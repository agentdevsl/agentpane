# Area 10: Code Quality & Technical Debt

**Review Date:** 2026-03-18
**Reviewer:** Architecture Review (automated)
**Scope:** `src/`, `package.json`, `biome.json`, `.github/workflows/`, quality infrastructure
**Codebase Stats:** 163,177 LOC across 691 files (631 production, 60 test files)

---

## Executive Summary

The AgentPane codebase is a 163K-line TypeScript application with generally strong typing practices (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and a well-configured Biome linter. However, several significant technical debt areas have accumulated: **855 bare console.* calls** in production code (despite having a structured logger), **25 services without tests**, **12 route modules without tests**, and a monolithic `api.ts` bootstrap file at 1,847 lines containing inline migration logic. The test suite covers 210 of 228 test files successfully but has **25 failing tests** in one test file. Coverage thresholds are set at only 48% for statements/functions/lines and 42% for branches.

**Overall Grade: C+** -- Type safety is excellent, linting is well-configured, but logging discipline, test coverage, and certain structural debt items need attention.

---

## 1. Code Duplication Analysis

### CQ-001: Migration Try/Catch Pattern in api.ts (HIGH)

**File:** `src/server/api.ts` (lines 178-348)
**Occurrences:** 9 identical patterns

The same try/catch pattern for SQLite ALTER TABLE migrations is repeated 9 times:

```typescript
// Pattern repeated 9 times with only the SQL and log message changing:
try {
  sqlite.exec(SOME_MIGRATION_SQL);
  log.info('[API Server] Some migration applied');
} catch (error) {
  if (!(error instanceof Error && error.message.includes('duplicate column name'))) {
    console.warn(
      '[API Server] Some migration error (unexpected):',
      error instanceof Error ? error.message : String(error)
    );
  }
}
```

**Recommendation:** Extract into a `runIdempotentMigration(sqlite, sql, label)` helper function. This would reduce ~120 lines to ~20.

### CQ-002: Error Serialization Pattern (MEDIUM)

**Pattern:** `error instanceof Error ? error.message : String(error)`
**Occurrences:** 150 in production code

This pattern appears 150 times across the codebase. It should be a utility function:

```typescript
// Suggested: src/lib/utils/error-message.ts
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

### CQ-003: Route Error Response Boilerplate (MEDIUM)

**Pattern:** `{ ok: false, error: { code: '...', message: '...' } }`
**Occurrences:** 456 across `src/server/routes/`

Additionally, `isValidId()` validation checks are duplicated 85 times across route handlers. While individual validation is reasonable, a Hono middleware or route-level validator could eliminate most of these.

### CQ-004: Duplicated Logging Helpers in container-agent.service.ts (LOW)

**File:** `src/services/container-agent.service.ts` (lines 17-37)

Custom `debugLog`, `infoLog`, `warnLog` functions duplicate what `createLogger` already provides. This file defines its own logging layer instead of using the existing structured logger.

```typescript
// Lines 17-37: Custom logging functions that should use createLogger
function debugLog(context: string, message: string, data?: Record<string, unknown>): void { ... }
function infoLog(context: string, message: string, data?: Record<string, unknown>): void { ... }
function warnLog(context: string, message: string, data?: Record<string, unknown>): void { ... }
```

---

## 2. Dead Code

### CQ-005: Commented-Out Swarm Features (LOW)

Multiple files contain commented-out code blocks for "Pending GA -- swarm features":

| File | Line(s) | Content |
|------|---------|---------|
| `src/services/durable-streams.service.ts` | 208 | `// TODO: Pending GA -- swarm features` |
| `src/services/container-agent.service.ts` | 163-165 | `// launchSwarm?: boolean;` `// teammateCount?: number;` |
| `src/lib/agents/stream-handler.ts` | 25-31 | 6 commented-out properties |
| `src/lib/agents/agentcore-bridge.ts` | 44 | `// TODO: Pending GA -- swarm features` |
| `src/lib/agents/container-bridge.ts` | 57 | `// TODO: Pending GA -- swarm features` |

These represent planned but unimplemented features. While acceptable short-term, they add noise and should be tracked in a feature branch or issue tracker rather than living in comments.

### CQ-006: No @ts-ignore or @ts-expect-error in Hand-Written Code (POSITIVE)

Only 1 `@ts-nocheck` found, and it is in the auto-generated `src/app/routeTree.gen.ts`. No `@ts-ignore` or `@ts-expect-error` in the codebase. This is excellent.

---

## 3. File Complexity Metrics

### Top 20 Largest Files by LOC

| Rank | File | LOC | Category |
|------|------|-----|----------|
| 1 | `src/services/container-agent.service.ts` | 3,076 | Service |
| 2 | `src/app/routes/settings/sandbox.tsx` | 2,878 | UI Route |
| 3 | `src/services/task-creation.service.ts` | 2,567 | Service |
| 4 | `src/server/api.ts` | 1,847 | Bootstrap |
| 5 | `src/lib/state-machines/__tests__/state-machines.test.ts` | 1,651 | Test |
| 6 | `src/app/components/features/new-task-dialog.tsx` | 1,580 | UI Component |
| 7 | `src/lib/streams/client.ts` | 1,492 | Library |
| 8 | `src/app/components/features/new-project-dialog.tsx` | 1,429 | UI Component |
| 9 | `src/server/routes/sandbox.ts` | 1,397 | Route |
| 10 | `src/lib/api/client.ts` | 1,384 | API Client |
| 11 | `src/server/routes/events.ts` | 1,323 | Route |
| 12 | `src/app/routeTree.gen.ts` | 1,095 | Generated |
| 13 | `src/lib/sandbox/providers/__tests__/nomad-sandbox-provider.test.ts` | 1,332 | Test |
| 14 | `src/services/__tests__/task-creation.service.test.ts` | 1,317 | Test |
| 15 | `src/lib/agents/stream-handler.ts` | 996 | Library |
| 16 | `src/app/components/features/project-settings.tsx` | 949 | UI Component |
| 17 | `src/services/scheduler.service.ts` | 931 | Service |
| 18 | `src/lib/sandbox/providers/docker-provider.ts` | 856 | Provider |
| 19 | `src/lib/bootstrap/phases/schema.ts` | 843 | Bootstrap |
| 20 | `src/services/durable-streams.service.ts` | 800 | Service |

### CQ-007: container-agent.service.ts is Oversized (HIGH)

At 3,076 lines, this is the largest file in the codebase. It handles:
- Container agent lifecycle (Docker, K8s, Nomad)
- AgentCore runtime lifecycle
- Plan management (pending plans, approval, rejection)
- Worktree resolution and cleanup
- Agent cancellation
- Event bridging

**Recommendation:** Split into focused modules:
- `container-agent-lifecycle.ts` (start, stop, cancel)
- `container-agent-plan.ts` (plan storage, approval, rejection, cleanup)
- `container-agent-worktree.ts` (worktree resolution, path translation)
- `agentcore-agent.ts` (AgentCore-specific execution path)

### CQ-008: api.ts as God File (HIGH)

At 1,847 lines, `src/server/api.ts` contains:
- Database initialization (SQLite + PostgreSQL, lines 125-348)
- 55 try/catch blocks for migrations
- Service instantiation (~30 services, lines 445-700)
- Sandbox provider initialization
- Route registration
- Server startup

This file is the monolithic entry point that wires the entire application. Inline SQLite migration SQL execution (9 duplicate patterns) and service construction should be factored out.

**Recommendation:** Extract database initialization into `src/server/bootstrap/database.ts`, service factory into `src/server/bootstrap/services.ts`, and sandbox initialization into `src/server/bootstrap/sandbox.ts`.

### CQ-009: task-creation.service.ts Console Log Density (MEDIUM)

At 2,567 lines with **118 `console.log/error/warn` calls**, this file has the highest density of bare console output in the codebase. Many contain emoji debug markers (`[TaskCreationService] ...`) suggesting development-time debugging that was never cleaned up.

### CQ-010: schema.ts Contains Raw SQL Strings (MEDIUM)

`src/lib/bootstrap/phases/schema.ts` at 843 lines consists entirely of raw SQL string constants for table creation. While functional, this duplicates the Drizzle ORM schema definitions in `src/db/schema/sqlite/`. These should ideally be generated from the ORM schema or consolidated.

---

## 4. Import Graph Analysis

### CQ-011: Mixed Import Style (Server vs Client) (LOW)

The codebase uses two import conventions:
- **Path alias `@/`:** 673 imports across 249 files (primarily in client-side code and some services)
- **Relative paths `../`:** Used in server-side code and `src/lib/`
- **Maximum relative import depth:** 6 levels deep

The `@/` alias is configured in both `tsconfig.json` and `vitest.config.ts`. Server-side files (`src/server/`, some `src/services/`) use `.js` extension relative imports while client-side uses bare `@/` aliases. This dual convention is workable but adds cognitive load.

### CQ-012: Barrel Files with Wildcard Re-exports (MEDIUM)

Several barrel files use `export *` which can cause:
- Tree-shaking issues
- Import cycle risks
- Slower IDE type resolution

Key barrel files:
| File | Re-exports |
|------|------------|
| `src/db/schema/sqlite/index.ts` | 38 `export *` statements |
| `src/db/schema/postgres/index.ts` | 23 `export *` statements |
| `src/lib/errors/index.ts` | 14 `export *` statements |
| `src/db/schema/index.ts` | Re-exports the full SQLite barrel |

The schema barrels re-export 38 modules, meaning any import from `@/db/schema` pulls in the entire schema namespace. This is acceptable for a schema barrel but worth noting for bundle size awareness.

### CQ-013: No Circular Import Issues Detected (POSITIVE)

No circular import chains were found. TypeScript compilation passes cleanly (`tsc --noEmit` exits with code 0), and the use of `import type` is enforced by Biome's `useImportType: "error"` rule, which prevents circular runtime dependencies from type imports.

---

## 5. Dependency Freshness

### Version Pinning Strategy

| Strategy | Count | Details |
|----------|-------|---------|
| Caret (`^`) | 61 | Most dependencies |
| Exact pin | 3 | `@tanstack/db`, `@xyflow/react`, `zod` |
| Tilde (`~`) | 0 | None |

The 3 exact-pinned packages are strategically chosen: `@tanstack/db` (pre-1.0 rapid API changes), `@xyflow/react` (breaking layout API changes), and `zod` (v4 major version). This is a sound strategy.

### CQ-014: Lock File Present (POSITIVE)

`bun.lock` is present and the CI uses `bun install --frozen-lockfile`, ensuring reproducible builds.

### Key Dependencies

| Package | Version | Latest | Notes |
|---------|---------|--------|-------|
| `react` | ^19.2.4 | Current | Up to date |
| `hono` | ^4.12.7 | Current | Up to date |
| `drizzle-orm` | ^0.45.1 | Current | Up to date |
| `vite` | ^7.3.1 | Current | Up to date |
| `tailwindcss` | ^4.1.18 | Current | Up to date |
| `@anthropic-ai/sdk` | ^0.78.0 | Current | Up to date |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.76 | Current | Pre-1.0, unstable APIs |
| `typescript` | ^5.7.2 | Current | Up to date |
| `vitest` | ^4.0.16 | Current | Up to date |
| `biome` | ^2.4.4 | Current | Up to date |

Dependencies appear current as of March 2026. The use of `@anthropic-ai/claude-agent-sdk` with `unstable_v2_createSession` indicates reliance on pre-GA APIs that may break.

---

## 6. Linting Coverage

### Biome Configuration Analysis

**File:** `biome.json`

**Enabled Rules:**
- `recommended: true` (all recommended rules active)
- `noUnusedImports: "error"` -- strict, prevents dead imports
- `noUnusedVariables: "error"` -- strict, prevents dead variables
- `useConst: "error"` -- enforces immutability where possible
- `useImportType: "error"` -- enforces type-only imports (critical for verbatimModuleSyntax)
- `noExplicitAny: "warn"` -- warns but does not block
- `noNonNullAssertion: "warn"` -- warns but does not block
- `noLeakedRender: "info"` (nursery) -- informational only

**Exclusions:**
- `routeTree.gen.ts` -- auto-generated (correct to exclude)
- `.claude/settings.local.json` -- local config
- `specs/archive/**` -- archived specs
- `charts/**` -- Helm charts
- `src/types/bun.d.ts` -- type definitions

**Test file relaxations:**
- `noExplicitAny: "off"` -- acceptable for test mocks
- `noNonNullAssertion: "off"` -- acceptable for test assertions
- `useYield: "off"` -- needed for generator mocks
- `noConstructorReturn: "off"` -- needed for mock classes

### CQ-015: Current Lint Status (MEDIUM)

Running `biome lint .` reports:
- **14 warnings** (`lint/complexity/noBannedTypes`)
- **270 infos** (`lint/nursery/noLeakedRender`)
- **0 errors**

The 14 `noBannedTypes` warnings indicate use of `{}` or `Function` types that should be replaced with more specific types. The 270 `noLeakedRender` infos flag React `{condition && <Component/>}` patterns where the condition could be falsy (0, NaN, ''). These are categorized as nursery/info so they do not block CI, but they represent potential rendering bugs.

### CQ-016: Biome Suppression Comments (LOW)

**Count: 33 `biome-ignore` comments** in production code

Breakdown by rule:
| Rule | Count | Justified? |
|------|-------|-----------|
| `useExhaustiveDependencies` | 10 | Yes -- intentional dependency exclusions with comments explaining why |
| `noStaticElementInteractions` | 6 | Yes -- drag handles, resize handles |
| `noExplicitAny` | 4 | Mostly yes -- generic fan-out callbacks, DB type regressions |
| `noNonNullAssertion` | 2 | Yes -- guarded by runtime checks documented in comments |
| `noAutofocus` | 1 | Yes -- intentional focus on expansion |
| `useSemanticElements` | 2 | Yes -- interactive cards that can't use button |
| `noDangerouslySetInnerHtml` | 1 | Yes -- shiki pre-escaped HTML |
| `noThenProperty` | 1 | Yes -- mock for Drizzle query chain |
| Other | 6 | Various justified cases |

All suppressions include explanatory comments. This is a healthy sign of disciplined lint management.

---

## 7. Console.log Audit

### CQ-017: Excessive Bare Console Calls in Production Code (HIGH)

**Total: 855 console.* calls** in 120 production files (excluding tests)

| Type | Count |
|------|-------|
| `console.error` | 420 |
| `console.log` | 224 |
| `console.warn` | 171 |
| `console.debug` | ~40 |

**Top 10 Offenders:**

| Rank | File | Count |
|------|------|-------|
| 1 | `src/services/task-creation.service.ts` | 118 |
| 2 | `src/server/api.ts` | 30 |
| 3 | `src/lib/streams/client.ts` | 29 |
| 4 | `src/lib/task-creation/hooks.ts` | 21 |
| 5 | `src/lib/sandbox/k8s-workspace-initializer.ts` | 21 |
| 6 | `src/lib/sandbox/providers/docker-provider.ts` | 20 |
| 7 | `src/server/routes/task-creation.ts` | 19 |
| 8 | `src/app/routes/index.tsx` | 19 |
| 9 | `src/services/marketplace.service.ts` | 17 |
| 10 | `src/lib/agents/stream-handler.ts` | 16 |

**Analysis:** The codebase has a structured logger (`src/lib/logging/logger.ts`) used by **38 files** via `createLogger()`. However, **120 files** bypass it with bare `console.*` calls. The structured logger provides:
- JSON output in production
- Human-readable output in development
- Log level filtering
- Context prefixes
- Request ID tracking

The 118 console calls in `task-creation.service.ts` are particularly egregious -- many contain emoji markers suggesting debug sessions that were never cleaned up.

**Recommendation:** Adopt `createLogger` universally. Add a custom Biome rule or ESLint rule to disallow bare `console.*` calls.

---

## 8. TODO/FIXME/HACK Audit

### CQ-018: TODO Inventory (MEDIUM)

**Total: 27 TODO comments** in production code

| Priority | Category | File | Line | Comment |
|----------|----------|------|------|---------|
| **High** | Missing API | `src/app/routes/sessions/$sessionId.tsx` | 142 | `TODO: Add API endpoint for agent pause` |
| **High** | Missing API | `src/app/routes/sessions/$sessionId.tsx` | 153 | `TODO: Add API endpoint for agent resume` |
| **High** | Missing API | `src/app/routes/sessions/$sessionId.tsx` | 164 | `TODO: Add API endpoint for agent stop` |
| **High** | Missing API | `src/app/routes/agents/$agentId.tsx` | 93 | `TODO: Add API endpoint for updating agent config` |
| **High** | Missing API | `src/app/routes/projects/$projectId/tasks/$taskId.tsx` | 83 | `TODO: Add API endpoint for updating tasks` |
| **High** | Missing API | `src/app/routes/projects/$projectId/tasks/$taskId.tsx` | 87 | `TODO: Add API endpoint for deleting tasks` |
| **Medium** | Missing Impl | `src/app/routes/templates/project.tsx` | 205 | `TODO: Implement edit dialog` |
| **Medium** | Missing Impl | `src/app/routes/templates/org.tsx` | 101 | `TODO: Implement edit dialog` |
| **Medium** | Missing API | `src/app/routes/queue/index.tsx` | 26 | `TODO: Add API endpoint for queue status` |
| **Medium** | Missing Impl | `src/app/components/features/new-project-dialog.tsx` | 574 | `TODO: Implement recent repos discovery via API` |
| **Medium** | Missing API | `src/app/routes/projects/$projectId/index.tsx` | 255 | `TODO: Implement code review approval/rejection API` |
| **Medium** | Missing API | `src/app/routes/projects/$projectId/index.tsx` | 270 | `TODO: Implement code review approval/rejection API` |
| **Medium** | Path Validation | `src/app/components/features/global-shortcuts.tsx` | 332 | `TODO: Add API endpoint for path validation` |
| **Medium** | Path Validation | `src/app/routes/projects/index.tsx` | 239 | `TODO: Add API endpoint for path validation` |
| **Medium** | Path Validation | `src/app/routes/index.tsx` | 267 | `TODO: Add API endpoint for path validation` |
| **Medium** | SDK Migration | `src/lib/sandbox/providers/agentcore-sandbox-instance.ts` | 49 | `TODO: Replace with @aws-sdk/client-bedrock-agentcore` |
| **Medium** | SDK Migration | `src/lib/sandbox/providers/agentcore-sandbox-instance.ts` | 193 | `TODO: Replace manual fetch + SigV4 signing with SDK` |
| **Low** | Feature Gate | `src/services/durable-streams.service.ts` | 208 | `TODO: Pending GA -- swarm features` |
| **Low** | Feature Gate | `src/services/container-agent.service.ts` | 163 | `TODO: Pending GA -- swarm features` |
| **Low** | Feature Gate | `src/lib/agents/stream-handler.ts` | 25 | `TODO: Pending GA -- swarm and remote session` |
| **Low** | Feature Gate | `src/lib/agents/agentcore-bridge.ts` | 44 | `TODO: Pending GA -- swarm features` |
| **Low** | Feature Gate | `src/lib/agents/container-bridge.ts` | 57 | `TODO: Pending GA -- swarm features` |
| **Low** | State Tracking | `src/services/marketplace.service.ts` | 455 | `TODO: Track individual plugin enable state` |
| **Low** | Mock Data | `src/app/components/features/agent-topology/detail-panel/activity-tab.tsx` | 21 | `TODO: Replace with real activity events` |
| **Low** | Test Fix | `src/services/__tests__/worktree.service.test.ts` | 147 | `TODO: Fix this test` |
| **Low** | Incomplete | `src/app/components/features/workflow-designer/index.tsx` | 452 | `TODO: Fetch full workflow data from API` |

**Key Themes:**
- **9 missing API endpoints** referenced in UI code -- UI has stubs but no backend support
- **3 repeated "path validation" TODOs** -- same missing endpoint referenced 3 times
- **5 "Pending GA" feature gates** for swarm/team mode -- tracked in comments
- **2 AWS SDK migration TODOs** -- manual SigV4 signing needs SDK replacement

No FIXME, HACK, or WORKAROUND comments were found, which is positive.

---

## 9. Test Coverage Gaps

### Test Suite Summary

| Metric | Value |
|--------|-------|
| Total test files | 60 (in `src/`) + tests in `tests/` |
| Passing test files | 210 of 228 (17 skipped, 1 failing) |
| Total tests | 6,458 (6,184 passed, 25 failed, 249 skipped) |
| Failing tests | 25 in `tests/lib/streams/client.test.ts` |
| Test/Production LOC ratio | 29,102 / 163,177 = 17.8% |

### CQ-019: Failing Test File (HIGH)

**File:** `tests/lib/streams/client.test.ts`
**Failures:** 25 out of 45 tests failing

These appear to be assertion mismatches against the `DurableStreamsClient` API (URL patterns and error handling). This test file has likely drifted from the implementation after a refactor.

### CQ-020: Low Coverage Thresholds (MEDIUM)

**Current thresholds in vitest.config.ts:**
- Statements: 48%
- Branches: 42%
- Functions: 48%
- Lines: 48%

These are quite low for a production application. Industry norms target 70-80% for critical services.

### CQ-021: Services Without Tests (HIGH)

**25 service files** lack corresponding test files:

| Service | Risk |
|---------|------|
| `container-agent.service.ts` (3,076 LOC!) | Critical -- largest file, no tests |
| `durable-streams.service.ts` (800 LOC) | High -- SSE infrastructure |
| `scheduler.service.ts` (931 LOC) | High -- cron scheduling |
| `plan-mode.service.ts` | High -- plan approval flow |
| `agent/agent-execution.service.ts` | High -- agent lifecycle |
| `agent/agent-crud.service.ts` | Medium |
| `agent/agent-queue.service.ts` | Medium |
| `terraform-compose.service.ts` | Medium |
| `terraform-registry.service.ts` | Medium |
| `terraform-sync-scheduler.ts` | Low |
| `template-sync-scheduler.ts` | Low |
| `event-source.service.ts` | Medium |
| `event-processing.service.ts` | Medium |
| `event-subscription.service.ts` | Medium |
| `settings.service.ts` | Medium |
| `marketplace.service.ts` | Medium |
| `api-key.service.ts` | High -- security critical |
| `github-token.service.ts` | High -- token management |
| `rbac-token.service.ts` | High -- security critical |
| `rbac.service.ts` | High -- access control |
| `sandbox.service.ts` | Medium |
| `session/session-presence.service.ts` | Low |
| `session/session-stream.service.ts` | Medium |
| `session/session-crud.service.ts` | Medium |
| `task-transitions.ts` | Medium |

### CQ-022: Route Modules Without Tests (MEDIUM)

**12 route files** have no corresponding test files:

| Route Module | Endpoints |
|-------------|-----------|
| `team-members.ts` | RBAC team member management |
| `team-invitations.ts` | Invitation workflow |
| `teams.ts` | Team CRUD |
| `webhooks.ts` | Webhook handling |
| `settings.ts` | Global settings |
| `sandbox-status.ts` | Container health |
| `workflow-designer.ts` | AI workflow generation |
| `rbac-tokens.ts` | API token management |
| `terraform.ts` | Terraform compose API |
| `tags.ts` | Tag CRUD |
| `team-github-token.ts` | Team GitHub token management |
| `invitation-accept.ts` | Invitation acceptance |

### CQ-023: Frontend Code Excluded from Coverage (LOW)

The vitest coverage configuration explicitly excludes all frontend code:
```typescript
exclude: [
  'src/app/**/*.ts',
  'src/app/**/*.tsx',
  // ...
]
```

This means 0% coverage tracking for UI components. While E2E tests exist via Playwright, there are no unit-level coverage metrics for the ~400 frontend source files.

---

## 10. CI/CD Pipeline

### CQ-024: CI Pipeline Analysis (MEDIUM)

**File:** `.github/workflows/ci.yml`

The pipeline has two jobs:

**Job 1: lint-and-typecheck**
- Runs on `ubuntu-latest`
- Bun 1.3.10
- Caches `~/.bun/install/cache`
- `bun run typecheck` (tsc --noEmit)
- `bun run check` (biome check -- lint + format)

**Job 2: test** (depends on lint-and-typecheck)
- Same setup
- `bun run test:coverage`
- Uploads coverage artifact

**Gaps:**
1. **No build step in CI** -- `bun run build` is not executed. The Vite build could fail without CI catching it.
2. **No E2E tests in CI** -- Playwright tests exist but are not run.
3. **No security audit step** -- No `bun audit` or equivalent vulnerability scanning.
4. **No dependency caching between jobs** -- Both jobs independently install dependencies and cache. Could share via artifacts.
5. **Sequential jobs** -- `test` depends on `lint-and-typecheck`, adding latency. These could run in parallel since they are independent.
6. **No branch protection evidence** -- No required status checks configured in the workflow.

**Positive:**
- Concurrency control with `cancel-in-progress: true`
- Frozen lockfile enforcement
- Coverage artifact upload

---

## Additional Findings

### CQ-025: Type Safety is Strong (POSITIVE)

The TypeScript configuration enables strict mode with additional strictness flags:
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `noUncheckedIndexedAccess: true`
- `verbatimModuleSyntax: true`

Only 4 `as any` casts exist in hand-written production code (excluding the auto-generated `routeTree.gen.ts`). This is exceptional for a 163K-line codebase.

### CQ-026: Type Assertions Count (LOW)

| Pattern | Count | Notes |
|---------|-------|-------|
| `as any` (hand-written) | 4 | Excellent -- minimal |
| `as unknown` | 38 | Reasonable for DB driver compatibility casts |
| `biome-ignore` | 33 | All documented with reasons |

### CQ-027: Structured Error Handling is Partially Adopted (MEDIUM)

The codebase has two error handling patterns:
1. **Structured errors** via `createError()` from `src/lib/errors/base.ts` -- 298 usages
2. **Raw throws** via `throw new Error(...)` -- 72 usages

The structured error catalog (`src/lib/errors/`) has 14 error modules with typed error codes. However, 72 raw `throw new Error` calls bypass this system, particularly in:
- `src/lib/crypto/server-encryption.ts` (4 throws)
- `src/server/routes/sandbox.ts` (3 throws)
- `src/server/routes/workflow-designer.ts` (3 throws)
- `src/lib/terraform/registry-client.ts` (3 throws)

### CQ-028: Result Type Pattern (POSITIVE)

The codebase consistently uses a `Result<T, E>` pattern (`src/lib/utils/result.ts`) for service-layer error handling instead of throwing exceptions. This is a significant positive for error handling discipline and makes error flows explicit at the type level.

---

## Priority Summary

### Critical (Fix Immediately)
| ID | Finding | Impact |
|----|---------|--------|
| CQ-019 | 25 failing tests in client.test.ts | CI health |
| CQ-021 | 25 services without tests (incl. 3,076-line container-agent) | Reliability |

### High Priority (Fix This Quarter)
| ID | Finding | Impact |
|----|---------|--------|
| CQ-017 | 855 bare console.* calls (118 in one file) | Observability, log noise |
| CQ-007 | container-agent.service.ts at 3,076 LOC | Maintainability |
| CQ-008 | api.ts God File at 1,847 LOC | Maintainability |
| CQ-001 | 9x duplicated migration try/catch in api.ts | Code duplication |
| CQ-020 | Coverage thresholds at 42-48% | Quality assurance |

### Medium Priority (Fix Next Quarter)
| ID | Finding | Impact |
|----|---------|--------|
| CQ-022 | 12 route modules without tests | Coverage gap |
| CQ-002 | 150x duplicated error serialization pattern | Code duplication |
| CQ-003 | 456 error response patterns / 85 isValidId checks | Boilerplate |
| CQ-024 | No build step, no E2E, no security audit in CI | CI completeness |
| CQ-009 | task-creation.service.ts with 118 console calls | Debug noise |
| CQ-010 | Raw SQL in schema.ts duplicating ORM definitions | Maintenance burden |
| CQ-015 | 14 noBannedTypes warnings | Type safety |
| CQ-018 | 27 TODOs including 9 missing API endpoints | Feature completeness |
| CQ-027 | 72 raw throw new Error bypassing error catalog | Error consistency |

### Low Priority (Track)
| ID | Finding | Impact |
|----|---------|--------|
| CQ-004 | Duplicated logging helpers in container-agent | Minor duplication |
| CQ-005 | Commented-out swarm features | Code noise |
| CQ-011 | Mixed import style (alias vs relative) | Cognitive load |
| CQ-012 | Large barrel re-exports (38 in schema) | Bundle awareness |
| CQ-016 | 33 biome-ignore suppressions (all documented) | Acceptable |
| CQ-023 | Frontend excluded from coverage metrics | Visibility gap |
| CQ-026 | 38 as unknown casts for DB compat | Acceptable |
