---
name: git-commits
description: Commit message format and branching conventions
metadata:
  type: convention
  shared: true
---

# Git Commit Conventions

## Branch Naming
- Feature: `feature/<name>`
- Bugfix: `bugfix/<name>`
- Refactor: `refactor/<name>`

## Commit Message Format
```
<type>: <imperative-mood summary>

<optional body explaining WHY>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Per-Story Commit Rule
- Each story = one independent commit
- Commit MUST be revertable without affecting other stories
- `git add <specific files>` NOT `git add -A`

Related: [[quality-gates]]
