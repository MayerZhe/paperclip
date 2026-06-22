// apps/desktop/src/main/file-bridge.ts
// Story 1.7: 宿主机 ↔ VM 共享目录工具函数
//
// 共享目录: ~/.paperclip/vm/shared/
// 安全约束:
//   - path traversal 防护 (path.resolve + 前缀检查)
//   - fileName 只允许 [a-zA-Z0-9._-]
//   - writeSharedFile 单文件最大 100MB
//   - 所有操作限制在共享目录内

import fs from "node:fs";
import path from "node:path";

// ─── 常量 ───
const SHARED_DIR_SEGMENT = ["vm", "shared"].join(path.sep);
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const VALID_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;

// ─── 导出接口 ───

export interface SharedFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

// ─── 内部工具函数 ───

/**
 * 根据 homeDir 解析共享目录绝对路径
 */
function resolveSharedDir(homeDir: string): string {
  return path.resolve(homeDir, SHARED_DIR_SEGMENT);
}

/**
 * 解析共享目录下的文件绝对路径，并执行安全检查。
 * 返回 { resolved: 绝对路径, sharedDir: 共享目录绝对路径 }
 * 如果 fileName 非法或路径逃逸则抛错。
 */
function resolveSafePath(
  homeDir: string,
  fileName: string,
): { resolved: string; sharedDir: string } {
  if (!VALID_FILENAME_RE.test(fileName)) {
    throw new Error(
      `Invalid file name: "${fileName}". Only alphanumeric, hyphens, underscores, and dots are allowed.`,
    );
  }

  const sharedDir = resolveSharedDir(homeDir);
  const resolved = path.resolve(sharedDir, fileName);

  // path traversal 防护：确保解析后的路径以共享目录开头
  // path.resolve + sep 确保 "/vm/shared/../escape" 也被检测
  if (!resolved.startsWith(sharedDir + path.sep) && resolved !== sharedDir) {
    throw new Error(
      `Path traversal detected: "${fileName}" resolves outside shared directory.`,
    );
  }

  return { resolved, sharedDir };
}

// ─── 公开 API ───

/**
 * 确保共享目录存在（不存在则自动创建）。
 * @returns 共享目录的绝对路径
 */
export function ensureSharedDir(homeDir: string): string {
  const dir = resolveSharedDir(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 读取共享目录下的文件列表。
 * 目录不存在返回空数组。
 */
export function readSharedDir(homeDir: string): SharedFile[] {
  const dir = resolveSharedDir(homeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: SharedFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // 文件可能在 readdir 后被删除，跳过
    }
  }

  return results;
}

/**
 * 将内容写入共享目录下的文件。
 * 目录不存在自动创建。内容超过 100MB 抛错。
 * @returns 写入文件的绝对路径
 */
export function writeSharedFile(
  homeDir: string,
  fileName: string,
  content: Buffer | string,
): string {
  const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;

  if (data.length > MAX_FILE_SIZE) {
    throw new Error(
      `File size ${data.length} bytes exceeds maximum ${MAX_FILE_SIZE} bytes (100MB).`,
    );
  }

  const { resolved, sharedDir } = resolveSafePath(homeDir, fileName);

  // 确保共享目录存在
  fs.mkdirSync(sharedDir, { recursive: true });

  fs.writeFileSync(resolved, data);
  return resolved;
}

/**
 * 读取共享目录下的文件内容。
 */
export function readSharedFile(homeDir: string, fileName: string): Buffer {
  const { resolved } = resolveSafePath(homeDir, fileName);
  return fs.readFileSync(resolved);
}

/**
 * 删除共享目录下的文件。
 * @returns true 如果文件存在并成功删除，false 如果文件不存在
 */
export function deleteSharedFile(homeDir: string, fileName: string): boolean {
  const { resolved } = resolveSafePath(homeDir, fileName);
  if (!fs.existsSync(resolved)) {
    return false;
  }
  fs.unlinkSync(resolved);
  return true;
}
