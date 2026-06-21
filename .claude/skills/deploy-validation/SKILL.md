---
name: deploy-validation
description: Pre-deployment configuration validation. Checks build output, deploy config (wrangler.toml, docker-compose), env templates, and CI/CD setup before merge.
---

## Overview

Deploy validation prevents the most common production failure mode: discovering that the build or deploy config is broken only after pushing. Thash.videos wasted 11 commits (2+ days) on Cloudflare Pages config trial-and-error that should have been caught pre-merge.

## Checklist

### Frontend (Cloudflare Pages / Vercel / Netlify)
- [ ] Build output directory exists (`out/`, `.next/`, `dist/`)
- [ ] `wrangler.toml` / `vercel.json` / `netlify.toml` present
- [ ] `compatibility_date` is valid (Cloudflare)
- [ ] `pages_build_output_dir` is set (Cloudflare)
- [ ] Build command matches what CI runs
- [ ] `NEXT_PUBLIC_*` env vars are documented and set

### Backend (Docker / VPS)
- [ ] `docker-compose.yml` or `docker/docker-compose.yml` present and valid
- [ ] `.env.example` lists all required env vars
- [ ] `.env.production.template` exists for production deploy
- [ ] No hardcoded secrets in config files
- [ ] Database migration directory exists and has files

### General
- [ ] `.gitignore` covers: `.env`, `*.db`, `node_modules/`, `.venv/`, build output
- [ ] CI workflow file exists (`.github/workflows/`)
- [ ] Pre-commit hooks are configured
- [ ] `scripts/deploy.sh` or equivalent deploy script exists

## Commands

```bash
# Frontend build check
ls <frontend-dir>/out/index.html 2>/dev/null || ls <frontend-dir>/.next/BUILD_ID 2>/dev/null || echo "MISSING: build output"

# wrangler.toml validation
test -f <frontend-dir>/wrangler.toml && grep -q "compatibility_date" <frontend-dir>/wrangler.toml || echo "MISSING: compatibility_date"
test -f <frontend-dir>/wrangler.toml && grep -q "pages_build_output_dir" <frontend-dir>/wrangler.toml || echo "WARN: pages_build_output_dir"

# Docker check
ls docker/docker-compose.yml 2>/dev/null || ls docker-compose.yml 2>/dev/null || echo "MISSING: docker-compose.yml"

# Env template check
test -f .env.example && echo "OK: .env.example" || echo "MISSING: .env.example"
test -f .env.production.template && echo "OK: .env.production.template" || echo "WARN: .env.production.template"

# CI check
ls .github/workflows/*.yml 2>/dev/null && echo "OK: CI workflows" || echo "WARN: No CI workflows"
```

## Rules

- Run BEFORE merging to main, not after pushing
- BLOCK merge on MISSING critical config (build output, .env.example, docker-compose)
- WARN on missing optional config (CI, .env.production.template)
- Never deploy without all BLOCK checks passing
