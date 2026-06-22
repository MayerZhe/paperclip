// apps/desktop/src/__tests__/sidebar-manager.test.ts
// S-A3: Tests for SidebarManager

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mutable state for mocks (runtime-accessible, NOT hoisted) ───

const state = {
  viewSetBounds: vi.fn(),
  viewSetVisible: vi.fn(),
  viewWebContentsClose: vi.fn(),
  viewLoadURL: vi.fn(),
  createdViews: [] as Array<{ setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; webContents: { loadURL: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }>,

  windowSend: vi.fn(),
  windowLoadFile: vi.fn(),
  windowClose: vi.fn(),
  windowIsDestroyed: vi.fn(() => false),
  windowShow: vi.fn(),
  windowGetContentSize: vi.fn(() => [1200, 800]),
  windowEventHandlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
  windowAddChildView: vi.fn(),
  windowRemoveChildView: vi.fn(),

  ipcOnHandlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
  ipcHandleHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  ipcRemovedListeners: [] as string[],
  ipcRemovedHandlers: [] as string[],

  // Captured BrowserWindow constructor args for inspection
  lastBrowserWindowArgs: null as Record<string, unknown> | null,
};

// ─── Mock factories ───

function createMockBrowserWindow(opts: Record<string, unknown>) {
  state.lastBrowserWindowArgs = opts;
  return {
    loadFile: state.windowLoadFile,
    close: state.windowClose,
    isDestroyed: state.windowIsDestroyed,
    show: state.windowShow,
    getContentSize: state.windowGetContentSize,
    webContents: {
      send: state.windowSend,
    },
    contentView: {
      addChildView: state.windowAddChildView,
      removeChildView: state.windowRemoveChildView,
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!state.windowEventHandlers[event]) state.windowEventHandlers[event] = [];
      state.windowEventHandlers[event].push(handler);
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      if (!state.windowEventHandlers[event]) state.windowEventHandlers[event] = [];
      state.windowEventHandlers[event].push(handler);
    },
  };
}

function createMockWebContentsView() {
  const view = {
    setBounds: state.viewSetBounds,
    setVisible: state.viewSetVisible,
    webContents: {
      loadURL: state.viewLoadURL,
      close: state.viewWebContentsClose,
    },
  };
  state.createdViews.push(view);
  return view;
}

// ─── Hoisted mocks (NO references to outer variables — only inline functions) ───

vi.mock("electron", () => ({
  BrowserWindow: function BrowserWindow(opts: Record<string, unknown>) {
    return createMockBrowserWindow(opts);
  },
  WebContentsView: function WebContentsView() {
    return createMockWebContentsView();
  },
  session: {
    fromPartition: vi.fn(() => ({ _session: "mock-session" })),
  },
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      if (!state.ipcOnHandlers[channel]) state.ipcOnHandlers[channel] = [];
      state.ipcOnHandlers[channel].push(handler);
    }),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.ipcHandleHandlers[channel] = handler;
    }),
    removeAllListeners: vi.fn((channel: string) => {
      state.ipcRemovedListeners.push(channel);
      delete state.ipcOnHandlers[channel];
    }),
    removeHandler: vi.fn((channel: string) => {
      state.ipcRemovedHandlers.push(channel);
      delete state.ipcHandleHandlers[channel];
    }),
    send: vi.fn(),
  },
}));

vi.mock("node:path", () => ({
  default: {
    join: (...args: string[]) => args.join("/"),
    dirname: (p: string) => p.split("/").slice(0, -1).join("/") || "/",
    resolve: (...args: string[]) => args.join("/"),
  },
}));

// ─── Import after mocks ───

import { createSidebarManager, type SidebarManager } from "../main/sidebar-manager.js";

// ─── Helpers ───

function triggerWindowEvent(event: string, ...args: unknown[]) {
  const handlers = state.windowEventHandlers[event] || [];
  for (const h of handlers) {
    h(...args);
  }
}

function triggerIpcOn(channel: string, ...args: unknown[]) {
  const handlers = state.ipcOnHandlers[channel] || [];
  for (const h of handlers) {
    h(...args);
  }
}

function createDefaultManager(): SidebarManager {
  return createSidebarManager({
    shellHtmlPath: "/app/renderer/shell.html",
    shellPreloadPath: "/app/renderer/shell-preload.js",
    jwtToken: "test-jwt-token",
    onSignOut: vi.fn(),
  });
}

// ─── Tests ───

describe("createSidebarManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.createdViews = [];
    state.windowEventHandlers = {};
    state.ipcOnHandlers = {};
    state.ipcHandleHandlers = {};
    state.ipcRemovedListeners = [];
    state.ipcRemovedHandlers = [];
    state.lastBrowserWindowArgs = null;
    state.windowIsDestroyed.mockReturnValue(false);
    state.windowGetContentSize.mockReturnValue([1200, 800]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ── Window creation ──

  describe("Window creation", () => {
    it("creates BrowserWindow with correct dimensions", () => {
      createDefaultManager();
      const args = state.lastBrowserWindowArgs!;
      expect(args.width).toBe(1200);
      expect(args.height).toBe(800);
      expect(args.minWidth).toBe(900);
      expect(args.minHeight).toBe(600);
      expect(args.title).toBe("PaperClip");
      expect(args.show).toBe(false);
    });

    it("includes macOS titlebar settings on darwin", () => {
      if (process.platform !== "darwin") return;
      createDefaultManager();
      const args = state.lastBrowserWindowArgs!;
      expect(args.titleBarStyle).toBe("hiddenInset");
      expect(args.titleBarOverlay).toBe(false);
      expect(args.vibrancy).toBe("under-window");
      expect(args.visualEffectState).toBe("active");
      expect(args.backgroundColor).toBe("#00000000");
      expect(args.trafficLightPosition).toEqual({ x: 12, y: 16 });
    });

    it("uses shell preload path in webPreferences", () => {
      createDefaultManager();
      const args = state.lastBrowserWindowArgs!;
      const wp = args.webPreferences as Record<string, unknown>;
      expect(wp.preload).toBe("/app/renderer/shell-preload.js");
      expect(wp.contextIsolation).toBe(true);
      expect(wp.nodeIntegration).toBe(false);
      expect(wp.sandbox).toBe(true);
    });

    it("loads shell.html via loadFile", () => {
      createDefaultManager();
      expect(state.windowLoadFile).toHaveBeenCalledWith("/app/renderer/shell.html");
    });

    it("shows window on ready-to-show", () => {
      createDefaultManager();
      triggerWindowEvent("ready-to-show");
      expect(state.windowShow).toHaveBeenCalled();
    });

    it("does not show window if destroyed before ready-to-show", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.windowShow.mockClear();
      triggerWindowEvent("ready-to-show");
      expect(state.windowShow).not.toHaveBeenCalled();
    });
  });

  // ── WebContentsView creation ──

  describe("WebContentsView creation", () => {
    it("creates two WebContentsView instances", () => {
      createDefaultManager();
      expect(state.createdViews).toHaveLength(2);
    });

    it("loads correct URLs for each view", () => {
      createDefaultManager();
      expect(state.viewLoadURL).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4000");
      expect(state.viewLoadURL).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3100");
    });

    it("adds both views to main window contentView", () => {
      createDefaultManager();
      expect(state.windowAddChildView).toHaveBeenCalledTimes(2);
    });

    it("starts with both views invisible", () => {
      createDefaultManager();
      expect(state.viewSetVisible).toHaveBeenCalledWith(false);
      expect(state.viewSetVisible).toHaveBeenCalledTimes(2);
    });
  });

  // ── Layout ──

  describe("Layout calculation", () => {
    it("sets correct content bounds on show", () => {
      createDefaultManager();
      state.viewSetBounds.mockClear();

      triggerWindowEvent("show");

      const expected = { x: 260, y: 48, width: 940, height: 752 };
      expect(state.viewSetBounds).toHaveBeenCalledWith(expected);
      expect(state.viewSetBounds).toHaveBeenCalledTimes(2);
    });

    it("recalculates layout on window resize", () => {
      createDefaultManager();
      state.windowGetContentSize.mockReturnValue([1400, 900]);
      state.viewSetBounds.mockClear();

      triggerWindowEvent("resize");

      const expected = { x: 260, y: 48, width: 1140, height: 852 };
      expect(state.viewSetBounds).toHaveBeenCalledWith(expected);
      expect(state.viewSetBounds).toHaveBeenCalledTimes(2);
    });

    it("clamps negative dimensions to 0", () => {
      createDefaultManager();
      state.windowGetContentSize.mockReturnValue([200, 400]);
      state.viewSetBounds.mockClear();

      triggerWindowEvent("resize");

      const expected = { x: 260, y: 48, width: 0, height: 352 };
      expect(state.viewSetBounds).toHaveBeenCalledWith(expected);
    });

    it("does not recalculate layout after destroy", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.viewSetBounds.mockClear();

      triggerWindowEvent("resize");
      expect(state.viewSetBounds).not.toHaveBeenCalled();
    });
  });

  // ── Default mode ──

  describe("Default mode", () => {
    it("defaults to agenthubs mode on creation", () => {
      const manager = createDefaultManager();
      expect(manager.getCurrentMode()).toBe("agenthubs");
    });
  });

  // ── switchToMode ──

  describe("switchToMode", () => {
    it("toggles visibility when switching to agent", () => {
      const manager = createDefaultManager();
      state.viewSetVisible.mockClear();

      manager.switchToMode("agent");

      const trueCalls = state.viewSetVisible.mock.calls.filter(
        (c) => c[0] === true
      );
      const falseCalls = state.viewSetVisible.mock.calls.filter(
        (c) => c[0] === false
      );
      expect(trueCalls.length).toBe(1);
      expect(falseCalls.length).toBe(1);
    });

    it("toggles visibility when switching back to agenthubs", () => {
      const manager = createDefaultManager();
      manager.switchToMode("agent");
      state.viewSetVisible.mockClear();

      manager.switchToMode("agenthubs");

      const trueCalls = state.viewSetVisible.mock.calls.filter(
        (c) => c[0] === true
      );
      const falseCalls = state.viewSetVisible.mock.calls.filter(
        (c) => c[0] === false
      );
      expect(trueCalls.length).toBe(1);
      expect(falseCalls.length).toBe(1);
    });

    it("no-ops when switching to current mode", () => {
      const manager = createDefaultManager();
      state.viewSetVisible.mockClear();
      state.windowSend.mockClear();

      manager.switchToMode("agenthubs");

      expect(state.viewSetVisible).not.toHaveBeenCalled();
      expect(state.windowSend).not.toHaveBeenCalled();
    });

    it("no-ops after destroy", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.viewSetVisible.mockClear();

      manager.switchToMode("agent");

      expect(state.viewSetVisible).not.toHaveBeenCalled();
    });

    it("updates getCurrentMode after switch", () => {
      const manager = createDefaultManager();
      expect(manager.getCurrentMode()).toBe("agenthubs");

      manager.switchToMode("agent");
      expect(manager.getCurrentMode()).toBe("agent");

      manager.switchToMode("agenthubs");
      expect(manager.getCurrentMode()).toBe("agenthubs");
    });

    it("sends sidebar:mode-changed to shell on mode switch", () => {
      const manager = createDefaultManager();
      state.windowSend.mockClear();

      manager.switchToMode("agent");

      expect(state.windowSend).toHaveBeenCalledWith(
        "sidebar:mode-changed",
        { mode: "agent" }
      );
    });

    it("does not send sidebar:mode-changed if window is destroyed", () => {
      const manager = createDefaultManager();
      state.windowIsDestroyed.mockReturnValue(true);
      state.windowSend.mockClear();

      manager.switchToMode("agent");

      expect(state.windowSend).not.toHaveBeenCalledWith(
        "sidebar:mode-changed",
        expect.anything()
      );
    });
  });

  // ── IPC: shell:switch-mode ──

  describe("IPC: shell:switch-mode", () => {
    it("switches to agent mode when shell sends IPC", () => {
      const manager = createDefaultManager();
      state.viewSetVisible.mockClear();

      triggerIpcOn("shell:switch-mode", {}, { mode: "agent" });

      const trueCalls = state.viewSetVisible.mock.calls.filter(
        (c) => c[0] === true
      );
      expect(trueCalls.length).toBe(1);
      expect(manager.getCurrentMode()).toBe("agent");
    });

    it("ignores unknown mode strings", () => {
      const manager = createDefaultManager();
      state.viewSetVisible.mockClear();

      triggerIpcOn("shell:switch-mode", {}, { mode: "unknown" });

      expect(state.viewSetVisible).not.toHaveBeenCalled();
      expect(manager.getCurrentMode()).toBe("agenthubs");
    });

    it("ignores IPC after destroy", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.viewSetVisible.mockClear();

      triggerIpcOn("shell:switch-mode", {}, { mode: "agent" });

      expect(state.viewSetVisible).not.toHaveBeenCalled();
    });
  });

  // ── IPC: shell:sign-out ──

  describe("IPC: shell:sign-out", () => {
    it("calls onSignOut callback via IPC", () => {
      const onSignOut = vi.fn();
      createSidebarManager({
        shellHtmlPath: "/app/renderer/shell.html",
        shellPreloadPath: "/app/renderer/shell-preload.js",
        jwtToken: "test-jwt",
        onSignOut,
      });

      triggerIpcOn("shell:sign-out");

      expect(onSignOut).toHaveBeenCalledTimes(1);
    });

    it("ignores IPC after destroy", () => {
      const onSignOut = vi.fn();
      const manager = createSidebarManager({
        shellHtmlPath: "/app/renderer/shell.html",
        shellPreloadPath: "/app/renderer/shell-preload.js",
        jwtToken: "test-jwt",
        onSignOut,
      });
      manager.destroy();

      triggerIpcOn("shell:sign-out");

      expect(onSignOut).not.toHaveBeenCalled();
    });
  });

  // ── IPC: shell:get-token ──

  describe("IPC: shell:get-token", () => {
    it("returns jwtToken via IPC", async () => {
      createDefaultManager();
      const handler = state.ipcHandleHandlers["shell:get-token"];
      expect(handler).toBeDefined();
      const result = await handler!();
      expect(result).toBe("test-jwt-token");
    });

    it("handler is removed after destroy (no longer invocable)", () => {
      const manager = createDefaultManager();
      // Verify handler exists before destroy
      expect(state.ipcHandleHandlers["shell:get-token"]).toBeDefined();
      manager.destroy();
      // Handler is removed during cleanup
      expect(state.ipcHandleHandlers["shell:get-token"]).toBeUndefined();
    });
  });

  // ── IPC: shell:refresh-balance ──

  describe("IPC: shell:refresh-balance", () => {
    it("returns placeholder via IPC", async () => {
      createDefaultManager();
      const handler = state.ipcHandleHandlers["shell:refresh-balance"];
      const result = await handler!();
      expect(result).toBe("Loading...");
    });
  });

  // ── updateOrgInfo ──

  describe("updateOrgInfo", () => {
    it("sends sidebar:org-info with full OrgInfo", () => {
      const manager = createDefaultManager();
      const info = {
        name: "Test Org",
        role: "Owner",
        balance: "100 CPDR",
        email: "test@example.com",
      };
      manager.updateOrgInfo(info);
      expect(state.windowSend).toHaveBeenCalledWith("sidebar:org-info", info);
    });

    it("sends partial OrgInfo", () => {
      const manager = createDefaultManager();
      manager.updateOrgInfo({ name: "New Name" });
      expect(state.windowSend).toHaveBeenCalledWith("sidebar:org-info", {
        name: "New Name",
      });
    });

    it("no-ops after destroy", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.windowSend.mockClear();
      manager.updateOrgInfo({ name: "X" });
      expect(state.windowSend).not.toHaveBeenCalled();
    });

    it("no-ops if window is destroyed", () => {
      const manager = createDefaultManager();
      state.windowIsDestroyed.mockReturnValue(true);
      state.windowSend.mockClear();
      manager.updateOrgInfo({ name: "X" });
      expect(state.windowSend).not.toHaveBeenCalled();
    });
  });

  // ── updateStatus ──

  describe("updateStatus", () => {
    it("sends sidebar:status for agent mode online", () => {
      const manager = createDefaultManager();
      manager.updateStatus("agent", "online");
      expect(state.windowSend).toHaveBeenCalledWith("sidebar:status", {
        mode: "agent",
        status: "online",
      });
    });

    it("sends sidebar:status for agenthubs mode loading", () => {
      const manager = createDefaultManager();
      manager.updateStatus("agenthubs", "loading");
      expect(state.windowSend).toHaveBeenCalledWith("sidebar:status", {
        mode: "agenthubs",
        status: "loading",
      });
    });

    it("sends sidebar:status for agent mode offline", () => {
      const manager = createDefaultManager();
      manager.updateStatus("agent", "offline");
      expect(state.windowSend).toHaveBeenCalledWith("sidebar:status", {
        mode: "agent",
        status: "offline",
      });
    });

    it("no-ops after destroy", () => {
      const manager = createDefaultManager();
      manager.destroy();
      state.windowSend.mockClear();
      manager.updateStatus("agent", "online");
      expect(state.windowSend).not.toHaveBeenCalled();
    });
  });

  // ── getWindow ──

  describe("getWindow", () => {
    it("returns the BrowserWindow instance", () => {
      const manager = createDefaultManager();
      const win = manager.getWindow();
      expect(win).toBeDefined();
      expect(typeof win.isDestroyed).toBe("function");
    });
  });

  // ── destroy ──

  describe("destroy", () => {
    it("removes all IPC listeners", () => {
      const manager = createDefaultManager();
      manager.destroy();
      expect(state.ipcRemovedListeners).toContain("shell:switch-mode");
      expect(state.ipcRemovedListeners).toContain("shell:sign-out");
      expect(state.ipcRemovedHandlers).toContain("shell:get-token");
      expect(state.ipcRemovedHandlers).toContain("shell:refresh-balance");
    });

    it("removes child views from contentView", () => {
      const manager = createDefaultManager();
      manager.destroy();
      expect(state.windowRemoveChildView).toHaveBeenCalledTimes(2);
    });

    it("closes WebContents for both views", () => {
      const manager = createDefaultManager();
      manager.destroy();
      expect(state.viewWebContentsClose).toHaveBeenCalledTimes(2);
    });

    it("closes the BrowserWindow", () => {
      const manager = createDefaultManager();
      manager.destroy();
      expect(state.windowClose).toHaveBeenCalled();
    });

    it("is idempotent (calling destroy twice is safe)", () => {
      const manager = createDefaultManager();
      manager.destroy();
      vi.clearAllMocks();
      expect(() => manager.destroy()).not.toThrow();
      expect(state.windowClose).not.toHaveBeenCalled();
      expect(state.windowRemoveChildView).not.toHaveBeenCalled();
    });

    it("handles destroy when window is already destroyed", () => {
      const manager = createDefaultManager();
      state.windowIsDestroyed.mockReturnValue(true);
      manager.destroy();
      expect(state.windowRemoveChildView).not.toHaveBeenCalled();
      expect(state.ipcRemovedListeners).toContain("shell:switch-mode");
      expect(state.windowClose).not.toHaveBeenCalled();
    });
  });

  // ── Mode change notification on IPC ──

  describe("Mode change notification", () => {
    it("sends sidebar:mode-changed when switching via IPC", () => {
      createDefaultManager();
      state.windowSend.mockClear();

      triggerIpcOn("shell:switch-mode", {}, { mode: "agent" });

      expect(state.windowSend).toHaveBeenCalledWith(
        "sidebar:mode-changed",
        { mode: "agent" }
      );
    });
  });

  // ── Edge case: no duplicate switchToMode on same mode via IPC ──

  describe("IPC duplicate prevention", () => {
    it("does not re-switch when IPC sends same mode", () => {
      const manager = createDefaultManager();
      triggerIpcOn("shell:switch-mode", {}, { mode: "agent" });
      state.viewSetVisible.mockClear();

      triggerIpcOn("shell:switch-mode", {}, { mode: "agent" });

      // No visibility change since already in agent mode
      expect(state.viewSetVisible).not.toHaveBeenCalled();
      expect(manager.getCurrentMode()).toBe("agent");
    });
  });
});
