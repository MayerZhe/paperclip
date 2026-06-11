---
name: gsap-timeline
description: Use when sequencing complex multi-step animations. Covers GSAP timelines: chaining, positioning, labels, nesting, and control methods.
---

## Overview

Timelines orchestrate multiple animations in sequence or with precise overlap. They're the backbone of complex animation sequences.

## Timeline Patterns

```javascript
const tl = gsap.timeline({
  paused: true,
  defaults: { ease: "power2.out" }
});

tl.addLabel("start")
  .from(".a", { opacity: 0, duration: 0.3 })
  .from(".b", { y: 30, duration: 0.4 }, "-=0.2") // overlap 0.2s
  .addLabel("middle")
  .to(".a", { scale: 1.2, duration: 0.3 })
  .to(".b", { opacity: 0, duration: 0.3 }, "<") // start at same time as previous
  .addLabel("end");

// Control
tl.play();
tl.pause();
tl.seek("middle");
tl.reverse();
```

## Positioning

- `"-=0.5"`: start 0.5s before previous tween ends (overlap)
- `"<"`: start at same time as previous tween
- `">"`: start after previous tween ends (default)
- `"+=0.3"`: start 0.3s after previous tween ends

## Rules

- Use labels for complex timelines — easier to seek and maintain
- Set `defaults` to avoid repeating ease/duration on every tween
- Nest timelines for modular sequences: `tl.add(childTimeline)`
- `paused: true` + `tl.play()` gives control over when animation starts
