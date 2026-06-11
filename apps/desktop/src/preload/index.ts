// apps/desktop/src/preload/index.ts
// v3.1: 极简 preload — 不暴露 ipcRenderer（ADR-06: 不加 Electron IPC）
// 仅桥接主进程的 one-shot 数据到渲染进程
// 版本号由主进程通过环境变量注入

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("paperclip", {
  platform: process.platform,
  version: process.env.PAPERCLIP_DESKTOP_VERSION || "0.3.1",
});
