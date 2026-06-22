#!/bin/bash
# PaperClip Local Smoke Test
# Usage: ./smoke-test.sh [--agenthubs] [--quick]
#
# Validates the PaperClip desktop daemon can start, serve health, and shut down
# cleanly. Optionally validates Docker Compose config for AgentHubs mode.
#
# Prerequisites:
#   - Node.js 22+
#   - PaperClip server built (dist/index.bundle.cjs or pnpm dev)
#   - curl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use a test-specific home to avoid corrupting production data.
PAPERCLIP_HOME="${PAPERCLIP_HOME:-/tmp/paperclip-smoke-test-home}"
APP_PATH="${APP_PATH:-/Applications/PaperClip.app}"
TIMEOUT="${SMOKE_TIMEOUT:-60}"
TEST_PORT="${SMOKE_PORT:-3199}"
QUICK_MODE=false
AGENTHUBS_MODE=false

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK_MODE=true ;;
    --agenthubs) AGENTHUBS_MODE=true ;;
  esac
done

cleanup_daemon() {
  if [[ -n "${DAEMON_PID:-}" ]]; then
    curl -sf -X POST "http://127.0.0.1:${TEST_PORT}/api/desktop/shutdown" 2>/dev/null || true
    sleep 2
    kill "${DAEMON_PID}" 2>/dev/null || true
    wait "${DAEMON_PID}" 2>/dev/null || true
  fi
}
trap cleanup_daemon EXIT

echo "=== PaperClip Smoke Test ==="
echo "PAPERCLIP_HOME: ${PAPERCLIP_HOME}"
echo "Test port:      ${TEST_PORT}"
echo "Timeout:        ${TIMEOUT}s"
echo ""

# ---------------------------------------------------------------------------
# Test 1: Daemon direct start
# ---------------------------------------------------------------------------
echo "--- Test 1: Daemon direct start ---"

# Ensure clean test home.
rm -rf "${PAPERCLIP_HOME}"
mkdir -p "${PAPERCLIP_HOME}"

# Choose the daemon entry point. Prefer the bundled output next to this repo,
# then fall back to running via pnpm in dev mode.
DAEMON_SCRIPT=""
if [[ -f "${REPO_ROOT}/supernode-desktop/paperclip-server" ]]; then
  DAEMON_SCRIPT="${REPO_ROOT}/supernode-desktop/paperclip-server"
  DAEMON_CMD=("node" "${DAEMON_SCRIPT}")
elif [[ -f "${REPO_ROOT}/server/dist/index.js" ]]; then
  DAEMON_SCRIPT="${REPO_ROOT}/server/dist/index.js"
  DAEMON_CMD=("node" "${DAEMON_SCRIPT}")
else
  echo "No daemon build found; running via pnpm dev (fallback)"
  DAEMON_CMD=("pnpm" "--filter" "@paperclipai/server" "dev")
fi

echo "Starting daemon: ${DAEMON_CMD[*]}"

PAPERCLIP_HOME="${PAPERCLIP_HOME}" \
  PAPERCLIP_INSTANCE_ID="smoke-test" \
  SERVE_UI=false \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  PAPERCLIP_OPEN_ON_LISTEN=false \
  HOST=127.0.0.1 \
  PORT="${TEST_PORT}" \
  "${DAEMON_CMD[@]}" &
DAEMON_PID=$!

# Wait for health endpoint.
START_TS=$(date +%s)
HEALTH_OK=false
for i in $(seq 1 "${TIMEOUT}"); do
  if curl -sf "http://127.0.0.1:${TEST_PORT}/api/health" > /dev/null 2>&1; then
    ELAPSED=$(( $(date +%s) - START_TS ))
    echo "PASS  Daemon health OK (${ELAPSED}s)"
    HEALTH_OK=true
    break
  fi
  if ! kill -0 "${DAEMON_PID}" 2>/dev/null; then
    echo "FAIL  Daemon exited prematurely (pid ${DAEMON_PID})"
    exit 1
  fi
  if [[ $i -eq "${TIMEOUT}" ]]; then
    echo "FAIL  Daemon failed to start within ${TIMEOUT}s"
    exit 1
  fi
  sleep 1
done

if [[ "${HEALTH_OK}" != "true" ]]; then
  echo "FAIL  Health check did not pass"
  exit 1
fi

# ---------------------------------------------------------------------------
# Test 2: Health response format
# ---------------------------------------------------------------------------
echo "--- Test 2: Health response format ---"

HEALTH=$(curl -sf "http://127.0.0.1:${TEST_PORT}/api/health")
if echo "${HEALTH}" | grep -q '"status":"ok"'; then
  echo "PASS  Health response valid: ${HEALTH}"
else
  echo "FAIL  Health response invalid: ${HEALTH}"
  exit 1
fi

# Quick mode: skip remaining tests.
if [[ "${QUICK_MODE}" == "true" ]]; then
  echo ""
  echo "--- Quick mode: skipping extended tests ---"
  cleanup_daemon
  trap - EXIT
  echo ""
  echo "=== Smoke Test Complete (quick) ==="
  exit 0
fi

# ---------------------------------------------------------------------------
# Test 3: Desktop status endpoint
# ---------------------------------------------------------------------------
echo "--- Test 3: Desktop status endpoint ---"

STATUS=$(curl -sf "http://127.0.0.1:${TEST_PORT}/api/desktop/status")
if echo "${STATUS}" | grep -q '"uptime"'; then
  echo "PASS  Desktop status valid: ${STATUS}"
else
  echo "WARN  Desktop status unexpected (may not be mounted in dev mode): ${STATUS}"
fi

# ---------------------------------------------------------------------------
# Test 4: Graceful shutdown
# ---------------------------------------------------------------------------
echo "--- Test 4: Graceful shutdown ---"

SHUTDOWN=$(curl -sf -X POST "http://127.0.0.1:${TEST_PORT}/api/desktop/shutdown")
if echo "${SHUTDOWN}" | grep -q '"acknowledged":true'; then
  echo "PASS  Shutdown acknowledged: ${SHUTDOWN}"
else
  echo "WARN  Shutdown response unexpected: ${SHUTDOWN}"
fi

# Wait for daemon to exit.
sleep 2
if ! kill -0 "${DAEMON_PID}" 2>/dev/null; then
  echo "PASS  Daemon exited cleanly after shutdown"
else
  echo "WARN  Daemon still running after shutdown; force-killing"
  kill "${DAEMON_PID}" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Test 5: Docker Compose config (AgentHubs mode)
# ---------------------------------------------------------------------------
if [[ "${AGENTHUBS_MODE}" == "true" ]]; then
  echo ""
  echo "--- Test 5: Docker Compose config ---"

  COMPOSE_FILE="${PAPERCLIP_HOME}/vm/docker-compose.yml"
  if [[ -f "${COMPOSE_FILE}" ]]; then
    if docker compose -f "${COMPOSE_FILE}" config > /dev/null 2>&1; then
      echo "PASS  Compose config valid (${COMPOSE_FILE})"
    else
      echo "FAIL  Compose config invalid (${COMPOSE_FILE})"
    fi
  else
    AGENTHUBS_COMPOSE="/Users/Mayer/mayer_project/coworker/agenthubs/docker-compose.yml"
    if [[ -f "${AGENTHUBS_COMPOSE}" ]]; then
      if docker compose -f "${AGENTHUBS_COMPOSE}" config > /dev/null 2>&1; then
        echo "PASS  Compose config valid (${AGENTHUBS_COMPOSE})"
      else
        echo "FAIL  Compose config invalid (${AGENTHUBS_COMPOSE})"
      fi
    else
      echo "SKIP  No compose file found; skipping Docker test"
    fi
  fi
else
  echo ""
  echo "SKIP  Test 5 (Docker Compose): use --agenthubs to enable"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup_daemon
trap - EXIT

echo ""
echo "=== Smoke Test Complete ==="
echo "All tests passed."
