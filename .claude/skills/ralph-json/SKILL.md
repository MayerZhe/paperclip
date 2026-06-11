---
name: ralph-json
description: Use when converting a Markdown PRD into structured prd.json for the Ralph autonomous agent loop. Triggered by phrases like "convert this prd" or "create prd.json"
---

# Ralph PRD to JSON Converter

## Overview

Convert the human-readable PRD (Markdown) into a machine-readable `prd.json` that the Ralph autonomous loop can process. Ralph spawns a fresh agent instance per iteration with no memory of previous work — each story must be completable in one context window.

## Output Format

Save to `prd.json`:

```json
{
  "project": "kebab-case-name",
  "branch": "ralph/kebab-case-name",
  "description": "Brief project description from PRD introduction",
  "stories": [
    {
      "id": "US-001",
      "title": "Brief story description",
      "description": "As a... I want... So that...",
      "acceptanceCriteria": ["measurable 1", "measurable 2"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## Story Sizing Rules (CRITICAL)

**Each story MUST be finishable within a single Ralph iteration (one context window).** Ralph spawns a fresh agent instance per iteration with no memory of previous work.

**Good sizes (2-3 sentences to describe):**
- Add a DB column with migration
- Add a UI component to an existing page
- Update a server action or API endpoint
- Add a filter dropdown to a list

**Too large (must split):**
- "Build the entire dashboard" → split by widget/component
- "Add authentication system" → split by: DB schema, signup, login, password reset, session management
- "Add notifications" → split by: table, service, bell icon, dropdown panel, mark-as-read, preferences page

> **Rule:** If you cannot describe the change in 2-3 sentences, it is too big.

## Dependency Ordering

Stories execute by priority order. Earlier stories must NOT depend on later ones.

**Correct order:**
1. Schema/database changes first
2. Server actions and backend logic
3. UI components consuming that backend
4. Dashboard or summary views

**Wrong:** UI component before its schema exists.

## Acceptance Criteria Rules

Every story MUST have these criteria:

| Criterion | When Required |
|-----------|--------------|
| `"Typecheck passes"` | **Every story** |
| `"Tests pass"` | Any story with testable logic |
| `"Verify in browser using dev-browser skill"` | **Frontend/UI stories** — visual confirmation is mandatory |

Criteria must be directly verifiable by Ralph — nothing vague.

**Good:** "Status column added to tasks table with values 'active' and 'completed'"
**Good:** "Clicking bell icon opens dropdown showing 5 most recent notifications"
**Bad:** "Works correctly" / "Good UX" / "Nice to have"

## Conversion Rules

- Sequential IDs (`US-001`, `US-002`, ...)
- Priority based on dependency order (earlier = lower number)
- All stories start with `passes: false`
- Every story includes `"Typecheck passes"` as final criterion
- Frontend stories include `"Verify in browser"` criterion
- No story depends on a later-priority story

## Archiving Prior Runs

Before writing new `prd.json`, check if one exists with a different branch name. If prior run has progress beyond header: archive both `prd.json` and `progress.txt` into `archive/YYYY-MM-DD-HH-MM/`, then reset progress.

## Pre-Save Checklist

- [ ] Prior runs archived (if applicable)
- [ ] Stories sized for one iteration each
- [ ] Dependencies correctly ordered
- [ ] Every story has `"Typecheck passes"` criterion
- [ ] UI stories include `"Verify in browser"` criterion
- [ ] All criteria are verifiable (nothing vague)
- [ ] No story depends on a later-priority story
