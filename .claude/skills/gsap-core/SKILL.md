---
name: gsap-core
description: Use when creating web animations with GSAP. Covers GSAP core: gsap.to(), gsap.from(), gsap.fromTo(), timelines, and easing.
---

## Overview

GSAP (GreenSock Animation Platform) is the standard for high-performance web animations. The core library handles DOM, SVG, Canvas, and WebGL animations with consistent API.

## Core Patterns

```javascript
// Basic tween
gsap.to(".element", { x: 100, duration: 1, ease: "power2.out" });

// From/to
gsap.from(".element", { opacity: 0, y: 50, duration: 0.5 });

// Timeline (sequence)
const tl = gsap.timeline();
tl.to(".a", { opacity: 1, duration: 0.3 })
  .to(".b", { x: 100, duration: 0.5 }, "-=0.2") // overlap
  .to(".c", { scale: 1.5, duration: 0.4 });
```

## Easing

- `power1.out` — subtle deceleration (most common)
- `power2.inOut` — smooth entrance/exit
- `elastic.out(1, 0.3)` — bouncy (use sparingly)
- `expo.out` — dramatic deceleration

## Rules

- Always use `gsap.to()` not direct style manipulation
- Prefer `y` over `top` (uses transform, GPU-accelerated)
- Kill tweens on unmount to prevent memory leaks
- Respect `prefers-reduced-motion` media query
