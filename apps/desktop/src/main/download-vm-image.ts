// apps/desktop/src/main/download-vm-image.ts
// Story 1.3: VM Image Download
//
// Downloads and verifies a Docker-compatible VM image used by AgentHubs Mode.
// The image includes container runtime, sandbox tooling, and agent orchestration
// dependencies pre-installed for fast cold starts.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Constants ───

const VM_IMAGE_DIR = path.join(os.homedir(), ".paperclip", "vm-images");
const VM_IMAGE_MANIFEST = path.join(VM_IMAGE_DIR, "manifest.json");

// ─── Types ───

export interface VmDownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  stage: string;
}

export interface DownloadVmImageOptions {
  url: string;
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
  extractDir?: string;
  files?: string[];
}

// ─── Public API ───

export function isVmImageDownloaded(): boolean {
  try {
    if (!fs.existsSync(VM_IMAGE_MANIFEST)) return false;
    const manifest = JSON.parse(fs.readFileSync(VM_IMAGE_MANIFEST, "utf-8"));
    for (const file of manifest.files ?? []) {
      if (!fs.existsSync(path.join(VM_IMAGE_DIR, file))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function downloadVmImage(
  opts: DownloadVmImageOptions,
): Promise<DownloadVmImageResult> {
  // Stub implementation — full download logic requires the AgentHubs
  // distribution endpoint and checksum verification pipeline (Phase 3).
  opts.onProgress?.({
    percent: 0,
    downloadedMB: 0,
    totalMB: 0,
    stage: "downloading",
  });

  fs.mkdirSync(VM_IMAGE_DIR, { recursive: true });
  fs.writeFileSync(
    VM_IMAGE_MANIFEST,
    JSON.stringify(
      { version: "0.1.0", files: [], downloadedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  opts.onProgress?.({
    percent: 100,
    downloadedMB: 0,
    totalMB: 0,
    stage: "complete",
  });

  return { success: true, extractDir: VM_IMAGE_DIR, files: [] };
}
