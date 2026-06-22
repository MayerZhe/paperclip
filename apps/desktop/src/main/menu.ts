// apps/desktop/src/main/menu.ts
// v3 Sprint 2: 增强诊断报告（daemon 状态、CLI 扫描结果、内存、env）+ Launch at Login toggle
// v3.1 Story 1.5: Mode 子菜单 + 全局快捷键 Cmd+Shift+M 模式切换

import { Menu, dialog, type BrowserWindow } from "electron";
import fs from "node:fs";
import { setAutoLaunch, getAutoLaunchState } from "./login-item.js";

/** 启动模式类型 */
export type MenuMode = "agent" | "agenthubs";

/** 菜单创建选项 */
export interface MenuOptions {
  /** 当前启动模式 */
  mode?: MenuMode;
  /** 模式切换回调 */
  onSwitchMode?: () => void;
}

/** 菜单创建所需的外部数据 */
export interface MenuDataProvider {
  /** Daemon 健康状态 */
  daemonHealth: string;
  /** CLI 扫描结果摘要 */
  cliScanSummary?: string[];
  /** 服务器端口 */
  serverPort: number;
}

/** 当前菜单数据提供者（在 createAppMenu 调用时设置） */
let dataProvider: MenuDataProvider = {
  daemonHealth: "unknown",
  cliScanSummary: [],
  serverPort: 3100,
};

/** 当前菜单选项 */
let menuOpts: MenuOptions = {};

/**
 * 设置菜单数据（在 daemon 状态变化或 CLI 扫描完成时更新）
 * @param data - 更新的数据字段
 */
export function updateMenuData(data: Partial<MenuDataProvider>): void {
  dataProvider = { ...dataProvider, ...data };
}

/**
 * 收集完整诊断信息
 * Daemon 状态通过 HTTP 实时获取，其余来自本地系统
 * @param serverPort - Daemon HTTP 端口
 * @returns 诊断数据对象
 */
async function collectDiagnostics(serverPort: number): Promise<Record<string, unknown>> {
  // 尝试获取 daemon 状态
  let daemonStatus: Record<string, unknown> = { error: "unreachable" };
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/desktop/status`);
    if (res.ok) {
      daemonStatus = (await res.json()) as Record<string, unknown>;
    }
  } catch {
    // daemon unreachable — use fallback
  }

  // 收集环境变量（仅 PAPERCLIP_* 前缀，过滤敏感信息）
  const paperclipEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PAPERCLIP_") && value !== undefined) {
      // 不暴露完整路径中的用户名
      paperclipEnv[key] = value.replace(process.env.HOME ?? "", "~");
    }
  }

  // 内存使用
  const memUsage = process.memoryUsage();

  return {
    version: "0.3.1",
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? "unknown",
    daemonStatus,
    cliScan: dataProvider.cliScanSummary ?? [],
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)} MB`,
    },
    env: paperclipEnv,
    paperclipHome: (process.env.PAPERCLIP_HOME ?? "unknown").replace(process.env.HOME ?? "", "~"),
    timestamp: new Date().toISOString(),
  };
}

/** 导出诊断信息的共享处理函数 */
async function handleExportDiagnostics(serverPort: number): Promise<void> {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: `paperclip-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!filePath) return;

  try {
    const diag = await collectDiagnostics(serverPort);
    fs.writeFileSync(filePath, JSON.stringify(diag, null, 2));
    dialog.showMessageBox({ message: `Diagnostics saved to ${filePath}` });
  } catch (err) {
    console.error("[PaperClip Desktop] Failed to export diagnostics:", err);
    dialog.showErrorBox("Export Failed", `Could not save diagnostics: ${err}`);
  }
}

/**
 * 创建应用菜单（含诊断增强 + Launch at Login toggle + Mode 子菜单）
 * @param mainWindow - 主 BrowserWindow
 * @param serverPort - Daemon HTTP 端口
 * @param cliScanSummary - CLI 扫描结果摘要（可选）
 * @param opts - 可选参数 { mode, onSwitchMode }
 */
export function createAppMenu(
  mainWindow: BrowserWindow,
  serverPort?: number,
  cliScanSummary?: string[],
  opts?: MenuOptions,
): void {
  const port = serverPort ?? 3100;
  const isMac = process.platform === "darwin";

  // 保存菜单选项引用
  menuOpts = opts ?? {};
  const currentMode = menuOpts.mode ?? "agent";

  // 更新菜单数据
  updateMenuData({
    serverPort: port,
    cliScanSummary: cliScanSummary ?? [],
  });

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "PaperClip",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Export Diagnostics",
          accelerator: "CmdOrCtrl+Shift+D",
          click: async () => {
            await handleExportDiagnostics(port);
          },
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
        { type: "separator" },
        {
          label: "Launch at Login",
          type: "checkbox",
          checked: getAutoLaunchState(),
          click: (menuItem) => {
            setAutoLaunch(menuItem.checked);
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    // ── Mode 子菜单（Story 1.5） ──
    {
      label: "Mode",
      submenu: [
        {
          label: "Agent Mode",
          type: "radio",
          checked: currentMode === "agent",
          click: () => {
            if (menuOpts.mode !== "agent") {
              menuOpts.onSwitchMode?.();
            }
          },
        },
        {
          label: "AgentHubs Mode",
          type: "radio",
          checked: currentMode === "agenthubs",
          click: () => {
            if (menuOpts.mode !== "agenthubs") {
              menuOpts.onSwitchMode?.();
            }
          },
        },
        { type: "separator" },
        {
          label: "Switch Mode",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => {
            menuOpts.onSwitchMode?.();
          },
        },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Export Diagnostics",
          click: async () => {
            await handleExportDiagnostics(port);
          },
        },
        {
          label: "Check for Updates",
          click: () => {
            // 通知渲染进程触发更新检查
            mainWindow.webContents.send("paperclip:check-update");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * 更新菜单模式（供模式管理器调用）
 * 重建应用菜单以更新 Mode 子菜单的 checked 状态
 * 注意：会重新设置整个应用菜单，保留所有现有参数
 * @param mode - 新模式
 * @param mainWindow - 主 BrowserWindow（用于保留现有菜单参数）
 */
export function updateMenuMode(mode: MenuMode, mainWindow: BrowserWindow): void {
  menuOpts = { ...menuOpts, mode };
  createAppMenu(
    mainWindow,
    dataProvider.serverPort,
    dataProvider.cliScanSummary,
    menuOpts,
  );
}
