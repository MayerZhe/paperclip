// apps/desktop/src/main/agenthubs-mode.ts
// Story 1.2: VM 生命周期管理 (Docker Compose)
//
// 管理 AgentHubs Mode 的 Docker Compose 生命周期：
//   - docker compose up -d 启动所有容器
//   - 指数退避等待健康检查就绪
//   - docker compose down 停止并清理容器
//   - 状态追踪与错误上报

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

import { isVmImageDownloaded } from "./download-vm-image.js";
import { ensureSharedDir } from "./file-bridge.js";

// ─── 类型定义 ───

export interface HealthCheckResults {
  cloudApi: boolean;
  paperclip: boolean;
  postgres: boolean;
  redis: boolean;
}

export interface AgentHubsModeState {
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  error?: string;
  composePath: string;
  healthCheckResults: HealthCheckResults;
}

export interface StartAgentHubsConfig {
  paperclipHome: string;
  composePath?: string;
  containerRuntime: string;
  onProgress?: (status: string) => void;
}

export interface StopAgentHubsConfig {
  composePath?: string;
  containerRuntime: string;
  timeout?: number;
}

// ─── 常量 ───

const VM_HOME = path.resolve(
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"),
  "vm",
);
const VM_EXTRACT_DIR = path.join(VM_HOME, "agenthubs-local-vm");
const DEFAULT_COMPOSE_PATH = path.join(VM_EXTRACT_DIR, "docker-compose.yml");

/** 健康检查指数退避间隔 (ms) — 通用用途 */
const HEALTH_CHECK_RETRIES = [120, 240, 480, 960, 1500, 2000, 3000];

/** Docker Compose 健康检查退避间隔 (ms) — 容器已启动时更快响应 */
const DOCKER_HEALTH_RETRIES = [80, 160, 320, 500, 750, 1000, 1500, 2000];

/** 启动指标文件路径 */
const STARTUP_METRICS_FILE = path.join(VM_HOME, "startup-metrics.json");
/** 启动指标最大保留条数 */
const MAX_STARTUP_METRICS = 5;

/** 必需的 Docker 镜像名称 */
const REQUIRED_DOCKER_IMAGES = [
  "agenthubs-postgres",
  "agenthubs-redis",
  "agenthubs-cloud-api",
  "agenthubs-paperclip",
];

/** 默认 docker compose down 超时 (秒) */
const DEFAULT_STOP_TIMEOUT = 30;

/** 容器内 paperclip 端口（宿主机映射） */
const PAPERCLIP_HOST_PORT = 3200;
/** cloud-api 端口 */
const CLOUD_API_PORT = 4000;
/** Postgres 端口 */
const POSTGRES_PORT = 5432;
/** Redis 端口 */
const REDIS_PORT = 6379;

// ─── 状态管理 ───

let currentState: AgentHubsModeState | null = null;

function setState(partial: Partial<AgentHubsModeState>): void {
  if (!currentState) {
    currentState = {
      status: "stopped",
      composePath: DEFAULT_COMPOSE_PATH,
      healthCheckResults: {
        cloudApi: false,
        paperclip: false,
        postgres: false,
        redis: false,
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

// ─── 工具函数 ───

/**
 * 解析 compose 文件路径
 */
function resolveComposePath(composePath?: string): string {
  const resolved = path.resolve(composePath ?? DEFAULT_COMPOSE_PATH);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `docker-compose.yml not found at ${resolved}. ` +
        `Run download-vm-image first.`,
    );
  }
  return resolved;
}

/**
 * 指数退避等待健康检查 URL 就绪
 * 借鉴 packaged-main.ts 的 waitForServerReady 模式
 */
async function waitForHealth(
  url: string,
  timeout = 30000,
  retries: number[] = HEALTH_CHECK_RETRIES,
): Promise<boolean> {
  const start = Date.now();
  for (const delay of retries) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 服务未就绪
    }
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}

/**
 * 执行 docker compose 命令，返回 stdout
 */
function dockerCompose(
  composePath: string,
  args: string[],
  timeout = 120000,
): string {
  const cmd = `docker compose -f "${composePath}" ${args.join(" ")}`;
  console.log(`[AgentHubs] Running: ${cmd}`);
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && "stderr" in err
        ? String((err as { stderr?: string }).stderr ?? err.message)
        : String(err);
    throw new Error(`docker compose failed: ${stderr.trim()}`);
  }
}

/**
 * 简单的 TCP 端口连通性检查（通用，不绑定特定 HTTP 协议）
 */
async function checkTcpPort(port: number, timeout = 2000): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket
      .on("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .on("error", () => {
        socket.destroy();
        resolve(false);
      })
      .on("timeout", () => {
        socket.destroy();
        resolve(false);
      })
      .connect(port, "127.0.0.1");
  });
}

// ─── Docker 镜像预检查 ───

/**
 * 检查必需的 Docker 镜像是否已存在于本地
 * @returns 缺失的镜像名称数组；如果全部存在则返回空数组
 */
function checkDockerImages(containerRuntime: string): string[] {
  const missing: string[] = [];
  for (const image of REQUIRED_DOCKER_IMAGES) {
    try {
      const result = execSync(
        `${containerRuntime} images -q ${image}`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (!result.trim()) {
        missing.push(image);
      }
    } catch {
      missing.push(image);
    }
  }
  return missing;
}

// ─── 启动指标 ───

interface StartupMetric {
  timestamp: string;
  totalMs: number;
  composeUpMs: number;
  cloudApiMs: number;
  paperclipMs: number;
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

// ─── 健康检查 ───

/**
 * 检查 AgentHubs 所有服务的健康状态
 */
export async function checkAgentHubsHealth(): Promise<HealthCheckResults> {
  const [cloudApi, paperclip, postgres, redis] = await Promise.all([
    fetch(`http://127.0.0.1:${CLOUD_API_PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false),
    fetch(`http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`)
      .then((r) => r.ok)
      .catch(() => false),
    // PG 和 Redis 使用 TCP 端口检查（它们不支持 HTTP）
    checkTcpPort(POSTGRES_PORT),
    checkTcpPort(REDIS_PORT),
  ]);

  const results: HealthCheckResults = {
    cloudApi,
    paperclip,
    postgres,
    redis,
  };

  // 更新内部状态
  if (currentState) {
    currentState.healthCheckResults = results;
  }

  return results;
}

// ─── 启动 AgentHubs Mode ───

/**
 * 启动 AgentHubs Mode — docker compose up -d
 *
 * 流程（优化后）：
 * 1. 检查 VM image 是否已下载
 * 2. 预检查必需 Docker 镜像是否存在
 * 3. 解析 composePath
 * 4. 确保共享目录存在
 * 5. docker compose up -d（立即返回，不等健康检查）
 * 6. 并行等待 cloud-api :4000/health + paperclip :3200/api/health 就绪
 * 7. 记录启动指标
 * 8. 返回 AgentHubsModeState
 */
export async function startAgentHubsMode(
  config: StartAgentHubsConfig,
): Promise<AgentHubsModeState> {
  const { paperclipHome, containerRuntime, onProgress } = config;
  const t0 = Date.now();

  onProgress?.("checking VM image...");

  // 1. 检查 VM image 是否已下载
  if (!isVmImageDownloaded()) {
    throw new Error(
      "VM image not downloaded. Run download-vm-image first.",
    );
  }

  // 2. 预检查必需 Docker 镜像
  const missingImages = checkDockerImages(containerRuntime);
  if (missingImages.length > 0) {
    throw new Error(
      `Required Docker images not found: ${missingImages.join(", ")}. ` +
        `Run download-vm-image first.`,
    );
  }

  // 3. 解析 compose 文件路径
  const composePath = resolveComposePath(config.composePath);
  onProgress?.(`compose file: ${composePath}`);

  // 4. 确保共享目录存在
  ensureSharedDir(paperclipHome);
  onProgress?.("shared directory ready");

  // 5. 执行 docker compose up -d（立即返回）
  setState({
    status: "starting",
    composePath,
    healthCheckResults: {
      cloudApi: false,
      paperclip: false,
      postgres: false,
      redis: false,
    },
  });

  onProgress?.("starting docker compose...");

  try {
    const output = dockerCompose(composePath, ["up", "-d"]);
    console.log(`[AgentHubs] Compose output:\n${output}`);
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : String(err);
    setState({ status: "error", error: errorMsg });
    throw new Error(`Failed to start AgentHubs containers: ${errorMsg}`);
  }

  const t1 = Date.now();
  const composeUpMs = t1 - t0;
  console.log(`[AgentHubs] docker compose up: ${composeUpMs}ms`);

  onProgress?.("containers started, waiting for services...");

  // 6. 并行等待 cloud-api :4000/health 和 paperclip :3200/api/health 就绪
  const [cloudApiReady, paperclipReady] = await Promise.all([
    waitForHealth(
      `http://127.0.0.1:${CLOUD_API_PORT}/health`,
      60000,
      DOCKER_HEALTH_RETRIES,
    ),
    waitForHealth(
      `http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`,
      60000,
      DOCKER_HEALTH_RETRIES,
    ),
  ]);

  const t2 = Date.now();
  const cloudApiMs = t2 - t0;
  const paperclipMs = t2 - t0;
  console.log(`[AgentHubs] cloud-api health: ${cloudApiMs}ms`);
  console.log(`[AgentHubs] paperclip health: ${paperclipMs}ms`);

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

  onProgress?.("all services ready");

  // 7. 运行完整健康检查
  const health = await checkAgentHubsHealth();

  const t3 = Date.now();
  const totalMs = t3 - t0;
  console.log(`[AgentHubs] Total startup: ${totalMs}ms`);

  // 记录启动指标（非关键路径）
  writeStartupMetrics({
    timestamp: new Date().toISOString(),
    totalMs,
    composeUpMs,
    cloudApiMs,
    paperclipMs,
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
 * 停止 AgentHubs Mode — docker compose down
 *
 * 流程：
 * 1. 如果已停止，直接返回
 * 2. 尝试 POST /api/desktop/shutdown 到容器内 paperclip（graceful shutdown；忽略网络错误）
 * 3. docker compose down（默认 SIGTERM，等 30s）
 * 4. 超时 → docker compose kill（SIGKILL）
 * 5. 更新状态为 'stopped'
 */
export async function stopAgentHubsMode(
  config: StopAgentHubsConfig,
): Promise<void> {
  const {
    containerRuntime,
    timeout = DEFAULT_STOP_TIMEOUT,
  } = config;

  // 1. 已停止，直接返回
  if (currentState?.status === "stopped") {
    return;
  }

  setState({ status: "stopping" });

  const composePath = resolveComposePath(config.composePath);

  // 2. 尝试通知容器内 paperclip 优雅关闭（忽略网络错误）
  try {
    console.log("[AgentHubs] Notifying paperclip in container to shut down...");
    await fetch(`http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/desktop/shutdown`, {
      method: "POST",
    });
    // 给 daemon 一点时间处理
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    // 容器可能已停止或未运行，忽略
    console.log("[AgentHubs] Paperclip shutdown endpoint not reachable, proceeding with docker compose down");
  }

  // 3. docker compose down（先 SIGTERM，等待 timeout 秒）
  try {
    dockerCompose(composePath, ["down", "--timeout", String(timeout)]);
    console.log("[AgentHubs] docker compose down completed");
  } catch (downErr) {
    // 4. down 失败（超时等），强制 kill
    console.warn(
      `[AgentHubs] docker compose down failed (${downErr}), force killing...`,
    );
    try {
      dockerCompose(composePath, ["kill"]);
      // 清理 kill 后留下的容器
      dockerCompose(composePath, ["down", "--remove-orphans"]);
    } catch (killErr) {
      console.error(
        `[AgentHubs] docker compose kill/down also failed: ${killErr}`,
      );
    }
  }

  // 5. 更新状态
  setState({
    status: "stopped",
    healthCheckResults: {
      cloudApi: false,
      paperclip: false,
      postgres: false,
      redis: false,
    },
  });
}
