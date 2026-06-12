// apps/desktop/src/main/context-menu.ts
// macOS native context menu bridge
// ADR-06 compliant: carries ONLY UI affordance data (menu labels + actions) — no business data
// Per spec: specs/001-macos-native-chrome/contracts/preload-bridge.md

import { ipcMain, Menu, BrowserWindow, clipboard, dialog, type MenuItemConstructorOptions } from "electron";

export interface ContextMenuItem {
  label: string;
  action?: string;
  enabled?: boolean;
  separator?: boolean;
}

export interface OpenDialogOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export function registerContextMenuHandler(): void {
  // ═══════════════════════════════════════
  // Native context menu (right-click / Control-click)
  // ═══════════════════════════════════════
  ipcMain.on("paperclip:context-menu", (_event, items: ContextMenuItem[]) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;

    const template: MenuItemConstructorOptions[] = items.map((item) => ({
      label: item.label,
      enabled: item.enabled !== false,
      type: item.separator ? "separator" : "normal",
      click: () => dispatchContextAction(item.action, win),
    }));

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win });
  });

  // ═══════════════════════════════════════
  // File open dialog (async request/response)
  // ═══════════════════════════════════════
  ipcMain.handle("paperclip:open-dialog", async (_event, options: OpenDialogOptions): Promise<OpenDialogResult> => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(win, {
      title: options.title,
      filters: options.filters,
      properties: options.properties,
    });

    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  });
}

function dispatchContextAction(action: string | undefined, win: Electron.BrowserWindow): void {
  switch (action) {
    case "cut":
      win.webContents.cut();
      break;
    case "copy":
      win.webContents.copy();
      break;
    case "paste":
      win.webContents.paste();
      break;
    case "selectAll":
      win.webContents.selectAll();
      break;
    case "newTask":
      // Navigate to new task — dispatch via webContents to renderer
      win.webContents.send("paperclip:action", "newTask");
      break;
    case "newProject":
      win.webContents.send("paperclip:action", "newProject");
      break;
    default:
      break;
  }
}
