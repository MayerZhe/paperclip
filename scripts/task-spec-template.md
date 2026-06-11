# Task Spec Template

> **用途**: Claude（主 session）向 orchestrator 委派任务的标准格式。
> **原则**: 每个字段都是强制性的 — 缺失字段会导致 orchestrator 误判或跳过关键步骤。
> **关键**: Required Skills 是防止执行层跑偏的核心机制 — Claude MUST 根据 Executor Skill Catalog 精确匹配。

---

## Task Spec: {task-id}

### Intent（用户原始意图）
<!-- 保留用户的业务语言，不做技术翻译。这是最终核验的基准。 -->

> {用户原话或澄清后的意图摘要}

### Context（背景约束）
<!-- 技术栈、已有代码、特殊限制 -->

- **Stack**: {nextjs | react | python-fastapi | go | ...}
- **Relevant Files**: {已有文件路径}
- **Constraints**: {部署环境、性能要求、兼容性等}

### Requirements（需求拆解）
<!-- 逐条列出，每条都是独立的、可验证的工作单元 -->

1. {需求 1}
2. {需求 2}
3. ...

### Acceptance Criteria（验收标准）
<!-- 每条必须可测试。前端 story 必须包含视觉验证项。 -->

- [ ] AC1: {可测试的验收条件}
- [ ] AC2: {可测试的验收条件}
- [ ] AC3: {可测试的验收条件}
<!-- 前端 story 必须包含: -->
- [ ] Visual: {截图对比 / 组件状态 / 响应式}

### Story Breakdown（Story 拆解）
<!-- 每个 story 在一个 context window 内可完成 -->

```json
[
  {
    "id": "S-001",
    "title": "{用户故事标题}",
    "description": "{作为 <角色>，我希望 <功能>，以便 <价值>}",
    "acceptanceCriteria": ["AC1", "AC2"],
    "stack": "frontend | backend | fullstack",
    "priority": 1,
    "dependencies": []
  }
]
```

### Required Skills（强制技能 — 防止执行层跑偏）
<!-- 
  Claude 根据 Executor Skill Catalog 精确匹配。
  每条包含: skill 名称 → 为什么需要 → 如何使用。
  orchestrator 必须将这些注入委派 prompt。
-->

| Story | Core Skills（1-2个） | Verify Skills（1个） | Workflow Skills（1个） |
|-------|---------------------|---------------------|----------------------|
| S-001 | {skill-name}: {why} | {skill-name}: {why} | {skill-name}: {why} |

**Skill Usage Instructions**（注入委派 prompt 的原文）:
```
## Required Skills
- **{skill_1}**: {触发条件} — {使用指导}
- **{skill_2}**: {触发条件} — {使用指导}
- **{skill_3}**: {触发条件} — {使用指导}

### Skill 激活要求
1. 开始前 Read 每个 skill 的 SKILL.md (.claude/skills/<skill-name>/SKILL.md)
2. 遵循每个 skill 规定的工作流，不跳过步骤
3. 实现完成后用 Verification Chain skills 逐条验证
```

### Verification Chain（验证链）
<!-- 从 L1-L5 中选取适用的层级 -->

| Layer | Gate | Trigger | Executor |
|-------|------|---------|----------|
| L1 | Type Check | 每个 story | orchestrator (Bash) |
| L2 | Unit Tests | 每个 story | orchestrator (Bash) / tester |
| L3a | Design Review | frontend story | architect agent |
| L3b | Contract Validation | fullstack story | reviewer agent |
| L3c | Stub Detection | backend story | reviewer agent |
| L4 | E2E | 全部 story 完成 | user (手动) |
| L5 | Deploy Validation | 合并前 | orchestrator (Bash) |

### Expected Output（期望输出）
<!-- orchestrator 完成后的回执格式 -->

```
## Task Result: {task-id}
- Status: PASS | FAIL | BLOCKED
- Changed files: [{paths}]
- Commit: {hash}
- AC Check:
  - [x] AC1: {pass/fail note}
  - [x] AC2: {pass/fail note}
- Notes: {意外发现、技术决策、已知限制}
```

---

## 使用流程

```
用户给任务
    │
    ▼
Claude 澄清需求（AskUserQuestion / 对话）
    │
    ▼
Claude 编写 Task Spec（使用此模板）
    ├── 拆解 Story
    ├── 匹配 Skills（查询 Executor Skill Catalog）
    └── 定义验证链
    │
    ▼
Claude 委派 orchestrator:
  "使用 orchestrator 执行以下 Task Spec: [spec内容]"
    │
    ▼
orchestrator S0→S3→S4→S5
    ├── S3: 按 spec 中指定的 skills 委派 specialist
    ├── S4: 按 spec 中指定的验证链执行门禁
    └── S5: 返回 Task Result
    │
    ▼
Claude 核验:
    ├── 对照 Intent 验证结果
    ├── 逐条检查 AC
    └── 如有偏差 → 写修正 Spec → 重新委派
    │
    ▼
Claude 报告用户
```
