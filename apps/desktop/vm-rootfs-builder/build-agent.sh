#!/bin/bash
# build-agent.sh — Build the agent.img for AgentHubs VM
#
# Creates a small exFAT (or FAT32 fallback) image containing:
#   - sdk-daemon binary (Go, from vm-guest-agent/bin/)
#   - cli-wrapper (shell script)
#   - sandbox-helper (shell script)
#
# The agent.img is mounted by the VM host to access the guest agent binary
# and helper scripts without needing to embed them in the rootfs.
#
# Usage:
#   ./build-agent.sh              # Build agent.img.zst
#   ./build-agent.sh --clean      # Clean and rebuild
#   AGENT_IMG_SIZE_MB=64 ./build-agent.sh  # Override image size
#
# Environment variables:
#   AGENT_IMG_SIZE_MB   Size of the image in MB (default: 64)
#   ZSTD_COMPRESSION    zstd compression level (default: 19)

set -euo pipefail

# ─── Configuration ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT_DIR="$SCRIPT_DIR/output"
AGENT_IMG_SIZE_MB="${AGENT_IMG_SIZE_MB:-64}"
ZSTD_COMPRESSION="${ZSTD_COMPRESSION:-19}"
CLEAN_BUILD=false

# ─── Parse arguments ───
for arg in "$@"; do
    case "$arg" in
        --clean)
            CLEAN_BUILD=true
            ;;
        --help|-h)
            echo "Usage: $0 [--clean]"
            echo ""
            echo "Options:"
            echo "  --clean    Remove build directory before starting"
            echo ""
            echo "Environment:"
            echo "  AGENT_IMG_SIZE_MB   Image size in MB (default: 64)"
            echo "  ZSTD_COMPRESSION    zstd compression level (default: 19)"
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $arg"
            echo "Usage: $0 [--clean]"
            exit 1
            ;;
    esac
done

# ─── Source paths ───
VM_GUEST_AGENT="$REPO_ROOT/apps/desktop/vm-guest-agent"
SDK_DAEMON_BIN="$VM_GUEST_AGENT/bin/sdk-daemon"
CLI_WRAPPER="$SCRIPT_DIR/cli-wrapper"
SANDBOX_HELPER="$SCRIPT_DIR/sandbox-helper"

# ─── Helper functions ───
log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        err "Required command not found: $1"
        return 1
    fi
}

human_size() {
    local bytes=$1
    if command -v numfmt &>/dev/null; then
        numfmt --to=iec-i --suffix=B "$bytes" 2>/dev/null || echo "${bytes} bytes"
    else
        if [ "$bytes" -ge 1073741824 ]; then
            echo "$(( (bytes * 10 + 536870912) / 1073741824 )).$(( ((bytes * 100 + 536870912) / 1073741824) % 100 )) GiB"
        elif [ "$bytes" -ge 1048576 ]; then
            echo "$(( (bytes * 10 + 524288) / 1048576 )).$(( ((bytes * 100 + 524288) / 1048576) % 100 )) MiB"
        elif [ "$bytes" -ge 1024 ]; then
            echo "$(( (bytes * 10 + 512) / 1024 )).$(( ((bytes * 100 + 512) / 1024) % 100 )) KiB"
        else
            echo "${bytes} bytes"
        fi
    fi
}

# ─── Phase 1: Environment validation ───
log "=== Phase 1: Validating build environment ==="

check_cmd zstd || {
    err "zstd is not installed"
    err "Install with: brew install zstd"
    exit 1
}

# Determine which filesystem tools are available
# macOS doesn't have mkfs.exfat or mkfs.fat by default
# We prefer a raw tar-based approach that doesn't require specific filesystem tools
USE_RAW_IMAGE=true
IMAGE_FS="raw"

if command -v mkfs.exfat &>/dev/null; then
    USE_RAW_IMAGE=false
    IMAGE_FS="exfat"
    log "Found mkfs.exfat, will create exFAT image"
elif command -v newfs_msdos &>/dev/null; then
    USE_RAW_IMAGE=false
    IMAGE_FS="fat32"
    log "Found newfs_msdos, will create FAT32 image"
elif command -v mkfs.fat &>/dev/null; then
    USE_RAW_IMAGE=false
    IMAGE_FS="fat32"
    log "Found mkfs.fat, will create FAT32 image"
else
    log "No exFAT/FAT32 tools found, will create raw tar image"
    log "  (Install e2fsprogs or dosfstools for filesystem images)"
fi

# ─── Phase 2: Source validation ───
log "=== Phase 2: Validating source paths ==="

# Check for sdk-daemon binary
if [ ! -f "$SDK_DAEMON_BIN" ]; then
    err "sdk-daemon binary not found at: $SDK_DAEMON_BIN"
    err ""
    err "Build it first:"
    err "  cd apps/desktop/vm-guest-agent && \\"
    err "    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \\"
    err "    go build -ldflags \"-s -w\" -o bin/sdk-daemon ./cmd/sdk-daemon/"
    exit 1
fi
SDK_DAEMON_SIZE=$(stat -f%z "$SDK_DAEMON_BIN" 2>/dev/null || stat -c%s "$SDK_DAEMON_BIN" 2>/dev/null)
log "sdk-daemon: $(human_size "$SDK_DAEMON_SIZE")"

# Check for helper scripts
for script in "$CLI_WRAPPER" "$SANDBOX_HELPER"; do
    if [ ! -f "$script" ]; then
        err "Helper script not found: $script"
        exit 1
    fi
done
log "cli-wrapper: $CLI_WRAPPER"
log "sandbox-helper: $SANDBOX_HELPER"

# ─── Phase 3: Prepare build context ───
log "=== Phase 3: Preparing build context ==="

if [ "$CLEAN_BUILD" = true ]; then
    log "Cleaning agent build directory"
    rm -rf "$BUILD_DIR/agent"
fi

AGENT_CONTENT="$BUILD_DIR/agent-content"
rm -rf "$AGENT_CONTENT"
mkdir -p "$AGENT_CONTENT"

# Copy all files to the content directory
cp "$SDK_DAEMON_BIN" "$AGENT_CONTENT/sdk-daemon"
chmod +x "$AGENT_CONTENT/sdk-daemon"
cp "$CLI_WRAPPER" "$AGENT_CONTENT/cli-wrapper"
chmod +x "$AGENT_CONTENT/cli-wrapper"
cp "$SANDBOX_HELPER" "$AGENT_CONTENT/sandbox-helper"
chmod +x "$AGENT_CONTENT/sandbox-helper"

log "Agent content prepared in $AGENT_CONTENT"
log "Files:"
for f in "$AGENT_CONTENT"/*; do
    file_size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null)
    log "  $(basename "$f") : $(human_size "$file_size")"
done

# ─── Phase 4: Create agent image ───
log "=== Phase 4: Creating agent image ==="

AGENT_IMG="$OUTPUT_DIR/agent.img"
AGENT_ZST="$OUTPUT_DIR/agent.img.zst"

rm -f "$AGENT_IMG" "$AGENT_ZST"

# Calculate needed size
ACTUAL_KB=$(du -sk "$AGENT_CONTENT" | awk '{print $1}')
NEEDED_MB=$(( (ACTUAL_KB + 1024) / 1024 + 2 ))
if [ "$NEEDED_MB" -gt "$AGENT_IMG_SIZE_MB" ]; then
    log "Content is ~${NEEDED_MB}MB, adjusting image size from ${AGENT_IMG_SIZE_MB}MB"
    AGENT_IMG_SIZE_MB="$NEEDED_MB"
fi

if [ "$USE_RAW_IMAGE" = true ]; then
    # Raw tar image: simple tar of the content directory
    log "Creating raw tar image (${AGENT_IMG_SIZE_MB}MB)..."
    tar cf "$AGENT_IMG" -C "$AGENT_CONTENT" .
else
    # Filesystem-based image (Linux only — requires mkfs.exfat or mkfs.fat)
    log "Creating ${IMAGE_FS} image (${AGENT_IMG_SIZE_MB}MB)..."

    # Create blank image
    dd if=/dev/zero of="$AGENT_IMG" bs=1M count="$AGENT_IMG_SIZE_MB" 2>/dev/null

    # Format the image
    case "$IMAGE_FS" in
        exfat)
            mkfs.exfat "$AGENT_IMG"
            ;;
        fat32)
            if command -v newfs_msdos &>/dev/null; then
                newfs_msdos -F 32 "$AGENT_IMG"
            else
                mkfs.fat -F 32 "$AGENT_IMG"
            fi
            ;;
    esac

    # Mount, copy files, unmount (Linux only)
    MOUNT_POINT="$BUILD_DIR/agent-mount"
    rm -rf "$MOUNT_POINT"
    mkdir -p "$MOUNT_POINT"
    mount -o loop "$AGENT_IMG" "$MOUNT_POINT"
    cp "$AGENT_CONTENT"/* "$MOUNT_POINT/"
    umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"
fi

AGENT_IMG_SIZE=$(stat -f%z "$AGENT_IMG" 2>/dev/null || stat -c%s "$AGENT_IMG" 2>/dev/null)
log "agent.img: $(human_size "$AGENT_IMG_SIZE")"

# ─── Phase 5: Compress with zstd ───
log "=== Phase 5: Compressing with zstd (level ${ZSTD_COMPRESSION}) ==="

zstd "-${ZSTD_COMPRESSION}" --rm "$AGENT_IMG" -o "$AGENT_ZST"

AGENT_ZST_SIZE=$(stat -f%z "$AGENT_ZST" 2>/dev/null || stat -c%s "$AGENT_ZST" 2>/dev/null)
log "agent.img.zst: $(human_size "$AGENT_ZST_SIZE")"

# ─── Phase 6: Report ───
log "=== Phase 6: Build report ==="
echo ""
echo "=== Agent Image Build Complete ==="
echo ""
echo "Output files:"
echo "  agent.img.zst    : $(human_size "$AGENT_ZST_SIZE")  ($AGENT_ZST)"
echo "  Image format     : ${IMAGE_FS}"
echo ""
echo "Files included:"
for f in "$AGENT_CONTENT"/*; do
    file_size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null)
    echo "  $(basename "$f") : $(human_size "$file_size")"
done
echo ""
echo "AC-3A.3 target: agent.img.zst < 8MB"
if [ "$AGENT_ZST_SIZE" -lt 8388608 ]; then
    echo "  PASS: agent.img.zst is under 8MB"
else
    echo "  WARNING: agent.img.zst is over 8MB. Consider:"
    echo "    - Stripping debug symbols from sdk-daemon"
    echo "    - Reducing helper script sizes"
fi
echo ""

# Clean up intermediate files
rm -rf "$AGENT_CONTENT"

log "Done. agent.img.zst is ready at $AGENT_ZST"
