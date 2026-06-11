---
name: gsap-scrolltrigger
description: Use when creating scroll-driven animations. Covers ScrollTrigger: parallax, pinning, scrubbing, and reveal-on-scroll effects.
---

## Overview

ScrollTrigger ties animations to scroll position. It powers parallax effects, scroll-triggered reveals, pinning sections, and scrub-based animations.

## Core Patterns

```javascript
// Reveal on scroll
gsap.from(".card", {
  scrollTrigger: ".card",
  opacity: 0,
  y: 60,
  duration: 0.8
});

// Scrub (animation follows scroll position)
gsap.to(".progress", {
  scrollTrigger: { trigger: ".section", scrub: true },
  scaleX: 1
});

// Pin (element stays fixed while scrolling)
ScrollTrigger.create({
  trigger: ".hero",
  pin: true,
  start: "top top",
  end: "bottom+=200"
});
```

## Key Properties

- `trigger`: element that triggers the animation
- `start`/`end`: scroll positions ("top center", "bottom+=100")
- `scrub`: animation follows scroll (true) or triggers once
- `pin`: element stays fixed during scroll range
- `markers`: set `true` during development to see trigger positions

## Rules

- Call `ScrollTrigger.refresh()` after layout changes
- Kill all ScrollTriggers on page transition: `ScrollTrigger.getAll().forEach(t => t.kill())`
- Test on mobile — viewport height changes with browser chrome
- Respect `prefers-reduced-motion`
