# PaperClip 桌面端封装 — 代码级实现方案

> 基于对 Claude Desktop 和 Open Design 的逆向分析，综合 PaperClip v0.10.x 源码结构。
> 日期: 2026-06-10

---

## 0. 架构决策记录 (ADR)

| ID | 决策 | 依据 |
|----|------|------|
| ADR-01 | **不使用 asar**：所有代码以纯文件目录形式分发 | Open Design 已验证：对嵌入式 PG 二进制、better-sqlite3 等原生模块，asar 的 `unpacked` 机制增加构建复杂度且无实质收益（asar 压缩率 ~40%，但 PaperClip 的重资产是 PG 二进制和 skills 内容，不参与压缩） |
| ADR-02 | **Electron 壳极薄**：`main.cjs` 只做 spawn + 窗口管理 | Open Design 的 2 行 main.cjs 模式。业务逻辑全在 daemon 子进程，Electron 主进程不 import 任何 PaperClip 业务代码 |
| ADR-03 | **Daemon 独立子进程**，不嵌入主进程 | PaperClip 已有完整 Node.js 运行时依赖，作为独立进程可复用现有 `startServer()` 入口，Electron 崩溃不影响 daemon 数据一致性 |
| ADR-04 | **复用 `paperclipai run` 的启动管线** | `paperclipai run` = onboard + doctor + startServer。桌面端不需要交互式 onboard，但需要 doctor check + 自动修复 + 启动 server。抽取启动管线为独立模块 |
| ADR-05 | **Web UI 通过 HTTP 加载**：`loadURL('http://localhost:3100')` | Open Design 模式。不通过 `file://` 或自定义协议加载，避免 SPA 路由、API 代理等问题 |
| ADR-06 | **不加 Electron IPC 协议** | PaperClip 已有完整的 REST API（`/api/health`、`/api/companies` 等）。桌面特有操作（启动/关闭 PG、托盘状态）通过少量 HTTP 端点暴露，不引入第二套 IPC |
| ADR-07 | **参考 Open Design 的 Sidecar 协议**用于进程间生命周期信号（STATUS / SHUTDOWN），不用于业务数据通信 | 业务数据走 HTTP；只有 daemon 健康状态、关闭请求走 Unix Socket |

---

## 1. 项目结构

```
paperclip/
├── apps/
│   └── desktop/                          ← 新增：Electron 桌面端
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron-builder.yml          ← electron-builder 打包配置
│       ├── src/
│       │   ├── main/
│       │   │   ├── index.ts              ← 主入口（~120行）
│       │   │   ├── packaged-main.ts      ← Electron 主进程逻辑（~500行）
│       │   │   ├── sidecar-server.ts     ← Unix Socket IPC 服务端
│       │   │   ├── pg-lifecycle.ts       ← 嵌入式 PG 生命周期管理
│       │   │   ├── cli-scanner.ts        ← PATH 扫描已安装的 Agent CLI
│       │   │   ├── tray.ts               ← 系统托盘
│       │   │   ├── menu.ts               ← 应用菜单
│       │   │   ├── updater.ts            ← 自动更新
│       │   │   └── notifications.ts      ← 原生通知
│       │   ├── preload/
│       │   │   └── index.ts              ← preload 脚本（contextBridge）
│       │   └── shared/
│       │       └── sidecar-proto.ts      ← Sidecar 消息类型定义
│       └── resources/
│           ├── icon.icns                 ← macOS 图标
│           ├── icon.ico                  ← Windows 图标
│           ├── icon.png                  ← Linux 图标
│           └── tray/
│               ├── tray-icon.png
│               ├── tray-icon@2x.png
│               ├── tray-icon-active.png  ← agent 运行中
│               └── tray-icon-alert.png   ← 异常状态
│
├── scripts/
│   └── desktop/
│       ├── bundle-desktop.ts             ← 打包脚本：组装 app bundle
│       ├── copy-daemon.ts                ← 复制 server + db + skills 到 bundle
│       └── copy-ui.ts                    ← 复制 UI dist 到 bundle
│
├── patches/                              ← 已有，无需新增
│   └── embedded-postgres@18.1.0-beta.16.patch
│
└── server/src/
    └── routes/
        └── desktop.ts                    ← 新增：桌面端专用 API 端点
```

---

## 2. 文件级实现

### 2.1 Electron 主入口 — `apps/desktop/src/main/index.ts`

```typescript
// apps/desktop/src/main/index.ts
// 借鉴 Open Design 的 2行 main.cjs 模式

// 这行不能省：Electron 入口必须是 CommonJS
// 实际逻辑在 packaged-main.ts（ESM），通过动态 import 加载
import("./packaged-main.js").catch((error) => {
  console.error("PaperClip Desktop failed to start", error);
  process.exit(1);
});
```

### 2.2 核心编排 — `apps/desktop/src/main/packaged-main.ts`

```typescript
// apps/desktop/src/main/packaged-main.ts
// Electron 主进程逻辑 — 借鉴 Open Design 的 packaged-main.mjs + 自研 PG 生命周期

import { app, BrowserWindow, Tray, Menu, dialog, shell, globalShortcut } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createSidecarServer, type SidecarServer } from "./sidecar-server.js";
import {
  startEmbeddedPg, stopEmbeddedPg, waitForPgReady,
  resolveEmbeddedPgBinary, PG_STATE,
} from "./pg-lifecycle.js";
import { scanCliAvailability, type CliScanResult } from "./cli-scanner.js";
import { createTray, updateTrayState } from "./tray.js";
import { createAppMenu } from "./menu.js";
import { createUpdater, type Updater } from "./updater.js";
import { showNotification } from "./notifications.js";
import { SIDECAR_MESSAGES, type SidecarStamp } from "../shared/sidecar-proto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 配置契约（借鉴 Open Design 的 open-design-config.json） ───
interface DesktopConfig {
  appVersion: string;
  daemonEntry: string;        // 相对路径 → server/dist/index.js
  uiDistDir: string;          // 相对路径 → ui/dist/
  embeddedPgPlatform: string; // darwin-arm64 | darwin-x64 | linux-x64 | win32-x64
  defaultPort: number;        // 3100
  pgDataDir: string;          // ~/.paperclip/instances/default/db
  namespace: string;
}

function loadDesktopConfig(): DesktopConfig {
  const configPath = path.join(__dirname, "..", "..", "paperclip-config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

// ─── 指数退避重试（借鉴 Open Design 的 REGISTER_DESKTOP_AUTH_RETRY_DELAYS_MS） ───
const HEALTH_CHECK_RETRIES = [120, 240, 480, 960, 1500, 2000, 3000];

async function waitForServerReady(port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  for (const delay of HEALTH_CHECK_RETRIES) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* server not ready yet */ }
    if (Date.now() - start > timeout) return false;
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

// ─── Sidecar 消息处理 ───
function handleSidecarMessage(
  msg: unknown,
  daemonPort: number,
  shutdown: () => Promise<void>,
) {
  // 处理来自 daemon 的进程间信号
  // 业务数据走 HTTP，不走这里
  const m = msg as Record<string, unknown>;
  switch (m?.type) {
    case SIDECAR_MESSAGES.STATUS:
      // daemon 报告状态变化 → 更新托盘图标
      updateTrayState(m.state as string);
      break;
    case SIDECAR_MESSAGES.NOTIFY:
      // daemon 请求推送原生通知
      showNotification(m.title as string, m.body as string);
      break;
    case SIDECAR_MESSAGES.SHUTDOWN:
      // daemon 请求关闭
      void shutdown();
      break;
  }
}

// ─── 主启动流程 ───
export async function runDesktopMain(): Promise<void> {
  const config = loadDesktopConfig();
  const pgBinary = resolveEmbeddedPgBinary(config.embeddedPgPlatform);

  // ═══════════════════════════════════════
  // Phase 1: 启动嵌入式 PostgreSQL
  // ═══════════════════════════════════════
  console.log("[PaperClip Desktop] Starting embedded PostgreSQL...");
  await startEmbeddedPg({
    binaryPath: pgBinary,
    dataDir: config.pgDataDir,
    port: 54329, // 默认端口，可能被占用
  });
  await waitForPgReady(54329, 15000);
  console.log("[PaperClip Desktop] PostgreSQL ready");

  // ═══════════════════════════════════════
  // Phase 2: 启动 PaperClip Server（Daemon 子进程）
  // ═══════════════════════════════════════
  const daemonEntry = path.join(__dirname, "..", "..", config.daemonEntry);
  const serverPort = await findAvailablePort(config.defaultPort);

  const serverEnv = {
    ...process.env,
    PAPERCLIP_HOME: path.dirname(config.pgDataDir), // ~/.paperclip/instances/default
    PAPERCLIP_INSTANCE_ID: "default",
    DATABASE_URL: `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip`,
    PORT: String(serverPort),
    PAPERCLIP_SERVE_UI: "true",
    PAPERCLIP_UI_DIST_DIR: path.join(__dirname, "..", "..", config.uiDistDir),
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",  // 桌面端静默自动迁移
    PAPERCLIP_SIDECAR_SOCKET: resolveSidecarSocketPath(),
  };

  console.log(`[PaperClip Desktop] Starting daemon on port ${serverPort}...`);
  const { spawn } = await import("node:child_process");
  const daemon = spawn(process.execPath, [daemonEntry], {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  daemon.stdout?.on("data", (data) => console.log(`[daemon] ${data}`));
  daemon.stderr?.on("data", (data) => console.error(`[daemon] ${data}`));

  daemon.on("exit", (code) => {
    console.error(`[PaperClip Desktop] Daemon exited with code ${code}`);
  });

  // ═══════════════════════════════════════
  // Phase 3: 等待 Server 就绪
  // ═══════════════════════════════════════
  await app.whenReady();

  // 启动 Sidecar IPC Server（Unix Socket）
  const sidecarServer = createSidecarServer(resolveSidecarSocketPath(), (msg) => {
    handleSidecarMessage(msg, serverPort, shutdown);
  });

  // 等待 /api/health 返回 ok
  console.log("[PaperClip Desktop] Waiting for daemon...");
  const ready = await waitForServerReady(serverPort, 30000);
  if (!ready) {
    dialog.showErrorBox("启动失败", "PaperClip Server 未能及时就绪，请检查日志");
    app.quit();
    return;
  }
  console.log("[PaperClip Desktop] Daemon ready");

  // ═══════════════════════════════════════
  // Phase 4: 扫描本地 Agent CLI（借鉴 Open Design）
  // ═══════════════════════════════════════
  const cliResults = await scanCliAvailability();
  console.log("[PaperClip Desktop] CLI scan results:", cliResults);

  // ═══════════════════════════════════════
  // Phase 5: 创建 BrowserWindow
  // ═══════════════════════════════════════
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "PaperClip",
    show: false, // 等 ready-to-show
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    // 把 CLI 扫描结果推送到前端（通过 preload 暴露的 API）
    mainWindow.webContents.send("paperclip:cli-scan", cliResults);
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // ═══════════════════════════════════════
  // Phase 6: 桌面特性
  // ═══════════════════════════════════════
  const tray = createTray(mainWindow);
  createAppMenu(mainWindow);
  const updater = createUpdater(config.appVersion);

  // 全局快捷键 show/hide
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  // ═══════════════════════════════════════
  // Phase 7: 优雅关闭（关键！）
  // ═══════════════════════════════════════
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[PaperClip Desktop] Shutting down...");

    // 顺序很重要：先通知 daemon，再停 daemon，最后停 PG
    try {
      // 1. 通知 daemon 准备关闭
      await fetch(`http://127.0.0.1:${serverPort}/api/desktop/shutdown`, {
        method: "POST",
      }).catch(() => {}); // daemon 可能已经死了

      // 2. 给 daemon 时间完成 checkpoint
      await new Promise(r => setTimeout(r, 2000));

      // 3. 杀 daemon 进程
      daemon.kill("SIGTERM");

      // 4. 等 daemon 退出（最多 10s）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          daemon.kill("SIGKILL");
          resolve();
        }, 10000);
        daemon.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // 5. 关闭 Sidecar IPC
      sidecarServer.close();

      // 6. 停止嵌入式 PG（pg_ctl stop -m fast）
      await stopEmbeddedPg(config.pgDataDir);
      console.log("[PaperClip Desktop] PostgreSQL stopped");
    } catch (err) {
      console.error("[PaperClip Desktop] Shutdown error:", err);
    }

    app.quit();
  };

  app.on("before-quit", (event) => {
    event.preventDefault();
    void shutdown();
  });

  app.on("window-all-closed", () => {
    void shutdown();
  });

  // macOS: 点击 Dock 图标重新显示窗口
  app.on("activate", () => {
    mainWindow.show();
  });
}

// 直接入口判断（借鉴 Open Design 的 isDirectEntry 模式）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void runDesktopMain().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
```

### 2.3 嵌入式 PG 生命周期 — `apps/desktop/src/main/pg-lifecycle.ts`

```typescript
// apps/desktop/src/main/pg-lifecycle.ts
// 管理 PostgreSQL 的启动/停止/健康检查
// 借鉴 PaperClip server/src/index.ts 的 embeddedPostgres 启动逻辑，
// 但抽取为独立模块供 Electron 主进程使用

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ─── 路径解析 ───
// 在打包后的 app 中，PG 二进制在 Resources/paperclip-server/embedded-pg/<platform>/bin/
// embedded-postgres 的 @embedded-postgres/<platform> 包提供二进制

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIR = path.join(__dirname, "..", "..");

export function resolveEmbeddedPgBinary(platform: string): {
  pgCtl: string;
  initdb: string;
  postgres: string;
  pgIsReady: string;
} {
  const baseDir = path.join(RESOURCES_DIR, "paperclip-server", "embedded-pg", platform);
  // 开发模式：二进制在 node_modules/@embedded-postgres/<platform>/bin/
  const devDir = path.join(
    RESOURCES_DIR, "..", "node_modules", "@embedded-postgres", platform,
  );

  const resolve = (bin: string) => {
    const packaged = path.join(baseDir, "bin", bin);
    if (fs.existsSync(packaged)) return packaged;
    const dev = path.join(devDir, "bin", bin);
    if (fs.existsSync(dev)) return dev;
    throw new Error(`Embedded PostgreSQL binary not found: ${bin} (platform: ${platform})`);
  };

  return {
    pgCtl: resolve("pg_ctl"),
    initdb: resolve("initdb"),
    postgres: resolve("postgres"),
    pgIsReady: resolve("pg_isready"),
  };
}

export const PG_STATE = {
  STOPPED: "stopped",
  STARTING: "starting",
  READY: "ready",
  ERROR: "error",
} as const;

export type PgState = (typeof PG_STATE)[keyof typeof PG_STATE];

let currentState: PgState = PG_STATE.STOPPED;

export function getPgState(): PgState {
  return currentState;
}

// ─── 检测已运行的 PG 实例（借鉴 server/src/index.ts 的 postmaster.pid 检测） ───
function isPostgresRunning(dataDir: string): number | null {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!fs.existsSync(pidFile)) return null;
  try {
    const content = fs.readFileSync(pidFile, "utf-8").split("\n");
    const pid = parseInt(content[0], 10);
    // 验证进程是否存活
    process.kill(pid, 0); // 不会真正发信号，只检查存在性
    return pid;
  } catch {
    // 进程不存在，清理残留 pid 文件
    fs.unlinkSync(pidFile);
    return null;
  }
}

// ─── 启动嵌入式 PG ───
export async function startEmbeddedPg(options: {
  binaryPath: ReturnType<typeof resolveEmbeddedPgBinary>;
  dataDir: string;
  port: number;
}): Promise<void> {
  const { binaryPath, dataDir, port } = options;

  // 如果已经运行，复用
  const existingPid = isPostgresRunning(dataDir);
  if (existingPid !== null) {
    console.log(`[PG] Reusing existing PostgreSQL (PID ${existingPid})`);
    currentState = PG_STATE.READY;
    return;
  }

  currentState = PG_STATE.STARTING;

  // 确保数据目录存在
  fs.mkdirSync(dataDir, { recursive: true });

  // 检查是否已初始化
  const pgVersionFile = path.join(dataDir, "PG_VERSION");
  const isInitialized = fs.existsSync(pgVersionFile);

  if (!isInitialized) {
    console.log("[PG] Initializing database cluster...");
    execSync(`"${binaryPath.initdb}" -D "${dataDir}" --encoding=UTF8 --locale=C --lc-messages=C`, {
      stdio: "inherit",
    });
  }

  // 启动 PostgreSQL
  console.log("[PG] Starting PostgreSQL...");
  execSync(
    `"${binaryPath.pgCtl}" start -D "${dataDir}" -l "${dataDir}/pg.log" -o "-p ${port}" -w`,
    { stdio: "inherit" },
  );

  currentState = PG_STATE.READY;
  console.log(`[PG] PostgreSQL started on port ${port}`);
}

// ─── 等待 PG 就绪 ───
export async function waitForPgReady(
  port: number,
  timeout = 15000,
): Promise<boolean> {
  const start = Date.now();
  const retryDelays = [200, 400, 800, 1600, 3000, 5000];

  for (const delay of retryDelays) {
    try {
      execSync(`pg_isready -h 127.0.0.1 -p ${port} -q`, { stdio: "ignore" });
      return true;
    } catch { /* not ready */ }
    if (Date.now() - start > timeout) return false;
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

// ─── 停止嵌入式 PG ───
export async function stopEmbeddedPg(dataDir: string): Promise<void> {
  if (currentState === PG_STATE.STOPPED) return;

  console.log("[PG] Stopping PostgreSQL...");
  try {
    execSync(`pg_ctl stop -D "${dataDir}" -m fast -w -t 15`, {
      stdio: "inherit",
    });
  } catch (err) {
    console.error("[PG] Failed to stop PostgreSQL cleanly:", err);
    // 尝试强制停止
    try {
      execSync(`pg_ctl stop -D "${dataDir}" -m immediate -w -t 5`, {
        stdio: "inherit",
      });
    } catch { /* last resort: kill */ }
  }
  currentState = PG_STATE.STOPPED;
}
```

### 2.4 CLI 扫描器 — `apps/desktop/src/main/cli-scanner.ts`

```typescript
// apps/desktop/src/main/cli-scanner.ts
// 借鉴 Open Design 的 agents.ts 白名单扫描模式
// 启动时自动检测本机已安装的 AI Agent CLI

import { execSync } from "node:child_process";

export interface CliScanResult {
  name: string;
  command: string;
  adapterType: string;    // 对应的 PaperClip 适配器类型
  found: boolean;
  version?: string;
  installHint?: string;
}

// 白名单（与 PaperClip 内置适配器类型对齐）
const CLI_WHITELIST: Array<{
  adapterType: string;
  command: string;
  label: string;
  versionFlag: string;
  installHint: string;
}> = [
  {
    adapterType: "claude_local",
    command: "claude",
    label: "Claude Code",
    versionFlag: "--version",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  {
    adapterType: "codex_local",
    command: "codex",
    label: "Codex CLI",
    versionFlag: "--version",
    installHint: "npm install -g @openai/codex",
  },
  {
    adapterType: "cursor",
    command: "agent",
    label: "Cursor Agent",
    versionFlag: "--version",
    installHint: "Install Cursor IDE from https://cursor.com",
  },
  {
    adapterType: "opencode_local",
    command: "opencode",
    label: "OpenCode",
    versionFlag: "--version",
    installHint: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    adapterType: "gemini_local",
    command: "gemini",
    label: "Gemini CLI",
    versionFlag: "--version",
    installHint: "npm install -g @google/gemini-cli",
  },
  {
    adapterType: "pi_local",
    command: "pi",
    label: "Pi Agent",
    versionFlag: "--version",
    installHint: "npm install -g @anthropic/pi",
  },
  {
    adapterType: "hermes_local",
    command: "hermes",
    label: "Hermes Agent",
    versionFlag: "--version",
    installHint: "npm install -g hermes-agent",
  },
  {
    adapterType: "openclaw_gateway",
    command: "openclaw",
    label: "OpenClaw",
    versionFlag: "--version",
    installHint: "npm install -g openclaw",
  },
];

function which(command: string): string | null {
  try {
    return execSync(`which "${command}" 2>/dev/null || echo ""`, {
      encoding: "utf-8",
    }).trim() || null;
  } catch {
    return null;
  }
}

function getVersion(command: string, versionFlag: string): string | undefined {
  try {
    return execSync(`${command} ${versionFlag} 2>&1`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim().split("\n")[0].slice(0, 80);
  } catch {
    return undefined;
  }
}

export async function scanCliAvailability(): Promise<CliScanResult[]> {
  console.log("[PaperClip Desktop] Scanning for installed AI Agent CLIs...");

  return CLI_WHITELIST.map((entry) => {
    const path = which(entry.command);
    const version = path ? getVersion(entry.command, entry.versionFlag) : undefined;

    console.log(
      `[Scanner] ${entry.label}: ${path ? `✅ ${path} ${version ?? ""}` : "❌ not found"}`,
    );

    return {
      name: entry.label,
      command: entry.command,
      adapterType: entry.adapterType,
      found: path !== null,
      version,
      installHint: path ? undefined : entry.installHint,
    };
  });
}
```

### 2.5 Sidecar IPC — `apps/desktop/src/main/sidecar-server.ts`

```typescript
// apps/desktop/src/main/sidecar-server.ts
// 借鉴 Open Design 的 createJsonIpcServer 模式
// Unix Domain Socket JSON IPC，用于进程间生命周期信号

import { createServer, type Server, type Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";

export type SidecarMessage = {
  type: "STATUS" | "NOTIFY" | "SHUTDOWN";
  payload?: unknown;
  timestamp: number;
};

export type SidecarServer = {
  close: () => void;
};

export function createSidecarServer(
  socketPath: string,
  handler: (message: SidecarMessage) => void,
): SidecarServer {
  // 清理残留的 socket 文件
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      // 按换行分割 JSON 消息
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as SidecarMessage;
          handler(message);
        } catch {
          console.error("[Sidecar] Invalid JSON message:", line);
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[Sidecar] Socket error:", err);
    });
  });

  server.listen(socketPath);

  return {
    close: () => {
      server.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    },
  };
}
```

### 2.6 系统托盘 — `apps/desktop/src/main/tray.ts`

```typescript
// apps/desktop/src/main/tray.ts
// 系统托盘管理，借鉴 Claude Desktop 的多倍率托盘图标方案

import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.join(__dirname, "..", "..", "resources", "tray");

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(path.join(RESOURCES, "tray-icon.png"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  tray.setToolTip("PaperClip");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示 PaperClip",
      click: () => mainWindow.show(),
    },
    { type: "separator" },
    {
      label: "Agent 状态",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "退出 PaperClip",
      click: () => {
        mainWindow.close(); // 触发 before-quit → shutdown 流程
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    mainWindow.show();
  });

  return tray;
}

export function updateTrayState(state: string): void {
  if (!tray) return;

  let iconFile = "tray-icon.png";
  switch (state) {
    case "agent-running":
      iconFile = "tray-icon-active.png";
      tray.setToolTip("PaperClip — Agent 运行中");
      break;
    case "error":
      iconFile = "tray-icon-alert.png";
      tray.setToolTip("PaperClip — 异常");
      break;
    default:
      tray.setToolTip("PaperClip");
  }

  const icon = nativeImage.createFromPath(path.join(RESOURCES, iconFile));
  tray.setImage(icon.resize({ width: 16, height: 16 }));
}
```

### 2.7 桌面端专用 API 端点 — `server/src/routes/desktop.ts`

```typescript
// server/src/routes/desktop.ts
// 桌面端专用 API — 只有 Electron 主进程调用（localhost only）

import { Router } from "express";

export function createDesktopRouter(options: {
  getPgState: () => string;
  getServerUptime: () => number;
  getCliScanResults: () => unknown[];
}) {
  const router = Router();

  // GET /api/desktop/status — Sidecar STATUS 等价物
  router.get("/status", (_req, res) => {
    res.json({
      pgState: options.getPgState(),
      serverUptime: options.getServerUptime(),
      cliScanResults: options.getCliScanResults(),
    });
  });

  // POST /api/desktop/shutdown — Electron 请求优雅关闭
  router.post("/shutdown", async (_req, res) => {
    res.json({ acknowledged: true });
    // 给响应一点时间返回，然后触发关闭流程
    setTimeout(() => {
      process.emit("SIGTERM" as any, "SIGTERM");
    }, 100);
  });

  // GET /api/desktop/cli-scan — 已扫描的 CLI 结果
  router.get("/cli-scan", (_req, res) => {
    res.json({ results: options.getCliScanResults() });
  });

  return router;
}
```

### 2.8 Preload 脚本 — `apps/desktop/src/preload/index.ts`

```typescript
// apps/desktop/src/preload/index.ts
// 安全地向渲染进程暴露有限的桌面 API

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("paperclipDesktop", {
  // CLI 扫描结果（主进程推送）
  onCliScanResult: (callback: (results: unknown[]) => void) => {
    ipcRenderer.on("paperclip:cli-scan", (_event, results) => {
      callback(results);
    });
  },

  // 获取桌面状态
  getDesktopStatus: () => ipcRenderer.invoke("paperclip:get-desktop-status"),

  // 原生通知
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke("paperclip:notify", { title, body }),

  // 平台信息
  platform: process.platform,
  isPackaged: process.defaultApp !== true,
});
```

### 2.9 打包配置 — `apps/desktop/electron-builder.yml`

```yaml
# apps/desktop/electron-builder.yml
# 借鉴 Open Design 的纯文件目录 + 无 asar 策略

appId: com.paperclipai.desktop
productName: PaperClip
copyright: Copyright © 2026 PaperClip AI

directories:
  output: dist
  buildResources: resources

files:
  # Electron 壳（极薄）
  - "dist/**/*"                  # 编译后的 TypeScript
  - "resources/**/*"             # 图标、托盘
  - "paperclip-config.json"      # 运行时配置契约

  # PaperClip Server（完整后端 + 嵌入式 PG）
  - "paperclip-server/**/*"      # server/dist + node_modules + embedded-pg + skills + teams

  # PaperClip UI（前端构建产物）
  - "paperclip-ui/**/*"          # ui/dist

asar: false  # ← 关键！不用 asar，纯文件目录

mac:
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  icon: resources/icon.icns
  category: public.app-category.developer-tools
  minimumSystemVersion: "12.0"
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

dmg:
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications

win:
  target:
    - target: nsis
      arch:
        - x64
  icon: resources/icon.ico

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true

linux:
  target:
    - target: AppImage
      arch:
        - x64
  category: Development
  icon: resources/icon.png

publish:
  provider: github
  owner: paperclipai
  repo: paperclip
```

### 2.10 打包脚本 — `scripts/desktop/bundle-desktop.ts`

```typescript
// scripts/desktop/bundle-desktop.ts
// 在 electron-builder 之前运行，组装 app bundle

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const APPS_DESKTOP = path.join(ROOT, "apps", "desktop");

// ─── 1. 编译 Electron 壳 TypeScript ───
console.log("[Bundle] Building Electron shell...");
execSync("npx tsc -p apps/desktop/tsconfig.json", { cwd: ROOT, stdio: "inherit" });

// ─── 2. 复制 PaperClip Server ───
console.log("[Bundle] Copying PaperClip server...");
const serverDist = path.join(ROOT, "server", "dist");
const bundledServer = path.join(APPS_DESKTOP, "paperclip-server", "dist");
fs.mkdirSync(path.dirname(bundledServer), { recursive: true });

// 复制编译后的 server 代码
execSync(`cp -R "${serverDist}" "${bundledServer}"`);

// 复制 server 运行时依赖（只复制运行时需要的，排除 devDependencies）
execSync(
  `cd server && NODE_ENV=production npm pack --dry-run 2>&1 | grep -oP '(?<=npm notice)\\s+\\S+' | xargs -I{} cp -R "{}" "${path.join(APPS_DESKTOP, "paperclip-server", "{}")}"`,
  { cwd: ROOT, stdio: "inherit" },
);

// 复制 skills 和 teams 目录
const skillsDir = path.join(ROOT, "packages", "skills-catalog", "catalog");
execSync(`cp -R "${skillsDir}" "${path.join(APPS_DESKTOP, "paperclip-server", "skills")}"`);

// ─── 3. 复制嵌入式 PG 二进制 ───
console.log("[Bundle] Copying embedded PostgreSQL binaries...");
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
for (const platform of platforms) {
  const src = path.join(ROOT, "node_modules", "@embedded-postgres", platform);
  if (fs.existsSync(src)) {
    const dest = path.join(APPS_DESKTOP, "paperclip-server", "embedded-pg", platform);
    execSync(`cp -R "${src}" "${dest}"`);
  }
}

// ─── 4. 复制 UI dist ───
console.log("[Bundle] Copying UI dist...");
const uiDist = path.join(ROOT, "ui", "dist");
const bundledUi = path.join(APPS_DESKTOP, "paperclip-ui", "dist");
fs.mkdirSync(path.dirname(bundledUi), { recursive: true });
execSync(`cp -R "${uiDist}" "${bundledUi}"`);

// ─── 5. 生成 paperclip-config.json ───
console.log("[Bundle] Generating paperclip-config.json...");
const { version } = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
);

// 自动检测当前构建平台
const currentPlatform = `${process.platform}-${process.arch}`;

const config = {
  appVersion: version,
  daemonEntry: "paperclip-server/dist/index.js",
  uiDistDir: "paperclip-ui/dist",
  embeddedPgPlatform: currentPlatform,
  defaultPort: 3100,
  pgDataDir: "~/.paperclip/instances/default/db",
  namespace: "release-stable",
};
fs.writeFileSync(
  path.join(APPS_DESKTOP, "paperclip-config.json"),
  JSON.stringify(config, null, 2),
);

console.log("[Bundle] Done! Ready for electron-builder.");
```

### 2.11 桌面端 package.json — `apps/desktop/package.json`

```json
{
  "name": "@paperclipai/desktop",
  "version": "0.10.0",
  "private": true,
  "type": "module",
  "main": "./dist/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "bundle": "tsx ../../scripts/desktop/bundle-desktop.ts",
    "pack": "pnpm bundle && electron-builder --config electron-builder.yml",
    "pack:mac": "pnpm pack --mac",
    "pack:win": "pnpm pack --win",
    "pack:linux": "pnpm pack --linux",
    "test": "vitest run"
  },
  "dependencies": {
    "electron-updater": "^6.3.0",
    "auto-launch": "^5.0.6"
  },
  "devDependencies": {
    "@types/node": "^24.12.0",
    "electron": "^41.3.0",
    "electron-builder": "^25.1.0",
    "typescript": "^6.0.0",
    "vitest": "^4.1.0"
  },
  "engines": {
    "node": "~24"
  }
}
```

---

## 3. 构建管线

```
                        ┌──────────────────┐
                        │ pnpm build       │
                        │ - server (tsc)   │
                        │ - ui (vite build)│
                        │ - packages (tsc) │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ pnpm desktop:bundle│  ← 新增脚本
                        │ 1. tsc desktop/   │
                        │ 2. cp server/dist  │
                        │ 3. cp embedded-pg/  │
                        │ 4. cp ui/dist      │
                        │ 5. gen config.json  │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ electron-builder  │
                        │ - macOS .dmg      │
                        │ - Windows .exe    │
                        │ - Linux .AppImage │
                        └────────┬─────────┘
                                 │
                                 ▼
                        📦 PaperClip-0.10.0-arm64.dmg (~800MB)
```

根 `package.json` 新增脚本：
```json
{
  "scripts": {
    "desktop:build": "pnpm --filter @paperclipai/desktop build",
    "desktop:bundle": "pnpm --filter @paperclipai/desktop bundle",
    "desktop:pack": "pnpm --filter @paperclipai/desktop pack",
    "desktop:pack:mac": "pnpm --filter @paperclipai/desktop pack:mac",
    "desktop:dev": "pnpm --filter @paperclipai/desktop exec electron ."
  }
}
```

---

## 4. 启动时序图

```
用户双击 PaperClip.app
        │
        ▼
┌─── Electron Main Process ──────────────────────────────────────────┐
│                                                                     │
│  [t=0ms]   main.cjs → import("./packaged-main.js")                 │
│  [t=10ms]  loadDesktopConfig() → 读取 paperclip-config.json        │
│  [t=20ms]  resolveEmbeddedPgBinary("darwin-arm64")                  │
│              → /Resources/paperclip-server/embedded-pg/.../pg_ctl  │
│                                                                     │
│  [t=30ms]  startEmbeddedPg({ dataDir: "~/.paperclip/.../db" })     │
│              检查 PG_VERSION → 已初始化? 跳过 initdb               │
│              检查 postmaster.pid → 已运行? 复用                    │
│              pg_ctl start -D ... -o "-p 54329" -w                  │
│                                                                     │
│  [t=2s]    waitForPgReady(54329) → pg_isready 轮询 ✅              │
│                                                                     │
│  [t=2s]    spawn("node", ["server/dist/index.js"], {               │
│              env: {                                                 │
│                DATABASE_URL: "postgres://...@127.0.0.1:54329/...",  │
│                PAPERCLIP_MIGRATION_AUTO_APPLY: "true",              │
│                PAPERCLIP_SERVE_UI: "true",                          │
│              }                                                      │
│            })                                                       │
│                                                                     │
│  [t=3s]    app.whenReady()                                         │
│  [t=3s]    createSidecarServer("/tmp/paperclip-sidecar.sock")       │
│                                                                     │
│  [t=3s-15s] waitForServerReady(3100)                                │
│               → curl http://127.0.0.1:3100/api/health              │
│               → 指数退避: 120/240/480/960/1500/2000/3000ms         │
│               → ✅ 200 OK                                           │
│                                                                     │
│  [t=15s]   scanCliAvailability()                                    │
│               which claude    → /opt/homebrew/bin/claude ✅         │
│               which codex     → ❌                                  │
│               which opencode  → /usr/local/bin/opencode ✅          │
│                                                                     │
│  [t=16s]   new BrowserWindow({ preload, ... })                      │
│  [t=16s]   mainWindow.loadURL("http://127.0.0.1:3100")             │
│                                                                     │
│  [t=18s]   mainWindow "ready-to-show" → show window                │
│            + push CLI scan results to renderer                      │
│            + createTray() + createAppMenu() + createUpdater()       │
│                                                                     │
│  ✅ 用户看到 PaperClip 界面                                         │
│  顶部横幅：「检测到 Claude Code ✅ | OpenCode ✅ | Codex ❌」       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

总启动时间预估：~18-25s
  - PG 启动: 2s
  - Server 启动 + 迁移: 10-13s
  - UI 加载: 3-5s
```

---

## 5. 体积预估

| 组件 | 预估大小 | 参考来源 |
|------|---------|---------|
| Electron Framework | 470 MB | Claude Desktop / Open Design 共享 |
| PaperClip Server (dist + node_modules) | ~150 MB | `pnpm build` 后 server/dist + production deps |
| Embedded PostgreSQL 二进制（单平台） | ~100 MB | `@embedded-postgres/darwin-arm64` 包大小 |
| PaperClip UI (vite build) | ~15 MB | `ui/dist/` |
| Skills / Teams / Design Systems | ~30 MB | `packages/skills-catalog/` |
| Electron 壳代码 | ~5 MB | `apps/desktop/dist/` |
| 其他资源（图标、预加载脚本） | ~5 MB | |
| **合计（单平台 .dmg）** | **~775 MB** | |
| **合计（单平台 .app）** | **~800 MB** | 含临时文件 |

对比：Open Design 527MB，Claude Desktop 675MB。PaperClip 更大的原因：嵌入式 PG 二进制（100MB）+ 完整 Express server 及其依赖（150MB）。

---

## 6. 开发工作分解

### Sprint 1: 核心壳（2 周）

| 天数 | 任务 | 产出 |
|------|------|------|
| D1-2 | 搭建 `apps/desktop/` 项目骨架，`electron-builder.yml` | 能 `electron .` 启动空白窗口 |
| D3-4 | 实现 `pg-lifecycle.ts` — PG 启动/停止/健康检查 | 单元测试覆盖 |
| D5-6 | 实现 `packaged-main.ts` — spawn daemon + waitForServerReady | 能启动完整 PaperClip |
| D7-8 | 实现优雅关闭（before-quit → daemon → PG） | 多次启停无数据损坏 |
| D9-10 | 实现 `bundle-desktop.ts` 打包脚本 | 生成可工作的 `.app` bundle |
| D11-12 | macOS 签名 + 公证配置 | 无 "无法验证开发者" 警告 |
| D13-14 | 集成测试 + bug 修复 | 启动成功率 > 95% |

### Sprint 2: 桌面体验（2 周）

| 天数 | 任务 | 产出 |
|------|------|------|
| D1-2 | CLI 扫描器 + UI 展示 | 启动后顶部横幅显示检测结果 |
| D3-4 | 系统托盘 + 状态指示 | 托盘图标反映运行状态 |
| D5-6 | 应用菜单 + 全局快捷键 | Cmd+Shift+P show/hide |
| D7-8 | 原生通知集成 | Agent 任务完成时推送 |
| D9-10 | 自动更新 | electron-updater + GitHub Releases |
| D11-14 | 开机自启 + 首次引导 | 首次打开时的 onboarding 向导 |

### Sprint 3: 多平台 + 发布（1-2 周）

| 天数 | 任务 | 产出 |
|------|------|------|
| D1-3 | Windows 适配 + .exe 构建验证 | Windows Installer |
| D4-5 | Linux AppImage 构建验证 | Linux 发布包 |
| D6-8 | 跨平台 PG 二进制验证 | 三平台全通过 |
| D9-10 | CI/CD (GitHub Actions) | 自动构建 + 发布 |

---

## 7. 关键风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `embedded-postgres` 二进制在打包后路径解析失败 | 高 | 阻塞 | 不用 asar，纯文件目录；开发阶段就在 `.app/Resources/` 下验证路径 |
| PG 优雅关闭时序错误导致数据损坏 | 中 | 严重 | `before-quit` → `SIGTERM` daemon → 等待 daemon 退出 → `pg_ctl stop -m fast`；强制写死等待超时 |
| 端口冲突（3100 已被占用） | 中 | 中 | `detect-port` 自动 fallback 到下一个可用端口 |
| macOS 公证失败 | 中 | 中 | 提前申请 Apple Developer Program；CI 中集成 `notarytool` |
| Server `node_modules` 体积过大 | 低 | 低 | `npm prune --production` + 排除 devDependencies |

---

## 8. 下一步

1. **先在现有的 PaperClip 项目里跑通 `pg-lifecycle.ts`** — 这是整个方案的核心依赖，验证独立进程管理嵌入式 PG 的可行性
2. **确认 `embedded-postgres` 在各平台的二进制路径** — `@embedded-postgres/darwin-arm64`、`darwin-x64`、`linux-x64`、`win32-x64` 的目录结构是否一致
3. **决定 macOS 代码签名策略** — 是否申请 Apple Developer Program，还是先用自签名 + 用户手动信任
4. **与 PaperClip 上游同步** — Desktop 打包应该作为 PaperClip 的正式发布通道，需要在 PaperClip repo 中提交 PR
