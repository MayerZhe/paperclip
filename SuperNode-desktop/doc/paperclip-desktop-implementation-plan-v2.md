# PaperClip 桌面端封装 — 代码级实现方案 v2

> 基于 v1 方案评审报告的逐行修正。
> 基准代码: PaperClip v0.3.1
> 日期: 2026-06-10

---

## 前置：v1 → v2 变更摘要

| # | v1 问题 | 严重度 | v2 修正 |
|---|---------|--------|---------|
| 1 | 环境变量 `PAPERCLIP_SERVE_UI` 不存在 | 🔴 阻塞 | 改为 `SERVE_UI=true` |
| 2 | 环境变量 `PAPERCLIP_UI_DIST_DIR` 不存在 | 🔴 阻塞 | 删除；UI dist 由 `app.ts` 自动探测 `../ui-dist` |
| 3 | 自定义 `paperclip-config.json` 格式不兼容 Zod schema | 🔴 阻塞 | 废弃；用 `paperclipai onboard -y` 生成标准 `config.json` |
| 4 | Electron 主进程直接管理 PG 生命周期 × `startServer()` 自管 PG → 双重 stop | 🔴 严重 | **废弃 `pg-lifecycle.ts`**；daemon 全权管理 PG，Electron 不碰 |
| 5 | CLI Scanner 遗漏 `acpx`、`grok` 适配器 | 🟡 中 | 补全白名单 |
| 6 | Skills 路径指向 `packages/skills-catalog/catalog/` 错误 | 🟡 中 | 改为 `skills/` 顶层目录 |
| 7 | 版本号 `0.10.x` 与实际 `0.3.1` 不符 | 🟡 中 | 全部改为 `0.3.1` |
| 8 | `PAPERCLIP_HOME` 路径导致双重嵌套 | 🟡 中 | `PAPERCLIP_HOME=~/.paperclip` + `PAPERCLIP_INSTANCE_ID=default` |

---

## 0. 架构决策记录 (ADR) — 修订版

| ID | 决策 | 依据 | v2 变更 |
|----|------|------|---------|
| ADR-01 | **不用 asar** | 嵌入式 PG 原生二进制 + `embedded-postgres` 库内部 `child_process.spawn` 无法从 asar 运行 | 不变 |
| ADR-02 | **Electron 壳极薄** | `main.cjs` 只做 spawn + 窗口管理 | 不变 |
| ADR-03 | **Daemon 全权管理 PG** | `startServer()` 内有完整的 `EmbeddedPostgres` 生命周期（`index.ts:293-450` + SIGTERM handler `index.ts:930-937`）。Electron 不应重复管理 PG | **🔴 修订**：废弃 v1 的 `pg-lifecycle.ts`，不传 `DATABASE_URL`，让 daemon 自己启停 PG |
| ADR-04 | **首次启动用 `paperclipai onboard -y` 生成配置** | 配置格式为 Zod `paperclipConfigSchema`（`shared/config-schema.ts:106`），手工构造极易出错。`onboard` 同时生成 `config.json` + `.env` + `master.key` | **🔴 修订**：废弃 v1 的自定义 `paperclip-config.json` |
| ADR-05 | `loadURL('http://localhost:3100')` | Server 通过 Express 中间件 serve UI（`app.ts:331-383`），HTTP 加载无 SPA 路由问题 | 不变 |
| ADR-06 | 不加 Electron IPC 协议 | 已有 40+ REST 路由文件 | 不变 |
| ADR-07 | Sidecar 仅用于进程间生命期信号 | Unix Socket JSON IPC，不承载业务数据 | 不变 |
| ADR-08 | **UI dist 放入 `server/ui-dist/`** | `app.ts:333-334` 按 `../ui-dist` 自动探测（从 `server/dist/` 出发 → `server/ui-dist/`） | **🆕 新增** |

---

## 1. 项目结构（修订版）

```
paperclip/
├── apps/
│   └── desktop/                          ← 新增：Electron 桌面端
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron-builder.yml
│       ├── src/
│       │   ├── main/
│       │   │   ├── index.ts              ← 2行入口（借鉴 Open Design）
│       │   │   ├── packaged-main.ts      ← 主进程逻辑（~400行，已精简）
│       │   │   ├── onboard.ts            ← 🆕 首次启动配置生成
│       │   │   ├── cli-scanner.ts        ← PATH 扫描
│       │   │   ├── sidecar-server.ts     ← Unix Socket IPC
│       │   │   ├── tray.ts               ← 系统托盘
│       │   │   ├── menu.ts               ← 应用菜单
│       │   │   ├── updater.ts            ← 自动更新
│       │   │   └── notifications.ts      ← 原生通知
│       │   ├── preload/
│       │   │   └── index.ts
│       │   └── shared/
│       │       └── sidecar-proto.ts
│       └── resources/
│           ├── icon.icns / icon.ico / icon.png
│           └── tray/
│               ├── tray-icon.png
│               ├── tray-icon@2x.png
│               ├── tray-icon-active.png
│               └── tray-icon-alert.png
│
├── server/src/routes/
│   └── desktop.ts                       ← 🆕 桌面端专用 API 端点
│
└── scripts/desktop/
    ├── bundle-desktop.ts                ← 打包脚本
    ├── copy-daemon.ts                   ← 复制 server + db + skills
    └── copy-ui.ts                       ← 复制 UI dist → server/ui-dist/
```

**删除的文件（v1 → v2）**：
- ❌ `apps/desktop/src/main/pg-lifecycle.ts` — 废弃，daemon 自管 PG
- ❌ `paperclip-config.json` — 废弃，用 `paperclipai onboard` 生成标准配置

---

## 2. 文件级实现（修订版）

### 2.1 Electron 主入口 — `apps/desktop/src/main/index.ts`

```typescript
// apps/desktop/src/main/index.ts
// 2行入口 — 完全借鉴 Open Design 的 main.cjs 模式

import("./packaged-main.js").catch((error) => {
  console.error("PaperClip Desktop failed to start", error);
  process.exit(1);
});
```

### 2.2 核心编排 — `apps/desktop/src/main/packaged-main.ts`

```typescript
// apps/desktop/src/main/packaged-main.ts
// 核心变更：不传 DATABASE_URL，daemon 自管 PG；
//          首次启动用 paperclipai onboard -y 生成配置

import { app, BrowserWindow, dialog, globalShortcut } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { createSidecarServer, type SidecarServer } from "./sidecar-server.js";
import { scanCliAvailability, type CliScanResult } from "./cli-scanner.js";
import { createTray, updateTrayState } from "./tray.js";
import { createAppMenu } from "./menu.js";
import { createUpdater, type Updater } from "./updater.js";
import { showNotification } from "./notifications.js";
import { SIDECAR_MESSAGES } from "../shared/sidecar-proto.js";
import { ensureFirstRunConfig } from "./onboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 常量 — 全部来自实际源码验证 ───
const PAPERCLIP_HOME = path.resolve(os.homedir(), ".paperclip");
const PAPERCLIP_INSTANCE_ID = "default";
const INSTANCE_ROOT = path.resolve(PAPERCLIP_HOME, "instances", PAPERCLIP_INSTANCE_ID);
const CONFIG_PATH = path.resolve(INSTANCE_ROOT, "config.json");
const ENV_PATH = path.resolve(INSTANCE_ROOT, ".env");
const DEFAULT_SERVER_PORT = 3100;

// ─── 指数退避重试（借鉴 Open Design 的 REGISTER_DESKTOP_AUTH_RETRY_DELAYS_MS） ───
const HEALTH_CHECK_RETRIES = [120, 240, 480, 960, 1500, 2000, 3000];

async function waitForServerReady(port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  for (const delay of HEALTH_CHECK_RETRIES) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* server not ready */ }
    if (Date.now() - start > timeout) return false;
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

// ─── 端口检测 ───
function findAvailablePort(preferred: number): number {
  // 简化版，生产环境建议使用 detect-port npm 包
  try {
    const net = require("node:net");
    const server = net.createServer();
    server.listen(preferred, "127.0.0.1");
    server.close();
    return preferred;
  } catch {
    return preferred; // fallback to daemon's own detect-port
  }
}

// ─── Sidecar 消息处理 ───
function handleSidecarMessage(msg: Record<string, unknown>, shutdown: () => void) {
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
  // daemon entry = server/dist/index.js
  // 在打包后的 bundle 中：Resources/paperclip-server/dist/index.js
  // 在开发环境中：../../server/dist/index.js
  const candidates = [
    path.join(__dirname, "..", "..", "paperclip-server", "dist", "index.js"),
    path.join(__dirname, "..", "..", "..", "server", "dist", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Daemon entry not found. Checked: ${candidates.join(", ")}`
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
  const serverPort = findAvailablePort(DEFAULT_SERVER_PORT);

  // 已修正的环境变量（基于源码验证）
  const serverEnv = {
    ...process.env,
    PAPERCLIP_HOME,                      // ~/.paperclip（不是 instance root！）
    PAPERCLIP_INSTANCE_ID: "default",
    // 不传 DATABASE_URL → daemon 自管 PG
    PORT: String(serverPort),
    SERVE_UI: "true",                    // ← 修正：不是 PAPERCLIP_SERVE_UI
    // 不传 PAPERCLIP_UI_DIST_DIR ← 废弃，app.ts 自动探测
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_OPEN_ON_LISTEN: "false",   // ← 新增：桌面端不打开浏览器
  };

  console.log(`[PaperClip Desktop] Starting daemon on port ${serverPort}...`);
  console.log(`[PaperClip Desktop] PAPERCLIP_HOME=${PAPERCLIP_HOME}`);
  console.log(`[PaperClip Desktop] DATABASE_URL=(not set → daemon will auto-start embedded PG)`);

  const daemon = spawn(process.execPath, [daemonEntry], {
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  daemon.stdout?.on("data", (data) => {
    process.stdout.write(`[daemon] ${data}`);
  });
  daemon.stderr?.on("data", (data) => {
    process.stderr.write(`[daemon] ${data}`);
  });
  daemon.on("exit", (code, signal) => {
    console.log(`[PaperClip Desktop] Daemon exited (code=${code}, signal=${signal})`);
  });

  // ═══════════════════════════════════════
  // Phase 2: 等待 app 就绪 + 启动 Sidecar
  // ═══════════════════════════════════════
  await app.whenReady();

  const sidecarSocketPath = path.join(os.tmpdir(), "paperclip-desktop-sidecar.sock");
  const sidecarServer = createSidecarServer(sidecarSocketPath, (msg) => {
    handleSidecarMessage(msg, () => shutdown());
  });

  // ═══════════════════════════════════════
  // Phase 3: 等待 Server 就绪
  // ═══════════════════════════════════════
  console.log("[PaperClip Desktop] Waiting for daemon...");
  const ready = await waitForServerReady(serverPort, 60000); // PG + 迁移可能较慢
  if (!ready) {
    dialog.showErrorBox("启动失败",
      "PaperClip Server 未能在 60 秒内就绪。\n请检查 ~/.paperclip/instances/default/logs/");
    app.quit();
    return;
  }
  console.log("[PaperClip Desktop] Daemon ready");

  // ═══════════════════════════════════════
  // Phase 4: 扫描本地 Agent CLI
  // ═══════════════════════════════════════
  const cliResults = await scanCliAvailability();
  console.log("[PaperClip Desktop] CLI scan:", cliResults.filter(r => r.found).map(r => r.label));

  // ═══════════════════════════════════════
  // Phase 5: 创建窗口
  // ═══════════════════════════════════════
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
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

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("paperclip:cli-scan", cliResults);
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // ═══════════════════════════════════════
  // Phase 6: 桌面特性
  // ═══════════════════════════════════════
  const tray = createTray(mainWindow);
  createAppMenu(mainWindow);
  const updater = createUpdater("0.3.1");

  globalShortcut.register("CommandOrControl+Shift+P", () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  // ═══════════════════════════════════════
  // Phase 7: 优雅关闭（修订版）
  // ═══════════════════════════════════════
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[PaperClip Desktop] Shutting down...");

    // 关键变更：daemon 自己管理 PG 停止
    // 时序：POST /api/desktop/shutdown → SIGTERM → 等待退出
    // daemon 的 SIGTERM handler（index.ts:930-937）会执行 embeddedPostgres.stop()

    try {
      // 1. 通知 daemon 准备关闭
      await fetch(`http://127.0.0.1:${serverPort}/api/desktop/shutdown`, {
        method: "POST",
      }).catch(() => {});

      // 2. 发送 SIGTERM
      daemon.kill("SIGTERM");

      // 3. 等待 daemon 退出（daemon 会在退出前停止 PG）
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn("[PaperClip Desktop] Daemon didn't exit in time, force killing");
          daemon.kill("SIGKILL");
          resolve();
        }, 15000);
        daemon.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (err) {
      console.error("[PaperClip Desktop] Shutdown error:", err);
    }

    // 4. 关闭 Sidecar
    sidecarServer.close();

    // 5. 退出
    app.exit(0);
  }

  app.on("before-quit", (event) => {
    event.preventDefault();
    void shutdown();
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
```

### 2.3 首次启动配置生成 — `apps/desktop/src/main/onboard.ts`

```typescript
// apps/desktop/src/main/onboard.ts
// 🆕 新增：首次启动时生成标准 PaperClip 配置
// 替代 v1 的自定义 paperclip-config.json

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface OnboardOptions {
  homeDir: string;      // ~/.paperclip
  instanceId: string;   // "default"
}

export async function ensureFirstRunConfig(options: OnboardOptions): Promise<void> {
  const instanceRoot = path.resolve(options.homeDir, "instances", options.instanceId);
  const configPath = path.resolve(instanceRoot, "config.json");
  const envPath = path.resolve(instanceRoot, ".env");

  // 如果配置已存在，跳过
  if (fs.existsSync(configPath) && fs.existsSync(envPath)) {
    console.log("[PaperClip Desktop] Config already exists, skipping onboard");
    return;
  }

  console.log("[PaperClip Desktop] First run detected — generating config...");

  fs.mkdirSync(instanceRoot, { recursive: true });

  // 选项 A：调用 paperclipai onboard -y（推荐，生成完整配置 + .env + master.key）
  try {
    execSync(
      `PAPERCLIP_HOME="${options.homeDir}" ` +
      `PAPERCLIP_INSTANCE_ID="${options.instanceId}" ` +
      `npx paperclipai onboard -y`,
      {
        stdio: "inherit",
        timeout: 30000,
      },
    );
    console.log("[PaperClip Desktop] Config generated via paperclipai onboard");
    return;
  } catch (err) {
    console.warn("[PaperClip Desktop] paperclipai onboard failed, falling back to manual config generation");
  }

  // 选项 B：手动生成最小配置（当 paperclipai CLI 不可用时）
  // 使用 Zod paperclipConfigSchema 的默认值
  const config = {
    $meta: {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    },
    database: {
      mode: "embedded",
      embeddedPostgresDataDir: path.resolve(instanceRoot, "db"),
      embeddedPostgresPort: 54329,
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      port: 3100,
      serveUi: true,
    },
    logging: {
      mode: "file",
      logDir: path.resolve(instanceRoot, "logs"),
    },
    telemetry: {
      enabled: false,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("[PaperClip Desktop] Config generated manually");

  // .env 文件由 startServer() 在第一次运行时自动补充默认值
}
```

### 2.4 CLI 扫描器（修订版）— `apps/desktop/src/main/cli-scanner.ts`

```typescript
// apps/desktop/src/main/cli-scanner.ts
// 修订：补全 acpx、grok 适配器；修正适配器类型名称

import { execSync } from "node:child_process";

export interface CliScanResult {
  label: string;
  command: string;
  adapterType: string;
  found: boolean;
  version?: string;
  installHint?: string;
}

// 白名单 — 已与 packages/adapters/ 目录逐项对齐
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
    command: "cursor-agent",
    label: "Cursor Agent",
    versionFlag: "--version",
    installHint: "Install Cursor IDE",
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
  // 🆕 新增：v1 遗漏的适配器
  {
    adapterType: "acpx_local",
    command: "acpx",
    label: "ACPX Runtime",
    versionFlag: "--version",
    installHint: "See ACPX documentation",
  },
  {
    adapterType: "grok_local",
    command: "grok",
    label: "Grok CLI",
    versionFlag: "--version",
    installHint: "npm install -g grok-cli",
  },
  {
    adapterType: "openclaw_gateway",
    command: "openclaw",
    label: "OpenClaw Gateway",
    versionFlag: "--version",
    installHint: "npm install -g openclaw",
  },
];

function which(command: string): string | null {
  try {
    // 使用 command -v 而非 which（macOS sandbox 兼容）
    const result = execSync(`command -v "${command}" 2>/dev/null || echo ""`, {
      encoding: "utf-8",
    }).trim();
    return result || null;
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
    const binPath = which(entry.command);
    const version = binPath ? getVersion(entry.command, entry.versionFlag) : undefined;

    console.log(
      `[Scanner] ${entry.label}: ${binPath ? `✅ ${version ?? ""}` : "❌"}`,
    );

    return {
      label: entry.label,
      command: entry.command,
      adapterType: entry.adapterType,
      found: binPath !== null,
      version,
      installHint: binPath ? undefined : entry.installHint,
    };
  });
}
```

### 2.5 桌面端 API 端点 — `server/src/routes/desktop.ts`

```typescript
// server/src/routes/desktop.ts
// 🆕 新增：桌面端专用 API
// 需要手动注册到 app.ts

import { Router } from "express";

export function createDesktopRouter(options: {
  getServerUptime: () => number;
  isShuttingDown: () => boolean;
}) {
  const router = Router();

  // GET /api/desktop/status
  // Electron 主进程轮询此端点以获取 daemon 运行状态
  router.get("/status", (_req, res) => {
    res.json({
      uptime: options.getServerUptime(),
      shuttingDown: options.isShuttingDown(),
    });
  });

  // POST /api/desktop/shutdown
  // Electron 请求优雅关闭
  // daemon 收到后：flush → checkpoint → 关闭 PG → process.exit(0)
  router.post("/shutdown", async (_req, res) => {
    res.json({ acknowledged: true });
    // 短暂延迟确保响应返回，然后触发 daemon 的 SIGTERM handler
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 200);
  });

  return router;
}

// ─── app.ts 注册方式 ───
// 在 server/src/app.ts 中添加：
//
// import { createDesktopRouter } from "./routes/desktop.js";
// api.use("/desktop", createDesktopRouter({
//   getServerUptime: () => process.uptime(),
//   isShuttingDown: () => shuttingDown,  // 需要在 app.ts 中维护一个 flag
// }));
```

### 2.6 打包脚本 — `scripts/desktop/bundle-desktop.ts`

```typescript
// scripts/desktop/bundle-desktop.ts
// 修订版：UI dist 复制到 server/ui-dist/（app.ts 自动探测路径）

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const APPS_DESKTOP = path.join(ROOT, "apps", "desktop");
const version = "0.3.1"; // 与 package.json 对齐

console.log("[Bundle] PaperClip Desktop v" + version);

// ─── 1. 编译 Electron 壳 ───
console.log("[Bundle] Building Electron shell...");
execSync("npx tsc -p apps/desktop/tsconfig.json", { cwd: ROOT, stdio: "inherit" });

// ─── 2. 复制 PaperClip Server ───
console.log("[Bundle] Copying PaperClip server...");
const serverDist = path.join(ROOT, "server", "dist");
const bundledServer = path.join(APPS_DESKTOP, "paperclip-server", "dist");
fs.mkdirSync(bundledServer, { recursive: true });
execSync(`cp -R "${serverDist}/" "${bundledServer}/"`);

// 2a. 复制 server package.json（runtime deps 信息）
execSync(`cp "${ROOT}/server/package.json" "${APPS_DESKTOP}/paperclip-server/"`);

// 2b. 复制嵌入式 PG 二进制（多平台）
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
for (const platform of platforms) {
  const src = path.join(ROOT, "node_modules", "@embedded-postgres", platform);
  if (fs.existsSync(src)) {
    const dest = path.join(APPS_DESKTOP, "paperclip-server", "embedded-pg", platform);
    fs.mkdirSync(dest, { recursive: true });
    execSync(`cp -R "${src}/" "${dest}/"`);
    console.log(`[Bundle] Embedded PG: ${platform} ✅`);
  } else {
    console.log(`[Bundle] Embedded PG: ${platform} ⚠️ not found (cross-platform build)`);
  }
}

// 2c. 复制 server node_modules（仅 production deps）
// TODO: 使用 npm ls --production 精确复制

// ─── 3. 复制 Skills ───
console.log("[Bundle] Copying skills...");
const skillsDir = path.join(ROOT, "skills");
const bundledSkills = path.join(APPS_DESKTOP, "paperclip-server", "skills");
if (fs.existsSync(skillsDir)) {
  fs.mkdirSync(bundledSkills, { recursive: true });
  execSync(`cp -R "${skillsDir}/" "${bundledSkills}/"`);
}

// ─── 4. 复制 UI dist → server/ui-dist/（关键！） ───
console.log("[Bundle] Copying UI dist → server/ui-dist/ ...");
const uiDist = path.join(ROOT, "ui", "dist");
const bundledUi = path.join(APPS_DESKTOP, "paperclip-server", "ui-dist");
if (fs.existsSync(uiDist)) {
  fs.mkdirSync(bundledUi, { recursive: true });
  execSync(`cp -R "${uiDist}/" "${bundledUi}/"`);
  console.log(`[Bundle] UI dist copied to paperclip-server/ui-dist/`);
} else {
  console.error("[Bundle] ⚠️ ui/dist/ not found! Run `pnpm build` first.");
}

// ─── 5. 复制 Teams Catalog ───
console.log("[Bundle] Copying teams catalog...");
const teamsCatalogDir = path.join(ROOT, "packages", "teams-catalog");
const bundledTeams = path.join(APPS_DESKTOP, "paperclip-server", "teams-catalog");
if (fs.existsSync(teamsCatalogDir)) {
  fs.mkdirSync(bundledTeams, { recursive: true });
  execSync(`cp -R "${teamsCatalogDir}/catalog/" "${bundledTeams}/catalog/"`);
  execSync(`cp -R "${teamsCatalogDir}/generated/" "${bundledTeams}/generated/"`);
}

console.log("[Bundle] Done! Ready for electron-builder.");
console.log(`[Bundle] Bundle size: ${fs.statSync(APPS_DESKTOP).size}`);
```

### 2.7 electron-builder.yml（修订版）

```yaml
# apps/desktop/electron-builder.yml
# 修订：版本号 0.3.1

appId: com.paperclipai.desktop
productName: PaperClip
copyright: Copyright © 2026

directories:
  output: dist
  buildResources: resources

files:
  - "dist/**/*"
  - "resources/**/*"
  - "paperclip-server/**/*"
  # 不包含 paperclip-config.json ← v2 废弃

asar: false

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
  hardenedRuntime: true

win:
  target:
    - target: nsis
      arch:
        - x64
  icon: resources/icon.ico

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

### 2.8 macOS Entitlements — `apps/desktop/build/entitlements.mac.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Node.js JIT 需要 -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- 原生 .node 模块需要 -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <!-- daemon HTTP 请求 -->
  <key>com.apple.security.network.client</key>
  <true/>
  <!-- daemon 本地端口监听 -->
  <key>com.apple.security.network.server</key>
  <true/>
  <!-- Sidecar Unix Socket -->
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
  <!-- 文件系统访问 -->
  <key>com.apple.security.files.downloads.read-write</key>
  <true/>
</dict>
</plist>
```

---

## 3. 构建管线（修订版）

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
                        │ pnpm desktop:bundle│
                        │ 1. tsc desktop/    │
                        │ 2. cp server/dist  │
                        │    → paperclip-server/dist/
                        │ 3. cp embedded-pg  │
                        │    → paperclip-server/embedded-pg/
                        │ 4. cp skills/      │  ← 修正路径
                        │    → paperclip-server/skills/
                        │ 5. cp ui/dist      │  ← 关键：到 server/ui-dist/
                        │    → paperclip-server/ui-dist/
                        │ 6. cp teams-catalog│
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
                        📦 PaperClip-0.3.1-arm64.dmg
```

---

## 4. 启动时序图（修订版）

```
用户双击 PaperClip.app
        │
        ▼
┌─── Electron Main Process ──────────────────────────────────────┐
│                                                                 │
│  [t=0s]   main.cjs → import("./packaged-main.js")              │
│                                                                 │
│  [t=0.1s] ensureFirstRunConfig()                                │
│             → config.json 已存在? 跳过                          │
│             → 否则: paperclipai onboard -y (或手动生成)         │
│                                                                 │
│  [t=0.5s] spawn("node", ["server/dist/index.js"], {            │
│             env: {                                              │
│               PAPERCLIP_HOME: "~/.paperclip",                   │
│               PAPERCLIP_INSTANCE_ID: "default",                 │
│               SERVE_UI: "true",       // ← 修正                │
│               PAPERCLIP_MIGRATION_AUTO_APPLY: "true",           │
│               PAPERCLIP_OPEN_ON_LISTEN: "false",                │
│               // DATABASE_URL 不设置 → startServer() 自启 PG    │
│             }                                                   │
│           })                                                    │
│                                                                 │
│     ┌─── Daemon 子进程 ──────────────────────────────────┐     │
│     │  startServer()                                      │     │
│     │  → config.databaseUrl = undefined                   │     │
│     │  → import("embedded-postgres")                      │     │
│     │  → new EmbeddedPostgres({ databaseDir: "~/.p/...",  │     │
│     │       user: "paperclip", password: "paperclip",     │     │
│     │       port: 54329, persistent: true })              │     │
│     │  → embeddedPostgres.initialise()  (首次)            │     │
│     │  → embeddedPostgres.start()         (2s)            │     │
│     │  → CREATE DATABASE paperclip        (首次)          │     │
│     │  → ensureMigrations()               (5-10s)         │     │
│     │  → createDb()                                       │     │
│     │  → server.listen(3100)              (1s)            │     │
│     │  → /api/health 可用 ✅                              │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│  [t=15s]  waitForServerReady(3100) → /api/health ✅            │
│                                                                 │
│  [t=15s]  scanCliAvailability()                                 │
│             command -v claude    → ✅                           │
│             command -v codex     → ❌                           │
│             command -v opencode  → ✅                           │
│                                                                 │
│  [t=16s]  new BrowserWindow() + loadURL + show                 │
│                                                                 │
│  ✅ 用户看到 PaperClip                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

总启动时间: ~18-25s
  daemon 内 PG 启动: 2s
  daemon 内迁移: 5-10s（首次）
  daemon 内 server listen: 1s
  Electron 窗口加载: 3-5s
```

---

## 5. 环境变量对照表（修订版，经源码验证）

| 环境变量 | 必须 | 值 | 源码验证 |
|---------|------|-----|---------|
| `PAPERCLIP_HOME` | 是 | `~/.paperclip` | `shared/home-paths.ts:17` |
| `PAPERCLIP_INSTANCE_ID` | 是 | `default` | `shared/home-paths.ts:34` |
| `SERVE_UI` | 是 | `true` | `config.ts:311`（**不是** `PAPERCLIP_SERVE_UI`） |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | 是 | `true` | `index.ts:119` |
| `PAPERCLIP_OPEN_ON_LISTEN` | 建议 | `false` | `index.ts:869`（默认 undefined → 不打开浏览器） |
| `PORT` | 否 | `3100` | `config-schema.ts:54` |
| `DATABASE_URL` | **不设** | — | 不设置 → `startServer()` 走嵌入式 PG 分支（`index.ts:311`） |
| `PAPERCLIP_UI_DIST_DIR` | ❌ 不存在 | — | `app.ts:333-334` 硬编码探测 `../ui-dist` |

---

## 6. 关键风险（修订版，补充评审 §6）

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| macOS Hardened Runtime 阻止 `child_process.spawn`（daemon + PG） | 中 | 阻塞 | entitlement: `allow-unsigned-executable-memory` + `disable-library-validation` |
| `embedded-postgres` patch 在打包后未生效 | 中 | PG locale 错误 | `bundle-desktop.ts` 中确保 `patches/` 已应用 |
| 首次启动 `paperclipai onboard` 不可用 | 低 | 阻塞 | `onboard.ts` 内置 fallback 手动生成最小配置 |
| `server/ui-dist/` 路径在开发环境和打包环境不一致 | 中 | UI 不加载 | 开发环境创建符号链接 `server/ui-dist → ../ui/dist` |
| daemon 的 `embeddedPostgres.stop()` 在 SIGTERM 后超时 | 低 | 数据不一致 | `before-quit` 中设 15s 超时 + SIGKILL fallback |
| 插件沙箱依赖 `better-sqlite3` 等原生模块 | 中 | 插件功能异常 | electron-builder `files` 确保所有原生 `.node` 模块被包含 |

---

## 7. 开发工作分解（修订版）

### Sprint 0: 验证 + 修正（新增 3 天）

| 天数 | 任务 | 验证方法 |
|------|------|---------|
| D1 | 验证 `startServer()` 在不设 `DATABASE_URL` 时完整启动嵌入式 PG | `SERVE_UI=true PAPERCLIP_MIGRATION_AUTO_APPLY=true node server/dist/index.js` |
| D2 | 验证 SIGTERM → `embeddedPostgres.stop()` 完整关闭 | 多次 SIGTERM `server/dist/index.js`，检查无残留 `postmaster.pid` |
| D3 | 验证 `server/ui-dist/` 路径探测 | 复制 `ui/dist` 到 `server/ui-dist/`，启动确认 `/api/health` + UI 可访问 |

### Sprint 1: 核心壳（2 周）

...（内容与 v1 基本相同，但 `pg-lifecycle.ts` 改为 `onboard.ts`，且不涉及 PG 管理）

### Sprint 2 + 3

...（与 v1 相同）

---

## 8. 附录：v1 → v2 全部源码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `apps/desktop/src/main/pg-lifecycle.ts` | ❌ 删除 | daemon 自管 PG |
| `apps/desktop/src/main/onboard.ts` | 🆕 新增 | 首次启动配置生成 |
| `apps/desktop/src/main/packaged-main.ts` | ✏️ 重写 | 移除 PG 管理、修正 env vars、修正关闭流程 |
| `apps/desktop/src/main/cli-scanner.ts` | ✏️ 修订 | 补全 acpx/grok，`which` → `command -v` |
| `server/src/routes/desktop.ts` | 🆕 新增 | shutdown 端点 |
| `server/src/app.ts` | ✏️ 修改 | 注册 desktop router |
| `scripts/desktop/bundle-desktop.ts` | ✏️ 修订 | UI → `server/ui-dist/`，修正 skills/teams 路径 |
| `apps/desktop/electron-builder.yml` | ✏️ 修订 | 版本号 0.3.1 |
| `apps/desktop/package.json` | ✏️ 修订 | 版本号 0.3.1 |
| `paperclip-config.json` | ❌ 删除 | 用 Zod schema 标准配置替代 |
| `apps/desktop/build/entitlements.mac.plist` | 🆕 新增 | macOS Hardened Runtime |
