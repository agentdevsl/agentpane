# Error Handling & Resilience Assessment

## Current Error Architecture

### Error Base and Catalog
The codebase implements a structured error system centered on `AppErrorClass` (extending `Error`) with typed error modules across 23 domain areas. Each module exports a factory object (e.g., `AgentErrors`, `TaskErrors`, `SandboxErrors`) that produces `AppError` instances with typed `code`, `message`, `status`, and optional `details`.

Key files:
- `src/lib/errors/base.ts` - `AppErrorClass` base, `createError()` factory
- `src/lib/errors/index.ts` - Re-exports all 23 error modules
- `src/lib/utils/result.ts` - `Result<T, E>` type with `ok()`, `err()`, `map()`, `unwrap()` helpers
- `src/lib/utils/error-message.ts` - `errorMessage()` utility for safe extraction from `unknown`
- `src/lib/utils/invariant.ts` - `invariant()` (throws in dev, logs in prod) and `softInvariant()` (never throws)

### Error Propagation Path
Services return `Result<T, E>` types. Routes check `result.ok` and call `errorResponse(result)` to produce standardized JSON responses:
```
Service → Result<T, AppError> → Route handler → errorResponse() → { ok: false, error: { code, message, status } }
```

The global `app.onError()` handler in `src/server/router.ts:567` catches unhandled exceptions and returns `{ ok: false, error: { code: 'INTERNAL_ERROR', message } }` with status 500. In development mode, the actual error message is included; in production, a generic message is shown.

### Process-Level Error Handling
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` are registered in `src/server/api.ts` - they log but do not crash the process.
- `GracefulShutdown` class (`src/server/bootstrap/shutdown.ts`) handles SIGINT/SIGTERM with LIFO-ordered cleanup, a 30-second timeout safety net, and individual try/catch per cleanup handler.

### Static Analysis
Custom Semgrep rules in `.semgrep/rules/error-handling.yml` check for:
- Empty catch blocks (WARNING)
- Error context loss in re-thrown errors (WARNING)

Additional rule in `.semgrep/rules/invariant-enforcement.yml` checks for:
- Database updates without `.returning()` verification
- Discarded `validateTransition()` return values

## Strengths

### 1. Consistent Result Type Usage
The `Result<T, E>` pattern is used extensively (89+ occurrences) throughout services, providing compile-time enforcement of error handling at call sites. Routes consistently check `result.ok` before proceeding.

### 2. Typed Error Catalog with HTTP Status Codes
Every error has a unique code, human-readable message, and appropriate HTTP status. Error details include contextual data (e.g., `TASK_INVALID_TRANSITION` includes `from`, `to`, and `allowedTransitions`). This enables clients to handle errors programmatically.

### 3. Robust Agent Execution Error Handling
- `stream-handler.ts` wraps all agent execution in try/catch with proper batcher cleanup (`destroyBatcher()`) and session close
- Error events are published to the session stream so the UI always reflects failures
- `recovery.ts` provides rate-limit detection with pause/retry semantics
- Memory capture errors are explicitly fire-and-forget with `.catch()` handlers
- SDK-level `assistant.error` messages are captured and published to sessions

### 4. Graceful Shutdown Implementation
- LIFO ordering ensures dependencies tear down before dependents
- Individual try/catch per cleanup handler prevents one failure from blocking others
- 30-second timeout with `forceExitTimer.unref()` (doesn't prevent exit)
- Idempotent via `isShuttingDown` flag

### 5. Server Startup Recovery
`src/server/bootstrap/phases/recovery.ts` recovers stale state on every startup:
- Resets stuck agents (starting/planning/running) to idle
- Moves orphaned in-progress tasks back to backlog
- Clears stale worktree references
Each recovery step has independent try/catch, so one failure doesn't block others.

### 6. Transaction Safety
Critical multi-step mutations use `db.transaction()`:
- Agent start: task + agent + agent_run updates in one transaction
- Task creation: position calculation + insert in transaction to prevent duplicate positions
- Team creation, invitation acceptance, RBAC token creation all use transactions

### 7. Standardized Error Response Helper
`errorResponse()` in `src/server/shared.ts` centralizes the `Result` error-to-HTTP-response conversion, preventing ad-hoc error formatting.

### 8. Database Offset Collision Retry
`DurableStreamsService.persistToDb()` retries up to 5 times on UNIQUE constraint violations for offset collisions, handling concurrent event persistence.

### 9. SSE Client Reconnection
`useEventStream` hook implements exponential backoff (1s to 30s, max 10 retries) for SSE reconnection on the client side.

## Critical Issues

### C-1: `validateTransition()` Return Value Discarded in `stop()`
**File:** `src/services/agent/agent-execution.service.ts:775`
```typescript
validateTransition(agent.status, { type: 'ABORT' });
```
The return value is not checked. The abort proceeds regardless of whether the transition is valid per the state machine. This could allow stopping an agent in an invalid state, causing inconsistent DB state.

**Risk:** Medium - data inconsistency possible. The Semgrep rule `invariant-enforcement.yml` explicitly checks for this pattern.

### C-2: Worktree/Session Not Cleaned Up on Transaction Failure
**File:** `src/services/agent/agent-execution.service.ts:340-416`
When the transaction fails at line 404, only the worktree DB record is deleted (line 406-414). However:
- The **session** record created at line 350-358 is not cleaned up
- The **physical worktree** (git directory) created by `worktreeService.create()` at line 340 is not removed
This can leave orphaned sessions and disk space consumed by abandoned worktrees.

**Risk:** High on repeated failures - disk space leak, orphaned DB records.

### C-3: 27 Empty Catch Blocks in Production Code
Found across 14 files (27 instances of `catch (_err) {}` pattern), plus 17 instances of `.catch(() => {})`. While some are intentional best-effort operations (e.g., Caddy SSE publish after DB persistence succeeds), several are problematic:

- **`session-stream.service.ts:167`** - Silently swallows real-time stream publish failures. If the stream server is down, no logging occurs and there's no way to diagnose why clients aren't receiving events.
- **`api-key.service.ts:164`** - `markInvalid()` silently fails. A stale valid flag could cause repeated auth failures against an invalid key.
- **`cli-monitor.service.ts:376,383,455`** - Database upsert/delete/callback errors silently swallowed.
- **`template-sync-scheduler.ts:99,107,136`** - Three nested levels of empty catches: sync errors, next-sync-at updates, and the outer scheduler loop. Template sync failures are invisible.
- **`docker-provider.ts:365,465`** - Container termination/removal errors silently ignored. Could leave zombie containers.

**Risk:** High for diagnostics - these make debugging production issues extremely difficult.

### C-4: `invariant()` Becomes a No-Op in Production
**File:** `src/lib/utils/invariant.ts:28-30`
In production (`NODE_ENV=production`), `invariant()` logs but **returns** instead of throwing. Code after the invariant call continues executing with the violated condition. For example:
```typescript
invariant(user, 'User must exist');
user.doSomething(); // In production, user is null/undefined here
```
This is by design (to prevent crashes), but it means invariant violations in production lead to undefined behavior rather than controlled failures.

**Risk:** Medium - potential null reference errors in production that would be caught in dev.

## Resilience Gaps

### R-1: No Retry Logic for Claude Agent SDK Calls
The `stream-handler.ts` functions (`runAgentPlanning`, `runAgentExecution`) have no retry logic. If the Claude SDK returns a transient error (network timeout, 500, 503), the agent immediately fails. The `recovery.ts` module detects rate limits but only returns `shouldRetry: true` - the actual retry is never implemented.

**Impact:** Agent tasks fail permanently on transient Claude API issues.

### R-2: No Circuit Breaker for External Services
No circuit breaker pattern exists for:
- Claude Agent SDK calls
- GitHub API calls (Octokit)
- Docker API calls
- Caddy streams server

A sustained outage of any external dependency can cause request queue buildup, connection exhaustion, or cascading failures.

### R-3: No Timeout on Agent SDK Session Creation or Stream Iteration
`unstable_v2_createSession()` and the `for await (const msg of session.stream())` loop in `stream-handler.ts` have no timeout. If the SDK hangs (e.g., network partition to Claude), the agent will block indefinitely. The only safeguard is the abort signal, which requires manual user intervention.

**Mitigation exists:** Container agents have `AGENT_MAX_RUNTIME_MS` timeout (default 2 hours), but the native agent execution path lacks this.

### R-4: Sandbox Initialization Retry Limited in Dev Mode
**File:** `src/server/bootstrap/sandbox/sandbox-init.ts:183`
`maxRetries` is 0 in dev mode, meaning sandbox initialization never retries after failure. In production, retry with exponential backoff is properly implemented (up to 10 retries, 15s-300s backoff).

### R-5: No Health Check for Real-Time Stream Server
The durable streams service silently swallows Caddy publish errors (empty catch blocks at lines 691, 963). There is no periodic health check or reconnection logic for the Caddy streams server. If Caddy goes down, all real-time updates silently fail and the system continues operating as if everything is fine.

### R-6: Fire-and-Forget Patterns Without Error Boundaries
24+ fire-and-forget async operations are scattered across the codebase. While most have `.catch()` handlers with logging, several use `void this.method()` which means unhandled rejections from those calls will only be caught by the global `unhandledRejection` handler. Examples:
- `void this.recordSkillExecutionForTask(...)` (4 occurrences in agent-execution.service.ts)
- `void this.worktreeInit.cleanupWorktree(...)` (2 occurrences in plan-approval.service.ts)

## External API Error Handling

### Claude Agent SDK
- **Stream errors:** Caught by try/catch in `runAgentPlanning`/`runAgentExecution`, published as `agent:error` events, agent status set to `error` in DB
- **Rate limits:** Detected via `rate_limit_event` messages from SDK, published to session stream. Recovery module suggests pause/retry but actual retry not implemented
- **Assistant errors:** SDK-level errors on messages are captured and published (line 602-626)
- **Session close:** Properly called in both success and error paths
- **Gap:** No timeout on SDK operations; no retry for transient failures

### GitHub API (Octokit)
- **Token validation:** Properly differentiates 401 (invalid), 429 (rate limited), and other errors in `team-github-token.ts`
- **Rate limit handling:** On 429, preserves previous validation state rather than marking invalid
- **Token format validation:** Validates PAT format before API call
- **Gap:** `waitForRepoReady()` in `github.ts` has a hardcoded 15-attempt poll with 2-second sleep but silently returns `false` on failure - caller may not handle this well

### Docker API
- **Container creation:** Errors wrapped in `SandboxErrors.CONTAINER_CREATION_FAILED` with message
- **Container recovery:** `DockerProvider.recover()` on startup scans for existing containers and re-registers them
- **Container removal:** Empty catch blocks for force-removal during cleanup (line 465)
- **Exec termination:** Empty catch on process kill (line 365) - intentional but no logging
- **Gap:** No health check for Docker daemon after initial startup. If Docker daemon restarts, the provider continues with stale container references

### Caddy Streams Server
- All publish failures are silently swallowed (empty catch blocks)
- **Mitigation:** DB persistence happens first, so events are durable. Clients can hydrate from DB on refresh
- **Gap:** No reconnection, no health check, no alerting

## Graceful Degradation

### What Works
1. **Sandbox unavailable:** The system functions without sandboxing. Sandbox init is non-blocking and uses lazy re-init in dev mode. `getSandboxProvider()` returns null gracefully.
2. **Memory service down:** All memory operations are fire-and-forget. Agent execution continues without memory context injection, with logged warnings.
3. **Caddy streams down:** Events are persisted to DB first. Real-time SSE fails silently, but clients can poll/refresh for state.
4. **Skill tracking unavailable:** All skill recording is fire-and-forget with null checks.

### What Doesn't
1. **Claude SDK unavailable:** Agent tasks fail completely. No fallback, no queuing for retry.
2. **Database down:** Complete application failure. No read-only fallback, no cached responses.
3. **GitHub API down:** Token validation fails, repo creation fails. Template sync fails silently (empty catches). No cached state for read operations.
4. **Real-time streams silent failure:** No user-visible indicator that real-time updates have stopped. The UI shows stale state with no "connection lost" warning in the agent execution view (the `useEventStream` hook only covers the event log, not session-specific streams).

## Recommendations

### Priority 1 - Critical (1-2 days each)

1. **Fix `validateTransition()` discard in `stop()`** - Check the return value and return an error if the transition is invalid. (~0.5 day)

2. **Add cleanup for session and physical worktree on transaction failure** - In `agent-execution.service.ts:404`, clean up the session record and call `worktreeService.remove()` alongside the worktree DB deletion. (~0.5 day)

3. **Audit and fix critical empty catch blocks** - At minimum, add `log.warn()` to the 10 most impactful empty catches: session-stream publish, api-key markInvalid, template-sync-scheduler, docker-provider termination. (~1 day)

### Priority 2 - Important (2-5 days each)

4. **Add max runtime timeout for native agent execution** - Add an `AbortSignal.timeout()` or manual timeout in `executeAgentAsync()` to match the container agent's `AGENT_MAX_RUNTIME_MS` pattern. (~1 day)

5. **Implement retry for Claude SDK transient errors** - Wrap `session.send()` and the stream loop in retry logic with exponential backoff for 429, 500, 503, and network errors. The `recovery.ts` module already identifies rate limits. (~2 days)

6. **Add Caddy streams health check** - Periodic ping to the Caddy streams server with a circuit breaker. When unhealthy, log warnings and skip real-time publish attempts rather than failing silently. (~2 days)

7. **Add `void` expression error handling** - Replace `void this.method()` patterns with `this.method().catch(log.warn)` to ensure errors are logged rather than relying on the global unhandledRejection handler. (~1 day)

### Priority 3 - Improvement (1-2 weeks)

8. **Production-safe invariant alternative** - Consider adding a `strictInvariant()` that throws in all environments for truly critical assertions (e.g., auth checks, payment calculations), while keeping the current `invariant()` for non-critical checks. (~1 day)

9. **Circuit breaker for external services** - Implement a shared circuit breaker utility for Claude SDK, GitHub, Docker, and Caddy calls. When a service is in open state, fail fast with a clear error rather than waiting for timeouts. (~3 days)

10. **Structured error chain preservation** - Several catch blocks throw new errors without preserving the cause chain. Adopt `new Error(msg, { cause: originalError })` pattern per the Semgrep rule. (~2 days)

11. **Real-time connection health indicator** - Add a client-side health check that detects when the stream connection is down and shows a banner. The `useEventStream` hook has reconnection but no user notification beyond connection state. (~2 days)

12. **Agent execution retry queue** - When an agent fails due to transient errors, automatically re-queue the task with backoff instead of requiring manual user intervention to restart. (~3 days)
