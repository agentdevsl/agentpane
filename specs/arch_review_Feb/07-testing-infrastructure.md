# 07 - Testing Infrastructure

## 1. Overview

AgentPane's testing infrastructure is **well-developed and mature**, featuring a multi-layered approach spanning unit tests, route tests, service tests, component tests, integration tests, and E2E tests. The project uses **Vitest 4.0.16** as the primary test runner with **jsdom** as the default test environment, **@testing-library/react** for component testing, and a custom **agent-browser** CLI wrapper for E2E testing.

The test suite totals approximately **145 test files** (36 in `src/`, 109 in `tests/`) with test infrastructure spread across:

| Layer | Location | Test Files | Framework |
|-------|----------|-----------|-----------|
| Unit (src) | `src/**/__tests__/*.test.ts` | ~36 | Vitest |
| Unit (tests) | `tests/**/*.test.ts` | ~45 | Vitest |
| Component | `tests/components/*.test.tsx` | ~12 | Vitest + @testing-library/react |
| API Route | `tests/api/*.test.ts` | ~7 | Vitest + Hono `.request()` |
| Integration | `tests/server/*.test.ts` | ~2 | Vitest |
| E2E (Vitest) | `tests/e2e/**/*.test.ts` | ~12 | Vitest + agent-browser |
| AI UI Scripts | `tests/ai-ui-tests/*.sh` | ~4 | Shell + agent-browser CLI |
| Package: cli-monitor | `packages/cli-monitor/src/__tests__/` | ~6 | Vitest |
| Package: agent-sandbox-sdk | `packages/agent-sandbox-sdk/__tests__/` | ~6 | Vitest |

**Key strengths:**
- Comprehensive mock infrastructure with type-safe builders (`tests/mocks/`)
- Database-backed test factories for all core entities (`tests/factories/`)
- In-memory SQLite for test isolation with proper FK constraint handling
- Good coverage thresholds enforced (74% statements, 64% branches, 80% functions, 74% lines)
- CI pipeline runs lint, typecheck, and tests with coverage on every PR

**Key gaps:**
- No Playwright configuration despite `@playwright/test` being a devDependency
- E2E tests use a custom `agent-browser` CLI wrapper rather than a standard framework
- Coverage excludes the entire `src/app/` directory (all frontend components)
- Dual mock systems exist (legacy `services.ts` vs. newer `mock-services.ts`), creating confusion
- Some integration tests test local helper functions rather than actual server behavior

---

## 2. Unit Test Setup

### 2.1 Vitest Configuration

**File**: `vitest.config.ts:1-65`

The root-level Vitest configuration defines:

```typescript
export default defineConfig({
  test: {
    globals: true,              // No need to import describe/it/expect
    environment: 'jsdom',       // DOM environment for component tests
    setupFiles: ['./tests/setup.ts'],
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'dist', '.claude', '.worktrees', '**/_archived/**', 'packages/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 74,
        branches: 64,
        functions: 80,
        lines: 74,
      },
    },
  },
});
```

Notable configuration decisions:
- **jsdom environment** is set globally even though most backend tests do not need it. This adds unnecessary overhead to service and API tests.
- **Packages are excluded** from the root test run; each package has its own `vitest.config.ts`.
- **Path aliases** are configured both in `test.alias` (for service mocking) and `resolve.alias` (for `@/` imports).

### 2.2 Global Setup

**File**: `tests/setup.ts:1-19`

The setup file performs three critical operations:
1. Extends expect with `@testing-library/jest-dom/vitest` matchers
2. Stubs `ANTHROPIC_API_KEY` and `NODE_ENV` environment variables
3. Manages the in-memory test database lifecycle (beforeAll/afterEach/afterAll)

### 2.3 Test Patterns and Style

Tests follow a consistent pattern using:
- **describe/it blocks** with clear behavioral descriptions
- **Result type checks**: `expect(result.ok).toBe(true)` followed by narrowed access `if (result.ok) { expect(result.value.x)... }`
- **Service tests** instantiate services with manual mock objects cast via `as never`
- **Route tests** use Hono's built-in `.request()` method for in-process HTTP testing

---

## 3. Test Factories

**Directory**: `tests/factories/`

Six database-backed factories exist, all following a consistent two-function pattern:

| Factory | File | Functions |
|---------|------|-----------|
| Project | `project.factory.ts` | `buildProject()` / `createTestProject()` |
| Task | `task.factory.ts` | `buildTask()` / `createTestTask()` / `createTasksInColumns()` |
| Agent | `agent.factory.ts` | `buildAgent()` / `createTestAgent()` |
| Session | `session.factory.ts` | `buildSession()` / `createTestSession()` |
| Worktree | `worktree.factory.ts` | `buildWorktree()` / `createTestWorktree()` |
| AgentRun | `agent-run.factory.ts` | `buildAgentRun()` / `createTestAgentRun()` |

**Pattern:**
- `build*()` returns a plain object (for unit tests that do not need database)
- `createTest*()` inserts into the test database via Drizzle and returns the full entity
- `createTest*s()` (plural) creates batches
- All use `@paralleldrive/cuid2` for ID generation
- Defaults are sensible and composable via `Partial<>` overrides

The `createTasksInColumns()` helper is particularly well-designed for Kanban board testing, creating tasks across multiple columns in a single call.

**File**: `tests/factories/task.factory.ts:78-100`

---

## 4. Mocking Strategy

### 4.1 Mock Architecture

**Directory**: `tests/mocks/`

The mock infrastructure is the most sophisticated part of the testing system, with a comprehensive barrel export at `tests/mocks/index.ts`. It provides:

| Mock Category | File | Purpose |
|--------------|------|---------|
| Database builders | `mock-builders.ts` | Type-safe Drizzle query chain mocks |
| Service mocks | `mock-services.ts` | Interface-typed service mocks with defaults |
| Legacy service mocks | `services.ts` | Older `vi.fn()` based service mocks |
| API/Route mocks | `mock-api.ts` | Hono context, middleware, SSE mocks |
| Git mocks | `mock-git.ts` | Architecture-aware git command runner |
| Legacy git mocks | `git.ts` | Simple Bun shell template literal mock |
| External mocks | `external.ts` | Claude SDK, Durable Streams, Octokit |
| Sandbox mocks | `mock-sandbox.ts` | Docker sandbox, provider mocks |
| Container bridge | `mock-container-bridge.ts` | Agent event stream simulation |
| Streams mocks | `mock-streams.ts` | Durable streams event collector |
| Agent lifecycle | `mock-agent-lifecycle.ts` | Agent configuration and running state |
| Scenarios | `mock-scenarios.ts` | Fully-wired multi-service test setups |

### 4.2 Database Mock Builders

**File**: `tests/mocks/mock-builders.ts:1-379`

The `createMockDatabase()` function is a standout piece of infrastructure that provides a fully type-safe Drizzle mock covering:
- `query.{table}.findFirst/findMany` for all 20 tables
- Chainable `insert().values().returning()` / `onConflictDoUpdate()`
- Chainable `update().set().where().returning()`
- Chainable `delete().where().run()`
- Chainable `select().from().where().all()`
- `transaction()` that passes the mock db to the callback

### 4.3 Service Mock Duplication

There are **two competing mock systems** for services:

1. **`mock-services.ts`** (newer): Uses duck-typed interfaces with `Result<>` return types and provides `createMock*()` functions that return properly typed objects
2. **`services.ts`** (legacy): Uses `ReturnType<typeof vi.fn>` for all methods and provides similar `createMock*()` functions

Both are re-exported from `tests/mocks/index.ts` with suffix disambiguation (e.g., `createMockSessionServiceLegacy`), but the coexistence creates confusion about which to use.

### 4.4 External Module Mocking

**File**: `tests/mocks/external.ts:1-44`

Global mocks for external dependencies:
- `@anthropic-ai/claude-agent-sdk` - Mocked as an async generator yielding text/tool_use/done events
- `@durable-streams/client` - Mocked DurableStreamsClient with publish/subscribe/close
- `octokit` - Mocked Octokit with repos.get, repos.getContent, pulls.create

### 4.5 Agent Stream Simulation

**File**: `tests/helpers/simulate-agent-stream.ts:1-78`

Provides three async generator factories that simulate the Claude Agent SDK stream message sequence:
- `createPlanningStream()` - Planning session ending with ExitPlanMode
- `createExecutionStream()` - Execution completing with result
- `createPlanningStreamWithAssistantAfterExit()` - Edge case with assistant message after ExitPlanMode

---

## 5. Integration Tests

### 5.1 API Route Integration

**Files**: `tests/api/*.test.ts` (~7 files)

API tests use `vi.hoisted()` and `vi.mock()` to replace service modules, then test the Hono route handlers directly via `.request()`. This pattern tests:
- Request validation (missing params, invalid IDs)
- Service call delegation
- Response formatting (ok/error envelope)
- HTTP status code mapping

Example from `tests/api/tasks.test.ts:77-102`:
```typescript
vi.mock('../../src/services/task.service.js', () => ({
  TaskService: class { list = taskServiceMocks.list; ... }
}));
// ... later
const response = await tasksRoute.request('http://localhost/?projectId=...');
```

### 5.2 Server Integration Tests

**File**: `tests/server/api-integration.test.ts:1-1505`

This file is the largest integration test at ~1505 lines. However, it **does not test the actual server**. Instead, it tests:
- Route pattern matching (via a local `matchRoute()` function)
- CORS header generation (via a local `getCorsHeaders()` function)
- JSON response format validation (via local `jsonSuccess()`/`jsonError()` functions)
- ID validation logic (via a local `isValidId()` function)
- Query parameter parsing (via local parse functions)
- Request body validation patterns

These are essentially **unit tests for API design patterns**, not true integration tests that start the server and make HTTP requests.

### 5.3 Database Integration

**File**: `tests/helpers/database.ts:1-153`

The database helper supports two modes:
- **SQLite (default)**: In-memory `better-sqlite3` with inline SQL migrations
- **Postgres**: Real PostgreSQL via `postgres` client with Drizzle migration runner

The SQLite mode provides excellent test isolation with zero disk I/O. The `clearTestDatabase()` function deletes records in FK-safe order.

The `seedTestDatabase()` function creates configurable numbers of projects, agents, and tasks for scenario testing.

---

## 6. E2E Tests

### 6.1 Agent-Browser Setup

**File**: `tests/e2e/setup.ts:1-248`

E2E tests use a custom wrapper around `agent-browser` CLI (a Playwright-based browser automation tool) rather than using Playwright directly. The setup provides:

- `open()` / `goto()` / `close()` - Navigation
- `click()` / `fill()` / `type()` / `press()` - Interaction
- `exists()` / `getText()` / `getAttribute()` - Queries
- `waitForSelector()` / `waitForNetworkIdle()` - Waiting
- `screenshot()` / `drag()` / `hover()` - Advanced actions
- Retry logic for transient failures (3 attempts with 1s delay)
- Conditional skip when `E2E_BASE_URL` is not set

### 6.2 E2E Test Categories

**Directory**: `tests/e2e/`

| Test File | Purpose |
|-----------|---------|
| `smoke.test.ts` | Server health, HTML rendering, static assets |
| `kanban-workflow.test.ts` | Dashboard, task cards, drag-and-drop, approval |
| `workflow.test.ts` | End-to-end workflow scenarios |
| `project-workflow.test.ts` | Project creation and management |
| `agent-session.test.ts` | Agent session monitoring |
| `components/*.test.ts` | Navigation, sidebar, settings, dialogs, kanban, session |

E2E tests are resilient to missing data -- they use try/catch blocks and `.catch(() => {})` to handle cases where no projects or tasks exist, falling back to `expect(true).toBe(true)`.

### 6.3 AI UI Test Scripts

**Directory**: `tests/ai-ui-tests/`

Four shell scripts provide an alternative browser testing mechanism:
- `smoke.sh` - Homepage load, title check, interactive elements, navigation links
- `navigation.sh` - Page navigation verification
- `projects.sh` - Project management UI
- `settings.sh` - Settings page verification

These are orchestrated by `run-all.sh` which checks server availability first.

### 6.4 Playwright Status

Despite `@playwright/test` (^1.58.1) and `playwright` (^1.57.0) being listed as devDependencies, **no `playwright.config.ts` file exists** and no tests use the Playwright test runner directly. All E2E tests go through the `agent-browser` CLI wrapper or shell scripts.

---

## 7. Coverage Analysis

### 7.1 Coverage Thresholds

**File**: `vitest.config.ts:46-51`

| Metric | Threshold | Assessment |
|--------|-----------|------------|
| Statements | 74% | Below the spec target of 80% |
| Branches | 64% | Significantly below the spec target of 80% |
| Functions | 80% | Meets spec target |
| Lines | 74% | Below the spec target of 80% |

### 7.2 Coverage Inclusions/Exclusions

**Included**: `src/**/*.ts`, `src/**/*.tsx`

**Excluded**:
- Test files (`*.test.ts`, `*.spec.ts`)
- Type declaration files (`*.d.ts`)
- Type-only files (`types.ts`, `index.ts`)
- **All frontend code** (`src/app/**/*.ts`, `src/app/**/*.tsx`)
- All type directories (`src/types/**`, `src/lib/types/**`)

### 7.3 What's Covered

**Well-covered areas:**
- Task service (CRUD, column transitions, approval, rejection, diff) -- ~35 tests
- Project service (create, delete, validation) -- ~4 tests
- Agent service (create, start, stop, concurrency) -- extensive tests
- Worktree service (create, remove, prune, merge, diff)
- API routes for tasks, projects, agents, sessions, worktrees, cli-monitor
- Error catalog validation
- Config loading and deep-merge utilities
- Cursor-based pagination
- State machine transitions
- Database schema validation
- Bootstrap hooks and initialization
- Durable streams provider

**Packages with own test suites:**
- `cli-monitor`: 6 test files (parser, watcher, daemon, session-store, client, mocks)
- `agent-sandbox-sdk`: 6 test files (builders, client, CRUD, exec, kubeconfig, schemas)

### 7.4 Critical Gaps

- **No frontend component coverage** in metrics (excluded from coverage config)
- **No tests for `stream-handler.ts`** (the critical Claude SDK integration file)
- **No tests for `agent-execution.service.ts`** (the agent lifecycle orchestrator)
- **No tests for Terraform compose service** (`terraform-compose.service.ts`)
- **No tests for container-agent.service.ts** (the Docker sandbox orchestrator)
- **No E2E tests in CI** -- only unit tests run in the GitHub Actions workflow

---

## 8. CI/CD Integration

**File**: `.github/workflows/ci.yml:1-75`

The CI pipeline has two sequential jobs:

1. **lint-and-typecheck**: Runs `bun run typecheck` and `bun run check` (Biome lint + format)
2. **test** (depends on lint-and-typecheck): Runs `bun run test:coverage` and uploads the coverage report as an artifact

**Configuration:**
- Runs on `ubuntu-latest`
- Uses Bun 1.3.6
- Caches `~/.bun/install/cache`
- Concurrency group per branch with cancel-in-progress
- Triggered on push to `main` and PRs targeting `main`

**Not included in CI:**
- E2E tests (`test:e2e`)
- AI UI tests (`test:ui`)
- Integration tests (`test:integration`)
- K8s tests (`test:k8s`, `test:k8s-e2e`)
- Build verification (`npm run build`)

---

## 9. Findings

### TI-001: Coverage Thresholds Below Specification Target
**Severity**: Medium
**Files**: `vitest.config.ts:46-51`
**Description**: The coverage thresholds (74/64/80/74) are below the specification targets (80/80/80/80) defined in `specs/application/testing/test-infrastructure.md:59-63`. Branch coverage at 64% is particularly concerning for a codebase with many conditional flows (state machines, error handling, Result types).
**Recommendation**: Incrementally raise thresholds toward 80% across all metrics. Prioritize branch coverage improvements in service layer code where `if (result.ok)` patterns create many branches.

### TI-002: Frontend Code Entirely Excluded from Coverage
**Severity**: High
**Files**: `vitest.config.ts:40-41`
**Description**: The coverage configuration excludes `src/app/**/*.ts` and `src/app/**/*.tsx`, meaning zero frontend code contributes to coverage metrics. While component tests exist in `tests/components/`, their coverage is not measured. This creates a blind spot for the entire React UI layer.
**Recommendation**: Remove the `src/app/` exclusion from coverage config or create a separate coverage profile for frontend code. At minimum, track component test coverage separately.

### TI-003: Dual Mock Systems Create Confusion
**Severity**: Medium
**Files**: `tests/mocks/services.ts:1-369`, `tests/mocks/mock-services.ts:1-505`, `tests/mocks/index.ts:184-196`
**Description**: Two parallel mock systems exist for services. The `services.ts` file (legacy) uses `ReturnType<typeof vi.fn>` while `mock-services.ts` (newer) uses duck-typed interfaces with Result types. Both are re-exported from `index.ts` with "Legacy" suffixes. Tests in `src/services/__tests__/` create local mock builders, while tests in `tests/` use either system. Inline mocks in `src/services/__tests__/project.service.test.ts:6-19` create yet another ad-hoc mock pattern.
**Recommendation**: Consolidate on the `mock-services.ts` interface-based approach. Migrate tests using legacy mocks. Deprecate `services.ts` and remove the ad-hoc `createDbMock()` pattern by using `createMockDatabase()` from `mock-builders.ts`.

### TI-004: Integration Tests Do Not Test Real Server
**Severity**: Medium
**Files**: `tests/server/api-integration.test.ts:1-1505`
**Description**: Despite being named "API Integration Tests", this 1500-line file tests local helper functions (route matching regex, CORS header generation, JSON response formatting) rather than the actual Hono server. It re-implements API logic in the test file and then asserts against it, testing the test's own code rather than the production code. For example, `matchRoute()` at line 22 and `isValidId()` at line 799 are locally defined, not imported from source.
**Recommendation**: Refactor to test the actual API server using Hono's `app.request()` method (as already done in `src/server/routes/__tests__/tasks.test.ts`). The route matching and validation tests should import functions from source code, not redefine them.

### TI-005: No Tests for Critical Agent Execution Path
**Severity**: High
**Files**: `src/lib/agents/stream-handler.ts`, `src/services/agent/agent-execution.service.ts`
**Description**: The core agent execution pipeline -- which manages the Claude SDK session, streams events, handles plan mode transitions, and coordinates worktrees -- has no dedicated test coverage. The `simulate-agent-stream.ts` helper exists but no tests import it. These files contain the most complex business logic in the application.
**Recommendation**: Create integration tests for `stream-handler.ts` using the existing `createPlanningStream()`/`createExecutionStream()` helpers from `tests/helpers/simulate-agent-stream.ts`. Test the event emission pipeline, ExitPlanMode detection, and error handling paths.

### TI-006: E2E Tests Not in CI Pipeline
**Severity**: Medium
**Files**: `.github/workflows/ci.yml:44-75`
**Description**: The CI pipeline only runs `test:coverage` (unit tests). E2E tests (`test:e2e`), AI UI tests (`test:ui`), integration tests (`test:integration`), and build verification are not executed in CI. This means regressions in navigation, visual rendering, and end-to-end workflows are not caught before merge.
**Recommendation**: Add a separate CI job for E2E tests that starts the dev server, waits for readiness, and runs `test:e2e`. Consider running a build step to catch build failures.

### TI-007: Playwright Installed but Unused
**Severity**: Low
**Files**: `package.json:46,59`
**Description**: Both `@playwright/test` (^1.58.1) and `playwright` (^1.57.0) are listed as devDependencies, but no `playwright.config.ts` exists and no tests use the Playwright API directly. E2E tests instead use the `agent-browser` CLI wrapper which shells out to `bunx agent-browser` per operation. This adds process-spawn overhead to every test interaction.
**Recommendation**: Either adopt Playwright directly for E2E tests (benefiting from its mature API, auto-wait, trace viewer, and CI support) or remove the unused dependencies to reduce install size. If `agent-browser` is preferred, document the rationale.

### TI-008: E2E Tests Use `expect(true).toBe(true)` as Fallback
**Severity**: Low
**Files**: `tests/e2e/kanban-workflow.test.ts:73-74,109,139,174`
**Description**: Multiple E2E tests catch all errors and fall back to `expect(true).toBe(true)`, making them always pass regardless of whether the tested functionality works. For example, the drag-and-drop test at line 113-140 catches all failures and unconditionally passes.
**Recommendation**: Use `it.skipIf(!serverRunning)` (already used in smoke tests) instead of try/catch with unconditional pass. Tests that cannot verify their assertions should be skipped, not silently passed.

### TI-009: jsdom Environment Used for All Tests
**Severity**: Low
**Files**: `vitest.config.ts:7`
**Description**: The global Vitest environment is set to `jsdom`, which adds DOM simulation overhead to every test file including pure backend service tests, API route tests, and database tests. Only component tests in `tests/components/` actually need a DOM environment.
**Recommendation**: Change the default environment to `node` and annotate component test files with `// @vitest-environment jsdom` or use a separate test configuration for component tests.

### TI-010: Ad-hoc `createDbMock()` Pattern in Service Tests
**Severity**: Low
**Files**: `src/services/__tests__/task.service.test.ts:6-14`, `src/services/__tests__/project.service.test.ts:6-19`, `src/services/__tests__/agent.service.test.ts:7-16`
**Description**: Service tests in `src/services/__tests__/` define local `createDbMock()` functions that manually construct Drizzle chain mocks with nested `vi.fn()` calls and `as never` casts. The centralized `createMockDatabase()` from `tests/mocks/mock-builders.ts` provides the same functionality with full type safety and consistent defaults.
**Recommendation**: Migrate `src/services/__tests__/` tests to use `createMockDatabase()` from the mock builders. This reduces boilerplate and eliminates `as never` casts.

### TI-011: No Tests for Terraform Compose or Container Agent Services
**Severity**: Medium
**Files**: `src/services/terraform-compose.service.ts`, `src/services/container-agent.service.ts`
**Description**: The Terraform No-Code Compose service (streaming HCL generation, code extraction) and the Container Agent service (Docker sandbox orchestration, credential management, agent runner lifecycle) have no test coverage. Both are complex services with multiple failure modes.
**Recommendation**: Add unit tests for the Terraform compose pipeline (prompt building, HCL code extraction, SSE event handling) and the container agent lifecycle (initialization stages, credential writing, container creation, status transitions).

### TI-012: Test Specification Divergence
**Severity**: Low
**Files**: `specs/application/testing/test-infrastructure.md:1-80`, `vitest.config.ts:1-65`
**Description**: The actual Vitest configuration diverges from the specification in several ways: the spec says `environment: 'node'` but implementation uses `jsdom`; the spec says `pool: 'forks'` with isolation but implementation uses defaults; the spec sets coverage thresholds at 80% but implementation uses 74/64/80/74; the spec says coverage includes `lib/**`, `app/**`, `db/**` but implementation uses `src/**` with `src/app/` excluded.
**Recommendation**: Update the specification to reflect the actual implementation, or align the implementation to match the specification. Keep one source of truth.

---

## 10. Summary

The testing infrastructure demonstrates strong architectural thinking with its type-safe mock builders, database-backed factories, and multi-layer test strategy. The most impactful improvements would be:

1. **Add tests for critical untested services** (stream-handler, agent-execution, terraform-compose, container-agent) -- these represent the highest-risk code in the application
2. **Consolidate mock systems** to eliminate the dual services.ts / mock-services.ts confusion
3. **Include E2E tests in CI** to catch regression in user-facing workflows
4. **Fix coverage configuration** to include frontend code and raise thresholds toward 80%
5. **Refactor integration tests** to test actual production code rather than reimplemented helpers

The existing infrastructure provides a solid foundation that, with targeted improvements, can achieve comprehensive coverage of the application's complex agent orchestration and real-time streaming capabilities.
