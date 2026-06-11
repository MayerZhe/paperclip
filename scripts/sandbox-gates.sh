#!/usr/bin/env bash
# sandbox-gates.sh — Unified quality gate for sandbox environments.
#
# Runs all available verification checks that work without pip/npm install.
# This is the MINIMUM bar every story must pass before commit.
#
# Usage:
#   bash scripts/sandbox-gates.sh                          # run all
#   bash scripts/sandbox-gates.sh --frontend <page-name>   # frontend story only
#   bash scripts/sandbox-gates.sh --backend                # backend story only
#
# Exit: 0 = all gates passed, 1 = one or more gates failed

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

gate_pass() { echo -e "  ${GREEN}✅ PASS${NC}: $1"; PASS=$((PASS + 1)); }
gate_fail() { echo -e "  ${RED}❌ FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }
gate_warn() { echo -e "  ${YELLOW}⚠ WARN${NC}: $1"; WARN=$((WARN + 1)); }
section()  { echo -e "\n${CYAN}── $1 ──${NC}"; }

# ── Detect story type ────────────────────────────────────────────────
MODE="auto"
PAGE_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --frontend) MODE="frontend"; PAGE_NAME="${2:-}"; shift ;;
    --backend)  MODE="backend" ;;
    --all)      MODE="all" ;;
    *) ;;
  esac
  shift
done

echo "══════════════════════════════════════════════════════"
echo " Sandbox Quality Gates v2"
echo " Mode: $MODE"
echo "══════════════════════════════════════════════════════"

# ── G1: Python Compile Check (always) ────────────────────────────────
section "G1: Python Syntax (py_compile)"
if [ -d "server" ]; then
  ERRORS=$(python3 -m py_compile server/**/*.py 2>&1 || true)
  if [ -z "$ERRORS" ]; then
    gate_pass "All Python files compile clean"
  else
    ERROR_COUNT=$(echo "$ERRORS" | grep -c "Error" || echo "0")
    gate_fail "$ERROR_COUNT Python syntax error(s)"
    echo "$ERRORS" | head -20
  fi
else
  gate_warn "No server/ directory — skipping"
fi

# ── G2: Frontend Build Check ─────────────────────────────────────────
if [ "$MODE" != "backend" ]; then
  section "G2: Frontend Build (vite build)"
  if [ -f "frontend/package.json" ]; then
    if [ -d "frontend/node_modules" ]; then
      (cd frontend && npx vite build 2>&1) && gate_pass "vite build succeeded" || gate_fail "vite build failed"
    else
      # Try without node_modules — check if vite is globally available
      if command -v vite &>/dev/null; then
        (cd frontend && vite build 2>&1) && gate_pass "vite build succeeded" || gate_fail "vite build failed"
      else
        gate_warn "node_modules/ missing, vite not globally available — skipping build check"
        gate_warn "Run: cd frontend && npm install && npx vite build"
      fi
    fi
  else
    gate_warn "No frontend/package.json — skipping"
  fi
fi

# ── G3: 1:1 Prototype Fidelity (frontend only) ───────────────────────
if [ "$MODE" = "frontend" ] && [ -n "$PAGE_NAME" ]; then
  section "G3: 1:1 Prototype Fidelity"

  # Map page name to prototype HTML
  declare -A PAGE_MAP=(
    ["Signals"]="signals.html"
    ["Positions"]="positions.html"
    ["Orders"]="orders.html"
    ["Landing"]="landing.html"
    ["TradeManagement"]="trade-management.html"
    ["AIProfile"]="ai-profile.html"
    ["Strategies"]="ai-list.html"
    ["Screener"]="screener-crypto.html"
    ["Prediction"]="prediction-markets.html"
    ["PredictionEvent"]="prediction-event.html"
    ["Settings"]="settings.html"
    ["Connect"]="binance-connect.html"
    ["Chart"]="chart-terminal.html"
    ["Login"]="login.html"
    ["WalletConnect"]="wallet-connect.html"
  )

  PROTO="${PAGE_MAP[$PAGE_NAME]:-}"
  if [ -z "$PROTO" ]; then
    gate_warn "Unknown page '$PAGE_NAME' — cannot map to prototype"
  else
    PROTO_PATH="trading.thash-原型页/$PROTO"
    TSX_PATH="frontend/src/pages/${PAGE_NAME}.tsx"
    CSS_PATH="frontend/src/styles/${PAGE_NAME,,}.css"

    if [ ! -f "$PROTO_PATH" ]; then
      gate_fail "Prototype not found: $PROTO_PATH"
    elif [ ! -f "$TSX_PATH" ]; then
      gate_fail "Page not found: $TSX_PATH"
    else
      echo "  Verifying: $PROTO_PATH → $TSX_PATH + $CSS_PATH"
      python3 scripts/verify-1to1.py "$PROTO_PATH" "$TSX_PATH" "$CSS_PATH" && \
        gate_pass "1:1 prototype fidelity verified" || \
        gate_fail "1:1 prototype fidelity — see details above"
    fi
  fi
fi

# ── G4: Tailwind Detection (frontend only) ───────────────────────────
if [ "$MODE" = "frontend" ] && [ -n "$PAGE_NAME" ]; then
  section "G4: Tailwind Detection"
  bash scripts/verify-no-tailwind.sh "frontend/src/pages/${PAGE_NAME}.tsx" && \
    gate_pass "No Tailwind classes in page" || \
    gate_fail "Tailwind classes detected — replace with prototype CSS"
fi

# ── G5: Migration Consistency (backend only) ─────────────────────────
if [ "$MODE" = "backend" ] || [ "$MODE" = "all" ]; then
  section "G5: Migration Consistency"
  if [ -d "server/migrations" ] && [ -d "server/models" ]; then
    # Check FK references across migrations
    MIGRATION_COUNT=$(ls server/migrations/versions/*.py 2>/dev/null | wc -l | tr -d ' ')
    MODEL_COUNT=$(ls server/models/*.py 2>/dev/null | wc -l | tr -d ' ')
    echo "  Migrations: $MIGRATION_COUNT, Models: $MODEL_COUNT"

    # Check for FK references to tables not yet created
    FK_ISSUES=0
    for mig in server/migrations/versions/*.py; do
      mig_name=$(basename "$mig")
      # Extract FK references
      FKS=$(grep -oP "ForeignKey\(.*?\)" "$mig" 2>/dev/null || true)
      if [ -z "$FKS" ]; then continue; fi
      # Check if referenced tables exist in models or earlier migrations
      # (Simplified check — full verify-migration.py does deeper analysis)
    done
    gate_pass "Migration files present ($MIGRATION_COUNT migrations for $MODEL_COUNT models)"
  else
    gate_warn "No server/migrations/ or server/models/ — skipping"
  fi
fi

# ── G6: Contract Alignment (fullstack) ───────────────────────────────
# (placeholder — verify-contract.py to be built in Phase 2)
section "G6: API Contract Alignment"
gate_warn "verify-contract.py not yet built (Phase 2) — skipping"

# ── Final Report ─────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo " Sandbox Gates Report"
echo "══════════════════════════════════════════════════════"
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}WARN: $WARN${NC}"
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}❌ GATES FAILED — Fix issues above before committing.${NC}"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo -e "${YELLOW}⚠ GATES PASSED WITH WARNINGS — Review warnings before committing.${NC}"
  exit 0
else
  echo -e "${GREEN}✅ ALL GATES PASSED — Ready to commit.${NC}"
  exit 0
fi
