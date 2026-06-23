#!/bin/bash
# build-rootfs.sh — Build the Alpine rootfs image for AgentHubs VM
#
# Steps:
#   1. Validate build environment (Docker, source directories)
#   2. Create build context directory with all required files
#   3. Build Docker image
#   4. Export container filesystem as a tar
#   5. Create ext4 image from the tar
#   6. Compress with zstd -19
#   7. Report file sizes
#
# Usage:
#   ./build-rootfs.sh              # Build with default options
#   ./build-rootfs.sh --clean      # Clean build directory first
#   ./build-rootfs.sh --skip-docker # Skip Docker build (use existing rootfs.tar)
#   ROOTFS_SIZE_MB=512 ./build-rootfs.sh  # Override image size
#
# Environment variables:
#   ROOTFS_SIZE_MB     Size of the ext4 image in MB (default: 512)
#   ZSTD_COMPRESSION   zstd compression level (default: 19)
#   SKIP_DOCKER_BUILD  Set to 1 to skip Docker build step

set -euo pipefail

# ─── Configuration ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT_DIR="$SCRIPT_DIR/output"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-512}"
ZSTD_COMPRESSION="${ZSTD_COMPRESSION:-19}"
CLEAN_BUILD=false
SKIP_DOCKER=false

# ─── Parse arguments ───
for arg in "$@"; do
    case "$arg" in
        --clean)
            CLEAN_BUILD=true
            ;;
        --skip-docker)
            SKIP_DOCKER=true
            ;;
        --help|-h)
            echo "Usage: $0 [--clean] [--skip-docker]"
            echo ""
            echo "Options:"
            echo "  --clean         Remove build directory before starting"
            echo "  --skip-docker   Skip Docker build (use existing rootfs.tar)"
            echo ""
            echo "Environment:"
            echo "  ROOTFS_SIZE_MB     ext4 image size in MB (default: 512)"
            echo "  ZSTD_COMPRESSION   zstd compression level (default: 19)"
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $arg"
            echo "Usage: $0 [--clean] [--skip-docker]"
            exit 1
            ;;
    esac
done

# ─── Source paths ───
VM_GUEST_AGENT="$REPO_ROOT/apps/desktop/vm-guest-agent"
SDK_DAEMON_BIN="$VM_GUEST_AGENT/bin/sdk-daemon"
CLOUD_API_SRC="$REPO_ROOT/agenthubs/cloud-api"
PAPERCLIP_SRC="$REPO_ROOT/server"

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
        # Fallback for macOS (no numfmt)
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

check_cmd docker || {
    err "Docker is not installed or not in PATH"
    err "Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
    err "Or use OrbStack: https://orbstack.dev/"
    exit 1
}

# Verify Docker daemon is running
if ! docker info &>/dev/null; then
    err "Docker daemon is not running"
    err "Please start Docker Desktop or OrbStack and try again"
    exit 1
fi

check_cmd zstd || {
    err "zstd is not installed"
    err "Install with: brew install zstd"
    exit 1
}

# Detect Docker runtime
DOCKER_RUNTIME="docker"
if docker info 2>/dev/null | grep -qi orbstack; then
    DOCKER_RUNTIME="orbstack"
    log "Detected Docker runtime: OrbStack"
elif docker info 2>/dev/null | grep -qi "docker desktop"; then
    DOCKER_RUNTIME="docker-desktop"
    log "Detected Docker runtime: Docker Desktop"
fi

# Detect platform architecture
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    x86_64)  TARGET_ARCH="amd64" ;;
    aarch64|arm64) TARGET_ARCH="arm64" ;;
    *)
        err "Unsupported host architecture: $HOST_ARCH"
        err "Only x86_64 and aarch64 are supported"
        exit 1
        ;;
esac
log "Build architecture: $HOST_ARCH -> target $TARGET_ARCH"

# Check mke2fs (from e2fsprogs)
check_cmd mke2fs || {
    err "mke2fs is not installed"
    err "Install with: brew install e2fsprogs"
    exit 1
}

# ─── Phase 2: Source validation ───
log "=== Phase 2: Validating source paths ==="

# Check for sdk-daemon binary
if [ ! -f "$SDK_DAEMON_BIN" ]; then
    err "sdk-daemon binary not found at: $SDK_DAEMON_BIN"
    err ""
    err "Build it first:"
    err "  cd apps/desktop/vm-guest-agent && \\"
    err "    GOCACHE=\$TMPDIR/go-cache GOMODCACHE=/Users/\\$USER/go/pkg/mod \\"
    err "    GOOS=linux GOARCH=${TARGET_ARCH} CGO_ENABLED=0 \\"
    err "    go build -ldflags \"-s -w\" -o bin/sdk-daemon ./cmd/sdk-daemon/"
    exit 1
fi
SDK_DAEMON_SIZE=$(stat -f%z "$SDK_DAEMON_BIN" 2>/dev/null || stat -c%s "$SDK_DAEMON_BIN" 2>/dev/null)
log "sdk-daemon: $(human_size "$SDK_DAEMON_SIZE")"

# Check for cloud-api source
if [ ! -d "$CLOUD_API_SRC" ]; then
    echo ""
    echo "WARNING: cloud-api source not found at $CLOUD_API_SRC"
    echo "  The Docker build will fail without it."
    echo "  This directory should contain the agenthubs/cloud-api Node.js project."
    echo "  Create it or clone it before building."
    echo ""
    CLOUD_API_MISSING=true
else
    log "cloud-api: $CLOUD_API_SRC"
    CLOUD_API_MISSING=false
fi

# Check for paperclip server source
if [ ! -f "$PAPERCLIP_SRC/package.json" ]; then
    echo ""
    echo "WARNING: paperclip server not found at $PAPERCLIP_SRC"
    echo "  The Docker build will fail without it."
    echo "  This directory should contain the paperclip server."
    echo "  Run 'pnpm install' in the repo root first."
    echo ""
    PAPERCLIP_MISSING=true
else
    log "paperclip: $PAPERCLIP_SRC"
    PAPERCLIP_MISSING=false
fi

# Check for other required files
REQUIRED_FILES=(
    "$SCRIPT_DIR/Dockerfile"
    "$SCRIPT_DIR/sdk-daemon-config.json"
    "$SCRIPT_DIR/services/sdk-daemon"
    "$SCRIPT_DIR/services/cloud-api"
    "$SCRIPT_DIR/services/paperclip"
    "$SCRIPT_DIR/services/minio"
)
for f in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$f" ]; then
        err "Required file not found: $f"
        exit 1
    fi
done
log "All required build files present"

# ─── Phase 3: Prepare build context ───
log "=== Phase 3: Preparing build context ==="

if [ "$CLEAN_BUILD" = true ]; then
    log "Cleaning build directory: $BUILD_DIR"
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Copy Dockerfile and config
cp "$SCRIPT_DIR/Dockerfile" "$BUILD_DIR/Dockerfile"
cp "$SCRIPT_DIR/sdk-daemon-config.json" "$BUILD_DIR/sdk-daemon-config.json"

# Copy services
mkdir -p "$BUILD_DIR/services"
cp "$SCRIPT_DIR/services/"* "$BUILD_DIR/services/"

# Copy sdk-daemon binary
cp "$SDK_DAEMON_BIN" "$BUILD_DIR/sdk-daemon"
log "Copied sdk-daemon to build context"

# Copy cloud-api source (if available)
if [ "$CLOUD_API_MISSING" = false ]; then
    log "Copying cloud-api source..."
    # Use rsync if available (faster, excludes node_modules)
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='.git' --exclude='dist' \
            "$CLOUD_API_SRC/" "$BUILD_DIR/cloud-api/"
    else
        cp -R "$CLOUD_API_SRC" "$BUILD_DIR/cloud-api"
        rm -rf "$BUILD_DIR/cloud-api/node_modules" "$BUILD_DIR/cloud-api/.git" 2>/dev/null || true
    fi
    log "Copied cloud-api to build context"
fi

# Copy paperclip server source (if available)
if [ "$PAPERCLIP_MISSING" = false ]; then
    log "Copying paperclip server source..."
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='.git' --exclude='dist' \
            --exclude='ui-dist' --exclude='__tests__' --exclude='*.test.*' \
            "$PAPERCLIP_SRC/" "$BUILD_DIR/paperclip-server/"
    else
        cp -R "$PAPERCLIP_SRC" "$BUILD_DIR/paperclip-server"
        rm -rf "$BUILD_DIR/paperclip-server/node_modules" \
               "$BUILD_DIR/paperclip-server/.git" \
               "$BUILD_DIR/paperclip-server/dist" 2>/dev/null || true
    fi
    log "Copied paperclip server to build context"
fi

# ─── Phase 4: Docker build ───
log "=== Phase 4: Building Docker image ==="

if [ "$SKIP_DOCKER" = true ]; then
    log "Skipping Docker build (--skip-docker flag set)"
else
    # Check disk space for build context (need at least 500MB)
    AVAILABLE_KB=$(df "$BUILD_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$AVAILABLE_KB" ] && [ "$AVAILABLE_KB" -lt 512000 ]; then
        err "Low disk space: $(human_size $(( AVAILABLE_KB * 1024 ))) available, need at least 500MB"
        exit 1
    fi

    log "Building Docker image: agenthubs-rootfs"
    docker build \
        --platform "linux/${TARGET_ARCH}" \
        --build-arg "TARGETARCH=${TARGET_ARCH}" \
        -t agenthubs-rootfs \
        "$BUILD_DIR"
    log "Docker image built successfully"
fi

# ─── Phase 5: Export filesystem ───
log "=== Phase 5: Exporting container filesystem ==="

ROOTFS_TAR="$BUILD_DIR/rootfs.tar"
ROOTFS_IMG="$OUTPUT_DIR/rootfs.img"
ROOTFS_ZST="$OUTPUT_DIR/rootfs.img.zst"

if [ -f "$ROOTFS_TAR" ] && [ "$SKIP_DOCKER" = true ]; then
    log "Using existing rootfs.tar (--skip-docker)"
else
    log "Exporting container filesystem to $ROOTFS_TAR"
    CONTAINER_ID=$(docker create agenthubs-rootfs)
    docker export "$CONTAINER_ID" -o "$ROOTFS_TAR"
    docker rm "$CONTAINER_ID"
fi

ROOTFS_TAR_SIZE=$(stat -f%z "$ROOTFS_TAR" 2>/dev/null || stat -c%s "$ROOTFS_TAR" 2>/dev/null)
log "rootfs.tar: $(human_size "$ROOTFS_TAR_SIZE")"

# ─── Phase 6: Create ext4 image ───
log "=== Phase 6: Creating ext4 image ==="

# Remove existing image if present
rm -f "$ROOTFS_IMG"

# Extract tar to a temp directory, then use mke2fs -d to create the image
log "Extracting tar to temp directory..."
TEMP_ROOTFS="$BUILD_DIR/temp-rootfs"
rm -rf "$TEMP_ROOTFS"
mkdir -p "$TEMP_ROOTFS"
tar xf "$ROOTFS_TAR" -C "$TEMP_ROOTFS"

# Calculate actual needed size + 20% overhead
ACTUAL_KB=$(du -sk "$TEMP_ROOTFS" | awk '{print $1}')
NEEDED_MB=$(( (ACTUAL_KB + 1024) / 1024 + 20 ))  # KB -> MB with overhead
if [ "$NEEDED_MB" -gt "$ROOTFS_SIZE_MB" ]; then
    log "Rootfs content is ~${NEEDED_MB}MB, adjusting image size from ${ROOTFS_SIZE_MB}MB"
    ROOTFS_SIZE_MB="$NEEDED_MB"
fi

log "Creating ext4 image (${ROOTFS_SIZE_MB}MB): $ROOTFS_IMG"
mke2fs -t ext4 -d "$TEMP_ROOTFS" "$ROOTFS_IMG" "${ROOTFS_SIZE_MB}M" 2>&1 | tail -1

# Cleanup temp directory
rm -rf "$TEMP_ROOTFS"

ROOTFS_IMG_SIZE=$(stat -f%z "$ROOTFS_IMG" 2>/dev/null || stat -c%s "$ROOTFS_IMG" 2>/dev/null)
log "rootfs.img: $(human_size "$ROOTFS_IMG_SIZE")"

# ─── Phase 7: Compress with zstd ───
log "=== Phase 7: Compressing with zstd (level ${ZSTD_COMPRESSION}) ==="

rm -f "$ROOTFS_ZST"
zstd "-${ZSTD_COMPRESSION}" --rm "$ROOTFS_IMG" -o "$ROOTFS_ZST"

ROOTFS_ZST_SIZE=$(stat -f%z "$ROOTFS_ZST" 2>/dev/null || stat -c%s "$ROOTFS_ZST" 2>/dev/null)
log "rootfs.img.zst: $(human_size "$ROOTFS_ZST_SIZE")"

# ─── Phase 8: Report ───
log "=== Phase 8: Build report ==="
echo ""
echo "=== Build Complete ==="
echo ""
echo "Output files:"
echo "  rootfs.img.zst   : $(human_size "$ROOTFS_ZST_SIZE")  ($OUTPUT_DIR/rootfs.img.zst)"
echo ""
echo "Intermediate files (in build/):"
echo "  rootfs.tar       : $(human_size "$ROOTFS_TAR_SIZE")"
echo ""
echo "AC-3A.2 target: rootfs.img.zst < 20MB"
if [ "$ROOTFS_ZST_SIZE" -lt 20971520 ]; then
    echo "  PASS: rootfs.img.zst is under 20MB"
else
    echo "  WARNING: rootfs.img.zst is over 20MB. Consider:"
    echo "    - Removing unnecessary APK packages"
    echo "    - Using --exclude patterns to skip test files"
    echo "    - Increasing zstd compression level"
fi
echo ""

# Clean up tar if build was successful (optional, keep for debugging)
# rm -f "$ROOTFS_TAR"

log "Done. rootfs.img.zst is ready at $ROOTFS_ZST"
