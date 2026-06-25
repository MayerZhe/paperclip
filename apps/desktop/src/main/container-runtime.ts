// apps/desktop/src/main/container-runtime.ts
// Sprint 3.1: 容器运行时检测 + 引导安装
// 按优先级顺序查找：orbstack（macOS 优先）、docker、colima、podman
// 检测结果缓存到 ~/.paperclip/container-runtime.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

export interface ContainerRuntimeInfo {
  available: string[];
  primary: string | null;
  command: string | null;
}

interface CachedRuntimeInfo {
  detectedAt: string;
  available: string[];
  primary: string | null;
  os: string;
}

// 容器运行时入口定义
interface RuntimeDefinition {
  name: string;
  paths: string[];       // fs.existsSync 检查的二进制路径
}

// ─── 容器运行时定义 ───
// 按优先级排序：orbstack（macOS 最优先）→ docker → colima → podman
const RUNTIME_DEFINITIONS: RuntimeDefinition[] = [
  {
    name: "orbstack",
    paths: [
      "/Applications/OrbStack.app/Contents/MacOS/x86_64/orbstack",
      "/opt/homebrew/bin/orbstack",
    ],
  },
  {
    name: "docker",
    paths: [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
    ],
  },
  {
    name: "colima",
    paths: [
      "/opt/homebrew/bin/colima",
    ],
  },
  {
    name: "podman",
    paths: [
      "/opt/homebrew/bin/podman",
    ],
  },
];

// 缓存文件路径
function cacheFilePath(): string {
  // 在 Electron 环境中使用 app.getPath('home')，在非 Electron 测试环境回退到 os.homedir()
  let home: string;
  try {
    home = app.getPath("home");
  } catch {
    home = os.homedir();
  }
  return path.resolve(home, ".paperclip", "container-runtime.json");
}

// ─── 核心检测逻辑 ───
function scanRuntimes(): { available: string[]; primary: string | null; command: string | null } {
  const available: string[] = [];

  for (const rt of RUNTIME_DEFINITIONS) {
    for (const binPath of rt.paths) {
      if (fs.existsSync(binPath)) {
        available.push(rt.name);
        break; // 一个 runtime 只需一个路径命中
      }
    }
  }

  if (available.length === 0) {
    console.log("[SuperNode Desktop] No container runtime detected");
    return { available: [], primary: null, command: null };
  }

  const primary = available[0];
  const primaryDef = RUNTIME_DEFINITIONS.find((rt) => rt.name === primary);
  const command = primaryDef?.paths.find((p) => fs.existsSync(p)) ?? null;

  console.log(
    `[SuperNode Desktop] Container runtimes: ${available.join(", ")} (primary: ${primary})`,
  );

  return { available, primary, command };
}

// ─── 缓存读写 ───
function writeCache(info: ContainerRuntimeInfo): void {
  const cachePath = cacheFilePath();
  const cacheDir = path.dirname(cachePath);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cache: CachedRuntimeInfo = {
      detectedAt: new Date().toISOString(),
      available: info.available,
      primary: info.primary,
      os: process.platform,
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[SuperNode Desktop] Failed to write container runtime cache:", err);
  }
}

function readCache(): ContainerRuntimeInfo | null {
  const cachePath = cacheFilePath();

  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    const raw = fs.readFileSync(cachePath, "utf-8");
    const cache: CachedRuntimeInfo = JSON.parse(raw);

    if (cache.os !== process.platform) {
      console.log("[SuperNode Desktop] Container runtime cache: OS mismatch, invalidating");
      return null;
    }

    return {
      available: cache.available,
      primary: cache.primary,
      command: cache.available.length > 0
        ? RUNTIME_DEFINITIONS.find((rt) => rt.name === cache.primary)
            ?.paths.find((p) => fs.existsSync(p)) ?? null
        : null,
    };
  } catch (err) {
    console.warn("[SuperNode Desktop] Failed to read container runtime cache:", err);
    return null;
  }
}

// ─── 导出接口 ───

/**
 * 检测可用的容器运行时。
 * 按优先级顺序查找：orbstack（macOS 优先）、docker、colima、podman。
 * 检测完成后自动缓存结果到 ~/.paperclip/container-runtime.json。
 */
export function detectContainerRuntime(): ContainerRuntimeInfo {
  const result = scanRuntimes();
  const info: ContainerRuntimeInfo = {
    available: result.available,
    primary: result.primary,
    command: result.command,
  };
  writeCache(info);
  return info;
}

/**
 * 获取上次缓存的容器运行时信息。
 * 如果缓存不存在或 OS 不匹配（跨平台迁移），返回 null。
 */
export function getCachedRuntimeInfo(): ContainerRuntimeInfo | null {
  return readCache();
}
