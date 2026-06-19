// apps/desktop/src/main/download-vm-image.ts
// Story 1.3: VM Image 下载
// 从 GitHub Releases 下载 VM image tar.gz，SHA256 校验，解压 + docker load，进度事件上报

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as tar from "tar";

// ─── 类型定义 ───

/** 下载进度 */
export interface DownloadProgress {
  /** 进度百分比 0–100 */
  percent: number;
  /** 已下载 MB */
  downloadedMB: number;
  /** 总大小 MB（-1 表示未知） */
  totalMB: number;
  /** 当前阶段 */
  stage: "downloading" | "verifying" | "extracting" | "loading" | "complete" | "error";
}

/** VM 镜像下载结果 */
export interface VmImageDownloadResult {
  success: boolean;
  /** 解压后镜像目录路径 */
  imagePath?: string;
  /** docker-compose.yml 路径 */
  composePath?: string;
  /** 错误信息 */
  error?: string;
}

/** downloadVmImage 配置 */
export interface VmImageDownloadConfig {
  /** 下载 URL（默认 GitHub Releases） */
  url?: string;
  /** 容器运行时（docker / podman） */
  containerRuntime: string;
  /** 进度回调 */
  onProgress?: (progress: DownloadProgress) => void;
}

// ─── 常量 ───

const DEFAULT_DOWNLOAD_URL =
  "https://github.com/MayerZhe/agenthubs/releases/download/vm-latest/agenthubs-local-vm.tar.gz";
const VM_HOME = path.resolve(
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"),
  "vm",
);
const VM_DOWNLOADS_DIR = path.join(VM_HOME, "downloads");
const VM_EXTRACT_DIR = path.join(VM_HOME, "agenthubs-local-vm");

/** 下载超时 15 分钟 */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 指数退避基础延迟 (ms) */
const RETRY_BASE_DELAY_MS = 2000;

// ─── 工具函数 ───

/**
 * 指数退避延迟
 * @param attempt - 第几次尝试 (1-based)
 */
function backoffDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/**
 * 格式化字节为 MB
 */
function toMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

// ─── 文件系统工具 ───

/**
 * 确保目录存在
 */
async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 安全删除文件（忽略文件不存在错误）
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // 文件不存在，忽略
  }
}

// ─── SHA256 校验文件下载 ───

/**
 * 下载 SHA256 校验文件
 * @param tarUrl - tar.gz 下载 URL
 * @param destPath - 校验文件保存路径
 */
function downloadChecksumFile(tarUrl: string, destPath: string): Promise<void> {
  const sha256Url = tarUrl.replace(/\.tar\.gz$/, ".tar.gz.sha256");
  return downloadFile(sha256Url, destPath);
}

/**
 * 读取 SHA256 文件内容
 * @param checksumPath - .sha256 文件路径
 * @returns 小写的十六进制哈希值，或 null
 */
async function readChecksum(checksumPath: string): Promise<string | null> {
  try {
    const content = await fsp.readFile(checksumPath, "utf-8");
    // 标准格式: "<hash>  <filename>" 或 "<hash> <filename>" 或仅 "<hash>"
    const match = content.trim().match(/^([a-fA-F0-9]{64})/);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// ─── HTTP/HTTPS 下载 ───

/**
 * HTTP/HTTPS 下载文件（支持重定向）
 * @param url - 下载 URL
 * @param destPath - 目标文件路径
 * @param onProgress - 进度回调
 * @param timeoutMs - 超时时间
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const request = protocol.get(url, { timeout: timeoutMs }, (response) => {
      // 处理重定向
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume(); // 消费响应体
        downloadFile(response.headers.location, destPath, onProgress, timeoutMs)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(
          new Error(`Download failed: HTTP ${response.statusCode} for ${url}`),
        );
        return;
      }

      const totalSize = response.headers["content-length"]
        ? parseInt(response.headers["content-length"], 10)
        : -1;

      let downloaded = 0;
      const writeStream = fs.createWriteStream(destPath);

      response.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (onProgress) {
          onProgress(downloaded, totalSize);
        }
      });

      response.pipe(writeStream);

      writeStream.on("finish", () => {
        writeStream.close();
        resolve();
      });

      writeStream.on("error", (err) => {
        writeStream.close();
        reject(err);
      });

      response.on("error", (err) => {
        writeStream.close();
        reject(err);
      });
    });

    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Download timeout after ${timeoutMs}ms: ${url}`));
    });

    request.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── SHA256 文件校验 ───

/**
 * 计算文件的 SHA256 哈希
 * @param filePath - 文件路径
 * @returns 小写的十六进制哈希值
 */
function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex").toLowerCase());
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── 解压 tar.gz ───

/**
 * 解压 tar.gz 到目标目录
 * @param tgzPath - tar.gz 文件路径
 * @param destDir - 解压目标目录
 */
async function extractTarGz(tgzPath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  await tar.extract({
    file: tgzPath,
    cwd: destDir,
  });
}

// ─── Docker 镜像加载 ───

/**
 * 查找目录中的 Docker images tar 文件
 * @param dir - 搜索目录
 * @returns 找到的 tar 文件路径列表
 */
async function findImageTars(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (e) => e.isFile() && (e.name.endsWith(".tar") || e.name.endsWith(".tar.gz")),
    )
    .map((e) => path.join(dir, e.name));
}

/**
 * 执行 docker load（或 podman load）
 * @param containerRuntime - docker 或 podman
 * @param imageTarPath - Docker image tar 文件路径
 * @returns 退出码
 */
function dockerLoad(
  containerRuntime: string,
  imageTarPath: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(containerRuntime, ["load", "-i", imageTarPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      console.log(`[VM Image] docker load: ${chunk.toString().trim()}`);
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── 进度上报 ───

/**
 * 创建进度上报辅助函数
 */
function makeProgressReporter(onProgress?: (progress: DownloadProgress) => void) {
  return (stage: DownloadProgress["stage"], percent: number, downloadedMB: number, totalMB: number) => {
    onProgress?.({ stage, percent, downloadedMB, totalMB });
  };
}

// ─── 公开 API ───

/**
 * 检查 VM 镜像是否已下载并解压
 * @returns 如果 docker-compose.yml 存在则返回 true
 */
export function isVmImageDownloaded(): boolean {
  const composePath = path.join(VM_EXTRACT_DIR, "docker-compose.yml");
  try {
    return fs.existsSync(composePath);
  } catch {
    return false;
  }
}

/**
 * 重试执行带退避的任务
 * @param fn - 异步任务函数（接收当前尝试次数）
 * @param maxRetries - 最大尝试次数
 * @returns fn 的返回值
 */
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt);
        console.warn(
          `[VM Image] Attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded, no error captured");
}

/**
 * 下载 VM 镜像
 *
 * 流程：
 * 1. 从 GitHub Releases 下载 tar.gz → ~/.paperclip/vm/downloads/
 * 2. 下载 .sha256 校验文件
 * 3. SHA256 校验（失败重试最多3次，指数退避）
 * 4. 解压 tar.gz → ~/.paperclip/vm/agenthubs-local-vm/
 * 5. docker load < images.tar
 *
 * @param config - 下载配置
 * @returns VmImageDownloadResult
 */
export async function downloadVmImage(
  config: VmImageDownloadConfig,
): Promise<VmImageDownloadResult> {
  const url = config.url ?? DEFAULT_DOWNLOAD_URL;
  const containerRuntime = config.containerRuntime;
  const report = makeProgressReporter(config.onProgress);

  await ensureDir(VM_DOWNLOADS_DIR);

  const tgzFilename = path.basename(new URL(url).pathname);
  const tgzPath = path.join(VM_DOWNLOADS_DIR, tgzFilename);
  const checksumPath = tgzPath + ".sha256";

  try {
    // ═══════════════════════════════════════
    // Step 1: 下载 .sha256 校验文件
    // ═══════════════════════════════════════
    report("downloading", 0, 0, -1);
    console.log(`[VM Image] Downloading checksum: ${url}.sha256`);
    await withRetry(async (attempt) => {
      // 重试前删除可能损坏的文件
      if (attempt > 1) {
        await safeUnlink(checksumPath);
      }
      return downloadChecksumFile(url, checksumPath);
    });

    // ═══════════════════════════════════════
    // Step 2: 下载 tar.gz（带进度）
    // ═══════════════════════════════════════
    report("downloading", 0, 0, -1);
    console.log(`[VM Image] Downloading: ${url}`);

    let lastReportTime = 0;
    await withRetry(async (attempt) => {
      if (attempt > 1) {
        await safeUnlink(tgzPath);
      }
      return downloadFile(url, tgzPath, (downloaded, total) => {
        const now = Date.now();
        // 节流：最多每 200ms 触发一次进度回调，避免 IPC 风暴
        if (now - lastReportTime >= 200 || downloaded === total) {
          lastReportTime = now;
          const downloadedMB = toMB(downloaded);
          const totalMB = total > 0 ? toMB(total) : -1;
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          report("downloading", percent, downloadedMB, totalMB);
        }
      });
    });

    // ═══════════════════════════════════════
    // Step 3: SHA256 校验
    // ═══════════════════════════════════════
    report("verifying", 0, 0, -1);
    console.log(`[VM Image] Verifying SHA256...`);
    const expectedHash = await readChecksum(checksumPath);
    if (!expectedHash) {
      return {
        success: false,
        error: "SHA256 checksum file is empty or malformed",
      };
    }

    const actualHash = await computeSha256(tgzPath);
    if (actualHash !== expectedHash) {
      // 删除不匹配的文件并报错
      await safeUnlink(tgzPath);
      await safeUnlink(checksumPath);
      return {
        success: false,
        error: `SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`,
      };
    }
    console.log(`[VM Image] SHA256 verified: ${actualHash}`);

    // ═══════════════════════════════════════
    // Step 4: 解压 tar.gz
    // ═══════════════════════════════════════
    report("extracting", 0, 0, -1);
    console.log(`[VM Image] Extracting to ${VM_EXTRACT_DIR}...`);
    // 清理旧解压目录（如果存在）
    try {
      await fsp.rm(VM_EXTRACT_DIR, { recursive: true, force: true });
    } catch {
      // 目录不存在
    }
    await extractTarGz(tgzPath, VM_EXTRACT_DIR);
    report("extracting", 100, 0, -1);

    // ═══════════════════════════════════════
    // Step 5: docker load images.tar
    // ═══════════════════════════════════════
    report("loading", 0, 0, -1);
    const imageTars = await findImageTars(VM_EXTRACT_DIR);
    if (imageTars.length > 0) {
      for (const imageTar of imageTars) {
        console.log(`[VM Image] Loading Docker image: ${imageTar}`);
        const { exitCode, stderr } = await dockerLoad(containerRuntime, imageTar);
        if (exitCode !== 0) {
          return {
            success: false,
            error: `${containerRuntime} load failed (exit ${exitCode}): ${stderr}`,
            imagePath: VM_EXTRACT_DIR,
          };
        }
      }
    } else {
      console.log(`[VM Image] No Docker image tars found in ${VM_EXTRACT_DIR} — skipping docker load`);
    }
    report("loading", 100, 0, -1);

    // ═══════════════════════════════════════
    // Step 6: 验证结果
    // ═══════════════════════════════════════
    const composePath = path.join(VM_EXTRACT_DIR, "docker-compose.yml");
    if (!fs.existsSync(composePath)) {
      return {
        success: false,
        error: `docker-compose.yml not found in ${VM_EXTRACT_DIR}`,
        imagePath: VM_EXTRACT_DIR,
      };
    }

    // 清理下载的临时文件
    await safeUnlink(tgzPath);
    await safeUnlink(checksumPath);

    report("complete", 100, 0, -1);
    console.log(`[VM Image] Download complete: ${VM_EXTRACT_DIR}`);

    return {
      success: true,
      imagePath: VM_EXTRACT_DIR,
      composePath,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[VM Image] Download failed: ${errorMessage}`);
    report("error", 0, 0, -1);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
