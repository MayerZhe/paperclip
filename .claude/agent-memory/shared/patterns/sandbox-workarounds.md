---
name: sandbox-workarounds
description: What operations work inside the Claude Code sandbox and what requires external execution
metadata:
  type: reference
  shared: true
---

# Sandbox Limitations & Workarounds

**Rule:** The Claude Code sandbox blocks raw Python socket creation (`PermissionError: [Errno 1] Operation not permitted` on `sock.connect`). This means `uvicorn`, `asyncpg`, and any Python TCP socket code will fail within the sandbox.

## What works IN sandbox
- pytest (SQLite-based tests)
- py_compile / tsc --noEmit (type checking)
- grep, find, git (read-only operations)
- curl (uses established system sockets)
- npm install / pip install (package managers)
- Building frontend assets (next build, vite build)

## What requires OUTSIDE sandbox
- Server startup (uvicorn, next dev, node server)
- Database connections (asyncpg, psycopg2, pymongo)
- HTTP endpoint testing via curl to localhost
- Browser preview / screenshot capture
- Real API calls to local services

## Recommended Strategy
1. Within sandbox: Run all unit tests, type checks, linting, code analysis
2. Generate `verify-e2e.sh` from template for manual E2E execution
3. orchestrator marks L4 (E2E) as WARNING not BLOCKING when sandbox detected
4. User runs `bash scripts/verify-e2e.sh` in external terminal

## Detection Snippet
```bash
python3 -c "
import socket
try:
    s = socket.socket()
    s.connect(('127.0.0.1', 1))
    print('NETWORK_OK')
except PermissionError:
    print('SANDBOX_DETECTED')
"
```

Related: [[api-naming]], [[quality-gates]]
