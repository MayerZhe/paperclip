# Skills Directory

> 2026-06-09 改造后的技能目录。Skills 内容**不会自动注入 Agent context**。
> 规则生效方式: 嵌入 Agent 身份文件（DO/DON'T/ALWAYS）或 orchestrator 在委派 prompt 中显式注入。

## Tier 1: 已嵌入 Agent 身份文件（不要在此查找）

这些技能的实质内容已直接写入 Agent 身份文件:
- karpathy-guidelines → frontend-dev.md, backend-dev.md 的 BEHAVIORS 段
- test-driven-development → backend-dev.md 的 TDD 段
- verification-before-completion → 所有 Agent 的 ALWAYS 段
- simplicity-first, surgical-changes, think-before-coding, goal-driven-execution → 合并入 Karpathy 4 原则

**这些 SKILL.md 文件仍然存在但不会被使用。** 规则已在身份文件中，不需要再读 skill 文件。

## Tier 2: 活跃技能（orchestrator 按条件注入）

| Skill | 注入条件 |
|-------|---------|
| writing-plans | Story 涉及 3+ 文件 |
| executing-plans | 已有实现计划时 |
| systematic-debugging | Bug 修复 Story |
| diagnose | 复杂问题排查 |
| frontend-design | 新建 UI 组件 |
| figma-implement-design | Figma 设计稿 |
| using-git-worktrees | worktree 环境（自动） |
| finishing-a-development-branch | Story 完成后 |
| requesting-code-review | review Story |

## Tier 3: 已归档（SKILL.md 保留但不再使用）

参见 [[ARCHIVED.md]]
