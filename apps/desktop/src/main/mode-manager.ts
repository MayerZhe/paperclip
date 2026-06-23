// apps/desktop/src/main/mode-manager.ts
// S-A4: 模式管理器 — 并行启动 agent daemon + agenthubs docker compose
//
// 使用 Promise.allSettled 并行启动两种模式。一种模式失败不影响另一种。
// Sidebar 负责可见性切换，mode-manager 只负责启动/停止/状态查询。

import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ─── 类型定义 ───

/** 应用启动模式 */
export type AppMode = "agent" | "agenthubs";

/** 模式管理器运行时状态 */
export type ModeState = "idle" | "starting" | "running" | "error" | "stopping";

/** 模式管理器完整状态 */
export interface ModeManagerState {
  currentMode: AppMode;
  state: ModeState;
  error?: string;
}

/** 模式启动结果 */
export interface ModeStartupResult {
  agent: { success: boolean; error?: string; port: number; daemon: ChildProcess | null };
  agenthubs: { success: boolean; error?: string };
}

/** 模式运行时状态（用于 onStatusChange 回调） */
export type ModeStatus = "starting" | "running" | "error";

/** startBothModes 所需的配置/回调 */
export interface StartBothModesConfig {
  /** PaperClip home 目录 (~/.paperclip) */
  paperclipHome: string;
  /** Agent 模式 daemon 配置 */
  agentConfig: {
    daemonEntry: string;
    serverPort: number;
  };
  /** AgentHubs 模式配置 */
  agenthubsConfig: {
    token?: string;
  };
  /** 启动 Agent daemon 的回调（packaged-main 提供 fork + waitForServerReady） */
  startAgentDaemon: (entry: string, port: number) => Promise<{ daemon: ChildProcess; port: number }>;
  /** 停止 Agent daemon 的回调（packaged-main 提供 shutdown 逻辑） */
  stopAgentDaemon: (daemon: ChildProcess, port: number) => Promise<void>;
  /** 状态变化回调（mode-manager 通知 packaged-main 各模式启动进度） */
  onStatusChange: (mode: AppMode, status: ModeStatus, error?: string) => void;
}

// ─── 内部状态 ───

let modeState: ModeManagerState = {
  currentMode: "agent",
  state: "idle",
};

// ─── 导出接口 ───

/** 获取当前模式管理器状态 */
export function getModeManagerState(): ModeManagerState {
  return { ...modeState };
}

/**
 * 获取初始模式偏好
 *
 * 读取 ~/.paperclip/instances/default/mode-preference.json，
 * 返回保存的模式偏好，无偏好时默认返回 "agent"。
 * 注意：此函数不再检测容器运行时 — 并行启动模式下该检测在启动阶段完成。
 */
export function getInitialMode(paperclipHome: string): AppMode {
  const prefPath = path.resolve(paperclipHome, "instances", "default", "mode-preference.json");

  try {
    if (fs.existsSync(prefPath)) {
      const raw = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
      if (typeof raw?.mode === "string" && (raw.mode === "agent" || raw.mode === "agenthubs")) {
        console.log(`[PaperClip Desktop] Mode preference: ${raw.mode}`);
        return raw.mode as AppMode;
      }
    }
  } catch (err) {
    console.warn("[PaperClip Desktop] Failed to read mode preference, defaulting to agent:", err);
  }

  console.log("[PaperClip Desktop] No mode preference — defaulting to agent");
  return "agent";
}

/**
 * 代码中更新模式状态
 */
function setModeManagerState(partial: Partial<ModeManagerState>): void {
  modeState = { ...modeState, ...partial };
  if (partial.currentMode) {
    console.log(`[PaperClip Desktop] Mode: ${partial.currentMode}, State: ${modeState.state}`);
  } else {
    console.log(`[PaperClip Desktop] Mode state: ${modeState.state}`);
  }
}

// ─── 并行启动 ───

/**
 * 并行启动 Agent 模式和 AgentHubs 模式
 *
 * 使用 Promise.allSettled 确保一种模式失败不会阻止另一种模式启动。
 *
 * Agent 模式：调用 startAgentDaemon 回调（packaged-main 实现 fork + health check）
 * AgentHubs 模式：动态导入 agenthubs-mode.js，调用 startAgentHubsMode
 */
export async function startBothModes(config: StartBothModesConfig): Promise<ModeStartupResult> {
  setModeManagerState({ state: "starting" });

  // 启动 Agent daemon
  const startAgent = async (): Promise<ModeStartupResult["agent"]> => {
    config.onStatusChange("agent", "starting");
    try {
      const { daemon, port } = await config.startAgentDaemon(
        config.agentConfig.daemonEntry,
        config.agentConfig.serverPort,
      );
      config.onStatusChange("agent", "running");
      return { success: true, port, daemon };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PaperClip Desktop] Agent daemon startup failed: ${message}`);
      config.onStatusChange("agent", "error", message);
      return { success: false, error: message, port: config.agentConfig.serverPort, daemon: null };
    }
  };

  // 启动 AgentHubs 模式（docker compose up）
  const startAgentHubs = async (): Promise<ModeStartupResult["agenthubs"]> => {
    config.onStatusChange("agenthubs", "starting");
    try {
      const { startAgentHubsMode } = await import("./agenthubs-mode.js");
      const result = await startAgentHubsMode({
        paperclipHome: config.paperclipHome,
        onProgress: (msg: string) => {
          console.log(`[PaperClip Desktop] AgentHubs: ${msg}`);
        },
      });

      if (result.status === "error") {
        const errMsg = result.error ?? "AgentHubs mode returned error status";
        console.error(`[PaperClip Desktop] AgentHubs startup failed: ${errMsg}`);
        config.onStatusChange("agenthubs", "error", errMsg);
        return { success: false, error: errMsg };
      }

      config.onStatusChange("agenthubs", "running");
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PaperClip Desktop] AgentHubs startup failed: ${message}`);
      config.onStatusChange("agenthubs", "error", message);
      return { success: false, error: message };
    }
  };

  // 并行启动两种模式
  const [agentResult, agenthubsResult] = await Promise.allSettled([
    startAgent(),
    startAgentHubs(),
  ]);

  // 从 allSettled 结果中提取值（allSettled 即使 reject 也会返回 settled）
  const agent = agentResult.status === "fulfilled"
    ? agentResult.value
    : { success: false, error: String(agentResult.reason), port: config.agentConfig.serverPort, daemon: null as ChildProcess | null };

  const agenthubs = agenthubsResult.status === "fulfilled"
    ? agenthubsResult.value
    : { success: false, error: String(agenthubsResult.reason) };

  // 至少一种模式启动成功 → state = 'running'
  // 两种模式都失败 → state = 'error'
  if (agent.success || agenthubs.success) {
    setModeManagerState({ state: "running", error: undefined });
  } else {
    const errors = [agent.error, agenthubs.error].filter(Boolean).join("; ");
    setModeManagerState({ state: "error", error: errors || "Both modes failed to start" });
  }

  return { agent, agenthubs };
}

/**
 * 停止两种模式
 *
 * @param result - startBothModes 返回的启动结果
 * @param stopAgentDaemon - 停止 Agent daemon 的回调（packaged-main 提供 shutdown 逻辑）
 */
export async function stopBothModes(
  result: ModeStartupResult,
  stopAgentDaemon: (daemon: ChildProcess, port: number) => Promise<void>,
): Promise<void> {
  setModeManagerState({ state: "stopping" });

  // 停止 Agent daemon
  if (result.agent.daemon) {
    try {
      await stopAgentDaemon(result.agent.daemon, result.agent.port);
      console.log("[PaperClip Desktop] Agent daemon stopped");
    } catch (err) {
      console.error("[PaperClip Desktop] Error stopping agent daemon:", err);
    }
  }

  // 停止 AgentHubs
  if (result.agenthubs.success) {
    try {
      const { stopAgentHubsMode } = await import("./agenthubs-mode.js");
      await stopAgentHubsMode({
        timeout: 60,
      });
      console.log("[PaperClip Desktop] AgentHubs mode stopped");
    } catch (err) {
      console.error("[PaperClip Desktop] Error stopping AgentHubs mode:", err);
    }
  }

  setModeManagerState({ state: "idle", error: undefined });
  console.log("[PaperClip Desktop] Both modes stopped");
}
