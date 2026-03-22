# Runtime, Build Tools, Linting & Monorepo Research

**Date:** March 2026
**Current Stack:** Bun 1.3.10 | Vite 8.0.1 | Biome 2.4.4 | No formal monorepo tooling

---

## 1. Runtime: Bun 1.3.x vs Deno 2.x vs Node.js 24+

### Current State: Bun 1.3.x

**What AgentPane uses Bun for:**

- Package manager (`bun install --frozen-lockfile` in CI)
- Script runner (`bun run dev`, `bun scripts/start-dev.ts`)
- API server runtime (`bun src/server/api.ts`)
- CLI-monitor compilation target (`bun build --compile`)
- Test runner delegated to Vitest (not `bun test`)

**Bun strengths in this project:**

- Fast installs: 5-10x faster than npm. CI caches `node_modules` but cold installs benefit significantly
- Single-file compilation: `bun build --compile` for cli-monitor produces native executables per platform without additional tooling
- TypeScript execution: No build step for scripts
- `better-sqlite3` works well: Bun ships prebuilt binaries, avoiding native compilation issues

**Known Bun issues (1.3.x):**

- Node.js API compatibility gaps (~95% covered): `node:cluster` incomplete, some `node:crypto` subtle ops differ
- Memory usage under sustained load: JavaScriptCore GC behaves differently from V8; less predictable GC pauses for long-running servers with many SSE connections
- Subprocess spawning: `Bun.spawn` is fast (~2-3x faster than Node.js) but has had bugs with stdio piping in complex scenarios
- Debugging: `--inspect` works but lacks some V8 inspector features

### Deno 2.x

- npm compatibility is production-grade; `deno install` works with `package.json`
- Built-in TypeScript with full support (not just type-stripping)
- Permissions model could add security for agent execution
- **Blockers:** better-sqlite3 native addon risk, Claude Agent SDK untested, Vite + TanStack Start chain unvalidated, dockerode Node.js streams compatibility
- **Migration effort:** HIGH (2-4 weeks validation with blocking risk)

### Node.js 24+

- Already the runtime target for agent-runner (`"engines": { "node": ">=22.0.0" }`)
- V8's TurboFan produces highly optimized code for long-running servers
- Claude Agent SDK is built and tested against Node.js
- Type stripping stable in Node 23+ (but no path aliases, no const enum)
- **Migration effort:** MODERATE (3-5 days; replace `bun install` with pnpm, `bun build --compile` with pkg/esbuild)

### Recommendation

| Runtime | Recommendation | Rationale |
|---------|---------------|-----------|
| **Bun 1.3.x** | **ADOPT (keep)** | Current choice works well. Fast installs, native TS, `--compile` for CLI. Hybrid model (Bun locally, Node in containers) is sound |
| **Deno 2.x** | **HOLD** | npm compat good but native addon story (better-sqlite3, dockerode) is risky. Claude SDK untested |
| **Node.js 24+** | **ASSESS** | Worth evaluating as pure production runtime. Already used in agent-runner. Low-risk fallback if Bun hits issues |

---

## 2. Build Tool: Vite 8 vs Turbopack vs Rspack vs Farm

### Current State: Vite 8.0.1

- Frontend React bundle (TanStack Router + React 19)
- Dev server with HMR on port 3000, proxy to API on 3001 and streams on 3002
- TanStack Router code generation plugin, Tailwind CSS v4 plugin, custom `serverOnlyStubs()` plugin
- Vite 8 uses Rolldown (Rust-based bundler) for production builds — 10-100x faster than Rollup

**Build performance (~803 files, ~45k LoC):**

- Dev startup: ~1-2 seconds
- HMR: <100ms
- Production build: ~5-15 seconds

### Alternatives

**Turbopack:** Next.js-specific. Not compatible with TanStack Start. NOT FEASIBLE.

**Rspack:** Rust-based webpack-compatible. No TanStack Start adapter. No `@tailwindcss/vite` equivalent. HIGH migration effort, not justified.

**Farm:** Rust-based with Vite compat layer. Incomplete plugin coverage. Smaller community. HIGH risk.

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Vite 8 (Rolldown)** | **ADOPT (keep)** | TanStack Start requires it. Rolldown brings Rust-speed builds. Plugin ecosystem is largest |
| **Turbopack** | **HOLD** | Next.js only |
| **Rspack** | **HOLD** | No TanStack Start adapter |
| **Farm** | **HOLD** | Immature ecosystem |

---

## 3. Linting/Formatting: Biome 2.x vs oxlint vs ESLint Flat Config

### Current State: Biome 2.4.4

- ~300+ lint rules covering most ESLint recommended + TypeScript-specific
- Formatting: Prettier-compatible for JS/TS/JSX/TSX/JSON
- Performance: 10-100x faster than ESLint + Prettier
- Single tool for lint + format

**Limitations:**

- No type-aware lint rules (can't do `no-floating-promises`, `strict-boolean-expressions`)
- Plugin system nascent (GritQL-based)
- No custom rule API comparable to ESLint

### oxlint

- Rust-based, 50-100x faster than ESLint, ~400+ rules
- **No formatter** — needs pairing with Prettier or Biome formatter
- No import organization
- Practical performance difference vs Biome is negligible for 803 files

### ESLint 9+ Flat Config

- Type-aware rules (`no-floating-promises`, `strict-boolean-expressions`) catch real bugs Biome cannot
- 3000+ plugins, largest ecosystem
- 10-50x slower than Biome/oxlint (10-30 seconds for 803 files vs <1 second)

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Biome 2.4.x** | **ADOPT (keep)** | Fast, unified lint+format, handles 95% of needs |
| **oxlint** | **ASSESS** | Monitor as Rolldown/oxc ecosystem matures |
| **ESLint 9 flat** | **TRIAL (supplementary)** | Run type-aware rules CI-only on critical paths (`src/services/`, `src/lib/agents/`) for `no-floating-promises` |

**Concrete recommendation:** Keep Biome primary. Add targeted ESLint in CI:

```yaml
- name: Type-aware lint (critical paths)
  run: npx eslint --config eslint.config.typeaware.js src/services/ src/lib/agents/
```

---

## 4. Module Bundling for Production

| Tool | Use Case | Recommendation | Rationale |
|------|----------|---------------|-----------|
| **Vite 8 / Rolldown** | Frontend | **ADOPT (keep)** | Already in use, Rolldown improves build speed |
| **esbuild** | Server API bundle | **TRIAL** | Could improve container cold start and deployment simplicity |
| **Bun build** | CLI monitor | **ADOPT (keep)** | Already working well for single-file and cross-platform compilation |
| **tsc** | Agent runner | **ADOPT (keep)** | Simple transpilation is sufficient |
| **Rolldown standalone** | Server | **ASSESS** | Wait for 1.0 standalone release |

---

## 5. Monorepo Tooling

### Current State

```
agentpane_nocode/
  package.json          (root - no workspaces field)
  bun.lock              (root lockfile, contains workspaces config)
  agent-runner/         (separate package.json, own bun.lock + package-lock.json)
  packages/
    cli-monitor/        (separate package.json, own bun.lock)
    agent-sandbox-sdk/  (separate package.json)
    nomad-sandbox-sdk/  (separate package.json)
```

**Problems:** No `workspaces` field in root package.json, dual lockfiles in agent-runner, independent dependency installs, manual build orchestration, no cross-package dependency graph.

### Bun Workspaces

- Add `"workspaces": ["packages/*", "agent-runner"]` to root package.json
- Single lockfile, shared `node_modules` with hoisting
- **Migration effort:** LOW (1-2 hours)

### Turborepo

- Task graph with `dependsOn`, remote caching, `turbo run --filter`
- **For 4-5 packages:** Marginal benefit. More valuable at 6+ packages
- **Migration effort:** LOW (2-4 hours)

### Nx

- Most feature-rich but overkill for 4-5 packages
- **Migration effort:** MODERATE (1-2 days)

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Bun Workspaces** | **ADOPT** | Essential foundation. Fixes dual lockfiles, enables dependency hoisting. Low effort, high value |
| **Turborepo** | **ASSESS** | Evaluate in 3-6 months if CI times grow or package count exceeds 6 |
| **Nx** | **HOLD** | Too heavy for current scale |
| **moon** | **HOLD** | Smaller community, no advantage over Turborepo |

---

## Priority Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **Set up Bun Workspaces** | 1-2 hours | Fixes dual lockfiles, shared deps |
| 2 | **Verify Vite 8 Rolldown** is active in production builds | 30 min | Ensure Rust-speed builds |
| 3 | **Trial esbuild for API server bundle** | 2-4 hours | Smaller Docker images, faster cold starts |
| 4 | **Add type-aware ESLint rules for critical paths** | 4-8 hours | Catches `no-floating-promises` bugs |
| 5 | **Upgrade Bun to latest 1.3.x** | 30 min | Bug fixes, compatibility |
