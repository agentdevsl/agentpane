# Architecture Review: Error Handling & Type Safety

**Area**: 08 - Error Handling & Type Safety
**Reviewer**: Claude Opus 4.6
**Date**: 2026-03-18
**Scope**: `src/lib/errors/`, `src/lib/validation/`, `src/lib/types/`, `src/lib/utils/result.ts`, and error/type patterns throughout the codebase

---

## Executive Summary

The AgentPane codebase exhibits a well-designed error handling architecture built on a `Result<T, E>` type pattern with a structured `AppError` system. Adoption is strong across 63 files importing the Result type, covering all major services. The TypeScript configuration is strict with `noUncheckedIndexedAccess` enabled. However, several areas need attention: the error catalog spec is outdated relative to implementation, some routes bypass Zod validation in favor of manual `as` casts, there is a dual validation system with redundant schemas, and catch blocks in route handlers consistently use `console.error` instead of the structured logger.

**Overall Grade**: B+

| Criterion | Rating | Notes |
|-----------|--------|-------|
| Error Catalog Completeness | B | 21 error modules implemented; spec lists 44 codes but implementation has 140+ |
| Result Type Usage | A | Consistent adoption across 63 importing files |
| Zod Schema Coverage | B+ | 29 files with Zod schemas; some routes still use manual `as` casts |
| TypeScript Strict Mode | A | All strict flags enabled, `noUncheckedIndexedAccess: true` |
| Type Assertion Safety | B | Most `as any` in generated code or test files; a few risky patterns |
| Error Propagation | B+ | Consistent `Result` flow; catch blocks mask original errors |
| Runtime Type Safety | B+ | Zod at API boundary; DB results not validated at runtime |

---

## 1. Error Catalog Completeness

### EH-001: Spec ErrorCode Type Outdated (Severity: Medium)

The spec at `specs/application/errors/error-catalog.md` defines an `ErrorCode` union type (lines 792-852) listing 44 error codes. The actual implementation has grown to **140+ distinct error codes** across 18 error modules. The spec is missing entire domains:

| Error Module | Error Codes in Impl | In Spec? |
|---|---|---|
| `agent-errors.ts` | 7 | Yes |
| `task-errors.ts` | 10 | Partial (missing `TASK_AGENT_NOT_RUNNING`, `TASK_AGENT_STOP_FAILED`) |
| `project-errors.ts` | 6 | Partial (missing `PROJECT_NOT_A_GIT_REPO`) |
| `session-errors.ts` | 4 | Yes |
| `worktree-errors.ts` | 8 | Yes |
| `concurrency-errors.ts` | 3 | Yes |
| `github-errors.ts` | 8 | Yes |
| `validation-errors.ts` | 5 | Partial (missing `INVALID_URL`) |
| `sandbox-errors.ts` | 33 | Partial (2 codes listed) |
| `sandbox-config-errors.ts` | 7 | No |
| `k8s-errors.ts` | 31 | No |
| `nomad-errors.ts` | 17 | No |
| `terraform-errors.ts` | 8 | No |
| `template-errors.ts` | 8 | No |
| `marketplace-errors.ts` | 7 | No |
| `plan-mode-errors.ts` | 17 | No |
| `event-errors.ts` | 11 + 8 schedule | No |
| `agentcore-errors.ts` | 9 | No |

The `ErrorCode` type from the spec is also not exported from `src/lib/errors/index.ts` and does not exist at runtime. The spec references a `workflow-status.ts` module that does not exist in the implementation.

**File**: `/Users/simon.lynch/git/agentpane_nocode/specs/application/errors/error-catalog.md`

### EH-002: Spec References Non-Existent Modules (Severity: Low)

The spec mentions `lib/errors/workflow-status.ts` with `WorkflowStatus` containing `APPROVAL_REQUIRED`, `AGENT_PAUSED`, `TASK_QUEUED`. This module does not exist. The `WorkflowStatus` type in the codebase is an unrelated enum (`draft | published | archived`) used in workflow designer schemas.

**File**: `specs/application/errors/error-catalog.md` (lines 575-597)

### EH-003: Index Does Not Export All Error Modules (Severity: Low)

`src/lib/errors/index.ts` exports 14 of the 18 error modules. Missing exports:

- `plan-mode-errors.ts` (not re-exported)
- `marketplace-errors.ts` (not re-exported)
- `terraform-errors.ts` (not re-exported)
- `agentcore-errors.ts` (not re-exported)

These are imported directly by consumers, but the barrel export is incomplete.

**File**: `/Users/simon.lynch/git/agentpane_nocode/src/lib/errors/index.ts`

---

## 2. Result Type Usage

### EH-004: Result Type - Strong Adoption (Severity: Informational)

The `Result<T, E>` type from `src/lib/utils/result.ts` is well-implemented and consistently adopted:

- **63 files** import from `result.ts`
- All service layer methods return `Result<T, DomainError>`
- Route handlers consistently check `result.ok` before proceeding

```typescript
// src/lib/utils/result.ts - Clean, minimal implementation
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

Utility functions (`map`, `mapErr`, `unwrap`, `unwrapOr`) are provided but `unwrap` is rarely used, which is good practice -- most code explicitly checks `result.ok`.

### EH-005: ContainerAgentService Uses Result but with `unknown` Error Type (Severity: Medium)

The `ContainerAgentTrigger` interface in `task.service.ts` declares:

```typescript
// src/services/task.service.ts:78
startAgent: (input: StartAgentInput) => Promise<Result<void, unknown>>;
stopAgent: (taskId: string) => Promise<Result<void, unknown>>;
```

Using `unknown` as the error type defeats the purpose of typed error handling. The actual implementation returns `Result<void, SandboxError>`. The interface should be tightened.

**File**: `/Users/simon.lynch/git/agentpane_nocode/src/services/task.service.ts`, line 78-79

### EH-006: Result Type Not Used in Bootstrap Phases (Severity: Low)

Bootstrap phases in `src/lib/bootstrap/phases/` use the Result type in their signatures but several internal operations throw exceptions rather than returning Results, relying on the outer try/catch in the bootstrap service. This is acceptable for startup code but inconsistent with the service layer pattern.

---

## 3. Zod Schema Coverage

### EH-007: Dual Validation System Creates Confusion (Severity: Medium)

There are **two** validation systems:

1. **`src/server/validation.ts`** (Hono-specific) - Used by route handlers directly via `parseBody()` / `parseJsonBody()`. Returns `{ ok, data } | { ok, response }` with a ready-made `Response` object.

2. **`src/lib/api/validation.ts`** (framework-agnostic) - Returns `Result<T, ValidationError>` aligned with the service-layer pattern.

Both define their own `parseBody` function. The Hono-specific version is used in route handlers (`tasks.ts`, `sessions.ts`, `worktrees.ts`, etc.), while the framework-agnostic version exists but is imported less. This leads to:

- Two different `parseBody` signatures in the codebase
- Two different error response formats for validation failures

**Files**:
- `/Users/simon.lynch/git/agentpane_nocode/src/server/validation.ts`
- `/Users/simon.lynch/git/agentpane_nocode/src/lib/api/validation.ts`

### EH-008: Duplicate Schema Definitions (Severity: Medium)

Two schema files define overlapping schemas with slightly different constraints:

| Schema | `src/server/validation.ts` | `src/lib/api/schemas.ts` |
|--------|--------------------------|-------------------------|
| `createTaskSchema` | title max 500 | title max 200 |
| `updateTaskSchema` | description max 10000 | description max 5000 |
| `moveTaskSchema` | has `startAgent` field | no `startAgent` field |
| `createSessionSchema` | idSchema (regex) | cuidSchema (isCuid) |
| `createWorktreeSchema` | has `agentId`, `taskTitle` | no `agentId`, `taskTitle` |

The `src/server/validation.ts` schemas are the ones actually used by route handlers. The `src/lib/api/schemas.ts` schemas appear to be an older or alternative set. Having two sets risks applying the wrong one.

**Files**:
- `/Users/simon.lynch/git/agentpane_nocode/src/server/validation.ts`
- `/Users/simon.lynch/git/agentpane_nocode/src/lib/api/schemas.ts`

### EH-009: Routes Using Manual `as` Casts Instead of Zod (Severity: High)

Several route handlers cast `c.req.json()` output with `as` instead of using Zod validation:

| File | Line | Pattern |
|------|------|---------|
| `routes/github.ts` | 82 | `(await c.req.json()) as { url: string; destination: string }` |
| `routes/github.ts` | 187 | `(await c.req.json()) as { ... }` |
| `routes/github.ts` | 381 | `(await c.req.json()) as { token: string }` |
| `routes/task-creation.ts` | 86 | `body as { projectId: string }` |
| `routes/task-creation.ts` | 115 | `body as { sessionId: string; message: string }` |
| `routes/agents.ts` | 57-71 | Manual body typing without Zod |
| `routes/tasks.ts` | 295 | `(await c.req.json()) as { reason?: string }` |
| `routes/sessions.ts` | 40 | `event.data as Record<string, unknown>` -- repeated 3+ times |

These bypass input validation entirely. Malformed input will not be caught, and error messages will be confusing (property access on undefined rather than a clear validation error).

**Files**: `src/server/routes/github.ts`, `src/server/routes/task-creation.ts`, `src/server/routes/agents.ts`

### EH-010: Zod Coverage Inventory (Severity: Informational)

Routes with Zod validation (29 files with Zod imports):

- Tasks (create, update, move): validated via `server/validation.ts`
- Sessions (create, export): validated
- Worktrees (create, merge, commit): validated
- Sandbox configs (create, update): validated via `lib/api/schemas.ts`
- Templates (create, update, list): validated
- Workflows (create, update, list): validated
- Settings (get, update): validated
- Events / cron sources: validated via `lib/validation/cron-event-sources.ts`
- Terraform registries: validated (inline schemas in `routes/terraform.ts`)
- RBAC (teams, members, tokens, tags): validated via `server/validation.ts`

Routes **without** Zod validation:
- `routes/github.ts` (clone, import, set-token)
- `routes/task-creation.ts` (start, message, accept, reject, etc.)
- `routes/agents.ts` (create, update -- manual checks only)
- `routes/filesystem.ts` (directory listing)
- `routes/cli-monitor.ts` (partial -- some endpoints validated, some not)

---

## 4. TypeScript Strict Mode

### EH-011: Strict Config is Excellent (Severity: Informational)

`tsconfig.json` has all important strict flags enabled:

```json
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true
}
```

Notable: `exactOptionalPropertyTypes: false` is the only strict flag not enabled. This is a reasonable choice as it can be disruptive to enable retroactively.

No `@ts-ignore` or `@ts-expect-error` comments were found in any source files. This is excellent.

**File**: `/Users/simon.lynch/git/agentpane_nocode/tsconfig.json`

---

## 5. Type Assertion Audit

### EH-012: `as any` Assertions Breakdown (Severity: Medium)

Total `as any` occurrences: **58** across source files.

| Category | Count | Risk |
|----------|-------|------|
| `routeTree.gen.ts` (auto-generated) | 49 | None -- TanStack Router codegen |
| Test files (`*.test.ts`) | 9 | Low -- test mocking pattern |
| `streams/client.ts` | 3 | Medium -- generic fan-out callbacks |
| `db/use-collection-query.ts` | 2 | Medium -- TanStack DB type regression workaround |
| `task-creation.service.ts` | 1 | Medium -- parsing untyped JSON |

The three `as any` casts in `src/lib/streams/client.ts` (lines 1443-1446) are properly annotated with `biome-ignore` comments explaining the reason (generic fan-out across callback shapes). Similarly, the `use-collection-query.ts` casts are documented as a workaround for a TanStack DB v0.5.29 regression.

The `task-creation.service.ts` cast at line 483 (`obj.questions as Array<any>`) is the most concerning -- it processes untyped JSON from Claude SDK responses without runtime validation. The code does defensive checking afterward, but the `any` type suppresses TypeScript's ability to catch mistakes.

**Files**:
- `/Users/simon.lynch/git/agentpane_nocode/src/lib/streams/client.ts`, line 1443
- `/Users/simon.lynch/git/agentpane_nocode/src/lib/db/use-collection-query.ts`, line 20
- `/Users/simon.lynch/git/agentpane_nocode/src/services/task-creation.service.ts`, line 483

### EH-013: Risky `as` Type Assertions in Route Handlers (Severity: Medium)

Session export formatting functions use repeated `as string` and `as Record<string, unknown>` casts on `event.data`:

```typescript
// src/server/routes/sessions.ts:40-53
const data = event.data as Record<string, unknown>;
const role = (data.role as string) || 'unknown';
const content = (data.content as string) || '';
const toolName = (data.toolName as string) || (data.tool as string) || ...
```

These are not validated at runtime. If `event.data` is null, a string, or has a different shape, these casts will produce incorrect output silently rather than failing safely.

**File**: `/Users/simon.lynch/git/agentpane_nocode/src/server/routes/sessions.ts`, lines 40-53, 87-91

### EH-014: Task Routes Column Cast (Severity: Low)

```typescript
// src/server/routes/tasks.ts:20-26
const column = c.req.query('column') as
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'waiting_approval'
  | 'verified'
  | undefined;
```

The query parameter is cast to a union type without validation. Any invalid string (e.g., `?column=foo`) will pass the type system but produce unexpected DB query behavior.

**File**: `/Users/simon.lynch/git/agentpane_nocode/src/server/routes/tasks.ts`, line 20

---

## 6. `any` / `unknown` Usage

### EH-015: Explicit `any` Type Annotations (Severity: Low)

Only **3** explicit `: any` type annotations exist outside test/generated files:

| File | Line | Usage |
|------|------|-------|
| `task-creation.service.ts` | 483 | `Array<any>` -- parsing AI-generated JSON |
| `streams/client.ts` | 1443 | `(...args: any[])` -- generic callback fan-out |
| `db/use-collection-query.ts` | 16 | `(q: any)` -- TanStack DB type workaround |

All three are annotated with `biome-ignore` comments explaining the rationale. This is excellent discipline.

### EH-016: `unknown` Usage is Appropriate (Severity: Informational)

The codebase uses `unknown` in 106 instances across 30 files, primarily in:
- Service method parameters where external data enters (`Record<string, unknown>`)
- Event payloads and streaming data
- Logger parameters
- Generic containers (`z.unknown()` in Zod schemas)

This is correct usage -- `unknown` is preferred over `any` for untyped data.

---

## 7. Error Propagation

### EH-017: Route Handlers Mask Service Errors in Catch Blocks (Severity: Medium)

Every route handler follows this pattern:

```typescript
// src/server/routes/tasks.ts (representative of all routes)
try {
  const result = await taskService.list(projectId, { column, limit, offset });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, result.error.status);
  }
  return json({ ok: true, data: result.value });
} catch (error) {
  console.error('[Tasks] List error:', error);
  return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tasks' } }, 500);
}
```

The `catch` block replaces the original error with a generic `DB_ERROR` code and a static message. The actual error is only logged to console. This has several problems:

1. **Lost error context**: The client receives `DB_ERROR` for any unhandled exception, whether it is a database issue, a null reference, a network timeout, or a logic bug.
2. **No structured error code**: The `DB_ERROR` code is not in the error catalog and is ad-hoc.
3. **Console.error instead of structured logger**: All route handlers use `console.error` while the rest of the codebase has `createLogger()`. This means route errors bypass log level configuration and structured logging.

The pattern is consistent across all route files examined: `tasks.ts`, `agents.ts`, `sessions.ts`, `worktrees.ts`, `terraform.ts`, `templates.ts`, and others.

### EH-018: Global Error Handler Exists but is Minimal (Severity: Low)

The Hono `onError` handler in `src/server/router.ts` (line 466) provides a safety net:

```typescript
app.onError((err, c) => {
  routerLog.error('Unhandled error', { requestId, error: err });
  const isDev = process.env.NODE_ENV === 'development';
  let message = 'An unexpected error occurred.';
  if (isDev && err instanceof Error) { message = err.message; }
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message } }, 500);
});
```

This handler correctly:
- Uses the structured logger (unlike route-level catches)
- Includes request ID for correlation
- Redacts error messages in production

However, since every route handler has its own try/catch, this handler only fires for middleware-level errors.

### EH-019: PlanModeService Log-and-Swallow Pattern (Severity: Medium)

`src/services/plan-mode.service.ts` has 10+ catch blocks that log stream publishing errors and continue:

```typescript
// Pattern repeated at lines 168-170, 179-181, 235-237, 374-376, 423-425, etc.
try {
  await this.streams.createStream(sessionId);
} catch (streamError) {
  console.error('[PlanModeService] Failed to create stream:', streamError);
}
```

Stream publishing failures are intentionally swallowed because they are non-critical (the UI just won't get a real-time update). This is a valid design choice, but:
- No retry logic exists
- No metric/counter for dropped events
- The pattern makes it hard to distinguish intentional swallowing from accidental error hiding

---

## 8. Try/Catch Patterns

### EH-020: No Empty Catch Blocks (Severity: Informational)

A search for empty catch blocks (`catch(e) {}`) returned zero results. All catch blocks either:
- Log and return an error response (routes)
- Log and swallow (stream publishing)
- Return a default value (settings parsing)
- Re-throw (rare)

### EH-021: Bare `catch {}` Pattern (Severity: Low)

There are 30+ instances of bare `catch {` (without error variable) across the codebase. These are used appropriately for:
- JSON parse failures where the error message is not needed
- Optional feature checks (e.g., Docker availability)
- URL parsing validation

Example:
```typescript
// src/server/shared.ts:103
} catch {
  return false;
}
```

This is idiomatic TypeScript and acceptable.

### EH-022: Route Catch Blocks Use console.error (Severity: Medium)

All route handlers use `console.error` instead of the structured logger:

| File | console.error Count |
|------|-------------------|
| `routes/tasks.ts` | 11 |
| `routes/agents.ts` | 10 |
| `routes/sessions.ts` | 7 |
| `routes/terraform.ts` | 11 |
| `routes/workflows.ts` | 5 |
| `routes/git.ts` | 6 |

The codebase has a proper structured logger (`src/lib/logging/logger.ts`) used elsewhere. Route handlers should use it for consistency and log level filtering.

---

## 9. Runtime Type Safety

### EH-023: API Boundary Validation is Strong (Severity: Informational)

API input validation uses Zod at the boundary for most endpoints. The `parseBody` and `parseJsonBody` functions in `src/server/validation.ts` provide consistent validation-to-response conversion:

```typescript
// src/server/validation.ts:221-227
export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return validationError(result.error.issues[0]?.message ?? 'Invalid request body');
  }
  return { ok: true, data: result.data };
}
```

### EH-024: Database Results Not Validated at Runtime (Severity: Low)

Database query results (from Drizzle ORM) are trusted without runtime validation. This is typical for ORMs and generally acceptable since the schema is defined in code. However, when DB columns are nullable or have JSON payloads (e.g., `StoredPlanOptions`, `AgentConfig`), there is no runtime check that the parsed JSON matches the expected shape.

Example from `container-agent.service.ts` where `task.planOptions` (a JSON column) is used without validation:

```typescript
// The planOptions is cast via the TaskPlanRow interface
interface TaskPlanRow {
  planOptions: StoredPlanOptions | null;  // Trusted from DB
}
```

### EH-025: Path Safety Validation (Severity: Informational)

The codebase includes a dedicated path safety module (`src/lib/utils/path-safety.ts`) that prevents recursive deletion of system directories. This is a thoughtful runtime safety measure with clear rules:
- Paths must have at least 3 components
- System directory prefixes require at least 4 components
- The module has its own result type (`PathSafetyResult`)

### EH-026: ID Validation at Route Boundary (Severity: Informational)

All route handlers validate ID parameters using `isValidId()` before passing them to services:

```typescript
// src/server/shared.ts:69-75
export function isValidId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 100) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
```

This is applied consistently across all route files. However, the Zod schemas in `src/lib/api/schemas.ts` use a stricter `isCuid` check. The route-level check is more permissive (allows any alphanumeric + hyphen + underscore).

---

## Error Code Inventory

### Complete Error Code Table

| Module | Code | HTTP Status | Type |
|--------|------|-------------|------|
| **Agent** | `AGENT_NOT_FOUND` | 404 | Static |
| | `AGENT_ALREADY_RUNNING` | 409 | Factory |
| | `AGENT_NOT_RUNNING` | 400 | Static |
| | `AGENT_TURN_LIMIT_EXCEEDED` | 200 | Factory |
| | `AGENT_NO_AVAILABLE_TASK` | 400 | Static |
| | `AGENT_TOOL_NOT_ALLOWED` | 403 | Factory |
| | `AGENT_EXECUTION_ERROR` | 500 | Factory |
| **Task** | `TASK_NOT_FOUND` | 404 | Static |
| | `TASK_NOT_IN_COLUMN` | 400 | Factory |
| | `TASK_ALREADY_ASSIGNED` | 409 | Factory |
| | `TASK_NO_DIFF` | 400 | Static |
| | `TASK_ALREADY_APPROVED` | 409 | Static |
| | `TASK_NOT_WAITING_APPROVAL` | 400 | Factory |
| | `TASK_INVALID_TRANSITION` | 400 | Factory |
| | `TASK_POSITION_CONFLICT` | 409 | Static |
| | `TASK_AGENT_NOT_RUNNING` | 400 | Static |
| | `TASK_AGENT_STOP_FAILED` | 500 | Static |
| **Project** | `PROJECT_NOT_FOUND` | 404 | Static |
| | `PROJECT_PATH_EXISTS` | 409 | Static |
| | `PROJECT_PATH_INVALID` | 400 | Factory |
| | `PROJECT_NOT_A_GIT_REPO` | 400 | Factory |
| | `PROJECT_HAS_RUNNING_AGENTS` | 409 | Factory |
| | `PROJECT_CONFIG_INVALID` | 400 | Factory |
| **Session** | `SESSION_NOT_FOUND` | 404 | Static |
| | `SESSION_CLOSED` | 400 | Static |
| | `SESSION_CONNECTION_FAILED` | 502 | Factory |
| | `SESSION_SYNC_FAILED` | 500 | Factory |
| **Worktree** | 8 codes | 400-500 | Mixed |
| **Concurrency** | 3 codes | 423-429 | Factory |
| **GitHub** | 8 codes | 401-500 | Mixed |
| **Validation** | 5 codes | 400 | Factory |
| **Sandbox** | 33 codes | 400-503 | Mixed |
| **SandboxConfig** | 7 codes | 400-409 | Mixed |
| **K8s** | 31 codes | 400-503 | Factory |
| **Nomad** | 17 codes | 400-503 | Factory |
| **Terraform** | 8 codes | 401-500 | Mixed |
| **Template** | 8 codes | 400-500 | Mixed |
| **Marketplace** | 7 codes | 400-500 | Mixed |
| **PlanMode** | 17 codes | 400-500 | Mixed |
| **Event** | 11 codes | 400-500 | Factory |
| **Schedule** | 8 codes | 400-500 | Factory |
| **AgentCore** | 9 codes | 400-503 | Factory |

**Total**: ~140+ unique error codes across 18 modules.

---

## Type Assertion Heatmap

Files with the most type assertions (`as` keyword, excluding imports):

| File | `as` Count | Notes |
|------|-----------|-------|
| `routeTree.gen.ts` | 49 | Auto-generated, all `as any` |
| `services/__tests__/agent.service.test.ts` | ~132 | Test mocking |
| `services/__tests__/task.service.test.ts` | ~44 | Test mocking |
| `services/__tests__/container-agent-worktree.test.ts` | ~35 | Test mocking |
| `services/__tests__/sandbox-config.service.test.ts` | ~21 | Test mocking |
| `services/container-agent.service.ts` | ~18 | Mostly `as TaskColumn` and similar |
| `services/scheduler.service.ts` | ~16 | Type narrowing |
| `server/routes/sessions.ts` | ~11 | `event.data as Record<...>` casts |
| `services/terraform-compose.service.ts` | ~8 | SDK response handling |
| `db/client.ts` | ~7 | Drizzle dialect configuration |

---

## `any` Usage Count by File (Non-Generated, Non-Test)

| File | Explicit `any` Count | Notes |
|------|---------------------|-------|
| `lib/streams/client.ts` | 3 | Callback fan-out, annotated |
| `lib/db/use-collection-query.ts` | 2 | TanStack DB workaround, annotated |
| `services/task-creation.service.ts` | 1 | JSON parsing, annotated |
| `lib/prompts/prompt-registry.ts` | 5 | Record types, likely `Record<string, any>` |
| `lib/terraform/stacks-prompt.ts` | 3 | Dynamic prompt construction |
| `lib/task-creation/hooks.ts` | 7 | SDK callback types |

**Total non-generated `any`**: ~21 across 6 files. All are annotated with biome-ignore comments.

---

## Key Recommendations

### Priority 1 (High)

1. **EH-009**: Add Zod validation to `routes/github.ts`, `routes/task-creation.ts`, and `routes/agents.ts`. The current `as` casts on request bodies are unsafe.

2. **EH-008**: Consolidate the dual validation schema files. Choose one (`server/validation.ts` is more actively used) and remove or deprecate the other. The differing constraints (title max 200 vs 500) are a correctness risk.

### Priority 2 (Medium)

3. **EH-017/EH-022**: Replace `console.error` in route handlers with the structured logger (`createLogger`). Consider creating a route-level error handler middleware that wraps the common try/catch pattern.

4. **EH-001**: Update `specs/application/errors/error-catalog.md` to cover all 18 error modules. The spec is significantly out of date.

5. **EH-005**: Tighten the `ContainerAgentTrigger` interface to use `SandboxError` instead of `unknown`.

### Priority 3 (Low)

6. **EH-003**: Add missing error modules to `src/lib/errors/index.ts` barrel export.

7. **EH-013**: Add runtime type guards when processing `event.data` in session export formatting.

8. **EH-014**: Validate the `column` query parameter in `routes/tasks.ts` against the allowed enum values before using it.

---

## Architecture Strengths

1. **Consistent Result type pattern**: The `Result<T, E>` type is adopted across all 63 service files, creating a predictable error flow.

2. **Typed error catalogs**: Each domain has its own error module with typed constructors. Error codes are string constants with HTTP status and details baked in.

3. **No `@ts-ignore` or `@ts-expect-error`**: Zero suppression comments in the entire codebase.

4. **Strong tsconfig**: All strict flags enabled including `noUncheckedIndexedAccess`.

5. **Type-level key matching**: The K8s, Nomad, and AgentCore error modules include compile-time assertions ensuring error ID maps stay in sync with error factory objects.

6. **Clean API response envelope**: Consistent `{ ok: true, data } | { ok: false, error: { code, message, details? } }` shape throughout.

7. **Path safety module**: Dedicated runtime protection against accidental deletion of system directories.
