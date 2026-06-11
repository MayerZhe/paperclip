# Executor Skill Catalog（参考文件）

> 此文件是从 orchestrator.md 提取的 Skill Catalog，供 orchestrator 在委派时参考。
> 注意：skills 在前端 frontmatter 中只是"可用"声明，SKILL.md 内容不会自动注入 Agent context。
> Tier 1 技能（Karpathy/TDD/verification）已嵌入各 Agent 身份文件。
> 此目录仅用于 Tier 2（按需注入）和 Tier 3（已废弃）的参考。

## 匹配规则

1. 确定 story.stack → 选择对应 Agent
2. 阅读 story.description → 识别任务类型
3. Tier 2 skills 由 orchestrator 在委派 prompt 中显式注入内容（不是注入名称）

## 快速匹配速查表

| Story 类型 | 匹配 Agent | Tier 2 Skills 注入 |
|-----------|-----------|-------------------|
| 新建 UI 页面/组件 | frontend-dev | frontend-design |
| 动画/交互效果 | frontend-dev | gsap-core, gsap-react（如需要） |
| CRUD API 端点 | backend-dev | writing-plans |
| 复杂业务逻辑/算法 | backend-dev | writing-plans, mp-tdd |
| Bug 修复 | frontend-dev / backend-dev | systematic-debugging |

## Tier 1（已嵌入 Agent 身份文件，不需要注入）

- karpathy-guidelines — 4 原则嵌入所有 developer agent
- test-driven-development — TDD 铁律嵌入 backend-dev
- verification-before-completion — 强制验证嵌入所有 agent
- simplicity-first, surgical-changes, think-before-coding, goal-driven-execution — Karpathy 子原则已合并

## Tier 2（保留 skill 文件，orchestrator 按条件注入）

| Skill | 大小 | 注入条件 |
|-------|:----:|---------|
| writing-plans | 6.1K | Story 涉及 3+ 文件 |
| executing-plans | 2.5K | 已有实现计划时 |
| systematic-debugging | 9.8K | Bug 修复 Story |
| diagnose | 7.1K | 复杂问题排查 |
| frontend-design | 1.1K | 新建 UI 组件 |
| figma-implement-design | 1K | Figma 设计稿 |
| using-git-worktrees | 8K | worktree 环境（自动） |
| finishing-a-development-branch | 7K | Story 完成后 |
| requesting-code-review | 2.8K | review Story |

## Tier 3（已废弃，SKILL.md 保留但不使用）

zoom-out, grill-me, brainstorming, creative-director, brand-guidelines,
design-brief, design-consultation, design-md, design-review, plan-design-review,
platform-design, canvas-design, gsap-core, gsap-react, gsap-scrolltrigger,
gsap-timeline, caveman, handoff, loop-operator, multi-execute,
dispatching-parallel-agents, prototype, grill-with-docs,
setup-pre-commit, setup-matt-pocock-skills, scaffold-exercises, write-a-skill,
git-guardrails-claude-code

## 委派 prompt 注入模板

```
## Active Behaviors（已嵌入你身份，MUST遵守）
- Karpathy 4 原则: ...
- TDD: ...
- Verification: ...

## Task-Specific Guidance
{当适用时，从 Tier 2 注入对应 skill 的关键内容，不是只写名字}

### 任务
{Spec 原文}

### 验收标准
{AC 原文}
```
