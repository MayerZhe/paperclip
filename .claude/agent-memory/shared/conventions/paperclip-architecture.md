---
name: paperclip-architecture
description: PaperClip monorepo architecture rules — contract sync, company-scoping, control-plane invariants
metadata:
  type: convention
  shared: true
---

# PaperClip Architecture Conventions

## 1. Monorepo Package Boundaries

```
server/          → Express REST API + orchestration services
ui/              → React + Vite board UI (Tailwind + shadcn/ui)
packages/db/     → Drizzle ORM schema, migrations, DB clients
packages/shared/ → Zod schemas, TypeScript types, API path constants, validators
packages/adapters/ → Agent adapter implementations (one per CLI)
packages/adapter-utils/ → Shared adapter helpers
packages/plugins/ → Plugin system + sandbox providers
skills/          → Agent skill catalog (top-level, NOT packages/skills-catalog/catalog/)
cli/             → tsx-driven CLI entry point
```

## 2. Contract Synchronization (CRITICAL)

When changing schema/API behavior, update ALL four layers:

```
packages/db/     → schema/*.ts → drizzle.config.ts → generate migration
packages/shared/ → types, constants, validators
server/          → routes, services
ui/              → API clients, pages
```

**Never skip a layer.** If `packages/shared` has a new type, `server` and `ui` MUST use it.

## 3. Company-Scoping Rule

Every domain entity MUST be scoped to a company. Company boundaries MUST be enforced in routes/services.

When adding endpoints:
- Apply company access checks
- Enforce actor permissions (board vs agent)
- Write activity log entries for mutations
- Return consistent HTTP errors (400/401/403/404/409/422/500)

## 4. Control-Plane Invariants (Never Break)

- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

## 5. API Conventions

- Base path: `/api`
- Board access = full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies
- API path constants in `packages/shared/src/api-paths.ts`

## 6. Database Change Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. Generate migration: `pnpm db:generate`
4. Validate: `pnpm -r typecheck`

Note: `drizzle.config.ts` reads compiled schema from `dist/schema/*.js` — `pnpm db:generate` compiles first.

## 7. Import Rules

- Use `workspace:*` for internal packages in package.json
- In TypeScript: import from package names, not relative paths across packages
- Server ↔ Shared: `import { ... } from "@paperclipai/shared"`
- UI ↔ Shared: `import { ... } from "@paperclipai/shared"`

Related: [[paperclip-desktop]], [[paperclip-env-vars]], [[git-commits]], [[quality-gates]]
