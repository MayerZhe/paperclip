---
name: paperclip-agents-compliance
description: PaperClip AGENTS.md mandatory compliance rules for all agents working in this repo
metadata:
  type: convention
  shared: true
---

# AGENTS.md Compliance Rules

> AGENTS.md 是本 repo 的权威工程规范文件。所有 Agent 必须遵守以下规则。

## 1. 开发前必读（按顺序）

在任何代码变更前，Agent 必须先读：
1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

**不许跳过。** `doc/SPEC-implementation.md` 是具体 V1 构建合同。

## 2. Contract Sync（合约同步）

Schema/API 变更 → 必须同步更新：
- `packages/db/` — schema + migration
- `packages/shared/` — types + constants + validators
- `server/` — routes + services
- `ui/` — API clients + pages

## 3. Plan Documents

新的计划文档 → `doc/plans/YYYY-MM-DD-slug.md`

不要新建根目录 plan 文件。如果 Super Node issue 有 plan 需要更新，用 issue plan document，不用 repo markdown。

## 4. Generated Artifacts

产生的可检查文件 → 使用 `skills/paperclip/scripts/paperclip-upload-artifact.sh` 上传到 Super Node API。

不要仅依赖本地文件系统路径作为唯一访问路径。

## 5. Database Changes

1. Edit `packages/db/src/schema/*.ts`
2. Export from `packages/db/src/schema/index.ts`
3. `pnpm db:generate`
4. `pnpm -r typecheck`

## 6. Verification

```sh
# 常规开发（最小验证）
pnpm test

# 全量检查（PR 前必须）
pnpm -r typecheck && pnpm test:run && pnpm build

# 浏览器测试（涉及 UI 变更时）
pnpm test:e2e
pnpm test:release-smoke
```

## 7. PR Requirements

必须完整填写 `.github/PULL_REQUEST_TEMPLATE.md` 所有栏目：
- **Thinking Path** — 从项目上下文到本变更的推理链
- **What Changed** — 具体变更列表
- **Verification** — Reviewer 如何验证
- **Risks** — 可能出问题的地方
- **Model Used** — AI 模型信息（provider, exact model ID, context window, capabilities），人类编写写 "None — human-authored"

## 8. Fork-Specific Rules

此 repo 是 `HenkDz/paperclip` fork，包含对 `paperclipai/paperclip` 的 QoL 补丁：

- Branch `feat/externalize-hermes-adapter` 将 Hermes 外部化
- Hermes 通过 Board → Adapter manager 注册（不是内置）
- Port 3101+（auto-detect if 3100 被占用）
- NTFS 上 `npx vite build` 可能挂起，用 `node node_modules/vite/bin/vite.js build`
- NTFS 启动可能需要 30-60s

### Fork QoL Patches（重新复制源码时必须重新应用）

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, first 3 lines/280 chars

Related: [[paperclip-architecture]], [[paperclip-desktop]], [[paperclip-env-vars]], [[quality-gates]], [[git-commits]]
