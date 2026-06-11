// apps/desktop/src/main/packaged-main.ts
// v3: 关闭流程增强（等待 server.close() + 处理 backup + interval 清理）
// 核心变更：不传 DATABASE_URL，daemon 自管 PG；
//          首次启动用 paperclipai onboard -y 生成配置

import { app, BrowserWindow, dialog, globalShortcut } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSidecarServer, type SidecarServer } from "./sidecar-server.js";
import { scanCliAvailability, type CliScanResult } from "./cli-scanner.js";
import { createTray, updateTrayState, startTrayHeartbeat } from "./tray.js";
import { createAppMenu } from "./menu.js";
import { createUpdater, type Updater } from "./updater.js";
import { showNotification } from "./notifications.js";
import { SIDECAR_MESSAGES } from "../shared/sidecar-proto.js";
import { ensureFirstRunConfig } from "./onboard.js";
import { loadWindowState, registerWindowStateHandlers } from "./window-state.js";
import { setAutoLaunch } from "./login-item.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取版本号。在打包后，app.getVersion() 从 Electron 的 package.json 读取。
// 在 monorepo dev 中，回退到读取 apps/desktop/package.json。
// Path: dist/main/ → ../package.json (dist/package.json, copied by bundle-desktop.ts)
//       or ../../package.json (apps/desktop/package.json, monorepo dev)
const DESKTOP_VERSION = (() => {
  try {
    return app.getVersion();
  } catch {
    try {
      return JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"),
      ).version;
    } catch {
      return JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf-8"),
      ).version;
    }
  }
})();

// ─── 常量 — 全部来自实际源码验证 ───
const PAPERCLIP_HOME = path.resolve(os.homedir(), ".paperclip");
const PAPERCLIP_INSTANCE_ID = "default";
const DEFAULT_SERVER_PORT = 3100;

// ─── 指数退避重试（借鉴 Open Design 的 REGISTER_DESKTOP_AUTH_RETRY_DELAYS_MS） ───
const HEALTH_CHECK_RETRIES = [120, 240, 480, 960, 1500, 2000, 3000];

async function waitForServerReady(port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  for (const delay of HEALTH_CHECK_RETRIES) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // server not ready
    }
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}

// ─── 端口检测 ───
// Daemon uses detect-port internally and respects the PORT env var.
// We always set PORT=3100; if the daemon can't bind to it, it will fail
// and report to Electron (rather than silently using a different port).
function findAvailablePort(): number {
  return DEFAULT_SERVER_PORT;
}

// ─── Sidecar 消息处理 ───
function handleSidecarMessage(msg: Record<string, unknown>, shutdown: () => void): void {
  switch (msg?.type) {
    case SIDECAR_MESSAGES.STATUS:
      updateTrayState(msg.state as string);
      break;
    case SIDECAR_MESSAGES.NOTIFY:
      showNotification(msg.title as string, msg.body as string);
      break;
    case SIDECAR_MESSAGES.SHUTDOWN:
      shutdown();
      break;
  }
}

// ─── 找到 daemon 入口 ───
function resolveDaemonEntry(): string {
  // Prefer esbuild-bundled CJS file (compatible with Electron 33's Node 20)
  // Fall back to raw ESM entry for monorepo dev
  const candidates = [
    // ── Packaged app candidates ──
    // Candidate 1: Resources/app/dist/main/ → ../../.. → Resources/paperclip-server/dist/index.bundle.cjs
    //              In packaged app: dist/main/ in asar=false → ../../.. = Resources/ → ✅
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.bundle.cjs"),
    // Candidate 2: index.bundle.mjs (ESM fallback)
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.bundle.mjs"),
    // Candidate 3: index.js (raw ESM entry, fallback if no bundle exists)
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.js"),

    // ── Monorepo dev candidates ──
    // Candidate 4: ../../../server/dist/index.js (monorepo dev — live server build)
    //              From apps/desktop/dist/main/ → ../../.. → repo root → server/dist/index.js ✅
    path.join(__dirname, "..", "..", "..", "server", "dist", "index.js"),
    // Candidate 5: ../../paperclip-server/dist/index.js (post-bundle-sync in apps/desktop/)
    //              Only exists after bundle-desktop.ts sync; may have stale daemon.
    //              Checked AFTER the live server candidate to avoid using stale builds.
    path.join(__dirname, "..", "..", "paperclip-server", "dist", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log(`[PaperClip Desktop] Daemon entry: ${c}`);
      return c;
    }
  }
  throw new Error(
    `Daemon entry not found. Checked: ${candidates.join(", ")}`,
  );
}

// ─── 主启动流程 ───
export async function runDesktopMain(): Promise<void> {
  // ═══════════════════════════════════════
  // Phase 0: 首次启动 — 生成配置
  // ═══════════════════════════════════════
  await ensureFirstRunConfig({
    homeDir: PAPERCLIP_HOME,
    instanceId: PAPERCLIP_INSTANCE_ID,
  });

  // ═══════════════════════════════════════
  // Phase 1: 启动 PaperClip Server
  // ═══════════════════════════════════════
  // 关键：不传 DATABASE_URL → startServer() 自己启动嵌入式 PG
  const daemonEntry = resolveDaemonEntry();
  const serverPort = findAvailablePort();

  // 已修正的环境变量（基于源码验证）
  // 不展开 process.env — 避免 Electron 内部环境变量泄漏到 daemon
  // （如 ELECTRON_RUN_AS_NODE, PAPERCLIP_UI_DEV_MIDDLEWARE 等）
  //
  // 计算 bundled assets 的目录（daemon entry 的父目录 = paperclip-server/dist/ 的父 = paperclip-server/）
  // 在打包后的结构中：
  //   Resources/paperclip-server/dist/index.bundle.cjs  ← daemonEntry
  //   Resources/paperclip-server/teams-catalog/          ← bundled teams
  //   Resources/paperclip-server/skills-catalog/         ← bundled skills
  //   Resources/paperclip-server/onboarding-assets/      ← bundled onboarding assets
  const daemonDir = path.dirname(daemonEntry); // paperclip-server/dist/
  const daemonRoot = path.dirname(daemonDir);  // paperclip-server/

  const serverEnv = {
    PATH: process.env.PATH,               // daemon 需要 PATH 来查找 npx / Node.js
    HOME: process.env.HOME,               // daemon 需要 HOME for ~/.paperclip
    PAPERCLIP_HOME,                       // ~/.paperclip（不是 instance root！）
    PAPERCLIP_INSTANCE_ID: "default",
    // 不传 DATABASE_URL → daemon 自管 PG
    PORT: String(serverPort),
    SERVE_UI: "true",                     // ← 修正：不是 PAPERCLIP_SERVE_UI
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_OPEN_ON_LISTEN: "false",    // ← 新增：桌面端不打开浏览器
    HOST: "127.0.0.1",                    // ← 不继承 shell 的 HOST 环境变量（如 MacBook-Pro-M4.local），强制 loopback
    // Bundled catalog paths — daemon uses these to find catalogs in the bundle
    PAPERCLIP_TEAMS_CATALOG_DIR: path.join(daemonRoot, "teams-catalog"),
    PAPERCLIP_SKILLS_CATALOG_DIR: path.join(daemonRoot, "skills-catalog"),
    PAPERCLIP_ONBOARDING_ASSETS_DIR: path.join(daemonRoot, "onboarding-assets"),
  };

  console.log(`[PaperClip Desktop] Starting daemon on port ${serverPort}...`);
  console.log(`[PaperClip Desktop] PAPERCLIP_HOME=${PAPERCLIP_HOME}`);
  console.log(`[PaperClip Desktop] DATABASE_URL=(not set → daemon will auto-start embedded PG)`);

  // 使用 fork() 而非 spawn(process.execPath) —
  // fork 创建轻量 Node.js 子进程（不加载 Chromium），使用 Electron 内嵌的 Node.js 运行时
  const daemon: ChildProcess = fork(daemonEntry, [], {
    env: serverEnv,
    silent: true, // 将 stdout/stderr 管道化（可用 daemon.stdout/.stderr 读取）
  });

  daemon.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[daemon] ${data}`);
  });
  let daemonExited = false;
  daemon.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[daemon] ${data}`);
  });
  daemon.on("exit", (code, signal) => {
    daemonExited = true;
    console.log(`[PaperClip Desktop] Daemon exited (code=${code}, signal=${signal})`);
  });

  // ═══════════════════════════════════════
  // Phase 2: 等待 app 就绪 + 启动 Sidecar
  // ═══════════════════════════════════════
  await app.whenReady();

  const sidecarSocketPath = path.join(os.tmpdir(), "paperclip-desktop-sidecar.sock");
  let sidecarServer: SidecarServer;
  let shuttingDown = false;
  let stopHeartbeat: () => void = () => {};

  // ─── 关闭函数（v3 增强版） ───
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[PaperClip Desktop] Shutting down...");

    // 0. 停止托盘心跳轮询
    stopHeartbeat();

    try {
      // Guard: if serverPort was never set (daemon failed before startup),
      // skip the HTTP shutdown notification
      if (serverPort && !daemonExited) {
        // 1. 通知 daemon 准备关闭
        //    daemon 端的 shutdown handler 会：
        //    - 标记 desktopFlag.shuttingDown = true
        //    - clearInterval for heartbeat + backup
        //    - 等待 databaseBackupInFlight 变为 false
        //    - 停止 telemetry
        //    - 调用 appShutdown()
        //    - server.close()
        //    - embeddedPostgres.stop()
        //    - process.exit(0)
        await fetch(`http://127.0.0.1:${serverPort}/api/desktop/shutdown`, {
          method: "POST",
        }).catch(() => {});
      }

      // 2. 发送 SIGTERM (only if daemon is still running)
      if (!daemonExited) {
        daemon.kill("SIGTERM");

        // 3. 等待 daemon 退出（最多 20s，给 PG 备份 + checkpoint 留时间）
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn("[PaperClip Desktop] Daemon didn't exit in time, force killing");
            daemon.kill("SIGKILL");
            resolve();
          }, 20000); // v3: 从 15s 增加到 20s
          daemon.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } else {
        console.log("[PaperClip Desktop] Daemon already exited, skipping SIGTERM + wait");
      }
    } catch (err) {
      console.error("[PaperClip Desktop] Shutdown error:", err);
    }

    // 4. 关闭 Sidecar
    sidecarServer.close();

    // 5. 退出
    app.exit(0);
  }

  sidecarServer = createSidecarServer(sidecarSocketPath, (msg) => {
    handleSidecarMessage(msg, () => {
      void shutdown();
    });
  });

  // ═══════════════════════════════════════
  // Phase 3: 等待 Server 就绪
  // ═══════════════════════════════════════
  console.log("[PaperClip Desktop] Waiting for daemon...");
  const ready = await waitForServerReady(serverPort, 60000); // PG + 迁移可能较慢
  if (!ready) {
    // Kill daemon before quitting — before-quit handler may not be registered yet
    if (!daemonExited) {
      daemon.kill("SIGTERM");
    }
    dialog.showErrorBox(
      "Startup Failed",
      "PaperClip Server did not become ready within 60 seconds.\nPlease check ~/.paperclip/instances/default/logs/",
    );
    app.quit();
    return;
  }
  console.log("[PaperClip Desktop] Daemon ready");

  // ═══════════════════════════════════════
  // Phase 4: 扫描本地 Agent CLI
  // ═══════════════════════════════════════
  const cliResults: CliScanResult[] = await scanCliAvailability();
  console.log(
    "[PaperClip Desktop] CLI scan:",
    cliResults.filter((r) => r.found).map((r) => r.label),
  );

  // ═══════════════════════════════════════
  // Phase 5: 创建窗口（恢复上次窗口状态）
  // ═══════════════════════════════════════
  // 设置版本号环境变量，preload 脚本通过 process.env 读取（Sprint 3）
  process.env.PAPERCLIP_DESKTOP_VERSION = DESKTOP_VERSION;

  const windowState = loadWindowState();
  const mainWindow = new BrowserWindow({
    x: windowState.x >= 0 ? windowState.x : undefined,
    y: windowState.y >= 0 ? windowState.y : undefined,
    width: windowState.width,
    height: windowState.height,
    minWidth: 900,
    minHeight: 600,
    title: "PaperClip",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 恢复最大化状态
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // 注册窗口状态持久化（close 时保存）
  registerWindowStateHandlers(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("paperclip:cli-scan", cliResults);
  });

  // 使用 HTTP 加载 UI（不是 file:// — ADR-05）
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // ═══════════════════════════════════════
  // Phase 6: 桌面特性
  // ═══════════════════════════════════════
  createTray(mainWindow);
  createAppMenu(
    mainWindow,
    serverPort,
    cliResults.filter((r) => r.found).map((r) => r.label),
  );
  const updater: Updater = createUpdater(DESKTOP_VERSION, mainWindow);

  // 启动托盘心跳轮询（每 15 秒轮询 /api/desktop/status）
  stopHeartbeat = startTrayHeartbeat(serverPort);

  // 全局快捷键：切换显示/隐藏
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  // ═══════════════════════════════════════
  // Phase 7: 优雅关闭
  // ═══════════════════════════════════════
  app.on("before-quit", (event) => {
    event.preventDefault();
    shutdown().finally(() => {
      // Fallback: if shutdown() didn't call app.exit(0), force it
      setTimeout(() => app.exit(0), 1000);
    });
  });

  app.on("activate", () => mainWindow.show());
}

// 直接入口判断
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void runDesktopMain().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
