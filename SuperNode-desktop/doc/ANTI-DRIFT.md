# ANTI-DRIFT.md — PaperClip 桌面端防漂移约束

> **目的**: 注入到每个 Agent delegation prompt，防止实现偏离架构决策。
> **基准**: [paperclip-desktop-implementation-plan-v3.md](paperclip-desktop-implementation-plan-v3.md) + [CLAUDE.md](../../CLAUDE.md) §4 ADR
> **Sprint 0 验证日期**: 2026-06-11

---

## 1. 架构铁律（违反即 BLOCK）

| # | 约束 | 依据 | 验证方法 |
|---|------|------|---------|
| **ADR-01** | 不用 asar，纯文件目录分发 | PG 二进制无法从 asar 运行 | grep `asar` → 必须为 false/不出现 |
| **ADR-02** | Electron 壳极薄（main.cjs 只做 spawn + 窗口管理） | 借鉴 2 行 main.cjs | main process ≤ 500 行 |
| **ADR-03** | Daemon 全权管理 PG 生命周期 | `startServer()` 自管 embeddedPostgres | Electron 代码不得 import pg/embedded-postgres |
| **ADR-04** | 首次启动用 `paperclipai onboard -y` | 手工构造配置易出错 | 不手写 config.json 生成逻辑（除 onboard.ts 的 fallback） |
| **ADR-05** | `loadURL('http://localhost:3100')` | 复用 Express serve UI | 不用 file:// 协议 |
| **ADR-06** | 不加 Electron IPC 协议 | 已有 40+ REST routes | 不出现 `ipcMain` / `ipcRenderer` |
| **ADR-07** | Sidecar Unix Socket 仅用于进程间生命期信号 | 不承载业务数据 | socket 消息体不含 JSON payload |
| **ADR-08** | UI dist → `server/ui-dist/` | `app.ts` 自动探测 | bundle 脚本复制到 server/ui-dist/ |

---

## 2. 环境变量约束（最易出错，每次变更必查）

### 正确名称

| ✅ 正确 | ❌ 禁止 | 源码位置 |
|---------|---------|---------|
| `SERVE_UI=true` | ~~`PAPERCLIP_SERVE_UI`~~ | `server/src/config.ts:311` |
| `PAPERCLIP_HOME=~/.paperclip` | ~~指向 instance root~~ | `server/src/worktree-config.ts:134` |
| `PAPERCLIP_INSTANCE_ID=default` | — | `server/src/worktree-config.ts:130` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY=true` | — | `server/src/index.ts:119` |
| `PAPERCLIP_OPEN_ON_LISTEN=false` | ~~`PAPERCLIP_OPEN_BROWSER`~~ | `server/src/index.ts:869` |
| `DATABASE_URL` **不设** | ~~设了指向外部 PG~~ | `server/src/index.ts:302` |
| `PORT=3100` | ~~`PAPERCLIP_PORT`~~ | `server/src/config.ts` |

### 桌面端必须设置

```sh
PAPERCLIP_HOME=<homeDir>           # ~/.paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_MIGRATION_AUTO_APPLY=true
SERVE_UI=true                       # ⚠️ 不是 PAPERCLIP_SERVE_UI
PAPERCLIP_OPEN_ON_LISTEN=false      # 桌面端不打开浏览器
# DATABASE_URL 不设                  # 不设 → daemon 自启嵌入式 PG
```

---

## 3. Zod 配置字段对齐（onboard.ts 手动生成时）

### `paperclipConfigSchema` 字段清单（`packages/shared/src/config-schema.ts:106`）

| Zod 路径 | 正确值 | 常见错误 |
|----------|--------|---------|
| `$meta.version` | `1` (number, z.literal) | ~~`"schemaVersion"`~~, ~~`"1"`~~ |
| `$meta.updatedAt` | ISO string | ~~`"createdAt"`~~ |
| `$meta.source` | `"onboard"` (必需！) | 漏写导致 parse 失败 |
| `database.mode` | `"embedded-postgres"` | ~~`"embedded"`~~ |
| `database.embeddedPostgresDataDir` | 绝对路径 string | 相对路径 |
| `database.embeddedPostgresPort` | `54329` | ~~`5432`~~ |
| `server.deploymentMode` | `"local_trusted"` | — |
| `server.exposure` | `"private"` | ~~`"public"`~~（需配合 DATABASE_URL） |
| `server.serveUi` | `true` | — |
| `logging.mode` | `"file"` | — |
| `telemetry.enabled` | `false` (桌面端建议) | — |

### 验证命令

```js
import { paperclipConfigSchema } from "@paperclipai/shared/config-schema";
const result = paperclipConfigSchema.parse(config); // throws if invalid
```

---

## 4. 关闭流程约束（v3 增强版）

### 必须顺序（不可跳步）

```
1. 标记 shuttingDown = true (desktopFlag)
2. clearInterval(heartbeatInterval)
3. clearInterval(backupInterval)
4. while (databaseBackupInFlight) → wait (max 30s)
5. telemetryClient.stop() + flush()
6. appShutdown() → shutdownAppServices()
7. server.close() → 等待活跃连接断开
8. embeddedPostgres.stop()
9. process.exit(0)
```

### Electron 侧

```
1. POST /api/desktop/shutdown → 等待 200
2. daemon.kill("SIGTERM")
3. 等待 daemon exit (max 20s)
4. 超时 → daemon.kill("SIGKILL")
5. sidecarServer.close()
6. app.exit(0)
```

### 禁止

- ❌ 跳过 `server.close()` 直接 `process.exit()`
- ❌ 跳过 backup-in-flight 等待
- ❌ 不 clear intervals 直接退出
- ❌ Electron 不通知 daemon 直接杀进程

---

## 5. 启动时序约束

```
[t=0s]   main.cjs → import("./packaged-main.js")
[t=0.1s] ensureFirstRunConfig() → onboard 或跳过
[t=0.5s] spawn("node", ["server/dist/index.js"], { env })
           → startServer() → embeddedPostgres.start()
           → 迁移 → listen(3100)
[t=15s]  waitForServerReady() → /api/health 200
[t=16s]  BrowserWindow + loadURL + show
```

---

## 6. 打包约束

| 约束 | 原因 |
|------|------|
| 不使用 asar | PG 二进制无法从 asar 加载 |
| `pg_dump` 包含在 bundle | 备份需要（embedded-postgres bin/ 目录自带） |
| Plugins 目录必须存在 | 避免 daemon 日志报错（创建 `.gitkeep`） |
| Skills/Teams 目录包含 | Agent 执行需要 |
| `server/ui-dist/` 必须存在 | SPA serve 入口 |

---

## 7. 上游修改清单（需要提交 PaperClip PR）

| 文件 | 修改 | 优先级 |
|------|------|--------|
| `server/src/index.ts:766,846` | `setInterval()` → 赋值变量 + push `activeIntervals[]` | 🔴 桌面必需 |
| `server/src/index.ts:920-949` | 重写 shutdown handler（等待 backup + server.close + clearIntervals） | 🔴 桌面必需 |
| `server/src/app.ts` | 在 `api.use("/health", ...)` 附近注册 desktop router | 🔴 桌面必需 |
| `server/src/routes/desktop.ts` | 新增 `/api/desktop/status` + `/api/desktop/shutdown` | 🔴 桌面必需 |
| `packages/shared/src/config-schema.ts` | Tailscale 检测超时从 3s → 1s | 🟡 体验优化 |
| 硬编码插件目录 | `DEFAULT_LOCAL_PLUGIN_DIR` 不存在时不报 error | 🟡 体验优化 |

---

## 8. Sprint 0 已验证结果（2026-06-11）

| 验证项 | 结果 | 发现 |
|--------|------|------|
| 不设 DATABASE_URL 启动 | ✅ PASS | 嵌入式 PG 自动初始化，API 正常响应 |
| Zod 配置 schema 校验 | ✅ PASS | v3 配置对象全部字段对齐 `paperclipConfigSchema` |
| UI dist 路径探测 | ✅ PASS | `server/ui-dist/` → `app.ts` 正确检测 |
| Env var 名称一致性 | ✅ PASS | `SERVE_UI` 非 `PAPERCLIP_SERVE_UI`，全部正确 |
| SIGTERM graceful shutdown | ⚠️ BLOCKED | sqlite3 原生模块未编译（node-gyp + macOS 26 兼容性），需修复 node_modules |
| `@types/node` 缺失 | 🔴 发现 | `pnpm install --ignore-scripts` 跳过了 devDependencies，需 `pnpm add -D -w @types/node` |

---

## 9. 注入指令（复制到每个 Agent delegation prompt）

```
## ANTI-DRIFT Constraints（强制遵守）
Read SuperNode-desktop/doc/ANTI-DRIFT.md before writing any code.

1. ENV VAR NAMES: Use SERVE_UI (NOT PAPERCLIP_SERVE_UI),
   PAPERCLIP_OPEN_ON_LISTEN (NOT PAPERCLIP_OPEN_BROWSER),
   PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_MIGRATION_AUTO_APPLY.

2. DO NOT add Electron IPC (ipcMain/ipcRenderer). Use REST only.

3. DO NOT use asar packaging.

4. DO NOT let Electron touch PostgreSQL lifecycle. Daemon owns PG.

5. SHUTDOWN ORDER: signal → wait backup → server.close() → PG stop → exit.

6. CONFIG FIELDS: $meta.version=l (number), database.mode="embedded-postgres",
   server.deploymentMode="local_trusted", server.exposure="private".

7. If writing onboard.ts fallback config, run it through
   paperclipConfigSchema.parse() before saving.
```
