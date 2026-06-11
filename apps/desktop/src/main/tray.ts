// apps/desktop/src/main/tray.ts
// v3 Sprint 2: 周期性轮询 GET /api/desktop/status，实时更新托盘状态文本和图标
// 图标使用 NativeImage 程序化绘制圆形指示器：绿=运行，黄=关闭中，红=不可达

import { Tray, Menu, nativeImage, BrowserWindow, type NativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { notifyDaemonStatusChange } from "./notifications.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Daemon 健康状态枚举 */
export type DaemonHealth = "running" | "shuttingDown" | "unreachable";

let currentHealth: DaemonHealth = "unreachable";
let trayInstance: Tray | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 程序化生成 16x16 托盘图标
 * 绘制圆形指示器：绿色=运行，黄色=关闭中，红色=不可达
 * @param health - Daemon 健康状态
 * @returns NativeImage 图标
 */
function createIndicatorIcon(health: DaemonHealth): NativeImage {
  const size = 16;
  // 使用 data URL（PNG base64）或通过 canvas 绘制
  // Electron 支持从 data URL 创建 NativeImage
  const canvas = Buffer.alloc(size * size * 4, 0);

  const colorMap: Record<DaemonHealth, [number, number, number, number]> = {
    running: [0, 200, 83, 255],       // 绿色 #00C853
    shuttingDown: [255, 193, 7, 255], // 黄色 #FFC107
    unreachable: [255, 82, 82, 255],  // 红色 #FF5252
  };

  const [r, g, b, a] = colorMap[health];
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = 6; // 圆形半径

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // 圆形内部：填充颜色（BGRA — Electron raw bitmap 格式）
        canvas[idx] = b;
        canvas[idx + 1] = g;
        canvas[idx + 2] = r;
        canvas[idx + 3] = a;
      } else if (dist <= radius + 1) {
        // 边缘抗锯齿
        const alpha = Math.max(0, 1 - (dist - radius));
        canvas[idx] = b;
        canvas[idx + 1] = g;
        canvas[idx + 2] = r;
        canvas[idx + 3] = Math.floor(a * alpha);
      }
      // 圆形外部保持透明 (0,0,0,0)
    }
  }

  const img = nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 1.0,
  });
  return img;
}

/**
 * 轮询 daemon 健康状态
 * @param serverPort - Daemon HTTP 端口
 * @returns 当前 DaemonHealth
 */
async function pollDaemonHealth(serverPort: number): Promise<DaemonHealth> {
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/desktop/status`);
    if (!res.ok) return "unreachable";
    const body = (await res.json()) as { uptime: number; shuttingDown: boolean };
    return body.shuttingDown ? "shuttingDown" : "running";
  } catch {
    return "unreachable";
  }
}

/**
 * 更新托盘 UI（图标 + context menu 状态标签）
 * @param tray - Tray 实例
 * @param health - 新健康状态
 */
function updateTrayUI(tray: Tray, health: DaemonHealth): void {
  const icon = createIndicatorIcon(health);
  tray.setImage(icon);

  const statusLabelMap: Record<DaemonHealth, string> = {
    running: "Status: Running",
    shuttingDown: "Status: Shutting Down",
    unreachable: "Status: Unreachable",
  };

  // 重建 context menu 以反映新状态
  const mainWindow = BrowserWindow.getAllWindows()[0];
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show PaperClip",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: statusLabelMap[health],
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        if (mainWindow) mainWindow.close();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * 启动托盘心跳轮询（每 15 秒）
 * 在 packaged-main.ts Phase 6 调用
 * @param serverPort - Daemon HTTP 端口
 * @returns 停止轮询的清理函数
 */
export function startTrayHeartbeat(serverPort: number): () => void {
  // 立即执行首次轮询
  pollDaemonHealth(serverPort)
    .then((health) => {
      currentHealth = health;
      if (trayInstance) updateTrayUI(trayInstance, health);
    })
    .catch((err) => {
      console.error("[PaperClip Desktop] Initial tray health poll failed:", err);
    });

  // 每 15 秒轮询
  pollingInterval = setInterval(async () => {
    try {
      const health = await pollDaemonHealth(serverPort);
      if (health !== currentHealth) {
        console.log(`[PaperClip Desktop] Tray health change: ${currentHealth} → ${health}`);
        notifyDaemonStatusChange(currentHealth, health);
        currentHealth = health;
        if (trayInstance) updateTrayUI(trayInstance, health);
      }
    } catch (err) {
      console.error("[PaperClip Desktop] Tray health poll error:", err);
    }
  }, 15000);

  return () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  };
}

/**
 * 创建系统托盘
 * @param mainWindow - 主 BrowserWindow
 * @returns Tray 实例
 */
export function createTray(mainWindow: BrowserWindow): Tray {
  // 尝试加载真实图标文件，失败则使用空白占位
  const iconPathCandidates = [
    path.join(__dirname, "..", "..", "resources", "tray", "tray-icon.png"),
    path.join(__dirname, "..", "..", "resources", "tray-icon.png"),
  ];

  let trayIcon: NativeImage = createIndicatorIcon("unreachable");
  let iconLoaded = false;
  for (const p of iconPathCandidates) {
    if (fs.existsSync(p)) {
      try {
        trayIcon = nativeImage.createFromPath(p);
        iconLoaded = true;
        break;
      } catch {
        // 继续尝试下一个路径
      }
    }
  }
  if (!iconLoaded) {
    trayIcon = createIndicatorIcon("unreachable");
  }

  const tray = new Tray(trayIcon);
  tray.setToolTip("PaperClip");
  trayInstance = tray;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show PaperClip",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "Status: Unreachable",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        mainWindow.close();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  return tray;
}

/**
 * 更新托盘状态（供外部调用——如 sidecar STATUS 消息或手动设置）
 * @param state - 状态字符串
 */
export function updateTrayState(state: string): void {
  const healthMap: Record<string, DaemonHealth> = {
    running: "running",
    shuttingDown: "shuttingDown",
    stopped: "unreachable",
    error: "unreachable",
  };
  currentHealth = healthMap[state] ?? "unreachable";
  if (trayInstance) updateTrayUI(trayInstance, currentHealth);
}
