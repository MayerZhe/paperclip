# Lessons Learned: Sprint 1 Core Shell — 2026-06-11

## Success Patterns

### 1. Server modifications kept minimal and scoped
**Pattern**: Modify upstream server files only for what desktop absolutely needs — desktop API routes + shutdown enhancement. No refactoring, no cleanup of unrelated code.
**Why it worked**: Minimizes merge conflicts when upstream changes. Each modification has a clear, defensible reason (AC1-AC4).

### 2. Desktop router placed in SuperNode-desktop/ not paperclip-master server/
**Pattern**: New desktop API routes live at `SuperNode-desktop/server/src/routes/desktop.ts`, imported into `server/src/app.ts` via relative path.
**Why it worked**: Keeps desktop-specific code in the desktop directory while the server import is a single-line addition. Easy to remove if desktop support is dropped.

### 3. shutdown handler uses existing scope variables
**Pattern**: `activeIntervals`, `databaseBackupInFlight`, `server`, and `app` are all in `startServer()` scope — no structural changes needed to access them from the enhanced shutdown handler.
**Why it worked**: Understanding the closure scope before adding code avoids unnecessary refactoring.

### 4. ANTI-DRIFT enforced via grep-based verification
**Pattern**: Each AC verified with targeted grep commands — `ipcMain`/`ipcRenderer`/`asar`, `import.*pg`, etc.
**Why it worked**: Automated checks catch drift that code review might miss.

## Failure Patterns

### 1. pnpm registry verification blocked local typecheck
**Problem**: `pnpm typecheck` failed with "Refusing to run pnpm@9.15.4: its npm registry signature could not be verified"
**Workaround**: Used direct tsc binary path at `node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc`
**Root cause**: Lockfile references a pnpm version not available in current registry
**Lesson**: Always have a fallback path to the raw compiler binary

### 2. Pre-existing tsconfig error masks new type errors
**Problem**: TS6053 for missing `packages/adapters/droid-local` blocks the build even though it's unrelated
**Workaround**: Filtered typecheck output for new errors specific to changed files
**Lesson**: When pre-existing errors exist, use targeted grep/filtering to isolate new errors

## Key Decisions

1. **Electron files live at `SuperNode-desktop/apps/desktop/src/main/`** — matches v3 plan structure, not the target monorepo path `apps/desktop/`
2. **v3 plan onboard.ts used over v2** — v3 version has corrected Zod field names (`$meta.version=1`, `database.mode="embedded-postgres"`, etc.)
3. **Stub implementations for updater/notifications** — Sprint 1 only needs stubs; Sprint 2 will implement actual logic
4. **preload/index.ts is minimal** — no `ipcRenderer` exposure (ADR-06 compliance)

## Risks to Monitor

1. **Dynamic import in onboard.ts** — `await import("@paperclipai/shared/config-schema")` may fail if the shared package isn't built before Electron starts (only affects manual config fallback path, not the preferred `paperclipai onboard -y` path)
2. **`require("node:net")` in packaged-main.ts** — uses CommonJS in an ESM file; works in Node but may need adjustment for strict ESM bundling
3. **Cross-directory import** — `server/src/app.ts` imports from `../../SuperNode-desktop/server/src/routes/desktop.js`; this relative path must be maintained if directory structure changes
