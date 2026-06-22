// apps/desktop/src/main/download-vm-image.ts
// Story 1.3: VM Image Download
//
// Downloads and verifies a Docker-compatible VM image used by AgentHubs Mode.
// The image includes container runtime, sandbox tooling, and agent orchestration
// dependencies pre-installed for fast cold starts.
//
// Download flow:
//   1. Resolve download URL (from opts or defaults)
//   2. Stream download to temp file with progress reporting
//   3. SHA256 checksum verification (if checksum provided)
//   4. Extract tar.gz to VM_IMAGE_DIR
//   5. Write manifest.json with file listing
//   6. Clean up temp file

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// ─── Constants ───────────────────────────────────────────────────────────────

const VM_IMAGE_DIR = path.join(os.homedir(), ".paperclip", "vm-images");
const VM_IMAGE_MANIFEST = path.join(VM_IMAGE_DIR, "manifest.json");

/** Default AgentHubs VM image distribution URL */
const DEFAULT_VM_IMAGE_URL =
  process.env.PAPERCLIP_VM_IMAGE_URL ??
  "https://releases.agenthubs.dev/vm/agenthubs-vm-latest.tar.gz";

/** Default SHA256 checksum URL (appended ".sha256" to image URL if not set) */
const DEFAULT_CHECKSUM_URL = (baseUrl: string) => `${baseUrl}.sha256`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VmDownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  stage: "downloading" | "verifying" | "extracting" | "complete" | "error";
  error?: string;
}

export interface DownloadVmImageOptions {
  /** URL of the VM image to download. Defaults to DEFAULT_VM_IMAGE_URL. */
  url?: string;
  /** SHA256 checksum for verification. If unset, fetched from {url}.sha256. */
  checksum?: string;
  /** Container runtime type (docker, podman, finch, colima). */
  containerRuntime?: string;
  /** Force re-download even if already cached. */
  force?: boolean;
  /** Callback for progress updates. */
  onProgress?: (progress: VmDownloadProgress) => void;
}

export interface DownloadVmImageResult {
  success: boolean;
  error?: string;
  extractDir: string;
  files: string[];
}

export interface VmManifest {
  downloadUrl: string;
  version: string;
  checksum: string;
  files: string[];
  totalBytes: number;
  downloadedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the existing manifest if present and valid.
 */
function readManifest(): VmManifest | null {
  try {
    if (!fs.existsSync(VM_IMAGE_MANIFEST)) return null;
    const raw = fs.readFileSync(VM_IMAGE_MANIFEST, "utf-8");
    const manifest = JSON.parse(raw) as VmManifest;

    // Verify all files still exist on disk
    for (const file of manifest.files ?? []) {
      if (!fs.existsSync(path.join(VM_IMAGE_DIR, file))) return null;
    }

    return manifest;
  } catch {
    return null;
  }
}

/**
 * Fetch the content-length (total bytes) and checksum from a URL via HEAD request.
 */
async function fetchRemoteInfo(
  url: string,
): Promise<{ totalBytes: number }> {
  // Try HEAD first for content-length
  try {
    const headRes = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (headRes.ok) {
      const contentLength = headRes.headers.get("content-length");
      if (contentLength) {
        return { totalBytes: parseInt(contentLength, 10) };
      }
    }
  } catch {
    // HEAD failed — fall through to GET with range
  }

  // Fallback: GET with bytes=0-0 to get Content-Range
  try {
    const rangeRes = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
    });
    const contentRange = rangeRes.headers.get("content-range");
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) {
        return { totalBytes: parseInt(match[1], 10) };
      }
    }
  } catch {
    // Both failed — we'll report 0 total bytes
  }

  return { totalBytes: 0 };
}

/**
 * Fetch the SHA256 checksum for the download URL.
 */
async function fetchChecksum(url: string): Promise<string | null> {
  const checksumUrl = DEFAULT_CHECKSUM_URL(url);
  try {
    const res = await fetch(checksumUrl);
    if (res.ok) {
      const text = await res.text();
      // Format: "<sha256>  <filename>" or just "<sha256>"
      const sha256Match = text.match(/^([a-f0-9]{64})/i);
      if (sha256Match) return sha256Match[1].toLowerCase();
    }
  } catch {
    // Checksum fetch failed — download will proceed without verification
  }
  return null;
}

/**
 * Download a file from URL to a local path, reporting progress.
 * Returns the SHA256 checksum of the downloaded file.
 */
async function downloadFile(
  url: string,
  destPath: string,
  totalBytes: number,
  signal: AbortSignal,
  onProgress?: (downloadedBytes: number, total: number) => void,
): Promise<string> {
  const response = await fetch(url, { signal, redirect: "follow" });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Response has no body");
  }

  const hash = createHash("sha256");
  let downloadedBytes = 0;

  const fd = await fsp.open(destPath, "w");
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        downloadedBytes += value.length;
        hash.update(Buffer.from(value));
        onProgress?.(downloadedBytes, totalBytes);

        await fd.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fd.close();
  }

  return hash.digest("hex");
}

/**
 * Extract a tar.gz archive to the target directory.
 * Uses system tar for reliability (available on macOS, Linux, WSL).
 */
function extractTarGz(archivePath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5 * 60 * 1000, // 5 minute timeout
    });
  } catch (err) {
    throw new Error(
      `Failed to extract VM image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Enumerate all files (recursively) in a directory relative to its root.
 */
function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string, relative: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), path.join(relative, entry.name));
      } else {
        results.push(path.join(relative, entry.name));
      }
    }
  };
  walk(dir, ".");
  return results;
}

/**
 * Compute total bytes of all files in a directory.
 */
function directorySize(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        total += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  return total;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a VM image has already been downloaded and is intact on disk.
 */
export function isVmImageDownloaded(): boolean {
  return readManifest() !== null;
}

/**
 * Get the cached manifest if a VM image has been downloaded.
 */
export function getVmImageManifest(): VmManifest | null {
  return readManifest();
}

/**
 * Remove all cached VM images from disk.
 */
export function clearVmImageCache(): void {
  if (fs.existsSync(VM_IMAGE_DIR)) {
    fs.rmSync(VM_IMAGE_DIR, { recursive: true, force: true });
  }
}

/**
 * Download and extract the AgentHubs VM image.
 *
 * Flow:
 *   1. Check cache — if already downloaded and not forced, return immediately
 *   2. Fetch remote info (content-length, checksum)
 *   3. Stream download to temp file with progress
 *   4. Verify SHA256 checksum
 *   5. Extract to VM_IMAGE_DIR
 *   6. Write manifest
 *   7. Clean up temp file
 *
 * @param opts - Download options
 * @returns Result with success, extractDir, and file listing
 */
export async function downloadVmImage(
  opts: DownloadVmImageOptions = {},
): Promise<DownloadVmImageResult> {
  const {
    url = DEFAULT_VM_IMAGE_URL,
    checksum: providedChecksum,
    force = false,
    onProgress,
  } = opts;

  const reportProgress = (progress: VmDownloadProgress) => onProgress?.(progress);

  // ── Step 0: Check cache ─────────────────────────────────────────────────
  if (!force) {
    const cached = readManifest();
    if (cached) {
      reportProgress({
        percent: 100,
        downloadedMB: cached.totalBytes / (1024 * 1024),
        totalMB: cached.totalBytes / (1024 * 1024),
        stage: "complete",
      });
      return {
        success: true,
        extractDir: VM_IMAGE_DIR,
        files: cached.files,
      };
    }
  }

  // ── Step 1: Fetch remote info ───────────────────────────────────────────
  reportProgress({ percent: 0, downloadedMB: 0, totalMB: 0, stage: "downloading" });

  let totalBytes = 0;
  let checksum = providedChecksum ?? null;

  try {
    const [info, fetchedChecksum] = await Promise.all([
      fetchRemoteInfo(url),
      providedChecksum ? Promise.resolve(null) : fetchChecksum(url),
    ]);
    totalBytes = info.totalBytes;
    if (fetchedChecksum) checksum = fetchedChecksum;
  } catch {
    // Non-fatal — continue without totalBytes/checksum
  }

  // ── Step 2: Download ────────────────────────────────────────────────────
  const abortController = new AbortController();
  const tempDir = path.join(VM_IMAGE_DIR, ".tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `vm-image-${Date.now()}.tar.gz`);

  try {
    const downloadedSha256 = await downloadFile(
      url,
      tempFile,
      totalBytes,
      abortController.signal,
      (downloaded, total) => {
        const effectiveTotal = total > 0 ? total : (os.freemem() > 100 * 1024 * 1024 ? 500 * 1024 * 1024 : 50 * 1024 * 1024); // rough estimate
        reportProgress({
          percent: Math.min(Math.round((downloaded / effectiveTotal) * 100), 99),
          downloadedMB: Math.round(downloaded / (1024 * 1024)),
          totalMB: Math.round(effectiveTotal / (1024 * 1024)),
          stage: "downloading",
        });
      },
    );

    // ── Step 3: Checksum verification ─────────────────────────────────────
    if (checksum) {
      reportProgress({ percent: 99, downloadedMB: 0, totalMB: 0, stage: "verifying" });
      if (downloadedSha256 !== checksum) {
        throw new Error(
          `Checksum mismatch: expected ${checksum}, got ${downloadedSha256}`,
        );
      }
    }

    // ── Step 4: Extract ────────────────────────────────────────────────────
    reportProgress({ percent: 99, downloadedMB: 0, totalMB: 0, stage: "extracting" });
    extractTarGz(tempFile, VM_IMAGE_DIR);

    // ── Step 5: Write manifest ─────────────────────────────────────────────
    const files = listFilesRecursive(VM_IMAGE_DIR);
    const finalSize = directorySize(VM_IMAGE_DIR);
    const manifest: VmManifest = {
      downloadUrl: url,
      version: "0.1.0",
      checksum: checksum ?? downloadedSha256,
      files: files.filter((f) => !f.startsWith(".tmp/")), // exclude temp files
      totalBytes: finalSize,
      downloadedAt: new Date().toISOString(),
    };

    fs.writeFileSync(VM_IMAGE_MANIFEST, JSON.stringify(manifest, null, 2));

    // ── Step 6: Clean up ───────────────────────────────────────────────────
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Non-fatal
    }

    reportProgress({
      percent: 100,
      downloadedMB: finalSize / (1024 * 1024),
      totalMB: finalSize / (1024 * 1024),
      stage: "complete",
    });

    return {
      success: true,
      extractDir: VM_IMAGE_DIR,
      files: manifest.files,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Clean up temp file on failure
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Non-fatal
    }

    reportProgress({
      percent: 0,
      downloadedMB: 0,
      totalMB: 0,
      stage: "error",
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
      extractDir: VM_IMAGE_DIR,
      files: [],
    };
  }
}
