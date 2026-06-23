// apps/desktop/src/main/vm-updater.ts
// Story 4.1: VM Image 自动更新
//
// VM image 更新独立于 Electron 壳（解耦）。
// 更新流程：
//   1. checkVmImageUpdate  — 读本地版本 + 查 GitHub Releases
//   2. installVmImageUpdate — 下载 + SHA256 验证 + zstd 解压 + 更新 VERSION 文件
//
// VM image 由两个文件组成：
//   - rootfs.img.zst  — Alpine rootfs（只读）
//   - agent.img.zst   — exFAT agent image（可写）
//
// 关键约束：
//   - 在用户下次切换模式时安装（不热替换正在运行的 VM）
//   - 更新失败 → fallback 旧版本（不阻塞用户使用）
//   - 保留当前版本 + 上一版本（cleanup 旧版本）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── 类型定义 ───

export interface VmImageVersion {
  /** 语义化版本号（如 "1.2.3"） */
  version: string;
  /** GitHub Release manifest URL (manifest.json) */
  manifestUrl: string;
  /** 根文件系统镜像信息 */
  rootfs: { url: string; sha256: string };
  /** Agent 镜像信息 */
  agent: { url: string; sha256: string };
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
  /** 安装进度回调 */
  onProgress?: (progress: VmImageInstallProgress) => void;
}

export interface VmImageInstallProgress {
  /** 进度百分比 0-100 */
  percent: number;
  /** 当前阶段 */
  stage: "downloading" | "verifying" | "extracting" | "cleanup" | "complete" | "error";
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

/** 下载的 asset 名称（双文件镜像） */
const VM_ASSET_NAMES = ["rootfs.img.zst", "agent.img.zst"];

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

/** GitHub API Rate-Limit 状态接口 */
interface GitHubRateLimitHeaders {
  "x-ratelimit-remaining"?: string;
  "x-ratelimit-reset"?: string;
}

/**
 * 从 GitHub Releases 获取最新的 VM image 版本信息。
 * 查询 releases?per_page=N，找第一个 tag 匹配 vm-v* 的 release，
 * 且同时包含 rootfs.img.zst 和 agent.img.zst 两个 asset。
 *
 * @param releasesUrl - 基础 URL（不含查询参数）
 * @returns VmImageVersion 如果找到完整 release；否则 null
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

  // Rate-limit 感知日志
  const headers = response.headers as unknown as GitHubRateLimitHeaders;
  if (response.status === 403 || response.status === 429) {
    const remaining = headers["x-ratelimit-remaining"] ?? "?";
    const reset = headers["x-ratelimit-reset"];
    const resetMsg = reset
      ? new Date(Number(reset) * 1000).toISOString()
      : "unknown";
    console.warn(
      `[VM Updater] GitHub API rate-limited: ${response.status} (remaining=${remaining}, reset=${resetMsg})`,
    );
    return null;
  }

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

    // 找两个必需的 .img.zst asset
    const rootfsAsset = release.assets.find(
      (a) => a.name === VM_ASSET_NAMES[0],
    );
    const agentAsset = release.assets.find(
      (a) => a.name === VM_ASSET_NAMES[1],
    );

    if (!rootfsAsset || !agentAsset) {
      const missing = [!rootfsAsset && VM_ASSET_NAMES[0], !agentAsset && VM_ASSET_NAMES[1]]
        .filter(Boolean)
        .join(", ");
      console.warn(
        `[VM Updater] Release ${release.tag_name} missing assets: ${missing}`,
      );
      continue;
    }

    // 找 manifest.json asset（可选 — 用于版本元数据）
    const manifestAsset = release.assets.find(
      (a) => a.name === "manifest.json",
    );

    // 找 .sha256 asset（可选 — SHA256 校验和文件）
    const rootfsShaAsset = release.assets.find(
      (a) => a.name === `${VM_ASSET_NAMES[0]}.sha256`,
    );
    const agentShaAsset = release.assets.find(
      (a) => a.name === `${VM_ASSET_NAMES[1]}.sha256`,
    );

    return {
      version,
      manifestUrl: manifestAsset
        ? manifestAsset.browser_download_url
        : `${release.html_url ?? releasesUrl.replace("/repos", "")}/releases/download/${release.tag_name}/manifest.json`,
      rootfs: {
        url: rootfsAsset.browser_download_url,
        sha256: rootfsShaAsset ? "" : "",
      },
      agent: {
        url: agentAsset.browser_download_url,
        sha256: agentShaAsset ? "" : "",
      },
      publishedAt: release.published_at,
    };
  }

  console.log("[VM Updater] No VM image release found in recent releases");
  return null;
}

/**
 * 下载 .sha256 文件内容并返回哈希值。
 *
 * 首先尝试 <url>.sha256（GitHub Asset API），
 * 如果失败则尝试对 URL 追加 .sha256。
 *
 * @param downloadUrl - 目标文件的下载 URL
 * @returns 小写的十六进制 sha256 哈希值，失败返回 null
 */
async function fetchSha256(downloadUrl: string): Promise<string | null> {
  // 尝试多种可能的 URL 变体
  const urlsToTry = [
    `${downloadUrl}.sha256`,
    downloadUrl.replace(/\.img\.zst$/, ".img.zst.sha256"),
  ];

  for (const shaUrl of urlsToTry) {
    try {
      const response = await fetch(shaUrl, {
        headers: {
          "User-Agent": "paperclip-desktop-vm-updater",
        },
      });
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      // 取第一行的第一段（标准 sha256sum 格式）
      const hash = text.trim().split(/\s+/)[0];
      if (hash && /^[a-f0-9]{64}$/i.test(hash)) {
        return hash.toLowerCase();
      }
    } catch {
      // 网络错误 → 尝试下一个 URL
    }
  }

  console.warn(
    `[VM Updater] SHA256 file not found for ${downloadUrl}`,
  );
  return null;
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

    // 如果 SHA256 尚未通过 asset API 获取，尝试从配套 .sha256 文件获取
    if (!latest.rootfs.sha256) {
      const sha256Hash = await fetchSha256(latest.rootfs.url);
      if (sha256Hash) {
        latest.rootfs.sha256 = sha256Hash;
      }
    }
    if (!latest.agent.sha256) {
      const sha256Hash = await fetchSha256(latest.agent.url);
      if (sha256Hash) {
        latest.agent.sha256 = sha256Hash;
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
 * 2. 下载 rootfs.img.zst 和 agent.img.zst 到版本化目录
 * 3. SHA256 校验每个文件
 * 4. zstd 解压到 vm/bundle/
 * 5. 备份旧版本（保留当前 + 上一版本）
 * 6. 替换 vm/bundle/ → 新版本
 * 7. 更新 VERSION 文件
 *
 * 注: 此函数依赖 download-vm-image.ts 中的 downloadVmImage() 函数。
 *     如果该模块尚未实现，import 会 throw，由调用方处理。
 */
export async function installVmImageUpdate(
  config: VmImageInstallConfig,
): Promise<VmImageInstallResult> {
  const { version, onProgress } = config;

  const report = (stage: VmImageInstallProgress["stage"], percent: number) => {
    onProgress?.({ percent, stage });
  };

  try {
    // ── Step 1: 确保下载目录存在 ──
    const versionDownloadDir = path.join(VM_DOWNLOADS_DIR, `vm-${version.version}`);
    fs.mkdirSync(versionDownloadDir, { recursive: true });

    // ── Step 2: 动态导入 downloadVmImage 并下载双文件 ──
    report("downloading", 0);
    console.log(
      `[VM Updater] Downloading VM image ${version.version} (rootfs + agent)`,
    );

    const { downloadVmImage } = await import("./download-vm-image.js");

    // 下载并校验 rootfs.img.zst
    const rootfsResult = await downloadVmImage({
      url: version.rootfs.url,
      onProgress: (progress: {
        percent: number;
        downloadedMB: number;
        totalMB: number;
        stage: string;
      }) => {
        onProgress?.({ percent: Math.round(progress.percent * 0.5), stage: "downloading" });
      },
    });

    if (!rootfsResult.success) {
      return {
        success: false,
        error: `Rootfs download failed: ${rootfsResult.error}`,
      };
    }

    // 下载并校验 agent.img.zst
    const agentResult = await downloadVmImage({
      url: version.agent.url,
      onProgress: (progress: {
        percent: number;
        downloadedMB: number;
        totalMB: number;
        stage: string;
      }) => {
        onProgress?.({ percent: 50 + Math.round(progress.percent * 0.5), stage: "downloading" });
      },
    });

    if (!agentResult.success) {
      return {
        success: false,
        error: `Agent download failed: ${agentResult.error}`,
      };
    }

    report("extracting", 75);
    console.log(`[VM Updater] Both images downloaded for ${version.version}`);

    // ── Step 3: SHA256 verified by downloadVmImage ──
    report("verifying", 80);

    // ── Step 4: Backup 旧版本并替换 ──
    report("cleanup", 85);

    const vmBundleDir = path.join(VM_HOME, "bundle");
    if (fs.existsSync(vmBundleDir)) {
      const backupDir = path.join(VM_DOWNLOADS_DIR, "backup");
      fs.mkdirSync(backupDir, { recursive: true });

      const currentVersionStr = getCurrentVmVersion();
      if (currentVersionStr) {
        const currentBackupDir = path.join(backupDir, `vm-${currentVersionStr}`);
        try {
          if (fs.existsSync(currentBackupDir)) {
            fs.rmSync(currentBackupDir, { recursive: true, force: true });
          }
          fs.renameSync(vmBundleDir, currentBackupDir);
          console.log(
            `[VM Updater] Backed up current version to ${currentBackupDir}`,
          );
        } catch (renameErr) {
          console.warn(
            `[VM Updater] Failed to rename old version, copying instead: ${renameErr}`,
          );
          fs.cpSync(vmBundleDir, currentBackupDir, { recursive: true });
        }
      }

      // Cleanup 旧版本（只保留 KEEP_VERSIONS 个）
      if (fs.existsSync(backupDir)) {
        try {
          const backups = fs
            .readdirSync(backupDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith("vm-"))
            .map((d) => d.name)
            .sort((a, b) => {
              const verA = a.slice(3);
              const verB = b.slice(3);
              return (compareSemver(verB, verA) ?? 0);
            });

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
    }

    // ── Step 5: 写入版本文件 ──
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

    return {
      success: false,
      error: errorMessage,
    };
  }
}

// ─── 备份恢复 ───

/**
 * 回退到上一个版本。
 * 从 backup 目录恢复 vm-{version} 到 vm/bundle/。
 *
 * 用于更新失败后的 fallback。
 */
export function rollbackToVersion(version: string): boolean {
  const backupDir = path.join(VM_DOWNLOADS_DIR, "backup", `vm-${version}`);
  const vmBundleDir = path.join(VM_HOME, "bundle");

  if (!fs.existsSync(backupDir)) {
    console.error(
      `[VM Updater] Cannot rollback: backup directory not found at ${backupDir}`,
    );
    return false;
  }

  try {
    // 删除当前的 bundle 目录（如果存在）
    if (fs.existsSync(vmBundleDir)) {
      fs.rmSync(vmBundleDir, { recursive: true, force: true });
    }

    // 确保目录存在
    fs.mkdirSync(path.dirname(vmBundleDir), { recursive: true });

    // 复制备份到 vm/bundle/
    fs.cpSync(backupDir, vmBundleDir, { recursive: true });

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
