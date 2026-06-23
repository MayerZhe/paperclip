// apps/desktop/src/main/vm-guest-rpc.ts
// Story 3B.2: JSON-RPC communication with the Swift CLI subprocess.
//
// VmGuestRpc wraps a child_process (spawn of the Swift CLI) and communicates
// with it via JSON-RPC over stdin/stdout. The Swift CLI manages the VM
// lifecycle and forwards guest-agent RPC calls through a vsock transport.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ─── 类型 ───

export interface RpcRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  status: "ok" | "error";
  data?: unknown;
  error?: string;
}

export interface VmConfig {
  /** Linux kernel image path */
  kernelPath: string;
  /** Optional initrd path */
  initrdPath?: string;
  /** Root filesystem image path */
  rootfsImage: string;
  /** Session overlay image path */
  sessionImage: string;
  /** Agent image path (exFAT) */
  agentImage: string;
  /** VM memory allocation in MiB */
  memoryMB: number;
  /** vCPU count */
  cpuCount: number;
  /** vsock port for guest-agent communication */
  vsockPort: number;
}

// ─── 内部：行协议 ───

/** JSON-RPC request with an internal id for correlation. */
interface PendingRequest {
  method: string;
  resolve: (value: RpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Default timeout for a single RPC request (ms) */
const DEFAULT_RPC_TIMEOUT = 30000;

/** Default timeout for waitForEvent (ms) */
const DEFAULT_EVENT_TIMEOUT = 60000;

// ─── VmGuestRpc ───

/**
 * JSON-RPC client that communicates with the Swift VM CLI process.
 *
 * Lifecycle:
 *  1. Construct with the path to the Swift CLI binary.
 *  2. `startVM(config)` spawns the subprocess and brings up the VM.
 *  3. `request(method, params)` sends a JSON-RPC call and awaits the response.
 *  4. `stopVM()` sends a shutdown command and kills the subprocess.
 *  5. `close()` tears everything down.
 *
 * Edge cases handled:
 *  - Subprocess crash: pending requests are rejected with a descriptive error.
 *  - Partial output: each line is expected to be a complete JSON object.
 *    Malformed lines are logged and skipped.
 *  - Timeout: each request has an individual timeout; expiry rejects the
 *    promise without crashing the process.
 *  - SIGTERM cascade: close() sends SIGTERM first, then SIGKILL after a grace
 *    period if the process hasn't exited.
 */
export class VmGuestRpc {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  /**
   * @param swiftCliPath - Absolute path to the Swift CLI binary.
   */
  constructor(private readonly swiftCliPath: string) {}

  // ─── 公开方法 ───

  /**
   * Start the VM via the Swift CLI.
   *
   * Spawns `swiftCliPath start ...` with appropriate arguments derived
   * from `config`. The subprocess is kept alive for subsequent RPC calls.
   */
  async startVM(config: VmConfig): Promise<void> {
    if (this.closed) {
      throw new Error("VmGuestRpc is closed");
    }
    if (this.process) {
      throw new Error("VM is already started; stopVM() first.");
    }

    const args = [
      "start",
      "--kernel", config.kernelPath,
      "--rootfs", config.rootfsImage,
      "--session", config.sessionImage,
      "--agent", config.agentImage,
      "--memory", String(config.memoryMB),
      "--cpus", String(config.cpuCount),
      "--vsock-port", String(config.vsockPort),
    ];
    if (config.initrdPath) {
      args.push("--initrd", config.initrdPath);
    }

    this.process = spawn(this.swiftCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupLineReader();
    this.setupProcessHandlers();
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * @param method  - RPC method name (e.g. "HealthCheck", "Spawn", "Kill").
   * @param params  - Optional parameters object.
   * @param timeoutMs - Per-request timeout in ms. Default 30000.
   * @returns The parsed RPC response.
   */
  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RpcResponse> {
    if (this.closed || !this.process || this.process.exitCode !== null) {
      throw new Error("VmGuestRpc is not connected");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = timeoutMs ?? DEFAULT_RPC_TIMEOUT;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC request '${method}' timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { method, resolve, reject, timer });

      try {
        this.process!.stdin!.write(payload + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Failed to write RPC request '${method}': ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /**
   * Wait for a specific event type emitted by the Swift CLI.
   *
   * Events are JSON objects emitted on stdout that do NOT have an `id`
   * field matching a pending request. They typically have a `type` field.
   *
   * @param eventType - The `type` value to wait for.
   * @param timeoutMs - Maximum time to wait in ms. Default 60000.
   * @returns The parsed event payload (without the `type` field).
   */
  async waitForEvent(
    eventType: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed || !this.process || this.process.exitCode !== null) {
      throw new Error("VmGuestRpc is not connected");
    }

    const timeout = timeoutMs ?? DEFAULT_EVENT_TIMEOUT;

    return new Promise<unknown>((resolve, reject) => {
      // Register as a special pending "request" with negative id to distinguish
      // from real RPC requests.
      const eventId = -(this.nextId++);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(eventId);
        reject(
          new Error(`Event '${eventType}' not received within ${timeout}ms`),
        );
      }, timeout);

      this.pendingRequests.set(eventId, {
        method: `event:${eventType}`,
        resolve: (resp: RpcResponse) => {
          if (resp.status === "ok") {
            resolve(resp.data);
          } else {
            reject(new Error(resp.error ?? "Unknown event error"));
          }
        },
        reject,
        timer,
      });
    });
  }

  /**
   * Stop the VM and kill the subprocess.
   *
   * Sends a "Shutdown" RPC first, then SIGTERM, then SIGKILL after a 5 s
   * grace period.
   */
  async stopVM(): Promise<void> {
    if (!this.process) return;

    // Try graceful shutdown via RPC
    try {
      await this.request("Shutdown", {}, 5000);
    } catch {
      // Ignore — the subprocess may already be unresponsive.
    }

    this.killProcess();
  }

  /**
   * Close the connection and release all resources.
   *
   * Rejects all pending requests with a "closed" error.
   * If a subprocess is still running it calls stopVM() first.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.process && this.process.exitCode === null) {
      this.killProcess();
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("VmGuestRpc closed"));
    }
    this.pendingRequests.clear();
  }

  // ─── 内部 ───

  /**
   * Set up line-by-line reading of the subprocess stdout.
   */
  private setupLineReader(): void {
    if (!this.process?.stdout) return;

    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line: string) => {
      this.handleLine(line.trim());
    });
  }

  /**
   * Handle a single line of JSON output from the subprocess.
   */
  private handleLine(line: string): void {
    if (!line) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(`[VmGuestRpc] Non-JSON line from subprocess: ${line.slice(0, 200)}`);
      return;
    }

    // If the line has a numeric `id`, it's a response to a pending request.
    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(parsed.id);

        const status =
          parsed.error != null
            ? "error"
            : ("status" in parsed && typeof parsed.status === "string"
                ? (parsed.status as "ok" | "error")
                : "ok");

        const response: RpcResponse = {
          status,
          data: parsed.result ?? parsed.data,
          error:
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error != null
                ? JSON.stringify(parsed.error)
                : undefined,
        };

        pending.resolve(response);
      }
      return;
    }

    // Otherwise it's an event — check if anyone is waiting for this type.
    const eventType = typeof parsed.type === "string" ? parsed.type : undefined;
    if (eventType) {
      for (const [id, pending] of this.pendingRequests) {
        if (pending.method === `event:${eventType}`) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          pending.resolve({ status: "ok", data: parsed });
          return;
        }
      }
    }

    // Unmatched line — log at debug level.
    console.debug(`[VmGuestRpc] Unhandled subprocess output: ${line.slice(0, 200)}`);
  }

  /**
   * Register process lifecycle handlers.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      console.log(`[VmGuestRpc] Subprocess exited: code=${code}, signal=${signal}`);
      if (!this.closed) {
        // Unexpected exit — reject all pending.
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(
              `Subprocess exited unexpectedly (code=${code}, signal=${signal})`,
            ),
          );
        }
        this.pendingRequests.clear();
      }
      this.process = null;
    });

    this.process.on("error", (err) => {
      console.error(`[VmGuestRpc] Subprocess error: ${err.message}`);
      if (!this.closed) {
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(`Subprocess error: ${err.message}`),
          );
        }
        this.pendingRequests.clear();
      }
    });

    // Forward stderr for diagnostics.
    if (this.process.stderr) {
      this.process.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) {
          console.error(`[VmGuestRpc:stderr] ${text}`);
        }
      });
    }
  }

  /**
   * Kill the subprocess: SIGTERM → wait 5 s → SIGKILL.
   */
  private killProcess(): void {
    if (!this.process || this.process.exitCode !== null) return;

    const pid = this.process.pid;
    this.process.kill("SIGTERM");

    const forceKill = setTimeout(() => {
      if (this.process && this.process.exitCode === null) {
        console.warn(`[VmGuestRpc] SIGTERM timeout, sending SIGKILL to pid=${pid}`);
        this.process.kill("SIGKILL");
      }
    }, 5000);

    this.process.once("exit", () => {
      clearTimeout(forceKill);
    });
  }
}
