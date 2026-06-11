# Task Spec: sprint-1-core-shell

> **Sprint**: Sprint 1 — 核心壳开发
> **日期**: 2026-06-11
> **基准方案**: [paperclip-desktop-implementation-plan-v3.md](../paperclip-desktop-implementation-plan-v3.md)
> **前置 Sprint**: Sprint 0 验证完成（4/6 AC PASS，2 项环境阻塞不影响 Sprint 1）

---

## Intent（用户原始意图）

> 开发 PaperClip v0.3.1 桌面端 Electron 核心壳：Electron 入口 → daemon spawn → 优雅关闭 → 打包脚本。
> 已有代码直接复制（v3 plan 中含完整实现），新文件委托 agent 开发，所有产物放在 `SuperNode-desktop/` 目录。

---

## Context（背景约束）

- **Stack**: TypeScript + Electron + Express (已有 server) + Node.js
- **Relevant Files**:
  - `server/src/app.ts:200-322` — 需在 API router 注册区域添加 desktop router
  - `server/src/index.ts:766,846` — setInterval 需赋值变量
  - `server/src/index.ts:920-949` — shutdown handler 需增强
  - `server/src/index.ts:570` — `databaseBackupInFlight` 变量已存在
  - `SuperNode-desktop/doc/paperclip-desktop-implementation-plan-v3.md` — 完整实现代码
  - `SuperNode-desktop/doc/ANTI-DRIFT.md` — 防漂移约束
- **Constraints**:
  - 遵循 ADR 01-08（参见 ANTI-DRIFT.md §1）
  - Electron 壳极薄（≤500 行）
  - 不加 Electron IPC
  - 不用 asar
  - Daemon 自管 PG 生命周期
  - 所有产物输出到 `SuperNode-desktop/`
- **Environment**:
  - macOS 26 (Darwin 25), Node v25.9.0
  - pnpm workspace（paperclip-master monorepo）
  - 已知问题: sqlite3@5.1.7 编译失败（不影响 Sprint 1），`@types/node` 已添加

---

## Requirements（需求拆解）

1. **R1**: 新增 `server/src/routes/desktop.ts` — `/api/desktop/status` (GET) + `/api/desktop/shutdown` (POST)
2. **R2**: 修改 `server/src/app.ts` — 注册 desktop router，传递 `desktopShutdownFlag`
3. **R3**: 修改 `server/src/index.ts` — 收集 intervals、增强 shutdown handler（等待 backup + server.close + clearIntervals）
4. **R4**: 创建 Electron 壳文件 — `index.ts`（2行入口）+ `packaged-main.ts`（核心编排）+ `onboard.ts`（首次配置生成）
5. **R5**: 创建 `cli-scanner.ts` — PATH 扫描 10 种 Agent CLI
6. **R6**: 创建 `sidecar-server.ts` — Unix Socket IPC（生命期信号）
7. **R7**: 创建 `tray.ts`（系统托盘）+ `menu.ts`（应用菜单 + 诊断）
8. **R8**: 创建 `updater.ts`（自动更新）+ `notifications.ts`（原生通知）
9. **R9**: 创建 `scripts/desktop/bundle-desktop.ts` — 打包脚本
10. **R10**: 所有新文件符合 ANTI-DRIFT.md 约束

---

## Acceptance Criteria（验收标准）

- [ ] **AC1**: `desktop.ts` 提供 `GET /api/desktop/status`（返回 uptime + shuttingDown）和 `POST /api/desktop/shutdown`（返回 acknowledged + 自触发 SIGTERM）
- [ ] **AC2**: `app.ts` 正确注册 `/api/desktop` router 在 `/api/health` 附近，desktopShutdownFlag 通过 app.locals 共享
- [ ] **AC3**: `index.ts` 的 `setInterval` (line 766, 846) 赋值变量并 push 到 `activeIntervals[]`
- [ ] **AC4**: `index.ts` 的 shutdown handler 包含：clearIntervals → wait backup-in-flight → telemetry stop → appShutdown() → server.close() → PG stop → exit(0)
- [ ] **AC5**: Electron 壳 `index.ts` ≤ 5 行，`packaged-main.ts` ≤ 500 行
- [ ] **AC6**: `onboard.ts` 生成的配置对象通过 `paperclipConfigSchema.parse()` Zod 验证
- [ ] **AC7**: 所有文件不出现 `ipcMain` / `ipcRenderer` / `asar`
- [ ] **AC8**: Electron 代码不 import `pg` / `embedded-postgres`
- [ ] **AC9**: `bundle-desktop.ts` 复制 server + UI + skills + teams + plugins 到 apps/desktop/paperclip-server/
- [ ] **AC10**: TypeScript 编译零错误（L1 Gate）
- [ ] **AC11**: 所有新文件语法正确，可被 tsx 加载

---

## Story Breakdown（Story 拆解）

```json
[
  {
    "id": "S1-001",
    "title": "Desktop API Routes + app.ts 注册",
    "description": "新增 server/src/routes/desktop.ts（/api/desktop/status + /shutdown），修改 server/src/app.ts 注册 desktop router",
    "acceptanceCriteria": ["AC1", "AC2"],
    "stack": "backend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S1-002",
    "title": "Server Shutdown 增强（上游修改）",
    "description": "修改 server/src/index.ts：收集 activeIntervals、重写 shutdown handler 增加 backup 等待 + server.close() + clearIntervals",
    "acceptanceCriteria": ["AC3", "AC4"],
    "stack": "backend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S1-003",
    "title": "Electron 核心壳",
    "description": "创建 apps/desktop/src/main/ 下所有 Electron 文件：index.ts, packaged-main.ts, onboard.ts, cli-scanner.ts, sidecar-server.ts, tray.ts, menu.ts, updater.ts, notifications.ts",
    "acceptanceCriteria": ["AC5", "AC6", "AC7", "AC8"],
    "stack": "backend",
    "priority": 2,
    "dependencies": []
  },
  {
    "id": "S1-004",
    "title": "打包脚本",
    "description": "创建 scripts/desktop/bundle-desktop.ts — 复制 daemon + UI + skills + teams + plugins → apps/desktop/paperclip-server/",
    "acceptanceCriteria": ["AC9"],
    "stack": "backend",
    "priority": 3,
    "dependencies": ["S1-003"]
  }
]
```

---

## Required Skills（强制技能 — 防止执行层跑偏）

| Story | Core Skills（1-2个） | Verify Skills（1个） | Workflow Skills（1个） |
|-------|---------------------|---------------------|----------------------|
| S1-001 | **backend-dev**: API route + Express router 注册 | **tester**: 验证 endpoint 响应 | **verification-before-completion**: 提交前自检 |
| S1-002 | **backend-dev**: 修改 shutdown 流程 + interval 管理 | **tester**: 验证 shutdown 完整性 | **verification-before-completion**: 提交前自检 |
| S1-003 | **backend-dev**: Electron 壳文件实现（从 v3 plan 复制 + 适配） | **reviewer**: 代码审查 ADR 合规 | **verification-before-completion**: 提交前自检 |
| S1-004 | **backend-dev**: 打包脚本（文件复制 + 目录组装） | **tester**: 验证 bundle 输出 | **verification-before-completion**: 提交前自检 |

**Skill Usage Instructions**（注入委派 prompt 的原文）:
```
## Required Skills
- **backend-dev**: 后端开发专家 — API 开发、数据模型、业务逻辑。TDD 强制，安全基线强制。
- **tester**: 测试验证专家 — 运行测试套件，分析失败，区分测试 bug vs 代码 bug。
- **reviewer**: 代码审查员 — 读 diff，对照 Spec，找问题。只看不改。聚焦安全→正确性→质量→性能。
- **verification-before-completion**: 提交前自检 — 对照 AC 逐条验证，确认无遗漏。

### Skill 激活要求
1. Agent 必须先 Read SuperNode-desktop/doc/ANTI-DRIFT.md 再写代码
2. 遵循每个 skill 规定的工作流，不跳过步骤
3. 实现完成后用 verification-before-completion 逐条验证 AC
```

---

## ANTI-DRIFT Constraints（注入到每个 Agent delegation prompt）

```
## ANTI-DRIFT Constraints（强制遵守）
Read SuperNode-desktop/doc/ANTI-DRIFT.md before writing any code.

1. ENV VAR NAMES: Use SERVE_UI (NOT PAPERCLIP_SERVE_UI),
   PAPERCLIP_OPEN_ON_LISTEN (NOT PAPERCLIP_OPEN_BROWSER),
   PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_MIGRATION_AUTO_APPLY.

2. DO NOT add Electron IPC (ipcMain/ipcRenderer). Use REST only.

3. DO NOT use asar packaging.

4. DO NOT let Electron touch PostgreSQL lifecycle. Daemon owns PG.

5. SHUTDOWN ORDER: desktopFlag=true → clearIntervals → wait backup-in-flight
   → telemetry stop → appShutdown() → server.close() → PG stop → exit(0).

6. CONFIG FIELDS: $meta.version=1 (number), database.mode="embedded-postgres",
   server.deploymentMode="local_trusted", server.exposure="private".

7. If writing onboard.ts fallback config, run it through
   paperclipConfigSchema.parse() before saving.

8. ELECTRON MAIN ≤ 500 lines. No business logic in main process.

9. All new files go to SuperNode-desktop/ directory.

10. Existing files (server/src/app.ts, server/src/index.ts) are MODIFIED in-place
    in the paperclip-master repo.
```

---

## Verification Chain（验证链）

| Layer | Gate | Trigger | Executor | Story |
|-------|------|---------|----------|-------|
| **L1** | Type Check (`tsc --noEmit`) | 每个 story 完成 | orchestrator (Bash) | S1-001~004 |
| **L2** | Unit Tests (`vitest run`) | 每个 story 完成 | orchestrator / tester | S1-001~004 |
| **L3b** | Contract Validation | S1-001 完成 | reviewer agent | S1-001 |
| **L3c** | Stub Detection | 所有 story | reviewer agent | S1-001~004 |
| **L3a** | Design Review (ADR 合规) | S1-003 完成 | reviewer agent | S1-003 |
| **L4** | E2E (手动启动验证) | 全部 story 完成 | User | ALL |
| **L5** | Deploy Validation | 合并前 | orchestrator | ALL |

---

## Expected Output（期望输出）

```
## Task Result: sprint-1-core-shell
- Status: PASS | FAIL | BLOCKED
- Changed files:
  - [NEW] SuperNode-desktop/apps/desktop/src/main/index.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/packaged-main.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/onboard.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/cli-scanner.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/sidecar-server.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/tray.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/menu.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/updater.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/notifications.ts
  - [NEW] SuperNode-desktop/server/src/routes/desktop.ts
  - [NEW] SuperNode-desktop/scripts/desktop/bundle-desktop.ts
  - [MODIFIED] server/src/app.ts (in paperclip-master/)
  - [MODIFIED] server/src/index.ts (in paperclip-master/)
- AC Check:
  - [ ] AC1: /api/desktop/status + /shutdown 端点正常
  - [ ] AC2: app.ts desktop router 注册正确
  - [ ] AC3: setInterval 变量化 + activeIntervals
  - [ ] AC4: shutdown handler 完整流程
  - [ ] AC5: Electron 壳 ≤500 行
  - [ ] AC6: onboard.ts Zod 验证通过
  - [ ] AC7: 无 ipcMain/ipcRenderer/asar
  - [ ] AC8: Electron 不 import pg
  - [ ] AC9: bundle-desktop.ts 正确复制
  - [ ] AC10: TypeScript 零错误
  - [ ] AC11: tsx 可加载
```

---

## 实施策略

### 执行顺序

```
Phase 1（并行）:
  ├── S1-001: Desktop API Routes + app.ts（backend-dev agent）
  └── S1-002: Server Shutdown 增强（backend-dev agent）

Phase 2（Phase 1 完成后）:
  └── S1-003: Electron 核心壳（backend-dev agent）

Phase 3（Phase 2 完成后）:
  └── S1-004: 打包脚本（backend-dev agent）

Phase 4（全部完成）:
  └── L1 TypeCheck + L2 Test + L3 Review + 汇总报告
```

### 关键原则

1. **S1-001 和 S1-002 并行** — 修改不同文件，无依赖
2. **S1-003 依赖 S1-001** — Electron 壳需要通过 REST 与 daemon 通信
3. **S1-004 依赖 S1-003** — 打包脚本需要所有文件就位
4. **已有代码直接复制** — v3 plan §2 含完整 TypeScript 实现，agent 按 plan 代码实现
5. **server 修改原地执行** — `server/src/app.ts` 和 `server/src/index.ts` 在 paperclip-master 中直接 Edit
6. **新文件放 SuperNode-desktop/** — Electron 壳、desktop routes、打包脚本全部输出到 SuperNode-desktop/

---

## 参考文件清单

| 文件 | 用途 |
|------|------|
| `SuperNode-desktop/doc/ANTI-DRIFT.md` | 防漂移约束（每个 agent 必读） |
| `SuperNode-desktop/doc/paperclip-desktop-implementation-plan-v3.md` | 完整代码实现（§2 含所有文件代码） |
| `CLAUDE.md` | 7-Agent 框架 + ADR |
| `doc/AGENT-SYSTEM-GUIDE.md` | User ↔ Claude 协作契约 |
