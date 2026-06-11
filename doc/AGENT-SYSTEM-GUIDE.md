# PaperClip Desktop — 7-Agent 协作系统使用指南

> **读者**: 人类开发者 + Claude（AI 协作者）
> **目的**: 定义你（User）与 Claude 如何协作，指挥 7-Agent 系统完成 `supernode-desktop/` 的开发任务。
> **前置阅读**: `CLAUDE.md`（系统架构），`AGENTS.md`（工程规范）

---

## 1. 系统全景

### 1.1 三个角色

```
┌──────────────────────────────────────────────────────┐
│  User (你)                                           │
│  → 提出需求、审查结果、做决策、批准下一步              │
└──────────┬───────────────────────────────────────────┘
           │ 发任务
           ▼
┌──────────────────────────────────────────────────────┐
│  Claude (我)                                         │
│  → 澄清需求、写 Task Spec、委托 orchestrator           │
│  → 回收结果、对照意图验证、向你报告                     │
│  → 我是唯一入口和质量守门人                            │
└──────────┬───────────────────────────────────────────┘
           │ Task Spec
           ▼
┌──────────────────────────────────────────────────────┐
│  orchestrator（编排器）                                │
│  → 只读、不写代码                                      │
│  → select → configure → dispatch → verify → close     │
│  → 派发 specialist agents，逐层过 Quality Gates        │
└──────────┬───────────────────────────────────────────┘
           │ Story dispatch
    ┌──────┼──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│架构│ │前端│ │后端│ │审查│ │测试│
│师  │ │开发│ │开发│ │者  │ │者  │
└────┘ └────┘ └────┘ └────┘ └────┘
```

### 1.2 你的职责

| 环节 | 你做什么 |
|------|---------|
| **提出需求** | 告诉我你想做什么（功能、修复、改进），越具体越好 |
| **澄清确认** | 当我回问确认细节时，做出选择 |
| **审查结果** | 我汇报后，检查是否符合你的意图 |
| **手动验证** | 运行 `pnpm dev`、打开浏览器、操作 UI |
| **决策推进** | "通过，继续下一步" 或 "有问题，修正 X" |
| **合并代码** | 最终确认后执行 commit / PR |

### 1.3 我的职责

| 环节 | 我做什么 |
|------|---------|
| **需求澄清** | 模糊需求 → 追问到你满意 |
| **写 Task Spec** | 结构化任务书（Intent / AC / Stories / Skills） |
| **委托执行** | 把 Spec 交给 orchestrator，监督进度 |
| **回收验证** | 逐项对照 AC 和原始 Intent，不只看 PASS 标签 |
| **偏差修正** | 实现偏离意图 → 写修正 Spec → 重新委托 |
| **报告决策** | 简明汇报 + 推荐下一步，等你确认 |

---

## 2. 一个任务的标准流程

### 2.1 你发起

```
"帮我在 supernode-desktop/ 实现 XYZ 功能"
```

可以附带：
- 参考文档（@ 文件路径）
- 设计稿或 prototype 路径
- 特定的约束（"只能用 REST，不加 IPC"）

### 2.2 我澄清

我会追问：
- 需求边界（什么做、什么不做）
- 技术选型（如有歧义）
- 验收标准（什么叫"完成"）

**你的回应方式**：
- "按 ADR-06，不加 IPC，用 REST"（引用已有决策）
- "做 A 和 B，C 留到 Sprint 2"（明确边界）
- 直接确认我理解的方案

### 2.3 我写 Task Spec 并委托

澄清完毕 → 我写 Task Spec → 委托 orchestrator。

**这个环节你不需要参与**，等待即可。我会告诉你预计涉及哪些 Stories。

### 2.4 我回收并验证

orchestrator 完成后，我会：

1. **对照 Intent 验证** — 实现方向对不对
2. **逐项确认 AC** — 不只是看 PASS 标签
3. **检查 git diff** — 范围是否合理，有无 TODO/HACK
4. **检查 Quality Gates** — L1 TypeCheck / L2 Test / L3 Review 是否全过

### 2.5 你审查并决策

我汇报后，你需要做决定：

| 情况 | 你说 |
|------|------|
| ✅ 完全符合预期 | "通过，提交" 或 "commit 并继续下一步" |
| ⚠️ 大体对但有偏差 | "X 处需要改成 Y，其他 OK" |
| ❌ 方向不对 | "重做，应该是 A 而不是 B" |

### 2.6 循环

```
你发起 → 我澄清 → 我写 Spec → orchestrator 执行 →
我验证 → 你审查 → 通过/修正 → 下一轮
```

---

## 3. Task Spec 阅读指南

当我说"这是 Task Spec"时，它包含以下结构，你可以快速扫一眼确认方向：

```
Intent:        一句话 — 做什么、为什么
Requirements:  功能需求（编号 R1, R2...）
AC:           验收条件（编号 AC1, AC2...）— 可测试、可判断
Stories:       拆解为独立可提交的子任务
  Story 1: 后端 API → backend-dev
  Story 2: 前端组件 → frontend-dev
  Story 3: 测试 → tester
Skills:        每个 Story 匹配 2-5 skills
Quality Gates: L1→L2→L3→L5 逐层验证策略
```

**你重点看**:
- Intent 是否准确表达了你的意思
- AC 是否覆盖了你关心的场景
- Stories 拆分是否合理

不需要看 Skills 匹配细节，那是我和 orchestrator 的事。

---

## 4. Quality Gates — 我们的安全网

每行代码必须通过四层验证，不通过不可合并：

| 层 | 检查 | 谁执行 | 失败后果 |
|----|------|--------|---------|
| **L1** | TypeScript 零类型错误 | orchestrator 跑 `tsc --noEmit` | ❌ 退回重写 |
| **L2** | 单元测试 100% 通过 | orchestrator / tester 跑 `vitest run` | ❌ 退回重写（最多 3 次） |
| **L3a** | 设计审查 | architect agent 审查 | ❌ 退回重写（最多 2 次） |
| **L3b** | API 合约验证 | reviewer agent 扫描前后端对齐 | ❌ 补缺后端 |
| **L3c** | Stub 检测 | reviewer agent 扫描 TODO/FIXME/空实现 | ⚠️ 警告 |
| **L4** | E2E 集成测试 | **你** 手动运行验证 | ⚠️ 警告 |
| **L5** | 部署验证 | orchestrator | ❌ 不可合并 |

**你参与 L4** — 我会告诉你如何验证：
```sh
# 本地启动
pnpm dev
# 打开 http://localhost:3100
# 按操作步骤验证功能
```

---

## 5. 常用场景速查

### 5.1 开发新功能

```
你: "开发 X 功能，参考 @doc/plans/xxx-plan.md"

我: 澄清 → Spec → orchestrator → 验证 → 报告你

你: "通过" / "修正 Y" / "重做"
```

### 5.2 修复 Bug

```
你: "XXX 功能有 Bug，现象是..."

我: 分析根因 → 写 Fix Spec → orchestrator → 验证

你: "确认修复" / "还有另一个问题..."
```

### 5.3 代码审查（不改代码）

```
你: "审查 supernode-desktop/ 的 xxx.ts"

我: 委托 reviewer agent → 汇总问题 → 报告你

你: "修 1 和 3，2 不用管"
```

### 5.4 跑测试 / 验证

```
你: "跑一遍完整测试"

我: orchestrator 执行 L1+L2 → 报告结果

你: 看结果，决定下一步
```

### 5.5 仅规划不编码

```
你: "分析 XXX 怎么做，先别写代码"

我: 委托 architect agent → 出方案 → 讨论

你: "方案 B，按这个写 Spec"
```

---

## 6. 你可以用的指令速查

### 对 Claude 说

| 指令 | 效果 |
|------|------|
| "开发 X" | 启动完整 workflow |
| "先分析 X，别写代码" | 仅规划 |
| "审查这个文件" | 代码审查 |
| "跑测试" | L1+L2 |
| "commit 这些改动" | 按规范提交 |
| "继续下一步" | 推进到下一个 Story |
| "修正 X，重做" | 产生修正 Spec |
| "跳过这个，做下一个" | 跳过一个 Story |

### 查系统状态

| 指令 | 效果 |
|------|------|
| "当前 Sprint 进度" | 汇总完成/进行中/待做 |
| "orchestrator 在做什么" | 当前执行状态 |
| "有哪些 agent" | 列出 7 agent 及其职责 |
| "Quality Gates 状态" | L1-L5 通过情况 |
| "最近 commit 记录" | 查看最近的提交 |

### 启动开发环境

| 指令 | 效果 |
|------|------|
| "启动 PaperClip Dev" | `pnpm dev` → port 3100 |
| "启动 UI Dev" | Vite HMR → port 5173 |
| "运行类型检查" | `pnpm typecheck` |
| "运行全量测试" | `pnpm test:run` |
| "构建" | `pnpm build` |

---

## 7. orchestrator 工作原则（你应该知道）

这些是 orchestrator 的硬约束，了解它们有助于你理解为什么某些事是这样做：

1. **orchestrator 不写代码** — 无 Write/Edit 工具，所有实现通过 Agent 委托
2. **每 Story 独立 commit** — 可单独 revert，不出一个巨型 commit
3. **失败 3 次 → blocked** — 同 Story 失败 3 次自动标记 blocked，需人工介入
4. **每 Story 回写 memory** — 经验教训写入 `.claude/agent-memory/shared/lessons/`
5. **禁止 sed/awk/echo/cat/tee** — 绕过写代码限制的行为被禁止

如果你发现 orchestrator 行为异常（例如卡住、反复失败同一件事），告诉我，我会介入。

---

## 8. 关键约定速查

### 8.1 环境变量（最易出错）

| ✅ 正确 | ❌ 错误 | 说明 |
|---------|---------|------|
| `SERVE_UI=true` | ~~`PAPERCLIP_SERVE_UI`~~ | 桌面端必须 |
| `DATABASE_URL` 不设 | ~~设了指向外部 PG~~ | 不设 → 自启嵌入式 PG |
| `PORT=3100` | ~~`PAPERCLIP_PORT`~~ | |
| `PAPERCLIP_HOME=~/.paperclip` | ~~指向 instance root~~ | |

### 8.2 桌面端铁律

| 规则 | 原因 |
|------|------|
| Electron 壳极薄 | 只 spawn + 窗口管理 |
| 不加 Electron IPC | 复用 40+ REST routes |
| 不用 asar 打包 | PG 二进制无法从 asar 运行 |
| Daemon 自管 PG | Electron 不碰 PG 生命周期 |

### 8.3 代码变更规则

| 规则 | 含义 |
|------|------|
| Company-scoped | 每个 entity 必须绑定公司 |
| Contract sync | Schema 变更 → db + shared + server + ui 四层全更新 |
| Plan docs | 新计划 → `doc/plans/YYYY-MM-DD-slug.md` |

---

## 9. MCP Server 工具速查

当我说"用 XXX 工具"时，以下是各工具的用途：

| MCP Server | 用途 | 典型场景 |
|------------|------|---------|
| **officecli** | 读写 Office 文档 | 读 .docx/.xlsx 需求文档、生成报告 |
| **Claude in Chrome** | 浏览器自动化 | E2E 验证、截图对比、操作 UI |
| **Claude Preview** | 本地 dev server 预览 | 启动 pnpm dev 后在浏览器查看 |
| **ccd_directory** | 访问项目外目录 | 读取 Multi-Agent-Architecture 参考文档 |
| **ccd_session** | 创建后台任务 | 发现需要独立处理的子问题 |
| **ccd_session_mgmt** | 跨 session 通信 | 查看其他 session 的状态 |
| **scheduled-tasks** | 定时任务 | 定期健康检查、每日构建 |

---

## 10. 排障指南

### 10.1 orchestrator 卡住

**现象**: 同一个 Story 反复失败，进度不动。

**你**: "orchestrator 卡在 Story X，手动介入"

**我**: 查看日志 → 分析根因 → 可能：
- 写修正 Spec
- Mark blocked，改 Story 拆分
- 人工执行部分步骤

### 10.2 测试失败

**现象**: L1/L2 不通过。

**我**: 分析失败原因 → 分类为测试 bug 还是代码 bug → 修正 → 重试 ≤ 3 次

**如果还是失败**: 我会告诉你具体原因，等你决策。

### 10.3 代码偏离意图

**现象**: 你审查时发现实现不对。

**你**: "X 处应该是 Y，不是现在的 Z"

**我**: 写修正 Spec，精确描述偏差和修正目标 → 重新委托 → 再次验证

### 10.4 环境问题

**现象**: `pnpm dev` 启动失败、PG 错误等。

**你**: "环境有问题，帮我诊断"

**我**: 检查 pnpm/node 版本 → 检查端口占用 → 检查 PG 状态 → 给出修复步骤

### 10.5 不确定是否要做

**现象**: 技术决策有多种方案。

**你**: "XXX 有几种做法，分析一下"

**我**: 委托 architect agent → 出对比方案 → 列出利弊 → 推荐 → 等你选择

---

## 11. 开发节奏建议

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Sprint 0 │ ──▶ │ Sprint 1 │ ──▶ │ Sprint 2 │ ──▶ Sprint 3
│ 验证     │     │ 核心壳   │     │ 桌面体验 │     │ 多平台
│ 3 天     │     │ 2 周     │     │ 2 周     │     │ 1-2 周
└──────────┘     └──────────┘     └──────────┘
```

**每个 Sprint 的内部节奏**:

1. 你先说"开始 Sprint X"
2. 我分析 Sprint 目标 → 拆解为 Task Specs → 排优先级
3. 按 Story 逐个推进（你每次审查一个 Story 的结果）
4. Sprint 结束 → 我汇总 → 你确认 → 进入下一 Sprint

**典型一天**:

```
早晨: 你 → "继续昨天的 Story 3"
上午: 我 → 委托 → orchestrator 执行
中午: 我 → 回收结果 → 验证 → 报告你
下午: 你 → 审查 → "通过" / "修正 X"
傍晚: 我 → commit / 修正 → 准备下一个 Story
```

---

## 12. 一页纸速查卡

```
User:  "开发 X" ────────────────────────────────┐
                                                 │
Claude: 澄清 → Spec → 委托 orchestrator           │
        → 回收 → 验证 → 报告 ──────────────────┐ │
                                               │ │
User 决策:                                     │ │
  "通过" → commit → 下一个 Story                │ │
  "修正 Y" → 修正 Spec → 重做 ─────────────────┘ │
  "重做" → 新 Spec ─────────────────────────────┘

Quality Gates: L1(类型) → L2(测试) → L3(审查) → L4(你验证) → L5(部署)

铁律:
  Electron 极薄 | 不加 IPC | 不用 asar | Daemon 自管 PG
  SERVE_UI=true (不是 PAPERCLIP_SERVE_UI!)
  DATABASE_URL 不设

文件:
  约定 → CLAUDE.md + .claude/agent-memory/shared/conventions/
  设计 → doc/plans/YYYY-MM-DD-slug.md
  记忆 → .claude/agent-memory/shared/lessons/
```
