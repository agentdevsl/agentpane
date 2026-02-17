# Architecture Review: Project Structure

**Review Date:** 2026-02-17
**Reviewer:** reviewer-1
**Scope:** Root layout, directory organisation, build system, CI/CD pipeline, configuration management

---

## 1. Overview

AgentPane is a TypeScript monorepo-like project built on Bun + Vite + TanStack Router for the frontend and a Hono-based API backend. It combines a single-page application, an API server, an independent `agent-runner` binary for Docker sandboxes, and two publishable NPM packages (`@agentpane/cli-monitor`, `@agentpane/agent-sandbox-sdk`).

The project has grown organically from a starter template ("agent-dev-template") into a substantial product with ~120+ source files, multiple build targets, dual-database support (SQLite/Postgres), Docker containerisation, Kubernetes CRD support, and comprehensive spec documentation. While the core `src/` layout is well-structured, the root directory has accumulated artefacts and the monorepo is missing formal workspace wiring.

**Overall Assessment:** The structure is functional and demonstrates strong separation of concerns between frontend/backend/packages. However, several configuration inconsistencies, stale artefacts, and missing workspace plumbing should be addressed before scaling the team further.

---

## 2. Directory Organisation

### 2.1 Root Directory Layout

```
agentpane_nocode/
  .claude/                 # Claude Code AI configuration (CLAUDE.md, settings, commands, skills)
  .copilot/                # GitHub Copilot config
  .design-engineer/        # Design-engineer system prompt
  .devcontainer/           # Dev container configurations (base, claude-code, vscode-agent)
  .github/                 # CI workflows, dependabot, issue templates, prompts, agents
  .hashicorp/              # Vault Radar config
  .specify/                # Speckit memory/templates
  .tanstack/               # TanStack generated config (gitignored)
  .vscode/                 # VS Code settings
  .worktrees/              # Git worktrees for sandboxed agents (gitignored)
  agent-runner/            # Standalone Node.js package for Docker containers
  charts/                  # Helm chart for Kubernetes deployment
  data/                    # Runtime SQLite database (gitignored)
  dist/                    # Build output (gitignored)
  docker/                  # Dockerfiles, compose files, entrypoint
  docs/                    # Architecture documentation (streaming, durable streams)
  k8s/                     # Kubernetes manifests (CRDs, namespace, sandbox templates)
  node_modules/            # Dependencies
  packages/                # Internal packages (cli-monitor, agent-sandbox-sdk)
  public/                  # Static assets (favicons)
  scripts/                 # Dev/ops scripts (start-dev, migrations, k8s setup)
  specs/                   # Application specifications, feature specs, roadmap
  src/                     # Main application source
  tests/                   # Test suites (api, components, e2e, integration, factories, mocks)
```

**Strengths:**
- Clear separation between `src/` (app code), `tests/` (test code), `packages/` (publishable libraries), and `agent-runner/` (container binary)
- Comprehensive spec documentation in `specs/application/` with 19 component specs, wireframes, and state machines
- Well-organised `.github/` with agents, prompts, issue templates, and CI workflows
- `.devcontainer/` with multiple container variants for different workflows

**Weaknesses:**
- Root is cluttered with 50+ entries including stale artefacts (see PS-001, PS-002)
- Multiple AI tool config directories (`.claude/`, `.copilot/`, `.design-engineer/`, `.specify/`) add noise
- `bob/` directory is empty, `CONTINUITY.md` contains stale debugging notes
- HTML prototype files at root (`button-preview.html`, `clawd-buttons.html`) are not in a design directory

### 2.2 Source Directory (`src/`)

```
src/
  app/                     # Frontend application
    client.tsx             # React entry point
    components/            # UI components (features/ + ui/)
    hooks/                 # React hooks
    providers/             # Context providers
    router.tsx             # TanStack Router config
    routeTree.gen.ts       # Auto-generated route tree
    routes/                # File-based routes
    services/              # Client-side service abstractions
    styles/                # CSS/theme files
  db/                      # Database layer
    client.ts              # DB client factory (SQLite + Postgres)
    migrations/            # SQLite migrations
    migrations-pg/         # Postgres migrations
    schema/                # Drizzle schema definitions
  lib/                     # Shared libraries (27 subdirectories)
    agents/                # Claude Agent SDK integration
    api/                   # API client utilities
    bootstrap/             # App initialisation
    cli-monitor/           # CLI monitor integration
    config/                # Configuration management
    constants/             # Application constants
    crypto/                # Cryptography utilities
    env.ts                 # Runtime environment detection
    errors/                # Error catalog and handlers
    github/                # GitHub integration
    hooks/                 # Shared hooks
    integrations/          # External integrations
    logging/               # Structured logging
    plan-mode/             # Agent plan mode logic
    prompts/               # Prompt registry and templates
    sandbox/               # Sandbox providers (Docker, K8s)
    sandbox-status/        # Sandbox status tracking
    sessions/              # Session management
    state-machines/        # XState-like state machines
    streams/               # Durable streams integration
    task-creation/         # Task creation pipeline
    terraform/             # Terraform compose utilities
    types/                 # Shared type definitions
    utils/                 # General utilities
    vite-stubs/            # Browser stubs for server-only modules
    workflow-dsl/          # Workflow DSL engine
  server/                  # Backend API server
    api.ts                 # Hono app + all routes (1,418 lines)
    crypto.ts              # Server crypto
    router.ts              # API router setup
    routes/                # Route handlers (22+ route files)
    runtime.ts             # Stream provider accessor
    shared.ts              # Shared server utilities
    sse-token.service.ts   # SSE auth token service
    validation.ts          # Request validation
  services/                # Business logic services (26 files)
    __tests__/             # Service unit tests
    agent/                 # Agent execution service
    cli-monitor/           # CLI monitor service
    session/               # Session service
    *.service.ts           # Top-level service files
  types/                   # Global type definitions
```

**Strengths:**
- Clean feature-based organisation within `src/app/components/features/`
- Database layer properly split between SQLite and Postgres schemas/migrations
- Services are well-separated with dedicated test directories
- Server routes are modularised into individual files

**Weaknesses:**
- `src/lib/` has 27 subdirectories and is becoming a dumping ground. Some directories (`hooks/`, `types/`) overlap with `src/app/hooks/` and `src/types/`
- `src/server/api.ts` at 1,418 lines is a monolith that should be split further
- Some services are extremely large: `container-agent.service.ts` (2,244 lines), `task-creation.service.ts` (2,544 lines)
- Mixed service organisation: some services are in subdirectories (`agent/`, `session/`, `cli-monitor/`), others are flat files

---

## 3. Build System

### 3.1 Vite Configuration

**File:** `vite.config.ts` (100 lines)

The Vite configuration handles the frontend SPA build with:
- TanStack Router plugin for file-based routing
- Tailwind CSS v4 via `@tailwindcss/vite`
- TypeScript path aliases via `vite-tsconfig-paths`
- Custom `serverOnlyStubs()` plugin to prevent server-only modules from being bundled for the browser
- Proxy configuration forwarding `/api` to `localhost:3001`

The custom stubs plugin is well-designed, using a configurable list of server-only modules (`SERVER_TOOL_MODULES`) and a separate stubs registry (`getStubId`/`getStubCode`).

**Build command:** `vite build && tsc --noEmit && npm run build:agent-runner`

This builds frontend assets, runs type-checking, and compiles the agent-runner. However, the `packages/` are not included in the build chain.

### 3.2 TypeScript Configuration

**Root `tsconfig.json`:**
- Target: ES2022, Module: ESNext, moduleResolution: Bundler
- Strict mode enabled with additional checks (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`)
- `verbatimModuleSyntax: true` for proper import/export type enforcement
- Path aliases: `@/*` -> `./src/*`, `@agentpane/agent-sandbox-sdk` -> package source

**Inconsistencies across packages:**

| Package | target | module | moduleResolution |
|---------|--------|--------|-----------------|
| Root | ES2022 | ESNext | Bundler |
| agent-runner | ES2022 | NodeNext | NodeNext |
| cli-monitor | ESNext | ESNext | bundler |
| agent-sandbox-sdk | ES2022 | ESNext | bundler |

The `agent-runner` uses `NodeNext` module resolution while all others use `Bundler` - this is correct since the agent-runner targets Node.js directly. However, the target inconsistency (`ESNext` vs `ES2022`) is needless.

### 3.3 Bun Configuration

**File:** `bunfig.toml`

Redirects `bun test` to vitest to prevent confusion with Bun's built-in test runner. This is a pragmatic solution.

### 3.4 Multiple Vitest Configurations

The project maintains three separate vitest configs:
- `vitest.config.ts` - Unit/integration tests (jsdom environment)
- `vitest.e2e.config.ts` - End-to-end tests (node environment, serial execution)
- `vitest.ai-ui.config.ts` - AI-powered UI tests via agent-browser (node, 2-min timeouts)

This separation is appropriate given the different test environments and timeout requirements.

---

## 4. CI/CD Pipeline

### 4.1 GitHub Actions (`ci.yml`)

**File:** `.github/workflows/ci.yml` (75 lines)

The pipeline has two jobs:

1. **lint-and-typecheck** - Runs `bun run typecheck` + `bun run check` (Biome)
2. **test** (depends on lint-and-typecheck) - Runs `bun run test:coverage` + uploads coverage artifact

**Strengths:**
- Concurrency control with `cancel-in-progress: true`
- Bun package caching for faster installs
- Coverage reports uploaded as artifacts

**Weaknesses:**
- No build verification job (the `build` script is never run in CI)
- No E2E test job
- No Docker image build/test
- No package build verification for `packages/cli-monitor` or `packages/agent-sandbox-sdk`
- Pinned Bun version (1.3.6) as env var but the Dockerfile also pins 1.3.6 - these could drift
- Single workflow file - no staging/production deployment workflows exist

### 4.2 Pre-commit Hooks (`.pre-commit-config.yaml`)

Comprehensive pre-commit setup:
- **Pre-commit:** Biome check, TypeScript type check, test suite, markdown lint, secret detection, YAML/JSON validation, private key detection, trailing whitespace
- **Pre-push:** Biome auto-fix

Running the full test suite on every commit is aggressive and may slow down developer workflow.

### 4.3 Dependabot

Configured for:
- Dev container updates (weekly)
- NPM dependency updates (weekly, grouped by dev/testing)
- GitHub Actions updates (weekly)

The grouping patterns reference `*eslint*` and `*prettier*` but the project uses Biome, not ESLint/Prettier. This is a stale configuration.

---

## 5. Configuration Management

### 5.1 Environment Variables

The `.env` file at root is essentially empty (just a comment). Environment configuration is managed through:
- `process.env` direct access throughout server code
- `src/lib/env.ts` for runtime environment detection (Vite vs Node)
- `vite.config.ts` `define` block for build-time constants
- Docker compose environment blocks
- Settings stored in SQLite/Postgres via `settings.service.ts`

There is no central `.env.example` file documenting required/optional environment variables.

### 5.2 Database Configuration

Dual database support is managed through:
- `drizzle.config.ts` (SQLite) + `drizzle.config.pg.ts` (Postgres)
- Separate migration directories (`migrations/` vs `migrations-pg/`)
- `DB_MODE` env var to select runtime database backend
- `scripts/migrate-sqlite-to-pg.ts` for migration between backends

### 5.3 Linting/Formatting (Biome)

**File:** `biome.json` (105 lines)

Well-configured with:
- Git-aware file selection
- Override rules for test files (relaxed `noExplicitAny`, `noNonNullAssertion`)
- Override rules for scripts (relaxed `noExplicitAny`)
- Generated files excluded from linting (routeTree.gen.ts, settings.local.json)
- 2-space indentation, single quotes, semicolons, ES5 trailing commas

### 5.4 Tailwind Configuration

A `tailwind.config.ts` exists at the root with a design token system using CSS custom properties. However, Tailwind v4 (used via `@tailwindcss/vite`) typically uses CSS-based configuration rather than the JS config file. This file may be partially redundant.

---

## 6. Findings

### PS-001: Stale Build Artefacts Committed to Repository

**Severity:** Medium
**Category:** Code Hygiene

Two timestamped JavaScript files are committed to the repository root that appear to be Vite/TanStack build artefacts:

- `/Users/simon.lynch/git/agentpane_nocode/app.config.timestamp_1768697232387.js` (line 1-19)
- `/Users/simon.lynch/git/agentpane_nocode/vite.config.timestamp_1768698877204.js` (line 1-50)

These are auto-generated transpilations of config files with embedded timestamps. They contain stale versions of the Vite config (e.g., the timestamp file has a simpler `serverOnlyStubs` without the stub registry system).

**Recommendation:** Add `*.timestamp_*.js` to `.gitignore` and remove these files from the repository.

---

### PS-002: Empty and Stale Root-Level Files/Directories

**Severity:** Low
**Category:** Code Hygiene

Several root-level items serve no current purpose:

| Item | Issue |
|------|-------|
| `bob/` (empty directory) | Empty directory with no apparent purpose |
| `CONTINUITY.md` | Contains stale debugging notes from a previous session; not a living document |
| `SPEC_UPDATES.md` | 7-line file, appears abandoned |
| `button-preview.html` (27,645 bytes) | HTML prototype file at root |
| `clawd-buttons.html` (18,595 bytes) | HTML prototype file at root |
| `fix-wireguard-push.sh` | One-off script committed at root level |

**Files:**
- `/Users/simon.lynch/git/agentpane_nocode/bob/` (empty)
- `/Users/simon.lynch/git/agentpane_nocode/CONTINUITY.md:1-11`
- `/Users/simon.lynch/git/agentpane_nocode/SPEC_UPDATES.md:1-7`
- `/Users/simon.lynch/git/agentpane_nocode/button-preview.html`
- `/Users/simon.lynch/git/agentpane_nocode/clawd-buttons.html`
- `/Users/simon.lynch/git/agentpane_nocode/fix-wireguard-push.sh`

**Recommendation:** Remove `bob/`, `CONTINUITY.md`, `SPEC_UPDATES.md`. Move HTML prototypes to `specs/wireframes/` or a `prototypes/` directory. Move `fix-wireguard-push.sh` to `scripts/` or remove it.

---

### PS-003: Missing Formal Workspace Configuration

**Severity:** High
**Category:** Build System

The project has three independent packages (`agent-runner/`, `packages/cli-monitor/`, `packages/agent-sandbox-sdk/`) but no workspace configuration in the root `package.json`. Each package manages its own `node_modules` and has its own lock file:

- `agent-runner/package-lock.json` (npm lockfile, 13.7KB) + `bun.lock`
- `packages/cli-monitor/` - no lockfile (uses root)
- `packages/agent-sandbox-sdk/` - has own `node_modules/`

Without `"workspaces"` in `package.json`, packages cannot share dependencies, and there is no single `bun install` that sets up the entire project. The `agent-runner/` uses `npm install` in the Dockerfile instead of `bun install`, creating an inconsistent install mechanism.

**Files:**
- `/Users/simon.lynch/git/agentpane_nocode/package.json:1-120` (no `workspaces` field)
- `/Users/simon.lynch/git/agentpane_nocode/agent-runner/package.json:1-26`
- `/Users/simon.lynch/git/agentpane_nocode/docker/Dockerfile:18` (`npm install --ignore-scripts`)

**Recommendation:** Add `"workspaces": ["packages/*", "agent-runner"]` to the root `package.json`. Consolidate to a single lock file. Update the Dockerfile to use `bun install` for the agent-runner.

---

### PS-004: Package Name Mismatch ("agent-dev-template")

**Severity:** Medium
**Category:** Configuration

The root `package.json` still uses the original template name:

```json
{
  "name": "agent-dev-template",
  "description": "Framework-agnostic TypeScript/Node.js web development template with AI-assisted workflows"
}
```

This is misleading for a production application. The name and description should reflect the actual project (AgentPane).

**File:** `/Users/simon.lynch/git/agentpane_nocode/package.json:2-4`

**Recommendation:** Update the name to `agentpane` (or `@agentpane/app`) and the description to match the project's purpose.

---

### PS-005: Node.js Engine Version Inconsistency

**Severity:** Medium
**Category:** Configuration

Different parts of the project require different Node.js versions:

| Location | Required Version |
|----------|-----------------|
| Root `package.json` | `>=24.0.0` |
| `agent-runner/package.json` | `>=22.0.0` |
| `packages/cli-monitor/package.json` | `>=22.0.0` |
| Docker base image | Bun 1.3.6 (Alpine) |

Node 24 is the current LTS but requiring it while sub-packages accept 22+ creates confusion. The `agent-runner` deploys inside Docker with Bun, not Node directly.

**Files:**
- `/Users/simon.lynch/git/agentpane_nocode/package.json:7`
- `/Users/simon.lynch/git/agentpane_nocode/agent-runner/package.json:25`
- `/Users/simon.lynch/git/agentpane_nocode/packages/cli-monitor/package.json:41`

**Recommendation:** Align all packages to the same minimum Node.js version. Since the project uses Bun as runtime, consider whether the `engines` field should specify Bun instead.

---

### PS-006: No Build Verification in CI

**Severity:** High
**Category:** CI/CD

The CI pipeline (`ci.yml`) runs lint, typecheck, and tests but never runs `bun run build`. This means the production build could break without being detected. Additionally:

- No Docker image build or smoke test
- No package build verification for `cli-monitor` or `agent-sandbox-sdk`
- No E2E tests in CI
- No deployment workflow

**File:** `/Users/simon.lynch/git/agentpane_nocode/.github/workflows/ci.yml:1-75`

**Recommendation:** Add a `build` job that runs the full build pipeline. Consider adding Docker build verification and at minimum a smoke test job.

---

### PS-007: Stale Dependabot Grouping Patterns

**Severity:** Low
**Category:** Configuration

The dependabot configuration groups updates for `*eslint*` and `*prettier*` but the project uses Biome, not ESLint or Prettier. These patterns will never match.

**File:** `/Users/simon.lynch/git/agentpane_nocode/.github/dependabot.yml:16-19`

**Recommendation:** Update grouping patterns to reference `@biomejs/*` and `biome` instead.

---

### PS-008: Dual Lock Files

**Severity:** Medium
**Category:** Build System

The project has both `package-lock.json` (444KB) and `bun.lock` (248KB) at the root. Since the project uses Bun as its runtime and package manager, the npm lock file is redundant and could cause confusion or dependency resolution conflicts.

The `agent-runner/` also has both `package-lock.json` and `bun.lock`.

**Files:**
- `/Users/simon.lynch/git/agentpane_nocode/package-lock.json` (444KB)
- `/Users/simon.lynch/git/agentpane_nocode/bun.lock` (248KB)
- `/Users/simon.lynch/git/agentpane_nocode/agent-runner/package-lock.json` (13.7KB)
- `/Users/simon.lynch/git/agentpane_nocode/agent-runner/bun.lock`

**Recommendation:** Remove `package-lock.json` from root and agent-runner. Add `package-lock.json` to `.gitignore`. Ensure CI and Docker use `bun install --frozen-lockfile` consistently.

---

### PS-009: Irrelevant MCP Configuration Committed

**Severity:** Low
**Category:** Configuration

The `.mcp.json` file configures an XcodeBuildMCP server, which has no relevance to this TypeScript web application.

**File:** `/Users/simon.lynch/git/agentpane_nocode/.mcp.json:1-8`

**Recommendation:** Remove `.mcp.json` or update it with relevant MCP servers. Consider adding it to `.gitignore` since it contains local tool preferences.

---

### PS-010: Monolithic `src/server/api.ts` (1,418 Lines)

**Severity:** Medium
**Category:** Code Organisation

The main API server file at `src/server/api.ts` is 1,418 lines. While it delegates to route files, the file itself handles app initialisation, middleware setup, all route mounting, and server startup. As the API grows, this will become increasingly difficult to maintain.

**File:** `/Users/simon.lynch/git/agentpane_nocode/src/server/api.ts:1-1418`

**Recommendation:** Extract middleware configuration, route registration, and server bootstrap into separate modules. The route mounting could be auto-discovered from the `routes/` directory.

---

### PS-011: Oversized Service Files

**Severity:** Medium
**Category:** Code Organisation

Two service files have grown well beyond reasonable single-file sizes:

| Service | Lines | Size |
|---------|-------|------|
| `task-creation.service.ts` | 2,544 | 93KB |
| `container-agent.service.ts` | 2,244 | 77KB |

Files this large are difficult to review, test, and maintain. They suggest these services handle too many responsibilities.

**Files:**
- `/Users/simon.lynch/git/agentpane_nocode/src/services/task-creation.service.ts` (2,544 lines)
- `/Users/simon.lynch/git/agentpane_nocode/src/services/container-agent.service.ts` (2,244 lines)

**Recommendation:** Decompose into focused sub-modules. For example, `task-creation.service.ts` could be split into validation, AI interaction, and persistence layers. `container-agent.service.ts` could separate Docker management, credential handling, and agent lifecycle.

---

### PS-012: `.DS_Store` Files Not Properly Gitignored

**Severity:** Low
**Category:** Code Hygiene

While `.DS_Store` is listed in `.gitignore`, multiple `.DS_Store` files exist in tracked directories (visible in `ls` output for `src/`, `packages/`, `specs/`, etc.). This suggests they were committed before the gitignore rule was added.

**Recommendation:** Remove all tracked `.DS_Store` files with `git rm --cached` recursively. The existing `.gitignore` rule will prevent future additions.

---

### PS-013: Missing `.env.example` File

**Severity:** Medium
**Category:** Developer Experience

There is no `.env.example` or `.env.template` documenting required and optional environment variables. The root `.env` file contains only a comment. Developers must read through multiple files (`CLAUDE.md`, `docker-compose.yml`, `start-dev.ts`, `drizzle.config.pg.ts`) to discover environment variables like:

- `ANTHROPIC_API_KEY`
- `CLAUDE_OAUTH_TOKEN`
- `DB_MODE` (sqlite/postgres)
- `DATABASE_URL`
- `SQLITE_DATA_DIR`
- `CORS_ORIGIN`
- `LOG_LEVEL`
- `VITE_E2E_SEED`

**Recommendation:** Create a `.env.example` at the root documenting all environment variables with descriptions, defaults, and required/optional status.

---

### PS-014: Stale Worktree in `.worktrees/`

**Severity:** Low
**Category:** Code Hygiene

The `.worktrees/` directory contains a worktree from a previous task (`create-reusable-terraform-s3-module-with-i0nr5t`) that appears to be orphaned. While `.worktrees/` is gitignored, this takes up disk space and could cause confusion.

**File:** `/Users/simon.lynch/git/agentpane_nocode/.worktrees/create-reusable-terraform-s3-module-with-i0nr5t/`

**Recommendation:** Add a cleanup script or periodic job to prune stale worktrees. Document the worktree lifecycle in AGENTS.md.

---

### PS-015: Pre-commit Running Full Test Suite

**Severity:** Medium
**Category:** Developer Experience

The `.pre-commit-config.yaml` runs the full test suite (`bun run test`) on every commit. Combined with Biome checks and TypeScript type checking, this can make commits take 30+ seconds.

**File:** `/Users/simon.lynch/git/agentpane_nocode/.pre-commit-config.yaml:24-35`

**Recommendation:** Move the test suite to a pre-push hook (like the existing Biome fix). For pre-commit, consider running only affected tests or a quick smoke test.

---

## 7. Summary

### Severity Distribution

| Severity | Count | Finding IDs |
|----------|-------|-------------|
| Critical | 0 | - |
| High | 2 | PS-003, PS-006 |
| Medium | 7 | PS-001, PS-004, PS-005, PS-008, PS-010, PS-011, PS-013 |
| Low | 6 | PS-002, PS-007, PS-009, PS-012, PS-014, PS-015 |

### Top Priority Actions

1. **PS-003** (High) - Add workspace configuration to unify package management
2. **PS-006** (High) - Add build verification to CI pipeline
3. **PS-008** (Medium) - Consolidate to single lock file (bun.lock)
4. **PS-013** (Medium) - Create `.env.example` for developer onboarding
5. **PS-011** (Medium) - Decompose oversized service files
