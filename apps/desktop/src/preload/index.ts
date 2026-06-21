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
});
