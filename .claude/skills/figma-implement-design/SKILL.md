---
name: figma-implement-design
description: Use when implementing a Figma design as code. Extracts design specs from Figma and produces pixel-accurate implementation.
---

## Overview

Turn Figma designs into production code. The goal: what you see in Figma is exactly what users see in the browser.

## Implementation Workflow

1. **Audit the Figma file** — identify components, variants, design tokens
2. **Extract specs** — colors, typography, spacing, layout grids
3. **Map to component tree** — which Figma layers become which React components
4. **Implement states first** — all variants before polish
5. **Polish** — animations, transitions, micro-interactions

## Quality Criteria

- Side-by-side comparison with Figma: no visible difference
- All component variants working
- Responsive behavior correct
- Text content, images, icons match design

## Rules

- Don't approximate — if a value is 13px in Figma, use 13px
- Figma auto-layout → CSS flexbox/grid (they map closely)
- Design tokens should be extracted, not rewritten
