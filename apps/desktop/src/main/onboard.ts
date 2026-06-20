// apps/desktop/src/main/onboard.ts
// v3: 修正所有 Zod schema 字段名和值
// Story 1.6: 首次启动引导 — 模式偏好存储 + IPC handler

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ipcMain } from "electron";

// ─── 类型定义 ───

export interface OnboardOptions {
  homeDir: string;      // ~/.paperclip
  instanceId: string;   // "default"
}

export interface ModePreference {
  mode: "agent" | "agenthubs";
  selectedAt: string;   // ISO 8601
}

export interface FirstRunResult {
  isFirstRun: boolean;
  mode?: "agent" | "agenthubs";
  configPath: string;
}

// ─── 模式偏好存储 ───

const MODE_PREFERENCE_BASENAME = "mode-preference.json";

function resolveModePreferencePath(homeDir: string, instanceId: string): string {
  return path.resolve(homeDir, "instances", instanceId, MODE_PREFERENCE_BASENAME);
}

export function getModePreference(homeDir: string, instanceId: string = "default"): ModePreference | null {
  const filePath = resolveModePreferencePath(homeDir, instanceId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (
      typeof raw?.mode === "string" &&
      (raw.mode === "agent" || raw.mode === "agenthubs") &&
      typeof raw?.selectedAt === "string"
    ) {
      return raw as ModePreference;
    }
    return null;
  } catch {
    console.warn("[PaperClip Desktop] Failed to parse mode-preference.json, ignoring");
    return null;
  }
}

export function setModePreference(
  homeDir: string,
  mode: "agent" | "agenthubs",
  instanceId: string = "default",
): void {
  const filePath = resolveModePreferencePath(homeDir, instanceId);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const preference: ModePreference = {
    mode,
    selectedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(preference, null, 2), { mode: 0o600 });
  console.log(`[PaperClip Desktop] Mode preference saved: ${mode}`);
}

// ─── 首次启动配置 ───

export async function ensureFirstRunConfig(options: OnboardOptions): Promise<FirstRunResult> {
  const instanceRoot = path.resolve(options.homeDir, "instances", options.instanceId);
  const configPath = path.resolve(instanceRoot, "config.json");
  const envPath = path.resolve(instanceRoot, ".env");

  // 检查已有模式偏好（非首次启动）
  const existingPreference = getModePreference(options.homeDir, options.instanceId);
  if (existingPreference) {
    console.log(`[PaperClip Desktop] Mode preference found: ${existingPreference.mode} (since ${existingPreference.selectedAt})`);

    if (fs.existsSync(configPath) && fs.existsSync(envPath)) {
      console.log("[PaperClip Desktop] Config already exists, skipping onboard");
      return { isFirstRun: false, mode: existingPreference.mode, configPath };
    }

    // 模式偏好存在但 config 缺失 → 仍视为首次启动，但保留 mode
    console.log("[PaperClip Desktop] Mode preference exists but config missing, re-running onboard");
  }

  // 首次启动判定：mode-preference.json 不存在
  const isFirstRun = !existingPreference;

  console.log("[PaperClip Desktop] First run detected — generating config...");
  fs.mkdirSync(instanceRoot, { recursive: true });

  // Option A: paperclipai onboard -y（首选）
  try {
    execSync(
      `PAPERCLIP_HOME="${options.homeDir}" ` +
      `PAPERCLIP_INSTANCE_ID="${options.instanceId}" ` +
      `npx paperclipai onboard -y`,
      { stdio: "inherit", timeout: 60000 },
    );
    console.log("[PaperClip Desktop] Config generated via paperclipai onboard");
    // 首次启动时写入默认模式偏好（agent）
    if (isFirstRun) {
      setModePreference(options.homeDir, "agent", options.instanceId);
    }
    return { isFirstRun, mode: existingPreference?.mode ?? "agent", configPath };
  } catch (err) {
    console.warn("[PaperClip Desktop] paperclipai onboard failed, generating manually");
  }

  // Option B: 手动生成 — 必须严格匹配 Zod paperclipConfigSchema
  // Schema reference: packages/shared/src/config-schema.ts:106-138
  const now = new Date().toISOString();
  const config = {
    "$meta": {
      "version": 1,              // ← 不是 "schemaVersion"
      "updatedAt": now,          // ← 不是 "createdAt"
      "source": "onboard",       // ← 必需字段
    },
    "database": {
      "mode": "embedded-postgres",  // ← 不是 "embedded"
      "embeddedPostgresDataDir": path.resolve(instanceRoot, "db"),
      "embeddedPostgresPort": 54329,
    },
    "server": {
      "deploymentMode": "local_trusted",
      "exposure": "private",
      "host": "127.0.0.1",
      "port": 3100,
      "serveUi": true,
    },
    "logging": {
      "mode": "file",
      "logDir": path.resolve(instanceRoot, "logs"),
    },
    "telemetry": {
      "enabled": false,
    },
    // 以下 section 有 .default()，可省略但显式提供更安全
    "auth": {
      "baseUrlMode": "auto",
    },
    "storage": {
      "provider": "local_disk",
    },
    "secrets": {
      "provider": "local_encrypted",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 验证生成文件的关键字段（替代 Zod parse，避免 workspace 依赖）
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const errors: string[] = [];
    if (parsed?.$meta?.version !== 1) errors.push("$meta.version must be 1");
    if (parsed?.$meta?.source !== "onboard") errors.push("$meta.source must be 'onboard'");
    if (parsed?.database?.mode !== "embedded-postgres") errors.push("database.mode must be 'embedded-postgres'");
    if (typeof parsed?.database?.embeddedPostgresPort !== "number") errors.push("database.embeddedPostgresPort required");
    if (typeof parsed?.database?.embeddedPostgresDataDir !== "string") errors.push("database.embeddedPostgresDataDir required");
    if (errors.length > 0) {
      throw new Error(`Config validation failed: ${errors.join("; ")}`);
    }
    console.log("[PaperClip Desktop] Config validated ✅");
  } catch (validationError) {
    console.error("[PaperClip Desktop] Config validation failed!", validationError);
    // 删除无效配置，下次重启重试
    fs.unlinkSync(configPath);
    throw new Error("Generated config failed Zod validation");
  }

  // 首次启动时写入默认模式偏好（agent）
  if (isFirstRun) {
    setModePreference(options.homeDir, "agent", options.instanceId);
  }

  return { isFirstRun, mode: existingPreference?.mode ?? "agent", configPath };
}

// ─── IPC handler 注册 ───

export function registerOnboardingIPC(): void {
  ipcMain.on(
    "onboarding:select-mode",
    (_event, mode: unknown) => {
      if (mode !== "agent" && mode !== "agenthubs") {
        console.warn(`[PaperClip Desktop] Invalid mode received via IPC: ${String(mode)}`);
        return;
      }

      const homeDir = process.env.PAPERCLIP_HOME;
      if (!homeDir) {
        console.error("[PaperClip Desktop] PAPERCLIP_HOME not set, cannot persist mode preference");
        return;
      }

      const instanceId = process.env.PAPERCLIP_INSTANCE_ID || "default";
      setModePreference(homeDir, mode, instanceId);
      console.log(`[PaperClip Desktop] IPC: mode set to ${mode}`);
    },
  );
}
