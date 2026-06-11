# S1-001: Desktop API Routes + app.ts 注册

## Agent: backend-dev

### Required Skills
- **backend-dev**: API route + Express router 注册 (core)
- **verification-before-completion**: 提交前对照 AC 逐条验证

---

## ANTI-DRIFT Constraints (强制遵守)

Read /Users/Mayer/mayer_project/coworker/paperclip-master/SuperNode-desktop/doc/ANTI-DRIFT.md before writing any code.

1. ENV VAR NAMES: Use SERVE_UI (NOT PAPERCLIP_SERVE_UI), PAPERCLIP_OPEN_ON_LISTEN (NOT PAPERCLIP_OPEN_BROWSER), PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_MIGRATION_AUTO_APPLY.
2. DO NOT add Electron IPC (ipcMain/ipcRenderer). Use REST only.
3. DO NOT use asar packaging.
4. DO NOT let Electron touch PostgreSQL lifecycle. Daemon owns PG.
5. SHUTDOWN ORDER: desktopFlag=true → clearIntervals → wait backup-in-flight → telemetry stop → appShutdown() → server.close() → PG stop → exit(0).
6. CONFIG FIELDS: $meta.version=1 (number), database.mode="embedded-postgres", server.deploymentMode="local_trusted", server.exposure="private".
9. All new files go to SuperNode-desktop/ directory.
10. Existing files (server/src/app.ts, server/src/index.ts) are MODIFIED in-place in the paperclip-master repo.

---

## Acceptance Criteria

**AC1**: `desktop.ts` 提供 `GET /api/desktop/status`（返回 uptime + shuttingDown）和 `POST /api/desktop/shutdown`（返回 acknowledged + 自触发 SIGTERM）
**AC2**: `app.ts` 正确注册 `/api/desktop` router 在 `/api/health` 附近，desktopShutdownFlag 通过 app.locals 共享

---

## Implementation Checklist

### Step 1: Create NEW file: SuperNode-desktop/server/src/routes/desktop.ts

Full file content:
```typescript
import { Router } from "express";

export function createDesktopRouter(options: {
  getServerUptime: () => number;
  isShuttingDown: () => boolean;
}) {
  const router = Router();

  // GET /api/desktop/status
  router.get("/status", (_req, res) => {
    res.json({
      uptime: options.getServerUptime(),
      shuttingDown: options.isShuttingDown(),
    });
  });

  // POST /api/desktop/shutdown
  router.post("/shutdown", async (_req, res) => {
    if (options.isShuttingDown()) {
      res.json({ acknowledged: true, alreadyShuttingDown: true });
      return;
    }
    res.json({ acknowledged: true });
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 300);
  });

  return router;
}
```

### Step 2: Modify server/src/app.ts

2a. Add import near other route imports (around line 67, after last route import):
```typescript
import { createDesktopRouter } from "../../SuperNode-desktop/server/src/routes/desktop.js";
```

2b. Add router registration right after the health routes block (line 211, after `api.use("/health", ...)` closure):
```typescript
  const desktopShutdownFlag = { shuttingDown: false };
  api.use(
    "/desktop",
    createDesktopRouter({
      getServerUptime: () => process.uptime(),
      isShuttingDown: () => desktopShutdownFlag.shuttingDown,
    }),
  );
```

2c. Add after `app.locals.paperclipShutdown = shutdownAppServices;` (line 492):
```typescript
  app.locals.paperclipDesktopShutdownFlag = desktopShutdownFlag;
```

---

## Verification Protocol

BEFORE reporting done:
1. Run: `cd /Users/Mayer/mayer_project/coworker/paperclip-master && pnpm typecheck 2>&1 | head -50`
2. If typecheck fails: fix errors, re-run, max 3 retries
3. Verify AC1 and AC2 are satisfied
4. Report PASS/FAIL with evidence

MUST PASS L1 TYPECHECK. No pass = not done.
