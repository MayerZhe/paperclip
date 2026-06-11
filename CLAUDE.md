# PaperClip Desktop — Claude → Orchestrator Development Workflow

> 项目: PaperClip v0.3.1 桌面端封装 (`supernode-desktop/`)
> 实施基准: [paperclip-desktop-implementation-plan-v3.md](../../Multi-Agent-Architecture/deliverables/paperclip-desktop-implementation-plan-v3.md)
> 前置参考: [AGENTS.md](AGENTS.md) — PaperClip 仓库工程规范（优先于本文件）

---

## 0. 项目技术栈

### PaperClip Monorepo

| 组件 | 技术 | 路径 |
|------|------|------|
| **Server** | Express + TypeScript, tsx 运行时 | `server/` |
| **UI** | React + Vite + Tailwind + shadcn/ui | `ui/` |
| **Database** | Drizzle ORM + PostgreSQL / 嵌入式 PGlite | `packages/db/` |
| **Shared** | Zod schemas, 类型, 常量, API path helpers | `packages/shared/` |
| **Adapters** | Claude/Codex/Cursor(cloud+local)/ACPX/Grok/OpenCode/Gemini/Pi/OpenClaw 适配器 | `packages/adapters/` |
| **Adapter Utils** | 适配器共享工具函数 | `packages/adapter-utils/` |
| **Skills Catalog** | Agent skill catalog (npm 包) | `packages/skills-catalog/` |
| **Teams Catalog** | Teams 定义目录 (npm 包) | `packages/teams-catalog/` |
| **Skills** | Agent skill 文件目录 | `skills/` |
| **CLI** | tsx 驱动的 CLI 工具 (`node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts`) | `cli/` |
| **Plugins** | 插件系统 + 沙箱 providers | `packages/plugins/` |
| **Desktop** | Electron 壳 + daemon 子进程 + 嵌入式 PostgreSQL | `apps/desktop/`（目标位置）/ `supernode-desktop/`（开发阶段根目录） |

### 关键命令

```sh
pnpm install          # 安装依赖
pnpm dev              # 启动 API (port 3100) + UI (同端口 SPA serve)
pnpm build            # 全量构建 (server/tsc + ui/vite + packages)
pnpm test             # Vitest 单元测试
pnpm typecheck        # 全量类型检查
pnpm db:generate      # Drizzle schema → SQL 迁移生成
pnpm -r typecheck     # 发布前完整类型检查
curl localhost:3100/api/health  # 验证服务健康
```

### 桌面端特有命令（⚠️ Sprint 1 待实现 — 当前 package.json 中不存在）

```sh
pnpm desktop:build    # 编译 Electron 壳 TypeScript
pnpm desktop:bundle   # 组装 app bundle (server + UI + PG + skills)
pnpm desktop:pack     # electron-builder 打包 .dmg/.exe/.AppImage
pnpm desktop:dev      # 开发模式启动 Electron
```

---

## 1. 核心开发原则

### Claude 是唯一任务入口和质量守门人

```
User 发任务 → Claude 澄清 → 写 Task Spec → 委托 orchestrator
  → orchestrator 派发 specialist → Claude 回收结果
  → 对照意图验证 → 报告用户
```

**orchestrator 只执行,不自行选题。**

### Workflow 循环

```
User: "开发 X 功能"
    │
    ▼
┌─ CLAUDE (你) ─────────────────────────────────────────────┐
│ 1. 澄清需求                                               │
│ 2. 写 Task Spec（参考 scripts/task-spec-template.md）     │
│    - Intent / Requirements / AC / Stories / Skills        │
│ 3. 委托 orchestrator                                      │
│ 4. 等待 Task Result                                       │
│ 5. 验证（对照 Intent + AC）                              │
│ 6. 报告用户                                               │
└──────────────────────────────────────────────────────────┘
```

### Task Spec 的 Skills 匹配规则

1. 确定 story.stack → 选择 Agent（frontend-dev/backend-dev/architect/reviewer/tester）
2. 读 story.description → 识别任务类型（CRUD/UI/animation/test/debug/design）
3. 匹配 2-5 skills：**1-2 核心 skill + 1 验证 skill + 1 流程 skill**
4. 将 skills 写入 Task Spec 的 Required Skills 字段

---

## 2. 7-Agent 协作框架

| Agent | 用途 | 工具 | 隔离 |
|-------|------|------|------|
| **requirements-analyst** | 需求分析 → prd.json | Read, Grep, Glob, Bash | — |
| **orchestrator** | 编排（只读），select→configure→dispatch→verify→close | Read, Grep, Glob, Bash, Agent | — |
| **architect** | 架构设计 + design review | Read, Grep, Glob, Bash | — |
| **frontend-dev** | 前端实现（UI/animation/design restoration） | Read, Write, Edit, Bash | worktree |
| **backend-dev** | 后端实现（API/database/service） | Read, Write, Edit, Bash | worktree |
| **reviewer** | Code review + API contract validation | Read, Grep, Glob, Bash | — |
| **tester** | L2 单元测试 + L4 E2E | Read, Bash, Edit, Grep | worktree |

### orchestrator 铁律

- ⛔ **orchestrator 不写代码** — 无 Write/Edit 工具，所有实现必须通过 Agent 委托
- ⛔ **禁止 sed/awk/echo/cat/tee 绕过限制**
- 每个 story 独立 commit，可单独 revert
- 同一 story 失败 3 次 → mark blocked → 人工介入
- 每个 story 完成后必须回写 agent memory

---

## 3. Quality Gates L1-L5

| Layer | Gate | 执行者 | On Fail |
|-------|------|--------|---------|
| **L1** | Type Check (`tsc --noEmit`) | orchestrator (Bash) | ❌ BLOCK return to S3 |
| **L2** | Unit Tests (`vitest run`) | orchestrator / tester | ❌ BLOCK return to S3 (max 3 retries) |
| **L3a** | Design Review | architect agent | ❌ BLOCK return to S3 (max 2 retries) |
| **L3b** | Contract Validation (API) | reviewer agent | ❌ frontend missing backend→BLOCK |
| **L3c** | Stub Detection | reviewer agent | ⚠️ WARNING |
| **L4** | E2E | user (manual) | ⚠️ WARNING |
| **L5** | Deploy Validation | orchestrator (Bash) | ❌ BLOCK must fix before merge |

---

## 4. PaperClip Desktop 架构（基于 v3 实施计划）

### ADR 关键决策

| ID | 决策 | 依据 |
|----|------|------|
| ADR-01 | **不用 asar** — 纯文件目录分发 | 嵌入式 PG 二进制无法从 asar 运行 |
| ADR-02 | **Electron 壳极薄** — main.cjs 只做 spawn + 窗口管理 | 借鉴 Open Design 的 2 行 main.cjs |
| ADR-03 | **Daemon 全权管理 PG** — Electron 不碰 PG 生命周期 | `startServer()` 自管 `embeddedPostgres` |
| ADR-04 | **首次启动用 `paperclipai onboard -y`** | 配置格式为 Zod `paperclipConfigSchema`，手工构造易出错 |
| ADR-05 | `loadURL('http://localhost:3100')` — HTTP 加载 UI | 复用 Express 中间件 serve UI |
| ADR-06 | 不加 Electron IPC 协议 | 已有 40+ REST 路由 |
| ADR-07 | Sidecar Unix Socket 仅用于进程间生命期信号 | 不承载业务数据 |
| ADR-08 | UI dist → `server/ui-dist/` | `app.ts` 自动探测 |

### 桌面端项目结构

> **注意**: 实施计划目标路径为 `apps/desktop/`，开发阶段在根目录 `supernode-desktop/` 下原型开发，最终通过 bundle 脚本复制到 `apps/desktop/` 对应位置。

```
apps/desktop/src/main/              ← 目标 monorepo 位置（目前为空，Sprint 1 实现）
├── index.ts              ← 2 行入口
├── packaged-main.ts      ← 核心编排（~400 行）
├── onboard.ts            ← 首次启动配置生成
├── cli-scanner.ts        ← PATH 扫描 Agent CLI（10 个适配器包，9 种适配器类型）
├── sidecar-server.ts     ← Unix Socket IPC
├── tray.ts               ← 系统托盘
├── menu.ts               ← 应用菜单 + 诊断
├── updater.ts            ← 自动更新
└── notifications.ts      ← 原生通知

server/src/routes/
└── desktop.ts            ← 桌面端专用 API (/api/desktop/status, /shutdown)

scripts/desktop/                   ← 构建脚本（Sprint 1 实现）
├── bundle-desktop.ts     ← 打包脚本
├── copy-daemon.ts        ← 复制 server + db + skills
└── copy-ui.ts            ← 复制 UI dist → server/ui-dist/
```

### 关键环境变量（经源码验证）

| 变量 | 必须 | 值 | 说明 |
|------|------|-----|------|
| `PAPERCLIP_HOME` | ✅ | `~/.paperclip` | **不是** instance root |
| `PAPERCLIP_INSTANCE_ID` | ✅ | `default` | |
| `SERVE_UI` | ✅ | `true` | ⚠️ 不是 `PAPERCLIP_SERVE_UI` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | ✅ | `true` | |
| `PAPERCLIP_OPEN_ON_LISTEN` | 建议 | `false` | 桌面端不打开浏览器 |
| `PORT` | 否 | `3100` | 默认值 |
| `DATABASE_URL` | **不设** | — | 不设 → daemon 自启嵌入式 PG |

### 启动时序

```
[t=0s]   main.cjs → import("./packaged-main.js")
[t=0.1s] ensureFirstRunConfig() → config.json 已存在? 跳过 : 生成
[t=0.5s] spawn("node", ["server/dist/index.js"], { env })
           → startServer() → embeddedPostgres.start()
           → 迁移 → listen(3100)
[t=15s]  waitForServerReady() → /api/health ✅
[t=16s]  BrowserWindow + loadURL + show
```

### 关闭时序（v3 增强版）

```
before-quit →
  POST /api/desktop/shutdown →
  daemon: clearIntervals → wait backup → server.close() → PG stop → exit(0)
  Electron: daemon SIGTERM → 等待 exit → sidecar.close() → app.exit(0)
```

---

## 5. PaperClip 工程规范（来自 AGENTS.md）

开发前必读（按顺序）：
1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

### 核心工程规则

1. **Keep changes company-scoped** — 每个 domain entity 必须 scoped to company
2. **Keep contracts synchronized** — schema 变更 → 更新 db + shared + server + ui
3. **Preserve control-plane invariants** — single-assignee task, atomic checkout, approval gates, budget hard-stop, activity logging
4. **Don't replace strategic docs** — 优先增量更新
5. **Plan documents** → `doc/plans/YYYY-MM-DD-slug.md`
6. **Generated artifacts** → 使用 `skills/paperclip/scripts/paperclip-upload-artifact.sh`

### 验证前检查清单

```sh
# 常规开发
pnpm test                    # Vitest suite
# 涉及 schema 变更
pnpm db:generate && pnpm -r typecheck
# 发布前完整检查
pnpm -r typecheck && pnpm test:run && pnpm build
# 浏览器测试（按需）
pnpm test:e2e
pnpm test:release-smoke
```

### PR 要求

必须完整填写 `.github/PULL_REQUEST_TEMPLATE.md` 所有栏目，包括 **Thinking Path**、**What Changed**、**Verification**、**Risks**、**Model Used**。

---

## 6. 开发模式

### 本地开发

```sh
pnpm install
pnpm dev          # API + UI 都在 localhost:3100
```

### 桌面端开发（在 supernode-desktop/ 下进行）

桌面端开发遵循 `paperclip-desktop-implementation-plan-v3.md` 的 Sprint 分解：

- **Sprint 0** (3天): 验证 — 不设 DATABASE_URL 启动 / SIGTERM 关闭 / UI dist 路径 / Zod 配置验证
- **Sprint 1** (2周): 核心壳 — Electron 入口 + daemon spawn + 优雅关闭 + 打包脚本
- **Sprint 2** (2周): 桌面体验 — CLI 扫描 + 托盘 + 菜单 + 通知 + 自动更新
- **Sprint 3** (1-2周): 多平台 — Windows + Linux + CI/CD

---

## 7. Delegation Prompt Template

```
Use orchestrator to execute scripts/task-specs/{task-id}.md

## Anti-Drift Governance（强制）
1. 读取 ANTI-DRIFT.md（当前 repo 中不存在，需从 Multi-Agent-Architecture 项目同步；如缺失则跳过，由 Claude 直接执行 anti-drift 检查）
2. 每个 Story 的 delegation prompt 必须注入 Anti-Drift Constraints
3. Frontend Story: Agent 必须先打开对应 prototype HTML，逐一枚举元素再编码
4. Backend Story: Agent 必须先检查 reference library
5. 所有 Agent 执行必须注入 ultracode thinking depth
6. 每个 Story → L1→L2→L3→L5 逐层验证
7. Spec group 全部完成 → 返回 Task Result → 等待 Claude review

### Ultracode Injection（追加到每个 Agent delegation prompt）
Think at ultracode depth. Before writing any code:
1. 识别所有 edge cases 和 boundary conditions
2. 考虑 failure modes 并写 defensive error handling
3. 评估性能影响（N+1 queries, memory, blocking I/O）
4. 审计安全面（input validation, auth, injection, data exposure）
5. 对照 prototype / reference implementation 验证
6. 写能证明正确性的测试，不只是追求覆盖率
```

---

## 8. Verification Checklist（Claude 回收结果后）

- [ ] 验证实现方向匹配用户 Intent
- [ ] 逐项确认 AC 实际通过（不只是 PASS 标签）
- [ ] Frontend Story: screenshot vs prototype HTML 并排对比
- [ ] Backend Story: 确认没有重写已有 reference library
- [ ] Agent 输出含 skill traces（test files/verification screenshots/plan docs）
- [ ] `git diff` 范围合理（无多余变更、无 TODO/FIXME/HACK）
- [ ] Commit message 清晰可追溯
- [ ] 有偏差 → 写修正 Spec → 重新委托
- [ ] 全部通过 → 简明总结 → 用户确认 → 下一 Spec group

---

## 9. Memory System

- **Cross-Agent Shared Knowledge**: `.claude/agent-memory/shared/`（patterns/, conventions/, lessons/）
- **Agent-Specific Knowledge**: `.claude/agent-memory/{agent-name}/`
- **Session Memory**: 每次开发任务后 → 经验教训写入 shared/lessons/
- **Project Conventions**: 桌面端开发约定写入 `.claude/agent-memory/shared/conventions/`

