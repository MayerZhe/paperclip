---
name: artifacts-builder
description: Use when building reusable, self-contained web components or widgets. Creates artifacts with HTML/CSS/JS that work standalone.
---

## Overview

Artifacts are self-contained, reusable web components. They should work in isolation — drop them into any page and they render correctly with no external dependencies.

## Artifact Requirements

- **Self-contained**: all CSS scoped, no external stylesheet dependencies
- **Framework-agnostic**: works with or without React/Vue/Angular
- **Configurable**: expose props/attributes for customization
- **Documented**: usage example, props table, default values

## Output Format

```html
<!-- Component: <name> -->
<!-- Usage: <description> -->
<!-- Props: <prop>: <type> (default: <value>) -->
<template>
  <!-- scoped HTML with inline styles -->
</template>
<script>
  // self-contained logic
</script>
```

## Rules

- No external CSS frameworks — everything is inline or scoped
- If an artifact needs a dependency, document it clearly
- Test in isolation before embedding in a larger page
