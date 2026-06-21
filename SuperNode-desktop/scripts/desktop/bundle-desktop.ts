// scripts/desktop/bundle-desktop.ts
// v6.0: pnpm deploy 驱动 — 用 pnpm 自身的依赖解析引擎替代手工 copyPkgWithDeps()。
//       消除所有 RC-1 ~ RC-11 类依赖遗漏问题（同 scope 跳过、多版本字母排序、
//       Worker 线程文件缺失、传递依赖遗漏等）。
//
// 核心变更：
//   - 移除 copyPkgWithDeps() + externalDeps 手工列表 + findPnpmEntry +
//     followDepDir + extractSemver + compareSemver（~120 行脆弱的手工依赖遍历）
//   - 使用 `pnpm deploy --legacy` 获得完整、正确的嵌套 node_modules
//     （pnpm 自身的依赖解析引擎保证零遗漏）

//   - esbuild external 列表简化为仅原生二进制 + Worker 线程包（~25 个，
//     且不再需要枚举传递依赖 — pnpm deploy 已包含它们）
//   - 使用 fs.cpSync({dereference:false}) 保留 pnpm 符号链接结构
//
// 流程：
//   1. Precheck: 验证必要构建产物存在
//   2. pnpm deploy → temp（pnpm 保证完整的 node_modules 树）
//   3. 复制 deploy 产物 → bundled server（dist/ + node_modules/）
//   4. esbuild bundle → 单个 CJS（仅 external 原生/Worker 包）
//   5. 复制 migrations（路径问题，非依赖问题）
//   6. 复制 UI dist, skills, teams, plugins
//   7. 复制 Electron 主进程 + 设置 electron-builder 配置
//   8. Post-bundle 验证

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ─── 路径常量 ────────────────────────────────────────────────────
// 脚本位于 paperclip-master/SuperNode-desktop/scripts/desktop/
const SCRIPT_DIR = path.resolve(import.meta.dirname ?? __dirname);
const ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const SUPER_DESKTOP = path.join(ROOT, "SuperNode-desktop");
const APPS_DESKTOP = path.join(ROOT, "apps", "desktop");

const desktopPkg = JSON.parse(
  fs.readFileSync(path.join(APPS_DESKTOP, "package.json"), "utf-8"),
);
const version = desktopPkg.version;

console.log(`[Bundle] PaperClip Desktop v${version}`);
console.log(`[Bundle] Root:    ${ROOT}`);
console.log(`[Bundle] Output:  ${SUPER_DESKTOP}/dist/`);

// ─── Precheck ────────────────────────────────────────────────────
const PRECHECK_REQUIRED: Array<{ p: string; label: string }> = [
  { p: path.join(ROOT, "server", "dist", "index.js"), label: "server/dist/index.js (run 'pnpm build' or 'pnpm dev' first)" },
  { p: path.join(APPS_DESKTOP, "dist", "main", "index.js"), label: "apps/desktop/dist/main/index.js (run 'cd apps/desktop && npx tsc' first)" },
  { p: path.join(ROOT, "ui", "dist", "index.html"), label: "ui/dist/index.html (run 'pnpm build' first)" },
];
let precheckOk = true;
for (const { p, label } of PRECHECK_REQUIRED) {
  if (!fs.existsSync(p)) {
    console.error(`[Bundle] ❌ Precheck FAIL: ${label}`);
    precheckOk = false;
  }
}
if (!precheckOk) {
  console.error("[Bundle] Build prerequisites missing. Aborting.");
  process.exit(1);
}
console.log("[Bundle] ✅ Precheck passed");

// ─── 工具函数 ────────────────────────────────────────────────────

/** 复制目录树（跟随符号链接）。用于 UI/skills 等不依赖 symlink 结构的资源。 */
function copyRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  let stat;
  try { stat = fs.lstatSync(src); } catch { return; }

  try {
    if (stat.isSymbolicLink()) {
      let realPath;
      try { realPath = fs.realpathSync(src); } catch { return; }
      const realStat = fs.statSync(realPath);
      if (realStat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(realPath)) {
          copyRecursive(path.join(realPath, entry), path.join(dest, entry));
        }
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(realPath, dest);
      }
    } else if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch (err: any) {
    if (err.code !== "EPERM" && err.code !== "EACCES") {
      console.log(`[Bundle] Skip: ${path.basename(src)} (${err.code})`);
    }
  }
}

// ─── 清理 ────────────────────────────────────────────────────────
const distDir = path.join(SUPER_DESKTOP, "dist");
const serverSymlink = path.join(SUPER_DESKTOP, "paperclip-server");
if (fs.existsSync(serverSymlink)) {
  try { fs.unlinkSync(serverSymlink); } catch { /* ignore */ }
}
if (fs.existsSync(distDir)) {
  console.log("[Bundle] Cleaning old dist/...");
  try {
    fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (e: any) {
    console.log(`[Bundle] rm failed (${e.code}), trying subdir-by-subdir...`);
    for (const entry of fs.readdirSync(distDir)) {
      try {
        fs.rmSync(path.join(distDir, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (e2: any) { console.log(`  skip: ${entry} (${e2.code})`); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// 1. pnpm deploy → bundledServer（DIRECT，无 temp copy）
//    直接 deploy 到目标目录，确保 node_modules 内 symlinks 引用
//    的是 bundle 内部的 .pnpm 虚拟 store（相对路径），而非外部 temp 目录。
//    这消除了 v6.0 的 symlink 断链 bug（temp dir 删除后所有 symlink 悬空）。
//    pnpm 的依赖解析引擎保证：
//    - 所有传递依赖都被包含
//    - 多版本冲突正确解决（非 flat node_modules）
//    - 原生二进制在已构建的前提下被包含
//    - 不再需要手工维护 externalDeps 列表
// ═══════════════════════════════════════════════════════════════════
const bundledServer = path.join(distDir, "paperclip-server");
fs.mkdirSync(bundledServer, { recursive: true });

console.log(`[Bundle] pnpm deploy --filter @paperclipai/server → ${bundledServer}`);
try {
  execSync(
    `pnpm deploy --filter @paperclipai/server --prod --legacy "${bundledServer}"`,
    { cwd: ROOT, stdio: "inherit", timeout: 300_000 },
  );
} catch (err: any) {
  console.error("[Bundle] ❌ pnpm deploy failed");
  console.error("[Bundle] Make sure pnpm >= 10 is installed and dependencies are built");
  process.exit(1);
}

// 验证 deploy 产出
if (!fs.existsSync(path.join(bundledServer, "dist", "index.js"))) {
  console.error("[Bundle] ❌ pnpm deploy did not produce dist/index.js — was the server built?");
  process.exit(1);
}
if (!fs.existsSync(path.join(bundledServer, "node_modules"))) {
  console.error("[Bundle] ❌ pnpm deploy did not produce node_modules");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// 2. 清理生产构建中不需要的文件
//    .d.ts (TypeScript 声明) + .js.map (source maps) 不应出现在
//    .app bundle 中 — 膨胀体积且暴露源码路径信息。
//    需要清理两个位置：
//    (a) server/dist/ — tsc 产物包含 .d.ts + .js.map
//    (b) node_modules/.pnpm/ — 许多 npm 包同时发布 .js + .d.ts + .map
//    pnpm 的嵌套结构意味着实际文件在 .pnpm/ 中，顶层是 symlink。
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Stripping .d.ts and .js.map from bundle...");

function stripBuildArtifacts(dir: string, traversePnpm: boolean): { stripped: number; savedBytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    const queue = [dir];
    while (queue.length > 0) {
      const current = queue.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          // node_modules 顶层是 symlinks（指向 .pnpm/），跳过它们。
          // .pnpm/ 包含真实文件 — 仅在 traversePnpm=true 时进入。
          if (entry.name === "node_modules" && !traversePnpm) continue;
          if (entry.name === ".pnpm" && !traversePnpm) continue;
          queue.push(full);
        } else if (entry.isFile()) {
          if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".js.map") || entry.name.endsWith(".d.ts.map")) {
            try { bytes += fs.statSync(full).size; } catch { /* race */ }
            try { fs.unlinkSync(full); count++; } catch { /* race */ }
          }
        }
      }
    }
  } catch { /* best-effort */ }
  return { stripped: count, savedBytes: bytes };
}

// (a) 清理 server/dist/
const stripDist = stripBuildArtifacts(path.join(bundledServer, "dist"), false);
console.log(`  dist/: ${stripDist.stripped} files (${(stripDist.savedBytes / (1024 * 1024)).toFixed(1)} MB)`);

// (b) 清理 node_modules/.pnpm/（真实文件所在位置）
const stripNm = stripBuildArtifacts(path.join(bundledServer, "node_modules"), true);
console.log(`  node_modules/: ${stripNm.stripped} files (${(stripNm.savedBytes / (1024 * 1024)).toFixed(1)} MB)`);
console.log(`  Total stripped: ${stripDist.stripped + stripNm.stripped} files (${((stripDist.savedBytes + stripNm.savedBytes) / (1024 * 1024)).toFixed(1)} MB saved)`);


// 打印大小
const bundledDistSize = (() => {
  try {
    const result = execSync(`du -sh "${path.join(bundledServer, "dist")}"`, { encoding: "utf-8" });
    return result.split("\t")[0]?.trim() ?? "?";
  } catch { return "?"; }
})();
const bundledNmSize = (() => {
  try {
    const result = execSync(`du -sh "${path.join(bundledServer, "node_modules")}"`, { encoding: "utf-8" });
    return result.split("\t")[0]?.trim() ?? "?";
  } catch { return "?"; }
})();
console.log(`  dist/: ${bundledDistSize}`);
console.log(`  node_modules/: ${bundledNmSize}`);

	// ── esbuild config (used by steps 3 + 4) ──

const ESBUILD_EXTERNALS = [
  // Category A: 原生二进制（包含 Native Addon / .node 的顶层包）
  "embedded-postgres",
  "sharp",
  "better-sqlite3",
  "@cursor/sdk",
  "@electric-sql/pglite",
  "bufferutil",
  "utf-8-validate",
          // Category B: Worker 线程包（使用 new Worker(__dirname + path) → 需要真实文件路径）
          // 只有顶层包（pino/pino-pretty）需要 externalize。
          // 它们的纯 JS 子依赖（pino-std-serializers, thread-stream 等）
          // 由 esbuild 打包进 CJS bundle — 这些包没有 Worker 线程，且 external
          // 的 pino 仍能通过 .pnpm 嵌套 symlink 解析它们。
          "pino",
          "pino-pretty",
  // Category C: 动态 require / 平台特定
  // "jsdom" bundled (RC-14) — ESM deps resolved at build time by esbuild
  "ws",
  "supports-color",
  "lightningcss",
  "electron",
  "fsevents",
  "pg",
  // Category D: 可选原生依赖（运行时不存在也应优雅降级）
  "@aws-sdk/signature-v4-crt",
];
	// ═══════════════════════════════════════════════════════════════════
	// 3. Fix pnpm deploy --legacy top-level symlink gaps
	//    pnpm deploy only creates top-level node_modules/<pkg> symlinks
	//    for direct dependencies. Transitive deps of externalized packages
	//    only exist in .pnpm/ nesting — Node.js can't resolve require()
	//    from the CJS bundle. Create top-level symlinks for every external
	//    package that is missing one.
	// ═══════════════════════════════════════════════════════════════════
	console.log("[Bundle] Creating top-level symlinks for external packages...");
	let symlinksCreated = 0;
	const bundledNmDir = path.join(bundledServer, "node_modules");
	const pnpmStoreDir = path.join(bundledNmDir, ".pnpm");

	for (const pkg of ESBUILD_EXTERNALS) {
	  const topLevel = path.join(bundledNmDir, pkg);
	  if (fs.existsSync(topLevel)) continue; // already has top-level symlink

	  // Find in .pnpm store — e.g., "pino" → pino@9.14.0, "@cursor/sdk" → @cursor+sdk@1.0.18
	  const escaped = pkg.startsWith("@") ? pkg.replace("/", "+") : pkg;
	  try {
	    for (const entry of fs.readdirSync(pnpmStoreDir)) {
	      if (!entry.startsWith(escaped + "@")) continue;
	      const realPkg = path.join(pnpmStoreDir, entry, "node_modules", pkg);
	      if (!fs.existsSync(realPkg)) continue;

	      // Ensure parent directories exist (e.g., node_modules/@cursor/)
	      fs.mkdirSync(path.dirname(topLevel), { recursive: true });
	      fs.symlinkSync(path.relative(path.dirname(topLevel), realPkg), topLevel, "dir");
	      symlinksCreated++;
	      break;
	    }
	  } catch { /* best-effort */ }
	}
	console.log(`  Created ${symlinksCreated} symlinks`);



	// ═══════════════════════════════════════════════════════════════════
	// 4. esbuild daemon bundle
//
//    External 策略（v6.0 简化版）：
//    ┌─────────────────────────────────────────────────────────┐
//    │ Category A: 原生二进制（CANNOT bundle）                  │
//    │   embedded-postgres, sharp, better-sqlite3              │
//    │   @cursor/sdk, @electric-sql/pglite                     │
//    │   bufferutil, utf-8-validate                            │
//    │ Category B: Worker 线程包（需要真实文件路径）             │
//    │   pino, pino-std-serializers, pino-pretty               │
//    │   thread-stream, real-require, sonic-boom               │
//    │   on-exit-leak-free, atomic-sleep                       │
//    │ Category C: 动态 require / 平台特定                      │
//    │   jsdom, ws, supports-color, lightningcss               │
//    │   electron, fsevents, pg                                │
//    │ Category D: 可选原生依赖（不存在也不应失败）               │
//    │   @aws-sdk/signature-v4-crt                             │
//    └─────────────────────────────────────────────────────────┘
//    NOTE: 不再需要 externalize @embedded-postgres/darwin-arm64
//    等子包 — 父包 (embedded-postgres/sharp) 已 externalized，
//    Node.js 运行时负责解析其内部动态 require。
//    这些包在部署的 node_modules 中由 pnpm 提供完整依赖树。
//    所有其他 JS 依赖被打包进 bundle — 不需要在 external 列表中。
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] esbuild: bundling daemon into single CJS file...");
const daemonEntry = path.join(bundledServer, "dist", "index.js");
const daemonBundled = path.join(bundledServer, "dist", "index.bundle.cjs");

// 自适应查找 esbuild（不硬编码版本号）
const monoPnpm = path.join(ROOT, "node_modules", ".pnpm");
const esbuildBin = (() => {
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(monoPnpm)) {
    if (entry.startsWith("esbuild@")) {
      const bp = path.join(monoPnpm, entry, "node_modules", "esbuild", "bin", "esbuild");
      if (fs.existsSync(bp)) candidates.push(bp);
    }
  }
  if (candidates.length === 0) {
    throw new Error("esbuild not found in monorepo node_modules. Run `pnpm install` first.");
  }
  // Sort by semver, not lexicographic ("0.5.0" > "0.20.0" lexicographically but not semantically)
  candidates.sort((a, b) => {
    const va = a.match(/esbuild@(.+)$/)?.[1] ?? "0";
    const vb = b.match(/esbuild@(.+)$/)?.[1] ?? "0";
    const pa = va.split(".").map(Number);
    const pb = vb.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  });
  return candidates[candidates.length - 1];
})();
		// ═══════════════════════════════════════════════════════════════════
		// 3.5 Fix @exodus/bytes ESM→CJS interop (RC-14)
		//    External CJS packages (jsdom, html-encoding-sniffer, whatwg-url,
		//    whatwg-mimetype) require() @exodus/bytes entry points, but the
		//    package has "type": "module". Electron 33 bundles Node 20.18.0
		//    which cannot require() ESM files. Fix: pre-bundle the required
		//    entry points to CJS (.cjs), then add "require" conditions to
		//    the package.json exports field so CJS require() resolves to .cjs
		//    while ESM import continues to use the original .js files.
		// ═══════════════════════════════════════════════════════════════════
		console.log("[Bundle] Fixing @exodus/bytes ESM→CJS for Electron Node 20.18...");
		let exodusFixed = 0;
		for (const entry of fs.readdirSync(pnpmStoreDir)) {
		  if (!entry.startsWith("@exodus+bytes@")) continue;
		  const exodusDir = path.join(pnpmStoreDir, entry, "node_modules", "@exodus", "bytes");
		  if (!fs.existsSync(exodusDir)) continue;

		  // Entry points required by external CJS packages (verified via grep):
		  //   html-encoding-sniffer → encoding-lite.js
		  //   jsdom → encoding.js
		  //   whatwg-url → whatwg.js, encoding.js
		  //   whatwg-mimetype → encoding.js
		  const entryPoints = ["encoding-lite.js", "encoding.js", "whatwg.js"];
		  const pkgJsonPath = path.join(exodusDir, "package.json");
		  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

		  for (const ep of entryPoints) {
		    const src = path.join(exodusDir, ep);
		    const cjsFile = src.replace(/\.js$/, ".cjs");
		    if (!fs.existsSync(src)) continue;
		    try {
		      // Pre-bundle ESM → CJS
		      execSync(
		        `"${esbuildBin}" "${src}" --bundle --platform=node --format=cjs ` +
		        `--external:@noble/hashes --outfile="${cjsFile}"`,
		        { stdio: "pipe", timeout: 30_000 },
		      );
		      // Delete the original ESM .js file — replaced by .cjs
		      fs.unlinkSync(src);
		      // Patch exports field: add "require" condition → .cjs
		      const exportKey = `./${ep}`;
		      if (pkgJson.exports?.[exportKey]) {
		        pkgJson.exports[exportKey] = {
		          types: pkgJson.exports[exportKey].types || `./${ep.replace(".js", ".d.ts")}`,
		          require: `./${path.basename(cjsFile)}`,
		          default: `./${path.basename(cjsFile)}`,
		        };
		      }
		      exodusFixed++;
		    } catch (err: any) {
		      console.warn(`  ⚠️  Failed to bundle @exodus/bytes/${ep}: ${err.message}`);
		    }
		  }

		  // Write updated package.json (keep "type": "module" intact)
		  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
		  console.log(`  Patched @exodus/bytes exports: ${entryPoints.length} entry points`);

		  break;
		}
		// Create top-level symlink for @exodus/bytes
		const exodusTop = path.join(bundledNmDir, "@exodus", "bytes");
		if (!fs.existsSync(exodusTop)) {
		  for (const entry of fs.readdirSync(pnpmStoreDir)) {
		    if (!entry.startsWith("@exodus+bytes@")) continue;
		    const realPkg = path.join(pnpmStoreDir, entry, "node_modules", "@exodus", "bytes");
		    if (!fs.existsSync(realPkg)) continue;
		    fs.mkdirSync(path.dirname(exodusTop), { recursive: true });
		    fs.symlinkSync(path.relative(path.dirname(exodusTop), realPkg), exodusTop, "dir");
		    symlinksCreated++;
		    break;
		  }
		}
		console.log(`  @exodus/bytes: ${exodusFixed} entry points converted to CJS`);


// esbuild external 列表 — 仅包含无法/不应打包的包
// NOTE: esbuild --external 不支持 glob pattern（如 `@img/*`）。
// 不需要 externalize `@embedded-postgres/darwin-arm64` 等子包 —
// 它们的 import 发生在 `embedded-postgres` / `sharp` 内部，
// 而父包已经 externalized，Node.js 运行时解析会处理子包。

const externalFlags = ESBUILD_EXTERNALS.map((e) => `--external:${e}`).join(" ");

console.log(`  esbuild: ${esbuildBin}`);
console.log(`  externals: ${ESBUILD_EXTERNALS.length} packages`);

execSync(
  `"${esbuildBin}" "${daemonEntry}" ` +
  `--bundle --platform=node --format=cjs --outfile="${daemonBundled}" ` +
  // CJS 格式下 import.meta.url 需要通过运行时 __filename 模拟
  `--banner:js="var __IMU = require('url').pathToFileURL(__filename).href;" ` +
  `--define:import.meta.url=__IMU ` +
  // External 列表
  `${externalFlags}`,
  { cwd: bundledServer, stdio: "inherit", timeout: 120_000 },
);

if (!fs.existsSync(daemonBundled)) {
  console.error("[Bundle] esbuild daemon bundle FAILED — index.bundle.cjs not created");
  process.exit(1);
}

const bundleSize = (fs.statSync(daemonBundled).size / (1024 * 1024)).toFixed(1);
console.log(`  index.bundle.cjs: ${bundleSize} MB`);

// ═══════════════════════════════════════════════════════════════════
// 4. 复制 migrations — 独立于依赖解析的路径问题
//    MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url))
//    → 在 bundle 中解析为 <bundle_dir>/migrations/
//    → 需要将 packages/db/dist/migrations/ 复制到 dist/migrations/
// ═══════════════════════════════════════════════════════════════════
const dbMigrations = path.join(ROOT, "packages", "db", "dist", "migrations");
const bundledMigrations = path.join(bundledServer, "dist", "migrations");
if (fs.existsSync(dbMigrations)) {
  console.log("[Bundle] Copying DB migrations...");
  fs.cpSync(dbMigrations, bundledMigrations, { recursive: true, force: true });
  const migrationCount = fs.readdirSync(bundledMigrations).filter((f) => f.endsWith(".sql")).length;
  console.log(`  ${migrationCount} migration files → dist/migrations/`);
} else {
  console.warn("[Bundle] ⚠️ DB migrations not found — server may fail to start");
}

// ═══════════════════════════════════════════════════════════════════
	// ═══════════════════════════════════════════════════════════════════
	// 4.5 Copy jsdom runtime assets (RC-14)
	//    jsdom reads default-stylesheet.css at runtime via __dirname.
	//    Since jsdom is now bundled, we need the CSS file at the path
	//    that jsdom expects: <bundledServer>/browser/default-stylesheet.css
	// ═══════════════════════════════════════════════════════════════════
	console.log("[Bundle] Copying jsdom runtime assets...");
	// jsdom uses path.resolve(__dirname, "../../browser/...") from its source.
	// __dirname in bundle = dist/paperclip-server/dist/, so ../../browser = dist/browser/
	const browserDir = path.join(bundledServer, "..", "browser");
	fs.mkdirSync(browserDir, { recursive: true });
	// Find jsdom in monorepo .pnpm store
	const monoPnpmDir = path.join(ROOT, "node_modules", ".pnpm");
	let cssCopied = false;
	for (const entry of fs.readdirSync(monoPnpmDir)) {
	  if (!entry.startsWith("jsdom@")) continue;
	  const cssSrc = path.join(monoPnpmDir, entry, "node_modules", "jsdom", "lib", "jsdom", "browser", "default-stylesheet.css");
	  if (fs.existsSync(cssSrc)) {
	    fs.copyFileSync(cssSrc, path.join(browserDir, "default-stylesheet.css"));
	    console.log("  default-stylesheet.css -> browser/");
	    // Also copy xhr-sync-worker.js for jsdom XMLHttpRequest (require.resolve)
	    const workerSrc = path.join(monoPnpmDir, entry, "node_modules", "jsdom", "lib", "jsdom", "living", "xhr", "xhr-sync-worker.js");
	    if (fs.existsSync(workerSrc)) {
	      fs.copyFileSync(workerSrc, path.join(bundledServer, "dist", "xhr-sync-worker.js"));
	      console.log("  xhr-sync-worker.js -> dist/");
	    }
	    cssCopied = true;
	    break;
	  }
	}
	if (!cssCopied) {
	  console.warn("  default-stylesheet.css not found — jsdom styling may fail");
	}

// 5. sqlite3 stub — PaperClip 使用 PostgreSQL，不需要 sqlite3 原生模块
//    （某些传递依赖可能尝试 require('sqlite3')）
//    ⚠️ 重要：pnpm deploy 的 node_modules/sqlite3 是符号链接。
//    直接 fs.mkdirSync 会跟随 symlink 修改 .pnpm store。
//    必须先删除 symlink，再创建真实目录。
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Creating sqlite3 stub...");
const sqlite3Path = path.join(bundledServer, "node_modules", "sqlite3");

// 删除 pnpm 创建的 sqlite3 符号链接（跟随它写入会污染 .pnpm store）
try {
  const stat = fs.lstatSync(sqlite3Path);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(sqlite3Path);
  } else {
    fs.rmSync(sqlite3Path, { recursive: true, force: true });
  }
} catch { /* doesn't exist — fine */ }

// 创建真实目录 + stub 文件
const sqlite3LibDir = path.join(sqlite3Path, "lib");
fs.mkdirSync(sqlite3LibDir, { recursive: true });
fs.writeFileSync(path.join(sqlite3LibDir, "sqlite3.js"), [
  `// Stub: sqlite3 native binary not needed (PaperClip uses PostgreSQL)`,
  `module.exports = exports = {`,
  `  Database: function() { throw new Error("sqlite3 not available in PaperClip Desktop"); },`,
  `  Statement: function() {}, Backup: function() {},`,
  `  cached: { Database: function() { throw new Error("sqlite3 not available"); } },`,
  `  OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 3,`,
  `  verbose: function() { return function() {}; },`,
  `};`,
  ``,
].join("\n"));
fs.writeFileSync(path.join(sqlite3Path, "package.json"), JSON.stringify({
  name: "sqlite3", version: "5.1.7-stub", main: "lib/sqlite3.js",
}));
console.log("  sqlite3 → stub");

// ═══════════════════════════════════════════════════════════════════
// 6. 复制 UI dist
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying UI dist...");
copyRecursive(path.join(ROOT, "ui", "dist"), path.join(bundledServer, "ui-dist"));

// ═══════════════════════════════════════════════════════════════════
// 7. 复制 Skills
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying skills...");
copyRecursive(path.join(ROOT, "skills"), path.join(bundledServer, "skills"));

// ═══════════════════════════════════════════════════════════════════
// 8. 复制 Teams Catalog
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying teams catalog...");
const teamsCatalogDir = path.join(ROOT, "packages", "teams-catalog");
if (fs.existsSync(path.join(teamsCatalogDir, "catalog"))) {
  copyRecursive(path.join(teamsCatalogDir, "catalog"), path.join(bundledServer, "teams-catalog", "catalog"));
}
if (fs.existsSync(path.join(teamsCatalogDir, "generated"))) {
  copyRecursive(path.join(teamsCatalogDir, "generated"), path.join(bundledServer, "teams-catalog", "generated"));
}

// ═══════════════════════════════════════════════════════════════════
// 8b. 复制 Skills Catalog
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying skills catalog...");
const skillsCatalogDir = path.join(ROOT, "packages", "skills-catalog");
if (fs.existsSync(path.join(skillsCatalogDir, "catalog"))) {
  copyRecursive(path.join(skillsCatalogDir, "catalog"), path.join(bundledServer, "skills-catalog", "catalog"));
}
if (fs.existsSync(path.join(skillsCatalogDir, "generated"))) {
  copyRecursive(path.join(skillsCatalogDir, "generated"), path.join(bundledServer, "skills-catalog", "generated"));
}

// ═══════════════════════════════════════════════════════════════════
// 8c. 复制 Onboarding Assets（default-agent-instructions.ts 需要）
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying onboarding assets...");
const onboardingAssetsDir = path.join(ROOT, "server", "src", "onboarding-assets");
if (fs.existsSync(onboardingAssetsDir)) {
  copyRecursive(onboardingAssetsDir, path.join(bundledServer, "onboarding-assets"));
  console.log("  onboarding-assets → bundledServer/onboarding-assets/");
} else {
  console.warn("  ⚠️ onboarding-assets not found at", onboardingAssetsDir);
}

// ═══════════════════════════════════════════════════════════════════
// 9. Plugins 目录
// ═══════════════════════════════════════════════════════════════════
fs.mkdirSync(path.join(bundledServer, "plugins"), { recursive: true });
fs.writeFileSync(path.join(bundledServer, "plugins", ".gitkeep"), "");

// ═══════════════════════════════════════════════════════════════════
// 10. 复制 Electron 主进程
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Copying Electron main process...");
copyRecursive(path.join(APPS_DESKTOP, "dist", "main"), path.join(distDir, "main"));
copyRecursive(path.join(APPS_DESKTOP, "dist", "preload"), path.join(distDir, "preload"));
copyRecursive(path.join(APPS_DESKTOP, "dist", "shared"), path.join(distDir, "shared"));
fs.copyFileSync(
  path.join(APPS_DESKTOP, "package.json"),
  path.join(distDir, "package.json"),
);

// ═══════════════════════════════════════════════════════════════════
// 11. 复制资源 & 配置 electron-builder 工作目录
// ═══════════════════════════════════════════════════════════════════
copyRecursive(path.join(APPS_DESKTOP, "resources"), path.join(SUPER_DESKTOP, "resources"));
fs.copyFileSync(
  path.join(APPS_DESKTOP, "package.json"),
  path.join(SUPER_DESKTOP, "package.json"),
);

// extraResources 需要 paperclip-server 在工作目录顶层
const topLevelServer = path.join(SUPER_DESKTOP, "paperclip-server");
if (fs.existsSync(topLevelServer)) {
  try { fs.unlinkSync(topLevelServer); } catch { /* ignore */ }
}
fs.symlinkSync(path.join("dist", "paperclip-server"), topLevelServer, "dir");

// 复制 electron-builder.yml
const ebConfigPath = path.join(APPS_DESKTOP, "electron-builder.yml");
if (fs.existsSync(ebConfigPath)) {
  fs.copyFileSync(ebConfigPath, path.join(SUPER_DESKTOP, "electron-builder.yml"));
}

// ═══════════════════════════════════════════════════════════════════
// 12. Post-bundle 验证
// ═══════════════════════════════════════════════════════════════════
console.log("\n[Verify] Post-bundle checks:");

// 验证嵌入的 postgres 二进制是否存在（pnpm deploy 应已包含）
function findEmbeddedPostgresBinary(baseDir: string): string | null {
  const pnpmDir = path.join(baseDir, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  try {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (!entry.startsWith("@embedded-postgres+")) continue;
      // 递归查找名为 "postgres" 的可执行文件
      function find(dir: string, depth: number): string | null {
        if (depth > 6) return null;
        try {
          for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, child.name);
            if (child.isFile() && child.name === "postgres") return full;
            if (child.isDirectory() && !child.isSymbolicLink()) {
              const result = find(full, depth + 1);
              if (result) return result;
            }
          }
        } catch { /* skip unreadable dirs */ }
        return null;
      }
      return find(path.join(pnpmDir, entry), 0);
    }
  } catch { return null; }
  return null;
}

const pgBinary = findEmbeddedPostgresBinary(bundledServer);

const checks: Array<{ p: string; label: string; critical: boolean }> = [
  { p: path.join(distDir, "main", "index.js"), label: "Electron entry", critical: true },
  { p: path.join(distDir, "preload", "index.js"), label: "Preload script", critical: true },
  { p: path.join(distDir, "package.json"), label: "Electron package.json", critical: true },
  { p: path.join(bundledServer, "dist", "index.js"), label: "Daemon entry (ESM src)", critical: false },
  { p: daemonBundled, label: "Daemon entry (CJS bundle)", critical: true },
  { p: path.join(bundledServer, "dist", "migrations"), label: "DB migrations", critical: true },
  { p: path.join(bundledServer, "node_modules", "embedded-postgres"), label: "embedded-postgres (package)", critical: true },
  { p: pgBinary ?? "/nonexistent", label: "embedded-postgres (binary)", critical: true },
  { p: path.join(bundledServer, "node_modules", "sharp"), label: "sharp (package)", critical: true },
  { p: path.join(bundledServer, "ui-dist", "index.html"), label: "UI index.html", critical: true },
];

let allPass = true;
for (const { p, label, critical } of checks) {
  const ok = fs.existsSync(p);
  const status = ok ? "✅" : critical ? "❌" : "⚠️";
  if (!ok && critical) allPass = false;
  console.log(`[Verify] ${status} ${label}`);
}

// Native binary was verified in critical checks list above.
// If pgBinary is null, embedded-postgres native binary download failed during pnpm deploy.
// This typically means .npmrc pmOnFail=ignore masked a download failure.
if (!pgBinary) {
  console.log("[Verify] ⚠️ Embedded PG binary search returned null — native download may have failed");
  console.log("[Verify]    Check .npmrc: pmOnFail=ignore may be hiding the error.");
  console.log("[Verify]    Try running: pnpm deploy --filter @paperclipai/server --prod --legacy <dest>");
}

// 检查 bundle 中关键动态 require 的 external 是否正确
console.log("[Verify] Checking externalized packages in node_modules...");
const criticalExternals = ["pino", "thread-stream", "jsdom", "ws"];
const pnpmStoreCheck = path.join(bundledServer, "node_modules", ".pnpm");
for (const name of criticalExternals) {
  const topLevel = path.join(bundledServer, "node_modules", name);
  if (fs.existsSync(topLevel)) {
    console.log(`[Verify] ✅ ${name}`);
    continue;
  }
  // transitives not hoisted — check .pnpm store
  let foundInPnpm = false;
  try {
    for (const entry of fs.readdirSync(pnpmStoreCheck)) {
      if (entry.startsWith(`${name}@`)) { foundInPnpm = true; break; }
    }
  } catch { /* skip */ }
  console.log(`[Verify] ${foundInPnpm ? "✅" : "⚠️"} ${name}${foundInPnpm ? " (in .pnpm/)" : " not found — may cause runtime errors"}`);
}

if (!allPass) {
  console.error("\n❌ Critical files missing! Build INCOMPLETE.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// 13. Sync to apps/desktop/ — electron-builder runs from there
//    Without this step, the daemon bundle (paperclip-server with
//    node_modules) never reaches the packaged app.
// ═══════════════════════════════════════════════════════════════════
console.log("[Bundle] Syncing to apps/desktop/ for electron-builder...");

// Clean old sync artifacts in apps/desktop/
const appsDesktopPaperclipServer = path.join(APPS_DESKTOP, "paperclip-server");
if (fs.existsSync(appsDesktopPaperclipServer)) {
  fs.rmSync(appsDesktopPaperclipServer, { recursive: true, force: true });
}
const appsDesktopDist = path.join(APPS_DESKTOP, "dist");
// Don't remove apps/desktop/dist entirely — it contains TypeScript build output
// that was built before bundle. Only clean sub-paths we manage.
for (const sub of ["main", "preload", "shared", "package.json"]) {
  const p = path.join(appsDesktopDist, sub);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// Sync daemon bundle (with node_modules from pnpm deploy)
console.log("  paperclip-server → apps/desktop/paperclip-server");
fs.cpSync(bundledServer, appsDesktopPaperclipServer, {
  recursive: true,
  dereference: false,  // Preserve pnpm symlinks
  force: true,
});

// Sync Electron main/preload (from SuperNode-desktop/dist/)
console.log("  dist/main → apps/desktop/dist/main");
fs.cpSync(path.join(distDir, "main"), path.join(appsDesktopDist, "main"), { recursive: true, force: true });
console.log("  dist/preload → apps/desktop/dist/preload");
fs.cpSync(path.join(distDir, "preload"), path.join(appsDesktopDist, "preload"), { recursive: true, force: true });
if (fs.existsSync(path.join(distDir, "shared"))) {
  console.log("  dist/shared → apps/desktop/dist/shared");
  fs.cpSync(path.join(distDir, "shared"), path.join(appsDesktopDist, "shared"), { recursive: true, force: true });
}
// Also copy dist/package.json to apps/desktop/dist/ so DESKTOP_VERSION reads work
fs.copyFileSync(
  path.join(distDir, "package.json"),
  path.join(appsDesktopDist, "package.json"),
);

	// Sync browser/ assets (jsdom default-stylesheet.css RC-14 fix)
	// In the .app, __dirname = Resources/paperclip-server/dist/
	// jsdom does path.resolve(__dirname, "../../browser/") → Resources/browser/
	// So browser/ must be at top-level in apps/desktop/ (added as extraResource)
	const superBrowserDir = path.join(distDir, "browser");
	if (fs.existsSync(superBrowserDir)) {
	  const appsBrowserDir = path.join(APPS_DESKTOP, "browser");
	  if (fs.existsSync(appsBrowserDir)) {
	    fs.rmSync(appsBrowserDir, { recursive: true, force: true });
	  }
	  fs.cpSync(superBrowserDir, appsBrowserDir, { recursive: true, force: true });
	  console.log("  browser/ → apps/desktop/browser/ (extraResource)");
	}

	console.log("[Bundle] ✅ Synced to apps/desktop/");

// ═══════════════════════════════════════════════════════════════════
// 14. 摘要
// ═══════════════════════════════════════════════════════════════════
const totalSize = (() => {
  try {
    const result = execSync(`du -sh "${bundledServer}"`, { encoding: "utf-8" });
    return result.split("\t")[0]?.trim() ?? "?";
  } catch { return "?"; }
})();

console.log(`\n✅ Bundle complete!`);
console.log(`   Total bundle size: ${totalSize}`);
console.log(`   Next: cd ${SUPER_DESKTOP} && npx electron-builder --config electron-builder.yml --dir`);
