---
name: paperclip-env-vars
description: Complete PaperClip environment variable reference — critical for avoiding v1→v2 naming mistakes
metadata:
  type: reference
  shared: true
---

# PaperClip Environment Variables Reference

> 全部经源码验证（server/src/index.ts, server/src/app.ts, packages/shared/src/config-schema.ts, packages/shared/src/home-paths.ts）

## Server Runtime

| 变量 | 必须 | 默认值 | 说明 | 源码位置 |
|------|------|--------|------|----------|
| `PAPERCLIP_HOME` | ✅ | `~/.paperclip` | PaperClip 主目录 | `shared/home-paths.ts` |
| `PAPERCLIP_INSTANCE_ID` | ✅ | `default` | 实例 ID | `shared/home-paths.ts` |
| `SERVE_UI` | 桌面端 ✅ | `false` | ⚠️ **不是** `PAPERCLIP_SERVE_UI`！ | `packages/shared/config.ts` |
| `PORT` | 否 | `3100` | Server 端口 | `packages/shared/config-schema.ts` |
| `DATABASE_URL` | 否 | (空) | 不设 → 嵌入式 PG/PGlite | `server/src/index.ts` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | 桌面端 ✅ | `false` | 自动运行迁移 | `server/src/index.ts` |
| `PAPERCLIP_MIGRATION_PROMPT` | 否 | `true` | 迁移前提示（字符串比较 `=== "never"` 可禁用） | `server/src/index.ts` |
| `PAPERCLIP_OPEN_ON_LISTEN` | 桌面端建议 | (undefined) | `false` → 桌面端不打开浏览器 | `server/src/index.ts` |
| `PAPERCLIP_DISABLE_TAILSCALE_DETECT` | 否 | (undefined) | `true` → 跳过 Tailscale 检测 | `packages/shared/config-schema.ts` |

## ❌ 不存在的环境变量（常见错误）

| 错误写法 | 正确写法 | 说明 |
|---------|---------|------|
| ~~`PAPERCLIP_SERVE_UI`~~ | `SERVE_UI` | v1 犯过的错 |
| ~~`PAPERCLIP_UI_DIST_DIR`~~ | 不需要 | app.ts 自动探测 `../ui-dist` |
| ~~`PAPERCLIP_PORT`~~ | `PORT` | |
| ~~`PAPERCLIP_DATABASE_URL`~~ | `DATABASE_URL` | |

## Instance Paths

```
~/.paperclip/                       ← PAPERCLIP_HOME
  instances/
    default/                        ← PAPERCLIP_INSTANCE_ID
      config.json                   ← Zod paperclipConfigSchema
      .env                          ← 环境变量持久化
      master.key                    ← 加密密钥
      db/                           ← 嵌入式 PG 数据目录
      logs/                         ← Server 日志
      plugins/                      ← 本地插件
```

## Desktop-Specific

桌面端 daemon spawn 时必须的 env:

```typescript
const serverEnv = {
  ...process.env,
  PAPERCLIP_HOME: "~/.paperclip",
  PAPERCLIP_INSTANCE_ID: "default",
  SERVE_UI: "true",                       // ← 不是 PAPERCLIP_SERVE_UI！
  PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  PAPERCLIP_OPEN_ON_LISTEN: "false",
  // DATABASE_URL intentionally NOT set → daemon 自启 PG
};
```

## Development

```sh
# 本地开发（使用嵌入式 PGlite）
pnpm dev
# DATABASE_URL 不设 → 自动使用 data/pglite/

# 桌面模式验证
SERVE_UI=true PAPERCLIP_MIGRATION_AUTO_APPLY=true node server/dist/index.js

# 跳过 Tailscale（加速启动）
PAPERCLIP_DISABLE_TAILSCALE_DETECT=true pnpm dev
```

Related: [[paperclip-desktop]], [[paperclip-architecture]]
