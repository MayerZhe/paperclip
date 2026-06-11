---
name: loop-operator
description: Use when running autonomous iteration loops. Repeatedly selects next task, dispatches agent, verifies result, and commits — until all tasks pass or max iterations reached.
---

## Overview

The loop operator drives autonomous execution: select → dispatch → verify → commit → repeat. Each iteration uses a fresh agent instance to prevent context bloat.

## Loop Algorithm

```
while (stories remain with passes=false) and (iterations < max):
  1. Select highest-priority unblocked story where passes=false
  2. Check dependencies — skip if any dependency hasn't passed
  3. Route to appropriate agent (frontend-dev / backend-dev)
  4. Wait for agent completion
  5. Run quality gates (type check, tests, lint)
  6. If passes: git commit, update prd.json (passes=true)
  7. If fails: increment retry count, record in progress.txt
  8. If retries >= 3: mark blocked, notify user
  9. Append learnings to AGENTS.md
```

## Safety Limits

- Max iterations: configurable (default 20)
- Max retries per story: 3
- Story timeout: agent must respond within a reasonable time
- Doom loop detection: same error 3 times in a row → stop and escalate

## Output

- Updated `prd.json` with passes/blocked status
- `progress.txt` with per-iteration learnings
- `AGENTS.md` with accumulated patterns
