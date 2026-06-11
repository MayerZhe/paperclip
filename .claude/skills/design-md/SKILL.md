---
name: design-md
description: Use when creating design documentation. Produces structured design specs that developers can implement from.
---

## Overview

A design spec document bridges design and development. It must be precise enough that a developer can implement it without guessing.

## Spec Format

```markdown
## Component: <Name>

### States
- Default: <description>
- Hover: <description>
- Active: <description>
- Disabled: <description>
- Error: <description>

### Dimensions
- Width: <value>
- Height: <value>
- Padding: <value>
- Gap: <value>

### Typography
- Font: <family> <weight> <size>/<line-height>
- Color: <value>

### Behavior
- On click: <action>
- On hover: <animation>
```

## Rules

- Every component spec must list all states
- Colors as hex/rgba values, not names ("blue" means nothing)
- Dimensions in px/rem, not "medium" or "large"
