// apps/desktop/src/main/onboard.ts
// v3: 修正所有 Zod schema 字段名和值

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface OnboardOptions {
  homeDir: string;      // ~/.paperclip
  instanceId: string;   // "default"
}

export async function ensureFirstRunConfig(options: OnboardOptions): Promise<void> {
  const instanceRoot = path.resolve(options.homeDir, "instances", options.instanceId);
  const configPath = path.resolve(instanceRoot, "config.json");
  const envPath = path.resolve(instanceRoot, ".env");

  if (fs.existsSync(configPath) && fs.existsSync(envPath)) {
    console.log("[SuperNode Desktop] Config already exists, skipping onboard");
    return;
  }

  console.log("[SuperNode Desktop] First run detected — generating config...");
  fs.mkdirSync(instanceRoot, { recursive: true });

  // Option A: paperclipai onboard -y（首选）
  try {
    execSync(
      `PAPERCLIP_HOME="${options.homeDir}" ` +
      `PAPERCLIP_INSTANCE_ID="${options.instanceId}" ` +
      `npx paperclipai onboard -y`,
      { stdio: "inherit", timeout: 60000 },
    );
    console.log("[SuperNode Desktop] Config generated via paperclipai onboard");
    return;
  } catch (err) {
    console.warn("[SuperNode Desktop] paperclipai onboard failed, generating manually");
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
    console.log("[SuperNode Desktop] Config validated ✅");
  } catch (validationError) {
    console.error("[SuperNode Desktop] Config validation failed!", validationError);
    // 删除无效配置，下次重启重试
    fs.unlinkSync(configPath);
    throw new Error("Generated config failed Zod validation");
  }
}
