// apps/desktop/src/__tests__/vm-disk.test.ts
// Story 3C4: Unit tests for session overlay disk creation.
//
// Tests the vm-disk.ts module:
//   - createSessionDisk behavior when disk already exists
//   - createSessionDisk with custom path and size
//   - Tool not found error handling

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — use vi.hoisted() for the mutable mock objects
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// execFile mock must be callback-based for promisify() to work correctly.
// promisify(execFile) expects: execFile(cmd, args, opts, cb) where cb(err, result)
function createCallBackExecFile() {
  return vi.fn((cmd: string, args: string[], opts: any, cb?: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (cmd === "which") {
      const target = args[0];
      if (target === "truncate_missing" || target === "mkfs.ext4_missing") {
        callback(new Error("not found"));
      } else {
        callback(null, { stdout: `/usr/bin/${target}` });
      }
    } else {
      callback(null, { stdout: "" });
    }
  });
}

const mockExecFile = vi.hoisted(() => createCallBackExecFile());

vi.mock("node:fs", () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  statSync: mockFs.statSync,
  mkdirSync: mockFs.mkdirSync,
  unlinkSync: mockFs.unlinkSync,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.stubEnv("PAPERCLIP_HOME", "/tmp/test-paperclip");

import { createSessionDisk } from "../main/vm-disk.js";

describe("vm-disk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Existing disk ───

  describe("createSessionDisk", () => {
    it("returns created: false when file already exists and is non-empty", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        isFile: () => true,
        size: 102400,
      } as any);

      const result = await createSessionDisk();
      expect(result.created).toBe(false);
      expect(result.sizeMB).toBe(512); // default size
      expect(result.path).toContain("session.img");
    });

    it("returns the custom path in the result", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        isFile: () => true,
        size: 102400,
      } as any);

      const result = await createSessionDisk("/custom/path/session.img");
      expect(result.path).toBe("/custom/path/session.img");
      expect(result.created).toBe(false);
    });

    it("respects custom sizeMB in the result", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        isFile: () => true,
        size: 2048,
      } as any);

      const result = await createSessionDisk(undefined, 1024);
      expect(result.sizeMB).toBe(1024);
      expect(result.created).toBe(false);
    });

    // ─── Tool availability checks ───

    it("throws when truncate is not found on PATH", async () => {
      mockFs.existsSync.mockReturnValue(false); // file doesn't exist

      // Override the which behavior: make truncate fail
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, cb?: any) => {
          const callback = typeof opts === "function" ? opts : cb;
          if (cmd === "which" && args[0] === "truncate") {
            callback(new Error("not found"));
          } else {
            callback(null, { stdout: "/usr/bin/found" });
          }
        },
      );

      await expect(createSessionDisk()).rejects.toThrow(/truncate not found/);
    });

    it("throws when mkfs.ext4 is not found on PATH", async () => {
      mockFs.existsSync.mockReturnValue(false);

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, cb?: any) => {
          const callback = typeof opts === "function" ? opts : cb;
          if (cmd === "which" && args[0] === "mkfs.ext4") {
            callback(new Error("not found"));
          } else {
            callback(null, { stdout: "/usr/bin/found" });
          }
        },
      );

      await expect(createSessionDisk()).rejects.toThrow(/mkfs\.ext4 not found/);
    });

    // ─── Successful creation ───

    it("creates disk with truncate and mkfs.ext4 when file does not exist", async () => {
      mockFs.existsSync.mockReturnValue(false);

      // Explicitly set the mock implementation to ensure tools are found
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, cb?: any) => {
          const callback = typeof opts === "function" ? opts : cb;
          callback(null, { stdout: cmd === "which" ? `/usr/bin/${args[0]}` : "" });
        },
      );

      const result = await createSessionDisk("/tmp/test/session.img", 256);

      expect(result.created).toBe(true);
      expect(result.sizeMB).toBe(256);
      expect(result.path).toBe("/tmp/test/session.img");

      // Verify parent directory creation
      expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/test", { recursive: true });

      // Verify truncate was called with correct args
      const truncateCalls = mockExecFile.mock.calls.filter(
        (call: any) => call[0] === "truncate",
      );
      expect(truncateCalls.length).toBeGreaterThanOrEqual(1);
      const truncateCall = truncateCalls[0]!;
      expect(truncateCall[1]).toEqual(["-s", "256M", "/tmp/test/session.img"]);

      // Verify mkfs.ext4 was called
      const mkfsCalls = mockExecFile.mock.calls.filter(
        (call: any) => call[0] === "mkfs.ext4",
      );
      expect(mkfsCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
