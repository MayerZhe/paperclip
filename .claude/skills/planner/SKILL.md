---
name: planner
description: Use when starting any complex task. Creates a comprehensive implementation strategy with phases, dependencies, risk assessment, and verification checkpoints before any code is written.
---

# Planner

## Overview

Create a comprehensive implementation strategy before writing any code. The planner identifies dependencies, assesses risks, and breaks work into incremental, verifiable steps.

This skill is invoked **before Phase 1 (Architecture Review)** in the standard development workflow.

## Blueprint Structure

```markdown
## Goal
<One sentence: what success looks like>

## Dependencies
- External services, APIs, or data changes needed
- Other stories/tasks this depends on

## Risk Assessment
- What could go wrong?
- What's the rollback strategy?

## Phases
### Phase 1: <Name>
- Files to create/modify
- API contracts (if applicable)
- Data model changes (if applicable)
- Verification checkpoint

### Phase 2: <Name>
...
```

## Rules

- Plans exist to be updated — when reality diverges, revise the plan
- Each phase must produce something independently verifiable
- If a phase has more than 5 steps, split it into sub-phases
- Unknowns are marked explicitly: `[NEEDS CLARIFICATION]`
- The planner identifies dependencies BEFORE the search-first workflow runs

## Integration

The planner runs **before** implementation. After planning:
1. Run search-first workflow to find existing libraries/patterns
2. Proceed to architecture review (if needed)
3. Begin implementation phase by phase

## When NOT to Use

- Single-file, single-change fixes
- Trivial tasks with one obvious solution
- Tasks completable in under 5 trivial steps
