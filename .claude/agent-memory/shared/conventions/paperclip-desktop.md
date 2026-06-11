---
name: paperclip-desktop
description: PaperClip Desktop development conventions — Electron patterns, daemon lifecycle, shutdown protocol, build pipeline
metadata:
  type: convention
  shared: true
---

# PaperClip Desktop Development Conventions

> 基于 v3 实施计划。桌面端开发在 `supernode-desktop/` 目录下进行。

## 1. Electron 壳原则

- **Electron 壳要极薄** — main process 只做 spawn + 窗口管理
- 业务逻辑全在 daemon 子进程，Electron 主进程不 import 任何 PaperClip 业务代码
- 2 行入口模式：`index.ts` → `import("./packaged-main.js")`
- **不用 asar** — 纯文件目录分发（嵌入式 PG 二进制无法从 asar 运行）
- **不加 Electron IPC 协议** — 已有 40+ REST routes

## 2. Daemon 生命周期管理

- Electron **不管理 PostgreSQL** — `startServer()` 自管 `embeddedPostgres`
- **不传 `DATABASE_URL`** 给 daemon → daemon 走嵌入式 PG 分支
- 首次启动：`ensureFirstRunConfig()` → `paperclipai onboard -y`（fallback: 手动生成 Zod-validated config）
- Sidecar Unix Socket 仅用于进程间生命期信号（STATUS / NOTIFY / SHUTDOWN），不承载业务数据

## 3. 优雅关闭协议（v3 增强版）

```
Electron before-quit →
  1. POST /api/desktop/shutdown → daemon 标记 shuttingDown
  2. daemon SIGTERM handler:
     - clearIntervals (heartbeat + backup)
     - wait for backup-in-flight (max 30s)
     - telemetryClient.flush()
     - server.close()
     - embeddedPostgres.stop()
     - process.exit(0)
  3. Electron: daemon.kill("SIGTERM") → 等待 exit (max 20s) → SIGKILL fallback
  4. sidecarServer.close()
  5. app.exit(0)
```

## 4. 配置生成（onboard.ts）

- 首选 `paperclipai onboard -y` 生成标准 config.json
- Fallback 手动生成时必须严格匹配 Zod `paperclipConfigSchema`
- 关键字段名（v2 已修 → v3 再确认）：
  - `$meta.version`（不是 `schemaVersion`）
  - `$meta.updatedAt`（不是 `createdAt`）
  - `$meta.source: "onboard"`（必需）
  - `database.mode: "embedded-postgres"`（不是 `"embedded"`）
- 生成后必须通过 `paperclipConfigSchema.parse()` 验证
- 验证失败 → 删除 config.json → 下次重试

## 5. 环境变量对照表

**桌面端必须设置**：
- `PAPERCLIP_HOME=~/.paperclip`（不是 instance root！）
- `PAPERCLIP_INSTANCE_ID=default`
- `SERVE_UI=true`（⚠️ 不是 `PAPERCLIP_SERVE_UI`！）
- `PAPERCLIP_MIGRATION_AUTO_APPLY=true`
- `PAPERCLIP_OPEN_ON_LISTEN=false`

**桌面端禁止设置**：
- `DATABASE_URL` — 不设，让 daemon 自启 PG
- `PAPERCLIP_UI_DIST_DIR` — 不存在此变量，app.ts 自动探测 `../ui-dist`

## 6. UI Dist 路径

- 打包：复制 `ui/dist` → `paperclip-server/ui-dist/`
- 开发：符号链接 `server/ui-dist → ../ui/dist`
- `app.ts` 硬编码探测 `../ui-dist`（从 `server/dist/` 出发）

## 7. CLI 扫描器白名单

`packages/adapters/` 下共 10 个子目录，对应 9 种适配器类型（Cursor 分 cloud/local 两个包）：
- claude-local (Claude Code), codex-local (Codex CLI), cursor-cloud + cursor-local (Cursor Agent)
- opencode-local (OpenCode), gemini-local (Gemini CLI), pi-local (Pi Agent)
- acpx-local (ACPX Runtime), grok-local (Grok CLI), openclaw-gateway (OpenClaw Gateway)

使用 `command -v` 而非 `which`（macOS sandbox 兼容）。

## 8. 构建管线

```
pnpm build → pnpm desktop:bundle → electron-builder → .dmg/.exe/.AppImage
```

bundle 步骤：tsc desktop → cp server/dist → cp embedded-pg → cp skills/ → cp ui/dist → server/ui-dist/ → cp teams-catalog

## 9. 风险缓解

| 风险 | 缓解 |
|------|------|
| macOS Hardened Runtime 阻止 spawn | entitlements: `allow-unsigned-executable-memory` + `disable-library-validation` |
| 备份进行中关闭 → 备份损坏 | shutdown 等待 `backupInFlight`（max 30s timeout） |
| HTTP server 未 close | shutdown 中 await `server.close()` |
| Tailscale 检测阻塞 3s | `PAPERCLIP_DISABLE_TAILSCALE_DETECT=true` 或降超时至 1s |

Related: [[paperclip-architecture]], [[paperclip-env-vars]], [[paperclip-agents-compliance]]
