---
name: simplicity-first
description: Use as an ongoing constraint during implementation. Rejects unnecessary features, single-use abstractions, unrequested flexibility, and error handling for impossible states.
---

# Simplicity First

Behavioral guidelines to reduce common LLM coding mistakes, derived from Andrej Karpathy's observations on LLM coding failure modes.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
