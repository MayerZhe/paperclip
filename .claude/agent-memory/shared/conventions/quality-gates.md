---
name: quality-gates
description: L1-L4 layered verification protocol for orchestrator quality enforcement
metadata:
  type: convention
  shared: true
---

# Quality Gate Standards (L1-L4)

All agents MUST understand which verification layer their work targets.

## L1: Type Check
- **Who**: orchestrator (Bash) or developer agent
- **What**: `tsc --noEmit` (TS) / `py_compile` (Python)
- **Standard**: Zero type errors
- **On Fail**: ❌ BLOCK — return to developer agent

## L2: Unit Tests
- **Who**: developer agent or tester agent
- **What**: `pytest` / `vitest run` — full suite
- **Standard**: 100% pass rate
- **On Fail**: ❌ BLOCK — classify test bug vs code bug, retry ≤3

## L3: API Contract Validation
- **Who**: reviewer agent
- **Trigger**: fullstack story OR frontend+backend paired
- **Standard**: Zero endpoints in "frontend calls but backend missing"
- **On Fail**: ❌ Delegate backend-dev to fill gaps

## L4: Integration/E2E
- **Who**: orchestrator (script gen) + user (execution)
- **Trigger**: After ALL stories pass L1-L3
- **Standard**: verify-e2e.sh exit code 0
- **On Fail**: ⚠️ WARNING — sandbox limitation, manual verification needed

Related: [[paperclip-architecture]], [[paperclip-desktop]]
