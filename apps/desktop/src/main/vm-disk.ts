// apps/desktop/src/main/vm-disk.ts
// Story 3B.2: Session overlay disk creation (raw ext4).
//
// Creates a raw ext4 disk image using `truncate` + `mkfs.ext4`.
// This disk serves as the per-VM-session writable overlay, leaving
// the bundle's rootfs.img untouched.
//
// macOS note: mkfs.ext4 is not available by default. The caller should
// ensure the tooling is present (e.g. via brew install e2fsprogs) before
// invoking createSessionDisk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── 常量 ───

/** Default session disk size in MiB */
const DEFAULT_SIZE_MB = 512;

/** Default session image path (under ~/.paperclip/vm/) */
function defaultSessionPath(): string {
  const paperclipHome = process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip");
  return path.join(paperclipHome, "vm", "sessions", "session.img");
}

// ─── 类型 ───

export interface SessionDiskResult {
  /** Absolute path to the created session disk image */
  path: string;
  /** Disk size in MiB */
  sizeMB: number;
  /** true if the disk was newly created; false if it already existed */
  created: boolean;
}

// ─── 内部：工具检测 ───

/**
 * Check whether `mkfs.ext4` is available on $PATH.
 */
async function hasMkfsExt4(): Promise<boolean> {
  try {
    await execFileAsync("which", ["mkfs.ext4"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether `truncate` is available on $PATH.
 */
async function hasTruncate(): Promise<boolean> {
  try {
    await execFileAsync("which", ["truncate"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ─── 导出：会话磁盘创建 ───

/**
 * Create a session overlay disk image if it doesn't already exist.
 *
 * Workflow:
 *  1. If the target file already exists and is non-empty, return `created: false`.
 *  2. Ensure the parent directory exists.
 *  3. Run `truncate -s <sizeM>M <path>` to create a sparse file.
 *  4. Run `mkfs.ext4 <path>` to format it as ext4.
 *  5. Return `created: true`.
 *
 * Edge cases handled:
 *  - mkfs.ext4 not on $PATH → descriptive error with macOS brew hint.
 *  - truncate not on $PATH → descriptive error.
 *  - Existing file is zero-length → re-create it.
 *  - Parent directory creation failure → propagated error.
 *
 * @param sessionPath - Optional custom path for the session image.
 *                      Defaults to ~/.paperclip/vm/sessions/session.img.
 * @param sizeMB       - Disk size in MiB. Default 512.
 * @returns A {@link SessionDiskResult} describing the disk.
 */
export async function createSessionDisk(
  sessionPath?: string,
  sizeMB?: number,
): Promise<SessionDiskResult> {
  const resolvedPath = path.resolve(sessionPath ?? defaultSessionPath());
  const size = sizeMB ?? DEFAULT_SIZE_MB;

  // 1. Already exists?
  if (fs.existsSync(resolvedPath)) {
    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.isFile() && stat.size > 0) {
        return { path: resolvedPath, sizeMB: size, created: false };
      }
    } catch {
      // Stat failed — we'll try to recreate below.
    }
  }

  // 2. Pre-flight: tool availability
  if (!(await hasTruncate())) {
    throw new Error(
      "truncate not found on PATH. Install coreutils (brew install coreutils) " +
        "or ensure /usr/bin/truncate is available.",
    );
  }
  if (!(await hasMkfsExt4())) {
    throw new Error(
      "mkfs.ext4 not found on PATH. On macOS install e2fsprogs: brew install e2fsprogs. " +
        "On Linux install e2fsprogs via your package manager.",
    );
  }

  // 3. Ensure parent directory
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });

  // 4. Create sparse file
  try {
    await execFileAsync("truncate", ["-s", `${size}M`, resolvedPath], {
      timeout: 10000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`truncate failed for ${resolvedPath}: ${message}`);
  }

  // 5. Format as ext4
  try {
    await execFileAsync("mkfs.ext4", ["-F", resolvedPath], {
      timeout: 30000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clean up the sparse file on format failure so we don't leave a
    // half-created image.
    try {
      fs.unlinkSync(resolvedPath);
    } catch {
      // Best effort cleanup.
    }
    throw new Error(`mkfs.ext4 failed for ${resolvedPath}: ${message}`);
  }

  return { path: resolvedPath, sizeMB: size, created: true };
}
