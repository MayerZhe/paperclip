# Lessons Learned: Phase 3A — Guest Agent + rootfs 构建 — 2026-06-23

## Success Patterns

### 1. Go cross-compilation with sandbox-aware cache paths
**Pattern**: Go build in sandbox requires explicit `GOCACHE` and `GOMODCACHE` pointing to sandbox-writable paths. Set `GOCACHE=$TMPDIR/go-cache GOMODCACHE=/Users/Mayer/go/pkg/mod` for build commands.
**Why it worked**: Go's default cache directory (`~/Library/Caches/go-build`) is outside the sandbox write allow list. Redirecting to TMPDIR solves it. GOMODCACHE pointing to pre-populated user mod cache avoids network downloads.
**How to apply**: All Go build/test commands in sandbox must use these env vars.

### 2. Worktree agent output requires explicit sync to main worktree
**Pattern**: Agent worktrees are isolated from the main worktree. After agent completion, files must be explicitly copied with `cp -r` from agent worktree to main worktree before commit.
**Why it worked**: This is a recurring pattern (previously documented in story-desktop-login-sidebar-cli-2026-06-22.md). The agent can commit/push but the main worktree doesn't automatically receive those changes.
**How to apply**: After every agent completes, check `ls` in main worktree first. If files missing, find agent worktree path from the agent result message and `cp -r` them.

### 3. Building .img files requires Docker runtime — test scripts should validate without it
**Pattern**: The rootfs.img.zst and agent.img.zst cannot be built in a CI/sandbox environment without Docker. Verification scripts (S-3A3) should validate everything that CAN be checked without Docker: binary file type, JSON config validity, script syntax, existence checks — and report clear FAIL/WARN for Docker-dependent checks.
**Why it worked**: verify-files.sh provides 7-step validation with clear PASS/FAIL/WARN separation, enabling partial AC verification even when Docker is unavailable.

## Failure Patterns

### 1. Go module download blocked by sandbox network policy
**Problem**: `go build` tried to download `golang.org/x/sys@v0.42.0` from proxy.golang.org, which is blocked by the sandbox network policy (Forbidden).
**Root cause**: The sandbox only allows connections to `127.0.0.1` and `api.anthropic.com`. Go module proxy is outside the allow list.
**Fix**: Point GOMODCACHE to the user's pre-populated Go module cache (`/Users/Mayer/go/pkg/mod`), which already had `golang.org/x/sys@v0.42.0` cached.
**Lesson**: Always check sandbox network allow list before builds that download dependencies. Pre-install or pre-cache any needed modules.

### 2. Go 1.25.0 toolchain requirement for x/sys@v0.42.0
**Problem**: The agent set `go 1.25.0` in go.mod with `toolchain go1.26.3` because the locally cached `golang.org/x/sys@v0.42.0` requires it. This is higher than the Spec's "Go 1.22+" minimum.
**Root cause**: The agent used the latest cached version of x/sys rather than pinning to a version compatible with Go 1.22.
**Lesson**: For Go projects, verify go.mod's `go` directive is compatible with the minimum Go version in the spec. Pin external dependencies to versions that match.

## Key Decisions

1. **vsock via `golang.org/x/sys/unix` instead of `github.com/mdlayher/vsock`** — The latter couldn't be downloaded due to sandbox network restrictions. `x/sys/unix` was cached locally and provides equivalent AF_VSOCK support via raw syscalls.
2. **Build-tag separated listener files** — `listener_linux.go` (real AF_VSOCK) vs `listener_stub.go` (returns error on non-Linux) enables cross-platform development and testing on macOS.
3. **Mock `io.ReadWriteCloser` connections for server tests** — Eliminates need for real vsock in unit tests, enabling full handler coverage on any platform.
4. **Dockerfile and build scripts designed for external execution** — Scripts use `set -euo pipefail`, explicit error messages, and graceful handling of missing source directories (warn but don't fail). This makes them usable in diverse environments.
5. **bin/sdk-daemon excluded from git tracking** — Added `.gitignore` with `bin/` pattern. The binary is a build artifact; only source code is committed.

## Risks to Monitor

1. **rootfs.img.zst and agent.img.zst sizes unverified** — Cannot build them in the current sandbox (no Docker). Need a follow-up manual build on a machine with Docker to verify AC-3A.2 (<20MB) and AC-3A.3 (<8MB).
2. **QEMU boot time unverified** — AC-3A.8 (<30s) requires actual QEMU with kernel Image and built .img files. test-qemu.sh is designed for this but untested end-to-end.
3. **Go 1.25/1.26 toolchain** — Higher than typical enterprise Go versions. May need downgrade if CI uses older Go. Tested working with local Go installation.
4. **AF_VSOCK on macOS** — The listener_stub.go returns an error on macOS. This is by design (VM guest only runs on Linux), but means the full daemon can't be integration-tested on macOS host without a VM.
