# Shared Agent Memory — Cross-Agent Knowledge

Cross-agent shared knowledge. Managed by orchestrator (read+write), consumed by specialist agents.

## Load Rules (orchestrator MUST)

Before delegating an agent:
1. Read `lessons/INDEX.md` → keyword match against Spec → pick 2-4 most relevant → extract key paragraphs
2. Load applicable conventions (check `conventions/` for domain matches)
3. Inject Context Package (≤ 5K tokens, key paragraphs only, not full files)

After each story:
4. Write `lessons/story-{id}-{date}.md` (success patterns + failure patterns + key decisions)
5. Update `lessons/INDEX.md` (append keyword entry for the new file)

## Directory Structure

```
shared/
├── MEMORY.md              ← This file (orchestrator reads on startup)
├── conventions/            ← Rules all agents must follow
│   ├── quality-gates.md    ← L1-L5 verification protocol
│   └── git-commits.md      ← Commit format and branch strategy
├── lessons/                ← Story-archived experience
│   └── INDEX.md            ← ★ Keyword index (orchestrator MUST read)
├── patterns/               ← Reusable code patterns
│   └── sandbox-workarounds.md
└── reference/              ← Reference docs (not injected into context)
    └── skill-catalog.md    ← Skill Catalog (extracted from orchestrator.md)
```

## Per-Agent Memory

Each agent has its own directory for private knowledge:
- `orchestrator/MEMORY.md` — orchestration patterns
- `frontend-dev/MEMORY.md` — frontend patterns
- `backend-dev/MEMORY.md` — backend patterns
- `tester/MEMORY.md` — testing patterns
- `reviewer/MEMORY.md` — review patterns

Per-agent memory is managed by the agent itself, not injected by orchestrator.

