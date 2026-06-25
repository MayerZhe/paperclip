// apps/desktop/src/main/login-item.ts
// v3 Sprint 2: macOS 开机自启管理 — 封装 app.setLoginItemSettings()

import { app } from "electron";

/**
 * 设置是否开机自启
 * 调用 Electron 原生 API app.setLoginItemSettings()
 * @param enabled - true 开启开机自启，false 关闭
 */
export function setAutoLaunch(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // macOS: 仅在 /Applications 中时生效；开发模式静默跳过
      args: ["--hidden"], // 启动时隐藏窗口（可选）
    });
    console.log(`[SuperNode Desktop] Auto-launch ${enabled ? "enabled" : "disabled"}`);
  } catch (err) {
    console.error("[SuperNode Desktop] Failed to set auto-launch:", err);
  }
}

/**
 * 获取当前开机自启状态
 * @returns 是否开机自启
 */
export function getAutoLaunchState(): boolean {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (err) {
    console.error("[SuperNode Desktop] Failed to get auto-launch state:", err);
    return false;
  }
}
