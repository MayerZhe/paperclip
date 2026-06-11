// apps/desktop/src/main/updater.ts
// v3 Sprint 2: 完整 electron-updater 实现
// 连接 GitHub Releases，处理 update-available/downloaded/error 事件

// electron-updater is a CommonJS module — must use default import, not named import
import electronUpdater from "electron-updater";
import type { UpdateCheckResult } from "electron-updater";
const { autoUpdater } = electronUpdater;
import { dialog, type BrowserWindow } from "electron";

/** 更新检查配置 */
export interface UpdaterConfig {
  /** GitHub Releases 仓库 (owner/repo) */
  repo: string;
  /** 是否启用自动下载 */
  autoDownload: boolean;
  /** 下载进度回调 */
  onDownloadProgress?: (percent: number) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
}

/** 默认上游仓库 — 可通过 PAPERCLIP_UPDATE_REPO 环境变量覆盖 */
const DEFAULT_UPDATE_REPO = "paperclipai/paperclip";

/**
 * 创建自动更新管理器
 * @param version - 当前应用版本
 * @param mainWindow - BrowserWindow（用于显示更新对话框）
 * @param config - 可选的更新配置
 * @returns Updater 实例
 */
export function createUpdater(
  version: string,
  mainWindow?: BrowserWindow,
  config?: Partial<UpdaterConfig>,
): Updater {
  const repo = process.env.PAPERCLIP_UPDATE_REPO ?? DEFAULT_UPDATE_REPO;
  const autoDownload = config?.autoDownload ?? true;
  const currentVersion = version;

  try {
    // 配置 electron-updater 的 GitHub Releases 源
    autoUpdater.setFeedURL({
      provider: "github",
      repo: repo.split("/")[1] ?? "paperclip",
      owner: repo.split("/")[0] ?? "paperclipai",
    });

    autoUpdater.autoDownload = autoDownload;
    autoUpdater.autoInstallOnAppQuit = true;
    // currentVersion is a read-only getter from electron-updater
    // — it sources from app.getVersion() which reads package.json

    // ─── 事件监听 ───

    autoUpdater.on("checking-for-update", () => {
      console.log("[PaperClip Desktop] Checking for updates...");
    });

    autoUpdater.on("update-available", (info) => {
      console.log(`[PaperClip Desktop] Update available: ${info.version}`);
      if (mainWindow) {
        mainWindow.webContents.send("paperclip:update-available", info.version);
      }
    });

    autoUpdater.on("update-not-available", () => {
      console.log("[PaperClip Desktop] No update available");
    });

    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.round(progress.percent);
      console.log(`[PaperClip Desktop] Download progress: ${percent}%`);
      config?.onDownloadProgress?.(percent);
      if (mainWindow) {
        mainWindow.webContents.send("paperclip:update-download-progress", percent);
      }
    });

    autoUpdater.on("update-downloaded", () => {
      console.log("[PaperClip Desktop] Update downloaded — prompting to restart");
      if (mainWindow) {
        dialog
          .showMessageBox({
            type: "info",
            title: "Update Ready",
            message: "A new version has been downloaded.",
            detail: "Click Restart to install the update now.",
            buttons: ["Restart", "Later"],
            defaultId: 0,
          })
          .then(({ response }) => {
            if (response === 0) {
              autoUpdater.quitAndInstall();
            }
          })
          .catch((err) => {
            console.error("[PaperClip Desktop] Failed to show update dialog:", err);
          });
      }
    });

    autoUpdater.on("error", (error) => {
      console.error("[PaperClip Desktop] Update error:", error.message);
      config?.onError?.(error);
    });
  } catch (err) {
    console.error("[PaperClip Desktop] Failed to initialize autoUpdater:", err);
  }

  return {
    /**
     * 检查更新
     * 自动下载（autoDownload=true 时），下载完成后提示重启
     */
    checkForUpdates(): void {
      try {
        void autoUpdater.checkForUpdates().catch((err) => {
          console.error("[PaperClip Desktop] Update check failed:", err.message);
          if (mainWindow) {
            dialog
              .showMessageBox({
                type: "error",
                title: "Update Check Failed",
                message: "Could not check for updates.",
                detail: err.message,
                buttons: ["OK"],
              })
              .catch(() => {});
          }
        });
      } catch (err) {
        console.error("[PaperClip Desktop] Update check threw:", err);
      }
    },

    /**
     * 获取当前版本
     */
    getCurrentVersion(): string {
      return currentVersion;
    },
  };
}

/** Updater 公共接口 */
export interface Updater {
  /** 检查更新（自动下载并提示安装） */
  checkForUpdates(): void;
  /** 获取当前应用版本 */
  getCurrentVersion(): string;
}
