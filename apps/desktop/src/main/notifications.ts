// apps/desktop/src/main/notifications.ts
// v3 Sprint 2: 增强通知 — 与 daemon 状态变化联动、支持 sidecar NOTIFY

import { Notification } from "electron";

/** 通知级别 */
export type NotificationLevel = "info" | "warning" | "error";

/** 通知选项 */
export interface ShowNotificationOptions {
  title: string;
  body: string;
  /** 通知级别（影响 macOS 上的通知样式） */
  level?: NotificationLevel;
  /** 是否静默（不播放声音） */
  silent?: boolean;
}

/**
 * 弹出原生通知
 * @param title - 通知标题
 * @param body - 通知正文
 */
export function showNotification(title: string, body: string): void {
  try {
    const notification = new Notification({ title, body });
    notification.show();
  } catch (err) {
    console.error("[PaperClip Desktop] Notification failed:", err);
  }
}

/**
 * 弹出高级原生通知（支持级别和静默模式）
 * @param options - 通知选项
 */
export function showAdvancedNotification(options: ShowNotificationOptions): void {
  try {
    const urgencyMap: Record<NotificationLevel, "critical" | "normal" | "low"> = {
      error: "critical",
      warning: "normal",
      info: "low",
    };

    const notification = new Notification({
      title: options.title,
      body: options.body,
      urgency: urgencyMap[options.level ?? "info"],
      silent: options.silent ?? false,
    });
    notification.show();
  } catch (err) {
    console.error("[PaperClip Desktop] Advanced notification failed:", err);
  }
}

/**
 * 在 daemon 状态变化时弹出通知
 * 由托盘轮询检测到状态变化时调用
 * @param previousHealth - 上一个健康状态
 * @param nextHealth - 新健康状态
 */
export function notifyDaemonStatusChange(
  previousHealth: string,
  nextHealth: string,
): void {
  try {
    if (nextHealth === "shuttingDown" && previousHealth === "running") {
      showAdvancedNotification({
        title: "PaperClip is shutting down",
        body: "The daemon is shutting down gracefully. Please wait...",
        level: "warning",
      });
    } else if (nextHealth === "unreachable" && previousHealth === "running") {
      showAdvancedNotification({
        title: "PaperClip daemon unreachable",
        body: "Connection to PaperClip daemon was lost. Check if the server is still running.",
        level: "error",
      });
    } else if (nextHealth === "running" && previousHealth !== "running") {
      showAdvancedNotification({
        title: "PaperClip daemon connected",
        body: "PaperClip daemon is now running and healthy.",
        level: "info",
        silent: true,
      });
    }
  } catch (err) {
    console.error("[PaperClip Desktop] Status change notification failed:", err);
  }
}
