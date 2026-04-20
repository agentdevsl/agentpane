# Cross-Cutting Concerns

## Summary
Horizontal hygiene that spans every subsystem: type-safety escapes, `Result<T,E>` discipline, background-job lifecycles, config duplication, import coupling, date/time handling, retry/timeout policy, stream-ID generation, Biome-ignore inventory, and magic-number centralisation. The codebase scores well on the primitives — `Result<T,E>` is defined once and used across 442 occurrences in 79 files, `CircuitBreaker` and `withRetry` live in `src/lib/utils`, and CLAUDE.md codifies the "no empty catch / no silent failure" rule. The drift is in consistent *application*: 29 `as unknown as` casts concentrate in three root causes (Drizzle polymorphism, event-payload narrowing, Cron config JSON), `Result` discipline breaks at the route boundary, four background timers have either unclear shutdown semantics or non-idempotent start, and the retry/circuit-breaker utilities are not imported outside their own test files. No P0 — the discipline exists; it is unevenly enforced.

## Map
| Cross-cutting concern | Primary files | Scope |
|-----------------------|---------------|-------|
| Type escapes | `services/*.service.ts`, `server/bootstrap/phases/database.ts`, `server/routes/health.ts` | 29 prod, 31 test `as unknown as` |
| Result discipline | `lib/utils/result.ts` + 79 consumers | Services return `Result`; routes mix `throw` + `Result` |
| Background jobs | `services/{scheduler,event-cleanup,task-creation,agent/agent-execution,sandbox,session/session-presence,container-agent/sandbox-state,memory/dream-scheduler}.service.ts`, `lib/sandbox/controllers/sandbox-controller.ts`, `server/routes/auth.ts` | 11 long-lived `setInterval` producers |
| Retry / CB utilities | `lib/utils/retry.ts`, `lib/utils/circuit-breaker.ts` | Zero production imports outside tests |
| Config sources | `services/settings.service.ts`, `lib/env.ts`, `server/bootstrap/server-config.ts`, `src/settings` DB table | Three layers, precedence ad-hoc per consumer |
| Stream ID factory | 81 `createId()` call sites across 30 files; ID prefixes (`plan:`, `sandbox:`, `terraform:`) applied inline | No central factory |
| Biome ignores | 37 `biome-ignore` comments across 28 files | `router.ts` has 9 duplicates in one block |
| Time / dates | 611 `new Date()` / `Date.now()` across 211 files | Mix of ISO strings, Unix ms, `Date` objects in DB |

## What's working
- `src/lib/utils/result.ts` gives one canonical `Result<T, AppError>` with `ok()` / `err()` constructors; 79 files use it.
- `CircuitBreaker` (`src/lib/utils/circuit-breaker.ts`) has proper half-open transition logic and 200-line test coverage.
- CLAUDE.md explicitly forbids empty catches and "fake success" responses; the Biome rule `noEmptyBlockStatements` is an error (seen in theme 10 findings).
- Timer handles are uniformly typed as `ReturnType<typeof setInterval>` — TypeScript catches handle reuse.
- `@paralleldrive/cuid2` is the one ID library; no `Math.random`-based IDs survive.
- `src/lib/env.ts` exists as a single env-parsing module (even if under-used).

## Findings

### F12-01: Drizzle polymorphism forces three runtime type holes
- **Priority**: P2
- **Observation**: `server/bootstrap/phases/database.ts:47,49,73` casts both `drizzlePg(...)` and `drizzle(...)` results to the internal `Database` union via `as unknown as Database`. `server/routes/health.ts:99,102` repeats the same pattern to call Postgres-only `execute()`. Root cause: the unified `Database` type in `src/types/database.ts` is an intersection the two concrete drivers can't structurally satisfy.
- **Risk**: Any future Drizzle API change slips past TypeScript silently; a wrong driver at runtime produces "method is not a function" rather than a compile error.
- **Recommendation**: Introduce a narrow `DatabaseClient` interface exposing only the subset both dialects truly share (`select/insert/update/delete/transaction/execute?`). Keep driver-specific capabilities behind discriminated helpers (`isPg(db)` / `isSqlite(db)`). Delete the three `as unknown as Database` casts in `database.ts` and both in `health.ts`.

### F12-02: Cron config is stored as JSON and cast four times
- **Priority**: P2
- **Observation**: `services/scheduler.service.ts:195,602,758,817` and `server/routes/events.ts:547` all cast `source.config as unknown as CronEventSourceConfig`. The column is typed `json` in Drizzle but the runtime shape is only validated on write in some paths and not at all on read.
- **Risk**: A corrupt or older-schema `event_sources.config` row becomes an unchecked read that blows up deep in the tick loop (silent reschedule failure).
- **Recommendation**: Define `cronConfigSchema` (Zod) once in `src/db/schema/shared/cron-config.ts`, parse on read inside `SchedulerService.loadSource()`, and return `Result<CronEventSourceConfig, AppError>`. Downstream casts disappear and malformed rows fail fast with a logged diagnostic.

### F12-03: Plan row cast repeated four times across container-agent
- **Priority**: P2
- **Observation**: `container-agent/plan-approval.service.ts:197,474,485` and `container-agent/container-exec.service.ts:1186` all cast `db.select({...}).get()` to `TaskPlanRow` via `as unknown`. Same SELECT shape, same target type, four copies.
- **Risk**: Shape drift (new column, renamed field) updates the type but not all four SELECTs; a reader silently receives `undefined` for the new field.
- **Recommendation**: Add `plan-approval/queries.ts` exporting `selectTaskPlanRow(db, taskId): Promise<Result<TaskPlanRow | null, AppError>>`. Both services call it; the cast lives in exactly one place and is covered by the single query shape.

### F12-04: Background timer lifecycle is inconsistent
- **Priority**: P1
- **Observation**: Eleven services own long-lived `setInterval`s. Cleanup discipline varies: `SchedulerService`, `EventCleanupService`, `DreamScheduler`, `CliMonitorService`, `SandboxController`, `SessionPresenceService`, `AgentExecutionService`, `SandboxStateManager` all expose `stop()` and are drained by bootstrap shutdown. `TaskCreationService` starts `cleanupInterval` at line 214 but exposes no stop method (grep: 0 matches for `stop()`/`dispose()`/`shutdown()` in the file). `server/routes/auth.ts:312` starts a session-cleanup `setInterval` in module init and relies on `unref()` alone — no way to stop from tests or graceful shutdown. `agentcore-bridge.service.ts:302` sets a per-agent `setTimeout` with `unref()` but never `clearTimeout`s it on successful completion — dangling timers accumulate one-per-task.
- **Risk**: Vitest cross-test leaks (timers firing against a closed DB handle), process taking longer than the shutdown deadline, and in `agentcore-bridge` a monotonic memory footprint across agent runs.
- **Recommendation**: Standardise a `BackgroundJob` interface (`start()` / `stop()` / `isRunning()`), require every service owning a timer to implement it, and have `ServerBootstrap` track them in an array drained on `SIGTERM`. Add an ESLint/Semgrep rule: top-level `setInterval` outside a class owning a `stop()` is an error.

### F12-05: `Result<T,E>` discipline stops at the route boundary
- **Priority**: P2
- **Observation**: Services return `Result<T, AppError>` uniformly (79 service files). Routes (`src/server/routes/*.ts`) mostly unwrap with `if (!result.ok) return json(...)` but several call sites still `throw` from services (`session-stream.service.ts` has 2 `throw new Error`, `task-creation.service.ts` has 7 — per grep). A mixed pattern in the same call stack means a caller has to both check `.ok` *and* wrap in `try/catch`, which in practice means one or the other gets skipped.
- **Risk**: Unhandled throw leaks to the default Hono error handler; `AppError.code` is lost, the UI gets a generic 500, and the error never reaches the service-level logger.
- **Recommendation**: Adopt "services never throw" as a hard rule. Replace every `throw new AppError(...)` in a service with `return err(appError(...))`. Add a Biome custom rule or Semgrep to flag `throw` inside files matching `*.service.ts` (allow `invariant()`-style assertions only). Routes then need *only* the `.ok` check.

### F12-06: `retry` and `CircuitBreaker` utilities have zero production consumers
- **Priority**: P2
- **Observation**: `src/lib/utils/retry.ts` and `src/lib/utils/circuit-breaker.ts` exist with full tests. Grep for `from '@/lib/utils/retry'` or `from '@/lib/utils/circuit-breaker'` across `src/` returns **no files**. Meanwhile `github.service.ts`, `terraform-registry.service.ts`, `caddy-producer.ts`, `plan-mode/claude-client.ts` each implement bespoke retry loops with ad-hoc backoff constants.
- **Risk**: Six independent retry policies drift in behaviour (jitter vs no jitter, cap differences, non-idempotent retries on POST). Rate-limit handling is copy-pasted instead of shared.
- **Recommendation**: Migrate `github/rate-limit.ts`, `terraform-registry.service.ts`, and Caddy producer flush to `withRetry()` in one PR. Wrap outbound HTTP to Caddy and GitHub in `CircuitBreaker` so upstream outages don't cascade to 100% of agent operations.

### F12-07: Config has three sources, no typed precedence layer
- **Priority**: P2
- **Observation**: Config lives in (a) `settings` DB table (read via `SettingsService.get()` — 25 sites), (b) `process.env` (135 sites across 43 files), (c) hard-coded defaults inside service constructors. Precedence is decided ad-hoc: `agentcore-bridge.service.ts` uses "env var > DB setting > default 4hr" for max runtime; other services read env directly, others read only from DB.
- **Risk**: Operator changes a UI setting, restarts the server, and the value silently loses to a stale env var. Tests can't easily override because the lookup is per-site.
- **Recommendation**: Introduce `AppConfig` keyed by config-name, each entry declaring `{ envVar, settingsKey, default, schema }`. `AppConfig.get('agent.maxRuntimeMs')` centralises precedence. The 25 `settingsService.get()` sites and 135 `process.env.` sites collapse toward this single surface over time.

### F12-08: Stream ID prefixes are applied at 4+ call sites without a factory
- **Priority**: P2
- **Observation**: The durable-stream ID scheme (`plan:{id}`, `sandbox:{id}`, `terraform:{id}`, bare CUID for sessions) is documented in CLAUDE.md but applied by string concatenation at each producer: `plan-mode.service.ts`, `codespace.service.ts`, `terraform-compose.service.ts`, `sandbox.service.ts`, plus every consumer that has to strip the prefix.
- **Risk**: A typo (`"plan-"` vs `"plan:"`) produces a silent non-overlap between producer and consumer — observed in the past per the CLAUDE.md "Plan stream ID prefix" note.
- **Recommendation**: Add `src/lib/streams/stream-id.ts` exporting `streamId.forPlan(id)`, `streamId.forSandbox(id)`, `streamId.forTerraform(jobId)`, `streamId.forSession(id)` plus `parseStreamId(raw): { kind, id }`. Replace the 81 `createId()` + concat sites that build durable-stream IDs.

### F12-09: Magic numbers are scattered, not centralised
- **Priority**: P3
- **Observation**: 152 literals matching `60_000 / 60 * 1000 / 3600` appear across 82 files. TTLs, ping intervals (SSE 30s), session idle timeouts, retry backoffs, rate-limit windows — each defined where it's used. Some are `const` inside the class (`TaskCreationService.CLEANUP_INTERVAL`), some are inline (`setInterval(..., 30000)`), some reference `DREAM_TICK_INTERVAL_HOURS * 60 * 60 * 1000` with the math done in-place.
- **Risk**: Tuning in ops means grepping for numbers; two constants drift (e.g., frontend poll interval and backend expiry) because they're in different files.
- **Recommendation**: `src/lib/constants/timing.ts` with named exports (`SSE_PING_INTERVAL_MS`, `SESSION_IDLE_TIMEOUT_MS`, `AGENT_ORPHAN_SWEEP_MS`, etc.). No logic change; purely a rename pass. Makes the ops knob surface explicit.

### F12-10: `@ts-nocheck` on five test files hides schema drift
- **Priority**: P2
- **Observation**: `src/services/memory/__tests__/{memory,dream,memory-store,skill-tracking,insight-deriver}.service.test.ts` all open with `// @ts-nocheck — test mocks use loose types`. Combined with `as unknown as SettingsService` / `as unknown as SkillTrackingService` mocks (seven occurrences in `dream.service.test.ts` alone), the memory subsystem's tests exercise almost no type contract.
- **Risk**: A service signature change in `MemoryStoreService` passes TypeScript *and* its own tests because the tests have type-checking disabled. The regression surfaces in integration or prod.
- **Recommendation**: Delete `@ts-nocheck`, create `src/services/memory/__tests__/mocks.ts` with typed partial-mock factories (`createMockSettingsService(overrides?)`), and fix whatever type errors surface. Small tactical effort; removes an entire class of silent regressions.

### F12-11: `router.ts` carries 9 identical `biome-ignore useHookAtTopLevel`
- **Priority**: P3
- **Observation**: `src/server/router.ts:323-337` has nine copies of `// biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook`. The rule fires because the helper is named `useRoleGuard` — Biome's heuristic is purely syntactic.
- **Risk**: Noise invites cargo-culting (new ignores added without checking). A genuine misuse would be buried in the same visual block.
- **Recommendation**: Rename `useRoleGuard` → `requireRole` (or `roleGuard`). One rename deletes all nine ignores and removes the false positive permanently. Most of the remaining 28 `biome-ignore`s are legitimate (Shiki HTML, dnd-kit attribute spread, intentional `noAutofocus`) — they should carry a short "why this is correct" rationale, which most already do.

### F12-12: Date/time representation is not normalised
- **Priority**: P3
- **Observation**: 611 `new Date()` / `Date.now()` sites across 211 files. Drizzle columns are a mix of `text('created_at')` (ISO string via `new Date().toISOString()`), `integer('created_at', { mode: 'timestamp_ms' })` (Unix ms), and `timestamp` (PG-only). The Caddy-produced event envelope uses Unix ms; `session_events.created_at` is ISO text; `userSessions.expiresAt` is ISO text compared via `lt(..., now)` string comparison in `auth.ts:317`.
- **Risk**: String-comparison of ISO timestamps works only because the format is fixed-width; a migration to local-offset or microseconds would silently break ordering. Mixing `Date.now()` with ISO-stored columns requires `new Date(ms).toISOString()` at every boundary — easy to forget.
- **Recommendation**: Pick Unix ms as the canonical internal representation, keep ISO text only for human-readable audit columns. Add `src/lib/utils/time.ts` with `nowMs()`, `toIso(ms)`, `fromIso(text)` helpers; run a migration to convert the handful of ISO-stored timestamp columns. Follow-up, not urgent — but document the convention in CLAUDE.md so it stops drifting.
