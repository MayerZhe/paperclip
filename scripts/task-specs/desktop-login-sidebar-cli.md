# Task Spec: desktop-login-sidebar-cli

> Plan: `/Users/Mayer/.claude/plans/elegant-tumbling-spark.md`
> Feature Branch: `feature/agenthubs-local-development`
> Current Branch: `claude/hopeful-yonath-4e566c`

## Intent（用户原始意图）

> 完成 Plan 中所有开发任务（Task A: 登录系统 + Sidebar 重构 + Task B: Agent CLI 引导），并测试通过所有测试。

核心体验：Claude Desktop 风格 — 左边原生侧边栏，横向 tabs 切换 AgentHubs（cowork）和 Agent（code）两种模式。双模同时运行，WebContentsView 切换可见性。登录通过 agenthubs.dev 完成，token 从 session localStorage 读取。Agent CLI 引导页面放在 paperclip UI 的 Instance Settings 下。

## Context（背景约束）

- **Stack**: Electron 39+ (main), TypeScript, React + Vite + Tailwind (UI), Docker Compose (AgentHubs VM)
- **Relevant Files**:
  - `apps/desktop/src/main/packaged-main.ts` — 核心编排，需重写 `runDesktopMain()`
  - `apps/desktop/src/main/mode-manager.ts` — 单模状态机，需重构为 `startBothModes()`
  - `apps/desktop/src/main/agenthubs-mode.ts` — VM 生命周期，保持不动
  - `apps/desktop/src/main/cli-scanner.ts` — CLI 扫描，保持不动
  - `apps/desktop/src/main/menu.ts` — 应用菜单，需新增 Mode 子菜单
  - `apps/desktop/src/main/tray.ts` — 系统托盘，保持不动
  - `apps/desktop/src/preload/index.ts` — preload bridge，需扩展 IPC
  - `ui/src/App.tsx` — 路由，需新增 agent-cli 路由
- **Constraints**:
  - ADR-01: 不用 asar
  - ADR-02: Electron 壳极薄
  - ADR-06: 不加 Electron IPC 协议（复用 REST + 少量 IPC）
  - 不改 agenthubs 项目任何代码
  - cli-scanner.ts 保持不动

## Requirements（需求拆解）

### Task A: 登录 + Sidebar

1. **auth-bridge.ts** — 登录 BrowserWindow 管理、导航检测、token 提取、session 复用
2. **sidebar-manager.ts** — WebContentsView 创建/定位/可见性切换、窗口 resize 处理
3. **shell.html + shell.css + shell.js** — Sidebar UI（260px 宽，dark theme，horizontal tabs，org info，status dots，user footer）
4. **shell-preload.ts** — Sidebar window 的 contextBridge IPC
5. **mode-manager.ts 重构** — 从 "停一个启一个" 改为 `startBothModes()` 并行启动
6. **packaged-main.ts 重写** — `runDesktopMain()` 改为 "login → start both → sidebar → IPC"
7. **menu.ts 适配** — 新增 Mode 子菜单（active tab indicator）
8. **preload/index.ts 扩展** — 新增 sidebar IPC channels

### Task B: Agent CLI 引导

9. **InstanceAgentCli.tsx** — React 组件，展示 10 种 CLI，3 种可安装（Claude/Codex/Antigravity）
10. **App.tsx 路由** — 新增 `<Route path="agent-cli" element={<InstanceAgentCli />} />`
11. **preload/index.ts CLI IPC** — 新增 `getCliScan()`, `installCli(adapterType)`
12. **packaged-main.ts CLI handlers** — 注册 `paperclip:get-cli-scan` + `paperclip:install-cli`
13. **cli-scanner.ts Antigravity** — 添加 Antigravity CLI 到 CLI_WHITELIST

## Acceptance Criteria（验收标准）

### Task A
- [ ] AC-A1: auth-bridge.ts 正确创建登录窗口、检测登录完成、提取 token、支持 session 复用
- [ ] AC-A2: sidebar-manager.ts 正确创建 WebContentsView、切换可见性、响应 resize
- [ ] AC-A3: shell.html 渲染正确 — 260px sidebar + horizontal tabs + org info + status dots + user footer
- [ ] AC-A4: shell-preload.ts 暴露正确 IPC bridge 给 shell window
- [ ] AC-A5: `startBothModes()` 并行启动 agent daemon + agenthubs docker compose
- [ ] AC-A6: `runDesktopMain()` 完整流程: auth → startBothModes → sidebar → IPC handlers → menu/tray
- [ ] AC-A7: menu.ts Mode 子菜单正确显示 active tab
- [ ] AC-A8: preload/index.ts 暴露 sidebar IPC channels

### Task B
- [ ] AC-B1: `/instance/settings/agent-cli` 页面可访问
- [ ] AC-B2: 页面展示 10 种 CLI，found/not-found 状态正确
- [ ] AC-B3: 只有 Claude CLI、Codex CLI、Antigravity CLI 有 Install 按钮
- [ ] AC-B4: Install 按钮执行正确的安装命令
- [ ] AC-B5: "Complete Setup" 持久化完成状态
- [ ] AC-B6: Antigravity CLI 已添加到 CLI_WHITELIST

### 全量
- [ ] AC-ALL: `pnpm typecheck` 通过（desktop 目录）
- [ ] AC-ALL: 所有现有测试仍然通过

## Story Breakdown（Story 拆解）

```json
[
  {
    "id": "S-A1",
    "title": "Create shell renderer files (shell.html, shell.css, shell.js, shell-preload.ts)",
    "description": "创建 Sidebar UI 的 4 个静态文件。shell.html 包含完整 DOM（horizontal tabs、org panel、status dots、user footer），shell.css 使用 agenthubs.dev dark theme 配色，shell.js 处理 tab 点击和 IPC 通信，shell-preload.ts 暴露 contextBridge。",
    "acceptanceCriteria": ["AC-A3", "AC-A4"],
    "stack": "frontend",
    "priority": 1,
    "dependencies": []
  },
  {
    "id": "S-A2",
    "title": "Create auth-bridge.ts — login BrowserWindow + token extraction",
    "description": "创建登录桥接模块。创建 BrowserWindow 加载 https://agenthubs.dev/login，使用 persist:agenthubs session partition，监视 did-navigate 检测登录完成（/login → /select-org），通过 executeJavaScript 读取 localStorage token，拦截 OrgSelect 的 localhost:4000 redirect，调用 agenthubs.dev API 获取 orgs 列表。支持 checkExistingSession() 在重启时复用 session。",
    "acceptanceCriteria": ["AC-A1"],
    "stack": "backend",
    "priority": 2,
    "dependencies": []
  },
  {
    "id": "S-A3",
    "title": "Create sidebar-manager.ts — WebContentsView management",
    "description": "创建 Sidebar 管理器。创建 main BrowserWindow 加载 shell.html，创建两个 WebContentsView（agent :3100, agenthubs :4000），用 addChildView 添加到 contentView，监听 resize 重新计算 bounds（sidebar 260px + content area）。提供 switchToMode() 通过 setVisible() 切换，updateOrgInfo()/updateStatus() 推送数据到 shell。",
    "acceptanceCriteria": ["AC-A2"],
    "stack": "backend",
    "priority": 3,
    "dependencies": ["S-A1"]
  },
  {
    "id": "S-A4",
    "title": "Refactor mode-manager.ts — startBothModes() parallel startup",
    "description": "重构模式管理器。移除单模状态机（switchToMode 切换逻辑），新增 startBothModes() 使用 Promise.allSettled 并行启动 agent daemon + agenthubs docker compose。保留 startAgentDaemon()/stopAgentDaemon() 作为实现细节。新增 ModeStartupResult 接口。",
    "acceptanceCriteria": ["AC-A5"],
    "stack": "backend",
    "priority": 4,
    "dependencies": ["S-A2", "S-A3"]
  },
  {
    "id": "S-A5",
    "title": "Rewrite packaged-main.ts runDesktopMain() — integrated flow",
    "description": "重写主启动流程。新流程: checkExistingSession → (if no session) createAuthBridge → startBothModes → createSidebarManager → push org/status data → register IPC handlers → createTray + createAppMenu → shutdown handler。移除 createModeSwitchHandler、createMainWindow 中的旧逻辑。新增 CLI scan IPC handlers。",
    "acceptanceCriteria": ["AC-A6", "AC-A8"],
    "stack": "backend",
    "priority": 5,
    "dependencies": ["S-A4"]
  },
  {
    "id": "S-A6",
    "title": "Update menu.ts — Mode submenu as tab-aware",
    "description": "更新应用菜单。新增 Mode 子菜单，显示当前 active tab（AgentHubs/Agent），提供 Switch Tab 命令（Cmd+Shift+M）。不再使用 radio button 互斥模式。",
    "acceptanceCriteria": ["AC-A7"],
    "stack": "backend",
    "priority": 6,
    "dependencies": ["S-A5"]
  },
  {
    "id": "S-B1",
    "title": "Add Antigravity CLI + CLI IPC handlers",
    "description": "在 cli-scanner.ts 的 CLI_WHITELIST 中添加 Antigravity CLI（adapterType: antigravity_local, command: antigravity）。在 packaged-main.ts 中注册 paperclip:get-cli-scan 和 paperclip:install-cli IPC handlers。get-cli-scan 调用已有 scanCliAvailability()，install-cli 只允许 claude_local/codex_local/antigravity_local 三种。",
    "acceptanceCriteria": ["AC-B4", "AC-B6"],
    "stack": "backend",
    "priority": 7,
    "dependencies": ["S-A5"]
  },
  {
    "id": "S-B2",
    "title": "Extend preload/index.ts — CLI IPC bridge",
    "description": "在 preload/index.ts 中新增 getCliScan() 和 installCli(adapterType) IPC 方法，通过 ipcRenderer.invoke 调用主进程。",
    "acceptanceCriteria": ["AC-A8"],
    "stack": "backend",
    "priority": 8,
    "dependencies": ["S-B1"]
  },
  {
    "id": "S-B3",
    "title": "Create InstanceAgentCli.tsx React component + route",
    "description": "创建 Agent CLI 引导页面 React 组件（ui/src/pages/InstanceAgentCli.tsx）。展示 10 种 CLI 的检测结果，只有 Claude CLI/Codex CLI/Antigravity CLI 三个有 Install 按钮。包含 Refresh Scan 和 Complete Setup 按钮。在 ui/src/App.tsx 的 Instance Settings Layout 下新增 agent-cli 路由。",
    "acceptanceCriteria": ["AC-B1", "AC-B2", "AC-B3", "AC-B5"],
    "stack": "frontend",
    "priority": 9,
    "dependencies": ["S-B2"]
  }
]
```

## Required Skills（强制技能 — 防止执行层跑偏）

| Story | Core Skills（1-2个） | Verify Skills（1个） | Workflow Skills（1个） |
|-------|---------------------|---------------------|----------------------|
| S-A1 | frontend-dev: shell UI 是纯 HTML/CSS/JS，非 React | — | — |
| S-A2 | backend-dev: Electron main process 登录桥接 | reviewer: 安全审查 token 处理 | — |
| S-A3 | backend-dev: Electron WebContentsView API | reviewer: 验证 bounds 计算 | — |
| S-A4 | backend-dev: 重构模式管理器 | reviewer: 验证 Promise.allSettled 逻辑 | — |
| S-A5 | backend-dev: 重写主启动流程 | reviewer: 验证事件循环和关闭流程 | — |
| S-A6 | backend-dev: 菜单系统更新 | — | — |
| S-B1 | backend-dev: IPC handler + CLI whitelist | reviewer: 验证 install 只允许白名单 | — |
| S-B2 | backend-dev: preload contextBridge 扩展 | — | — |
| S-B3 | frontend-dev: React 组件 + Tailwind + shadcn/ui | reviewer: 验证组件状态 | — |

### Ultracode Injection（追加到每个 Agent delegation prompt）

```
Think at ultracode depth. Before writing any code:
1. 识别所有 edge cases 和 boundary conditions
2. 考虑 failure modes 并写 defensive error handling
3. 评估性能影响（N+1 queries, memory, blocking I/O）
4. 审计安全面（input validation, auth, injection, data exposure）
5. 对照 prototype / reference implementation 验证
6. 写能证明正确性的测试，不只是追求覆盖率
```

## Verification Chain（验证链）

| Layer | Gate | Trigger | Executor |
|-------|------|---------|----------|
| L1 | Type Check (`tsc --noEmit`) | 每个 story 完成后 | orchestrator (Bash) |
| L2 | Unit Tests (`vitest run`) | 所有 story 完成后 | orchestrator (Bash) |
| L3b | Contract Validation | S-A2, S-A5 | reviewer agent |
| L3c | Stub Detection | 所有 story 完成后 | reviewer agent |

## Expected Output（期望输出）

```
## Task Result: desktop-login-sidebar-cli
- Status: PASS | FAIL | BLOCKED
- Changed files: [{paths}]
- Commits: [{hashes}]
- AC Check:
  - [x] AC-A1~A8: {pass/fail notes}
  - [x] AC-B1~B6: {pass/fail notes}
  - [x] AC-ALL: typecheck + tests
- Notes: {意外发现、技术决策、已知限制}
```
