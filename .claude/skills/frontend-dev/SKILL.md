---
name: frontend-dev
description: Use for frontend development workflow tasks: build configuration, bundling, optimization, deployment, and tooling.
---

## Overview

Frontend development goes beyond UI — it includes build tooling, performance optimization, bundle management, and deployment configuration.

## Core Competencies

- **Build**: webpack, vite, turbopack configuration
- **Optimization**: code splitting, lazy loading, tree shaking, image optimization
- **Performance**: Core Web Vitals (LCP, FID, CLS), bundle analysis
- **Tooling**: ESLint, Prettier, TypeScript configuration
- **Deployment**: static export, SSR, edge functions

## Rules

- Don't optimize prematurely — measure first, then fix the bottleneck
- Bundle size budgets should be explicit and enforced
- Lazy load everything below the fold by default
