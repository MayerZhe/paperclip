// apps/desktop/src/main/sidebar-manager.ts
// S-A3: SidebarManager — BrowserWindow + WebContentsView management
//
// Manages:
//   1. A BrowserWindow that loads shell.html (the sidebar shell)
//   2. Two WebContentsView instances (agent mode at :3100, agenthubs mode at :4000)
//   3. Layout calculation (sidebar 260px + content area filling remaining space)
//   4. IPC for switching modes and pushing data to the shell

import {
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
} from "electron";
import path from "node:path";

// ─── 类型定义 ───

export interface OrgInfo {
  name: string;
  role: string;
  balance: string;
  email: string;
}

export interface SidebarManager {
  switchToMode(mode: "agent" | "agenthubs"): void;
  updateOrgInfo(info: Partial<OrgInfo>): void;
  updateStatus(mode: "agent" | "agenthubs", status: "online" | "offline" | "loading"): void;
  getWindow(): BrowserWindow;
  getCurrentMode(): "agent" | "agenthubs";
  destroy(): void;
}

// ─── 常量 ───

const SIDEBAR_WIDTH = 260;
const TITLEBAR_HEIGHT = 48; // macOS hiddenInset titlebar

// Unique IPC listener keys for cleanup
const IPC_CHANNELS = {
  SWITCH_MODE: "shell:switch-mode",
  SIGN_OUT: "shell:sign-out",
  GET_TOKEN: "shell:get-token",
  REFRESH_BALANCE: "shell:refresh-balance",
} as const;

// ─── 实现 ───

export function createSidebarManager(opts: {
  shellHtmlPath: string;
  shellPreloadPath: string;
  jwtToken: string;
  onSignOut: () => void;
}): SidebarManager {
  const { shellHtmlPath, shellPreloadPath, jwtToken, onSignOut } = opts;

  // ─── 内部状态 ───
  let currentMode: "agent" | "agenthubs" = "agenthubs";
  let destroyed = false;

  // ─── 1. IPC handlers (register BEFORE window creation to avoid race conditions) ───

  // shell:switch-mode — user clicked a tab in the sidebar
  ipcMain.on(IPC_CHANNELS.SWITCH_MODE, (_event, payload: { mode: string }) => {
    if (destroyed) return;
    if (payload.mode === "agent" || payload.mode === "agenthubs") {
      switchToModeImpl(payload.mode);
    }
  });

  // shell:sign-out — user clicked sign out in the sidebar
  ipcMain.on(IPC_CHANNELS.SIGN_OUT, () => {
    if (destroyed) return;
    onSignOut();
  });

  // shell:get-token — shell requests the current JWT token (already authenticated)
  ipcMain.handle(IPC_CHANNELS.GET_TOKEN, () => {
    if (destroyed) return null;
    return jwtToken;
  });

  // shell:refresh-balance — placeholder for CPDR balance refresh
  ipcMain.handle(IPC_CHANNELS.REFRESH_BALANCE, () => {
    if (destroyed) return "Loading...";
    return "Loading...";
  });

  // ─── 2. Create main BrowserWindow (sidebar shell) ───

  const isMac = process.platform === "darwin";

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "PaperClip",
    show: false,
    ...(isMac && {
      titleBarStyle: "hiddenInset",
      titleBarOverlay: false,
      vibrancy: "under-window",
      visualEffectState: "active",
      backgroundColor: "#00000000",
      trafficLightPosition: { x: 12, y: 16 },
    }),
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(shellHtmlPath);

  mainWindow.once("ready-to-show", () => {
    if (destroyed) return;
    mainWindow.show();
  });

  // ─── 3. Create WebContentsView for AgentHubs (:4000) ───

  const agenthubsView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: session.fromPartition("persist:agenthubs"),
    },
  });

  agenthubsView.webContents.loadURL("http://127.0.0.1:4000");

  // ─── 4. Create WebContentsView for Agent (:3100) ───

  const agentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "preload", "index.js"),
    },
  });

  agentView.webContents.loadURL("http://127.0.0.1:3100");

  // ─── 5. Add views to main window (both hidden initially) ───

  mainWindow.contentView.addChildView(agenthubsView);
  mainWindow.contentView.addChildView(agentView);

  // Initially both are invisible — first switchToMode call makes one visible
  agenthubsView.setVisible(false);
  agentView.setVisible(false);

  // ─── 6. Layout calculation ───

  function layoutViews(): void {
    if (destroyed) return;

    const [width, height] = mainWindow.getContentSize();

    const contentX = SIDEBAR_WIDTH;
    const contentY = TITLEBAR_HEIGHT;
    const contentWidth = Math.max(0, width - SIDEBAR_WIDTH);
    const contentHeight = Math.max(0, height - TITLEBAR_HEIGHT);

    const contentBounds = {
      x: contentX,
      y: contentY,
      width: contentWidth,
      height: contentHeight,
    };

    agenthubsView.setBounds(contentBounds);
    agentView.setBounds(contentBounds);
  }

  mainWindow.on("resize", layoutViews);

  // Initial layout after window is shown
  mainWindow.once("show", () => {
    layoutViews();
  });

  // ─── 7. switchToMode implementation ───

  function switchToModeImpl(mode: "agent" | "agenthubs"): void {
    if (destroyed || currentMode === mode) return;

    if (mode === "agent") {
      agentView.setVisible(true);
      agenthubsView.setVisible(false);
    } else {
      agenthubsView.setVisible(true);
      agentView.setVisible(false);
    }

    currentMode = mode;

    // Notify sidebar shell of mode change
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sidebar:mode-changed", { mode });
    }
  }

  // ─── 8. updateOrgInfo ───

  function updateOrgInfoImpl(info: Partial<OrgInfo>): void {
    if (destroyed || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("sidebar:org-info", info);
  }

  // ─── 9. updateStatus ───

  function updateStatusImpl(
    mode: "agent" | "agenthubs",
    status: "online" | "offline" | "loading",
  ): void {
    if (destroyed || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("sidebar:status", { mode, status });
  }

  // ─── 10. destroy ───

  function destroyImpl(): void {
    if (destroyed) return;
    destroyed = true;

    // Remove IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.SWITCH_MODE);
    ipcMain.removeAllListeners(IPC_CHANNELS.SIGN_OUT);
    ipcMain.removeHandler(IPC_CHANNELS.GET_TOKEN);
    ipcMain.removeHandler(IPC_CHANNELS.REFRESH_BALANCE);

    // Remove views
    if (!mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(agenthubsView);
      mainWindow.contentView.removeChildView(agentView);
    }

    // Close WebContents (frees resources)
    agenthubsView.webContents.close();
    agentView.webContents.close();

    // Close window
    if (!mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  }

  // Activate default mode (agenthubs visible on startup)
  switchToModeImpl("agenthubs");

  // ─── Return public API ───

  return {
    switchToMode: switchToModeImpl,
    updateOrgInfo: updateOrgInfoImpl,
    updateStatus: updateStatusImpl,
    getWindow: () => mainWindow,
    getCurrentMode: () => currentMode,
    destroy: destroyImpl,
  };
}
