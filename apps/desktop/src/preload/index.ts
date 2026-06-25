// apps/desktop/src/preload/index.ts
// v3.2: Preload bridge — native UI affordances (context menus, file dialogs)
// ADR-06 compliant: carries ONLY UI affordance data, NO business data
// Per spec: specs/001-macos-native-chrome/contracts/preload-bridge.md

import { contextBridge, ipcRenderer } from "electron";

interface ContextMenuItem {
  label: string;
  action?: string;
  enabled?: boolean;
  separator?: boolean;
}

interface OpenDialogOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
}

interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

contextBridge.exposeInMainWorld("paperclip", {
  platform: process.platform,
  version: process.env.PAPERCLIP_DESKTOP_VERSION || "0.3.1",

  // Native context menu — replaces browser default right-click menu (US3)
  showContextMenu: (items: ContextMenuItem[]) => {
    ipcRenderer.send("paperclip:context-menu", items);
  },

  // Native file open dialog (US3)
  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> => {
    return ipcRenderer.invoke("paperclip:open-dialog", options);
  },

  // Story 3.3: Agent → AgentHubs data bridge
  exportAgent: (data: {
    name: string;
    description: string;
    adapterType: string;
    adapterConfig: Record<string, string | number | boolean>;
    skills: string[];
    exportedAt: string;
  }): Promise<{ success: boolean; filePath: string }> => {
    return ipcRenderer.invoke("file-bridge:export-agent", data);
  },

  // CLI scan — returns results from main process scanCliAvailability()
  getCliScan: () => ipcRenderer.invoke("paperclip:get-cli-scan"),

  // Install a CLI tool — main process execs the install command
  installCli: (adapterType: string) => ipcRenderer.invoke("paperclip:install-cli", { adapterType }),

  // ── Mode sync ──
  /** React tab 切换 → Electron main process 更新 tray/menu */
  switchMode: (mode: "agent" | "agenthubs") =>
    ipcRenderer.send("paperclip:mode-changed", mode),

  /** UI 初始化时获取上次保存的 mode */
  getInitialMode: (): Promise<"agent" | "agenthubs"> =>
    ipcRenderer.invoke("paperclip:get-initial-mode"),

  // ── Auth ──
  /** Sign out → Electron 清除 session + 重新显示登录窗口 */
  signOut: () => ipcRenderer.send("paperclip:sign-out"),

  // ── AgentHubs health ──
  /** 轮询 AgentHubs 服务健康状态 */
  getAgentHubsHealth: (): Promise<{
    cloudApi: boolean;
    paperclip: boolean;
    minio: boolean;
  }> => ipcRenderer.invoke("paperclip:agenthubs-health"),

  // ── VM status ──
  /** VM download progress events (main→renderer push) */
  onVmDownloadProgress: (cb: (progress: {
    percent: number;
    downloadedMB: number;
    totalMB: number;
    stage: string;
  }) => void) => {
    const handler = (_event: any, progress: any) => cb(progress);
    ipcRenderer.on("paperclip:vm-download-progress", handler);
    return () => {
      ipcRenderer.removeListener("paperclip:vm-download-progress", handler);
    };
  },

  /** Check if VM bundle is ready */
  isVmReady: (): Promise<boolean> =>
    ipcRenderer.invoke("paperclip:vm-status"),
});
