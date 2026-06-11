---
name: canvas-design
description: Use when creating Canvas or WebGL graphics, data visualizations, charts, or custom rendering.
---

## Overview

Canvas and WebGL provide pixel-level control for graphics, charts, and visualizations. Use them when DOM-based approaches can't achieve the required performance or visual complexity.

## When Canvas/WebGL

- Large datasets (1000+ DOM elements chokes the browser)
- Custom shapes or rendering beyond CSS capabilities
- Real-time animations with 60fps requirement
- Particle effects, WebGL shaders, complex charts

## When NOT Canvas

- Standard UI components (use DOM/React)
- Simple charts (use a charting library first)
- Anything achievable with CSS transforms

## Rules

- Canvas is an escape hatch — prefer DOM when possible
- Always provide a fallback for non-Canvas environments
- Test performance with realistic data volumes, not sample data
