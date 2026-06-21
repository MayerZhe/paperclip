---
name: design-review
description: Use when reviewing a design implementation. Compares implemented UI against design specs, catches visual discrepancies.
---

## Overview

A design review ensures what was built matches what was designed. Compare the implementation against the spec, pixel by pixel when needed.

## Review Checklist

- [ ] Colors match design tokens exactly
- [ ] Typography (font, size, weight, line-height) matches spec
- [ ] Spacing (padding, margin, gap) matches spec
- [ ] All component states are implemented (default, hover, active, disabled, error, empty)
- [ ] Responsive behavior works at specified breakpoints
- [ ] Loading and error states are handled
- [ ] Empty state has appropriate UI

## Rules

- Review at actual device sizes, not just the design tool's viewport
- Check both light and dark modes if applicable
- If the design spec is wrong, flag it — don't blindly match a broken spec
