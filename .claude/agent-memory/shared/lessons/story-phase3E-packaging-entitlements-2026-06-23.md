# Lessons Learned: Phase 3E — Packaging + Entitlements + Smoke Tests — 2026-06-23

## Success Patterns

### 1. Parallel delegation of non-overlapping config stories works efficiently
**Pattern**: S-3E1 (bundle-desktop.ts), S-3E2 (electron-builder.yml + plist files), S-3E3 (test files) were delegated to 3 agents in parallel. Despite nominal dependencies, each story touched completely disjoint files — bundle script, build config, and test files — so they could run concurrently with zero merge conflicts.
**Why it worked**: S-3E1 only touched `SuperNode-desktop/scripts/desktop/bundle-desktop.ts`, S-3E2 only touched `apps/desktop/{electron-builder.yml, build/*.plist}`, S-3E3 only created new files in `scripts/desktop/` and `apps/desktop/src/__tests__/`. Zero file overlap = zero merge conflicts.
**How to apply**: Before parallel delegation, verify files touched do not overlap. Even if stories are logically sequenced, check for physical file independence.

### 2. Agent worktree extraction via git show is cleaner than cherry-pick for isolated files
**Pattern**: Instead of cherry-picking the entire agent commit (which includes the agent's worktree fork history for all repo files), we used `git show <commit>:<path>` to extract only the changed files, then applied them via `cp` to the main worktree.
**Why it worked**: Cherry-pick on agent worktrees that were forked from a full repo snapshot pulls in hundreds of file changes unrelated to the story. File-level extraction gives exactly the delta we need.
**How to apply**: After agent completion, first check `git diff --name-only HEAD~1..HEAD` in the agent worktree to identify changed files. Then `git show <commit>:<path> > <temp>` for each file. Apply to main worktree with `cp`.

### 3. Sandbox TMPDIR discovery is necessary for temp file operations
**Pattern**: `/tmp/` is read-only in sandbox, but `$TMPDIR` (which resolves to `/tmp/claude-501/`) is writable. Always use `$TMPDIR` for intermediate file extraction.
**Why it worked**: The sandbox write policy allows `/tmp/claude/` and `$TMPDIR` paths explicitly.
**How to apply**: Never use `/tmp/` directly. Always `echo $TMPDIR` first to find the writable temp directory.

### 4. Gradual verification: check file content before applying
**Pattern**: After extracting files from agent worktree, we verified each file with wc -l, grep for key terms, plutil -lint for XML, bash -n for shell, and tsc --noEmit for TypeScript BEFORE committing.
**Why it worked**: Catching errors at extraction time avoids bad commits. The S-3E1 agent's bundle-desktop.ts was 881 lines (original was 798, +83 lines for copyVmBundle), which matches the expected delta.
**How to apply**: Always verify extracted content before cp+commit. Don't trust agent output blindly.

## Failure Patterns

### 1. Agent worktree commits include the entire repo snapshot
**Problem**: `git diff --name-only HEAD~1..HEAD` in agent worktrees showed 100+ files because the agent's worktree contains the full repo checkout from fork time. Only 1-3 files were actual story changes.
**Root cause**: Agent isolation via worktree creates a full repo snapshot. The first agent commit inherits all files from the branch HEAD.
**Fix**: Filter to `git diff --name-only <parent-of-agent-commit>..<agent-commit>` and look for files not matching known snapshot patterns.
**Lesson**: Always cross-reference agent file list against expected story scope. Expect file list to include agent memory files + codegraph + doc files + the actual changes.

### 2. SuperNode-desktop/ has no tsconfig.json for standalone typechecking
**Problem**: Running `tsc --noEmit --project SuperNode-desktop/tsconfig.json` failed because there's no tsconfig in that directory. The bundle-desktop.ts is a standalone build script.
**Root cause**: The bundle-desktop.ts is meant to be run with `tsx`, not compiled as part of the monorepo project. It has its own path resolution and doesn't need a tsconfig.
**Fix**: Use `tsc --noEmit --target ES2022 --module nodenext --moduleResolution nodenext --strict --esModuleInterop <file>` to typecheck standalone scripts.
**How to apply**: For standalone TypeScript scripts outside the monorepo build system, use direct tsc invocation with explicit module flags rather than a tsconfig project.

## Key Decisions

1. **copyVmBundle uses WARN+skip for missing files** — VM images (.img.zst) come from Docker build, Swift binary from Xcode/Swift build. Neither is guaranteed present in development. Graceful degradation via WARN is appropriate.
2. **sdk-daemon is copied unconditionally** — The Go binary exists (ELF ARM64, 2.7MB, statically linked) and is produced by `make` without Docker. It's a reliable artifact unlike the Docker/Swift build outputs.
3. **entitlements.inherit.plist created as separate file** — Following electron-builder convention, child processes (daemon, Swift CLI, VM) inherit only the entitlements they need (virtualization) rather than the full set from the main app.
4. **Smoke test goes in scripts/desktop/ not SuperNode-desktop/scripts/** — This keeps the repo root's scripts/desktop/ as the authoritative location for build/test scripts, separate from SuperNode-desktop/ which is a build artifact directory.

## Risks to Monitor

1. **Swift binary not built** — `supernode-vm` from `apps/desktop/vm-runtime/swift/.build/apple/Products/Release/supernode-vm` requires Xcode + Swift toolchain on the build machine. CI must have Xcode installed.
2. **VM images not built** — `rootfs.img.zst` and `agent.img.zst` require Docker to build. CI must have Docker available. If Docker is unavailable, the bundle will be incomplete but not fail.
3. **vitest cannot run in apps/desktop/** — Pre-existing infrastructure issue (apps/desktop not in pnpm workspace). packaging.test.ts was written with vitest imports but may not run until this is resolved. The typecheck passes, which is a good first line of defense.
4. **entitlements only verified syntactically** — `plutil -lint` checks XML validity but cannot verify semantic correctness. `com.apple.security.virtualization` entitlement requires a provisioning profile with this capability — we've only verified it's declared, not that Apple will honor it.
