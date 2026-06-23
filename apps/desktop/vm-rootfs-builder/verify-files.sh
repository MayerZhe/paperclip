#\!/bin/bash
# verify-files.sh — 结构化验证 rootfs.img + agent.img artifacts (无需 QEMU)
#
# Usage: ./verify-files.sh [output-dir]
#   output-dir: 包含 rootfs.img.zst, agent.img.zst, sdk-daemon 的目录
#               默认: output/
#
# Validates:
#   1. .img files exist and are raw disk images
#   2. .zst compressed sizes meet AC thresholds
#   3. sdk-daemon is valid ELF ARM64 binary
#   4. JSON config files have valid syntax
#
# 用途: S-3A3 验证前的前置检查，在无 QEMU 环境下运行
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/output}"

PASS=0
FAIL=0
WARN=0

green()  { echo -e "\033[32m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }

pass() { PASS=$((PASS + 1)); green "  PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); red   "  FAIL: $*"; }
warn() { WARN=$((WARN + 1)); yellow "  WARN: $*"; }

echo "=========================================="
echo " verify-files.sh — File Structure Check"
echo "=========================================="
echo "Output dir: $OUTPUT_DIR"
echo ""

# ──────────────────────────────────────────────────────────────────────
# Step 1: 验证 .img 文件存在性
# ──────────────────────────────────────────────────────────────────────
echo "--- Step 1: .img Files Existence ---"

ROOTFS_IMG="${OUTPUT_DIR}/rootfs.img"
AGENT_IMG="${OUTPUT_DIR}/agent.img"

if [ -f "$ROOTFS_IMG" ]; then
  ROOTFS_SIZE=$(stat -f%z "$ROOTFS_IMG" 2>/dev/null || stat -c%s "$ROOTFS_IMG" 2>/dev/null || echo "0")
  ROOTFS_MB=$(( ROOTFS_SIZE / 1024 / 1024 ))
  pass "rootfs.img found (${ROOTFS_MB}MB)"
else
  fail "rootfs.img not found at $ROOTFS_IMG"
fi

if [ -f "$AGENT_IMG" ]; then
  AGENT_SIZE=$(stat -f%z "$AGENT_IMG" 2>/dev/null || stat -c%s "$AGENT_IMG" 2>/dev/null || echo "0")
  AGENT_MB=$(( AGENT_SIZE / 1024 / 1024 ))
  pass "agent.img found (${AGENT_MB}MB)"
else
  fail "agent.img not found at $AGENT_IMG"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 2: 验证 .img 文件类型 (raw disk image / ext4 / ...)
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 2: File Type Detection ---"

if command -v file &>/dev/null; then
  if [ -f "$ROOTFS_IMG" ]; then
    ROOTFS_TYPE=$(file "$ROOTFS_IMG" 2>/dev/null || echo "unknown")
    echo "  rootfs.img: $ROOTFS_TYPE"
    if echo "$ROOTFS_TYPE" | grep -qiE "(ext[234]|filesystem|disk|raw|data)"; then
      pass "rootfs.img is a recognized disk/filesystem image"
    else
      warn "rootfs.img type not recognized as disk image"
    fi
  fi

  if [ -f "$AGENT_IMG" ]; then
    AGENT_TYPE=$(file "$AGENT_IMG" 2>/dev/null || echo "unknown")
    echo "  agent.img: $AGENT_TYPE"
    if echo "$AGENT_TYPE" | grep -qiE "(ext[234]|filesystem|disk|raw|data)"; then
      pass "agent.img is a recognized disk/filesystem image"
    else
      warn "agent.img type not recognized as disk image"
    fi
  fi
else
  warn "'file' command not available — cannot detect file types"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 3: 验证 .zst 压缩大小 (AC 阈值)
#   AC-3A.2: rootfs.img.zst < 20MB
#   AC-3A.3: agent.img.zst < 8MB
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 3: Compressed Size Check (AC Thresholds) ---"

ROOTFS_ZST="${OUTPUT_DIR}/rootfs.img.zst"
AGENT_ZST="${OUTPUT_DIR}/agent.img.zst"

if [ -f "$ROOTFS_ZST" ]; then
  ROOTFS_ZST_SIZE=$(stat -f%z "$ROOTFS_ZST" 2>/dev/null || stat -c%s "$ROOTFS_ZST" 2>/dev/null || echo "0")
  ROOTFS_ZST_MB=$(( ROOTFS_ZST_SIZE / 1024 / 1024 ))
  echo "  rootfs.img.zst: ${ROOTFS_ZST_MB}MB"

  if [ "$ROOTFS_ZST_SIZE" -lt $((20 * 1024 * 1024)) ]; then
    pass "rootfs.img.zst < 20MB (AC-3A.2): ${ROOTFS_ZST_MB}MB"
  else
    fail "rootfs.img.zst >= 20MB (AC-3A.3 requires < 20MB): ${ROOTFS_ZST_MB}MB"
  fi
else
  warn "rootfs.img.zst not found at $ROOTFS_ZST — skipping AC-3A.2 check"
fi

if [ -f "$AGENT_ZST" ]; then
  AGENT_ZST_SIZE=$(stat -f%z "$AGENT_ZST" 2>/dev/null || stat -c%s "$AGENT_ZST" 2>/dev/null || echo "0")
  AGENT_ZST_MB=$(( AGENT_ZST_SIZE / 1024 / 1024 ))
  echo "  agent.img.zst: ${AGENT_ZST_MB}MB"

  if [ "$AGENT_ZST_SIZE" -lt $((8 * 1024 * 1024)) ]; then
    pass "agent.img.zst < 8MB (AC-3A.3): ${AGENT_ZST_MB}MB"
  else
    fail "agent.img.zst >= 8MB (AC-3A.3 requires < 8MB): ${AGENT_ZST_MB}MB"
  fi
else
  warn "agent.img.zst not found at $AGENT_ZST — skipping AC-3A.3 check"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 4: 验证 sdk-daemon 是有效的 ARM64 ELF 二进制
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 4: sdk-daemon Binary Check ---"

SDK_DAEMON="${OUTPUT_DIR}/sdk-daemon"

# Also check the vm-guest-agent bin directory
SDK_DAEMON_ALT="${SCRIPT_DIR}/../vm-guest-agent/bin/sdk-daemon"

SDK_FOUND=false
for SDK_PATH in "$SDK_DAEMON" "$SDK_DAEMON_ALT"; do
  if [ -f "$SDK_PATH" ]; then
    SDK_FOUND=true
    echo "  Found: $SDK_PATH"
    if command -v file &>/dev/null; then
      SDK_TYPE=$(file "$SDK_PATH" 2>/dev/null || echo "unknown")
      echo "  Type: $SDK_TYPE"

      if echo "$SDK_TYPE" | grep -qi "ELF.*ARM.*aarch64"; then
        pass "sdk-daemon is ELF 64-bit ARM aarch64 binary"
      elif echo "$SDK_TYPE" | grep -qi "ELF"; then
        warn "sdk-daemon is ELF but architecture may not be aarch64: $SDK_TYPE"
      else
        warn "sdk-daemon does not appear to be an ELF binary: $SDK_TYPE"
      fi

      # Check executable permissions
      if [ -x "$SDK_PATH" ]; then
        pass "sdk-daemon has execute permission"
      else
        warn "sdk-daemon missing execute permission"
      fi
    else
      warn "'file' command not available — cannot verify sdk-daemon"
    fi
    break
  fi
done

if [ "$SDK_FOUND" \!= "true" ]; then
  fail "sdk-daemon not found at $SDK_DAEMON or $SDK_DAEMON_ALT"
  fail "Build sdk-daemon via vm-guest-agent first (S-3A1)"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 5: 验证 JSON 配置文件
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 5: JSON Config Validation ---"

# Validate sdk-daemon-config.json
CONFIG="${SCRIPT_DIR}/sdk-daemon-config.json"
if [ -f "$CONFIG" ]; then
  if python3 -c "import json; json.load(open('$CONFIG'))" 2>/dev/null; then
    pass "sdk-daemon-config.json is valid JSON"
  else
    fail "sdk-daemon-config.json contains invalid JSON"
  fi
else
  warn "sdk-daemon-config.json not found at $CONFIG"
fi

# Check manifest.json if it exists (from download-vm-image.ts workflow)
MANIFEST="${OUTPUT_DIR}/manifest.json"
if [ -f "$MANIFEST" ]; then
  if python3 -c "import json; json.load(open('$MANIFEST'))" 2>/dev/null; then
    pass "manifest.json is valid JSON"
  else
    fail "manifest.json contains invalid JSON"
  fi
fi

# Check any other .json files in the output dir
JSON_FILES=$(find "${OUTPUT_DIR}" -maxdepth 1 -name "*.json" -not -name "manifest.json" 2>/dev/null || true)
if [ -n "$JSON_FILES" ]; then
  echo "  Additional JSON files found:"
  for jf in $JSON_FILES; do
    jf_name=$(basename "$jf")
    if python3 -c "import json; json.load(open('$jf'))" 2>/dev/null; then
      pass "$jf_name is valid JSON"
    else
      fail "$jf_name contains invalid JSON"
    fi
  done
fi

# ──────────────────────────────────────────────────────────────────────
# Step 6: 验证产物完整性（checksum 对比）
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 6: Artifact Integrity ---"

# If we have a checksum file, verify against it
CHECKSUM_FILE="${OUTPUT_DIR}/checksums.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  ORIG_DIR=$(pwd)
  cd "$OUTPUT_DIR"
  if command -v shasum &>/dev/null; then
    # macOS shasum
    if shasum -a 256 -c "$(basename "$CHECKSUM_FILE")" 2>/dev/null; then
      pass "All artifacts pass SHA256 checksum verification"
    else
      fail "SHA256 checksum verification failed — corrupted artifacts"
    fi
  elif command -v sha256sum &>/dev/null; then
    # Linux sha256sum
    if sha256sum -c "$(basename "$CHECKSUM_FILE")" 2>/dev/null; then
      pass "All artifacts pass SHA256 checksum verification"
    else
      fail "SHA256 checksum verification failed — corrupted artifacts"
    fi
  else
    warn "No sha256sum/shasum tool found — skipping checksum verification"
  fi
  cd "$ORIG_DIR"
else
  warn "No checksums.sha256 found — skipping integrity check"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 7: 验证 build 脚本存在且可执行
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- Step 7: Build Script Availability ---"

for BUILD_SCRIPT in "build-rootfs.sh" "build-agent.sh"; do
  BSP="${SCRIPT_DIR}/${BUILD_SCRIPT}"
  if [ -f "$BSP" ]; then
    if [ -x "$BSP" ]; then
      pass "$BUILD_SCRIPT exists and is executable"
    else
      warn "$BUILD_SCRIPT exists but is not executable"
    fi
  else
    warn "$BUILD_SCRIPT not found — needed for S-3A2 artifact generation"
  fi
done

# ──────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo " verify-files.sh — Summary"
echo "=========================================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "WARN: $WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  red "Some checks FAILED. Review output above before proceeding to QEMU test."
  exit 1
else
  green "All checks passed\!"
  exit 0
fi
