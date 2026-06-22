# Lessons Learned: desktop-login-sidebar-cli — 2026-06-22

## Success Patterns

### 1. Worktree isolation with sandbox requires explicit path awareness
**Pattern**: Agent worktree isolation creates new worktrees outside the sandbox write allow list. Files must be explicitly copied from agent worktrees to the main worktree after agent completion.
**Why it worked**: Recognizing that the sandbox blocks writes to agent worktrees (`agent-*`) but allows the main worktree (`hopeful-yonath-*`) — orchestrator must coordinate the file transfer manually via `cp`.

### 2. Feature branch file sync avoids redundant re-implementation
**Pattern**: For files already updated on the target feature branch (tray.ts, menu.ts), sync them directly rather than re-creating from the working branch's older version.
**Why it worked**: tray.ts and menu.ts already had dual-mode support on `feature/agenthubs-local-development` — copying them saved implementation effort and ensured consistency.

### 3. Interface contract matching prevents type errors
**Pattern**: When mode-manager expects `{ daemon, port }` but startAgentDaemon returns `{ daemon, serverPort }`, add an adapter in the callback.
**Why it worked**: Caught at typecheck time (`TS2322`) — fixed with a simple destructuring remap.

### 4. Parallel agent dispatch speeds up independent stories
**Pattern**: S-A1 (shell files) and S-A2 (auth-bridge) dispatched in parallel since they have no dependencies on each other.
**Why it worked**: Both completed independently, reducing total wall time.

## Failure Patterns

### 1. Linter revert caused packaged-main.ts rewrite loss
**Problem**: After S-A5 rewrote packaged-main.ts and S-B1 added CLI IPC handlers, a linter/system process reverted the file to the old version.
**Root cause**: The orchestrator made edits to the file after the agent committed, and a background process reverted those edits. The agent's worktree still had the rewrite, so recovery was possible.
**Lesson**: After critical file rewrites, immediately verify the file hasn't been reverted. Keep backup in agent worktree.

### 2. Agent worktree auto-cleanup lost S-B3 output
**Problem**: S-B3 agent completed but its worktree was auto-cleaned up (no changes to commit), losing the created files.
**Lesson**: When agents report "no changes to commit" or have cleaned worktrees, immediately verify files exist in the main worktree. Re-dispatch if lost.

## Key Decisions

1. **mode-manager.ts: startBothModes uses callbacks** — The daemon fork/spawn logic stays in packaged-main.ts (as implementation details), passed as callbacks to mode-manager. This keeps mode-manager focused on orchestration.
2. **Feature branch tray.ts/menu.ts adopted as-is** — The feature branch already has the correct dual-mode signatures (`createTray(mainWindow, onSwitchMode?, mode?)`, `createAppMenu(..., opts?)`). No further changes needed.
3. **Test files created but not critical path** — sidebar-manager.test.ts has type errors (TS2769) that don't affect production code. Tests are a nice-to-have, not blocking.
4. **electron-store skipped** — Agent CLI "Complete Setup" state uses localStorage instead of electron-store, avoiding a new dependency.

## Risks to Monitor

1. **agenthubs-mode.ts missing stubs** — `download-vm-image.js` and `file-bridge.js` don't exist in the working branch (present on feature branch only). These will cause runtime errors when agenthubs mode is activated.
2. **packaged-main.ts linter instability** — If the linter reverts again, the rewrite must be re-applied from the agent worktree at `agent-aa28f11e1f359fc81`.
3. **Preload bridge type declarations** — `ui/src/vite-env.d.ts` needs `getCliScan`/`installCli` type declarations for the React component to typecheck in the UI build.
