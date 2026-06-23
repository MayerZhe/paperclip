// apps/desktop/src/__tests__/vm-bundle.test.ts
// Story 3C4: Unit tests for VM bundle detection and path resolution.
//
// Tests the vm-bundle.ts module:
//   - Path resolution functions (getVmBundleDir, getRootfsPath, getAgentImgPath)
//   - Readiness check (isVmBundleReady)

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — use vi.hoisted() for the mutable mock object
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  statSync: mockFs.statSync,
}));

// Note: PAPERCLIP_HOME is resolved at module load time via path.resolve().
// We use the default os.homedir() fallback in initial import, then test
// the PAPERCLIP_HOME override behavior via dynamic re-import.

import {
  getVmBundleDir as getVmBundleDirDefault,
  getRootfsPath,
  getAgentImgPath,
  isVmBundleReady,
} from "../main/vm-bundle.js";

describe("vm-bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Path resolution ───

  describe("getVmBundleDir", () => {
    it("returns path ending in /vm/bundle", () => {
      const dir = getVmBundleDirDefault();
      expect(dir).toContain("/vm/bundle");
      expect(dir.endsWith("/vm/bundle")).toBe(true);
    });

    it("uses PAPERCLIP_HOME env var when set", async () => {
      // Re-import the module with PAPERCLIP_HOME set
      vi.stubEnv("PAPERCLIP_HOME", "/tmp/test-paperclip");
      vi.resetModules();
      const { getVmBundleDir } = await import("../main/vm-bundle.js");
      const dir = getVmBundleDir();
      expect(dir).toBe("/tmp/test-paperclip/vm/bundle");
      vi.unstubAllEnvs();
    });
  });

  describe("getRootfsPath", () => {
    it("returns path ending in /vm/bundle/rootfs.img", () => {
      const p = getRootfsPath();
      expect(p).toContain("/vm/bundle/rootfs.img");
      expect(p.endsWith("rootfs.img")).toBe(true);
    });
  });

  describe("getAgentImgPath", () => {
    it("returns path ending in /vm/bundle/agent.img", () => {
      const p = getAgentImgPath();
      expect(p).toContain("/vm/bundle/agent.img");
      expect(p.endsWith("agent.img")).toBe(true);
    });
  });

  // ─── Readiness check: isVmBundleReady ───

  describe("isVmBundleReady", () => {
    it("returns false when bundle directory does not exist", () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(isVmBundleReady()).toBe(false);
    });

    it("returns false when rootfs.img is missing", () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith("/vm/bundle")) return true;
        if (p.endsWith("rootfs.img")) return false;
        return false;
      });
      mockFs.statSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(isVmBundleReady()).toBe(false);
    });

    it("returns false when agent.img is empty (size 0)", () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith("/vm/bundle")) return true;
        if (p.includes("rootfs.img") || p.includes("agent.img")) return true;
        if (p.includes("manifest.json")) return false;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("rootfs.img")) {
          return { isFile: () => true, size: 1024 } as any;
        }
        if (typeof p === "string" && p.includes("agent.img")) {
          return { isFile: () => true, size: 0 } as any;
        }
        throw new Error("stat failed");
      });
      expect(isVmBundleReady()).toBe(false);
    });

    it("returns false when rootfs.img has size 0", () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith("/vm/bundle")) return true;
        if (p.includes("rootfs.img") || p.includes("agent.img")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("rootfs.img")) {
          return { isFile: () => true, size: 0 } as any;
        }
        if (typeof p === "string" && p.includes("agent.img")) {
          return { isFile: () => true, size: 2048 } as any;
        }
        throw new Error("stat failed");
      });
      expect(isVmBundleReady()).toBe(false);
    });

    it("returns true when both rootfs.img and agent.img exist and are non-empty", () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith("/vm/bundle")) return true;
        if (p.includes("rootfs.img")) return true;
        if (p.includes("agent.img")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("rootfs.img")) {
          return { isFile: () => true, size: 1048576 } as any;
        }
        if (typeof p === "string" && p.includes("agent.img")) {
          return { isFile: () => true, size: 524288 } as any;
        }
        throw new Error("stat failed");
      });
      expect(isVmBundleReady()).toBe(true);
    });

    it("returns false when rootfs.img exists but is not a regular file", () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith("/vm/bundle")) return true;
        if (p.includes("rootfs.img")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("rootfs.img")) {
          return { isFile: () => false, size: 100 } as any;
        }
        throw new Error("stat failed");
      });
      expect(isVmBundleReady()).toBe(false);
    });
  });
});
