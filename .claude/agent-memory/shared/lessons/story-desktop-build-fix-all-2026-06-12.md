# Lessons Learned: Desktop Build 35-Bug Systematic Repair — 2026-06-12

## Success Patterns

### 1. Sequenced fix groups in dependency order
**Pattern**: Fix Group A (path sync) was the foundation — without it, daemon bundle never reaches electron-builder. Executed A→I sequentially since overlapping files (packaged-main.ts modified in B, C, E, F, G).
**Why it worked**: Each story built on the previous. Story A being first ensured all subsequent daemon-side fixes actually take effect in the packaged app.

### 2. Already-fixed bugs marked as such
**Pattern**: Bug 6 (afterPack absolute path) and Bug 8/9 (pnpm pack conflict) were already fixed in current code or fixed earlier in the sequence. Marked them "ALREADY FIXED" + skipped redundant changes.
**Why it worked**: Avoids unnecessary edits and documents the actual state.

### 3. Minimal env var inheritance for daemon
**Pattern**: Instead of spreading `...process.env`, only pass PATH + HOME + explicitly controlled vars. Prevents Electron internal env vars (ELECTRON_RUN_AS_NODE, PAPERCLIP_UI_DEV_MIDDLEWARE) from leaking into daemon.
**Why it worked**: Whitelist approach prevents future env var pollution bugs.

### 4. Candidate-based path resolution for bundled assets
**Pattern**: skills-catalog, teams-catalog, and onboarding-assets all use try-multiple-candidates pattern. Bundle copies assets to `bundledServer/{skills-catalog,teams-catalog,onboarding-assets}/` and server code tries both monorepo and bundle paths.
**Why it worked**: Same pattern across all 3 asset types. Env var override (PAPERCLIP_SKILLS_CATALOG_DIR, etc.) provides explicit control for edge cases.

## Failure Patterns

### 1. TOCTOU port detection was a no-op
**Problem**: `findAvailablePort()` created a server → listen → immediately close without await. Net result: always returned 3100, never actually checked if port was free.
**Fix**: Removed entirely. Daemon uses detect-port internally and respects PORT env var.
**Lesson**: "Port detection" functions that don't await listen/close are pure theater.

### 2. before-quit registered too late for startup failures
**Problem**: `app.on("before-quit")` registered at line 312 (Phase 7), but `app.quit()` called at line 236 on startup failure (Phase 3). Result: daemon orphaned, port 3100 locked.
**Fix**: Manual `daemon.kill('SIGTERM')` before `app.quit()` in failure path.
**Lesson**: Always consider the startup failure path when registering shutdown handlers.

### 3. daemon.on("exit") event fires only once
**Problem**: `shutdown()` called `daemon.kill('SIGTERM')` then `daemon.on("exit", resolve)`. If daemon had already exited (e.g., crash), the exit event never fires again → 20s timeout.
**Fix**: `daemonExited` flag tracked in exit handler; shutdown skips SIGTERM+wait if already dead.
**Lesson**: Node.js event emitters fire events once. Always track process state with a flag for already-fired events.

## Key Decisions

1. **Kept .npmrc pmOnFail=ignore** — changing it could break monorepo installs. bundle-desktop.ts post-deploy verification now catches missing native binaries instead.
2. **Electron-builder runs from apps/desktop/** — bundle-desktop.ts syncs output there. This avoids changing the CI workflow structure.
3. **`electron:pack` not `pack`** — avoids pnpm built-in `pack` command (which creates tarballs) shadowing the npm script.
4. **TypeScript typecheck passes for apps/desktop** (zero errors in changed files). Pre-existing server type errors (drizzle-orm version mismatch) are unrelated.

## Risks to Monitor

1. **The sync step in bundle-desktop.ts is large** — `fs.cpSync` of entire paperclip-server (with node_modules) to apps/desktop/ adds ~30s to build time. Could be optimized with rsync or symlink.
2. **ESM→CJS bundle still uses __IMU banner** — the `import.meta.url` replacement via esbuild banner is fragile. Future esbuild versions may change banner behavior.
3. **`app.getVersion()`** requires electron.app to be ready. The DESKTOP_VERSION singleton now uses it as primary — verify it works in all Electron lifecycle phases.
