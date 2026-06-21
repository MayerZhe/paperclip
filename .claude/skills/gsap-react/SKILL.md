---
name: gsap-react
description: Use when integrating GSAP animations with React components. Covers useGSAP hook, useRef, context safety, and cleanup patterns.
---

## Overview

GSAP and React work well together when you follow the rules: use refs (not selectors), animate in useEffect/useGSAP, and clean up on unmount.

## React Pattern

```jsx
import { useRef } from "react";
import { useGSAP } from "@gsap/react";

function AnimatedComponent() {
  const ref = useRef();

  useGSAP(() => {
    gsap.from(ref.current, { opacity: 0, y: 30, duration: 0.6 });
  }, { scope: ref });

  return <div ref={ref}>Content</div>;
}
```

## Rules

- **Always use refs**, never class selectors — React may render multiple instances
- **Always kill tweens on unmount** — `useGSAP` handles this, manual useEffect needs `return () => ctx.revert()`
- **Use `gsap.context()`** for grouped animations with shared cleanup
- **React.StrictMode** runs effects twice in dev — GSAP handles this with `.revert()`

## Common Mistakes

- Using string selectors (".my-class") instead of refs
- Forgetting to clean up tweens on unmount (memory leak + stale animations)
- Animating CSS properties directly (use GSAP, not CSS transitions + GSAP)
