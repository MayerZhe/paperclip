# AgentHubs Design System for PaperClip UI

## Overview

This directory contains the AgentHubs design system tokens and theme files
for the PaperClip desktop UI. The design system is an **incremental
extension** of the existing shadcn/ui (Tailwind v4) variable system — it
adds AgentHubs-branded tokens and dark mode enhancements without replacing
any existing CSS custom properties.

## Files

| File | Purpose |
|------|---------|
| `tokens.css` | Namespaced `--ah-*` CSS variables (typography, colors, radius, transitions) |
| `agent-hubs-theme.css` | Dark mode overlay for `.dark` — background/chrome overrides + opt-in utility classes |

## How to Use

### 1. Import the design system

Both files are imported in `ui/src/index.css`:

```css
@import url('https://fonts.googleapis.com/css2?...');
@import "./design-system/tokens.css";
@import "./design-system/agent-hubs-theme.css";
```

### 2. Reference tokens in your components

Use the namespaced `--ah-*` variables directly:

```css
.my-agent-hubs-component {
  font-family: var(--ah-font-heading);
  background: var(--ah-bg-card);
  border: 1px solid var(--ah-border-default);
  border-radius: var(--ah-radius);
  transition: border-color var(--ah-transition-fast);
}

.my-agent-hubs-component:hover {
  border-color: var(--ah-border-hover);
  background: var(--ah-bg-hover);
}
```

### 3. Opt-in utility classes

Add `class="ah-surface"` to any container for AgentHubs zero-radius,
dark card styling. Add `class="ah-accent-action"` for purple accent hover
on interactive text elements.

### 4. Inline Tailwind with design tokens

The `@theme inline` block in `index.css` maps shadcn/ui design tokens
(`--background`, `--foreground`, etc.) to Tailwind utility classes
(`bg-background`, `text-foreground`). Since `agent-hubs-theme.css`
overrides the same variables inside `.dark`, existing Tailwind utilities
automatically reflect the AgentHubs palette in dark mode — no component
changes needed.

## Relationship with shadcn/ui

| Layer | What it does |
|-------|-------------|
| `index.css` `:root` / `.dark` | Original shadcn/ui design tokens (Tailwind v4 compatible) |
| `tokens.css` | New `--ah-*` namespace tokens (does not touch existing variables) |
| `agent-hubs-theme.css` | Overrides shadcn/ui `.dark` variables to match AgentHubs Cloud palette |

**Key principle**: The shadcn/ui variable names and structure are preserved.
Components using `bg-background`, `text-foreground`, `bg-card`, etc. continue
to work. The theme file only changes *what those variables resolve to* inside
`.dark`.

## Dark Mode Default

The AgentHubs design system is **dark-mode-first**, matching AgentHubs Cloud:

- Page background: `#050505` (near-black, OLED-optimized)
- Card background: `#111111` (one step above page)
- Hover background: `#1a1a1a` (two steps above page)
- Accent: `oklch(0.65 0.2 265)` (saturated purple)
- Borders: `#222222` (subtle, near-background)

## Font Selection Rationale

| Role | Font | Reasoning |
|------|------|-----------|
| Headings | **Space Grotesk** | Geometric sans-serif with distinctive character; conveys the AgentHubs brand identity through its slightly unconventional letterforms while maintaining excellent readability at display sizes. |
| Body | **Inter** | Industry-standard UI font optimized for screen reading at small sizes; high x-height, open apertures, and clear differentiation between similar glyphs (I/l/1, O/0). |
| Code | **JetBrains Mono** | Developer-focused monospace with ligatures and clear character differentiation; consistent with the coding/agent tooling nature of PaperClip. |

All three fonts are loaded from Google Fonts in `index.css` and mapped to
CSS custom properties in `tokens.css` for easy composition.
