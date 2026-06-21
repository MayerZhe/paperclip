---
name: ralph-prd
description: Use when the user asks you to create a PRD, plan a feature, or "think through" requirements before implementation
---

# Ralph PRD Generator

## Overview

Convert user requirements into a structured Product Requirements Document. Each story must be specific enough to implement without ambiguity.

**Announce at start:** "I'm using the ralph-prd skill to create a structured PRD."

## Step 1: Clarifying Questions

Before writing the PRD, ask 3-5 essential clarifying questions with lettered multiple-choice options. Cover:

- **Problem/Goal:** What problem does this solve? Who is the user?
- **Core Functionality:** What must it do? What's the MVP scope?
- **Scope/Boundaries:** What's explicitly NOT included?
- **Success Criteria:** How will we know this is done correctly?

## Step 2: Generate PRD

Save to `tasks/prd-[feature-name].md`.

### Required PRD Sections

```markdown
# [Feature Name]

## Introduction
<1-2 sentences describing the feature and its value>

## Goals
- <goal 1>
- <goal 2>

## User Stories

### US-001: <Story Title>
**As a** <user type>
**I want** <action/capability>
**So that** <benefit/value>

**Acceptance Criteria:**
- [ ] <measurable condition 1>
- [ ] <measurable condition 2>

### US-002: ...

## Functional Requirements
1. <numbered requirement 1>
2. <numbered requirement 2>

## Non-Goals
- <explicitly out of scope 1>
- <explicitly out of scope 2>

## Design & Technical Considerations
- <key technical decision>
- <architecture note>

## Success Metrics
- <measurable outcome 1>

## Open Questions
- <unresolved question 1>
```

## Rules

- Every story must have measurable acceptance criteria — not "works correctly"
- Write for junior developers or AI agents: be explicit, avoid jargon, use numbered requirements
- Each story should be implementable in one session by one agent
- Stories must not depend on later-priority stories
- **Do NOT start implementing. Just create the PRD.**

## Pre-Save Checklist

- [ ] All user stories have acceptance criteria
- [ ] Functional requirements are numbered and explicit
- [ ] Non-goals are clearly stated
- [ ] Each story is sized for one implementation session
- [ ] Dependencies between stories are clear
- [ ] Vague criteria replaced with measurable ones

## Example PRD Excerpt

```markdown
# Task Priority System

## Introduction
Allow users to set priority levels on tasks so they can focus on what matters most.

## User Stories

### US-001: Set Task Priority
**As a** task owner
**I want** to mark a task as High/Medium/Low priority
**So that** I can sort and focus on critical work

**Acceptance Criteria:**
- [ ] Priority dropdown on task detail page with 3 options
- [ ] Selected priority persists after page refresh
- [ ] Default priority is "Medium" for new tasks
```

## Output

The PRD markdown can then be converted to `prd.json` by the ralph-json skill for consumption by the orchestrator's autonomous loop.
