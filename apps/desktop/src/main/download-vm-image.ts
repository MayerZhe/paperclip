// apps/desktop/src/main/download-vm-image.ts
// Story 3C3: Dual .img.zst manifest-based VM image download
//
// Downloads rootfs.img.zst and agent.img.zst in parallel, verifies SHA256
// from a manifest.json, decompresses with zstd, and installs to the VM bundle.
//
// Bundle layout (shared with vm-bundle.ts):
//   ~/.paperclip/vm/bundle/
//   ├── rootfs.img        # Decompressed Alpine rootfs
//   ├── agent.img         # Decompressed agent exFAT image
//   └── manifest.json     # VmManifest

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

// ─── Constants ───

const PAPERCLIP_HOME =
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip");

const VM_HOME = path.resolve(PAPERCLIP_HOME, "vm");
const VM_BUNDLE_DIR = path.join(VM_HOME, "bundle");
const VM_DOWNLOADS_DIR = path.join(VM_HOME, "downloads");
const VM_BUNDLE_MANIFEST = path.join(VM_BUNDLE_DIR, "manifest.json");

const DEFAULT_VM_MANIFEST_URL =
  "https://releases.agenthubs.dev/vm/manifest.json";

const REQUIRED_IMAGES = ["rootfs.img", "agent.img"] as const;

// ─── Types ───

export interface VmDownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  stage:
    | "fetching_manifest"
    | "downloading"
    | "verifying"
    | "decompressing"
    | "complete"
    | "error";
}

export interface DownloadVmImageOptions {
  /** URL to manifest.json (default: https://releases.agenthubs.dev/vm/manifest.json) */
  manifestUrl?: string;
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

export interface VmManifestFileInfo {
  url: string;
  sha256: string;
  size: number;
}

export interface VmManifest {
  version: string;
  rootfs: VmManifestFileInfo;
  agent: VmManifestFileInfo;
  totalBytes: number;
  downloadedAt: string;
  files: string[];
}

// ─── Public API ───

/**
 * Check whether the VM image bundle is fully downloaded and ready.
 *
 * A bundle is considered ready when:
 *   1. manifest.json exists in the bundle directory
 *   2. Both rootfs.img and agent.img exist and are non-empty
 */
export function isVmImageDownloaded(): boolean {
  try {
    if (!fs.existsSync(VM_BUNDLE_MANIFEST)) return false;
    const manifest = JSON.parse(
      fs.readFileSync(VM_BUNDLE_MANIFEST, "utf-8"),
    );
    // Must have a non-empty files array
    const files: string[] = manifest.files ?? [];
    if (files.length === 0) return false;
    for (const file of files) {
      const filePath = path.join(VM_BUNDLE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and return the VM bundle manifest.
 *
 * @returns Parsed VmManifest, or null if the manifest does not exist or is malformed.
 */
export function getVmImageManifest(): VmManifest | null {
  try {
    if (!fs.existsSync(VM_BUNDLE_MANIFEST)) return null;
    const raw = fs.readFileSync(VM_BUNDLE_MANIFEST, "utf-8");
    const manifest = JSON.parse(raw) as VmManifest;
    // Basic validation
    if (
      !manifest.version ||
      !manifest.rootfs ||
      !manifest.agent ||
      !Array.isArray(manifest.files)
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Clear the VM image cache.
 *
 * Removes the bundle directory and downloads directory.
 */
export function clearVmImageCache(): void {
  for (const dir of [VM_BUNDLE_DIR, VM_DOWNLOADS_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

/**
 * Download and install the VM image bundle.
 *
 * Flow:
 * 1. Fetch manifest.json
 * 2. Parse manifest → rootfs + agent URLs with SHA256
 * 3. Parallel download both .img.zst files to downloads/
 * 4. SHA256 verification for both files
 * 5. zstd decompress both files to bundle/
 * 6. Write manifest to bundle/
 * 7. Clean up download cache
 * 8. Return result
 */
export async function downloadVmImage(
  opts: DownloadVmImageOptions = {},
): Promise<DownloadVmImageResult> {
  const {
    manifestUrl = DEFAULT_VM_MANIFEST_URL,
    force = false,
    onProgress,
  } = opts;

  const report = (stage: VmDownloadProgress["stage"], percent = 0) => {
    onProgress?.({
      percent,
      downloadedMB: 0,
      totalMB: 0,
      stage,
    });
  };

  try {
    // ── Step 0: Check if already downloaded ──
    if (!force && isVmImageDownloaded()) {
      report("complete", 100);
      const manifest = getVmImageManifest()!;
      return {
        success: true,
        extractDir: VM_BUNDLE_DIR,
        files: manifest.files,
      };
    }

    // ── Step 1: Fetch manifest.json ──
    report("fetching_manifest", 0);
    console.log(`[download-vm-image] Fetching manifest: ${manifestUrl}`);

    const manifestResp = await fetch(manifestUrl);
    if (!manifestResp.ok) {
      throw new Error(
        `Failed to fetch manifest: HTTP ${manifestResp.status} ${manifestResp.statusText}`,
      );
    }

    const rawManifest = (await manifestResp.json()) as {
      version: string;
      rootfs: { url: string; sha256: string; size: number };
      agent: { url: string; sha256: string; size: number };
    };

    // Validate manifest structure
    if (
      !rawManifest.version ||
      !rawManifest.rootfs?.url ||
      !rawManifest.rootfs?.sha256 ||
      !rawManifest.agent?.url ||
      !rawManifest.agent?.sha256
    ) {
      throw new Error("Invalid manifest: missing required fields");
    }

    // Validate SHA256 format: must be 64 hex characters
    for (const [name, info] of [
      ["rootfs", rawManifest.rootfs],
      ["agent", rawManifest.agent],
    ] as const) {
      if (!/^[a-f0-9]{64}$/.test(info.sha256)) {
        // Accept uppercase too, normalize to lowercase
        if (!/^[A-Fa-f0-9]{64}$/.test(info.sha256)) {
          throw new Error(
            `Invalid SHA256 in manifest.${name}: ${info.sha256}`,
          );
        }
        info.sha256 = info.sha256.toLowerCase();
      }
    }

    const manifest: VmManifest = {
      version: rawManifest.version,
      rootfs: rawManifest.rootfs,
      agent: rawManifest.agent,
      totalBytes: rawManifest.rootfs.size + rawManifest.agent.size,
      downloadedAt: new Date().toISOString(),
      files: [...REQUIRED_IMAGES],
    };

    console.log(
      `[download-vm-image] Manifest v${manifest.version} — ` +
        `rootfs: ${(manifest.rootfs.size / 1e6).toFixed(1)}MB, ` +
        `agent: ${(manifest.agent.size / 1e6).toFixed(1)}MB`,
    );

    // ── Step 2: Create download temp dir ──
    fs.mkdirSync(VM_DOWNLOADS_DIR, { recursive: true });
    // Clean existing bundle
    if (fs.existsSync(VM_BUNDLE_DIR)) {
      fs.rmSync(VM_BUNDLE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(VM_BUNDLE_DIR, { recursive: true });

    // ── Step 3: Parallel download both files ──
    report("downloading", 0);

    const rootfsDest = path.join(VM_DOWNLOADS_DIR, "rootfs.img.zst");
    const agentDest = path.join(VM_DOWNLOADS_DIR, "agent.img.zst");

    const [rootfsResult, agentResult] = await Promise.all([
      downloadFile(manifest.rootfs.url, rootfsDest, {
        expectedSha256: manifest.rootfs.sha256,
        totalSize: manifest.rootfs.size,
        onProgress: (downloaded) => {
          // Report aggregated progress
          const rootfsPct = manifest.rootfs.size > 0
            ? downloaded / manifest.totalBytes
            : 0;
          onProgress?.({
            percent: Math.round(rootfsPct * 50), // rootfs is first 50%
            downloadedMB: Math.round(downloaded / 1e6),
            totalMB: Math.round(manifest.totalBytes / 1e6),
            stage: "downloading",
          });
        },
      }),
      downloadFile(manifest.agent.url, agentDest, {
        expectedSha256: manifest.agent.sha256,
        totalSize: manifest.agent.size,
        onProgress: (downloaded) => {
          const agentPct = manifest.agent.size > 0
            ? downloaded / manifest.totalBytes
            : 0;
          onProgress?.({
            percent: Math.round(50 + agentPct * 50), // agent is second 50%
            downloadedMB: Math.round(
              (manifest.rootfs.size + downloaded) / 1e6,
            ),
            totalMB: Math.round(manifest.totalBytes / 1e6),
            stage: "downloading",
          });
        },
      }),
    ]);

    if (!rootfsResult.ok) {
      throw new Error(`rootfs download failed: ${rootfsResult.error}`);
    }
    if (!agentResult.ok) {
      throw new Error(`agent download failed: ${agentResult.error}`);
    }

    // ── Step 4: SHA256 verification ──
    report("verifying", 80);

    console.log(
      `[download-vm-image] Verifying SHA256 for rootfs… (expected ${manifest.rootfs.sha256})`,
    );
    const rootfsHash = await sha256File(rootfsDest);
    console.log(`[download-vm-image] rootfs SHA256: ${rootfsHash}`);
    if (rootfsHash !== manifest.rootfs.sha256) {
      throw new Error(
        `rootfs SHA256 mismatch: expected ${manifest.rootfs.sha256}, got ${rootfsHash}`,
      );
    }

    console.log(
      `[download-vm-image] Verifying SHA256 for agent… (expected ${manifest.agent.sha256})`,
    );
    const agentHash = await sha256File(agentDest);
    console.log(`[download-vm-image] agent SHA256: ${agentHash}`);
    if (agentHash !== manifest.agent.sha256) {
      throw new Error(
        `agent SHA256 mismatch: expected ${manifest.agent.sha256}, got ${agentHash}`,
      );
    }

    console.log("[download-vm-image] SHA256 verification passed for both files");

    // ── Step 5: zstd decompression ──
    report("decompressing", 90);

    const rootfsOut = path.join(VM_BUNDLE_DIR, "rootfs.img");
    const agentOut = path.join(VM_BUNDLE_DIR, "agent.img");

    await Promise.all([
      decompressZstd(rootfsDest, rootfsOut),
      decompressZstd(agentDest, agentOut),
    ]);

    // Verify decompressed files exist and are non-empty
    for (const [label, filePath] of [
      ["rootfs", rootfsOut],
      ["agent", agentOut],
    ] as const) {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        throw new Error(`${label}.img decompressed to empty file`);
      }
      console.log(
        `[download-vm-image] ${label}.img: ${(stat.size / 1e6).toFixed(1)}MB`,
      );
    }

    // ── Step 6: Write manifest to bundle ──
    fs.writeFileSync(
      VM_BUNDLE_MANIFEST,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // ── Step 7: Cleanup download cache ──
    try {
      fs.rmSync(rootfsDest, { force: true });
      fs.rmSync(agentDest, { force: true });
    } catch {
      // best effort cleanup
    }

    report("complete", 100);
    console.log("[download-vm-image] VM image bundle ready");

    return {
      success: true,
      extractDir: VM_BUNDLE_DIR,
      files: manifest.files,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[download-vm-image] Download failed: ${errorMessage}`);
    report("error", 0);

    // Clean up partial downloads
    for (const dir of [VM_DOWNLOADS_DIR, VM_BUNDLE_DIR]) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
    }

    return {
      success: false,
      error: errorMessage,
      extractDir: VM_BUNDLE_DIR,
      files: [],
    };
  }
}

// ─── Internal helpers ───

interface DownloadFileOptions {
  expectedSha256?: string;
  totalSize?: number;
  onProgress?: (downloadedBytes: number) => void;
}

interface DownloadFileResult {
  ok: boolean;
  error?: string;
}

/**
 * Download a file from url to destPath with optional SHA256 verification
 * and progress reporting.
 */
async function downloadFile(
  url: string,
  destPath: string,
  opts: DownloadFileOptions = {},
): Promise<DownloadFileResult> {
  const { onProgress } = opts;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, error: "Response body is not readable" };
    }

    const fileStream = fs.createWriteStream(destPath);
    let downloaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        downloaded += value.length;
        onProgress?.(downloaded);
      }
    } finally {
      fileStream.end();
      // Wait for file stream to finish
      await new Promise<void>((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });
    }

    return { ok: true };
  } catch (err) {
    // Clean up partial file
    try {
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    } catch {
      // best effort
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compute SHA256 hash of a file (streaming, works on large files).
 */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);

  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Decompress a zstd-compressed file.
 *
 * Tries system zstd binary first (macOS: /usr/bin/zstd, Linux: zstd),
 * then falls back to @chainsafe/zstd npm module.
 */
async function decompressZstd(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const systemZstd = process.platform === "darwin" ? "/usr/bin/zstd" : "zstd";

  // Try system zstd first
  try {
    await execFileAsync(systemZstd, ["-d", inputPath, "-o", outputPath, "-f"], {
      timeout: 5 * 60 * 1000, // 5 minutes
    });
    console.log(`[download-vm-image] Decompressed with system zstd: ${path.basename(inputPath)}`);
    return;
  } catch (err) {
    console.warn(
      `[download-vm-image] System zstd failed for ${path.basename(inputPath)}, trying npm module: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: use @chainsafe/zstd npm module (dynamic import)
  try {
    // @ts-expect-error — @chainsafe/zstd is an optional dependency; may not be installed
    const { decompress } = await import("@chainsafe/zstd");
    const compressed = await fsp.readFile(inputPath);
    const decompressed = await decompress(compressed);
    await fsp.writeFile(outputPath, decompressed);
    console.log(`[download-vm-image] Decompressed with @chainsafe/zstd: ${path.basename(inputPath)}`);
  } catch (err) {
    throw new Error(
      `zstd decompression failed for ${path.basename(inputPath)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
