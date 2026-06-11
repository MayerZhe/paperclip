# Lessons Learned: Sprint 2 Desktop Experience — 2026-06-11

## Success Patterns

### 1. Tray heartbeat as a composable module
**Pattern**: `startTrayHeartbeat(port)` returns a cleanup function — `stopHeartbeat()`. The heartbeat is started in Phase 6 and stopped as step 0 in the shutdown sequence. This keeps tray logic self-contained and composable.
**Why it worked**: The cleanup pattern (returning a teardown function) avoids coupling between tray.ts and packaged-main.ts. Tray only imports `notifyDaemonStatusChange`, not the other way around.
**Reuse potential**: Same pattern used for `registerWindowStateHandlers(win)` → returns cleanup.

### 2. Notifications integrated through tray polling, not a separate mechanism
**Pattern**: `notifyDaemonStatusChange(prev, next)` is called from tray's polling interval when it detects a state change. Notifications don't need their own polling loop.
**Why it worked**: Single source of truth for daemon health state. No duplicate HTTP requests. The tray poll interval (15s) is appropriate for notifications too.

### 3. Programmatic icon generation with pure Node.js
**Pattern**: `generate-icons.ts` uses a minimal PNG encoder (IHDR + IDAT + IEND + CRC32) with no external dependencies. Creates colored circle placeholder icons at 16/32/256/512 px.
**Why it worked**: Zero npm dependencies for icon generation. The script produces valid PNGs verifiable by header byte inspection.
**Caveat**: Icons are simple colored circles — not production-grade. Designer-provided icons should replace these before release.

### 4. Menu data provider singleton pattern
**Pattern**: `updateMenuData()` allows external modules to update menu-relevant data without re-creating the menu. The diagnostics export function fetches daemon status fresh each time (not cached).
**Why it worked**: Menu is created once at startup. CLI scan results are passed in at creation. Diagnostics fetch live data on demand.

### 5. ANTI-DRIFT enforced via grep-based verification (Sprint 1 pattern reused)
**Pattern**: Each AC verified with targeted grep commands. False positives from ADR keyword grep were manually reviewed (embedded-postgres in config strings, NOT library imports).
**Why it worked**: Same reason as Sprint 1 — automated checks catch drift that code review might miss.

## Failure Patterns

### 1. `__dirname` not available in ES module scope
**Problem**: `generate-icons.ts` used `__dirname` which is undefined in ESM (`--experimental-strip-types` mode).
**Fix**: Added `fileURLToPath(import.meta.url)` and `path.dirname()` to derive `__dirname`.
**Lesson**: All new TypeScript files in this project should use `fileURLToPath(import.meta.url)` pattern. `__dirname` only works in CJS.

### 2. `stopHeartbeat` closure issue — variable declared after function that uses it
**Problem**: `stopHeartbeat` was `const`-declared in Phase 6, but the `shutdown()` function (declared earlier in Phase 2) references it.
**Fix**: Changed to `let stopHeartbeat: () => void = () => {};` declared at Phase 2 scope, assigned later in Phase 6.
**Lesson**: When a shutdown function needs to reference a resource created later, declare the variable early with a no-op default.

## Key Decisions

1. **electron-updater feed URL defaults to `paperclipai/paperclip`** — configurable via `PAPERCLIP_UPDATE_REPO` env var. Matches v3 plan.
2. **Window state validated for sanity** — coordinates clamped to reasonable screen bounds (-1920 to 7680) to prevent off-screen windows on display changes.
3. **Menu uses `webContents.send("paperclip:check-update")`** for update trigger — avoids direct electron-updater import in menu.ts, keeps updater logic in one file.
4. **electron-builder.yml includes entitlement for JIT, unsigned executable memory, and disabled library validation** — needed for embedded PG native extensions in hardened runtime.
5. **New files in separate modules** (window-state.ts, login-item.ts) rather than inline in packaged-main.ts — keeps core under 500 lines.

## Risks to Monitor

1. **`electron-updater` requires a valid code-signing certificate for macOS auto-update** — dev builds won't auto-update. Production builds need CI signing setup.
2. **PNG icons are minimal (colored circles)** — will need designer-provided icons before release.
3. **`apps/desktop/tsconfig.json` compiles `src/main/` and `src/preload/`** — ensure preload directory exists before first build. Currently only preload/index.ts exists from Sprint 1.
