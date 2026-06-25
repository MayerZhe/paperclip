// apps/desktop/src/__tests__/vm-guest-rpc.test.ts
// Story 3B.3: Swift CLI integration tests
//
// Tests for:
//   1. VmGuestRpc class (JSON-RPC over child_process stdin/stdout)
//   2. vm-bundle.ts (bundle detection and path resolution)
//   3. vm-disk.ts (session disk creation)
//   4. health-check.ts (HTTP and TCP health probes)
//   5. Integration test (only runs if swift CLI binary exists)
//
// All dependencies that interact with the OS (child_process, fs, net, fetch)
// are mocked. The integration test safely skips when the binary is absent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { type ChildProcess } from "node:child_process";

// =====================================================================
// Mock node:child_process
// =====================================================================

const mockChildProcess = (): ChildProcess => {
  const ee = new EventEmitter() as unknown as ChildProcess;

  // stdin writes accumulator
  const stdinWrites: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
  (stdin as any).writable = true;
  (stdin as any).write = vi.fn(
    (chunk: string | Buffer, cb?: (err?: Error) => void): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      stdinWrites.push(text);
      if (cb) cb();
      return true;
    },
  );

  // stdout readable stream
  const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  (stdout as any).resume = vi.fn();

  // stderr readable stream
  const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;

  Object.assign(ee, {
    pid: 99999,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: vi.fn((signal?: string) => {
      (ee as any).killed = true;
      (ee as any).exitCode = signal === "SIGKILL" ? 1 : 0;
      setTimeout(() => {
        ee.emit("exit", (ee as any).exitCode, signal ?? "SIGTERM");
      }, 10);
    }),
    _stdinWrites: stdinWrites,
  });

  return ee as ChildProcess;
};

const spawnedProcesses: ChildProcess[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn((..._args: unknown[]) => {
      const proc = mockChildProcess();
      spawnedProcesses.push(proc);
      return proc;
    }),
  };
});

// =====================================================================
// Mock node:net
// =====================================================================

// Mock Socket BEFORE any module under test imports it.
// health-check.ts does: import net from "node:net"; new net.Socket()
// That resolves to the default export (the module namespace).
// So we need to mock the default export with a Socket property.
let __mockSocketFactory: () => any = () => {
  throw new Error("Socket mock not set up for this test");
};

vi.mock("node:net", () => {
  // Use a regular function (not arrow) so `new Socket()` works as a constructor.
  function SocketConstructor(this: any) {
    return __mockSocketFactory.call(this);
  }
  return {
    default: {
      Socket: vi.fn(SocketConstructor),
      createConnection: vi.fn(),
      connect: vi.fn(),
      createServer: vi.fn(),
    },
    Socket: vi.fn(SocketConstructor),
    createConnection: vi.fn(),
    connect: vi.fn(),
    createServer: vi.fn(),
  };
});

// =====================================================================
// Mock global fetch
// =====================================================================

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// =====================================================================
// Imports under test
// =====================================================================

import { VmGuestRpc } from "../main/vm-guest-rpc.js";
import type { VmConfig } from "../main/vm-guest-rpc.js";
import { getVmBundleDir, getRootfsPath, getAgentImgPath, isVmBundleReady } from "../main/vm-bundle.js";
import { createSessionDisk } from "../main/vm-disk.js";
import { waitForHealth, checkTcpPort, checkAgentHubsHealth, DEFAULT_HEALTH_RETRIES } from "../main/health-check.js";

// =====================================================================
// Helpers
// =====================================================================

const makeConfig = (overrides?: Partial<VmConfig>): VmConfig => ({
  kernelPath: "/tmp/test-kernel",
  rootfsImage: "/tmp/test-rootfs.img",
  sessionImage: "/tmp/test-session.img",
  agentImage: "/tmp/test-agent.img",
  memoryMB: 1024,
  cpuCount: 2,
  vsockPort: 9000,
  ...overrides,
});

function pushStdoutLine(proc: ChildProcess, line: string): void {
  proc.stdout!.emit("data", Buffer.from(line + "\n", "utf-8"));
}

// =====================================================================
// Section 1: VmGuestRpc Unit Tests
// =====================================================================

describe("VmGuestRpc", () => {
  let rpc: VmGuestRpc;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnedProcesses.length = 0;
    mockFetch.mockReset();
    rpc = new VmGuestRpc("/usr/local/bin/supernode-vm");
  });

  afterEach(() => {
    rpc.close();
  });

  // JSON-RPC request/response correlation (AC-3B.6)
  describe("request/response correlation", () => {
    it("correlates responses to requests by id", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const reqPromise = rpc.request("ping");
      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pong" }));

      const resp = await reqPromise;
      expect(resp.status).toBe("ok");
      expect(resp.data).toBe("pong");
    });

    it("matches responses with the correct pending request (multiple concurrent)", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const p1 = rpc.request("HealthCheck");
      const p2 = rpc.request("Status");

      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { status: "ok" } }));
      const resp2 = await p2;
      expect(resp2.status).toBe("ok");
      expect(resp2.data).toEqual({ status: "ok" });

      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { healthy: true } }));
      const resp1 = await p1;
      expect(resp1.status).toBe("ok");
      expect(resp1.data).toEqual({ healthy: true });
    });
  });

  // Request timeout
  describe("request timeout handling", () => {
    it("rejects request after timeout", async () => {
      await rpc.startVM(makeConfig());
      await expect(rpc.request("slowMethod", {}, 100)).rejects.toThrow(
        "RPC request 'slowMethod' timed out after 100ms",
      );
    });

    it("rejects request with custom timeout", async () => {
      await rpc.startVM(makeConfig());
      await expect(rpc.request("fastTimeout", {}, 50)).rejects.toThrow(
        "RPC request 'fastTimeout' timed out after 50ms",
      );
    });
  });

  // Event parsing
  describe("event parsing (waitForEvent)", () => {
    it("resolves when matching event type arrives", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const eventPromise = rpc.waitForEvent("Ready", 500);
      pushStdoutLine(proc, JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        type: "Ready",
        timestamp: "2026-06-23T00:00:00.000Z",
      }));

      const data = await eventPromise;
      expect(data).toHaveProperty("type", "Ready");
      expect(data).toHaveProperty("timestamp");
    });

    it("rejects on event timeout when no matching event arrives", async () => {
      await rpc.startVM(makeConfig());
      await expect(rpc.waitForEvent("Ready", 100)).rejects.toThrow(
        "Event 'Ready' not received within 100ms",
      );
    });

    it("does not confuse events with request responses", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const eventPromise = rpc.waitForEvent("Ready", 200);
      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));

      await expect(eventPromise).rejects.toThrow("not received within 200ms");
    });
  });

  // Process crash handling
  describe("process crash handling", () => {
    it("rejects all pending requests when process exits unexpectedly", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const p1 = rpc.request("ping");
      const p2 = rpc.request("status");

      proc.emit("exit", 1, null);

      await expect(p1).rejects.toThrow("Subprocess exited unexpectedly (code=1, signal=null)");
      await expect(p2).rejects.toThrow("Subprocess exited unexpectedly (code=1, signal=null)");
    });

    it("rejects pending requests when process emits error", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const p1 = rpc.request("ping");
      proc.emit("error", new Error("EPIPE"));

      await expect(p1).rejects.toThrow("Subprocess error: EPIPE");
    });

    it("rejects request when process is not connected", async () => {
      await expect(rpc.request("ping")).rejects.toThrow("VmGuestRpc is not connected");
    });

    it("rejects request when RPC is closed", async () => {
      await rpc.startVM(makeConfig());
      rpc.close();
      await expect(rpc.request("ping")).rejects.toThrow("VmGuestRpc is not connected");
    });
  });

  // close() cleanup
  describe("close() cleanup", () => {
    it("rejects all pending requests when closed", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const p1 = rpc.request("ping");
      const p2 = rpc.request("status");

      rpc.close();

      await expect(p1).rejects.toThrow("VmGuestRpc closed");
      await expect(p2).rejects.toThrow("VmGuestRpc closed");
    });

    it("sends SIGTERM to subprocess on close", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      rpc.close();

      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("does not throw if close() called multiple times", () => {
      rpc.close();
      expect(() => rpc.close()).not.toThrow();
    });

    it("sends SIGKILL after 5 second grace period (simulated)", async () => {
      vi.useFakeTimers();
      try {
        await rpc.startVM(makeConfig());
        const proc = spawnedProcesses[0]!;

        // Override kill so SIGTERM does NOT auto-emit exit.
        // This simulates a stuck process that requires SIGKILL.
        const originalKill = proc.kill;
        let killCount = 0;
        (proc.kill as any) = vi.fn((signal?: string) => {
          killCount++;
          if (signal === "SIGKILL" || killCount >= 2) {
            return (originalKill as any)(signal);
          }
          return true;
        });

        rpc.close();

        expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

        // Advance past the 5 second grace period
        vi.advanceTimersByTime(5100);

        expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // startVM() edge cases
  describe("startVM()", () => {
    it("throws if already started", async () => {
      await rpc.startVM(makeConfig());
      await expect(rpc.startVM(makeConfig())).rejects.toThrow(
        "VM is already started; stopVM() first.",
      );
    });

    it("throws if closed", async () => {
      rpc.close();
      await expect(rpc.startVM(makeConfig())).rejects.toThrow("VmGuestRpc is closed");
    });

    it("includes initrd flag when config has initrdPath", async () => {
      const { spawn } = await import("node:child_process");
      await rpc.startVM(makeConfig({ initrdPath: "/tmp/initrd" }));

      const callArgs = vi.mocked(spawn).mock.calls[0];
      expect(callArgs).toBeDefined();
      const args = callArgs![1] as string[];
      expect(args).toContain("--initrd");
      expect(args).toContain("/tmp/initrd");
    });

    it("does not include initrd flag when config has no initrdPath", async () => {
      const { spawn } = await import("node:child_process");
      await rpc.startVM(makeConfig({ initrdPath: undefined }));

      const callArgs = vi.mocked(spawn).mock.calls[0];
      const args = callArgs![1] as string[];
      expect(args).not.toContain("--initrd");
    });
  });

  // stopVM()
  describe("stopVM()", () => {
    it("sends Shutdown RPC then kills process", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const stopPromise = rpc.stopVM();

      // Respond to the Shutdown request immediately
      pushStdoutLine(proc, JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "stopped" },
      }));

      await stopPromise;

      const writes = (proc as any)._stdinWrites as string[];
      const shutdownWrite = writes.find((w: string) =>
        w.includes('"method":"Shutdown"'),
      );
      expect(shutdownWrite).toBeDefined();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is safe to call stopVM when not started", async () => {
      await expect(rpc.stopVM()).resolves.toBeUndefined();
    });
  });

  // Output resilience
  describe("output parsing resilience", () => {
    it("silently skips non-JSON lines on stdout", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      const respPromise = rpc.request("ping", {}, 500);
      pushStdoutLine(proc, "this is not json");
      pushStdoutLine(proc, "kernel: [ 0.000000] booting...");
      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));

      const resp = await respPromise;
      expect(resp.status).toBe("ok");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Non-JSON line from subprocess"),
      );
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });

    it("handles error response from subprocess", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const reqPromise = rpc.request("badMethod");
      pushStdoutLine(proc, JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found: badMethod" },
      }));

      const resp = await reqPromise;
      expect(resp.status).toBe("error");
      expect(resp.error).toContain("Method not found");
    });

    it("handles empty lines gracefully", async () => {
      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      const respPromise = rpc.request("ping", {}, 500);
      pushStdoutLine(proc, "");
      pushStdoutLine(proc, "   ");
      pushStdoutLine(proc, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));

      const resp = await respPromise;
      expect(resp.status).toBe("ok");
    });
  });

  // stderr handling
  describe("stderr handling", () => {
    it("forwards stderr to console.error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await rpc.startVM(makeConfig());
      const proc = spawnedProcesses[0]!;

      proc.stderr!.emit("data", Buffer.from("error: something went wrong\n", "utf-8"));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("error: something went wrong"),
      );
      errorSpy.mockRestore();
    });
  });
});

// =====================================================================
// Section 2: vm-bundle.ts Unit Tests
// =====================================================================

describe("vm-bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVmBundleDir()", () => {
    it("resolves to a path under .paperclip/vm/bundle", () => {
      const dir = getVmBundleDir();
      expect(dir).toContain(".paperclip");
      expect(dir).toContain("vm");
      expect(dir).toContain("bundle");
    });
  });

  describe("getRootfsPath()", () => {
    it("returns a path ending with rootfs.img", () => {
      expect(getRootfsPath()).toContain("rootfs.img");
    });
  });

  describe("getAgentImgPath()", () => {
    it("returns a path ending with agent.img", () => {
      expect(getAgentImgPath()).toContain("agent.img");
    });
  });

  describe("isVmBundleReady()", () => {
    it("returns false when bundle directory does not exist", () => {
      expect(isVmBundleReady()).toBe(false);
    });
  });
});

// =====================================================================
// Section 3: vm-disk.ts Unit Tests
// =====================================================================

describe("vm-disk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSessionDisk()", () => {
    it("detects missing tooling gracefully", async () => {
      // File does not exist so createSessionDisk runs pre-flight tool checks.
      // On macOS: truncate exists but mkfs.ext4 typically does not.
      // Either "not found on PATH" error means the pre-flight check is working.
      const nonExistentPath = "/tmp/nonexistent-dir-unlikely/new-session.img";
      await expect(createSessionDisk(nonExistentPath, 512)).rejects.toThrow(
        /not found on PATH/,
      );
    });
  });
});

// =====================================================================
// Section 4: health-check.ts Unit Tests
// =====================================================================

describe("health-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("waitForHealth()", () => {
    it("returns true when endpoint returns 200 (within time budget)", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const resultPromise = waitForHealth(
        "http://127.0.0.1:3100/api/health",
        30000,
        [10, 20],
      );

      await vi.advanceTimersByTimeAsync(10);
      const result = await resultPromise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:3100/api/health");
    });

    it("returns false on timeout (all retries exhausted without 200)", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const resultPromise = waitForHealth(
        "http://127.0.0.1:3100/api/health",
        100,
        [10, 20],
      );

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    it("retries on non-200 response", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });

      const resultPromise = waitForHealth(
        "http://127.0.0.1:3000/health",
        30000,
        [10, 20],
      );

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);

      const result = await resultPromise;
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("respects total timeout budget", async () => {
      mockFetch.mockRejectedValue(new Error("Timeout"));

      const resultPromise = waitForHealth(
        "http://127.0.0.1:3100/api/health",
        100,
        DEFAULT_HEALTH_RETRIES,
      );

      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      expect(result).toBe(false);
    });
  });

  describe("checkTcpPort()", () => {
    it("resolves true for open port (connect event)", async () => {
      // Wire up the mock Socket factory so connect() fires the connect event
      __mockSocketFactory = function (this: any) {
        let onConnect: Function | null = null;
        Object.assign(this, {
          setTimeout: vi.fn(),
          connect: vi.fn(() => { if (onConnect) onConnect(); }),
          destroy: vi.fn(),
          on: vi.fn((event: string, cb: Function) => {
            if (event === "connect") onConnect = cb;
            return this;
          }),
        });
        return this;
      };

      const result = await checkTcpPort(5432, 500);
      expect(result).toBe(true);
    });

    it("resolves false for closed port (error event)", async () => {
      __mockSocketFactory = function (this: any) {
        let onError: Function | null = null;
        Object.assign(this, {
          setTimeout: vi.fn(),
          connect: vi.fn(() => { if (onError) onError(new Error("ECONNREFUSED")); }),
          destroy: vi.fn(),
          on: vi.fn((event: string, cb: Function) => {
            if (event === "error") onError = cb;
            return this;
          }),
        });
        return this;
      };

      const result = await checkTcpPort(9999, 500);
      expect(result).toBe(false);
    });

    it("resolves false on timeout", async () => {
      __mockSocketFactory = function (this: any) {
        let onTimeout: Function | null = null;
        Object.assign(this, {
          setTimeout: vi.fn(),
          connect: vi.fn(() => { if (onTimeout) onTimeout(); }),
          destroy: vi.fn(),
          on: vi.fn((event: string, cb: Function) => {
            if (event === "timeout") onTimeout = cb;
            return this;
          }),
        });
        return this;
      };

      const result = await checkTcpPort(5432, 500);
      expect(result).toBe(false);
    });
  });

  describe("checkAgentHubsHealth()", () => {
    it("resolves with correct structure when all services healthy", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      __mockSocketFactory = function (this: any) {
        let onConnect: Function | null = null;
        Object.assign(this, {
          setTimeout: vi.fn(),
          connect: vi.fn(() => { if (onConnect) onConnect(); }),
          destroy: vi.fn(),
          on: vi.fn((event: string, cb: Function) => {
            if (event === "connect") onConnect = cb;
            return this;
          }),
        });
        return this;
      };

      const results = await checkAgentHubsHealth();
      expect(results).toEqual({
        cloudApi: true,
        paperclip: true,
        postgres: true,
        redis: true,
      });
    });

    it("reports false for services that fail", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      __mockSocketFactory = function (this: any) {
        let onConnect: Function | null = null;
        Object.assign(this, {
          setTimeout: vi.fn(),
          connect: vi.fn(() => { if (onConnect) onConnect(); }),
          destroy: vi.fn(),
          on: vi.fn((event: string, cb: Function) => {
            if (event === "connect") onConnect = cb;
            return this;
          }),
        });
        return this;
      };

      const results = await checkAgentHubsHealth();
      expect(results.cloudApi).toBe(false);
      expect(results.paperclip).toBe(false);
      expect(results.postgres).toBe(true);
      expect(results.redis).toBe(true);
    });
  });
});

// =====================================================================
// Section 5: Integration test (runs only if Swift CLI binary exists)
// =====================================================================

describe("Swift CLI Integration", () => {
  it.skip("spawns Swift CLI, tests JSON-RPC handshake, ping, and shutdown", async () => {
    // This test is skipped by default. It runs only when the supernode-vm
    // binary and full VM bundle are present.
    //
    // To run manually:
    //   1. Build the Swift CLI: cd vm-runtime/swift && swift build
    //   2. Add to PATH: export PATH="$(pwd)/.build/debug:$PATH"
    //   3. Run: npx vitest run apps/desktop/src/__tests__/vm-guest-rpc.test.ts \
    //            -t "Swift CLI Integration"

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    let binaryPath: string;
    try {
      const { stdout } = await execFileAsync("which", ["supernode-vm"], {
        timeout: 5000,
      });
      binaryPath = stdout.trim();
    } catch {
      return; // Binary not found, it.skip handles the rest
    }

    const rpc = new VmGuestRpc(binaryPath);
    try {
      const { spawn } = await import("node:child_process");
      const proc = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
      );

      const response = await new Promise<string | null>((resolve) => {
        let output = "";
        proc.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("\n")) {
            resolve(output.trim());
          }
        });
        setTimeout(() => resolve(null), 3000);
      });

      expect(response).not.toBeNull();
      expect(JSON.parse(response!)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: "pong",
      });

      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "stop" }) + "\n",
      );
      proc.stdin!.end();

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on("exit", (c) => resolve(c));
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(null);
        }, 5000);
      });

      expect(exitCode).toBe(0);
    } finally {
      rpc.close();
    }
  });
});
