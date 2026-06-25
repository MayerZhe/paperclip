// apps/desktop/src/main/window-state.ts
// v3 Sprint 2: 窗口位置/大小持久化到 ~/.paperclip/desktop-state.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { type BrowserWindow } from "electron";

/** 窗口状态数据 */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const STATE_FILE = path.resolve(os.homedir(), ".paperclip", "desktop-state.json");

const DEFAULT_STATE: WindowState = {
  x: -1, // -1 表示未保存（使用默认位置）
  y: -1,
  width: 1280,
  height: 860,
  isMaximized: false,
};

/**
 * 从文件加载窗口状态
 * @returns 保存的窗口状态，如果文件不存在或读取失败则返回默认值
 */
export function loadWindowState(): WindowState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE };
    }
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;

    // 验证并合并默认值
    const state: WindowState = {
      x: typeof parsed.x === "number" ? parsed.x : DEFAULT_STATE.x,
      y: typeof parsed.y === "number" ? parsed.y : DEFAULT_STATE.y,
      width: typeof parsed.width === "number" ? parsed.width : DEFAULT_STATE.width,
      height: typeof parsed.height === "number" ? parsed.height : DEFAULT_STATE.height,
      isMaximized: typeof parsed.isMaximized === "boolean" ? parsed.isMaximized : DEFAULT_STATE.isMaximized,
    };

    // 合理性检查：窗口坐标应在屏幕范围内
    if (state.x < -1920 || state.x > 7680) state.x = DEFAULT_STATE.x;
    if (state.y < -1080 || state.y > 4320) state.y = DEFAULT_STATE.y;
    if (state.width < 400) state.width = DEFAULT_STATE.width;
    if (state.height < 300) state.height = DEFAULT_STATE.height;

    return state;
  } catch (err) {
    console.error("[SuperNode Desktop] Failed to load window state:", err);
    return { ...DEFAULT_STATE };
  }
}

/**
 * 保存窗口状态到文件
 * @param win - BrowserWindow 实例
 */
export function saveWindowState(win: BrowserWindow): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const isMaximized = win.isMaximized();
    // 非最大化时保存实际位置和大小
    const bounds = win.getBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[SuperNode Desktop] Failed to save window state:", err);
  }
}

/**
 * 注册窗口状态持久化事件
 * 在 'close' 事件时保存，启动时通过 loadWindowState() 恢复
 * @param win - BrowserWindow 实例
 * @returns 清理函数（移除事件监听）
 */
export function registerWindowStateHandlers(win: BrowserWindow): () => void {
  const onClose = () => {
    saveWindowState(win);
  };

  win.on("close", onClose);

  return () => {
    win.removeListener("close", onClose);
  };
}
