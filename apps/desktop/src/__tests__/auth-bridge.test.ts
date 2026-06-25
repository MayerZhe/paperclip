// apps/desktop/src/__tests__/auth-bridge.test.ts
// Phase 2: Tests for auth-bridge org selection bug fix

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function fakeToken(userId = "user_1", email = "test@example.com"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, email, name: "Test User", iat: 1234567890 }),
  ).toString("base64url");
  const signature = "fake-signature";
  return `${header}.${payload}.${signature}`;
}

function fakeOrgs() {
  return [
    { id: "org_001", name: "Alpha Org", type: "sn" as const, slug: "org_001" },
    { id: "org_002", name: "Beta Org", type: "hmo" as const, slug: "org_002" },
  ];
}

const mockWebContents = vi.hoisted(() => ({
  removeAllListeners: vi.fn(),
  on: vi.fn(),
  executeJavaScript: vi.fn(),
}));

const { MockBrowserWindow } = vi.hoisted(() => {
  class MockBrowserWindow {
    webContents = mockWebContents;
    isDestroyed = vi.fn(() => false);
    close = vi.fn();
    once = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    removeAllListeners = vi.fn();
    on = vi.fn();
  }
  return { MockBrowserWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: MockBrowserWindow,
  session: {
    fromPartition: vi.fn(() => ({})),
  },
}));

import { createAuthBridge, checkExistingSession } from "../main/auth-bridge.js";
import type { LoginResult } from "../main/auth-bridge.js";

function assertNotNull<T>(value: T | null | undefined): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error("Expected value not to be null or undefined");
  }
}

describe("createAuthBridge — org selection flow", () => {
  let onLoginComplete: (result: LoginResult) => void;
  let onLoginFailed: (error: Error) => void;
  let didNavigateHandler: (
    event: unknown,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
  ) => void;
  let willNavigateHandler: (event: { preventDefault: () => void }, url: string) => void;
  let completeResult: LoginResult | null = null;
  let failedError: Error | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    completeResult = null;
    failedError = null;
    mockWebContents.executeJavaScript.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createBridge() {
    onLoginComplete = vi.fn((result: LoginResult) => {
      completeResult = result;
    }) as unknown as typeof onLoginComplete;

    onLoginFailed = vi.fn((error: Error) => {
      failedError = error;
    }) as unknown as typeof onLoginFailed;

    createAuthBridge({ onLoginComplete, onLoginFailed });

    const onCalls = mockWebContents.on.mock.calls;
    for (const call of onCalls) {
      if (call[0] === "did-navigate") {
        didNavigateHandler = call[1] as typeof didNavigateHandler;
      } else if (call[0] === "will-navigate") {
        willNavigateHandler = call[1] as typeof willNavigateHandler;
      }
    }
  }

  // advanceTimePromise: advances fake timers by ms, flushing promises
  async function advanceTimePromise(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    // Also flush any microtasks queued after timer advancement
    await vi.runAllTicks();
  }

  async function navigateTo(url: string, httpCode = 200) {
    const promise = didNavigateHandler(null, url, httpCode, "OK");
    // Advance past the 1-second delay inside the handler
    await advanceTimePromise(1500);
    await promise;
  }

  function willNavigateTo(url: string) {
    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, url);
    return event;
  }

  function givenTokenInStorage(token: string | null) {
    mockWebContents.executeJavaScript.mockResolvedValue(token);
  }

  function givenOrgsApiReturns(orgs: ReturnType<typeof fakeOrgs>, status = 200) {
    vi.stubGlobal("fetch", async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => orgs,
    }));
  }

  function givenOrgsApiFails(status: number) {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status,
      json: async () => ({ error: "unauthorized" }),
    }));
  }

  it("should cache auth at /select-org and not settle until /console navigation", async () => {
    const token = fakeToken();
    const orgs = fakeOrgs();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    // Act 1: Navigate to /select-org — fix ensures NO settlement
    await navigateTo("http://localhost:3000/select-org");

    // Assert: NOT settled yet (cachedAuth is populated but succeed() not called)
    expect(completeResult).toBeNull();
    expect(failedError).toBeNull();

    // Act 2: will-navigate to /console/sn/org_001 — should settle now
    const willEvent = willNavigateTo("http://localhost:3000/console/sn/org_001");

    assertNotNull(completeResult);
    expect(completeResult.token).toBe(token);
    expect(completeResult.user.email).toBe("test@example.com");
    expect(completeResult.orgs).toHaveLength(2);
    expect(completeResult.selectedOrgId).toBe("org_001");
    expect(willEvent.preventDefault).toHaveBeenCalled();
  });

  it("should match org by slug in console URL", async () => {
    const orgsWithDifferentSlug = [
      { id: "uuid-abc-123", name: "Alpha Org", type: "sn" as const, slug: "alpha" },
      { id: "uuid-def-456", name: "Beta Org", type: "hmo" as const, slug: "beta" },
    ];
    const token = fakeToken();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgsWithDifferentSlug);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    willNavigateTo("http://localhost:3000/console/sn/alpha");
    assertNotNull(completeResult);
    expect(completeResult.selectedOrgId).toBe("uuid-abc-123");
  });

  it("should match org by id if slug doesn't match", async () => {
    const orgs = fakeOrgs();
    const token = fakeToken();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    willNavigateTo("http://localhost:3000/console/sn/org_002");
    assertNotNull(completeResult);
    expect(completeResult.selectedOrgId).toBe("org_002");
  });

  it("should fall back to first org if slug doesn't match any org", async () => {
    const orgs = fakeOrgs();
    const token = fakeToken();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    willNavigateTo("http://localhost:3000/console/sn/nonexistent");
    assertNotNull(completeResult);
    expect(completeResult.selectedOrgId).toBe(orgs[0].id);
  });

  it("should handle /console/hmo/<slug> for HMO org type", async () => {
    const orgs = fakeOrgs();
    const token = fakeToken();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    willNavigateTo("http://localhost:3000/console/hmo/org_002");
    assertNotNull(completeResult);
    expect(completeResult.selectedOrgId).toBe("org_002");
  });

  it("should settle with first org when navigating to /dashboard with cachedAuth", async () => {
    const token = fakeToken();
    const orgs = fakeOrgs();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    await navigateTo("http://localhost:3000/dashboard");
    assertNotNull(completeResult);
    expect(completeResult.selectedOrgId).toBe(orgs[0].id);
    expect(completeResult.token).toBe(token);
  });

  it("should still handle direct /console navigation without prior /select-org", async () => {
    const token = fakeToken();
    const orgs = fakeOrgs();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/console/sn/org_001");
    assertNotNull(completeResult);
    expect(completeResult.token).toBe(token);
    expect(completeResult.selectedOrgId).toBe("org_001");
  });

  it("should not fail when no token found at /select-org (waits for later login)", async () => {
    givenTokenInStorage(null);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");

    expect(completeResult).toBeNull();
    expect(failedError).toBeNull();
  });

  it("should fail when org fetch fails at /select-org", async () => {
    const token = fakeToken();
    givenTokenInStorage(token);
    givenOrgsApiFails(401);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");

    expect(completeResult).toBeNull();
    expect(failedError).not.toBeNull();
    if (failedError) {
      expect(failedError.message).toContain("Login failed");
    }
  });

  it("should not react to events after settlement", async () => {
    const token = fakeToken();
    const orgs = fakeOrgs();
    givenTokenInStorage(token);
    givenOrgsApiReturns(orgs);
    createBridge();

    await navigateTo("http://localhost:3000/select-org");
    willNavigateTo("http://localhost:3000/console/sn/org_001");

    assertNotNull(completeResult);
    completeResult = null;

    await navigateTo("http://localhost:3000/select-org");
    expect(completeResult).toBeNull();
  });
});

describe("checkExistingSession", () => {
  it("is exported and callable (smoke test)", () => {
    expect(typeof checkExistingSession).toBe("function");
  });
});
