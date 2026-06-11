# S1-002: Server Shutdown 增强

## Agent: backend-dev

### Required Skills
- **backend-dev**: 修改 shutdown 流程 + interval 管理 (core)
- **verification-before-completion**: 提交前对照 AC 逐条验证

---

## ANTI-DRIFT Constraints (强制遵守)

Read /Users/Mayer/mayer_project/coworker/paperclip-master/SuperNode-desktop/doc/ANTI-DRIFT.md before writing any code.

1. ENV VAR NAMES: Use SERVE_UI (NOT PAPERCLIP_SERVE_UI), PAPERCLIP_OPEN_ON_LISTEN, PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_MIGRATION_AUTO_APPLY.
5. SHUTDOWN ORDER: desktopFlag=true → clearIntervals → wait backup-in-flight → telemetry stop → appShutdown() → server.close() → PG stop → exit(0).
10. Existing files (server/src/app.ts, server/src/index.ts) are MODIFIED in-place in the paperclip-master repo.

---

## Acceptance Criteria

**AC3**: `index.ts` 的 `setInterval` (line 766, 846) 赋值变量并 push 到 `activeIntervals[]`
**AC4**: `index.ts` 的 shutdown handler 包含：clearIntervals → wait backup-in-flight → telemetry stop → appShutdown() → server.close() → PG stop → exit(0)

---

## Current Code State (server/src/index.ts)

Key line numbers (inside `startServer()` function):
- Line 48: `import { initTelemetry, getTelemetryClient } from "./telemetry.js";`
- Line 570: `let databaseBackupInFlight = false;`
- Line 655: `const server = createServer(...)` 
- Line 766: `setInterval(() => {` (heartbeat — 67 lines of code)
- Line 832: `}, config.heartbeatSchedulerIntervalMs);` (heartbeat closing)
- Line 846: `setInterval(() => {` (backup — 5 lines of code)
- Line 850: `}, backupIntervalMs);` (backup closing)
- Lines 920-949: Current shutdown handler (30 lines)

All these variables are in `startServer()` function scope — accessible from shutdown handler.

---

## Implementation — Three Edits to server/src/index.ts

### Edit 1: Add activeIntervals array (after line 656)

Insert after `const server = createServer(...)` + `server.keepAliveTimeout` lines:
```typescript
  const activeIntervals: ReturnType<typeof setInterval>[] = [];
```

### Edit 2: Capture interval references

**At line 766**, change:
```
    setInterval(() => {
```
to:
```
    const hbInterval = setInterval(() => {
```

**After line 832** (`}, config.heartbeatSchedulerIntervalMs);`), add:
```typescript
    activeIntervals.push(hbInterval);
```

**At line 846**, change:
```
    setInterval(() => {
```
to:
```
    const backupInterval = setInterval(() => {
```

**After line 850** (`}, backupIntervalMs);`), add:
```typescript
    activeIntervals.push(backupInterval);
```

### Edit 3: Replace shutdown handler (lines 920-949)

Replace the ENTIRE block from the `{` before `const shutdown` to the closing `}` after `process.once("SIGTERM", ...)` with:

```typescript
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      // Mark desktop shutting down flag
      const desktopFlag = (app as { locals?: Record<string, unknown> })
        .locals?.paperclipDesktopShutdownFlag as { shuttingDown: boolean } | undefined;
      if (desktopFlag) desktopFlag.shuttingDown = true;

      // Clear all intervals (stop heartbeat + backup timers)
      logger.info({ signal, count: activeIntervals.length }, "Clearing active intervals");
      for (const interval of activeIntervals) {
        clearInterval(interval);
      }

      // Wait for in-flight database backup
      if (typeof databaseBackupInFlight !== "undefined" && databaseBackupInFlight) {
        logger.info("Waiting for in-flight database backup to complete...");
        const backupWaitStart = Date.now();
        while (databaseBackupInFlight) {
          if (Date.now() - backupWaitStart > 30000) {
            logger.warn("Database backup timeout — proceeding with shutdown");
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Stop telemetry
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      // Call app shutdown hooks
      const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } })
        .locals?.paperclipShutdown;
      appShutdown?.();

      // Graceful HTTP server close
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) logger.error({ err }, "Error closing HTTP server");
          resolve();
        });
      });

      // Stop embedded PG
      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }
```

---

## Verification Protocol

BEFORE reporting done:
1. Run: `cd /Users/Mayer/mayer_project/coworker/paperclip-master && pnpm typecheck 2>&1 | head -50`
2. If typecheck fails: fix errors, re-run, max 3 retries
3. Verify AC3 and AC4 are satisfied
4. Report PASS/FAIL with evidence

MUST PASS L1 TYPECHECK. No pass = not done.
