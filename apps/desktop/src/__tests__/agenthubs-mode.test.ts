// apps/desktop/src/__tests__/agenthubs-mode.test.ts
// S-3C1: Tests for the rewritten agenthubs-mode.ts (VM platform, no Docker)
//
// Strategy: Test the state management, constants, and health check logic
// in isolation. VM spawning/integration is tested via e2e.

import { describe, it, expect } from "vitest";
import {
  getAgentHubsModeState,
  checkAgentHubsHealth,
} from "../main/agenthubs-mode.js";
import type {
  HealthCheckResults,
  AgentHubsModeState,
  StartAgentHubsConfig,
  StopAgentHubsConfig,
} from "../main/agenthubs-mode.js";

// ─── Type compatibility tests ────────────────────────────────────────────────

describe("agenthubs-mode type definitions", () => {
  it("HealthCheckResults does NOT contain postgres or redis", () => {
    // Verify the new interface: only cloudApi, paperclip, minio
    // postgres and redis are removed (inside VM, not host-accessible)
    const results: HealthCheckResults = {
      cloudApi: true,
      paperclip: true,
      minio: true,
    };

    // @ts-expect-error: postgres should not exist on HealthCheckResults
    const _postgresCheck: boolean = results.postgres;

    // @ts-expect-error: redis should not exist on HealthCheckResults
    const _redisCheck: boolean = results.redis;

    expect(results.cloudApi).toBe(true);
    expect(results.paperclip).toBe(true);
    expect(results.minio).toBe(true);
  });

  it("AgentHubsModeState uses composePath (back compat field name)", () => {
    const state: AgentHubsModeState = {
      status: "running",
      composePath: "/some/vm/bundle/dir",
      healthCheckResults: {
        cloudApi: false,
        paperclip: false,
        minio: false,
      },
    };

    expect(state.status).toBe("running");
    expect(state.composePath).toBe("/some/vm/bundle/dir");
    // verify type allows only 5 status values
    const _check:
      | "stopped"
      | "starting"
      | "running"
      | "stopping"
      | "error" = state.status;
    expect(_check).toBe("running");
  });

  it("StartAgentHubsConfig does NOT contain containerRuntime or composePath", () => {
    // These fields are removed (VM platform replaces Docker)
    const config: StartAgentHubsConfig = {
      paperclipHome: "/home/user/.paperclip",
      onProgress: (msg: string) => {
        console.log(msg);
      },
    };

    // @ts-expect-error: containerRuntime must not exist
    const _rtCheck: string = config.containerRuntime;

    // @ts-expect-error: composePath must not exist
    const _cpCheck: string = config.composePath;

    expect(config.paperclipHome).toBe("/home/user/.paperclip");
    expect(typeof config.onProgress).toBe("function");
  });

  it("StopAgentHubsConfig does NOT contain containerRuntime or composePath", () => {
    const config: StopAgentHubsConfig = {
      timeout: 60,
      sessionImagePath: "/tmp/session.img",
    };

    // @ts-expect-error: containerRuntime must not exist
    const _rtCheck: string = config.containerRuntime;

    // @ts-expect-error: composePath must not exist
    const _cpCheck: string = config.composePath;

    expect(config.timeout).toBe(60);
    expect(config.sessionImagePath).toBe("/tmp/session.img");
  });
});

// ─── State management tests ─────────────────────────────────────────────────

describe("getAgentHubsModeState", () => {
  it("returns null before any start is called", () => {
    const state = getAgentHubsModeState();
    expect(state).toBeNull();
  });
});

// ─── Health check tests ─────────────────────────────────────────────────────

describe("checkAgentHubsHealth", () => {
  it("returns false for all services when nothing is running", async () => {
    const results = await checkAgentHubsHealth();

    // When nothing is running, all health checks should fail (false)
    expect(results.cloudApi).toBe(false);
    expect(results.paperclip).toBe(false);
    expect(results.minio).toBe(false);

    // postgres and redis must not be in the results
    expect("postgres" in results).toBe(false);
    expect("redis" in results).toBe(false);
  });

  it("result type matches HealthCheckResults interface", async () => {
    const results = await checkAgentHubsHealth();

    // Verify the shape of the returned object
    const keys = Object.keys(results).sort();
    expect(keys).toEqual(["cloudApi", "minio", "paperclip"]);
  });
});
