#!/bin/bash
# PaperClip Desktop DMG Smoke Test
# Usage: ./scripts/desktop/smoke-test.sh [--quick]
#
# Validates the SuperNode Desktop build artifacts before packaging:
#   1. Directory structure (dist/, agenthubs-vm/, vm-runtime/)
#   2. electron-builder.yml config validity
#   3. Entitlements plist files with required keys
#   4. VM images in dist/agenthubs-vm/
#   5. Swift binaries (supernode-vm, sdk-daemon)
#
# All optional components (VM images, Swift binaries) use SKIP not FAIL.
# Run from repo root: ./scripts/desktop/smoke-test.sh
#
# Prerequisites: None – static file checks only, no app start.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUPER_DESKTOP="${REPO_ROOT}/SuperNode-desktop"
DIST_DIR="${SUPER_DESKTOP}/dist"
APPS_DESKTOP="${REPO_ROOT}/apps/desktop"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# ─── Helpers ──────────────────────────────────────────────────────

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

pass_msg() { green "PASS  $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail_msg() { red   "FAIL  $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip_msg() { yellow "SKIP  $1"; SKIP_COUNT=$((SKIP_COUNT + 1)); }
info_msg() { echo "INFO  $1"; }

# ─── Header ───────────────────────────────────────────────────────

echo "========================================"
echo " PaperClip Desktop DMG Smoke Test"
echo "========================================"
echo "Repo root:      ${REPO_ROOT}"
echo "SuperNode:      ${SUPER_DESKTOP}"
echo "Dist dir:       ${DIST_DIR}"
echo ""

# ─── Test 1: Directory structure ──────────────────────────────────

echo "--- Test 1: Directory structure ---"

if [[ -d "${SUPER_DESKTOP}" ]]; then
  pass_msg "SuperNode-desktop/ exists"
else
  fail_msg "SuperNode-desktop/ does not exist at ${SUPER_DESKTOP}"
  echo ""
  echo "=== Smoke Test Aborted (critical structure missing) ==="
  exit 1
fi

if [[ -d "${APPS_DESKTOP}" ]]; then
  pass_msg "apps/desktop/ exists"
else
  fail_msg "apps/desktop/ does not exist at ${APPS_DESKTOP}"
fi

if [[ -d "${DIST_DIR}" ]]; then
  pass_msg "SuperNode-desktop/dist/ exists"
  # List dist contents
  info_msg "dist/ contents:"
  ls -la "${DIST_DIR}" 2>/dev/null | sed 's/^/       /' || true
else
  skip_msg "SuperNode-desktop/dist/ does not exist (not yet built)"
fi

# ─── Test 2: electron-builder.yml ─────────────────────────────────

echo ""
echo "--- Test 2: electron-builder.yml ---"

EB_YML="${SUPER_DESKTOP}/electron-builder.yml"

if [[ -f "${EB_YML}" ]]; then
  pass_msg "electron-builder.yml exists"

  # Validate YAML is non-empty and has expected keys
  if [[ -s "${EB_YML}" ]]; then
    pass_msg "electron-builder.yml is non-empty"

    # Check required keys (line-anchored grep for YAML top-level keys)
    for key in "appId:" "productName:" "asar:" "mac:" "files:"; do
      if grep -q "^${key}" "${EB_YML}"; then
        pass_msg "  contains key: ${key}"
      else
        fail_msg "  missing key: ${key}"
      fi
    done

    # ADR-01: asar must be false
    if grep -q 'asar: false' "${EB_YML}"; then
      pass_msg "  asar: false (ADR-01)"
    else
      fail_msg "  asar must be false per ADR-01"
    fi

    # Product name
    if grep -q 'productName: SuperNode' "${EB_YML}"; then
      pass_msg "  productName: SuperNode"
    else
      fail_msg "  productName must be SuperNode"
    fi

  else
    fail_msg "electron-builder.yml is empty"
  fi
else
  fail_msg "electron-builder.yml not found at ${EB_YML}"
fi

# ─── Test 3: Entitlements plist ───────────────────────────────────

echo ""
echo "--- Test 3: Entitlements plist ---"

PLIST_PATH="${APPS_DESKTOP}/build/entitlements.mac.plist"

if [[ -f "${PLIST_PATH}" ]]; then
  pass_msg "entitlements.mac.plist exists"

  # Validate XML structure
  if grep -q '<?xml' "${PLIST_PATH}"; then
    pass_msg "  valid XML declaration"
  else
    fail_msg "  missing XML declaration"
  fi

  if grep -q '<!DOCTYPE plist' "${PLIST_PATH}"; then
    pass_msg "  valid DOCTYPE plist"
  else
    fail_msg "  missing DOCTYPE plist"
  fi

  if grep -q '<plist' "${PLIST_PATH}" && grep -q '</plist>' "${PLIST_PATH}"; then
    pass_msg "  plist tags present"
  else
    fail_msg "  missing plist tags"
  fi

  # Check required entitlement keys
  for entitlement in \
    "com.apple.security.network.client" \
    "com.apple.security.cs.allow-jit"
  do
    if grep -q "${entitlement}" "${PLIST_PATH}"; then
      pass_msg "  entitlement: ${entitlement}"
    else
      fail_msg "  missing entitlement: ${entitlement}"
    fi
  done

  # Virtualization entitlement (optional for now)
  if grep -q "com.apple.security.virtualization" "${PLIST_PATH}"; then
    pass_msg "  entitlement: com.apple.security.virtualization"
  else
    skip_msg "  entitlement: com.apple.security.virtualization (not yet added — required for VM support)"
  fi

else
  fail_msg "entitlements.mac.plist not found at ${PLIST_PATH}"
fi

# ─── Test 4: VM images (agenthubs-vm) ────────────────────────────

echo ""
echo "--- Test 4: VM images (agenthubs-vm) ---"

VM_DIR="${DIST_DIR}/agenthubs-vm"

if [[ -d "${VM_DIR}" ]]; then
  pass_msg "agenthubs-vm/ directory exists"
  info_msg "agenthubs-vm/ contents:"
  ls -lh "${VM_DIR}" 2>/dev/null | sed 's/^/       /' || true

  # Check for rootfs.img (uncompressed) or rootfs.img.zst (compressed)
  if [[ -f "${VM_DIR}/rootfs.img" ]] || [[ -f "${VM_DIR}/rootfs.img.zst" ]]; then
    local_rootfs=""
    [[ -f "${VM_DIR}/rootfs.img" ]] && local_rootfs="${VM_DIR}/rootfs.img"
    [[ -f "${VM_DIR}/rootfs.img.zst" ]] && local_rootfs="${VM_DIR}/rootfs.img.zst"
    pass_msg "  rootfs image found: $(basename "${local_rootfs}")"
  else
    skip_msg "  rootfs image not found (not yet downloaded/built)"
  fi

  # Check for agent.img (uncompressed) or agent.img.zst (compressed)
  if [[ -f "${VM_DIR}/agent.img" ]] || [[ -f "${VM_DIR}/agent.img.zst" ]]; then
    local_agent=""
    [[ -f "${VM_DIR}/agent.img" ]] && local_agent="${VM_DIR}/agent.img"
    [[ -f "${VM_DIR}/agent.img.zst" ]] && local_agent="${VM_DIR}/agent.img.zst"
    pass_msg "  agent image found: $(basename "${local_agent}")"
  else
    skip_msg "  agent image not found (not yet downloaded/built)"
  fi

else
  skip_msg "agenthubs-vm/ directory does not exist (not yet built)"
fi

# ─── Test 5: Swift / vm-runtime binaries ──────────────────────────

echo ""
echo "--- Test 5: VM runtime binaries ---"

VM_RUNTIME_DIR="${DIST_DIR}/vm-runtime"

if [[ -d "${VM_RUNTIME_DIR}" ]]; then
  pass_msg "vm-runtime/ directory exists"
  info_msg "vm-runtime/ contents:"
  ls -lh "${VM_RUNTIME_DIR}" 2>/dev/null | sed 's/^/       /' || true

  # supernode-vm
  if [[ -f "${VM_RUNTIME_DIR}/supernode-vm" ]]; then
    if [[ -x "${VM_RUNTIME_DIR}/supernode-vm" ]]; then
      pass_msg "  supernode-vm exists and is executable"
    else
      pass_msg "  supernode-vm exists (executable bit not set — will be fixed at packaging)"
    fi
  else
    skip_msg "  supernode-vm not found (compile with: swift build -c release --product supernode-vm)"
  fi

  # sdk-daemon
  if [[ -f "${VM_RUNTIME_DIR}/sdk-daemon" ]]; then
    if [[ -x "${VM_RUNTIME_DIR}/sdk-daemon" ]]; then
      pass_msg "  sdk-daemon exists and is executable"
    else
      pass_msg "  sdk-daemon exists (executable bit not set — will be fixed at packaging)"
    fi
  else
    skip_msg "  sdk-daemon not found (guest agent daemon, compile separately)"
  fi

else
  skip_msg "vm-runtime/ directory does not exist (not yet built)"
fi

# ─── Summary ──────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Smoke Test Summary"
echo "========================================"
echo "PASS: ${PASS_COUNT}"
echo "FAIL: ${FAIL_COUNT}"
echo "SKIP: ${SKIP_COUNT}"
echo ""

TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
if [[ "${FAIL_COUNT}" -eq 0 ]]; then
  green "All assertions passed (${PASS_COUNT}/${TOTAL} checks, ${SKIP_COUNT} skipped)."
  exit 0
else
  red "${FAIL_COUNT} assertion(s) failed."
  exit 1
fi
