// apps/desktop/src/main/agenthubs-mode.ts
// S-3C1: Rewrite from Docker Compose to VM Platform
//
// Manages the AgentHubs Mode lifecycle using the VM platform abstraction layer:
//   - isVmBundleReady() to verify the VM bundle is ready
//   - createSessionDisk() to create a per-session writable overlay
//   - VmGuestRpc to communicate with the Swift CLI for VM lifecycle
//   - waitForHealth() to wait for HTTP services to be ready
//
// Replaces the old docker compose lifecycle completely.
// No docker/compose/container references remain.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { isVmBundleReady, getRootfsPath, getAgentImgPath, getVmBundleDir } from "./vm-bundle.js";
import { createSessionDisk } from "./vm-disk.js";
import { VmGuestRpc } from "./vm-guest-rpc.js";
import { waitForHealth } from "./health-check.js";
import { isVmImageDownloaded } from "./download-vm-image.js";
import { ensureSharedDir } from "./file-bridge.js";

// ─── 类型定义 ───

export interface HealthCheckResults {
  cloudApi: boolean;
  paperclip: boolean;
  minio: boolean;
}

export interface AgentHubsModeState {
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  error?: string;
  composePath: string; // REPURPOSED: now points to VM bundle dir (keep field name for compatibility)
  healthCheckResults: HealthCheckResults;
}

export interface StartAgentHubsConfig {
  paperclipHome: string;
  onProgress?: (status: string) => void;
}

export interface StopAgentHubsConfig {
  timeout?: number;
  sessionImagePath?: string; // NEW: path to session overlay disk for cleanup
}

// ─── 常量 ───

const VM_HOME = path.resolve(
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"),
  "vm",
);

/** 健康检查指数退避间隔 (ms) */
const HEALTH_CHECK_RETRIES = [120, 240, 480, 960, 1500, 2000, 3000];

/** 启动指标文件路径 */
const STARTUP_METRICS_FILE = path.join(VM_HOME, "startup-metrics.json");
/** 启动指标最大保留条数 */
const MAX_STARTUP_METRICS = 5;

/** paperclip 端口（宿主机映射） */
const PAPERCLIP_HOST_PORT = 3200;
/** cloud-api 端口 */
const CLOUD_API_PORT = 4000;
/** MinIO API 端口 */
const MINIO_API_PORT = 9000;
/** MinIO Console 端口 (web UI, not health-checked) */
const MINIO_CONSOLE_PORT = 9001;

// ─── 状态管理 ───

let currentState: AgentHubsModeState | null = null;

function setState(partial: Partial<AgentHubsModeState>): void {
  if (!currentState) {
    currentState = {
      status: "stopped",
      composePath: getVmBundleDir(),
      healthCheckResults: {
        cloudApi: false,
        paperclip: false,
        minio: false,
      },
      ...partial,
    };
  } else {
    Object.assign(currentState, partial);
  }
}

// ─── 导出：获取当前状态 ───

export function getAgentHubsModeState(): AgentHubsModeState | null {
  return currentState;
}

// ─── Swift CLI 路径解析 ───

/**
 * Resolve the path to the Swift CLI binary (supernode-vm).
 *
 * Priority:
 *   1. SUPERNODE_VM_PATH env var (explicit override)
 *   2. ../vm-runtime/swift/.build/release/supernode-vm relative to __dirname
 *      (production layout: dist/main/ → ../../.. reaches apps/desktop)
 *   3. "supernode-vm" on PATH (development convenience)
 */
function resolveSwiftCliPath(): string {
  // 1. Explicit override
  if (process.env.SUPERNODE_VM_PATH) {
    return process.env.SUPERNODE_VM_PATH;
  }

  // 2. Relative to __dirname (production layout)
  //    __dirname = apps/desktop/dist/main/
  //    Going up 3 levels: dist/main → dist → desktop → apps
  //    Then into: vm-runtime/swift/.build/release/supernode-vm
  const productionPath = path.resolve(
    __dirname,
    "..", "..", "..",
    "vm-runtime", "swift", ".build", "release", "supernode-vm",
  );
  if (fs.existsSync(productionPath)) {
    return productionPath;
  }

  // 3. Fallback: assume "supernode-vm" is on PATH
  return "supernode-vm";
}

// ─── 启动指标 ───

interface StartupMetric {
  timestamp: string;
  totalMs: number;
  bootTimeMs: number;      // NEW: time for VM to boot + emit Ready event
  servicesReadyMs: number;  // NEW: time for cloud-api + paperclip + minio to be ready
}

/**
 * 写入启动指标到 ~/.paperclip/vm/startup-metrics.json
 * 失败静默忽略（非关键路径）
 */
function writeStartupMetrics(metric: StartupMetric): void {
  try {
    const dir = path.dirname(STARTUP_METRICS_FILE);
    fs.mkdirSync(dir, { recursive: true });

    let metrics: StartupMetric[] = [];
    if (fs.existsSync(STARTUP_METRICS_FILE)) {
      try {
        const raw = fs.readFileSync(STARTUP_METRICS_FILE, "utf-8");
        metrics = JSON.parse(raw);
        if (!Array.isArray(metrics)) metrics = [];
      } catch {
        metrics = [];
      }
    }

    metrics.push(metric);
    // 只保留最近 N 条
    if (metrics.length > MAX_STARTUP_METRICS) {
      metrics = metrics.slice(-MAX_STARTUP_METRICS);
    }

    fs.writeFileSync(STARTUP_METRICS_FILE, JSON.stringify(metrics, null, 2), "utf-8");
  } catch {
    // 非关键路径，静默忽略
  }
}

// ─── RPC 实例（生命周期内复用） ───

let rpc: VmGuestRpc | null = null;
let sessionDiskPath: string | null = null;

// ─── 健康检查 ───

/**
 * 检查 AgentHubs 所有服务的健康状态
 *
 * Probes:
 *   - cloud-api (HTTP :4000/health)
 *   - paperclip  (HTTP :3200/api/health)
 *   - minio      (HTTP :9000/minio/health/live)
 *
 * PG and Redis are inside the VM and NOT directly accessible from host.
 */
export async function checkAgentHubsHealth(): Promise<HealthCheckResults> {
  const [cloudApi, paperclip, minio] = await Promise.all([
    fetch(`http://127.0.0.1:${CLOUD_API_PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false),
    fetch(`http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`)
      .then((r) => r.ok)
      .catch(() => false),
    fetch(`http://127.0.0.1:${MINIO_API_PORT}/minio/health/live`)
      .then((r) => r.ok)
      .catch(() => false),
  ]);

  const results: HealthCheckResults = {
    cloudApi,
    paperclip,
    minio,
  };

  // 更新内部状态
  if (currentState) {
    currentState.healthCheckResults = results;
  }

  return results;
}

// ─── 启动 AgentHubs Mode ───

/**
 * 启动 AgentHubs Mode — VM-based lifecycle
 *
 * 流程：
 *  1. Check isVmBundleReady() — if not ready, throw
 *  2. Check isVmImageDownloaded() — if not downloaded, throw
 *  3. Create session disk: createSessionDisk()
 *  4. Swift CLI path resolution
 *  5. Construct VmConfig
 *  6. Call rpc.startVM(config)
 *  7. Wait for "Ready" event from VM
 *  8. Set security policy (allow networking)
 *  9. Wait for cloud-api + paperclip + minio health checks
 *  10. Write startup metrics
 *  11. Return AgentHubsModeState
 */
export async function startAgentHubsMode(
  config: StartAgentHubsConfig,
): Promise<AgentHubsModeState> {
  const { paperclipHome, onProgress } = config;
  const t0 = Date.now();

  onProgress?.("checking VM bundle...");

  // 1. Check VM image is downloaded
  if (!isVmImageDownloaded()) {
    throw new Error(
      "VM image not downloaded. Run download-vm-image first.",
    );
  }

  // 2. Check VM bundle is ready (images extracted)
  if (!isVmBundleReady()) {
    throw new Error(
      "VM bundle not ready. Run download-vm-image first.",
    );
  }

  // 3. Create session disk
  onProgress?.("creating session disk...");
  let sessionDisk: { path: string; sizeMB: number; created: boolean };
  try {
    sessionDisk = await createSessionDisk();
    sessionDiskPath = sessionDisk.path;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    setState({ status: "error", error: errorMsg });
    throw new Error(`Failed to create session disk: ${errorMsg}`);
  }

  onProgress?.("session disk ready");

  // 3b. Ensure shared directory exists (host ↔ VM file bridge)
  ensureSharedDir(paperclipHome);
  onProgress?.("shared directory ready");

  // 4. Resolve Swift CLI path
  const swiftCliPath = resolveSwiftCliPath();
  console.log(`[AgentHubs] Swift CLI: ${swiftCliPath}`);

  // 5. Construct VmConfig
  const kernelPath = path.join(getVmBundleDir(), "vmlinuz");
  const vmConfig = {
    kernelPath,
    rootfsImage: getRootfsPath(),
    sessionImage: sessionDisk.path,
    agentImage: getAgentImgPath(),
    memoryMB: 2048,
    cpuCount: 2,
    vsockPort: 9999,
  };

  // 6-7. Start VM via RPC
  setState({
    status: "starting",
    composePath: getVmBundleDir(),
    healthCheckResults: {
      cloudApi: false,
      paperclip: false,
      minio: false,
    },
  });

  onProgress?.("starting VM...");

  rpc = new VmGuestRpc(swiftCliPath);

  try {
    await rpc.startVM(vmConfig);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    setState({ status: "error", error: errorMsg });
    throw new Error(`Failed to start VM: ${errorMsg}`);
  }

  // 7. Wait for "Ready" event (VM booted, guest agent running)
  onProgress?.("waiting for VM to boot...");
  try {
    await rpc.waitForEvent("Ready", 120000);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    setState({ status: "error", error: errorMsg });
    throw new Error(`VM boot timed out: ${errorMsg}`);
  }

  const t1 = Date.now();
  const bootTimeMs = t1 - t0;
  console.log(`[AgentHubs] VM boot: ${bootTimeMs}ms`);

  // 8. Allow networking
  onProgress?.("configuring VM security policy...");
  try {
    await rpc.request("SetSecurityPolicy", { allowNetwork: true });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[AgentHubs] SetSecurityPolicy failed (non-fatal): ${errorMsg}`);
  }

  // 9. Wait for cloud-api + paperclip + minio health checks
  onProgress?.("VM running, waiting for services...");

  const [cloudApiReady, paperclipReady, minioReady] = await Promise.all([
    waitForHealth(
      `http://127.0.0.1:${CLOUD_API_PORT}/health`,
      60000,
      HEALTH_CHECK_RETRIES,
    ),
    waitForHealth(
      `http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`,
      60000,
      HEALTH_CHECK_RETRIES,
    ),
    waitForHealth(
      `http://127.0.0.1:${MINIO_API_PORT}/minio/health/live`,
      60000,
      HEALTH_CHECK_RETRIES,
    ),
  ]);

  const t2 = Date.now();
  const servicesReadyMs = t2 - t0;
  console.log(`[AgentHubs] cloud-api ready: ${cloudApiReady}`);
  console.log(`[AgentHubs] paperclip ready: ${paperclipReady}`);
  console.log(`[AgentHubs] minio ready: ${minioReady}`);
  console.log(`[AgentHubs] Services ready: ${servicesReadyMs}ms`);

  if (!cloudApiReady) {
    setState({
      status: "error",
      error: `cloud-api health check timed out at http://127.0.0.1:${CLOUD_API_PORT}/health`,
    });
    throw new Error(currentState?.error);
  }
  if (!paperclipReady) {
    setState({
      status: "error",
      error: `paperclip health check timed out at http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`,
    });
    throw new Error(currentState?.error);
  }
  if (!minioReady) {
    setState({
      status: "error",
      error: `minio health check timed out at http://127.0.0.1:${MINIO_API_PORT}/minio/health/live`,
    });
    throw new Error(currentState?.error);
  }

  onProgress?.("all services ready");

  // 10. Run full health check
  const health = await checkAgentHubsHealth();

  const t3 = Date.now();
  const totalMs = t3 - t0;
  console.log(`[AgentHubs] Total startup: ${totalMs}ms`);

  // Record startup metrics (non-critical path)
  writeStartupMetrics({
    timestamp: new Date().toISOString(),
    totalMs,
    bootTimeMs,
    servicesReadyMs,
  });

  setState({
    status: "running",
    healthCheckResults: health,
  });

  onProgress?.("AgentHubs mode running");
  return currentState!;
}

// ─── 停止 AgentHubs Mode ───

/**
 * 停止 AgentHubs Mode — VM-based shutdown
 *
 * 流程：
 *  1. If already stopped, return
 *  2. Try POST /api/desktop/shutdown to paperclip (graceful shutdown; ignore network errors)
 *  3. Call rpc.stopVM() — sends Shutdown RPC then SIGTERM/SIGKILL
 *  4. Close the RPC
 *  5. Cleanup session disk (fs.unlinkSync)
 *  6. Update state to 'stopped'
 */
export async function stopAgentHubsMode(
  config: StopAgentHubsConfig,
): Promise<void> {
  // 1. Already stopped, return
  if (currentState?.status === "stopped") {
    return;
  }

  setState({ status: "stopping" });

  // 2. Try to notify paperclip for graceful shutdown (ignore network errors)
  try {
    console.log("[AgentHubs] Notifying paperclip in VM to shut down...");
    await fetch(`http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/desktop/shutdown`, {
      method: "POST",
    });
    // Give daemon a moment to process
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    // VM may already be stopped or unreachable, ignore
    console.log("[AgentHubs] Paperclip shutdown endpoint not reachable, proceeding with VM stop");
  }

  // 3. Stop VM via RPC
  if (rpc) {
    try {
      await rpc.stopVM();
      console.log("[AgentHubs] VM stopped via RPC");
    } catch (err) {
      console.warn(`[AgentHubs] VM stop via RPC failed: ${err}`);
    }
  }

  // 4. Close RPC
  if (rpc) {
    rpc.close();
    rpc = null;
  }

  // 5. Cleanup session disk
  const diskPath = config.sessionImagePath ?? sessionDiskPath;
  if (diskPath && fs.existsSync(diskPath)) {
    try {
      fs.unlinkSync(diskPath);
      console.log(`[AgentHubs] Session disk cleaned up: ${diskPath}`);
    } catch (err) {
      console.warn(`[AgentHubs] Failed to cleanup session disk ${diskPath}: ${err}`);
    }
  }
  sessionDiskPath = null;

  // 6. Update state
  setState({
    status: "stopped",
    healthCheckResults: {
      cloudApi: false,
      paperclip: false,
      minio: false,
    },
  });
}
