# Task Spec: SPRINT-0-VERIFY

> **Sprint**: Sprint 0 — 验证（3 天）
> **基准**: [paperclip-desktop-implementation-plan-v3.md](../paperclip-desktop-implementation-plan-v3.md) §15
> **创建时间**: 2026-06-10

---

## Intent（用户原始意图）

> 从 Sprint 0（验证）开始，确认 PaperClip v0.3.1 现有代码在桌面化四大关键路径上的行为：不设 DATABASE_URL 完整启动、SIGTERM 优雅关闭、配置 Zod 校验通过、UI dist 路径探测正确。同时创建 ANTI-DRIFT.md 防漂移约束文件，为 Sprint 1 核心壳开发建立安全网。

---

## Context（背景约束）

- **Stack**: TypeScript + Express + Drizzle + Embedded PostgreSQL (PGlite wrapper)
- **Relevant Files**:
  - `server/src/index.ts` — `startServer()`, shutdown handler, heartbeat/backup intervals
  - `server/src/app.ts` — route registration, `serveUi` detection, `paperclipShutdown` hook
  - `packages/shared/src/config-schema.ts` — `paperclipConfigSchema` (Zod)
  - `server/src/config.ts` — config loading, env var parsing
- **Constraints**:
  - ✅ `SERVE_UI=true` (NOT `PAPERCLIP_SERVE_UI`)
  - ✅ `DATABASE_URL` 不设 → daemon 自启嵌入式 PG
  - ✅ `PAPERCLIP_HOME=~/.paperclip` (NOT instance root)
  - ✅ `PAPERCLIP_INSTANCE_ID=default`
  - ✅ UI dist → `server/ui-dist/` (自动探测)
  - Electron 壳不在此 Sprint 范围

---

## Requirements（需求拆解）

1. **R1**: 验证不设 `DATABASE_URL` 时 `startServer()` 能完整启动嵌入式 PG → 迁移 → listen
2. **R2**: 验证 SIGTERM graceful shutdown：停止 interval、等待 backup（如有）、`server.close()`、`embeddedPostgres.stop()`、`process.exit(0)`
3. **R3**: 验证 v3 计划中的 `onboard.ts` 手动配置对象能被 `paperclipConfigSchema.parse()` 通过
4. **R4**: 验证 `server/ui-dist/` 路径探测逻辑：复制 UI dist 后启动，确认 HTML 正确返回
5. **R5**: 逐项验证所有关键 env var 名与源码一致（`SERVE_UI`、`PAPERCLIP_HOME`、`PAPERCLIP_INSTANCE_ID`、`PAPERCLIP_MIGRATION_AUTO_APPLY`、`PAPERCLIP_OPEN_ON_LISTEN`）
6. **R6**: 创建 `ANTI-DRIFT.md` — 桌面端开发的防漂移约束文件（替代缺失的 Multi-Agent-Architecture 同步）

---

## Acceptance Criteria（验收标准）

- [ ] AC1: 不设 `DATABASE_URL` 启动，日志含 `embedded-postgres` 启动成功 + `Server listening on`，进程无崩溃
- [ ] AC2: 发送 SIGTERM 后，日志含 `Stopping embedded PostgreSQL`，5s 内进程退出，无残留 `postmaster.pid`
- [ ] AC3: `paperclipConfigSchema.parse(onboardConfig)` 不抛出异常，所有字段名匹配 Zod schema
- [ ] AC4: `ui/dist` 复制到 `server/ui-dist/` 后，`SERVE_UI=true` 启动 → `curl http://127.0.0.1:3100/` 返回 HTML（含 `<!doctype html>`）
- [ ] AC5: grep 确认所有 env var 引用：`SERVE_UI`（非 `PAPERCLIP_SERVE_UI`）、`PAPERCLIP_HOME`、`PAPERCLIP_INSTANCE_ID`、`PAPERCLIP_MIGRATION_AUTO_APPLY` 均存在于源码
- [ ] AC6: `ANTI-DRIFT.md` 已创建在 `SuperNode-desktop/doc/`，包含所有关键检查项（env var、shutdown、配置字段、打包约束），可供每个 Agent delegation prompt 引用

---

## Story Breakdown（Story 拆解）

```json
[
  {
    "id": "S0-001",
    "title": "验证嵌入式 PG 启动 + 优雅关闭",
    "description": "作为桌面端开发者，我需要确认不设 DATABASE_URL 时嵌入式 PostgreSQL 自动启动并完成迁移，且在收到 SIGTERM 后 gracefully shutdown，以便信任 daemon 进程的生命周期管理",
    "acceptanceCriteria": ["AC1", "AC2"],
    "stack": "backend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S0-002",
    "title": "验证 onboard 配置 Zod 校验 + UI dist 路径",
    "description": "作为桌面端开发者，我需要确认 v3 计划中的 onboard 配置对象能通过 Zod schema 解析，且 UI dist 路径探测逻辑正确",
    "acceptanceCriteria": ["AC3", "AC4", "AC5"],
    "stack": "backend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S0-003",
    "title": "创建 ANTI-DRIFT.md",
    "description": "作为 Claude/Orchestrator，我需要 ANTI-DRIFT.md 防漂移约束文件，以便在每个 Story delegation prompt 中注入约束，防止 Agent 偏离桌面端架构决策",
    "acceptanceCriteria": ["AC6"],
    "stack": "docs",
    "priority": 1,
    "dependencies": ["S0-001", "S0-002"]
  }
]
```

---

## Required Skills（强制技能 — 防止执行层跑偏）

| Story | Core Skills（1-2个） | Verify Skills（1个） | Workflow Skills（1个） |
|-------|---------------------|---------------------|----------------------|
| S0-001 | **tester**: 运行启动/关闭脚本验证 | **verification-before-completion**: 逐项对照 AC | **systematic-debugging**: 若失败则诊断 |
| S0-002 | **tester**: 运行 Zod parse + curl 验证 | **verification-before-completion**: 逐项对照 AC | **systematic-debugging**: 若失败则诊断 |
| S0-003 | **architect**: 基于 ADR + v3 plan 编写约束文档 | **code-review**: 审查约束是否完整 | **surgical-changes**: 最小化文档范围 |

**Skill Usage Instructions**（注入委派 prompt 的原文）:
```
## Required Skills
- **verification-before-completion**: 每个验证步骤完成后必须对照 AC 逐项确认，不跳过任何检查
- **systematic-debugging**: 如启动/shutdown 失败，诊断根因而非绕过，记录发现
- **surgical-changes**: ANTI-DRIFT.md 仅写核心约束，不重复 CLAUDE.md 或 v3 plan 内容

### Skill 激活要求
1. S0-001/S0-002 开始前：确认依赖可用（node_modules, pnpm install）
2. S0-003 开始前：Read ADR（CLAUDE.md §4）+ v3 plan §9（上游修改）
3. 所有 Story 完成后写 agent memory 到 .claude/agent-memory/shared/lessons/
```

---

## Verification Chain（验证链）

| Layer | Gate | Trigger | Executor | S0-001 | S0-002 | S0-003 |
|-------|------|---------|----------|--------|--------|--------|
| L1 | Type Check | — | orchestrator (Bash) | N/A（不写代码） | N/A | N/A |
| L2 | Unit Tests | — | orchestrator (Bash) | 运行现有 `pnpm test` | 运行现有 `pnpm test` | N/A |
| L3b | Contract Validation | S0-003 | reviewer agent | — | — | N/A |
| L3c | Stub Detection | S0-003 | reviewer agent | — | — | 检查 ANTI-DRIFT.md 无 TODO/HACK |
| L4 | E2E | 全部完成 | User（手动） | 手动确认 JSON 启动日志 | 手动 curl 确认 HTML | 阅读 ANTI-DRIFT.md |

---

## Sprint 0 验证方法（具体命令）

### S0-001: 启动 + 关闭验证

```sh
# Step 1: 确保依赖就绪
cd /Users/Mayer/mayer_project/coworker/paperclip-master
pnpm install
pnpm build   # 需要 server/dist/ 存在

# Step 2: 不设 DATABASE_URL 启动
PAPERCLIP_HOME=/tmp/paperclip-sprint0 \
PAPERCLIP_INSTANCE_ID=default \
PAPERCLIP_MIGRATION_AUTO_APPLY=true \
SERVE_UI=false \
PAPERCLIP_OPEN_ON_LISTEN=false \
DATABASE_URL="" \
node server/dist/index.js &

# Step 3: 等待启动 → 检查日志 → 发送 SIGTERM → 检查退出
sleep 15
curl http://127.0.0.1:3100/api/health
kill -TERM $PID
wait $PID
```

### S0-002: 配置校验 + UI 路径

```sh
# Zod 验证脚本
node -e "
const { paperclipConfigSchema } = require('@paperclipai/shared/config-schema');
const config = { /* v3 onboard config */ };
paperclipConfigSchema.parse(config);
console.log('PASS');
"

# UI dist 路径
cp -r ui/dist server/ui-dist/
SERVE_UI=true node server/dist/index.js &
curl -s http://127.0.0.1:3100/ | head -5
```

### S0-003: ANTI-DRIFT.md

输出到 `SuperNode-desktop/doc/ANTI-DRIFT.md`。

---

## Expected Output（期望输出）

```
## Task Result: SPRINT-0-VERIFY
- Status: PASS | FAIL | BLOCKED
- S0-001 (PG start + shutdown): PASS/FAIL — {关键发现}
- S0-002 (Config + UI path): PASS/FAIL — {关键发现}
- S0-003 (ANTI-DRIFT.md): PASS/FAIL — {文档位置}
- Changed files: [{paths}]
- Notes: {意外发现、与 v3 plan 的偏差、上游修复建议}
```
