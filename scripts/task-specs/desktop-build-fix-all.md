# Task Spec: Desktop Build — 9-Fix-Group Systematic Repair

> **来源**: Workflow `desktop-build-bug-hunt` — 6 parallel codegraph agents → 3-skeptic adversarial verification → synthesized fix plan
> **日期**: 2026-06-12
> **严重性**: 🔴 2 CRITICAL + 🟠 5 BLOCKER + 🟡 28 MAJOR = 35 confirmed bugs
> **预期工时**: ~2 hours (9 fix groups, most are single-file edits)

---

## Intent

系统性修复桌面端构建系统全部 35 个已确认 bug。按依赖顺序执行 9 个 Fix Group，
每个 Group 修复一组关联文件，修复后通过 L1 (typecheck) + L2 (unit test) 验证。

## Requirements

1. 按 Fix Group A→I 顺序执行（A 是基础，必须在其他之前）
2. 每个 Group 完成后运行相关类型检查
3. 不可引入新 bug 或破坏现有功能
4. 遵循 PaperClip 工程规范（AGENTS.md, CLAUDE.md）
5. 每个 Group 的 commit message 格式: `fix(desktop): <group description>`

## Acceptance Criteria

- [ ] Fix Group A: `bundle-desktop.ts` 正确同步 `apps/desktop/` 和 `SuperNode-desktop/dist/`
- [ ] Fix Group A: CI workflow 从正确目录运行 electron-builder
- [ ] Fix Group A: `electron-builder.yml` afterPack 路径修正
- [ ] Fix Group A: `files` glob 移除无效排除
- [ ] Fix Group B: daemon 启动失败时不遗留孤儿进程
- [ ] Fix Group B: daemon 已死时 shutdown 不挂起 20s
- [ ] Fix Group B: before-quit handler 在 waitForServerReady 前注册
- [ ] Fix Group B: serverEnv 不继承全部 Electron 环境变量
- [ ] Fix Group C: `onboarding-assets` 在 bundle 中正确解析
- [ ] Fix Group C: teams-catalog 在 bundle 中可找到
- [ ] Fix Group C: skills-catalog 支持 env var + 被复制到 bundle
- [ ] Fix Group C: daemon 设置 `PAPERCLIP_TEAMS_CATALOG_DIR` 和 `PAPERCLIP_SKILLS_CATALOG_DIR`
- [ ] Fix Group D: `pnpm pack` 不冲突（重命名为 `electron:pack`）
- [ ] Fix Group D: `dist` script 先运行 bundle
- [ ] Fix Group D: esbuild 版本排序使用 semver 而非字母序
- [ ] Fix Group E: `resolveDaemonEntry` 候选路径正确
- [ ] Fix Group F: `findAvailablePort` 真正检测端口占用
- [ ] Fix Group G: config 解析 CWD 正确
- [ ] Fix Group H: 依赖版本匹配
- [ ] Fix Group I: `pmOnFail=error` 暴露原生模块构建失败

---

## Stories

### Story A: Build Pipeline Path Sync (Fix Group A, Fix Order 1)

**Stack**: backend-dev
**Files**:
- `SuperNode-desktop/scripts/desktop/bundle-desktop.ts`
- `.github/workflows/desktop.yml`
- `apps/desktop/electron-builder.yml`
- `SuperNode-desktop/electron-builder.yml`

**Description**:

这是最关键的修复——没有它，所有其他 daemon 修复都无法生效，因为正确的 daemon bundle（含 node_modules）从未被 electron-builder 打包。

**Bug 1 (CRITICAL)**: `pnpm deploy` 将 daemon 输出到 `SuperNode-desktop/dist/paperclip-server/`，
但 CI step `Package with electron-builder` 的 `working-directory: apps/desktop` 打包的是 `apps/desktop/` 目录。
两个目录之间没有任何同步——electron-builder 打包的是陈旧（或空）的 daemon bundle。

**Fix**: `bundle-desktop.ts` 在构建完成后，将 `SuperNode-desktop/dist/` 的完整内容复制到 `apps/desktop/` 对应位置。
具体：`fs.cpSync(path.join(distDir, 'paperclip-server'), path.join(APPS_DESKTOP, 'paperclip-server'), {recursive: true})` 和 `fs.cpSync(path.join(distDir, 'main'), path.join(APPS_DESKTOP, 'dist', 'main'), {recursive: true})` 等。

同时更新 `apps/desktop/electron-builder.yml`：
1. `files` glob 中移除 `!dist/paperclip-server/**`（paperclip-server 是 extraResources，不在 dist 内，排除无效）
2. `files` 添加 `"paperclip-server/**"` 确保 daemon bundle 被打包
3. `afterPack` 改为相对路径: `"../../SuperNode-desktop/scripts/desktop/fix-helper-plist.cjs"` → 但此路径从 `apps/desktop/` 运行时不对。正确做法是将 `fix-helper-plist.cjs` 复制到 `apps/desktop/scripts/` 或直接用 `"scripts/fix-helper-plist.cjs"`

**Bug 6 (BLOCKER)**: `SuperNode-desktop/electron-builder.yml` 中的 `afterPack` 路径是绝对路径 `/Users/Mayer/...`，且该文件是 `bundle-desktop.ts` 从 `apps/desktop/electron-builder.yml` 复制的派生文件。但 `SuperNode-desktop/electron-builder.yml` 被提交到源码控制，内容与源文件不同步。

**Fix**: 
- 从 `SuperNode-desktop/electron-builder.yml` 中删除 `afterPack` 中的绝对路径
- `bundle-desktop.ts` 复制 `electron-builder.yml` 后，修正 `afterPack` 路径使其相对于 `SuperNode-desktop/`

**Bug 7 (MAJOR)**: `!dist/paperclip-server/**` 排除 glob 无效——paperclip-server 不在 dist/ 内（它是 extraResources，在顶层）。

**Fix**: 从 `files` 中移除该排除行。如果需要排除 daemon bundle 不被打包到 `dist/`（因为它作为 extraResources 单独处理），则不需要此排除——paperclip-server 不在 dist/ 下。

**CI 修正**: `.github/workflows/desktop.yml` 中：
- Line 97: `pnpm pack` → `pnpm electron:pack`（匹配 Fix Group D 的重命名）
- 或者将 `working-directory` 改为 `SuperNode-desktop` 并使用那里的 electron-builder.yml

### Story B: Daemon Lifecycle Hardening (Fix Group B, Fix Order 2)

**Stack**: backend-dev
**Files**:
- `apps/desktop/src/main/packaged-main.ts`

**Description**:

修复进程管理 bug。

**Bug 2 (BLOCKER)**: Line 231-237: `app.quit()` 在启动失败时调用，但 `before-quit` handler 在 line 312 才注册。结果是 daemon 子进程成为孤儿进程——Electron 退出但 daemon 继续运行，占用端口 3100。

**Fix**: 
1. 在 `waitForServerReady` 调用之前注册 `before-quit` handler
2. 或者：在 `app.quit()` 之前手动 `daemon.kill('SIGTERM')`

**Bug 17 (MAJOR)**: Line 195: `daemon.kill('SIGTERM')` 在 shutdown 中调用。如果 daemon 已经 exit 了（例如崩溃），`daemon.kill` 不抛错但也不做任何事——然后 line 198 的 `daemon.on("exit", ...)` 永远不触发（exit 事件已经 fired），导致 20s 超时后才 force kill。

**Fix**: 
1. 添加 `daemonExited` flag，在 `daemon.on("exit", ...)` 中设置为 true
2. 在 shutdown 中检查 `daemonExited`，如果已退出则跳过 SIGTERM → 直接 resolve

**Bug 19 (MAJOR)**: Line 312-315: `before-quit` 的 `event.preventDefault()` + `void shutdown()` 不等待 shutdown 完成。如果 `serverPort` 未设置（daemon 从未成功启动），`fetch` 调用发往 `http://127.0.0.1:undefined/api/desktop/shutdown`，会 hang。

**Fix**: 
1. 将 `before-quit` handler 注册移到更早位置
2. 在 shutdown() 开头检查 `serverPort` 是否有效
3. `void shutdown()` → `shutdown().finally(() => app.exit(0))`

**Bug 15 (MAJOR)**: Line 128: `...process.env` 继承所有 Electron 环境变量。开发环境变量（如 `PAPERCLIP_UI_DEV_MIDDLEWARE`）可能泄漏到 daemon。

**Fix**: 只显式传递需要的环境变量，不展开 `...process.env`。或者至少排除已知危险的变量。

### Story C: esbuild Path Resolution for Bundled Assets (Fix Group C, Fix Order 3)

**Stack**: backend-dev
**Files**:
- `server/src/services/default-agent-instructions.ts`
- `server/src/services/skills-catalog.ts`
- `server/src/services/teams-catalog.ts`
- `apps/desktop/src/main/packaged-main.ts`
- `SuperNode-desktop/scripts/desktop/bundle-desktop.ts`

**Description**:

修复 esbuild CJS bundle 中 `import.meta.url` 替换导致的所有路径解析错误。

**Bug 3 (BLOCKER)**: `default-agent-instructions.ts:11`: `new URL('../onboarding-assets/${role}/${fileName}', import.meta.url)` 在 bundle 中解析错误。esbuild 的 `__IMU` banner 将 `import.meta.url` 替换为 bundle 文件路径 `dist/index.bundle.cjs`，所以 `../onboarding-assets/` 解析为 `dist/../onboarding-assets/` = bundle root 上一级 → ENONENT。

**Fix**: 
- 方案 A: 在 `bundle-desktop.ts` 中也将 `onboarding-assets/` 复制到 `bundledServer/onboarding-assets/`
- 方案 B: 使用多个候选路径（先尝试 `../onboarding-assets`，再尝试 `../../onboarding-assets`）

推荐方案 A（简单、确定性）。

**Bug 4 (BLOCKER) + Bug 5 (BLOCKER)**: skills-catalog 和 teams-catalog 在 bundle 中找不到。

**skills-catalog fix** (`server/src/services/skills-catalog.ts`):
1. 添加 `PAPERCLIP_SKILLS_CATALOG_DIR` 环境变量支持（matching teams-catalog 的 pattern）
2. `resolveCatalogPackageRoot()` 使用候选列表：env var → `../skills-catalog`（从 serviceDir）→ `../../skills-catalog`
3. `getCatalogManifest()` 使用 `statCatalogManifest()` pattern（循环候选而非直接 throw）

**teams-catalog fix** (`server/src/services/teams-catalog.ts`):
1. `buildCatalogPackageRootCandidates()` 添加 bundle 候选：`path.resolve(serviceDir, '../teams-catalog')`

**packaged-main.ts fix**:
1. 在 `serverEnv` 中设置 `PAPERCLIP_TEAMS_CATALOG_DIR` 和 `PAPERCLIP_SKILLS_CATALOG_DIR`，指向 bundled 位置
2. 值: `path.join(daemonEntryDir, 'teams-catalog')` 和 `path.join(daemonEntryDir, 'skills-catalog')`
   - 其中 `daemonEntryDir = path.dirname(resolveDaemonEntry())`

**bundle-desktop.ts fix**:
1. 复制 `packages/skills-catalog/catalog` 和 `packages/skills-catalog/generated` 到 `bundledServer/skills-catalog/`
   （匹配已有的 teams-catalog 复制逻辑 lines 548-558）
2. 复制 `server/src/services/onboarding-assets/` 到 `bundledServer/onboarding-assets/`

### Story D: Build Script Fixes (Fix Group D, Fix Order 4)

**Stack**: backend-dev
**Files**:
- `apps/desktop/package.json`
- `.github/workflows/desktop.yml`
- `SuperNode-desktop/scripts/desktop/bundle-desktop.ts`

**Description**:

修复构建脚本中的工具问题。

**Bug 8 (MAJOR)**: `pnpm pack` 调用 pnpm 内置 `pack` 命令（生成 tarball），而非 npm script `pack`（运行 electron-builder）。

**Fix**: 在 `apps/desktop/package.json` 中：
1. 重命名 `"pack": "electron-builder --config electron-builder.yml"` → `"electron:pack": "electron-builder --config electron-builder.yml"`
2. 更新 `"dist": "pnpm build && pnpm pack"` → `"dist": "pnpm build && pnpm electron:pack"`
3. 在 `desktop.yml` line 97 中：`pnpm pack --${{ matrix.arch }}` → `pnpm electron:pack --${{ matrix.arch }}`

**Bug 9 (MAJOR)**: `dist` script 不先运行 bundle。

**Fix**: `"dist": "pnpm build && pnpm electron:pack"` → `"dist": "pnpm build && pnpm bundle && pnpm electron:pack"`

**Bug 11 (MAJOR, esbuild version sort)**: `bundle-desktop.ts:337`: `candidates.sort()` 使用字母序。esbuild 目录名如 `esbuild@0.5.0` vs `esbuild@0.20.0`，字母序下 `0.5.0 > 0.20.0`。

**Fix**: 使用 semver 比较：
```typescript
candidates.sort((a, b) => {
  const va = a.match(/esbuild@(.+)$/)?.[1] ?? '0';
  const vb = b.match(/esbuild@(.+)$/)?.[1] ?? '0';
  // semver compare
  const pa = va.split('.').map(Number);
  const pb = vb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
});
```

**Bug 12 (MAJOR)**: `SuperNode-desktop/electron-builder.yml` 是派生文件（从 `apps/desktop/electron-builder.yml` 复制），但被提交到源码控制。如果被手动修改，下次构建会覆盖。

**Fix**: 将 `SuperNode-desktop/electron-builder.yml` 添加到 `.gitignore`。或者从源码中删除它（因为它是 `bundle-desktop.ts` 动态生成的）。

### Story E: resolveDaemonEntry Path Cleanup (Fix Group E, Fix Order 5)

**Stack**: backend-dev
**Files**:
- `apps/desktop/src/main/packaged-main.ts`

**Description**:

修复 `resolveDaemonEntry()` 中的路径候选。

**Bug 22 (MAJOR)**: Candidate 1 (line 88): `__dirname` 在打包后是 `Resources/app/dist/main/`，所以 `../../../paperclip-server/` → `Resources/paperclip-server/`。但 `extraResources` 将 `paperclip-server` 放到 `Resources/paperclip-server/`，所以这个路径是正确的。但 line 87 的注释说 4-up → OK。实际检查：`dist/main/` → `..` = `dist/` → `..` = `app/` → `..` = `Resources/`。然后 `paperclip-server/` → `Resources/paperclip-server/`。✅ 正确。

**Bug 23 (MAJOR)**: Candidate 4 (line 94): `../../paperclip-server/dist/index.js`。从 `dist/main/` → `..` = `dist/` → `..` = 应用根目录。`paperclip-server/` → 应用根目录/paperclip-server/。在打包后，应用根目录是 `Resources/app/`，所以是 `Resources/app/paperclip-server/`。但 paperclip-server 在 `Resources/paperclip-server/`（不在 app 内）。❌ 错误。

**Fix**: Candidate 4 在打包后永远不匹配。保留为 monorepo dev only。添加注释说明。

**Bug 24 (MAJOR)**: 同 Bug 23——candidate 4 使用陈旧的 `apps/desktop/paperclip-server` 路径。这个路径在 monorepo dev 中可能在 bundle-desktop 运行后存在（如果 `APPS_DESKTOP` 中有 paperclip-server symlink）。但如果它匹配，它会使用可能过期的 daemon。

**Fix**: 确保 candidate 4 仅在 monorepo dev 场景中匹配（添加注释，不在打包后检查）。

**Bug 21 (MAJOR)**: Candidate 4 在正确的 monorepo candidate 5 之前匹配。如果 `apps/desktop/paperclip-server/` 存在（可能来自之前的不完整构建），它会遮蔽正确的 `server/dist/index.js`。

**Fix**: 将 candidate 5（`../../../server/dist/index.js`）移到 candidate 4 之前。

**Bug 18 (MAJOR)**: Line 28-29: `DESKTOP_VERSION` 使用 `path.resolve(__dirname, '..', '..', 'package.json')`（即 `../../package.json` 从 `dist/main/`）。在打包后，`__dirname` = `Resources/app/dist/main/`，`../../` = `Resources/app/`，查找 `Resources/app/package.json`。这个文件在 `bundle-desktop.ts` line 575 中被复制到 `dist/package.json`，所以路径应为 `../package.json`（从 `dist/main/` 上到 `dist/`）。

**Fix**: 使用 `app.getVersion()` 作为主方案，回退到 `path.resolve(__dirname, '..', 'package.json')`。

### Story F: Port Detection and Port Mismatch (Fix Group F, Fix Order 6)

**Stack**: backend-dev
**Files**:
- `apps/desktop/src/main/packaged-main.ts`

**Description**:

**Bug 20 (MAJOR)**: `findAvailablePort()` (lines 56-65) 是 TOCTOU no-op。它创建 server → listen → 立即 close → 返回 preferred。在 close() 和实际 daemon 启动之间，端口可能被占用。而且 `server.listen()` 和 `server.close()` 之间没有 await——端口从未真正绑定。

**Fix**: 简化 `findAvailablePort`：由于 daemon 自己使用 `detect-port`，让 daemon 选择端口。Electron 只需要知道使用哪个端口。方案：去掉 `findAvailablePort`，总是使用 `DEFAULT_SERVER_PORT`，如果 daemon 选择不同端口则从 daemon output 解析。或者直接传 `PORT=3100` 给 daemon（daemon 的 detect-port 会使用该端口如果可用）。

**Bug 16 (MAJOR)**: Line 132: `PORT: String(serverPort)` 总是 `"3100"`（因为 `findAvailablePort` 总是返回 preferred）。但 daemon 内部使用 `detect-port` 可能选择不同端口。Electron 轮询 `3100` 但 daemon 在 `3101` 监听 → 超时。

**Fix**: 由于 `findAvailablePort` 总是返回 3100，且 daemon 用 `detect-port`，两个可能不同。修复方案：设置 `PORT=3100` 并确保 daemon 使用该端口。如果 daemon 的 `detect-port` 发现 3100 被占用，让它失败向 Electron 报告，而非静默使用不同端口。实际上 PORT 环境变量已经被设置，daemon 应该遵守——确认 daemon 的 detect-port 逻辑会使用 PORT 环境变量。

### Story G: Config and Onboarding (Fix Group G, Fix Order 7)

**Stack**: backend-dev
**Files**:
- `apps/desktop/src/main/onboard.ts`
- `apps/desktop/src/main/packaged-main.ts`

**Description**:

**Bug 14 (MAJOR)**: `onboard.ts:31`: 30s timeout for `npx paperclipai onboard`。首次启动时下载 npx 包可能很慢。

**Fix**: 将 timeout 从 30000 增加到 60000，或添加重试逻辑。

**Bug 25 (MAJOR)**: `server/src/config.ts:294`: `findConfigFileFromAncestors` 从错误的 CWD 遍历。在 packaged app 中，CWD 可能是 `Resources/app/` 或用户 home 目录，可能捡到错误祖先目录中的 `.paperclip/config.json`。

**Note**: 这需要追踪 `config.ts` 中的 config 解析逻辑。如果 daemon CWD 正确设置为 PAPERCLIP_HOME 相关目录，此问题自然解决。在 packaged-main.ts 中设置 daemon 的 `cwd` 选项。

### Story H: Dependency Version Cleanup (Fix Group H, Fix Order 8)

**Stack**: backend-dev
**Files**:
- `apps/desktop/package.json`

**Description**:

**Bug 10 (MAJOR)**: `embedded-postgres` 声明在 `apps/desktop/dependencies` 中，但它只被 daemon 使用（通过 pnpm deploy 获得独立副本）。Electron 主进程不需要它。检查是否应移到 `devDependencies` 或完全移除（因为 pnpm deploy 独立管理 daemon 依赖）。

**Bug 11 (MAJOR)**: `electron-updater ^6.3.9` 可能与 `electron-builder@25.1.8` 不完全兼容。验证版本兼容性。

**Bug 12 (MAJOR)**: `embedded-postgres 18.1.0-beta.16` vs root workspace 中的 `18.1.0-beta.15`。版本不一致可能导致 patch 目标错误。

**Fix**: 
1. 从 `apps/desktop/dependencies` 中移除 `embedded-postgres`（仅 daemon 使用）
2. 验证 `electron-updater` 版本与 `electron-builder@25.1.8` 兼容
3. 统一 `embedded-postgres` 版本

### Story I: pnpm pmOnFail Risk (Fix Group I, Fix Order 9)

**Stack**: backend-dev
**Files**:
- `.npmrc`
- `SuperNode-desktop/scripts/desktop/bundle-desktop.ts`

**Description**:

**Bug 13 (MAJOR)**: `.npmrc` 中 `pmOnFail=ignore` 隐藏 `pnpm deploy` 期间原生模块构建失败。如果 `embedded-postgres` 或 `sharp` 的二进制下载/构建失败，构建继续但 daemon 运行时崩溃。

**Fix**: 将 `.npmrc` 中的 `pmOnFail=ignore` 改为仅对 monorepo install 生效，或完全移除。在 `bundle-desktop.ts` 中添加 post-deploy 检查：验证关键原生二进制存在。

---

## Required Skills

| Story | Skills |
|-------|--------|
| A | backend-dev, tester |
| B | backend-dev, tester |
| C | backend-dev, tester |
| D | backend-dev, tester |
| E | backend-dev, tester |
| F | backend-dev, tester |
| G | backend-dev, tester |
| H | backend-dev, tester |
| I | backend-dev, tester |

---

## Anti-Drift Constraints

1. 每个 Story 执行前必须先 Read 要修改的文件（文件可能已被其他 Story 修改）
2. 修改后立即运行 `pnpm typecheck` 验证（在 `apps/desktop/` 目录）
3. 路径引用使用 `path.resolve` / `path.join`，不要硬编码字符串
4. 不要引入新的 TODO/FIXME/HACK
5. 每个 Story 完成后独立 commit
6. 如果 Story 中描述的问题是已经在代码中修复的（例如已有正确的代码），标记为 "ALREADY FIXED" 并跳过
