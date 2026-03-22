# AgentPane Development Guidelines

<default_follow_through_policy>
- If the user's intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask permission only if the next step is:
  (a) irreversible,
  (b) has external side effects (for example sending, purchasing, deleting, or writing to production), or
  (c) requires missing sensitive information or a choice that would materially change the outcome.
- If proceeding, briefly state what you did and what remains optional.
</default_follow_through_policy>

<instruction_priority>

- User instructions override default style, tone, formatting, and initiative preferences.
- Safety, honesty, privacy, and permission constraints do not yield.
- If a newer user instruction conflicts with an earlier one, follow the newer instruction.
- Preserve earlier instructions that do not conflict.
</instruction_priority>

<dependency_checks>
- Before taking an action, check whether prerequisite discovery, lookup, or memory retrieval steps are required.
- Do not skip prerequisite steps just because the intended final action seems obvious.
- If the task depends on the output of a prior step, resolve that dependency first.
</dependency_checks>

Use bun not npm

## AI Assistant Rules

> **Read this section first.** These are hard constraints for code generation.

### Frontend design

Use these skills:

- claude-design-skill — Design engineering for Claude Code
- frontend-design — Create production-grade frontend interfaces

### MUST

- Use TypeScript with strict mode for all new code
- Use `async/await` for all asynchronous code — never callbacks
- Use Vitest for unit/integration tests, Agent Browser for E2E
- Use Biome for linting and formatting
- Use environment variables for all configuration (never hardcode secrets)
- Use explicit return types for public functions
- Use `const` by default, `let` only when mutation is required
- Implement proper error handling with Result types for expected errors
- Follow local-first architecture patterns
- Use dependency injection for testability

### NEVER

- Use `any` type without explicit justification
- Use `var` — always use `const` or `let`
- Store secrets in code or version control
- Use synchronous file/network operations in async contexts
- Disable TypeScript strict checks
- Skip error handling for async operations
- Use mutable global state
- Commit `.env` files or credentials
- Block the UI on network requests (local-first)

### PREFER

- Open source libraries over proprietary solutions
- Functional programming patterns over imperative
- Composition over inheritance
- Small, focused functions (< 30 lines)
- Early returns with guard clauses
- Template literals over string concatenation
- Optional chaining (`?.`) and nullish coalescing (`??`)
- Named exports over default exports
- Descriptive variable names over comments
- Result types over thrown exceptions for expected errors
- Optimistic UI updates with sync reconciliation

---

## Code Conventions

### Import Style (CQ-011)

The codebase uses two import styles by convention:

- **Path alias `@/`** — Used in `src/services/`, `src/server/routes/`, and deep `src/lib/` modules
  for cross-cutting imports (e.g., `import { ok } from '@/lib/utils/result'`). Configured in
  `tsconfig.json` paths. Preferred for imports that cross module boundaries.
- **Relative paths** — Used within the same directory or immediate siblings (e.g.,
  `import { createError } from './base.js'`). Preferred for tightly coupled files in the same
  package/module.

Both styles are acceptable. Do not mix them within a single file.

### Barrel File Re-exports (CQ-012)

Barrel files (e.g., `src/db/schema/sqlite/index.ts`, `src/lib/errors/index.ts`) use wildcard
`export *` re-exports. This is acceptable and intentional — it simplifies imports for consumers
while keeping module internals organized.

### Biome Lint Suppressions (CQ-016)

The codebase has `biome-ignore` suppressions with inline justification comments. Common cases
include `noExplicitAny` for untyped SDK/JSON data and `noSuspiciousAssignInExpressions` in
stream processing loops.

### Frontend Coverage Exclusion (CQ-023)

Frontend code (`src/app/`) is excluded from Vitest coverage metrics in `vitest.config.ts`. React
components are better tested via Agent Browser (visual/E2E) than unit tests. Backend services
and utilities have coverage thresholds applied.

### Database Driver Casts (CQ-026)

The codebase has `as unknown` type casts in database-related code. These bridge the gap between
Drizzle ORM's generated types and the actual query results from better-sqlite3.

---

## Architecture: Server-Side SQLite with Real-Time Streaming

1. **Data lives on the server** — SQLite database runs on Bun server
2. **Fast API access** — TanStack Query/DB for client-side caching
3. **Real-time updates** — Durable Streams for agent progress and live data
4. **Simple operations** — Standard REST API patterns via Hono

### Caddy Front Door (Durable Streams Server)

In production, a custom Caddy binary (`durable-streams-server`) runs on `:3000` as the front door. Bun runs as a backend API on `:3001`. Caddy handles three concerns:

1. **Durable Streams** — LMDB-backed SSE + long-poll at `/v1/stream/*` for real-time agent events
2. **API reverse proxy** — `/api/*` proxied to Bun on `:3001` with streaming flush
3. **Static files** — SPA with gzip/brotli, immutable cache headers for `/assets/*`

```text
Client (:3000)
  ├── /v1/stream/*  → Caddy durable_streams (LMDB, SSE)
  ├── /api/*        → reverse_proxy → Bun (:3001)
  └── /*            → static files / SPA fallback
```

**Dev mode** uses `DurableStreamTestServer` (from `@durable-streams/server`) on `:3002` instead of Caddy.

---

## Naming Conventions

| Type             | Convention      | Example              |
| ---------------- | --------------- | -------------------- |
| Files            | kebab-case      | `task-agent.ts`      |
| Classes          | PascalCase      | `TaskAgent`          |
| Functions        | camelCase       | `runAgent`           |
| Constants        | SCREAMING_SNAKE | `MAX_AGENT_TURNS`    |
| Types/Interfaces | PascalCase      | `AgentConfig`        |
| DB Tables        | snake_case      | `agent_sessions`     |
| Routes           | kebab-case      | `/agents/$id`        |

---

<!-- intent-skills:start -->
# Skill mappings - when working in these areas, load the linked skill file into context

skills:

- task: "Working with TanStack DB collections, live queries, or React state sync"
    load: "node_modules/@tanstack/react-db/skills/react-db/SKILL.md"
- task: "Setting up or modifying TanStack DB collection adapters and sync config"
    load: "node_modules/@tanstack/db/skills/db-core/collection-setup/SKILL.md"
- task: "Building live queries with filtering, joins, aggregates, or derived collections"
    load: "node_modules/@tanstack/db/skills/db-core/live-queries/SKILL.md"
- task: "Optimistic mutations, transactions, or paced mutations on collections"
    load: "node_modules/@tanstack/db/skills/db-core/mutations-optimistic/SKILL.md"
- task: "Stream-backed reactive database with @durable-streams/state"
    load: "node_modules/@durable-streams/server/node_modules/@durable-streams/state/skills/stream-db/SKILL.md"
- task: "Defining typed state schemas for durable streams collections"
    load: "node_modules/@durable-streams/server/node_modules/@durable-streams/state/skills/state-schema/SKILL.md"
- task: "Reading or subscribing to durable streams (SSE, long-poll, reconnect)"
    load: "node_modules/@durable-streams/server/node_modules/@durable-streams/client/skills/reading-streams/SKILL.md"
- task: "Writing or appending data to durable streams (producers, batching)"
    load: "node_modules/@durable-streams/server/node_modules/@durable-streams/client/skills/writing-data/SKILL.md"
- task: "Deploying or configuring durable stream servers (Caddy, test server)"
    load: "node_modules/@durable-streams/server/node_modules/@durable-streams/client/skills/server-deployment/SKILL.md"
- task: "TanStack Router routes, navigation, Link component, or useNavigate"
    load: "node_modules/@tanstack/router-core/skills/router-core/navigation/SKILL.md"
- task: "Route data loading, loaders, staleTime, pendingComponent, or beforeLoad"
    load: "node_modules/@tanstack/router-core/skills/router-core/data-loading/SKILL.md"
- task: "Route auth guards, protected routes, RBAC, or redirect"
    load: "node_modules/@tanstack/router-core/skills/router-core/auth-and-guards/SKILL.md"
- task: "Search params validation, search middlewares, or URL state"
    load: "node_modules/@tanstack/router-core/skills/router-core/search-params/SKILL.md"
- task: "E2E browser testing, screenshots, form filling, or web interaction"
    load: "node_modules/agent-browser/skills/agent-browser/SKILL.md"
<!-- intent-skills:end -->
