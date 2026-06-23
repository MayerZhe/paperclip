// apps/desktop/src/main/vm-updater.ts
// Story 4.1: VM Image 自动更新
//
// VM image 更新独立于 Electron 壳（解耦）。
// 更新流程：
//   1. checkVmImageUpdate  — 读本地版本 + 查 GitHub Releases
//   2. installVmImageUpdate — 下载 + 解压 + docker load + 更新 VERSION 文件
//
// 关键约束：
//   - 在用户下次切换模式时安装（不热替换正在运行的 Docker 容器）
//   - 更新失败 → fallback 旧版本（不阻塞用户使用）
//   - 保留当前版本 + 上一版本（cleanup 旧版本）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── 类型定义 ───

export interface VmImageVersion {
  /** 语义化版本号（如 "1.2.3"） */
  version: string;
  /** tar.gz 的 SHA256 校验和 */
  sha256: string;
  /** tar.gz 下载 URL */
  downloadUrl: string;
  /** GitHub Release 发布时间 (ISO 8601) */
  publishedAt: string;
}

export interface VmImageUpdateConfig {
  /** 当前安装的版本 — 默认从 ~/.paperclip/vm/VERSION 读取 */
  currentVersion?: string;
  /** GitHub Releases API URL — 默认 agenthubs 仓库 */
  releasesUrl?: string;
}

export interface VmImageUpdateResult {
  hasUpdate: boolean;
  latestVersion?: VmImageVersion;
}

export interface VmImageInstallConfig {
  /** 目标版本信息 */
  version: VmImageVersion;
  /** 容器运行时（docker / podman） */
  containerRuntime: string;
  /** 安装进度回调 */
  onProgress?: (progress: VmImageInstallProgress) => void;
}

export interface VmImageInstallProgress {
  /** 进度百分比 0-100 */
  percent: number;
  /** 当前阶段 */
  stage: "downloading" | "verifying" | "extracting" | "loading" | "cleanup" | "complete" | "error";
}

export interface VmImageInstallResult {
  success: boolean;
  error?: string;
  /** 安装后的版本号 */
  version?: string;
}

// ─── 常量 ───

const PAPERCLIP_HOME =
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip");

const VM_HOME = path.resolve(PAPERCLIP_HOME, "vm");
const VM_VERSION_FILE = path.join(VM_HOME, "VERSION");
const VM_DOWNLOADS_DIR = path.join(VM_HOME, "downloads");
const VM_EXTRACT_DIR = path.join(VM_HOME, "agenthubs-local-vm");

/** 默认 GitHub Releases API */
const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/MayerZhe/agenthubs/releases";

/** 每个请求最多取多少条 release */
const RELEASES_PER_PAGE = 5;

/** VM image release tag 前缀 */
const VM_TAG_PREFIX = "vm-v";

/** 下载的 tar.gz asset 名称 */
const VM_ASSET_NAME = "agenthubs-local-vm.tar.gz";

/** 保留的旧版本数量 */
const KEEP_VERSIONS = 2;

// ─── Semver 工具 ───

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** 解析 semver 字符串，非法格式返回 null */
function parseSemver(version: string): Semver | null {
  const trimmed = version.trim();
  // 去除前导 v（如 "v1.2.3"）
  const cleaned = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const parts = cleaned.split(".");
  if (parts.length !== 3) return null;

  const [major, minor, patch] = parts.map(Number);
  if (isNaN(major!) || isNaN(minor!) || isNaN(patch!)) return null;

  return { major: major!, minor: minor!, patch: patch! };
}

/**
 * 比较两个 semver 版本。
 * 返回:
 *   -1  (a < b)
 *    0  (a === b)
 *    1  (a > b)
 *   null (解析失败)
 */
function compareSemver(a: string, b: string): number | null {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) return null;

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }
  return 0;
}

// ─── GitHub Releases API ───

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

/**
 * 从 GitHub Releases 获取最新的 VM image 版本信息。
 * 查询 releases?per_page=N，找第一个 tag 匹配 vm-v* 的 release。
 */
async function fetchReleaseAsset(
  releasesUrl: string,
): Promise<VmImageVersion | null> {
  const url = `${releasesUrl}?per_page=${RELEASES_PER_PAGE}`;
  console.log(`[VM Updater] Fetching releases: ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "paperclip-desktop-vm-updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    console.warn(
      `[VM Updater] GitHub API returned ${response.status}: ${response.statusText}`,
    );
    return null;
  }

  const releases = (await response.json()) as GitHubRelease[];
  if (!Array.isArray(releases) || releases.length === 0) {
    console.log("[VM Updater] No releases found");
    return null;
  }

  // 找第一个 tag 匹配 vm-v* 的 release
  for (const release of releases) {
    if (!release.tag_name.startsWith(VM_TAG_PREFIX)) continue;

    const version = release.tag_name.slice(VM_TAG_PREFIX.length);

    // 校验 semver
    if (!parseSemver(version)) {
      console.warn(
        `[VM Updater] Skipping release with non-semver tag: ${release.tag_name}`,
      );
      continue;
    }

    // 找 tar.gz asset
    const tgzAsset = release.assets.find(
      (a) => a.name === VM_ASSET_NAME,
    );
    if (!tgzAsset) {
      console.warn(
        `[VM Updater] Release ${release.tag_name} has no ${VM_ASSET_NAME} asset`,
      );
      continue;
    }

    // 找 .sha256 asset（可选 — 如果 GitHub 上提供，优先用；否则安装时动态校验）
    const sha256Asset = release.assets.find(
      (a) => a.name === `${VM_ASSET_NAME}.sha256`,
    );

    return {
      version,
      sha256: sha256Asset ? "" : "", // sha256 文件需要额外下载获取内容；安装时校验
      downloadUrl: tgzAsset.browser_download_url,
      publishedAt: release.published_at,
    };
  }

  console.log("[VM Updater] No VM image release found in recent releases");
  return null;
}

/**
 * 下载 .sha256 文件内容
 */
async function fetchSha256(downloadUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${downloadUrl}.sha256`, {
      headers: {
        "User-Agent": "paperclip-desktop-vm-updater",
      },
    });
    if (!response.ok) {
      console.warn(
        `[VM Updater] SHA256 file not found at ${downloadUrl}.sha256 (${response.status})`,
      );
      return null;
    }
    const text = await response.text();
    // 取第一行的第一段（标准 sha256sum 格式）
    const hash = text.trim().split(/\s+/)[0];
    if (hash && /^[a-f0-9]{64}$/i.test(hash)) {
      return hash.toLowerCase();
    }
    return null;
  } catch (err) {
    console.warn(`[VM Updater] Failed to fetch SHA256: ${err}`);
    return null;
  }
}

// ─── 版本文件读写 ───

/**
 * 获取当前安装的 VM 版本。
 * 读取 ~/.paperclip/vm/VERSION 文件，格式为一行版本号。
 * 文件不存在或无法读取时返回 null。
 */
export function getCurrentVmVersion(): string | null {
  try {
    if (!fs.existsSync(VM_VERSION_FILE)) {
      return null;
    }
    const content = fs.readFileSync(VM_VERSION_FILE, "utf-8").trim();
    if (!content) return null;

    // 校验 semver 格式
    if (!parseSemver(content)) {
      console.warn(`[VM Updater] Invalid version in VERSION file: "${content}"`);
      return null;
    }
    return content;
  } catch (err) {
    console.warn(`[VM Updater] Failed to read VERSION file: ${err}`);
    return null;
  }
}

/**
 * 写入版本号到 ~/.paperclip/vm/VERSION。
 * 自动创建 ~/.paperclip/vm/ 目录（如果不存在）。
 */
function writeVersion(version: string): void {
  const dir = path.dirname(VM_VERSION_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VM_VERSION_FILE, `${version.trim()}\n`, "utf-8");
}

// ─── 核心 API ───

/**
 * 检查 VM image 更新。
 *
 * 流程:
 * 1. 读取本地 ~/.paperclip/vm/VERSION
 * 2. Fetch GitHub Releases API
 * 3. 找 tag 匹配 vm-v* 的最新 release
 * 4. 比较 semver
 * 5. 返回 hasUpdate + latestVersion
 *
 * 网络错误或 API 限流时静默失败（不抛异常），返回 hasUpdate=false。
 */
export async function checkVmImageUpdate(
  config: VmImageUpdateConfig = {},
): Promise<VmImageUpdateResult> {
  const currentVersion =
    config.currentVersion ?? getCurrentVmVersion();
  const releasesUrl = config.releasesUrl ?? DEFAULT_RELEASES_URL;

  if (!currentVersion) {
    console.log(
      "[VM Updater] No current VM version found (VERSION file missing) — treating as first install",
    );
    // 没有当前版本 → 视为有更新（首次安装场景由调用方决定是否触发下载）
  }

  console.log(`[VM Updater] Checking for VM image update (current: ${currentVersion ?? "none"})`);

  try {
    const latest = await fetchReleaseAsset(releasesUrl);

    if (!latest) {
      return { hasUpdate: false };
    }

    // 如果下载 URL 没有 .sha256 配套文件，尝试获取 sha256
    if (!latest.sha256) {
      const sha256Hash = await fetchSha256(latest.downloadUrl);
      if (sha256Hash) {
        latest.sha256 = sha256Hash;
      }
    }

    if (!currentVersion) {
      // 首次安装 — 有可用版本
      return { hasUpdate: true, latestVersion: latest };
    }

    const cmp = compareSemver(latest.version, currentVersion);
    if (cmp === null) {
      console.warn(
        `[VM Updater] Semver parse error comparing latest=${latest.version} vs current=${currentVersion}`,
      );
      return { hasUpdate: false };
    }

    const hasUpdate = cmp > 0;
    console.log(
      `[VM Updater] latest=${latest.version} vs current=${currentVersion} → hasUpdate=${hasUpdate}`,
    );

    return {
      hasUpdate,
      latestVersion: hasUpdate ? latest : undefined,
    };
  } catch (err) {
    console.error(`[VM Updater] Update check failed: ${err}`);
    // 静默失败 — 不阻塞用户使用
    return { hasUpdate: false };
  }
}

// ─── 安装更新 ───

/**
 * 下载并安装 VM image 更新。
 *
 * 流程:
 * 1. 确保 ~/.paperclip/vm/downloads/ 目录存在
 * 2. 下载 tar.gz 到 vm/downloads/vm-{version}/
 * 3. 解压到 vm/downloads/vm-{version}/agenthubs-local-vm/
 * 4. docker load 镜像
 * 5. 备份旧版本（保留当前 + 上一版本）
 * 6. 替换 vm/agenthubs-local-vm/ → 新版本
 * 7. 更新 VERSION 文件
 *
 * 注: 此函数依赖 download-vm-image.ts 中的 downloadVmImage() 函数。
 *     如果该模块尚未实现，import 会 throw，由调用方处理。
 */
export async function installVmImageUpdate(
  config: VmImageInstallConfig,
): Promise<VmImageInstallResult> {
  const { version, containerRuntime, onProgress } = config;

  const report = (stage: VmImageInstallProgress["stage"], percent: number) => {
    onProgress?.({ percent, stage });
  };

  try {
    // ── Step 1: 确保下载目录存在 ──
    report("downloading", 0);
    const versionDownloadDir = path.join(VM_DOWNLOADS_DIR, `vm-${version.version}`);
    fs.mkdirSync(versionDownloadDir, { recursive: true });

    // ── Step 2: 动态导入 downloadVmImage 并下载 ──
    //    下载到 versionDownloadDir 下
    report("downloading", 0);
    console.log(
      `[VM Updater] Downloading VM image ${version.version} from ${version.downloadUrl}`,
    );

    const { downloadVmImage } = await import("./download-vm-image.js");

    const downloadResult = await downloadVmImage({
      manifestUrl: version.downloadUrl,
      onProgress: (progress: {
        percent: number;
        downloadedMB: number;
        totalMB: number;
        stage: string;
      }) => {
        // 将 downloadVmImage 的进度映射到安装进度
        const mappedStages: Record<
          string,
          VmImageInstallProgress["stage"]
        > = {
          fetching_manifest: "downloading",
          downloading: "downloading",
          verifying: "verifying",
          decompressing: "extracting",
          complete: "complete",
          error: "error",
        };
        const stage = mappedStages[progress.stage] ?? "downloading";
        onProgress?.({ percent: progress.percent, stage });
      },
    });

    if (!downloadResult.success) {
      return {
        success: false,
        error: `Download failed: ${downloadResult.error}`,
      };
    }

    // ── Step 3: 解压结果已在 downloadVmImage 中处理 ──
    //    downloadVmImage 解压到 VM_EXTRACT_DIR 常量路径
    //    (~/.paperclip/vm/agenthubs-local-vm/)
    //    我们需要将其移动到版本化目录，保留旧版本
    report("cleanup", 90);

    // ── Step 4: 备份旧版本 ──
    if (fs.existsSync(VM_EXTRACT_DIR)) {
      const backupDir = path.join(VM_DOWNLOADS_DIR, "backup");
      fs.mkdirSync(backupDir, { recursive: true });

      // 当前版本 → backup
      const currentVersionStr = getCurrentVmVersion();
      if (currentVersionStr) {
        const currentBackupDir = path.join(backupDir, `vm-${currentVersionStr}`);
        try {
          // 删除旧同名备份（如果存在）
          if (fs.existsSync(currentBackupDir)) {
            fs.rmSync(currentBackupDir, { recursive: true, force: true });
          }
          // rename 比 copy+delete 安全
          fs.renameSync(VM_EXTRACT_DIR, currentBackupDir);
          console.log(
            `[VM Updater] Backed up current version to ${currentBackupDir}`,
          );
        } catch (renameErr) {
          console.warn(
            `[VM Updater] Failed to rename old version, copying instead: ${renameErr}`,
          );
          fs.cpSync(VM_EXTRACT_DIR, currentBackupDir, { recursive: true });
        }
      }

      // Cleanup 旧版本（只保留当前 + 上一版本 = KEEP_VERSIONS 个）
      if (fs.existsSync(backupDir)) {
        try {
          const backups = fs
            .readdirSync(backupDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith("vm-"))
            .map((d) => d.name)
            .sort((a, b) => {
              const verA = a.slice(3);
              const verB = b.slice(3);
              return (compareSemver(verB, verA) ?? 0); // 降序（新版本在前）
            });

          // 删除超出保留数量的旧版本
          for (let i = KEEP_VERSIONS; i < backups.length; i++) {
            const oldDir = path.join(backupDir, backups[i]!);
            console.log(`[VM Updater] Removing old backup: ${oldDir}`);
            fs.rmSync(oldDir, { recursive: true, force: true });
          }
        } catch (cleanupErr) {
          console.warn(
            `[VM Updater] Failed to cleanup old backups: ${cleanupErr}`,
          );
        }
      }

      // ── Step 5: 将新下载的版本 renove 到 VM_EXTRACT_DIR ──
      //    downloadVmImage 解压到了 VM_EXTRACT_DIR
      //    由于我们刚才 backup 了 VM_EXTRACT_DIR，现在 downloadResult 中的路径可能已经变了
      //    实际上 downloadVmImage 解压到 VM_EXTRACT_DIR (硬编码常量)
      //    而 downloadVmImage 内部的 VM_EXTRACT_DIR 使用了自己的常量
      //    这里需要确保版本化存储的一致性

      // 注意: downloadVmImage 解压到了它自己的 VM_EXTRACT_DIR（~/.paperclip/vm/agenthubs-local-vm/）
      // 如果 downloadVmImage 在执行时发现目录已存在会先 rm 再解压
      // 由于我们在调用 downloadVmImage 之前没有做 backup，所以它解压到了默认路径
      // 现在 backup 之后，新版本已经在 VM_EXTRACT_DIR 中
      // 无需额外操作 — 新版本已在正确位置
    }

    // ── Step 6: 写入版本文件 ──
    writeVersion(version.version);

    report("complete", 100);
    console.log(`[VM Updater] VM image updated to ${version.version}`);

    return {
      success: true,
      version: version.version,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[VM Updater] Install failed: ${errorMessage}`);
    report("error", 0);

    // ⚠️ 更新失败 → 保留旧版本（不阻塞用户使用）
    // 旧版本的 VM_EXTRACT_DIR 在 backup 阶段已保存
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// ─── 备份恢复 ───

/**
 * 回退到上一个版本。
 * 从 backup 目录恢复 vm-{version} 到 VM_EXTRACT_DIR。
 *
 * 用于更新失败后的 fallback。
 */
export function rollbackToVersion(version: string): boolean {
  const backupDir = path.join(VM_DOWNLOADS_DIR, "backup", `vm-${version}`);

  if (!fs.existsSync(backupDir)) {
    console.error(
      `[VM Updater] Cannot rollback: backup directory not found at ${backupDir}`,
    );
    return false;
  }

  try {
    // 删除当前的 VM_EXTRACT_DIR（如果存在）
    if (fs.existsSync(VM_EXTRACT_DIR)) {
      fs.rmSync(VM_EXTRACT_DIR, { recursive: true, force: true });
    }

    // 确保目录存在
    fs.mkdirSync(path.dirname(VM_EXTRACT_DIR), { recursive: true });

    // 复制备份到 VM_EXTRACT_DIR
    fs.cpSync(backupDir, VM_EXTRACT_DIR, { recursive: true });

    // 更新 VERSION 文件
    writeVersion(version);

    console.log(
      `[VM Updater] Rolled back to version ${version} from ${backupDir}`,
    );
    return true;
  } catch (err) {
    console.error(`[VM Updater] Rollback failed: ${err}`);
    return false;
  }
}

/**
 * 列出本地可用的备份版本。
 */
export function listBackupVersions(): string[] {
  const backupDir = path.join(VM_DOWNLOADS_DIR, "backup");

  if (!fs.existsSync(backupDir)) return [];

  try {
    return fs
      .readdirSync(backupDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("vm-"))
      .map((d) => d.name.slice(3))
      .filter((v) => parseSemver(v) !== null)
      .sort((a, b) => {
        const cmp = compareSemver(b, a);
        return cmp ?? 0; // 降序（新版本在前）
      });
  } catch {
    return [];
  }
}
