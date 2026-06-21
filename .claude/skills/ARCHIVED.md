# Archived Skills（Tier 3）

以下 26 个 skills 已从 Agent frontmatter 中移除。SKILL.md 文件保留但不会被 Agent 加载。

归档原因:

## 太薄（<1KB，无实质内容）
- zoom-out (430B) — "给全景视角"不需要独立文件
- grill-me (635B) — 已在身份文件 ALWAYS 段
- brainstorming (965B) — 委派 prompt 直接说"考虑 3 种方案"
- creative-director (998B) — 原型已定义设计方向
- brand-guidelines (935B) — 原型已定义视觉规范
- design-brief (819B) — architect 不运行
- design-consultation (797B) — architect 不运行
- design-md (869B) — architect 不运行
- design-review (925B) — architect 不运行
- plan-design-review (774B) — architect 不运行
- platform-design (842B) — architect 不运行
- handoff (847B) — 太薄

## 从未触发（项目不需要）
- canvas-design (900B) — 无 Canvas 需求
- gsap-core (1.1K) — 无动画需求
- gsap-react (1.2K) — 无动画需求
- gsap-scrolltrigger (1.3K) — 无动画需求
- gsap-timeline (1.3K) — 无动画需求
- prototype (3.2K) — 原型在 HTML 文件里

## Orchestrator 内建能力（不需要独立 skill）
- loop-operator (1.3K)
- multi-execute (1.2K)
- dispatching-parallel-agents (6.4K)
- deploy-validation (2.6K)

## 不适用
- setup-pre-commit (2.2K) — 一次性操作
- setup-matt-pocock-skills (6.8K) — 第三方
- scaffold-exercises (3.6K) — 教学用途
- write-a-skill (3K) — 元技能
- git-guardrails-claude-code (2.3K) — Claude Code 内置

## 处理
- 从 Agent frontmatter `skills:` 字段中移除 ✅
- SKILL.md 文件保留在磁盘上（上游来源，不删除）
- 不会被任何 Agent 加载或引用
