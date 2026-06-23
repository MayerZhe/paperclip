// apps/desktop/src/main/health-check.ts
// Story 3B.2: Extracted health-check utilities.
//
// Provides exponential-backoff HTTP health checking and TCP port
// connectivity probing. Originally extracted from agenthubs-mode.ts
// and packaged-main.ts patterns.
//
// Key patterns retained from source:
//   - Exponential backoff with configurable retry intervals.
//   - HTTP fetch with ok-check.
//   - TCP socket probe via node:net.

import net from "node:net";

// ─── 常量 ───

/**
 * Default exponential backoff intervals (ms).
 *
 * These are the original HEALTH_CHECK_RETRIES from agenthubs-mode.ts,
 * generalised here for any caller.
 */
export const DEFAULT_HEALTH_RETRIES = [
  100, 200, 400, 800, 1600, 3200, 5000, 10000,
];

/** Seconds to wait between health check rounds (for periodic checks). */
const HEALTH_CHECK_INTERVAL = 5_000;

// ─── 类型 ───

/**
 * Results of the AgentHubs health check across all services.
 */
export interface HealthCheckResults {
  cloudApi: boolean;
  paperclip: boolean;
  postgres: boolean;
  redis: boolean;
}

// ─── 导出：waitForHealth ───

/**
 * Wait for an HTTP endpoint to become reachable.
 *
 * Uses exponential backoff: tries each delay in `retries` sequentially;
 * if the endpoint returns HTTP 2xx the function resolves `true`.
 * If the total elapsed time exceeds `timeoutMs` (or all retries are
 * exhausted), resolves `false`.
 *
 * @param url       - The HTTP(S) URL to probe (e.g. http://127.0.0.1:4000/health).
 * @param timeoutMs - Total time budget in ms. Default 30000.
 * @param retries   - Retry delay intervals in ms. Default {@link DEFAULT_HEALTH_RETRIES}.
 * @returns `true` if the endpoint responded 2xx within budget; `false` otherwise.
 */
export async function waitForHealth(
  url: string,
  timeoutMs = 30000,
  retries: number[] = DEFAULT_HEALTH_RETRIES,
): Promise<boolean> {
  const start = Date.now();
  for (const delay of retries) {
    // Respect timeout across all iterations.
    if (Date.now() - start >= timeoutMs) {
      return false;
    }
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Service not ready yet — will retry after delay.
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}

// ─── 导出：checkTcpPort ───

/**
 * Simple TCP port connectivity check.
 *
 * Opens a TCP connection to 127.0.0.1:<port> and resolves `true` if the
 * connection succeeds within `timeoutMs`, `false` otherwise.
 *
 * This is suitable for services that don't expose an HTTP health endpoint
 * (e.g. PostgreSQL, Redis).
 *
 * @param port      - TCP port number on localhost.
 * @param timeoutMs - Connection timeout in ms. Default 2000.
 * @returns `true` if the port accepted a connection.
 */
export async function checkTcpPort(
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
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

// ─── 导出：checkAgentHubsHealth ───

/**
 * Check AgentHubs services health.
 *
 * Probes:
 *   - cloud-api (HTTP :4000/health)
 *   - paperclip  (HTTP :3200/api/health)
 *   - postgres   (TCP :5432)
 *   - redis      (TCP :6379)
 *
 * All four checks run concurrently via Promise.all.
 *
 * @returns A {@link HealthCheckResults} object with per-service status.
 */
export async function checkAgentHubsHealth(): Promise<HealthCheckResults> {
  const CLOUD_API_PORT = 4000;
  const PAPERCLIP_HOST_PORT = 3200;
  const POSTGRES_PORT = 5432;
  const REDIS_PORT = 6379;

  const [cloudApi, paperclip, postgres, redis] = await Promise.all([
    fetch(`http://127.0.0.1:${CLOUD_API_PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false),
    fetch(`http://127.0.0.1:${PAPERCLIP_HOST_PORT}/api/health`)
      .then((r) => r.ok)
      .catch(() => false),
    checkTcpPort(POSTGRES_PORT),
    checkTcpPort(REDIS_PORT),
  ]);

  return { cloudApi, paperclip, postgres, redis };
}

// ─── 导出：周期性健康轮询工具 ───

/**
 * Callback invoked on each health check cycle.
 *
 * @returns `true` to keep polling; `false` to stop.
 */
export type HealthPollerCallback = (
  results: HealthCheckResults,
) => boolean | void;

/**
 * Start a periodic health check loop.
 *
 * Runs `checkAgentHubsHealth()` every `intervalMs` (default 5000) and
 * calls `onCheck` with the result. The loop stops when `onCheck` returns
 * `false`.
 *
 * @param onCheck    - Called with each health check result.
 * @param intervalMs - Poll interval in ms. Default 5000.
 * @returns A cancel function. Call it to stop polling.
 */
export function pollAgentHubsHealth(
  onCheck: HealthPollerCallback,
  intervalMs = HEALTH_CHECK_INTERVAL,
): () => void {
  let cancelled = false;

  const run = async () => {
    while (!cancelled) {
      try {
        const results = await checkAgentHubsHealth();
        if (cancelled) return;
        const keepGoing = onCheck(results);
        if (keepGoing === false) return;
      } catch {
        // Silently retry on transient errors.
      }
      if (cancelled) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  // Fire and forget (unhandled rejection handled by the catch above).
  void run();

  return () => {
    cancelled = true;
  };
}
