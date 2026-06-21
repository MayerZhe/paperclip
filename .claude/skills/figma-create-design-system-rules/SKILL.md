---
name: figma-create-design-system-rules
description: Use when creating or extracting design system rules from Figma. Converts Figma styles, variables, and components into implementable design tokens.
---

## Overview

A Figma design file contains the source of truth for visual design. Extract design tokens (colors, typography, spacing, effects) and component specs into implementable rules.

## Extraction Process

1. **Audit Figma Styles** — list all color styles, text styles, effect styles
2. **Extract Tokens** — convert Figma values to code-ready format
3. **Document Components** — variants, states, props for each component
4. **Generate CSS Variables / Tailwind Config** — produce the token file

## Token Format

```json
{
  "colors": { "primary": "#...", "secondary": "#..." },
  "typography": { "heading": { "fontFamily": "...", "fontSize": "...", "fontWeight": "..." } },
  "spacing": { "xs": "4px", "sm": "8px", "md": "16px" },
  "borderRadius": { "default": "8px" }
}
```

## Rules

- Figma is the source of truth — if code deviates, fix the code
- Design tokens should be framework-agnostic (can generate CSS, Tailwind, or styled-components from them)
- Each token needs a semantic name, not a visual description ("primary" not "blue-500")
