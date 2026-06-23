// apps/desktop/src/main/vm-bundle.ts
// Story 3B.2: VM bundle detection and path resolution
//
// Provides functions to check whether the VM bundle is ready and
// resolve paths to bundle files following the canonical layout:
//
//   ~/.paperclip/vm/bundle/
//   ├── rootfs.img        # Alpine rootfs (read-only)
//   ├── agent.img         # exFAT with sdk-daemon binary
//   └── manifest.json     # { "version": "...", "files": {...} }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── 常量 ───

/** VM home directory root */
const VM_HOME = path.resolve(
  process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"),
  "vm",
);

/** Bundle directory under VM_HOME */
const VM_BUNDLE_DIR = path.join(VM_HOME, "bundle");

/** Required image file names that must exist in the bundle directory */
const REQUIRED_IMAGES = ["rootfs.img", "agent.img"] as const;

// ─── 导出：路径解析 ───

/**
 * Get the VM bundle directory path.
 *
 * Uses PAPERCLIP_HOME env var if set; otherwise defaults to ~/.paperclip/vm/bundle/.
 *
 * @returns Absolute path to the VM bundle directory.
 */
export function getVmBundleDir(): string {
  return VM_BUNDLE_DIR;
}

/**
 * Get the path to the root filesystem image (Alpine rootfs, read-only).
 *
 * @returns Absolute path to rootfs.img in the bundle directory.
 */
export function getRootfsPath(): string {
  return path.join(VM_BUNDLE_DIR, "rootfs.img");
}

/**
 * Get the path to the agent image (exFAT with sdk-daemon binary).
 *
 * @returns Absolute path to agent.img in the bundle directory.
 */
export function getAgentImgPath(): string {
  return path.join(VM_BUNDLE_DIR, "agent.img");
}

// ─── 导出：就绪检查 ───

/**
 * Check whether the VM bundle is ready for use.
 *
 * A bundle is considered ready when:
 *   1. The bundle directory exists.
 *   2. Both rootfs.img and agent.img are present and non-empty.
 *   3. manifest.json exists (optional — logged but not required for readiness).
 *
 * @returns `true` if both required images exist and are non-empty.
 */
export function isVmBundleReady(): boolean {
  if (!fs.existsSync(VM_BUNDLE_DIR)) {
    return false;
  }

  for (const name of REQUIRED_IMAGES) {
    const fullPath = path.join(VM_BUNDLE_DIR, name);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size === 0) {
        return false;
      }
    } catch {
      // File missing or permission error — not ready.
      return false;
    }
  }

  // manifest.json is optional but worth logging if missing.
  const manifestPath = path.join(VM_BUNDLE_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.warn(
      `[vm-bundle] manifest.json not found in ${VM_BUNDLE_DIR}. Bundle may be incomplete.`,
    );
  }

  return true;
}
