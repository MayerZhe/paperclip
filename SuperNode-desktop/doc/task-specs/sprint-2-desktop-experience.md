# Task Spec: sprint-2-desktop-experience

> **Sprint**: Sprint 2 — 桌面体验增强
> **日期**: 2026-06-11
> **基准方案**: [paperclip-desktop-implementation-plan-v3.md](../paperclip-desktop-implementation-plan-v3.md)
> **前置 Sprint**: Sprint 1 核心壳开发完成（11/11 AC PASS）

---

## Intent（用户原始意图）

> 在 Sprint 1 核心壳基础上，实现完整的桌面体验：系统托盘状态实时反映 daemon 健康、原生通知与 daemon 事件联动、自动更新就绪、窗口状态持久化、打包基础设施完整可构建。

---

## Context（背景约束）

- **Stack**: TypeScript + Electron + Node.js
- **Sprint 1 已交付**:
  - `packaged-main.ts` — 7 阶段启动编排、优雅关闭
  - `tray.ts` — 基础托盘（Status label 固定为 "stopped"，无实时心跳）
  - `menu.ts` — 应用菜单 + Export Diagnostics（数据字段偏少）
  - `updater.ts` — Stub（仅 console.log，非功能实现）
  - `notifications.ts` — 基础 wrapper（未与 daemon 事件串联）
  - `cli-scanner.ts` — 功能完整（10 适配器）
  - `sidecar-server.ts` — 功能完整（Unix Socket）
  - `bundle-desktop.ts` — 文件复制脚本
  - `desktop.ts` — `/api/desktop/status` + `/api/desktop/shutdown`
- **Sprint 2 要增强/新增**:
  - `tray.ts` — 周期性轮询 `/api/desktop/status`，托盘状态实时反映 daemon 健康
  - `notifications.ts` — 与 server 端通知事件集成
  - `updater.ts` — 实现 `electron-updater` 自动更新
  - `menu.ts` — 诊断报告增强（daemon 状态、CLI 扫描结果、内存使用）
  - 🆕 `window-state.ts` — 窗口位置/大小持久化
  - 🆕 `login-item.ts` — 开机自启管理
  - 🆕 打包基础设施 — `package.json`, `tsconfig.json`, `electron-builder.yml`, entitlements, 图标
- **Constraints**:
  - ADR 01-08 全部遵守（参见 ANTI-DRIFT.md）
  - 所有新文件输出到 `SuperNode-desktop/`
  - 现有文件原地增强（不移动）
  - Electron 主进程总行数 ≤ 500（Sprint 1 = 282，Sprint 2 余量 ~200）
- **Environment**: macOS 26 (Darwin 25), Node v25.9.0, pnpm workspace

---

## Requirements（需求拆解）

1. **R1**: 增强 `tray.ts` — 周期性轮询 `GET /api/desktop/status`，更新托盘状态文本和图标
2. **R2**: 增强 `notifications.ts` — 接收 daemon 事件（通过 Server-Sent Events 或 sidecar NOTIFY），弹出原生通知
3. **R3**: 增强 `updater.ts` — 实现 `electron-updater`（GitHub Releases 源），处理 update-available/downloaded/error 事件
4. **R4**: 增强 `menu.ts` — 诊断报告加入 daemon 状态、CLI 扫描结果、内存使用、env 信息
5. **R5**: 🆕 `window-state.ts` — 窗口位置/大小保存到 `~/.paperclip/desktop-state.json`，启动时恢复
6. **R6**: 🆕 `login-item.ts` — macOS `app.setLoginItemSettings()` 管理开机自启
7. **R7**: 🆕 打包基础设施 — `package.json`, `tsconfig.json`, `electron-builder.yml`, entitlements, tray 图标生成脚本
8. **R8**: 所有增强遵守 ANTI-DRIFT.md §1-6 约束

---

## Acceptance Criteria（验收标准）

- [ ] **AC1**: `tray.ts` 每 15 秒轮询 `GET /api/desktop/status`，托盘 status label 实时反映 `shuttingDown` / `uptime`
- [ ] **AC2**: `tray.ts` 托盘图标在不同状态（running/stopped/error）下切换（至少程序化生成，不需真实图标文件）
- [ ] **AC3**: `notifications.ts` 在 daemon 任务完成/失败时弹出原生通知（通过 server 事件轮询或 sidecar NOTIFY）
- [ ] **AC4**: `updater.ts` 实现 `electron-updater`，包含 `checkForUpdates()`、事件监听、下载进度/错误处理
- [ ] **AC5**: `menu.ts` Export Diagnostics 输出包含：version, platform, arch, daemon status (来自 /api/desktop/status), CLI scan results, memory usage, env vars, timestamp
- [ ] **AC6**: `window-state.ts` 在窗口关闭时保存 `{ x, y, width, height, isMaximized }` 到 `~/.paperclip/desktop-state.json`，启动时恢复
- [ ] **AC7**: `login-item.ts` 提供 `setAutoLaunch(enabled: boolean)` 函数，menu 中增加 "Launch at Login" toggle
- [ ] **AC8**: `apps/desktop/package.json` 包含正确的 name/version/description/main/dependencies/build 字段
- [ ] **AC9**: `apps/desktop/tsconfig.json` 编译 `src/main/` 和 `src/preload/` 到 `dist/main/` 和 `dist/preload/`
- [ ] **AC10**: `apps/desktop/electron-builder.yml` 配置 macOS `.dmg` + `.zip`，无 asar
- [ ] **AC11**: `apps/desktop/build/entitlements.mac.plist` 包含必要权限（network, audio, usb）
- [ ] **AC12**: 托盘图标生成脚本可程序化创建占位图标（16x16, 32x32, 256x256 PNG）
- [ ] **AC13**: 所有新/改文件通过 TypeScript 语法检查（L1 Gate）
- [ ] **AC14**: ADR 合规扫描通过（无 ipcMain/ipcRenderer/asar/PG import）

---

## Story Breakdown（Story 拆解）

```json
[
  {
    "id": "S2-001",
    "title": "Tray 心跳轮询 + 状态实时更新",
    "description": "增强 tray.ts：添加周期性轮询 GET /api/desktop/status，解析 { uptime, shuttingDown }，更新托盘 context menu 的 Status 行。添加简单程序化图标生成（NativeImage 绘制圆形指示器：绿=运行，黄=关闭中，红=不可达）。在 packaged-main.ts 中启动轮询、在 shutdown 时停止。",
    "acceptanceCriteria": ["AC1", "AC2"],
    "stack": "backend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S2-002",
    "title": "通知集成 + 菜单诊断增强",
    "description": "增强 notifications.ts：在 Electron 主进程中周期性检查 daemon 状态（复用 tray 轮询结果），当检测到状态变化（如 shuttingDown=true）时弹出通知。增强 menu.ts Export Diagnostics：在现有字段基础上，增加 GET /api/desktop/status 结果、已完成的 CLI scan 结果、process.memoryUsage()、所有 PAPERCLIP_* 环境变量。",
    "acceptanceCriteria": ["AC3", "AC5"],
    "stack": "backend",
    "priority": 1,
    "dependencies": ["S2-001"]
  },
  {
    "id": "S2-003",
    "title": "自动更新实现",
    "description": "重写 updater.ts：使用 electron-updater 连接 GitHub Releases。实现 checkForUpdates() → 检查更新 → autoDownload → 下载完成后通知用户重启。处理 update-available, update-not-available, download-progress, error 四个事件。在菜单 Help 中添加 'Check for Updates' 项。",
    "acceptanceCriteria": ["AC4"],
    "stack": "backend",
    "priority": 2,
    "dependencies": []
  },
  {
    "id": "S2-004",
    "title": "窗口状态持久化 + 开机自启",
    "description": "新增 window-state.ts：在 BrowserWindow 'close' 事件时保存 { x, y, width, height, isMaximized } 到 ~/.paperclip/desktop-state.json。启动时从文件读取并应用到 BrowserWindow 构造参数。新增 login-item.ts：封装 app.setLoginItemSettings()，在菜单 Edit 中增加 'Launch at Login' toggle。",
    "acceptanceCriteria": ["AC6", "AC7"],
    "stack": "backend",
    "priority": 2,
    "dependencies": []
  },
  {
    "id": "S2-005",
    "title": "打包基础设施",
    "description": "创建 apps/desktop/package.json（name: paperclip-desktop, version: 0.3.1, electron-builder 依赖），apps/desktop/tsconfig.json（target ES2022, module NodeNext），apps/desktop/electron-builder.yml（mac dmg+zip, no asar, extraResources），apps/desktop/build/entitlements.mac.plist（network+audio+usb），图标生成脚本 scripts/desktop/generate-icons.ts（程序化生成 16/32/256/512 px PNG 占位图标），apps/desktop/.gitignore。",
    "acceptanceCriteria": ["AC8", "AC9", "AC10", "AC11", "AC12"],
    "stack": "backend",
    "priority": 3,
    "dependencies": ["S2-001", "S2-002", "S2-003", "S2-004"]
  }
]
```

---

## Required Skills（强制技能 — 防止执行层跑偏）

| Story | Core Skills（1-2个） | Verify Skills（1个） | Workflow Skills（1个） |
|-------|---------------------|---------------------|----------------------|
| S2-001 | **backend-dev**: HTTP polling + Electron Tray API | **tester**: 验证轮询逻辑 + 状态切换 | **verification-before-completion**: AC 逐条验证 |
| S2-002 | **backend-dev**: Notification API + Menu 增强 | **reviewer**: 审查 sidecar 协议使用 | **verification-before-completion**: AC 逐条验证 |
| S2-003 | **backend-dev**: electron-updater 集成 | **tester**: 验证事件处理链 | **verification-before-completion**: AC 逐条验证 |
| S2-004 | **backend-dev**: window-state + login-item | **tester**: 验证持久化读写 | **verification-before-completion**: AC 逐条验证 |
| S2-005 | **backend-dev**: 打包配置文件 | **reviewer**: 审查配置完整性 | **verification-before-completion**: AC 逐条验证 |

**Skill Usage Instructions**（注入委派 prompt 的原文）:
```
## Required Skills
- **backend-dev**: 后端开发专家 — API 开发、数据模型、业务逻辑。TDD 强制，安全基线强制。
- **tester**: 测试验证专家 — 运行测试套件，分析失败，区分测试 bug vs 代码 bug。
- **reviewer**: 代码审查员 — 读 diff，对照 Spec，找问题。只看不改。聚焦安全→正确性→质量→性能。
- **verification-before-completion**: 提交前自检 — 对照 AC 逐条验证，确认无遗漏。

### Skill 激活要求
1. Agent 必须先 Read SuperNode-desktop/doc/ANTI-DRIFT.md 再写代码
2. 必须 Read 被修改文件的当前内容，理解现实现后再修改
3. 遵循每个 skill 的工作流，不跳过步骤
4. 实现完成后用 verification-before-completion 逐条验证 AC
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
   Tray polling uses HTTP GET /api/desktop/status, NOT IPC.

3. DO NOT use asar packaging. electron-builder.yml MUST set asar: false.

4. DO NOT let Electron touch PostgreSQL lifecycle. Daemon owns PG.

5. SHUTDOWN ORDER (don't break): signal → wait backup → server.close() → PG stop → exit.
   Tray polling MUST stop before shutdown sequence begins.

6. CONFIG FIELDS: $meta.version=1 (number), database.mode="embedded-postgres",
   server.deploymentMode="local_trusted", server.exposure="private".

7. Electron main process total ≤ 500 lines.
   New modules (window-state.ts, login-item.ts) should be separate files
   imported by packaged-main.ts, NOT inline code.

8. All new files go to SuperNode-desktop/ directory.

9. Tray polling uses the EXISTING /api/desktop/status endpoint (Sprint 1).
   Do NOT create new API routes for tray functionality.

10. electron-updater feed URL should be configurable (env var or constant),
    defaulting to a GitHub Releases URL pattern.
```

---

## Existing File Modification Map（精确变更清单）

每个 Story 的 Agent 必须精确知道哪些文件是 **MODIFY**（编辑已有文件）vs **NEW**（创建新文件）。

| 文件 | 变更类型 | Sprint 1 状态 | Sprint 2 变更 |
|------|---------|---------------|---------------|
| `apps/desktop/src/main/tray.ts` | ✏️ MODIFY | 50 行，status 固定文本 | 添加 heartbeat 轮询、状态图标切换 |
| `apps/desktop/src/main/notifications.ts` | ✏️ MODIFY | 13 行，基础 wrapper | 添加事件驱动的通知触发 |
| `apps/desktop/src/main/updater.ts` | ✏️ REWRITE | 16 行，stub | 完整 electron-updater 实现 |
| `apps/desktop/src/main/menu.ts` | ✏️ MODIFY | 127 行，基础诊断 | 增强诊断数据字段 |
| `apps/desktop/src/main/packaged-main.ts` | ✏️ MODIFY | 278 行 | 集成新模块（window-state, login-item） |
| `apps/desktop/src/main/window-state.ts` | 🆕 NEW | 不存在 | 窗口状态持久化 |
| `apps/desktop/src/main/login-item.ts` | 🆕 NEW | 不存在 | 开机自启管理 |
| `apps/desktop/package.json` | 🆕 NEW | 不存在 | Electron 包配置 |
| `apps/desktop/tsconfig.json` | 🆕 NEW | 不存在 | TypeScript 编译配置 |
| `apps/desktop/electron-builder.yml` | 🆕 NEW | 不存在 | electron-builder 打包配置 |
| `apps/desktop/build/entitlements.mac.plist` | 🆕 NEW | 不存在 | macOS Hardened Runtime |
| `scripts/desktop/generate-icons.ts` | 🆕 NEW | 不存在 | 程序化图标生成 |
| `apps/desktop/.gitignore` | 🆕 NEW | 不存在 | 桌面端 gitignore |
| `apps/desktop/resources/` | 🆕 NEW | 不存在 | 图标资源目录 |

---

## Verification Chain（验证链）

| Layer | Gate | Trigger | Executor | Story |
|-------|------|---------|----------|-------|
| **L1** | Syntax Check (`node --experimental-strip-types --check`) | 每个 story 完成 | orchestrator (Bash) | S2-001~005 |
| **L2** | Tray logic review (轮询间隔、状态机) | S2-001 完成 | reviewer agent | S2-001 |
| **L3b** | Packaging config review (electron-builder.yml 正确性) | S2-005 完成 | reviewer agent | S2-005 |
| **L3c** | Stub Detection (无残留 stub/console.log/TODO) | 全部 story 完成 | reviewer agent | ALL |
| **L3a** | Design Review (ADR 合规) | 全部 story 完成 | reviewer agent | ALL |
| **L4** | E2E (手动启动验证) | 全部 story 完成 | User | ALL |
| **L5** | Deploy Validation | 合并前 | orchestrator | ALL |

---

## Expected Output（期望输出）

```
## Task Result: sprint-2-desktop-experience
- Status: PASS | FAIL | BLOCKED
- Changed files:
  - [MODIFIED] SuperNode-desktop/apps/desktop/src/main/tray.ts
  - [MODIFIED] SuperNode-desktop/apps/desktop/src/main/notifications.ts
  - [REWRITTEN] SuperNode-desktop/apps/desktop/src/main/updater.ts
  - [MODIFIED] SuperNode-desktop/apps/desktop/src/main/menu.ts
  - [MODIFIED] SuperNode-desktop/apps/desktop/src/main/packaged-main.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/window-state.ts
  - [NEW] SuperNode-desktop/apps/desktop/src/main/login-item.ts
  - [NEW] SuperNode-desktop/apps/desktop/package.json
  - [NEW] SuperNode-desktop/apps/desktop/tsconfig.json
  - [NEW] SuperNode-desktop/apps/desktop/electron-builder.yml
  - [NEW] SuperNode-desktop/apps/desktop/build/entitlements.mac.plist
  - [NEW] SuperNode-desktop/scripts/desktop/generate-icons.ts
  - [NEW] SuperNode-desktop/apps/desktop/.gitignore
- AC Check:
  - [ ] AC1: Tray 15s 轮询 + 实时状态
  - [ ] AC2: 状态图标切换（绿/黄/红）
  - [ ] AC3: 通知与 daemon 事件联动
  - [ ] AC4: electron-updater 完整实现
  - [ ] AC5: 诊断报告字段增强
  - [ ] AC6: 窗口状态持久化
  - [ ] AC7: 开机自启 toggle
  - [ ] AC8: package.json 完整
  - [ ] AC9: tsconfig.json 正确
  - [ ] AC10: electron-builder.yml 无 asar
  - [ ] AC11: entitlements 权限完整
  - [ ] AC12: 图标生成脚本可运行
  - [ ] AC13: TypeScript 语法通过
  - [ ] AC14: ADR 合规
```

---

## 实施策略

### 执行顺序

```
Phase 1（并行）:
  ├── S2-001: Tray 心跳轮询（backend-dev）
  ├── S2-003: 自动更新实现（backend-dev）
  └── S2-004: 窗口状态 + 开机自启（backend-dev）

Phase 2（Phase 1 完成后）:
  └── S2-002: 通知集成 + 菜单诊断增强（backend-dev）
       ↑ 依赖 S2-001 的轮询结果复用

Phase 3（全部代码完成后）:
  └── S2-005: 打包基础设施（backend-dev）
       ↑ 依赖所有源码就位

Phase 4（全部完成）:
  └── L1 Syntax Check + L2 Logic Review + L3 ADR Compliance + 汇总报告
```

### 关键原则

1. **S2-001、S2-003、S2-004 并行** — 修改不同文件，无依赖冲突
2. **S2-002 后于 S2-001** — 通知复用 tray 的 daemon 状态轮询结果
3. **S2-005 后于所有代码 Story** — 打包需要源码完整
4. **所有 MODIFY 操作** — Agent 必须先 Read 当前文件内容，再做增量 Edit
5. **所有 NEW 操作** — Agent 参考 v3 plan 和 Sprint 1 代码风格
6. **Sprint 2 质量目标** — 零 stub 残留、零 console.log TODO、零死代码

---

## 参考文件清单

| 文件 | 用途 |
|------|------|
| `SuperNode-desktop/doc/ANTI-DRIFT.md` | 防漂移约束（每个 agent 必读） |
| `SuperNode-desktop/doc/paperclip-desktop-implementation-plan-v3.md` | 完整实现方案 |
| `SuperNode-desktop/apps/desktop/src/main/tray.ts` | 待增强的托盘（50行） |
| `SuperNode-desktop/apps/desktop/src/main/notifications.ts` | 待增强的通知（13行） |
| `SuperNode-desktop/apps/desktop/src/main/updater.ts` | 待重写的更新器（16行 stub） |
| `SuperNode-desktop/apps/desktop/src/main/menu.ts` | 待增强的菜单（127行） |
| `SuperNode-desktop/apps/desktop/src/main/packaged-main.ts` | 核心编排（278行，需集成新模块） |
| `SuperNode-desktop/server/src/routes/desktop.ts` | `/api/desktop/status` 端点定义 |
| `server/src/routes/desktop.ts` | 同上（paperclip-master 中的副本） |
| `CLAUDE.md` | 7-Agent 框架 + ADR |
