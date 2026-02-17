# 02 - Backend API & Services Architecture Review

**Review Date:** 2026-02-17
**Reviewer:** reviewer-2
**Scope:** API routes, service layer, middleware, error handling, data validation, Hono setup

---

## 1. Overview

The AgentPane backend is a Hono-based REST API running on Bun (port 3001) alongside the Vite frontend dev server (port 3000). The architecture follows a layered pattern:

```
Hono Router (router.ts)
  -> Middleware Chain (CORS, logging, request ID, security headers, rate limiting, auth)
  -> Route Handlers (src/server/routes/*.ts)
  -> Service Layer (src/services/*.ts)
  -> Database (Drizzle ORM -> SQLite/PostgreSQL)
```

**Key Strengths:**
- Clean factory-pattern route creation with dependency injection via `createXxxRoutes(deps)`.
- Consistent `Result<T, E>` monad pattern throughout the service layer.
- Well-structured error catalog with typed error objects.
- Dual-database support (SQLite for development, PostgreSQL for production).
- Good separation between route handlers and business logic.

**Key Concerns:**
- The main entry point (`api.ts`) is a 1,419-line monolith responsible for DB init, migration, service wiring, sandbox provider setup, and server lifecycle.
- Inconsistent validation patterns across route modules (some use `parseBody()`, others do inline `safeParse()`).
- Routes directly access `db` and import schema tables, bypassing the service layer.
- Authentication middleware is permissive in development mode (always allows access).
- No transaction boundaries for multi-step database operations.

---

## 2. API Route Organization

### 2.1 Route Structure

Routes are organized in `src/server/routes/` with 20+ route modules, each following a consistent factory pattern:

```typescript
export function createXxxRoutes(deps: XxxDeps) {
  const app = new Hono();
  // ... route definitions
  return app;
}
```

**Route modules (27 files):**

| Route File | Base Path | Endpoints |
|---|---|---|
| `health.ts` | `/api/health` | Health checks |
| `projects.ts` | `/api/projects` | CRUD + summaries |
| `tasks.ts` | `/api/tasks` | CRUD + move + plan approval |
| `agents.ts` | `/api/agents` | CRUD + start/stop/pause/resume |
| `sessions.ts` | `/api/sessions` | CRUD + events + SSE stream + export |
| `worktrees.ts` | `/api/worktrees` | CRUD + commit + merge + diff + prune |
| `settings.ts` | `/api/settings` | Get/Put key-value settings |
| `git.ts` | `/api/git` | Status, branches, commits |
| `github.ts` | `/api/github` | OAuth, installations |
| `terraform.ts` | `/api/terraform` | Registry + compose |
| `sandbox.ts` | `/api/sandbox-configs`, `/api/sandbox/k8s` | Sandbox configs |
| `sandbox-status.ts` | `/api/sandbox/status` | Provider health |
| `filesystem.ts` | `/api/filesystem` | Discover repos |
| `cli-monitor.ts` | `/api/cli-monitor` | CLI session monitoring |
| `templates.ts` | `/api/templates` | Template management |
| `workflows.ts` | `/api/workflows` | Workflow management |
| `marketplaces.ts` | `/api/marketplaces` | Plugin marketplace |
| `api-keys.ts` | `/api/keys` | API key management |
| `webhooks.ts` | `/api/webhooks` | Webhook handlers |
| `task-creation.ts` | `/api/tasks/create-with-ai` | AI-powered task creation |
| `workflow-designer.ts` | `/api/workflow-designer` | Workflow design UI backend |

### 2.2 RESTfulness Assessment

Most routes follow REST conventions well:
- `GET /api/tasks` (list), `POST /api/tasks` (create), `GET /api/tasks/:id` (read), `PUT /api/tasks/:id` (update), `DELETE /api/tasks/:id` (delete).
- Sub-resources use nested paths: `GET /api/tasks/:id/diff`, `PATCH /api/tasks/:id/move`.

**Issues with REST conventions:**
- `POST /api/tasks/:id/approve-plan` and `POST /api/tasks/:id/reject-plan` use action-verbs in URLs. A more RESTful approach would be `PATCH /api/tasks/:id/plan` with `{ action: "approve" }`.
- `PUT /api/tasks/:id` is used for partial updates (should be `PATCH`). See `src/server/routes/tasks.ts:119`.
- The "summaries" endpoint at `GET /api/projects/summaries` must be registered before `GET /api/projects/:id` to avoid being matched as a project ID. This is fragile and relies on route registration order. See `src/server/routes/projects.ts:147` vs `:254`.

### 2.3 Response Envelope

All endpoints use a consistent envelope:

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "..." } }

// List
{ "ok": true, "data": { "items": [...], "nextCursor": null, "hasMore": false, "totalCount": N } }
```

This is well-structured but `nextCursor` is always `null` and `hasMore` is always `false` in many endpoints, suggesting cursor-based pagination is spec'd but not implemented.

---

## 3. Service Layer

### 3.1 Service Patterns

Services are organized in `src/services/` with two patterns:

**Simple services** (single file):
- `task.service.ts`, `project.service.ts`, `worktree.service.ts`, `settings.service.ts`, `api-key.service.ts`, `marketplace.service.ts`, `sandbox-config.service.ts`

**Decomposed services** (directory with facade):
- `agent.service.ts` -> `agent/agent-crud.service.ts`, `agent/agent-execution.service.ts`, `agent/agent-queue.service.ts`
- `session.service.ts` -> `session/session-crud.service.ts`, `session/session-presence.service.ts`, `session/session-stream.service.ts`
- `cli-monitor/` -> `cli-monitor.service.ts`

The decomposed services use a Facade pattern where the main service class delegates to focused sub-services. This is a good pattern for managing complexity.

### 3.2 Dependency Injection

Dependencies are injected via constructor parameters for services and via the `RouterDependencies` interface for routes. All wiring happens in `api.ts`.

```typescript
// src/server/router.ts:109-129
export interface RouterDependencies {
  db: Database;
  githubService: GitHubTokenService;
  apiKeyService: ApiKeyService;
  templateService: TemplateService;
  // ... 16 more dependencies
}
```

**Issue:** The dependency graph is assembled manually with no DI container. Service creation order matters -- `TaskService` is created with a stub worktree service and later patched via `setWorktreeService()` (see `api.ts:346-360` and `api.ts:535-540`). This temporal coupling is a code smell.

### 3.3 Result Pattern

All service methods return `Result<T, E>`:

```typescript
// src/lib/utils/result.ts
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
```

This is consistently used across the service layer with typed error objects. The pattern works well and avoids exception-based error handling. Utility functions (`ok`, `err`, `map`, `mapErr`, `unwrap`, `unwrapOr`) are provided.

### 3.4 Business Logic Placement

Some business logic leaks into route handlers instead of being in services:

- **Project summaries** (`src/server/routes/projects.ts:147-251`): The `/api/projects/summaries` endpoint contains ~100 lines of N+1 query logic (fetching tasks, agents, and individual task titles for each project) directly in the route handler. The `ProjectService` has a `listWithSummaries()` method that duplicates this logic. This should be consolidated.

- **SSE stream management** (`src/server/routes/sessions.ts:352-559`): The SSE streaming endpoint contains ~200 lines of complex stream setup, event replay from both in-memory and database storage, real-time subscription, and keep-alive ping logic. This should be extracted into a dedicated service or utility.

---

## 4. Middleware Chain

### 4.1 Middleware Stack

The middleware is applied in `router.ts:134-146`:

```typescript
app.use('*', cors({ ... }));          // CORS
app.use('*', logger());               // Hono built-in request logger
app.use('*', requestIdMiddleware);     // X-Request-Id generation
app.use('*', securityHeaders);         // Security headers
app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000 }));  // Rate limiting
app.use('/api/*', authMiddleware);     // Authentication
```

**Security headers** (`router.ts:66-79`):
- Sets `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`.
- In production, adds `Strict-Transport-Security` and `Content-Security-Policy`.
- Good baseline security posture.

### 4.2 Authentication

The auth middleware (`src/lib/api/auth-middleware.ts`) supports three methods:
1. Session cookie (`agentpane_session`)
2. Bearer token (API key)
3. Development mode bypass

**Critical concern:** In development mode (which is the default when `NODE_ENV` is unset), the middleware always returns success with a `local-dev` user, even with no credentials at all. See `auth-middleware.ts:130-134`. This means the authentication middleware is effectively a no-op in development. While this is convenient for local development, it means auth code paths are never exercised during normal development, increasing the risk of auth bugs going undetected.

Additionally, token validation is only performed when `AuthOptions` validators are provided, but the `authMiddleware` in `router.ts:81-97` calls `getAuthContext(c.req.raw)` without passing any validators. This means even in production, session cookies and Bearer tokens are accepted without database validation -- the middleware just extracts a pseudo-userId from the token prefix. See `auth-middleware.ts:77-81` and `auth-middleware.ts:101-105`.

### 4.3 Rate Limiting

The rate limiter (`src/lib/api/rate-limiter.ts`) uses in-memory fixed-window counters per IP address. This is appropriate for a single-instance deployment but will not work correctly with multiple instances (as noted in the file's own documentation). The limit of 200 requests per minute per IP is reasonable.

**Minor issue:** The rate limiter uses `x-forwarded-for` header for IP detection (`rate-limiter.ts:47-50`). In production behind a reverse proxy, this header should be trusted; without a trusted proxy, it can be spoofed to bypass rate limiting.

---

## 5. Error Handling

### 5.1 Error Catalog

The codebase has a structured error catalog in `src/lib/errors/`:

| File | Error Prefix | Count |
|---|---|---|
| `base.ts` | `AppError` | Base type + class |
| `task-errors.ts` | `TASK_*` | 10 errors |
| `project-errors.ts` | `PROJECT_*` | 6 errors |
| `agent-errors.ts` | `AGENT_*` | Not examined in detail |
| `session-errors.ts` | `SESSION_*` | Not examined in detail |
| `validation-errors.ts` | `VALIDATION_*` | Not examined in detail |
| `concurrency-errors.ts` | `CONCURRENCY_*` | Not examined in detail |

Errors are created via a factory function:

```typescript
// src/lib/errors/base.ts
export const createError = (code, message, status, details?) => ({ code, message, status, details });
```

### 5.2 Error Handling Consistency

**Route-level error handling:** Every route handler wraps service calls in try/catch and returns a generic `DB_ERROR` or `SERVER_ERROR` response. This provides a safety net but loses specific error information. Example pattern:

```typescript
// src/server/routes/tasks.ts:60-63
} catch (error) {
  console.error('[Tasks] List error:', error);
  return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tasks' } }, 500);
}
```

**Global error handler** (`router.ts:233-247`): The `app.onError()` handler catches unhandled exceptions and returns a structured error response, hiding internal details in production.

**Issue:** Route handlers catch exceptions and return generic errors (e.g., `DB_ERROR`) while the service layer returns specific typed errors via `Result`. The catch blocks mask the actual service-layer error information. Additionally, there are 174 `console.log/error/warn` calls across the route files, using raw `console` instead of the structured `createLogger` used elsewhere.

### 5.3 Duplicate Transition Logic

Task transition validation exists in two places with different rules:

1. `src/lib/errors/task-errors.ts:5-9` -- Strict transitions:
   ```
   backlog -> [in_progress]
   in_progress -> [waiting_approval, backlog]
   waiting_approval -> [verified, in_progress]
   verified -> []
   ```

2. `src/services/task-transitions.ts:13-18` -- Permissive transitions (allows any column to move to any other column except itself).

The service layer uses `task-transitions.ts` (permissive), while the error file defines stricter transitions that are never used at runtime. This is confusing and could lead to bugs if someone assumes the strict transitions are enforced.

---

## 6. Data Validation

### 6.1 Validation Schemas

Centralized Zod schemas are in `src/server/validation.ts`:
- `idSchema` -- CUID2/kebab-case identifiers
- `createTaskSchema`, `updateTaskSchema`, `moveTaskSchema`
- `createAgentSchema`
- `createSessionSchema`, `exportSessionSchema`
- `createWorktreeSchema`, `mergeWorktreeSchema`, `commitWorktreeSchema`

The `parseBody()` helper provides a consistent validation interface.

### 6.2 Validation Inconsistencies

**Three different validation patterns are used across routes:**

1. **Centralized `parseBody()` helper** (recommended pattern):
   ```typescript
   // src/server/routes/tasks.ts:70-71
   const parsed = parseBody(createTaskSchema, rawBody);
   if (!parsed.ok) return parsed.response;
   ```

2. **Inline `safeParse()` with manual error formatting:**
   ```typescript
   // src/server/routes/projects.ts:80-92
   const parsed = createProjectSchema.safeParse(body);
   if (!parsed.success) {
     return json({ ok: false, error: { code: 'VALIDATION_ERROR', message: ... } }, 400);
   }
   ```

3. **Manual validation with no schema:**
   ```typescript
   // src/server/routes/agents.ts:73-84
   if (!body.projectId || !body.name || !body.type) {
     return json({ ok: false, error: { code: 'MISSING_PARAMS', message: '...' } }, 400);
   }
   ```

Pattern (1) is the best approach. Patterns (2) and (3) should be migrated to use `parseBody()` for consistency.

### 6.3 Query Parameter Validation

Query parameters (`limit`, `offset`, `projectId`) are parsed with `parseInt()` and no bounds checking:

```typescript
// src/server/routes/tasks.ts:27-28
const limit = parseInt(c.req.query('limit') ?? '50', 10);
const offset = parseInt(c.req.query('offset') ?? '0', 10);
```

If a client sends `limit=999999`, it could cause performance issues. There is no validation that `limit` and `offset` are positive integers within reasonable bounds.

---

## 7. Findings

### BA-001: Monolithic API Entry Point
**Severity:** Medium
**Files:** `src/server/api.ts:1-1419`
**Description:** The API entry point is a 1,419-line file responsible for environment validation, database initialization (with 8 migration steps), service instantiation (20+ services), sandbox provider initialization (450+ lines including K8s CRD auto-install, minikube auto-start, and auto-heal logic), server startup, and graceful shutdown. The `initSandboxProvider()` function alone spans lines 664-1168 (504 lines).
**Recommendation:** Extract into focused modules: `db-init.ts`, `service-registry.ts`, `sandbox-init.ts`, `shutdown.ts`. Use a service container pattern to manage dependency lifetimes and initialization order.

### BA-002: Authentication Middleware Ineffective in Development
**Severity:** High
**Files:** `src/lib/api/auth-middleware.ts:108-135`, `src/server/router.ts:81-97`
**Description:** In development mode (default), authentication always succeeds with `userId: 'local-dev'`. More critically, even when session cookies or Bearer tokens are provided, no database validation is performed because `getAuthContext()` is called without `AuthOptions` validators. Session tokens and API keys are accepted at face value with only the first 8 characters used as a pseudo-userId (e.g., `session:abcd1234`).
**Recommendation:** Pass real validators (`validateSessionToken`, `validateApiKey`) to `getAuthContext()` in the router's auth middleware. At minimum, validate Bearer tokens against the `api_keys` table. Consider requiring `SKIP_AUTH=true` explicitly for dev mode bypass rather than defaulting to open access.

### BA-003: N+1 Query Pattern in Project Summaries
**Severity:** Medium
**Files:** `src/server/routes/projects.ts:147-251`
**Description:** The `/api/projects/summaries` endpoint executes N+1 queries: for each project, it fetches all tasks, then all agents, then for each running agent, fetches the agent's current task title individually. With 10 projects and 5 running agents, this is 10 + 10 + 50 = 70 queries per request. The same pattern is duplicated in `src/services/project.service.ts:183-255`.
**Recommendation:** Replace with a single aggregation query using SQL `GROUP BY` and `JOIN`, or use Drizzle's relational queries with eager loading. Consolidate the logic into `ProjectService.listWithSummaries()` and remove the duplicate implementation from the route handler.

### BA-004: Temporal Coupling in Service Initialization
**Severity:** Medium
**Files:** `src/server/api.ts:346-360`, `src/server/api.ts:535-540`, `src/server/api.ts:1154`
**Description:** `TaskService` is created with a stub worktree service that returns `NOT_IMPLEMENTED` errors, then later patched via `setWorktreeService()`. Similarly, `setContainerAgentService()` is called after sandbox initialization. This temporal coupling means services are in a partially-initialized state during startup, and any request that hits the stub methods would get confusing errors.
**Recommendation:** Use a lazy initialization pattern or a service container that resolves dependencies at first use rather than requiring a specific initialization order.

### BA-005: Inconsistent Validation Patterns Across Routes
**Severity:** Low
**Files:** `src/server/routes/projects.ts:80-92`, `src/server/routes/agents.ts:57-98`, `src/server/routes/settings.ts:86-98`
**Description:** Three different validation approaches are used: centralized `parseBody()` with Zod schemas, inline `safeParse()` with manual error formatting, and manual property checking without any schema. This makes it harder to maintain consistent error responses and validation behavior.
**Recommendation:** Migrate all routes to use the `parseBody()` helper from `validation.ts`. Move inline schemas (like `createProjectSchema` in `projects.ts:13-17` and `updateSettingsSchema` in `settings.ts:13-15`) to the centralized `validation.ts` file.

### BA-006: Duplicate Task State Transition Definitions
**Severity:** Medium
**Files:** `src/lib/errors/task-errors.ts:5-9`, `src/services/task-transitions.ts:13-18`
**Description:** Task column transitions are defined twice with conflicting rules. The error catalog defines strict transitions (e.g., `backlog` can only go to `in_progress`), while `task-transitions.ts` allows any column to transition to any other column. The runtime uses the permissive version, making the error catalog's transitions misleading dead code.
**Recommendation:** Remove the transition map from `task-errors.ts` and have `TaskErrors.INVALID_TRANSITION` reference the canonical `task-transitions.ts` for allowed transitions. Decide whether the permissive or strict model is correct and enforce it consistently.

### BA-007: Route Handlers Bypass Service Layer
**Severity:** Medium
**Files:** `src/server/routes/projects.ts:1-489`, `src/server/routes/settings.ts:1-127`, `src/server/routes/git.ts:1-453`
**Description:** Several route modules import DB schemas and Drizzle ORM operators directly, executing queries inside route handlers instead of delegating to the service layer. For example, `projects.ts` imports `agents`, `projects`, and `tasks` from the schema and performs direct DB queries for CRUD operations, despite `ProjectService` existing. `settings.ts` performs raw DB operations without any service. `git.ts` executes shell commands directly via `commandRunner`.
**Recommendation:** Route handlers should only orchestrate: parse input, call service method, format response. All DB access and shell commands should go through the service layer. Create a `SettingsService` (one exists at `src/services/settings.service.ts`) and route through it. Move git command execution to a `GitService`.

### BA-008: Unvalidated Query Parameters
**Severity:** Low
**Files:** `src/server/routes/tasks.ts:27-28`, `src/server/routes/sessions.ts:125-126`, `src/server/routes/projects.ts:35`, `src/server/routes/git.ts:234`
**Description:** Query parameters like `limit`, `offset`, and filter values are parsed with `parseInt()` without validation. Values like `limit=-1`, `limit=NaN`, or `limit=999999` are accepted without error. The `column` parameter in tasks is cast with `as` without validation: `c.req.query('column') as TaskColumn | undefined`.
**Recommendation:** Create Zod schemas for query parameters and validate them at the route level. At minimum, clamp `limit` to a reasonable range (e.g., 1-200) and ensure `offset >= 0`.

### BA-009: SSE Connection Management Complexity
**Severity:** Medium
**Files:** `src/server/routes/sessions.ts:117, 352-559`
**Description:** The SSE streaming endpoint is ~200 lines of complex logic embedded directly in the route handler. It manages a module-level `sseConnections` Map, implements event replay from both in-memory and database storage, handles subscription lifecycle, and runs keep-alive pings. The cleanup function captures variables from the outer scope through closure, making it prone to stale references.
**Recommendation:** Extract SSE stream management into a dedicated `SSEStreamManager` class that handles connection lifecycle, replay, subscription, and cleanup. This would improve testability and reduce the complexity of the route handler.

### BA-010: Logging Inconsistency
**Severity:** Low
**Files:** All route files (174 occurrences of `console.log/error/warn`)
**Description:** Route handlers use raw `console.log`, `console.error`, and `console.warn` for logging (174 occurrences across 17 route files), while the server infrastructure uses the structured `createLogger` utility (e.g., `src/server/api.ts:10`, `src/server/router.ts:53`). This means route-level logs lack structured metadata (request IDs, timestamps, log levels) that the logger provides.
**Recommendation:** Replace all `console.*` calls in route handlers with the structured logger, passing the request ID from middleware context for correlation.

### BA-011: InMemoryDurableStreamsServer Embedded in API Entry Point
**Severity:** Low
**Files:** `src/server/api.ts:364-483`
**Description:** The `InMemoryDurableStreamsServer` class (120 lines) is defined inline within the API entry point file. It implements an in-memory event store with subscriptions. Its `subscribe()` method has an infinite polling loop with a 100ms sleep (`api.ts:434-444`) that will never terminate, which is a resource leak if used outside of the real-time subscriber path.
**Recommendation:** Extract `InMemoryDurableStreamsServer` to its own file (e.g., `src/lib/streams/in-memory-server.ts`). The infinite `subscribe()` generator should include a cancellation mechanism or document that the `addRealtimeSubscriber` path should be preferred.

### BA-012: SSE Endpoint Manually Sets CORS Headers
**Severity:** Low
**Files:** `src/server/routes/sessions.ts:550-558`
**Description:** The SSE stream endpoint constructs a raw `Response` object and manually sets CORS headers from the `corsHeaders` constant in `shared.ts`, instead of relying on the Hono CORS middleware that is applied globally. The `corsHeaders` in `shared.ts:6-10` are hardcoded to `http://localhost:3000`, which may not match the `CORS_ORIGIN` environment variable used by the middleware.
**Recommendation:** Let the Hono CORS middleware handle CORS for SSE responses. If the raw Response bypasses middleware, consider using `c.header()` to set the response headers within the Hono context, or configure the SSE endpoint to go through the standard middleware chain.

### BA-013: Missing Transaction Boundaries
**Severity:** Medium
**Files:** `src/services/task.service.ts:321-410`, `src/server/routes/projects.ts:417-424`, `src/server/api.ts:248-338`
**Description:** Multi-step database operations are performed without transactions. For example, `TaskService.moveColumn()` creates a session record (line 363), updates the task (line 384), and triggers a container agent (line 406) -- if the agent trigger fails, the task and session are left in an inconsistent state. Project deletion (`projects.ts:417-424`) deletes tasks, then agents, then the project in three separate queries without a transaction -- a failure after deleting tasks but before deleting the project would leave orphaned data.
**Recommendation:** Wrap multi-step DB operations in database transactions using Drizzle's `db.transaction()` API. At minimum, project deletion and task column moves should be transactional.

### BA-014: Shell Command Injection Mitigations Are Partial
**Severity:** Medium
**Files:** `src/server/routes/git.ts:171-173, 272-273`, `src/server/shared.ts:40-49`
**Description:** The `isValidBranchName()` function validates branch names before shell interpolation, which is good. However, in `git.ts:272-273`, the `targetBranch` variable is interpolated into a shell command (`git log ${targetBranch} ...`) after validation, but the `limit` parameter is also interpolated (`-n ${limit}`) without shell escaping. While `limit` is parsed as an integer (limiting injection risk), the pattern of string interpolation into shell commands is fragile. The `commandRunner.exec()` method uses `sh -c` (see `api.ts:512`), meaning all commands go through shell interpretation.
**Recommendation:** Use array-based command execution (e.g., `Bun.spawn(['git', 'log', branch, '-n', String(limit)]...)`) instead of shell string interpolation via `sh -c`. This eliminates the entire class of shell injection vulnerabilities.

### BA-015: Unused SSETokenService
**Severity:** Low
**Files:** `src/server/sse-token.service.ts:1-431`
**Description:** A comprehensive `SSETokenService` class (431 lines) exists with token generation, validation, revocation, and cleanup. However, it does not appear to be used anywhere -- SSE endpoints in `sessions.ts` do not require token authentication, and the service is not imported in `api.ts` or `router.ts`. A singleton instance is exported but never consumed.
**Recommendation:** Either integrate the SSE token service into the SSE endpoints (which would improve security for SSE connections, especially since EventSource does not support custom headers), or remove the dead code.

---

## 8. Summary

| Severity | Count | Key Areas |
|---|---|---|
| High | 1 | Authentication bypass (BA-002) |
| Medium | 7 | Monolith entry point (BA-001), N+1 queries (BA-003), temporal coupling (BA-004), duplicate transitions (BA-006), service bypass (BA-007), SSE complexity (BA-009), missing transactions (BA-013), shell injection (BA-014) |
| Low | 5 | Validation inconsistency (BA-005), query params (BA-008), logging (BA-010), embedded class (BA-011), manual CORS (BA-012), unused code (BA-015) |

### Priority Recommendations

1. **Immediate (High):** Fix authentication to validate tokens against the database in production mode (BA-002).
2. **Short-term (Medium):** Extract `api.ts` monolith into focused modules (BA-001). Add transaction boundaries for multi-step operations (BA-013). Switch to array-based command execution (BA-014).
3. **Medium-term (Medium):** Consolidate service layer usage -- route handlers should not access DB directly (BA-007). Fix N+1 query patterns (BA-003). Resolve duplicate transition definitions (BA-006).
4. **Long-term (Low):** Standardize validation patterns (BA-005). Adopt structured logging in routes (BA-010). Integrate or remove SSE token service (BA-015).
