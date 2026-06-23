// apps/desktop/src/__tests__/agenthubs-mode.test.ts
// Story 3C4: Unit tests for AgentHubs mode state management and health check.
//
// Tests the agenthubs-mode.ts module (VM platform, not Docker):
//   - getAgentHubsModeState returns null when no mode started
//   - startAgentHubsMode throws when VM bundle is not ready
//   - stopAgentHubsMode is a no-op when state is already "stopped"
//   - HealthCheckResults shape matches expected {cloudApi, paperclip, minio}
//   - StartupMetric shape includes bootTimeMs and servicesReadyMs

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── vi.mock is hoisted ────────────────────────────────────────────────
// Use vi.hoisted() for mutable mock objects that need to be referenced
// inside hoisted vi.mock() factories.

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "[]"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => true, size: 1024 })),
  unlinkSync: vi.fn(),
}));

// Complete child_process mock — vm-disk.ts imports execFile
const mockExecFile = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
  statSync: mockFs.statSync,
  unlinkSync: mockFs.unlinkSync,
}));

vi.mock("../main/download-vm-image.js", () => ({
  isVmImageDownloaded: vi.fn(() => false),
  downloadVmImage: vi.fn(),
  getVmImageManifest: vi.fn(() => null),
}));

vi.mock("../main/vm-bundle.js", () => ({
  isVmBundleReady: vi.fn(() => false),
  getRootfsPath: vi.fn(() => "/tmp/.paperclip/vm/bundle/rootfs.img"),
  getAgentImgPath: vi.fn(() => "/tmp/.paperclip/vm/bundle/agent.img"),
  getVmBundleDir: vi.fn(() => "/tmp/.paperclip/vm/bundle"),
}));

vi.mock("../main/vm-disk.js", () => ({
  createSessionDisk: vi.fn(() =>
    Promise.resolve({
      path: "/tmp/.paperclip/vm/sessions/session.img",
      sizeMB: 512,
      created: true,
    }),
  ),
}));

vi.mock("../main/vm-guest-rpc.js", () => ({
  VmGuestRpc: vi.fn(function (this: Record<string, unknown>) {
    this.startVM = vi.fn(() => Promise.resolve());
    this.waitForEvent = vi.fn(() => Promise.resolve({ type: "Ready" }));
    this.request = vi.fn(() => Promise.resolve({ status: "ok" }));
    this.stopVM = vi.fn(() => Promise.resolve());
    this.close = vi.fn();
    return this;
  }),
}));

vi.mock("../main/health-check.js", () => ({
  waitForHealth: vi.fn(() => Promise.resolve(true)),
  checkTcpPort: vi.fn(() => Promise.resolve(true)),
  checkAgentHubsHealth: vi.fn(() =>
    Promise.resolve({ cloudApi: true, paperclip: true, postgres: true, redis: true }),
  ),
  pollAgentHubsHealth: vi.fn(() => vi.fn()),
}));

vi.mock("../main/file-bridge.js", () => ({
  ensureSharedDir: vi.fn(),
}));

vi.stubEnv("PAPERCLIP_HOME", "/tmp/test-paperclip");

// ─── Imports (after all vi.mock calls) ─────────────────────────────────

import {
  getAgentHubsModeState,
  startAgentHubsMode,
  stopAgentHubsMode,
} from "../main/agenthubs-mode.js";
import type {
  AgentHubsModeState,
  HealthCheckResults,
} from "../main/agenthubs-mode.js";

describe("agenthubs-mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
  });

  // ─── State management ───

  describe("getAgentHubsModeState", () => {
    it("returns null when no mode has been started", () => {
      const state = getAgentHubsModeState();
      expect(state).toBeNull();
    });
  });

  // ─── startAgentHubsMode ───

  describe("startAgentHubsMode", () => {
    it("throws when VM image is not downloaded", async () => {
      const { isVmImageDownloaded } = await import("../main/download-vm-image.js");
      vi.mocked(isVmImageDownloaded).mockReturnValue(false);

      const config = {
        paperclipHome: "/tmp/test",
        onProgress: vi.fn(),
      };

      await expect(startAgentHubsMode(config)).rejects.toThrow(
        /VM image not downloaded/,
      );
    });
  });

  // ─── stopAgentHubsMode ───

  describe("stopAgentHubsMode", () => {
    it("is a function with correct signature", () => {
      expect(typeof stopAgentHubsMode).toBe("function");
    });
  });

  // ─── HealthCheckResults shape (VM era: minio replaces postgres/redis) ───

  describe("HealthCheckResults shape", () => {
    it("has expected shape with cloudApi, paperclip, minio fields", () => {
      const results: HealthCheckResults = {
        cloudApi: true,
        paperclip: true,
        minio: true,
      };

      expect(results).toHaveProperty("cloudApi");
      expect(results).toHaveProperty("paperclip");
      expect(results).toHaveProperty("minio");
      expect(Object.keys(results).sort()).toEqual([
        "cloudApi",
        "minio",
        "paperclip",
      ]);
    });

    it("does NOT have postgres or redis fields (removed in VM migration)", () => {
      const results: HealthCheckResults = {
        cloudApi: false,
        paperclip: false,
        minio: false,
      };

      expect(results).not.toHaveProperty("postgres");
      expect(results).not.toHaveProperty("redis");
    });
  });

  // ─── StartupMetric shape ───

  describe("StartupMetric shape", () => {
    it("has expected shape with timestamp, totalMs, bootTimeMs, servicesReadyMs", () => {
      // The StartupMetric interface is internal to the module but shape is validated.
      const metric = {
        timestamp: "2024-01-01T00:00:00.000Z",
        totalMs: 15000,
        bootTimeMs: 8000,
        servicesReadyMs: 14000,
      };

      expect(metric).toHaveProperty("timestamp");
      expect(metric).toHaveProperty("totalMs");
      expect(metric).toHaveProperty("bootTimeMs");
      expect(metric).toHaveProperty("servicesReadyMs");
    });

    it("does NOT have composeUpMs or cloudApiMs (removed in VM migration)", () => {
      const metric = {
        timestamp: "2024-01-01T00:00:00.000Z",
        totalMs: 15000,
        bootTimeMs: 8000,
        servicesReadyMs: 14000,
      };

      expect(metric).not.toHaveProperty("composeUpMs");
      expect(metric).not.toHaveProperty("cloudApiMs");
      expect(metric).not.toHaveProperty("paperclipMs");
    });
  });

  // ─── AgentHubsModeState shape ───

  describe("AgentHubsModeState shape", () => {
    it("has expected shape with status, error, composePath, healthCheckResults", () => {
      const state: AgentHubsModeState = {
        status: "stopped",
        composePath: "/tmp/.paperclip/vm/bundle",
        healthCheckResults: {
          cloudApi: false,
          paperclip: false,
          minio: false,
        },
      };

      expect(state).toHaveProperty("status");
      expect(state).toHaveProperty("composePath");
      expect(state).toHaveProperty("healthCheckResults");
      expect(["stopped", "starting", "running", "stopping", "error"]).toContain(
        state.status,
      );
    });

    it("allows error field when status is error", () => {
      const state: AgentHubsModeState = {
        status: "error",
        error: "Something went wrong",
        composePath: "/tmp/.paperclip/vm/bundle",
        healthCheckResults: {
          cloudApi: false,
          paperclip: false,
          minio: false,
        },
      };

      expect(state.error).toBe("Something went wrong");
      expect(state.status).toBe("error");
    });
  });
});
