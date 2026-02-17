# 10. Cross-Cutting Concerns

## Overview

This document reviews the cross-cutting infrastructure that underpins the entire AgentPane codebase: TypeScript configuration, error handling, logging, configuration management, security patterns, and shared utilities. These foundational layers affect every module and their quality directly impacts system reliability, debuggability, and maintainability.

**Overall Assessment:** The cross-cutting infrastructure is well-designed with strong foundations. TypeScript strict mode is fully enabled, the error catalog is comprehensive and well-tested, and the Result type provides a functional error-handling pattern. However, there are significant gaps in logging consistency (720 raw `console.*` calls vs. only 25 structured logger usages), and the auth middleware defaults to permissive behavior in development mode without adequate guardrails.

---

## 1. Type Safety

### TypeScript Configuration

The root `tsconfig.json` (`/Users/simon.lynch/git/agentpane_nocode/tsconfig.json`) has an exemplary strict configuration:

```json
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "forceConsistentCasingInFileNames": true
}
```

**Strengths:**
- `strict: true` enables all strict family checks (`strictNullChecks`, `strictFunctionTypes`, etc.)
- `noUncheckedIndexedAccess: true` is an excellent choice -- forces explicit handling of `undefined` from index operations
- `verbatimModuleSyntax: true` enforces correct `import type` vs `import` usage
- `exactOptionalPropertyTypes: false` is a pragmatic choice (enabling this can be overly restrictive)

**`any` Usage Analysis:**
- Total `any` occurrences across `src/`: **56 instances in 4 files**
- `src/app/routeTree.gen.ts`: 43 occurrences -- **auto-generated** by TanStack Router, acceptable
- `src/services/__tests__/container-agent-worktree.test.ts`: 9 occurrences -- `as any` casts to access private methods in tests, acceptable testing pattern
- `src/lib/sessions/derived.ts`: 1 occurrence
- `src/app/routeTree.gen.ts`: 3 additional parameter-type `any` annotations

**`@ts-ignore` / `@ts-expect-error` Usage:** Only **1 occurrence** across the entire codebase (in `routeTree.gen.ts`, auto-generated). This is excellent discipline.

### Type Patterns

**Result Type** (`src/lib/utils/result.ts`):
A well-implemented discriminated union pattern:
```typescript
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
```
With utility functions: `ok()`, `err()`, `isOk()`, `isErr()`, `map()`, `mapErr()`, `unwrap()`, `unwrapOr()`. This is used consistently throughout services and API handlers, providing type-safe error propagation without exceptions.

**AppError Interface** (`src/lib/errors/base.ts`):
```typescript
export interface AppError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
```
Clean, serializable error structure used as the `E` type in `Result<T, AppError>` throughout the application.

---

## 2. Error Handling

### Error Catalog Architecture

The error catalog is organized into **15 domain-specific error files** under `src/lib/errors/`:

| Error Module | File | Error Count |
|---|---|---|
| Agent | `agent-errors.ts` | 7 |
| Concurrency | `concurrency-errors.ts` | 3 |
| GitHub | `github-errors.ts` | 8 |
| K8s | `k8s-errors.ts` | ~35 |
| Marketplace | `marketplace-errors.ts` | 7 |
| Plan Mode | `plan-mode-errors.ts` | 17 |
| Project | `project-errors.ts` | 6 |
| Sandbox | `sandbox-errors.ts` | ~35 |
| Sandbox Config | `sandbox-config-errors.ts` | 8 |
| Session | `session-errors.ts` | 4 |
| Task | `task-errors.ts` | 10 |
| Template | `template-errors.ts` | 8 |
| Terraform | `terraform-errors.ts` | 8 |
| Validation | `validation-errors.ts` | 5 |
| Worktree | `worktree-errors.ts` | 8 |

**Total: ~160+ cataloged error codes**

Each module follows a consistent pattern:
```typescript
export const XxxErrors = {
  STATIC_ERROR: createError('CODE', 'message', statusCode),
  DYNAMIC_ERROR: (param: string) => createError('CODE', `message: ${param}`, statusCode, { param }),
} as const;
```

**Strengths:**
- Comprehensive test coverage in `src/lib/errors/__tests__/error-catalog.test.ts` (685 lines testing all core error modules)
- Type-safe union types exported alongside each error module (e.g., `AgentError`, `TaskError`)
- HTTP status codes are semantically correct (404 for not-found, 409 for conflicts, 429 for rate limiting)
- K8s errors include a separate `K8S_ERROR_IDS` mapping for monitoring system integration (Sentry-style grouping)

**Error Middleware** (`src/lib/api/middleware.ts`):
```typescript
export const withErrorHandling = (handler) => async ({ request, params }) => {
  try {
    return await handler({ request, context: apiContext });
  } catch (error) {
    const appError = { code: 'API_UNHANDLED_ERROR', message: 'Unhandled API error', status: 500 };
    return Response.json(failure(appError), { status: appError.status });
  }
};
```

**Global Error Handler** in Hono router (`src/server/router.ts:233-247`):
```typescript
app.onError((err, c) => {
  routerLog.error('Unhandled error', { requestId, error: err });
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message } }, 500);
});
```

Both layers ensure unhandled exceptions never leak stack traces in production.

### Dual Error Pattern Concern

The codebase has both `AppError` (plain object) and `AppErrorClass` (Error subclass) in `base.ts`:

```typescript
// Plain object factory (used everywhere)
export const createError = (code, message, status, details?) => ({ code, message, status, details });

// Class-based (defined but rarely used)
export class AppErrorClass extends Error implements AppError { ... }
```

The `AppErrorClass` exists but is not widely used -- the functional `createError()` pattern dominates. This is fine as long as the team is aware that `AppError` objects will NOT be caught by `instanceof Error` checks.

---

## 3. Logging

### Logger Implementation

**Location:** `src/lib/logging/logger.ts`

The structured logger supports:
- **4 levels:** debug, info, warn, error
- **Contextual logging:** `createLogger('ServiceName')` creates a scoped logger
- **Structured JSON in production:** Full `LogEntry` with timestamp, context, requestId, data, error
- **Human-readable in development:** `LEVEL [Context] (req:xxx) message {data}`
- **Error serialization:** Extracts message, stack, and code from Error objects
- **Configurable min level:** Via `LOG_LEVEL` env var with validation

### Logging Consistency Problem

**Structured logger adoption:** Only **25 `createLogger` usages** across 9 files:
- `src/server/api.ts` (2)
- `src/server/router.ts` (2)
- `src/services/terraform-compose.service.ts` (2)
- `src/lib/sandbox/controllers/sandbox-controller.ts` (2)
- `src/lib/sandbox/providers/agent-sandbox-provider.ts` (2)
- `src/lib/sandbox/providers/agent-sandbox-instance.ts` (2)
- And a few others

**Raw `console.*` calls:** **720 occurrences** across **89 files**. This is the most significant cross-cutting concern issue. Files like:
- `src/server/api.ts`: 34 `console.*` calls alongside 2 `createLogger` usages
- `src/server/routes/sessions.ts`: 15 raw console calls
- `src/services/cli-monitor/cli-monitor.service.ts`: 11 raw console calls
- `src/lib/task-creation/hooks.ts`: 21 raw console calls
- `src/lib/sandbox/providers/docker-provider.ts`: 20 raw console calls

This means the majority of logging bypasses the structured logger entirely, losing:
- Request ID correlation
- Structured JSON output in production
- Consistent context prefixes
- Log-level filtering

### Request ID Infrastructure

The router (`src/server/router.ts:57-64`) generates request IDs:
```typescript
async function requestIdMiddleware(c: Context, next: Next) {
  const id = c.req.header('x-request-id') ?? `req-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  return next();
}
```

However, request IDs are NOT propagated to service-layer logging. The structured logger supports `requestId` as an optional parameter, but there is no middleware or context mechanism to automatically thread it through service calls.

---

## 4. Configuration Management

### Environment Variables

Environment variables are accessed via `process.env.*` directly throughout the codebase (**82 occurrences across 28 files**). There is no centralized env schema or validation beyond:

1. **Startup validation** in `src/server/api.ts:22-52`: Checks for `ANTHROPIC_API_KEY` or `CLAUDE_OAUTH_TOKEN` and `CORS_ORIGIN`
2. **A minimal `RuntimeEnv` type** in `src/lib/env.ts` for client-side env (only `e2eSeed`)

Key env vars used across the codebase:
- `ANTHROPIC_API_KEY` / `CLAUDE_OAUTH_TOKEN` -- Agent execution
- `NODE_ENV` -- Development vs production behavior
- `LOG_LEVEL` -- Logger minimum level
- `DB_MODE` / `DB_PATH` / `DATABASE_URL` -- Database configuration
- `CORS_ORIGIN` -- CORS allowed origin
- `SKIP_AUTH` -- Development auth bypass
- `AGENTPANE_MAX_TURNS` -- Agent turn limit override
- `VITE_E2E_SEED` -- E2E testing seed data

### Project Configuration

**Config Service** (`src/lib/config/config-service.ts`):
- Loads `.claude/settings.json` from project paths
- Validates with Zod schema (`projectConfigSchema`)
- Supports env var overrides (e.g., `AGENTPANE_MAX_TURNS`)
- Detects secrets in config keys via `containsSecrets()` pattern matching
- Uses `deepMerge()` utility for layered configuration

**Settings Service** (database-backed):
- Key-value store in SQLite `settings` table
- Used for sandbox defaults, K8s config, provider selection
- No schema validation on stored values (JSON.parse with type assertions)

### Secret Detection

`src/lib/config/validate-secrets.ts` blocks keys matching:
```typescript
const BLOCKED_PATTERNS = [/SECRET/i, /PASSWORD/i, /PRIVATE_KEY/i, /_TOKEN$/i, /_API_KEY$/i];
const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
```

This is a defense-in-depth measure but the allowlist is small and the patterns could miss creative key names.

---

## 5. Security Patterns

### Authentication

**Auth Middleware** (`src/lib/api/auth-middleware.ts`):

Three authentication methods (checked in order):
1. Session cookie (`agentpane_session`)
2. Bearer token (`Authorization: Bearer xxx`)
3. Development bypass (when `NODE_ENV !== 'production'`)

**Critical concern:** In development mode (which includes when `NODE_ENV` is unset), ALL requests are automatically authenticated as `local-dev` user without any credentials. While this is convenient for local development, there are no guardrails:

```typescript
// Default: allow with dev user for local development
return ok({ userId: 'local-dev', authMethod: 'dev' });
```

The `withAuth()` wrapper is also available for route-level auth enforcement, and health endpoints are explicitly exempted from auth in the router middleware.

**Token validation fallbacks:** When validators are not configured, session tokens and Bearer tokens are accepted without database validation, constructing user IDs from token prefixes:
```typescript
userId: `session:${sessionToken.substring(0, 8)}`,
```

### Security Headers

`src/server/router.ts:66-79` sets standard security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- Production-only: `Strict-Transport-Security`, `Content-Security-Policy`

### Rate Limiting

`src/lib/api/rate-limiter.ts`:
- In-memory fixed-window counter per IP
- Default: 200 requests per 60 seconds
- Sends standard `X-RateLimit-*` headers
- Automatic stale entry cleanup every 60 seconds
- **Limitation:** In-memory only; does not work across multiple instances

### CORS Configuration

Single origin (`CORS_ORIGIN` env var, defaults to `http://localhost:3000`). Correctly restricts methods and headers.

### Encryption

**Token Encryption** (`src/server/crypto.ts`):
- AES-256-GCM with PBKDF2 key derivation (100,000 iterations)
- Key material stored in `./data/.keyfile` (file-based, separate from database)
- Salt and IV are unique per encryption operation
- Proper key-derivation with separate salt per operation

**SSE Token Service** (`src/server/sse-token.service.ts`):
- Cryptographically secure random tokens (32 bytes)
- Short-lived (5 minutes), single-use tokens
- Per-user token limits (max 10)
- Automatic expired token cleanup
- Proper token format validation

### Input Validation

**API Validation** (`src/lib/api/validation.ts`):
- Zod-based schema validation for request bodies and query parameters
- Consistent error formatting via `ValidationErrors.VALIDATION_ERROR`
- All API schemas defined in `src/lib/api/schemas.ts` with comprehensive constraints
- CUID format validation for all entity IDs

**Path Safety** (`src/lib/utils/path-safety.ts`):
- Protection against accidental deletion of system directories
- Requires minimum path depth (3+ components)
- Blocks dangerous prefixes (`/`, `/bin`, `/etc`, `/Users`, etc.)
- Path traversal prevention via `path.resolve()` + `path.normalize()`

---

## 6. Shared Utilities

### Utility Library (`src/lib/utils/`)

| File | Purpose | Quality |
|---|---|---|
| `result.ts` | Result<T,E> monad with map/unwrap | Excellent -- core pattern |
| `deep-merge.ts` | Recursive object merge with cycle detection | Good -- handles edge cases |
| `path-safety.ts` | Path validation for deletion safety | Good -- defensive |
| `cn.ts` | Lightweight className utility (tailwind) | Good -- zero-dependency |
| `date.ts` | SQLite date conversion helpers | Good -- focused |
| `slugify.ts` | String-to-slug for branch names | Good -- simple |
| `resolve-anthropic-key.ts` | Multi-source API key resolution | Good -- cascading |
| `resolve-model.ts` | Model ID resolution with cascade priority | Good -- clean |

### API Response Helpers (`src/lib/api/response.ts`)

```typescript
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
export const success = <T>(data: T): ApiSuccess<T> => ({ ok: true, data });
export const failure = (error: AppError): ApiFailure => ({ ok: false, error: { code, message, details } });
```

Consistent response envelope used across all API routes.

---

## 7. Findings

### CC-001: Pervasive Raw Console Logging Bypasses Structured Logger
**Severity:** High
**Description:** 720 `console.log/warn/error` calls across 89 files vs. only 25 `createLogger` usages across 9 files. The vast majority of logging bypasses the structured logger, losing request ID correlation, structured JSON output in production, log-level filtering, and consistent context.
**Affected Files:**
- `src/server/api.ts:34` (34 raw console calls alongside structured logger)
- `src/lib/task-creation/hooks.ts` (21 raw calls)
- `src/lib/sandbox/providers/docker-provider.ts` (20 raw calls)
- `src/server/routes/sessions.ts` (15 raw calls)
- `src/server/routes/worktrees.ts` (15 raw calls)
- `src/services/task-creation.service.ts` (117 lines of `console.*`)
- 83 additional files
**Recommendation:** Adopt a lint rule or ESLint plugin (`no-console`) to flag raw console usage in `src/` (except tests). Migrate high-traffic files to `createLogger()` first. Consider creating a logger singleton per module pattern that's as easy to use as `console.log`.

### CC-002: No Centralized Environment Variable Schema or Validation
**Severity:** Medium
**Description:** Environment variables are accessed via raw `process.env.*` in 82 occurrences across 28 files with no centralized schema. Only `ANTHROPIC_API_KEY` and `CORS_ORIGIN` are validated at startup. Missing variables like `DB_MODE`, `DATABASE_URL`, `LOG_LEVEL`, `SKIP_AUTH`, and `AGENTPANE_MAX_TURNS` are silently defaulted throughout the code.
**Affected Files:**
- `src/server/api.ts:22-52` (partial startup validation)
- `src/lib/env.ts` (only covers `VITE_E2E_SEED`)
- `src/lib/config/config-service.ts:45-51` (raw `process.env.AGENTPANE_MAX_TURNS`)
- `src/lib/logging/logger.ts:33-44` (raw `process.env.LOG_LEVEL`)
- `src/server/router.ts:72` (raw `process.env.NODE_ENV`)
- `src/lib/api/auth-middleware.ts:110` (raw `process.env.NODE_ENV`, `process.env.SKIP_AUTH`)
**Recommendation:** Create a centralized `src/lib/env/server-env.ts` that validates all server-side env vars at startup using Zod, with explicit defaults and type exports. This prevents silent misconfiguration and provides a single source of truth.

### CC-003: Request IDs Not Propagated to Service Layer
**Severity:** Medium
**Description:** The router generates request IDs via `requestIdMiddleware` and stores them in Hono context (`c.set('requestId', id)`), but these IDs are never passed to service-layer methods. The structured logger supports `requestId` as a parameter, but services have no mechanism to receive or thread it through calls.
**Affected Files:**
- `src/server/router.ts:57-64` (request ID generation)
- `src/lib/logging/logger.ts:80` (supports `requestId` but never receives it from services)
- All route handlers in `src/server/routes/*.ts` (don't pass requestId to services)
**Recommendation:** Implement an AsyncLocalStorage-based request context that automatically captures the request ID from Hono middleware and makes it available to all downstream service calls and logger instances without explicit parameter threading.

### CC-004: Development Auth Bypass Has No Warning or Audit Trail
**Severity:** Medium
**Description:** In development mode (including when `NODE_ENV` is unset), all requests are automatically authenticated as `local-dev` without any credentials required. There is no log entry, audit trail, or console warning when this bypass is active. The `X-Dev-User` header also allows impersonating any user in development mode.
**Affected Files:**
- `src/lib/api/auth-middleware.ts:108-135` (three separate dev bypass paths)
**Recommendation:** Log a startup warning when dev auth bypass is active. Add per-request debug logging when the bypass is used. Consider requiring explicit `SKIP_AUTH=true` rather than defaulting to open access in development.

### CC-005: Settings Service Stores JSON Without Schema Validation
**Severity:** Low
**Description:** The database-backed settings service stores arbitrary JSON values via `JSON.parse()` with type assertions (`as` casts) when reading them back. There is no runtime validation that the stored JSON conforms to the expected shape. Corrupt or hand-edited settings could cause runtime crashes.
**Affected Files:**
- `src/server/api.ts:644` (`JSON.parse(globalDefaults.value) as { image?: string; ... }`)
- `src/server/api.ts:675` (`JSON.parse(providerSetting.value) as { provider?: string; ... }`)
- `src/server/api.ts:714` (`const parsed = JSON.parse(k8sSetting.value)` -- untyped)
- `src/server/api.ts:1263` (K8s heal interval settings parse)
**Recommendation:** Create Zod schemas for each settings key and validate on read. The `SettingsService` should expose typed getter methods like `getSandboxDefaults()` that validate and return properly typed objects.

### CC-006: Inconsistent Error Handling in Migration Code
**Severity:** Low
**Description:** The SQLite migration block in `api.ts` uses a fragile pattern of running migrations inside try/catch blocks that check for duplicate column errors by string matching on error messages. This is repeated 5 times with nearly identical code.
**Affected Files:**
- `src/server/api.ts:175-236` (5 repeated try/catch migration blocks with `error.message.includes('duplicate column name')`)
**Recommendation:** Extract a `runIdempotentMigration(sql, label)` helper that encapsulates the try/catch/duplicate-column pattern. Better yet, migrate to Drizzle Kit's built-in migration tracking so that individual migration SQL blocks are tracked as applied.

### CC-007: Rate Limiter Is In-Memory Only
**Severity:** Low
**Description:** The rate limiter uses an in-memory `Map` store. In a multi-instance deployment (which the Docker/K8s sandbox architecture suggests is a goal), rate limits would not be shared across instances, allowing users to exceed limits by hitting different instances.
**Affected Files:**
- `src/lib/api/rate-limiter.ts:32` (`const store = new Map<string, RateLimitEntry>()`)
**Recommendation:** The existing implementation acknowledges this in its JSDoc comment ("For production with multiple instances, replace with Redis-backed limiter"). When scaling horizontally, implement a Redis-backed or database-backed rate limiter. For the current single-instance deployment, this is acceptable.

### CC-008: Encryption Key File Has No Permission Restrictions
**Severity:** Low
**Description:** The encryption key material file (`./data/.keyfile`) is created with `writeFileSync` using default file permissions. On Unix systems, this means the file may be readable by other users on the system.
**Affected Files:**
- `src/server/crypto.ts:34` (`writeFileSync(KEY_FILE_PATH, Buffer.from(keyMaterial).toString('base64'), 'utf-8')`)
**Recommendation:** Set restrictive file permissions (mode `0600`) when writing the keyfile: `writeFileSync(KEY_FILE_PATH, ..., { mode: 0o600 })`.

### CC-009: `api.ts` Is an Oversized God Module
**Severity:** Medium
**Description:** `src/server/api.ts` is 1419 lines and handles: database initialization, migration execution, service instantiation, sandbox provider initialization (including K8s with minikube autostart), container recovery, graceful shutdown, and K8s auto-heal intervals. It is the single largest source file and mixes infrastructure concerns with application bootstrapping.
**Affected Files:**
- `src/server/api.ts` (1419 lines, ~1300 lines of initialization code)
**Recommendation:** Break this into focused modules: `src/server/bootstrap/database.ts`, `src/server/bootstrap/services.ts`, `src/server/bootstrap/sandbox-provider.ts`, `src/server/bootstrap/k8s-heal.ts`. Keep `api.ts` as a thin orchestrator that calls each bootstrap phase.

### CC-010: Token/Cookie Validation Fallback Accepts Tokens Without Verification
**Severity:** Medium
**Description:** When no `validateSessionToken` or `validateApiKey` callbacks are provided to `getAuthContext()`, session cookies and Bearer tokens are accepted without any database validation. The user ID is constructed from the first 8 characters of the token. This means ANY string passed as a session cookie or Bearer token is accepted in the default configuration.
**Affected Files:**
- `src/lib/api/auth-middleware.ts:77-81` (session token fallback: `userId: session:${sessionToken.substring(0, 8)}`)
- `src/lib/api/auth-middleware.ts:101-105` (Bearer token fallback: `userId: token:${token.substring(0, 8)}`)
- `src/server/router.ts:87` (calls `getAuthContext(c.req.raw)` without validators)
**Recommendation:** In the router's `authMiddleware`, pass validator callbacks that check against the database. At minimum, log a warning when the validation fallback path is used in non-development environments.

### CC-011: Duplicate `createError` + `AppErrorClass` Patterns
**Severity:** Low
**Description:** The error base module exports both a `createError` factory function (returns plain `AppError` objects) and an `AppErrorClass` (extends `Error`). The class-based version is defined but appears to be unused in practice. This duality could confuse contributors about which pattern to use.
**Affected Files:**
- `src/lib/errors/base.ts:8-18` (`createError` factory)
- `src/lib/errors/base.ts:20-31` (`AppErrorClass` class)
**Recommendation:** If `AppErrorClass` is unused, remove it to avoid confusion. If there are plans to use it for `try/catch` based error handling, document when to use each approach.

---

## Summary

| Area | Rating | Key Strengths | Key Gaps |
|---|---|---|---|
| **Type Safety** | Strong | Strict mode, noUncheckedIndexedAccess, minimal `any` | None significant |
| **Error Handling** | Strong | 160+ cataloged errors, comprehensive tests, Result type | Dual error pattern (CC-011) |
| **Logging** | Weak | Good logger design | 97% of logging bypasses it (CC-001) |
| **Configuration** | Moderate | Zod-validated project config, secret detection | No centralized env schema (CC-002) |
| **Security** | Moderate | Good headers, encryption, rate limiting, SSE tokens | Dev auth bypass, token fallback (CC-004, CC-010) |
| **Shared Utilities** | Strong | Clean Result type, path safety, deep merge | None significant |
| **Code Organization** | Moderate | Good error catalog structure | api.ts god module (CC-009) |

### Critical Path Items
1. **CC-001** (High): Logging consistency -- affects production observability
2. **CC-009** (Medium): api.ts complexity -- affects maintainability
3. **CC-002** (Medium): Env var validation -- affects deployment reliability
4. **CC-010** (Medium): Token validation fallback -- affects security posture
