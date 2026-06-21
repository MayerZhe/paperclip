---
name: frontend-design
description: Use when creating UI components, pages, or layouts. Produces production-ready HTML/CSS/React with attention to visual quality.
---

## Overview

Frontend design turns design specs into code. The output should be visually indistinguishable from the design — every pixel, every state, every animation.

## Implementation Quality

- **Pixel-perfect**: colors, spacing, typography match design exactly
- **All states**: default, hover, active, focus, disabled, loading, empty, error
- **Responsive**: works at all specified breakpoints
- **Accessible**: proper ARIA labels, keyboard navigation, focus management, contrast ratios
- **Performant**: no layout thrashing, efficient rendering

## Design Token Usage

- Always reference design tokens, never hard-code values
- Use CSS custom properties or theme context
- If a token doesn't exist, add it to the design system — don't use a one-off value

## Rules

- Start with mobile layout, enhance for larger screens
- Test at actual device sizes, not just resized browser windows
- If the design looks wrong, it's wrong — don't ship "close enough"
