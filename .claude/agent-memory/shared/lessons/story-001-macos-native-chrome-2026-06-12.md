# Lessons Learned: macOS Native Chrome — 2026-06-12

## Success Patterns

### 1. Four-Layer Architecture: incremental, independently testable
**Pattern**: Split the transformation into four layers (Window Chrome, Visual Foundation, Native Interaction, Motion Polish) ordered by visual impact and dependency. Each layer is independently verifiable via quickstart.md scenarios.
**Why it worked**: Layer 1 (hiddenInset) alone eliminates ~60% of the perceived web-ness. Layer 2 (CSS foundation) touches every pixel. Each layer adds value without breaking the previous one. The quickstart.md VS-1 through VS-5 scenarios provide concrete manual test scripts for each layer.

### 2. Platform-guarded changes via spread operator in Electron
**Pattern**: `...(isMac && { titleBarStyle: "hiddenInset", ... })` — the spread conditional pattern avoids duplicate BrowserWindow constructors and keeps platform branching minimal.
**Why it worked**: Clean, single-location change. Windows/Linux continue with default chrome because the spread evaluates to `{}` on non-darwin. No if/else duplication of the entire 30-line constructor.

### 3. CSS Variables as the foundation layer (Phase 2)
**Pattern**: All visual changes (radii, fonts, scrollbars, vibrancy blurs) defined as CSS custom properties in `ui/src/index.css` before any component was modified. Components reference `var(--sidebar-bg)` instead of hardcoded colors.
**Why it worked**: Components auto-magically inherit the macOS look when CSS variables change. Light/dark mode adaptation is a single-variable change, not N component updates.

### 4. Preload bridge limited to UI affordances (ADR-06 compliance)
**Pattern**: `contextBridge.exposeInMainWorld("paperclip", { showContextMenu, showOpenDialog })` — the bridge carries ONLY menu item labels and action strings. No business data, no REST API calls, no database access.
**Why it worked**: The context menu is a pure UI affordance (replacing DOM `contextmenu` events). Cut/Copy/Paste are dispatched via `webContents.cut()` etc., not through business logic. File dialogs are OS-native UI that belong in the main process.

### 5. CSS-only motion (no framer-motion dependency)
**Pattern**: All animations use CSS `@keyframes`, `transition`, and `motion-safe:` Tailwind variants. The `usePrefersReducedMotion()` hook uses `useSyncExternalStore` for zero-rerender subscription.
**Why it worked**: Avoiding `framer-motion` (120KB gzipped) was the right call per research.md R7. CSS transitions cover page fades (200ms ease-out), spring sidebar (cubic-bezier(0.34, 1.56, 0.64, 1)), and button scale feedback (active:scale-[0.97]). The existing `@media (prefers-reduced-motion: reduce)` patterns in index.css already gate all legacy animations.

## Failure Patterns

### 1. `--sidebar-bg-light` was redundant — removed in post-commit fix
**Problem**: Initial T007 defined both `--sidebar-bg` and `--sidebar-bg-light` as separate vars. But since `.dark` overrides `--sidebar-bg`, the light-mode value should just go in `:root`'s `--sidebar-bg`. The separate `--sidebar-bg-light` var was never used.
**Fix**: Removed `--sidebar-bg-light` from `:root` and `.dark`. Put `rgba(255, 255, 255, 0.72)` directly in `:root --sidebar-bg` and `rgba(5, 5, 5, 0.75)` in `.dark --sidebar-bg`. Added `--sidebar-border-subtle` for light/dark border variants.
**Lesson**: CSS custom properties that exist in both `:root` and `.dark` should follow the same naming pattern. Don't create separate light/dark variants unless needed — let the cascade handle it.

### 2. Type declaration needed before window.paperclip usage in UI
**Problem**: `window.paperclip?.platform` in Layout.tsx caused TypeScript errors because no `Window` interface augmentation existed in the UI package.
**Fix**: Added `declare global { interface Window { paperclip?: { ... } } }` to `ui/src/vite-env.d.ts`. This is the standard Vite pattern for augmenting global types.
**Lesson**: Any preload-exposed API MUST have a corresponding type declaration in the UI package. The pattern is `declare global` in `vite-env.d.ts` (or equivalent).

## Key Decisions

1. **Zero daemon changes** — all changes in `apps/desktop/` or `ui/`. The daemon (`server/`) was untouched. This aligns with ADR-02/03/05: Electron is a thin shell, daemon manages PG and API independently.
2. **Zero new npm dependencies** — no `framer-motion`, no new Electron packages. CSS-only animations cover all Layer 4 needs.
3. **macOS-only scope** — all Electron changes wrapped in `process.platform === "darwin"` guard. Windows/Linux continue with default chrome. CSS `macos` class (applied via JS when platform is darwin) scopes visual changes.
4. **CSS variables over inline styles** — radii, fonts, vibrancy blurs all use CSS custom properties. This enables future theming without code changes.
5. **Preload bridge: `contextBridge` NOT `nodeIntegration`** — `contextIsolation: true, nodeIntegration: false, sandbox: true` maintained. The preload uses `contextBridge.exposeInMainWorld` to safely expose only the needed APIs.

## Risks to Monitor

1. **Vibrancy on external displays** — Electron's `vibrancy: 'under-window'` may render differently on displays with different color profiles or HDR. Manual testing needed on multi-display setups.
2. **Scrollbar hover reveal on non-macOS** — the overlay scrollbar CSS applies globally (not `.macos` scoped). This is intentional (clean scrollbars benefit all platforms) but should be verified on Windows/Linux.
3. **`trafficLightPosition` with future Electron updates** — Electron 39+ may change how traffic light positions interact with `titleBarStyle: hiddenInset`. The `{ x: 12, y: 16 }` values are standard for macOS 11+ but may need adjustment.
4. **`page-transition-enter` with React Suspense** — the `key={location.pathname}` on the page wrapper forces remount on every route change. This is correct for transitions but may cause unexpected remounts with React.lazy() components.
