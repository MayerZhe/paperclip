---
name: platform-design
description: Use when designing for a specific platform (iOS, Android, web, desktop). Applies platform-specific design patterns and guidelines.
---

## Overview

Each platform has its own design language. Design for the platform the user is on, not an abstract ideal.

## Platform Considerations

- **Web**: responsive breakpoints, accessibility (a11y), browser compatibility
- **iOS**: Human Interface Guidelines, safe areas, navigation patterns
- **Android**: Material Design, back button behavior, fragmentation
- **Desktop**: window management, keyboard shortcuts, menu systems

## Rules

- Follow platform conventions over personal preference — users expect standard behavior
- If a component exists natively on the platform, prefer it over custom
- Test on real devices/viewports, not just the design canvas
