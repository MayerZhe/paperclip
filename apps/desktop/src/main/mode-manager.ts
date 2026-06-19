// apps/desktop/src/main/mode-manager.ts
// Story 1.4: 模式管理器 — 管理 Agent ↔ AgentHubs 模式切换
//
// 状态机: idle → stopping(旧模式) → starting(新模式) → running | error
// 关键约束:
//   - 模式切换必须等旧模式完全停止后才启动新模式
//   - Agent Mode daemon 的 fork/spawn 逻辑保持在 packaged-main.ts 中，mode-manager 只通过回调调用
//   - 切换超时：停止旧模式最多 60s（AgentHubs），启动新模式最多 60s
//   - 切换失败 → state='error' + 保持旧模式 running（不回退到 broken 状态）
//   - 首次启动默认 Agent Mode（不强制下载 VM image）

import { type BrowserWindow } from "electron";
import { type ChildProcess } from "node:child_process";
import { getModePreference, setModePreference, type ModePreference } from "./onboard.js";
import { detectContainerRuntime, type ContainerRuntimeInfo } from "./container-runtime.js";
import { updateTrayMode, type LaunchMode } from "./tray.js";
import { updateMenuMode, type MenuMode } from "./menu.js";

// ─── 类型定义 ───

/** 应用启动模式 */
export type AppMode = "agent" | "agenthubs";

/** 模式管理器状态 */
export type ModeState = "idle" | "stopping" | "starting" | "running" | "error";

/** 模式管理器完整状态 */
export interface ModeManagerState {
  currentMode: AppMode;
  state: ModeState;
  error?: string;
}

/** switchToMode 所需的配置/回调 */
export interface SwitchModeConfig {
  /** PaperClip home 目录 (~/.paperclip) */
  paperclipHome: string;
  /** Electron BrowserWindow 实例 */
  browserWindow: BrowserWindow;
  /** Agent Mode 的 daemon 子进程（当前运行时传入，便于 stop/kill） */
  daemonProcess?: ChildProcess;
  /** 启动 Agent Mode daemon 的回调（packaged-main 提供 fork + waitForServerReady） */
  onDaemonStart?: () => Promise<void>;
  /** 停止 Agent Mode daemon 的回调（packaged-main 提供 shutdown 逻辑） */
  onDaemonStop?: () => Promise<void>;
}

// ─── 内部状态 ───

let modeState: ModeManagerState = {
  currentMode: "agent",
  state: "idle",
};

// ─── 常量 ───

const AGENTHUB_URL = "http://127.0.0.1:4000";
const AGENT_URL = "http://127.0.0.1:3100";
const STOP_TIMEOUT_MS = 60000;   // 停止旧模式最多 60s（AgentHubs 可较长）
const START_TIMEOUT_MS = 60000;  // 启动新模式最多 60s
const DAEMON_STOP_TIMEOUT_MS = 30000; // daemon 单次停止超时 30s

// ─── 导出接口 ───

/** 获取当前模式管理器状态 */
export function getModeManagerState(): ModeManagerState {
  return { ...modeState };
}

/**
 * 初始化 — 读取上次模式偏好，决定启动模式
 *
 * 逻辑:
 * 1. 调用 getModePreference(homeDir)
 * 2. 如果偏好是 'agenthubs':
 *    - 检测容器运行时
 *    - 有容器运行时 → 返回 'agenthubs'
 *    - 无容器运行时 → 返回 'agent'（fallback）
 * 3. 否则 → 返回 'agent'（默认）
 */
export function getInitialMode(paperclipHome: string): AppMode {
  const preference: ModePreference | null = getModePreference(paperclipHome);

  if (preference && preference.mode === "agenthubs") {
    const runtime: ContainerRuntimeInfo = detectContainerRuntime();
    if (runtime.available.length > 0) {
      console.log(
        `[PaperClip Desktop] Mode preference: agenthubs (container: ${runtime.primary})`,
      );
      return "agenthubs";
    }
    console.warn(
      "[PaperClip Desktop] Mode preference is agenthubs but no container runtime found — falling back to agent",
    );
    return "agent";
  }

  if (preference) {
    console.log(`[PaperClip Desktop] Mode preference: ${preference.mode}`);
    return preference.mode;
  }

  console.log("[PaperClip Desktop] No mode preference — defaulting to agent");
  return "agent";
}

/**
 * 代码中更新模式状态（不持久化到 preference — 由 switchToMode 统一管理）
 */
function setModeManagerState(partial: Partial<ModeManagerState>): void {
  modeState = { ...modeState, ...partial };
  if (partial.currentMode) {
    console.log(`[PaperClip Desktop] Mode: ${partial.currentMode}, State: ${modeState.state}`);
  } else {
    console.log(`[PaperClip Desktop] Mode state: ${modeState.state}`);
  }
}

// ─── 启动/停止辅助 ───

/** 等待 daemon 进程退出（最多 timeout 毫秒） */
function waitForDaemonExit(daemonProcess: ChildProcess, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Daemon did not exit within ${timeout}ms`));
    }, timeout);

    daemonProcess.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    // 如果 daemon 已经退出，on("exit") 之前注册的监听器已经触发过，
    // 检查 killed 标志
    if (daemonProcess.killed) {
      clearTimeout(timer);
      resolve();
    }
  });
}

// ─── 切换到 AgentHubs Mode ───

/**
 * 切换到 AgentHubs 模式的内部实现
 *
 * 流程:
 * 1. 检测容器运行时（如果无 → throw with guide message）
 * 2. state → 'stopping'
 * 3. 停止 Agent Mode daemon
 * 4. state → 'starting'
 * 5. 启动 AgentHubs Mode
 * 6. BrowserWindow.loadURL('http://127.0.0.1:4000')
 * 7. 更新托盘 + 菜单 + 保存偏好
 * 8. state → 'running'
 */
async function switchToAgentHubs(config: SwitchModeConfig): Promise<void> {
  const { paperclipHome, browserWindow, daemonProcess, onDaemonStop } = config;

  // 1. 检测容器运行时
  const runtime: ContainerRuntimeInfo = detectContainerRuntime();
  if (runtime.available.length === 0) {
    const guide = [
      "AgentHubs mode requires a container runtime. No container runtime was detected.",
      "",
      "Install one of the following:",
      "  - OrbStack: https://orbstack.dev/  (recommended for macOS)",
      "  - Docker Desktop: https://www.docker.com/products/docker-desktop/",
      "  - Colima: brew install colima && colima start",
      "  - Podman: brew install podman && podman machine init && podman machine start",
      "",
      "After installing, restart PaperClip and try again.",
    ].join("\n");

    throw new Error(guide);
  }

  // 2. state → 'stopping'
  setModeManagerState({ state: "stopping" });

  // 3. 停止 Agent Mode daemon
  if (daemonProcess && onDaemonStop) {
    try {
      await onDaemonStop();
    } catch (err) {
      console.warn("[PaperClip Desktop] onDaemonStop threw:", err);
    }

    // 等待 daemon 进程真正退出
    if (!daemonProcess.killed) {
      try {
        await waitForDaemonExit(daemonProcess, DAEMON_STOP_TIMEOUT_MS);
      } catch {
        console.warn(
          "[PaperClip Desktop] Daemon did not exit in time during mode switch, force killing",
        );
        daemonProcess.kill("SIGKILL");
        // 再等待一小段时间确保进程清理
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 4. state → 'starting'
  setModeManagerState({ state: "starting" });

  // 5. 启动 AgentHubs Mode
  //    startAgentHubsMode 来自 agenthubs-mode.ts（由 Story 1.3 实现）
  //    该函数内部执行: docker compose up → 健康检查 → 返回成功
  //
  //    注意: 使用动态 import 避免循环依赖 — agenthubs-mode.ts 是独立模块，
  //    在 mode-manager 中按需加载。如果模块尚不存在，import 会 throw。
  const { startAgentHubsMode } = await import("./agenthubs-mode.js");

  const startResult = await Promise.race([
    startAgentHubsMode({
      paperclipHome,
      containerRuntime: runtime.primary ?? "docker",
      onProgress: (msg: string) => {
        console.log(`[PaperClip Desktop] AgentHubs: ${msg}`);
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("AgentHubs mode startup timed out after 60s")),
        START_TIMEOUT_MS,
      ),
    ),
  ]);

  if (!startResult || startResult.status === "error") {
    throw new Error(
      `AgentHubs mode failed to start: ${startResult?.error ?? "unknown error"}`,
    );
  }

  // 6. BrowserWindow.loadURL('http://127.0.0.1:4000')
  try {
    await browserWindow.loadURL(AGENTHUB_URL);
  } catch (err) {
    console.error("[PaperClip Desktop] Failed to load AgentHubs URL:", err);
    throw new Error(`Failed to load AgentHubs UI at ${AGENTHUB_URL}: ${err}`);
  }

  // 7. 更新托盘 + 菜单
  updateTrayMode("agenthubs");
  updateMenuMode("agenthubs", browserWindow);

  // 8. 保存模式偏好
  setModePreference(paperclipHome, "agenthubs");

  // 9. state → 'running'
  setModeManagerState({ currentMode: "agenthubs", state: "running", error: undefined });
}

// ─── 切换到 Agent Mode ───

/**
 * 切换到 Agent 模式的内部实现
 *
 * 流程:
 * 1. state → 'stopping'
 * 2. 停止 AgentHubs Mode
 * 3. state → 'starting'
 * 4. 启动 Agent Mode daemon
 * 5. BrowserWindow.loadURL('http://127.0.0.1:3100')
 * 6. 更新托盘 + 菜单 + 保存偏好
 * 7. state → 'running'
 */
async function switchToAgent(config: SwitchModeConfig): Promise<void> {
  const { paperclipHome, browserWindow, onDaemonStart } = config;

  // 1. state → 'stopping'
  setModeManagerState({ state: "stopping" });

  // 2. 停止 AgentHubs Mode
  //    stopAgentHubsMode 来自 agenthubs-mode.ts（由 Story 1.3 实现）
  //    该函数内部执行: docker compose down → 等待清理
  //
  //    注意: 使用动态 import 避免循环依赖。如果模块尚不存在则 throw —
  //    此时当前模式是 agenthubs（否则不会调用 switchToAgent），
  //    但 agenthubs-mode.ts 未实现，属于配置错误。
  try {
    const runtime: ContainerRuntimeInfo = detectContainerRuntime();
    const { stopAgentHubsMode } = await import("./agenthubs-mode.js");

    await Promise.race([
      stopAgentHubsMode({
        composePath: undefined, // agenthubs-mode 内部自行推断 compose 文件路径
        containerRuntime: runtime.primary ?? "docker",
        timeout: Math.floor(STOP_TIMEOUT_MS / 1000), // StopAgentHubsConfig.timeout 以秒为单位
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("AgentHubs mode stop timed out after 60s")),
          STOP_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    // 如果 agenthubs-mode.ts 模块不存在，记录警告但继续尝试启动 agent
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      console.warn(
        "[PaperClip Desktop] agenthubs-mode.ts not implemented yet, skipping AgentHubs stop",
      );
    } else {
      console.warn("[PaperClip Desktop] Error stopping AgentHubs mode:", err);
    }
  }

  // 3. state → 'starting'
  setModeManagerState({ state: "starting" });

  // 4. 启动 Agent Mode daemon
  if (!onDaemonStart) {
    throw new Error("onDaemonStart callback is required to switch to Agent mode");
  }

  await Promise.race([
    onDaemonStart(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Agent mode daemon startup timed out after 60s")),
        START_TIMEOUT_MS,
      ),
    ),
  ]);

  // 5. BrowserWindow.loadURL('http://127.0.0.1:3100')
  try {
    await browserWindow.loadURL(AGENT_URL);
  } catch (err) {
    console.error("[PaperClip Desktop] Failed to load Agent URL:", err);
    throw new Error(`Failed to load Agent UI at ${AGENT_URL}: ${err}`);
  }

  // 6. 更新托盘 + 菜单
  updateTrayMode("agent");
  updateMenuMode("agent", browserWindow);

  // 7. 保存模式偏好
  setModePreference(paperclipHome, "agent");

  // 8. state → 'running'
  setModeManagerState({ currentMode: "agent", state: "running", error: undefined });
}

// ─── 核心模式切换函数 ───

/**
 * 模式切换（核心函数）
 *
 * 状态机:
 *   agent → stopping_agent → stopped → starting_agenthubs → agenthubs
 *   agenthubs → stopping_agenthubs → stopped → starting_agent → agent
 *
 * 切换失败 → state='error' + 保持旧模式 running（不回退到 broken 状态）
 *
 * 并发保护: 如果已经在切换中 (state === 'stopping' || state === 'starting')，
 *           直接返回，避免重复切换导致状态混乱。
 */
export async function switchToMode(
  targetMode: AppMode,
  config: SwitchModeConfig,
): Promise<void> {
  // 并发保护：如果已经在切换中，忽略重复请求
  if (modeState.state === "stopping" || modeState.state === "starting") {
    console.warn(
      `[PaperClip Desktop] Mode switch already in progress (state=${modeState.state}), ignoring request to switch to ${targetMode}`,
    );
    return;
  }

  // 已经是目标模式，无需切换
  if (modeState.currentMode === targetMode && modeState.state === "running") {
    console.log(`[PaperClip Desktop] Already in ${targetMode} mode, skipping switch`);
    return;
  }

  const previousMode = modeState.currentMode;

  try {
    if (targetMode === "agenthubs") {
      await switchToAgentHubs(config);
    } else {
      await switchToAgent(config);
    }
  } catch (err) {
    // 切换失败 → state='error' + 保持旧模式 running（不回退到 broken 状态）
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      `[PaperClip Desktop] Mode switch failed (${previousMode} → ${targetMode}):`,
      errorMessage,
    );

    // 保持旧模式状态，只记录错误信息
    setModeManagerState({ state: "error", error: errorMessage });

    // 注意: 不回退模式 — currentMode 保持不变，托盘/菜单保持旧模式
    // 用户看到的是旧模式继续运行，托盘/菜单显示旧模式
    throw err; // 重新抛出，让调用方知道切换失败
  }
}
