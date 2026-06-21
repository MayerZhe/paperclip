---
name: multi-execute
description: Use when executing multiple independent tasks simultaneously. Launches parallel agent instances, each in its own worktree, for maximum throughput.
---

## Overview

When stories have no dependencies between them, execute them in parallel. Launch multiple agents simultaneously, each in an isolated worktree.

## Parallel Execution Pattern

```
For each independent story:
  ├─ Create worktree
  ├─ Launch agent (frontend-dev or backend-dev based on stack)
  ├─ Agent implements → tests → commits
  └─ Collect results

Wait for all agents to complete, then:
  ├─ Verify no merge conflicts between worktrees
  ├─ Integrate all changes
  └─ Run full test suite on integrated code
```

## Preconditions

- Stories must have no dependencies between them (check `dependsOn` field)
- Each agent gets its own worktree — no file sharing
- Sufficient system resources for parallel execution

## Rules

- Maximum 3 parallel agents (to manage resource usage)
- If any parallel agent fails, other agents continue independently
- Run integration tests after all agents complete — parallel work may expose hidden coupling
