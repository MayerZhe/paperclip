# PaperClip Desktop Smoke Test

Automated smoke test for verifying the PaperClip desktop daemon starts, serves
its health endpoint, and shuts down cleanly. Located at `scripts/test/smoke-test.sh`.

## Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| **Node.js** | 22+ | Required for daemon runtime |
| **curl** | any | Used for HTTP health checks |
| **Docker** (optional) | 24+ | Only needed with `--agenthubs` flag |
| **pnpm** | 9+ | Only needed if no pre-built dist exists |

### Optional: OrbStack

[OrbStack](https://orbstack.dev) is a lightweight Docker Desktop alternative
that works well for the AgentHubs Docker test. Install it if you prefer not to
use Docker Desktop:

```sh
brew install orbstack
```

## Quick Start

```sh
# From the supernode-desktop directory:
cd supernode-desktop

# Quick test (daemon start + health only, ~15s)
./scripts/test/smoke-test.sh --quick

# Full test including Docker Compose validation
./scripts/test/smoke-test.sh --agenthubs
```

## Test Cases

| # | Test | Description | Flag Required |
|---|------|-------------|---------------|
| 1 | Daemon direct start | Starts daemon with smoke-test config, waits for `/api/health` | -- |
| 2 | Health response format | Validates `{ "status": "ok" }` in response body | -- |
| 3 | Desktop status endpoint | Calls `GET /api/desktop/status`, checks for `uptime` field | -- |
| 4 | Graceful shutdown | `POST /api/desktop/shutdown`, confirms daemon exits | -- |
| 5 | Docker Compose config | Validates `docker compose config` for AgentHubs mode | `--agenthubs` |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PAPERCLIP_HOME` | `/tmp/paperclip-smoke-test-home` | Test data directory (cleaned each run) |
| `SMOKE_TIMEOUT` | `60` | Max seconds to wait for daemon startup |
| `SMOKE_PORT` | `3199` | Port for test daemon (avoids conflict with production 3100) |

The script automatically sets these daemon environment variables:

| Variable | Value | Reason |
|---|---|---|
| `PAPERCLIP_INSTANCE_ID` | `smoke-test` | Isolate from production instance |
| `SERVE_UI` | `false` | API-only, no UI needed |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `true` | Auto-apply migrations without prompt |
| `PAPERCLIP_OPEN_ON_LISTEN` | `false` | Don't open browser |
| `HOST` | `127.0.0.1` | Loopback only |
| `PORT` | `3199` | Non-default port |

## Manual Test Checklist

For a full manual verification, walk through these steps:

### First Launch

- [ ] Delete `~/.paperclip` (or set `PAPERCLIP_HOME` to a fresh directory)
- [ ] Launch PaperClip.app
- [ ] Onboarding screen appears
- [ ] Complete onboarding (creates `config.json`)
- [ ] Dashboard loads at `http://localhost:3100`
- [ ] Health endpoint returns `{ "status": "ok" }`

### Agent Mode

- [ ] Navigate to Agent management
- [ ] Create or select an agent
- [ ] Start a task
- [ ] Verify task appears in board view
- [ ] Verify activity log updates

### AgentHubs Mode (if enabled)

- [ ] Verify Docker is running (`docker ps`)
- [ ] Switch to AgentHubs mode (if config supports it)
- [ ] Verify VM container starts
- [ ] Verify health endpoint is reachable through the gateway

### Shutdown

- [ ] Quit PaperClip.app (Cmd+Q)
- [ ] Verify daemon process exits (check Activity Monitor or `ps aux | grep paperclip`)
- [ ] No orphaned `postgres` processes remain

### Crash Recovery

- [ ] Force-kill the daemon (`kill -9 <pid>`)
- [ ] Relaunch PaperClip.app
- [ ] Verify it starts cleanly (auto-recovers embedded PG)
- [ ] Health endpoint returns `{ "status": "ok" }`

## Verification Checklist

After running the smoke test or manual verification, confirm:

- [ ] `GET /api/health` returns `{ "status": "ok" }` within timeout
- [ ] `GET /api/desktop/status` returns `uptime` and `shuttingDown` fields
- [ ] `POST /api/desktop/shutdown` is acknowledged and daemon exits
- [ ] No port conflicts (test uses 3199, production uses 3100)
- [ ] Test `PAPERCLIP_HOME` directory is clean before and after
- [ ] Docker Compose config is valid (if `--agenthubs` used)

## Known Issues

1. **First-run embedded PG initialization can be slow (~10-15s).** The smoke test
   timeout defaults to 60s. Increase `SMOKE_TIMEOUT` on slow machines.

2. **Orphaned postgres processes.** If a previous smoke test was interrupted
   (Ctrl+C during startup), the embedded PostgreSQL process may still be
   listening on port 3199. Kill it manually:
   ```sh
   lsof -ti :3199 | xargs kill -9
   ```

3. **AgentHubs Compose file not found.** If `--agenthubs` is passed but neither
   `~/.paperclip/vm/docker-compose.yml` nor the agenthubs repo exists, the test
   skips Docker validation with a warning.

4. **Dev mode vs bundled mode.** The script auto-detects whether a bundled
   daemon (`supernode-desktop/paperclip-server`) or dev build
   (`server/dist/index.js`) exists, and falls back to `pnpm dev` if neither is
   found. The dev fallback may behave differently (e.g., auto-restart on file
   changes).

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Daemon exited prematurely" | Missing Node.js deps | Run `pnpm install` first |
| "Daemon failed to start within 60s" | Slow embedded PG init | Increase `SMOKE_TIMEOUT` |
| "Health response invalid" | Wrong port or daemon crashed | Check daemon stdout/stderr |
| Port 3199 already in use | Previous run not cleaned up | `lsof -ti :3199 \| xargs kill` |
