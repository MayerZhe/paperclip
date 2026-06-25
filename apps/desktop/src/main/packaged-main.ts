// apps/desktop/src/main/packaged-main.ts
// S-A5: Rewrite runDesktopMain() — unified startup flow with sidebar shell
//
// New flow:
//   checkExistingSession → (if no session) createAuthBridge login →
//   startBothModes → createSidebarManager → push org/status data →
//   register IPC handlers → createTray + createAppMenu → shutdown handler
//
// Architecture: Both modes start in parallel via mode-manager. The sidebar
// shell (BrowserWindow + WebContentsView) manages visibility. No more
// "stop one, start the other" dual-branch startup.

import { app, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fork, exec, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSidecarServer } from "./sidecar-server.js";
import { scanCliAvailability, type CliScanResult } from "./cli-scanner.js";
import { createTray, updateTrayState, startTrayHeartbeat } from "./tray.js";
import { createAppMenu, type MenuOptions } from "./menu.js";
import { createUpdater, type Updater } from "./updater.js";
import { showNotification } from "./notifications.js";
import { SIDECAR_MESSAGES } from "../shared/sidecar-proto.js";
import { ensureFirstRunConfig } from "./onboard.js";
import { registerContextMenuHandler } from "./context-menu.js";
import { createAuthBridge, checkExistingSession, type LoginResult } from "./auth-bridge.js";
import {
  startBothModes,
  stopBothModes,
  type ModeStartupResult,
} from "./mode-manager.js";
import { createSidebarManager, type SidebarManager } from "./sidebar-manager.js";
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
const DEFAULT_SERVER_PORT = 3200;

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
// We always set PORT=3200; if the daemon can't bind to it, it will fail
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
  // Prefer tsc-compiled ESM entry (dist/index.js) over esbuild bundle.
  // esbuild bundle corrupts __dirname references in bundled packages (e.g. jsdom
  // reads its own default-stylesheet.css from disk — __dirname resolves to dist/
  // instead of node_modules/jsdom/lib/jsdom/browser/).  Using the tsc-compiled
  // ESM with pnpm-deployed node_modules avoids this entirely.
  const candidates = [
    // ── Packaged app candidates ──
    // Candidate 1: Resources/app/dist/main/ → ../../.. → Resources/paperclip-server/dist/index.js
    //              In packaged app: dist/main/ in asar=false → ../../.. = Resources/ → ✅
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.js"),
    // Candidate 2: index.bundle.cjs (esbuild bundle — fallback; has __dirname path issues)
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.bundle.cjs"),
    // Candidate 3: index.bundle.mjs (ESM bundle fallback)
    path.join(__dirname, "..", "..", "..", "paperclip-server", "dist", "index.bundle.mjs"),

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
      console.log(`[SuperNode Desktop] Daemon entry: ${c}`);
      return c;
    }
  }
  throw new Error(
    `Daemon entry not found. Checked: ${candidates.join(", ")}`,
  );
}

// ─── Agent Mode daemon 启动（提取为可复用的回调，供 mode-manager 调用） ───
async function startAgentDaemon(): Promise<{ daemon: ChildProcess; serverPort: number }> {
  // Phase 0: 首次启动 — 生成配置（ensureFirstRunConfig 内部会跳过已存在的配置）
  await ensureFirstRunConfig({
    homeDir: PAPERCLIP_HOME,
    instanceId: PAPERCLIP_INSTANCE_ID,
  });

  // Phase 1: 启动 SuperNode Server
  const daemonEntry = resolveDaemonEntry();
  const serverPort = findAvailablePort();

  const daemonDir = path.dirname(daemonEntry);
  const daemonRoot = path.dirname(daemonDir);

  const serverEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PAPERCLIP_HOME,
    PAPERCLIP_INSTANCE_ID: "default",
    PORT: String(serverPort),
    SERVE_UI: "true",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    HOST: "127.0.0.1",
    PAPERCLIP_TEAMS_CATALOG_DIR: path.join(daemonRoot, "teams-catalog"),
    PAPERCLIP_SKILLS_CATALOG_DIR: path.join(daemonRoot, "skills-catalog"),
    PAPERCLIP_ONBOARDING_ASSETS_DIR: path.join(daemonRoot, "onboarding-assets"),
  };

  console.log(`[SuperNode Desktop] Starting daemon on port ${serverPort}...`);

  const daemon: ChildProcess = fork(daemonEntry, [], {
    env: serverEnv,
    cwd: PAPERCLIP_HOME,
    silent: true,
  });

  daemon.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[daemon] ${data}`);
  });
  daemon.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[daemon] ${data}`);
  });
  daemon.on("exit", (code, signal) => {
    console.log(`[SuperNode Desktop] Daemon exited (code=${code}, signal=${signal})`);
  });

  const ready = await waitForServerReady(serverPort, 60000);
  if (!ready) {
    daemon.kill("SIGTERM");
    throw new Error("SuperNode Server did not become ready within 60 seconds");
  }
  console.log("[SuperNode Desktop] Daemon ready");
  return { daemon, serverPort };
}

// ─── Agent Mode daemon 停止（提取为可复用的回调，供 mode-manager 调用） ───
async function stopAgentDaemon(daemon: ChildProcess, serverPort: number): Promise<void> {
  console.log("[SuperNode Desktop] Stopping agent daemon...");

  await fetch(`http://127.0.0.1:${serverPort}/api/desktop/shutdown`, {
    method: "POST",
  }).catch(() => {});

  if (!daemon.killed) {
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[SuperNode Desktop] Daemon didn't exit in time, force killing");
        daemon.kill("SIGKILL");
        resolve();
      }, 20000);
      daemon.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  console.log("[SuperNode Desktop] Agent daemon stopped");
}

// ─── 主启动流程 ───
export async function runDesktopMain(): Promise<void> {
  // ── Phase 0: 环境初始化 ───────────────────────────────────────────────

  process.env.PAPERCLIP_DESKTOP_VERSION = DESKTOP_VERSION;

  // Default to local_trusted mode when no cloud auth is configured.
  // This enables offline/standalone use without requiring a login API at localhost:3000.
  // Users with cloud auth can override via PAPERCLIP_DEPLOYMENT_MODE=authenticated.
  if (!process.env.PAPERCLIP_DEPLOYMENT_MODE && !process.env.DEPLOYMENT_MODE) {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
  }

  // ── Phase 1: 等待 Electron app 就绪，然后检查已有会话 ─────────────────
  // ⚠️ checkExistingSession() 在内部创建 BrowserWindow，必须在 app.whenReady() 之后调用，
  // 否则 Electron 抛出 "Session can only be received when app is ready"。

  await app.whenReady();

  let loginResult: LoginResult | null = await checkExistingSession();

  // If no existing session, open login window
  if (!loginResult) {
    loginResult = await new Promise<LoginResult | null>((resolve) => {
      try {
        const loginWindow = createAuthBridge({
          onLoginComplete: (result) => {
            loginWindow.close();
            resolve(result);
          },
          onLoginFailed: (err) => {
            console.error("[SuperNode Desktop] Login failed:", err.message);
            loginWindow.close();
            resolve(null);
          },
        });
        loginWindow.on("closed", () => {
          // User closed the login window without completing login — cancelled
          resolve(null);
        });
      } catch (err) {
        console.error("[SuperNode Desktop] Failed to create login window:", err);
        resolve(null);
      }
    });

    if (!loginResult) {
      console.log("[SuperNode Desktop] Login cancelled or failed — quitting");
      app.quit();
      return;
    }
  }

  const { token, user, orgs, selectedOrgId } = loginResult;
  const selectedOrg = orgs?.find((o) => o.id === selectedOrgId) ?? orgs?.[0];

  // ── Phase 2: 确保首次启动配置（为 agent mode 准备） ──────────────────

  await ensureFirstRunConfig({
    homeDir: PAPERCLIP_HOME,
    instanceId: PAPERCLIP_INSTANCE_ID,
  });

  // ── Phase 3: 并行启动两种模式 ────────────────────────────────────────

  const requestedPort = findAvailablePort();
  const daemonEntry = resolveDaemonEntry();

  // sidebarMgr declared here but not yet created — mode-manager's onStatusChange
  // fires synchronously during startBothModes, so we buffer updates until
  // sidebarMgr is assigned in Phase 4.
  let sidebarMgr: SidebarManager | null = null;
  const pendingStatusUpdates: Array<{ mode: "agent" | "agenthubs"; status: "online" | "offline" | "loading" }> = [];
  let agentDaemonReady = false;
  let agentDaemonPort: number | null = null;

  const applyStatusUpdate = (mode: "agent" | "agenthubs", status: "online" | "offline" | "loading") => {
    if (sidebarMgr) {
      sidebarMgr.updateStatus(mode, status);
    } else {
      pendingStatusUpdates.push({ mode, status });
    }
  };

  /** Activate agent tab — call when daemon is confirmed ready */
  const activateAgentMode = () => {
    if (!sidebarMgr) return;
    const port = agentDaemonPort ?? requestedPort;
    sidebarMgr.updateAgentUrl(port);
    sidebarMgr.switchToMode("agent");
  };

  // ── Phase 3: 并行启动两种模式（fire-and-continue — 不阻塞 Sidebar 创建）──
  //
  // 原先 await startBothModes() 在 Docker daemon 不可用时可能阻塞 140-180s，
  // 导致 creatSidebarManager() 永远不执行。改为先启动、先创建 sidebar、
  // 后 await 结果的策略。onStatusChange 回调通过 pendingStatusUpdates 缓冲，
  // 在 sidebar 创建后 flush，确保 status dots 正确渲染。
  const modeResultPromise = startBothModes({
    paperclipHome: PAPERCLIP_HOME,
    agentConfig: { daemonEntry, serverPort: requestedPort },
    agenthubsConfig: { token },
    startAgentDaemon: async (_entry: string, _port: number) => {
      const result = await startAgentDaemon();
      return { daemon: result.daemon, port: result.serverPort };
    },
    stopAgentDaemon: async (daemon: ChildProcess, port: number) => {
      await stopAgentDaemon(daemon, port);
    },
    onStatusChange: (mode, status, _error) => {
      const mapped = status === "running" ? "online" : status === "error" ? "offline" : "loading";
      applyStatusUpdate(mode, mapped);
      // When agent daemon becomes ready, switch to agent tab immediately.
      // Do NOT wait for AgentHubs VM — VM boot blocks for 120s in sandbox.
      if (mode === "agent" && status === "running") {
        agentDaemonReady = true;
        agentDaemonPort = requestedPort;
        activateAgentMode();
      }
    },
  });

  // ── Phase 4: 创建 Sidebar Shell（BrowserWindow + WebContentsView） ───
  // 立即创建，不等待 modeResult — 用户立即可见 sidebar UI

  sidebarMgr = createSidebarManager({
    shellHtmlPath: path.join(__dirname, "..", "renderer", "shell.html"),
    shellPreloadPath: path.join(__dirname, "..", "renderer", "shell-preload.js"),
    jwtToken: token,
    agentPort: requestedPort,
    onSignOut: async () => {
      // Clear session and restart login by quitting
      app.quit();
    },
  });

  // Flush pending status updates now that sidebarMgr is assigned
  for (const update of pendingStatusUpdates) {
    sidebarMgr.updateStatus(update.mode, update.status);
  }
  pendingStatusUpdates.length = 0;

  // If agent daemon became ready before sidebarMgr was created, activate now
  if (agentDaemonReady) {
    activateAgentMode();
  }

  const mainWindow = sidebarMgr.getWindow();

  // ── Phase 5: Push 初始数据到 Sidebar ──────────────────────────────────

  sidebarMgr.updateOrgInfo({
    name: selectedOrg?.name ?? "AgentHubs",
    role: "Owner",
    balance: "Loading...",
    email: user?.email ?? "",
  });

  // ── Phase 6: 注册 IPC Handlers ─────────────────────────────────────────

  registerContextMenuHandler();

  // CLI IPC handlers
  ipcMain.handle("paperclip:get-cli-scan", async () => {
    return await scanCliAvailability();
  });

  ipcMain.handle("paperclip:install-cli", async (_event, { adapterType }: { adapterType: string }) => {
    const ALLOWED_INSTALL = ["claude_local", "codex_local", "antigravity_local"];
    if (!ALLOWED_INSTALL.includes(adapterType)) {
      throw new Error(`Install not supported for ${adapterType}`);
    }
    const scanResults = await scanCliAvailability();
    const entry = scanResults.find((r) => r.adapterType === adapterType);
    if (!entry || !entry.installHint) {
      throw new Error(`No install command found for ${adapterType}`);
    }
    return new Promise<{ success: boolean; output: string }>((resolve, reject) => {
      exec(entry.installHint!, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve({ success: true, output: stdout });
      });
    });
  });

  // ── S-3F1: VM download + status IPC handlers (Welcome screen) ─────────
  import("./download-vm-image.js").then(({ downloadVmImage, isVmImageDownloaded }) => {
    // shell:vm-download — trigger VM image download
    ipcMain.on("shell:vm-download", async () => {
      try {
        await downloadVmImage({
          onProgress: (progress) => {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send("sidebar:vm-download-progress", progress);
            }
          },
        });
      } catch (err) {
        console.error("[SuperNode Desktop] VM download failed:", err);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send("sidebar:vm-download-progress", {
            percent: 0,
            downloadedMB: 0,
            totalMB: 0,
            stage: "error",
          });
        }
      }
    });

    // shell:vm-download-cancel — cancel VM download (noop for now)
    ipcMain.on("shell:vm-download-cancel", () => {
      console.log("[SuperNode Desktop] VM download cancel requested (noop)");
    });

    // shell:vm-status — check if VM bundle is ready
    ipcMain.handle("shell:vm-status", async () => {
      return {
        downloaded: isVmImageDownloaded(),
        manifest: null,
      };
    });
  });

  // ── Phase 7: 启动 Tray + App Menu + Sidecar + Updater ──────────────────
  // Do NOT await modeResultPromise here — AgentHubs VM boot takes ~120s
  // in sandbox and blocking on it prevents the UI from loading. Instead,
  // chain post-startup work on the promise and finish the critical path now.

  // Use defaults for agent port until modeResult resolves
  const fallbackPort = requestedPort;
  let stopHeartbeat = () => {};

  // Create tray + menu immediately (with fallback port)
  const cliResultsPromise = scanCliAvailability();

  const onSwitchMode = () => {
    if (!sidebarMgr) return;
    const current = sidebarMgr.getCurrentMode();
    sidebarMgr.switchToMode(current === "agent" ? "agenthubs" : "agent");
  };

  createTray(mainWindow, onSwitchMode, "agenthubs");

  const menuOpts: MenuOptions = {
    mode: "agenthubs",
    onSwitchMode,
  };
  // Menu & heartbeat use fallback port — updated once modeResult settles
  createAppMenu(mainWindow, fallbackPort, [], menuOpts);

  // Sidecar Server
  const sidecarSocketPath = path.join(os.tmpdir(), "paperclip-desktop-sidecar.sock");
  const sidecarServer = createSidecarServer(sidecarSocketPath, (msg) => {
    handleSidecarMessage(msg, () => {
      console.log("[SuperNode Desktop] Sidecar requested shutdown — triggering app quit");
      app.quit();
    });
  });

  // Updater
  const updater: Updater = createUpdater(DESKTOP_VERSION, mainWindow);

  // Resolve CLI scan in background — send results to renderer when ready
  cliResultsPromise.then((cliResults) => {
    console.log(
      "[SuperNode Desktop] CLI scan:",
      cliResults.filter((r) => r.found).map((r) => r.label),
    );
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("paperclip:cli-scan", cliResults);
    }
  });

  // ── Phase 8: Post-startup tasks (non-blocking) ──
  // When modeResult settles, update tray/menu with actual port + start heartbeat

  let modeResult: ModeStartupResult | null = null;

  modeResultPromise.then((result) => {
    modeResult = result;
    if (result.agent.success) {
      stopHeartbeat = startTrayHeartbeat(result.agent.port);
      // Ensure sidebar is on agent mode (may already be from onStatusChange)
      if (!agentDaemonReady) {
        activateAgentMode();
      }
    }
  }).catch((err) => {
    console.error("[SuperNode Desktop] Mode startup error:", err);
  });

  // ── Phase 9: Shutdown Handler ────────────────────────────────────────

  app.on("before-quit", (event) => {
    event.preventDefault();
    console.log("[SuperNode Desktop] Shutting down...");
    stopHeartbeat();
    const cleanup = () => {
      sidecarServer?.close();
    };
    if (modeResult) {
      Promise.allSettled([
        stopBothModes(modeResult, stopAgentDaemon),
        Promise.resolve().then(cleanup),
      ]).finally(() => {
        setTimeout(() => app.exit(0), 1000);
      });
    } else {
      cleanup();
      setTimeout(() => app.exit(0), 1000);
    }
  });

  app.on("activate", () => mainWindow.show());

  console.log("[SuperNode Desktop] Startup complete");
}

// 直接入口判断
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void runDesktopMain().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
