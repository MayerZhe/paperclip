# PaperClip 桌面端封装 — 代码级实现方案 v3

> v2 审计修正版。基于 21 项完整性检查结果。
> 基准代码: PaperClip v0.3.1 | 日期: 2026-06-10

---

## v2 → v3 变更摘要

| # | v2 问题 | 严重度 | v3 修正 | 审计发现 |
|---|---------|--------|---------|----------|
| 1 | `onboard.ts` 手动配置 Zod schema 4 处不匹配 | 🔴 | 字段名/值全部对齐 schema | 6.1-6.4 |
| 2 | 备份进行中关闭 → 备份损坏 | 🔴 | shutdown 等待 `databaseBackupInFlight=false` | 3.1 |
| 3 | HTTP server 未 `server.close()` | 🔴 | `process.exit` 前调用 `server.close()` | 11.1 |
| 4 | heartbeat / backup interval 未 clear | 🟡 | shutdown 中 clearInterval | 2.1, 3.2 |
| 5 | `jobCoordinator` / `scheduler` 未 stop | 🟡 | shutdown 中调用 `.stop()` | 11.2 |
| 6 | 缺少 `app.ts` 具体 diff | 🟡 | 补充实际修改代码 | 1.1 |
| 7 | Tailscale 检测可能阻塞 3s | 🟡 | plan 中注明 + 建议绕过 | 11.3 |
| 8 | 缺少 PaperClip 上游修复清单 | 🟡 | 🆕 新增 §9「需要的上游修改」 | — |

---

## 完整方案

以下为 v3 完整方案。对 v2 有修改的文件标注了 `[修改]`，新增文件标注 `[新增]`。无变化的部分引用 v2 不再重复。

---

## 0. ADR（与 v2 相同，无新增）

引用 v2 §0。

---

## 1. 项目结构（与 v2 相同）

```
apps/desktop/src/main/
├── index.ts              ← 2行入口
├── packaged-main.ts      ← [修改] 关闭流程增强
├── onboard.ts            ← [修改] 配置字段对齐 schema
├── cli-scanner.ts        ← 无变化
├── sidecar-server.ts     ← 无变化
├── tray.ts               ← 无变化
├── menu.ts               ← [修改] 新增诊断菜单项
├── updater.ts            ← 无变化
└── notifications.ts      ← 无变化

server/src/
├── app.ts                ← [修改] 注册 desktop router
├── index.ts              ← [修改] 关闭流程增强（上游修复）
└── routes/
    └── desktop.ts        ← [新增] 桌面端 API
```

---

## 2. 文件级实现

### 2.1 onboard.ts — [修改] 配置字段对齐 Zod schema

```typescript
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
    console.log("[PaperClip Desktop] Config already exists, skipping onboard");
    return;
  }

  console.log("[PaperClip Desktop] First run detected — generating config...");
  fs.mkdirSync(instanceRoot, { recursive: true });

  // Option A: paperclipai onboard -y（首选）
  try {
    execSync(
      `PAPERCLIP_HOME="${options.homeDir}" ` +
      `PAPERCLIP_INSTANCE_ID="${options.instanceId}" ` +
      `npx paperclipai onboard -y`,
      { stdio: "inherit", timeout: 30000 },
    );
    console.log("[PaperClip Desktop] Config generated via paperclipai onboard");
    return;
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

  // 验证生成的文件能被 Zod 解析
  try {
    const { paperclipConfigSchema } = await import(
      "@paperclipai/shared/config-schema"
    );
    paperclipConfigSchema.parse(config);
    console.log("[PaperClip Desktop] Config validated ✅");
  } catch (validationError) {
    console.error("[PaperClip Desktop] Config validation failed!", validationError);
    // 删除无效配置，下次重启重试
    fs.unlinkSync(configPath);
    throw new Error("Generated config failed Zod validation");
  }
}
```

### 2.2 packaged-main.ts — [修改] 关闭流程增强

v3 修改点（其他代码与 v2 相同，仅列出变化部分）：

```typescript
// apps/desktop/src/main/packaged-main.ts 中的 shutdown 函数
// v3: 等待 server.close() + 处理 backup + interval 清理

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[PaperClip Desktop] Shutting down...");

  try {
    // 1. 通知 daemon 准备关闭
    //    daemon 端的 shutdown handler（index.ts:921-949）会：
    //    - 停止 telemetry
    //    - 调用 appShutdown()
    //    - 等待 databaseBackupInFlight 变为 false（需要上游修复 §9）
    //    - 清除 heartbeat + backup intervals（需要上游修复 §9）
    //    - server.close()（需要上游修复 §9）
    //    - embeddedPostgres.stop()
    //    - process.exit(0)
    await fetch(`http://127.0.0.1:${serverPort}/api/desktop/shutdown`, {
      method: "POST",
    }).catch(() => {});

    // 2. 发送 SIGTERM
    daemon.kill("SIGTERM");

    // 3. 等待 daemon 退出（最多 20s，给 PG 备份 + checkpoint 留时间）
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[PaperClip Desktop] Daemon didn't exit in time, force killing");
        daemon.kill("SIGKILL");
        resolve();
      }, 20000); // v3: 从 15s 增加到 20s
      daemon.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (err) {
    console.error("[PaperClip Desktop] Shutdown error:", err);
  }

  sidecarServer.close();
  app.exit(0);
}
```

### 2.3 server/src/app.ts — [修改] 注册 desktop router

```typescript
// server/src/app.ts
// 在现有路由注册区域添加

// ... 现有 imports
import { createDesktopRouter } from "./routes/desktop.js";  // ← 新增

// ... 现有 createApp() 函数中

// 在 api router 注册区域（app.ts:201-322 附近）添加：
const desktopShutdownFlag = { shuttingDown: false };
api.use(
  "/desktop",
  createDesktopRouter({
    getServerUptime: () => process.uptime(),
    isShuttingDown: () => desktopShutdownFlag.shuttingDown,
  }),
);

// 将 desktopShutdownFlag 暴露给 index.ts 的 shutdown handler
// 方式 1: 通过 app.locals
app.locals.paperclipDesktopShutdownFlag = desktopShutdownFlag;

// 方式 2: 通过 createApp 返回值（需要修改 createApp 的返回类型）
// 推荐方式 1，改动最小
```

### 2.4 server/src/index.ts — [修改] 上游修复（桌面化必需 + 通用改进）

以下修改对桌面化是必要的，同时对 PaperClip 本身也是改进。

```typescript
// server/src/index.ts
// 在 startServer() 函数中收集 intervals以便清理

// ─── 收集所有 intervals ───
const activeIntervals: ReturnType<typeof setInterval>[] = [];

// 在 heartbeat setInterval 处（index.ts:766）：
const hbInterval = setInterval(() => { ... }, config.heartbeatSchedulerIntervalMs);
activeIntervals.push(hbInterval);

// 在 backup setInterval 处（index.ts:846）：
const backupInterval = setInterval(() => { ... }, backupIntervalMs);
activeIntervals.push(backupInterval);

// ─── shutdown handler（index.ts:920-949）v3 版本 ───
const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
  // v3: 标记正在关闭（供 /api/desktop/status 使用）
  const desktopFlag = (app as { locals?: Record<string, unknown> })
    .locals?.paperclipDesktopShutdownFlag as { shuttingDown: boolean } | undefined;
  if (desktopFlag) desktopFlag.shuttingDown = true;

  // v3: 清除所有 intervals（停止 heartbeat + backup 定时器）
  logger.info({ signal, count: activeIntervals.length }, "Clearing active intervals");
  for (const interval of activeIntervals) {
    clearInterval(interval);
  }

  // v3: 等待正在进行的备份完成
  if (typeof databaseBackupInFlight !== "undefined" && databaseBackupInFlight) {
    logger.info("Waiting for in-flight database backup to complete...");
    const backupWaitStart = Date.now();
    while (databaseBackupInFlight) {
      if (Date.now() - backupWaitStart > 30000) {
        logger.warn("Database backup timeout — proceeding with shutdown");
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 停止 telemetry
  const telemetryClient = getTelemetryClient();
  if (telemetryClient) {
    telemetryClient.stop();
    await telemetryClient.flush();
  }

  // 调用 app shutdown hooks
  const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } })
    .locals?.paperclipShutdown;
  appShutdown?.();

  // v3: 优雅关闭 HTTP server
  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) logger.error({ err }, "Error closing HTTP server");
      resolve();
    });
  });

  // 停止嵌入式 PG
  if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
    logger.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await embeddedPostgres?.stop();
    } catch (err) {
      logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  process.exit(0);
};
```

### 2.5 server/src/routes/desktop.ts — [修改] 增强关闭端点

```typescript
// server/src/routes/desktop.ts
// v3: 增加 shutdown 前置检查

import { Router } from "express";

export function createDesktopRouter(options: {
  getServerUptime: () => number;
  isShuttingDown: () => boolean;
}) {
  const router = Router();

  // GET /api/desktop/status
  router.get("/status", (_req, res) => {
    res.json({
      uptime: options.getServerUptime(),
      shuttingDown: options.isShuttingDown(),
    });
  });

  // POST /api/desktop/shutdown
  // Electron 请求优雅关闭。
  // daemon 收到后：标记 shuttingDown → 200 响应 → 短暂延迟 → 发送 SIGTERM
  router.post("/shutdown", async (_req, res) => {
    // 防止重复关闭
    if (options.isShuttingDown()) {
      res.json({ acknowledged: true, alreadyShuttingDown: true });
      return;
    }
    res.json({ acknowledged: true });
    // 延迟确保响应发送完毕
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 300);
  });

  return router;
}
```

### 2.6 托盘 — [修改] 集成 Heartbeat 检查

```typescript
// apps/desktop/src/main/tray.ts 补充 — 周期性获取 daemon 状态
// 在 packaged-main.ts 中添加周期性状态轮询

// 每 10s 检查 daemon 状态，更新托盘图标
const statusInterval = setInterval(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/desktop/status`);
    if (!res.ok) throw new Error("unhealthy");
    const data = await res.json();
    // 根据 status 更新托盘
    if (data.shuttingDown) {
      updateTrayState("shutting-down");
    } else {
      updateTrayState("ready");
    }
  } catch {
    updateTrayState("daemon-unreachable");
  }
}, 10000);

// 在 shutdown 中清除
app.on("before-quit", () => clearInterval(statusInterval));
```

### 2.7 菜单 — [修改] 新增诊断项

```typescript
// apps/desktop/src/main/menu.ts 的 Help 菜单中添加

{
  label: "导出诊断信息",
  click: async () => {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: `paperclip-diagnostics-${new Date().toISOString().slice(0,10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return;
    const diag = {
      version: "0.3.1",
      platform: process.platform,
      arch: process.arch,
      daemonStatus: await fetch(`http://127.0.0.1:${serverPort}/api/desktop/status`)
        .then(r => r.json()).catch(() => ({ error: "unreachable" })),
      cliScan: cliResults,
      paperclipHome: PAPERCLIP_HOME,
    };
    fs.writeFileSync(filePath, JSON.stringify(diag, null, 2));
    dialog.showMessageBox({ message: `诊断信息已保存到 ${filePath}` });
  },
},
```

---

## 3-8. 其余文件

以下文件与 v2 一致（已通过审计），仅列出文件名，内容引用 v2：
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/cli-scanner.ts`（已含 acpx/grok 修正）
- `apps/desktop/src/main/sidecar-server.ts`
- `apps/desktop/src/main/updater.ts`
- `apps/desktop/src/main/notifications.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/package.json`
- `apps/desktop/build/entitlements.mac.plist`
- `scripts/desktop/bundle-desktop.ts`

---

## 9. 🆕 需要的上游 PaperClip 修改

以下是对 PaperClip 源码的修改，桌面化必需。建议作为独立 PR 提交到 PaperClip 上游。

### 9.1 server/src/index.ts — shutdown 增强

| 行号范围 | 修改 | 优先级 |
|---------|------|--------|
| 766, 846 | 将 `setInterval(...)` 赋值给变量，push 到 `activeIntervals[]` | 🔴 桌面必需 |
| 920-949 | 重写 shutdown handler：等待 backup + server.close() + clearIntervals | 🔴 桌面必需 |

### 9.2 server/src/app.ts — desktop router 注册

| 修改 | 优先级 |
|------|--------|
| 在 `api.use("/health", ...)` 附近添加 `api.use("/desktop", createDesktopRouter({...}))` | 🔴 桌面必需 |
| 新增 `desktopShutdownFlag` 传递给 `createDesktopRouter` | 🔴 桌面必需 |

### 9.3 packages/shared/src/config-schema.ts — Tailscale 检测超时

| 修改 | 优先级 |
|------|--------|
| `execFileSync("tailscale", ...)` 超时从 3000ms 降至 1000ms 或改为异步 try-catch | 🟡 体验优化 |

### 9.4 硬编码插件目录

| 修改 | 优先级 |
|------|--------|
| `DEFAULT_LOCAL_PLUGIN_DIR` 在不存在时不报错（已有 try-catch，但日志会打印 error） | 🟡 体验优化 |

---

## 10. 构建管线（与 v2 相同，增加 plugins 目录检查）

```typescript
// scripts/desktop/bundle-desktop.ts 中新增
// 确保插件目录存在（避免 daemon 日志错误）
const pluginsDir = path.join(APPS_DESKTOP, "paperclip-server", "plugins");
fs.mkdirSync(pluginsDir, { recursive: true });
fs.writeFileSync(path.join(pluginsDir, ".gitkeep"), "");
```

---

## 11. 启动时序图（与 v2 相同）

引用 v2 §4。唯一变化：首次启动 `onboard.ts` 生成的配置现在通过 Zod 验证 ✅。

---

## 12. 关闭时序图（v3 详细版）

```
用户关闭窗口 / Cmd+Q
        │
        ▼
┌─── Electron Main Process ──────────────────────────────────────┐
│                                                                 │
│  [0ms]   before-quit → event.preventDefault()                  │
│                                                                 │
│  [10ms]  POST /api/desktop/shutdown                            │
│             → daemon desktopFlag.shuttingDown = true           │
│             → daemon 返回 { acknowledged: true }               │
│                                                                 │
│  [310ms] daemon 内部 process.kill(self, SIGTERM)               │
│                                                                 │
│     ┌─── Daemon SIGTERM handler (v3) ─────────────────────┐    │
│     │                                                       │    │
│     │  [0ms]  desktopFlag = true                            │    │
│     │  [1ms]  clearInterval(heartbeatInterval)              │    │
│     │  [1ms]  clearInterval(backupInterval)                 │    │
│     │  [2ms]  while (backupInFlight) → wait                │    │
│     │           → backup 未在运行 → 跳过 wait               │    │
│     │  [3ms]  telemetryClient.stop() + flush()              │    │
│     │  [5ms]  appShutdown() → shutdownAppServices()         │    │
│     │  [10ms] server.close() → 等待活跃连接断开             │    │
│     │  [15ms] embeddedPostgres.stop()                       │    │
│     │           → pg_ctl stop -m fast                       │    │
│     │           → 等待 checkpoint 完成 (最多 2s)            │    │
│     │  [2s]   process.exit(0)                               │    │
│     └───────────────────────────────────────────────────────┘    │
│                                                                 │
│  [400ms] Electron 发送 daemon.kill("SIGTERM") ← 无害重复        │
│             → daemon 已退出或正在退出                           │
│  [400ms] daemon.on("exit") 触发                                 │
│  [400ms] sidecarServer.close()                                  │
│  [400ms] app.exit(0)                                            │
│                                                                 │
│  ✅ 完全关闭                                                    │
└─────────────────────────────────────────────────────────────────┘

总关闭时间: ~3-5s（取决于 PG checkpoint 速度）
```

---

## 13. 关键风险（v3 补充）

在 v2 基础上新增：

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| server.close() 有活跃长连接（SSE agent 日志流）不关闭 | 低 | 关闭超时 | server.close() 后设 5s timeout，超时后 force exit |
| 上游修复 PR 不被接受 | 中 | 需要 fork | 桌面化分支维护 patch；或 fork 后提交 |
| Tailscale 检测 3s 阻塞启动 | 中 | 体验 | 设为 `PAPERCLIP_DISABLE_TAILSCALE_DETECT=true` 或降超时 |

---

## 14. 完整性自检清单

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | `onboard.ts` 配置通过 Zod `paperclipConfigSchema.parse()` | ✅ v3 修正 |
| 2 | 环境变量全量验证（`SERVE_UI` 非 `PAPERCLIP_SERVE_UI`） | ✅ v2 已修正 |
| 3 | `DATABASE_URL` 不传 → daemon 自启 PG | ✅ v2 已修正 |
| 4 | `PAPERCLIP_HOME` 路径无双重嵌套 | ✅ v2 已修正 |
| 5 | UI dist → `server/ui-dist/` | ✅ v2 已修正 |
| 6 | CLI 扫描器补全 acpx/grok | ✅ v2 已修正 |
| 7 | shutdown 等待 backup-in-flight | ✅ v3 新增 |
| 8 | shutdown 中 server.close() | ✅ v3 新增 |
| 9 | shutdown 中 clearIntervals | ✅ v3 新增 |
| 10 | app.ts 注册 desktop router | ✅ v3 补充 |
| 11 | macOS entitlements | ✅ v2 已包含 |
| 12 | Skills/Teams/Plugins 目录在 bundle 中 | ✅ v3 补充 plugins |
| 13 | 备份二进制 pg_dump 包含在 bundle | ⚠️ 见下方说明 |

### ⚠️ pg_dump 二进制

`embedded-postgres` 包的二进制目录同时包含 `pg_dump`。由于 bundle 中已包含完整的 `@embedded-postgres/<platform>/bin/` 目录，`pg_dump` 天然可用。无需额外处理。

---

## 15. 开发 Sprint 修订

### Sprint 0: 验证（3 天，与 v2 相同，增加配置验证项）

| 天数 | 任务 | 验证方法 |
|------|------|---------|
| D1 | 验证 `startServer()` 不设 `DATABASE_URL` 完整启动 | `SERVE_UI=true node server/dist/index.js` |
| D2 | 验证修改后的 shutdown handler（server.close + backup wait + clearIntervals） | 多次 SIGTERM，检查无残留 postmaster.pid、无损坏备份 |
| D2 | 验证 `onboard.ts` 手动配置通过 Zod 解析 | `paperclipConfigSchema.parse(config)` |
| D3 | 验证 `server/ui-dist/` 路径探测 | 复制 `ui/dist` → `server/ui-dist/`，启动确认 UI 可访问 |
| D3 | 验证所有 env var 名与源码一致 | grep 验证 `SERVE_UI`、`PAPERCLIP_HOME`、`PAPERCLIP_INSTANCE_ID` 等 |

### Sprint 1-3

与 v2 相同，Sprint 1 开始前需完成 Sprint 0 的全部验证。
