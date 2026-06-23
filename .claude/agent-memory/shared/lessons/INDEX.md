# Lessons Index

> Keyword → file mapping for orchestrator memory loading (Step 2a).
> Each project adds its own entries as stories complete.
>
> Format: `keyword1, keyword2 → filename.md — one-line summary`

## How to Add
After each story completes, append a line:
```
1to1, prototype, CSS, fidelity → story-001-example-2026-01-01.md — CSS class matching failure
```

## Current Lessons
<!-- Add entries below as stories complete -->

desktop, electron, shutdown, graceful-shutdown, express-router, anti-drift, env-vars, paperclip → story-sprint-1-core-shell-2026-06-11.md — Desktop API routes, server shutdown enhancement, Electron core shell, bundle script

tray, heartbeat, polling, notifications, electron-updater, window-state, login-item, auto-launch, diagnostics, packaging, electron-builder, icons, png, entitlements, sprite2 → story-sprint-2-desktop-experience-2026-06-11.md — Tray heartbeat polling, daemon status notifications, electron-updater, window state persistence, auto-launch, packaging infrastructure, programmatic icon generation

desktop, build, bundle, electron-builder, esbuild, path-resolution, daemon, lifecycle, port-detection, env-vars, onboarding, dependencies, native-binaries, package.json → story-desktop-build-fix-all-2026-06-12.md — Systematic 35-bug repair across 9 fix groups; path sync, daemon lifecycle, esbuild asset resolution, build scripts, resolveDaemonEntry, port detection, config fix, dependency cleanup, native binary verification

macos, native-chrome, electron, titlebar, hiddenInset, vibrancy, CSS, system-font, overlay-scrollbars, context-menu, preload, contextBridge, motion, animations, reduce-motion → story-001-macos-native-chrome-2026-06-12.md — Four-layer macOS native transformation: window chrome (hiddenInset+vibrancy), visual foundation (system font+rounded corners+overlay scrollbars+frosted glass), native context menu (preload bridge+Menu.buildFromTemplate), motion polish (CSS animations+spring sidebar+button feedback)

desktop, login, sidebar, auth-bridge, WebContentsView, mode-manager, parallel-startup, IPC, preload, contextBridge, CLI-scan, antigravity, React-component, worktree-isolation, sandbox → story-desktop-login-sidebar-cli-2026-06-22.md — Desktop login system + sidebar shell with WebContentsView, dual-mode parallel startup, Agent CLI setup page, worktree sandbox copy pattern

go, golang, vsock, guest-agent, sdk-daemon, cross-compile, arm64, wire-format, rpc, vm, aarch64, docker, alpine, rootfs, ext4, exfat, minio, openrc, zstd, qemu → story-phase3A-guest-agent-rootfs-2026-06-23.md — Go guest agent with vsock RPC (5 methods), Alpine rootfs Docker build scripts, QEMU verification harness, sandbox Go build workarounds

swift, virtualization, VZVirtualMachine, vm-manager, json-rpc, vsock-device, universal-binary, worktree-sync, cherry-pick, vitest-mock, net-socket-mock → story-phase3B-swift-vm-runtime-2026-06-23.md — Swift VM Manager CLI with VZVirtualMachine lifecycle, TypeScript VM platform abstraction layer (vm-bundle, vm-disk, vm-guest-rpc, health-check), integration tests with vitest mocking patterns, worktree sync via fetch + cherry-pick

migration, integration, docker-removal, agenthubs-mode, download-vm-image, vm-updater, dual-img-zst, manifest-download, zstd, sha256, minio, health-check, typecheck, vitest, worktree-conflict, stale-test-interface → story-phase3C-code-migration-integration-2026-06-23.md — Phase 3C code migration: agenthubs-mode Docker→VM platform rewrite, download-vm-image tar.gz→dual .img.zst manifest download, mode-manager/packaged-main containerRuntime removal, vm-updater adaptation, test suite with 25 passing tests, cherry-pick conflict resolution patterns, stale test interface lesson

delivery, degradation, sn-registration, sn-feed-client, websocket, setsecuritypolicy, token-injection, vm-download, offline-ui, sidebar-download-button, sideloader, stale-worktree, cherry-pick-revert, git-reset-sandbox, vitest-infra → story-phase3D-delivery-degradation-2026-06-23.md — Phase 3D delivery chain: SN registration via SetSecurityPolicy+SnFeedClient after VM boot, VM degradation UI with offline dot + Download button, stale worktree cherry-pick resolution, sandbox git-reset workaround

packaging, bundle-desktop, electron-builder, entitlements, virtualization, plist, extraResources, smoke-test, copyVmBundle, vm-runtime, agenthubs-vm, parallel-delegation, git-show-extraction, sandbox-tmpdir → story-phase3E-packaging-entitlements-2026-06-23.md — Phase 3E: copyVmBundle step in bundle-desktop.ts, electron-builder entitlements with com.apple.security.virtualization, smoke test script + packaging unit tests, parallel delegation pattern for non-overlapping file stories, git show file extraction pattern for agent worktree
