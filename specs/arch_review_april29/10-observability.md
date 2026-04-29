# 10 — Observability (April 29 Review)

**Theme:** structured logging, log redaction, log level discipline, metrics, tracing, `/api/health` probe, silent catch blocks, error funnels, audit log coverage, request correlation.

**Status snapshot vs April 20 review:** The plumbing landed in PR #176 is real and correct in shape. `MetricsService` exists, `/api/metrics` is routed and admin-guarded, `captureException()` is wired into the five canonical sites, `correlationId` flows through the durable-stream envelope and into agent-runner via `CORRELATION_ID`, agent-runner's structured stderr logger replaced 79 of the 87 raw `console.*` calls, and the cardinality-bounded `metricsMiddleware` records HTTP requests. The defining failure mode of this round, however, is that **most of the metrics service's surface is unused outside the metrics module itself** — `incAgentStarted`, `setAgentGauge`, `incSse/decSse`, and `recordDbLatency` have zero call sites in `src/services/**` and `src/lib/**`. The endpoint exists; it's structurally a hollow shell whose only populated field is the HTTP counter. April 20's F10-01 was technically resolved by the route landing; in practice the operational question "how many agents are running right now" still cannot be answered from `/api/metrics`.

The other major April 20 items also remain in their prior state: silent-catch tail (F10-02) is unmoved, audit coverage (F10-12) is still hook-only, frontend observability (F10-07) is still zero, scheduler heartbeats (F10-06) are still ad-hoc, health checks (F10-10) are still sequential and timeout-less. New observations specific to this round: missing Nomad subsystem in `/api/health`, rate-limit 429 responses log nothing, error.cause and arbitrary Error properties are dropped before masking, and dev-mode log formatting strips stack traces.

## Map (verified `path:line`)

- **Structured logger.** `src/lib/logging/logger.ts:62` (`maskSensitiveData`), `:131-148` (service/env/level), `:181-217` (`log()` core), `:226-245` (`createLogger`).
- **Request context.** `src/lib/context/request-context.ts:14` (`AsyncLocalStorage`), `:22-24` (`getRequestId`).
- **Request-ID middleware.** `src/server/router.ts:97-104` (`requestIdMiddleware`), `:336` (`app.use('*', requestIdMiddleware)`).
- **HTTP metrics middleware.** `src/server/router.ts:111-130` (`metricsMiddleware`), `:339`. Cardinality bound at `:146-171` (`normaliseMetricsRoute`, `METRICS_ROUTE_LIMIT = 500`).
- **Hono access log.** `src/server/router.ts:335` (`app.use('*', logger())`). No latency capture, no `requestId`.
- **App `onError`.** `src/server/router.ts:674-695` — logs + `captureException`.
- **Process handlers.** `src/server/api.ts:22-30` — both `uncaughtException` and `unhandledRejection` route to `captureException`.
- **Health.** `src/server/routes/health.ts:50-317` — 7 subsystem checks (database, github, sandbox, kubernetes, streams, apiKey, sandboxInit). Sequential. Only the streams reachability check has a 3 s `AbortSignal.timeout` (`:251`).
- **Liveness/Readiness.** `src/server/routes/health.ts:290-294` and `:295-314`; alternate aliases at `src/server/router.ts:493-501` (`/api/healthz`, `/api/readyz`).
- **MetricsService.** `src/services/metrics.service.ts:57-208`; singleton at `:218-226`.
- **`/api/metrics` route.** `src/server/routes/metrics.ts:26-55`. Wired at `src/server/router.ts:660-668` behind admin RBAC.
- **Admin metrics.** `src/server/routes/admin-metrics.ts:20-62` — plan-mode + streams. Wired at `src/server/router.ts:649-655`.
- **Error sink.** `src/lib/telemetry/error-sink.ts:64-82` (default sink), `:95-108` (`captureException`), `:127-133` (`initSentryIfConfigured`).
- **Invariant.** `src/lib/utils/invariant.ts:21-46` (logs-and-returns in prod, throws in dev), `:53-68` (`strictInvariant` always throws), `:74-83` (`softInvariant`).
- **State machine telemetry.** `src/lib/state-machines/instrumented-machine.ts:33-76` — `log.info` per transition; optional `onTransition` callback never wired.
- **Audit.** Schema at `src/db/schema/sqlite/audit-logs.ts:10-36` and `src/db/schema/postgres/audit-logs.ts:9-33`. The single writer is `src/lib/agents/hooks/audit.ts:25` (PostToolUse hook). No other call site.
- **Agent-runner logger.** `agent-runner/src/logger.ts:52-101` — JSON-line stderr logger. `correlationId` from `CORRELATION_ID` env. Host-side parser is `src/lib/agents/container-bridge.ts:60-69` (`tryReplayAgentRunnerLogLine`).
- **Stream envelope correlation.** `src/lib/streams/envelope.ts:23-41` (`streamEventMetadataSchema.correlationId`); fill-in at `src/lib/streams/session-event.ts:7,27,33,43` (defaults to `getRequestId()`).
- **Rate limiter.** `src/lib/api/rate-limiter.ts:258-269` — 429 response. **No log emission on trip.**

## Verified counts (April 29)

- `catch {` (no binding): **169 occurrences across 79 files** under `src/` (excluding `__tests__/`).
- `catch (_*)` (binding ignored): **31 occurrences across 21 files**.
- `console.*` in `src/app/**` (frontend): **237 occurrences across 64 files** (close to April 20's 241/70).
- `console.*` in `src/server`/`src/services`/`src/lib`: **5 functional sites, all in `src/lib/logging/logger.ts`** (lines 143, 206, 209, 212, 215) — the logger's own implementation. The 3 remaining `console.*` in `agent-runner/src/` are JSDoc comments and one fallback in `logger.ts:84`.
- Audit-log writers: **1** (`src/lib/agents/hooks/audit.ts:25`).
- MetricsService consumers (excluding self + the metrics route): **0**.

## What's working

1. **F10-03 step 1.** `correlationId` is plumbed end-to-end: from `getRequestId()` on the host, through `streamEventMetadataSchema.correlationId` (`envelope.ts:23-41`), into the agent-runner via `CORRELATION_ID` env, and through the runner's stderr JSON logger (`agent-runner/src/logger.ts:55-72`). Host-side replay at `container-bridge.ts:46-69` preserves the field on `createLogger('agent-runner')`. The "single operation across the API/runner/stream boundary" goal is achieved for the events that go through the envelope.
2. **F10-04 sink.** `captureException()` is wired into all five canonical sites (process handlers `src/server/api.ts:22-30`, `app.onError` `router.ts:674-695`, `invariant`/`strictInvariant` `invariant.ts:33-38, 61-66`, planning catch `agent-execution.service.ts:840-845`). `initSentryIfConfigured()` runs on startup as a no-op breadcrumb.
3. **F10-05.** Agent-runner has a real structured logger; the file-by-file sweep landed (only the `console.error` fallback in `agent-runner/src/logger.ts:84` survives, as a defensible last-resort). `tryReplayAgentRunnerLogLine` runs before the event JSON parse so log lines route correctly (`container-bridge.ts:46`).
4. **F10-09.** `PlanModeService.getMetrics()` is folded into `/api/metrics.planMode` (`metrics.ts:36, 49`) and surfaced separately on `/api/admin/metrics/plan-mode` (`admin-metrics.ts:23-39`). The drop-counter is no longer write-only.
5. **HTTP metrics cardinality.** `normaliseMetricsRoute` (`router.ts:149-171`) buckets unmatched paths to `<404>` / `<other>` and caps observed routes at 500, preventing the unbounded-key blow-up that would have followed a naive implementation. This is the hardest part of `/metrics` to get right and it is correct.
6. **Mask coverage.** `maskSensitiveData` (`logger.ts:62-106`) handles circular refs, depth limit (10), `Date`/`RegExp` preservation, recursive arrays/objects, 17 sensitive field names, and 5 token-value patterns. 18 mask tests in `src/lib/logging/__tests__/mask-sensitive-data.test.ts`.

## Findings

### F10-14 — `MetricsService` is a hollow shell — only HTTP requests populate

- **Priority:** P1
- **Effort:** S
- **Observation:** A repository-wide grep for `incAgentStarted|incAgentCompleted|incAgentErrored|setAgentGauge|incSse|decSse|recordDbLatency|incCounter|setGauge` returns **zero hits outside `src/services/metrics.service.ts` itself and the `/api/metrics` route file**. The middleware in `src/server/router.ts:111-130` calls `recordHttpRequest` per response, and the route handler folds in `getEventRouterSnapshot()` and `streamsService.getPublishLagMetrics()` and `planModeService.getMetrics()` — but none of the agent lifecycle, SSE, or DB-latency methods are called by anyone. The `agent`, `sse`, and `db.byQueryType` sections of the snapshot will always show zeros in production unless the EventRouter snapshot is consulted (which is only the in-process SSE counter, not the dedicated `MetricsService.sseActive` field).
- **`path:line` evidence:**
  - `src/services/metrics.service.ts:92-98` — `incAgentStarted/Completed/Errored` defined.
  - `src/services/metrics.service.ts:103-114` — `setAgentGauge`, `incSse`, `decSse` defined.
  - `src/services/metrics.service.ts:117-127` — `recordDbLatency` defined.
  - **No callers anywhere in `src/`.**
  - `src/server/routes/metrics.ts:34` — only `getEventRouterSnapshot()` actually populates the SSE field.
- **Risk:** Operations cannot answer "how many agents are running right now" or "what's the p95 DB latency" from `/api/metrics`. The endpoint passes its tests because the tests directly call `metricsService.incAgentStarted()` etc. — production traffic does not. The next round of "we need a metric for X" will reasonably conclude that the methods exist and assume they're wired, then debug for an hour finding they aren't.
- **Recommendation:**
  1. `agent-execution.service.ts` — call `incAgentStarted` on each `start()`, `incAgentCompleted`/`incAgentErrored` in the lifecycle catch (around `:817`/`:836`). Call `setAgentGauge(this.runningAgents.size, idleCount)` on each transition.
  2. `event-bus.ts` / `cli-monitor` SSE entry points — call `incSse`/`decSse` symmetrically. The EventRouter already counts; either delete `MetricsService.sseActive` or have it shadow the EventRouter snapshot.
  3. Database — wrap the Drizzle `db.execute`/`db.query.*` paths used by hot routes with a tiny `withDbLatency('select_task', () => ...)` helper. Even sampling 1% gives useful p95 data.
  4. Wire `instrumentMachine`'s `onTransition` callback (`instrumented-machine.ts:30, 70`) to a metrics counter so cycle-time data isn't only in logs.
  5. Add an integration test that hits a real route and asserts the agent counter incremented — if no integration test forces wiring, the hollow-shell pattern repeats.
- **Links:** F10-01 (the original endpoint finding), `src/services/metrics.service.ts:67-127`.

### F10-15 — Sequential health checks with no per-subsystem timeout (still)

- **Priority:** P2
- **Effort:** S
- **Observation:** `src/server/routes/health.ts:60-287` runs the six subsystem checks sequentially. Only the streams reachability check has a timeout (`:251` — 3 s). The K8s `healthCheck()` at `src/lib/sandbox/providers/agent-sandbox-provider.ts:461-514` issues blocking control-plane RPCs with no abort signal. Under DB lock contention or K8s control-plane slowness, `/api/health` can block for the duration of the slowest subsystem, while a Kubernetes liveness probe with the default 1 s timeout will mark the pod unhealthy and trigger a restart. April 20's F10-10 called this out; nothing changed.
- **Risk:** Thundering-herd restart loop during DB or K8s degradation. The readiness gate at `:67-83` correctly responds 503 fast during sandbox init, but the deep `/api/health` check has no equivalent safeguard.
- **Recommendation:** Wrap each subsystem check in a `withTimeout(check, 1000, 'subsystem-name')` and run them via `Promise.allSettled`. On timeout, the subsystem reports `status: 'timeout'`. Document that the `/api/health/readiness` endpoint at `health.ts:295-314` is the correct K8s liveness target — the deep `/api/health` is for human dashboards. The deployment spec should pin this; right now nothing prevents an operator from pointing a 1 s liveness probe at `/api/health` and self-DOS-ing.
- **Links:** April 20 F10-10; `src/server/routes/health.ts:60-287`; `src/lib/sandbox/providers/agent-sandbox-provider.ts:461`.

### F10-16 — `/api/health` does not check Nomad even though the provider exists

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/server/router.ts:266-267` and `:555-556` plumb `getNomadProvider` through to the sandbox-status route. The bootstrap pipeline at `src/server/bootstrap/server-bootstrap.ts:136, 149` resolves it. But the call to `createHealthRoutes` at `router.ts:483-491` only passes `getK8sProvider`, not `getNomadProvider`, so a deployment running on Nomad reports `kubernetes: not_configured` and never checks Nomad cluster reachability. Consequence: an operator using Nomad gets a false sense of health — DB ok + apiKey ok ⇒ "healthy" — while the actual workload runtime is opaque to the probe.
- **Recommendation:** Extend `HealthDeps` (`health.ts:33-48`) with `getNomadProvider`, mirror the K8s block at `:217-244`, and pass the dep through at `router.ts:483-491`. While at it, consider a generic `getProviders` array to avoid the three-provider branch repetition. There are also no health checks for the durable-streams DB outbox (event-outbox-relay) or the GitHub App webhook plumbing — both should follow the same pattern.
- **Links:** `src/server/router.ts:266-267, 555-556`; `src/server/routes/health.ts:33-48, 217-244`; `src/server/bootstrap/server-bootstrap.ts:136`.

### F10-17 — Audit-log writes still come only from agent tool hooks

- **Priority:** P2
- **Effort:** M
- **Observation:** A repository-wide grep for `db.insert(auditLogs)` returns one hit: `src/lib/agents/hooks/audit.ts:25`. Every other security-relevant state change — admin settings update (`src/services/settings.service.ts`), API key create/delete (`src/services/api-key.service.ts`), team member add/remove (route handlers), RBAC role assignment (`src/services/rbac.service.ts`), codespace deletion (`src/services/codespace.service.ts:421-440`), GitHub App install/rotate (`src/services/github-app.service.ts`), sandbox provider config switch (`src/services/sandbox-config.service.ts`) — does not write an audit row. The schema also has no `userId` / `actor` column (`audit-logs.ts:10-36`), so even the rows that exist cannot answer "who". April 20's F10-12 called this out; the schema is unchanged.
- **Risk:** For a multi-tenant system with stored GitHub tokens and Claude OAuth tokens, the compliance answer to "who removed whom from team X" is unanswerable. The audit table is half-built — the data shape is mostly correct (`tool/status/input/output/durationMs/turnNumber`), but it's structured for tool-call audit, not for state-change audit.
- **Recommendation:** Two-step:
  1. Add columns `actor_user_id text references users(id) on delete set null`, `actor_kind text` (one of `user|api_token|system`), `request_id text`, `event_kind text` (e.g. `team.member.removed`, `settings.updated`, `api_key.created`). Migration. Schema-drift test (per CLAUDE.md). Reconcile with the existing `tool` / `agent_id` / `agent_run_id` columns by treating tool-hook audits as a special kind (`event_kind = 'tool.execution'`).
  2. Define a small `auditService.record(eventKind, { actor, codespaceId, taskId, before, after, requestId })` helper that wraps the write + masks before/after via `maskSensitiveData`. Call from each service method that mutates security-relevant state.
- **Links:** April 20 F10-08 (audit-side), F10-12; `src/db/schema/sqlite/audit-logs.ts:10-36`; `src/lib/agents/hooks/audit.ts:25`.

### F10-18 — Empty/silent catch tail unchanged

- **Priority:** P2
- **Effort:** S
- **Observation:** Counts:
  - `catch {` — 169 occurrences across 79 files (April 20: 168/78).
  - `catch (_*)` — 31 occurrences across 21 files (April 20: 31).
  Sampling across the boot path, scheduler tail, and route handlers shows the same pattern as April 20: a `catch {}` followed by a comment ("Best effort", "Use default", "Continue checking remaining sandboxes") and no log emission. Examples:
  - `src/server/bootstrap/sandbox/heal-intervals.ts:69, 97, 110, 120, 182` — five "best-effort" silent catches in the K8s heal loop. If `kubectl apply` is silently failing for every manifest, the heal loop logs nothing and the cluster never recovers.
  - `src/services/sandbox.service.ts:480` — `catch (_sandboxErr)` in the per-sandbox idle-timeout iteration. A consistent failure on one sandbox burns CPU forever and is invisible.
  - `src/services/codespace.service.ts:651, 659, 667` — three swallowed git errors in the validate path. The user gets `defaultBranch = 'main'` regardless of whether `git symbolic-ref` worked.
  - `src/services/memory/dream-scheduler.service.ts:123` — comment "Swallowed — logged inside checkAndDream". Only true if every code path inside `checkAndDream` logs; the outer ack is fragile.
- **Risk:** As April 20: classical silent-failure surface. Heal loops that don't heal, settings panels that don't save, sandbox state-machine ticks that silently no-op. These are exactly the bugs Biome's `noEmptyBlockStatements` was supposed to catch — but the lint allows blocks containing only a comment, which is the dominant pattern here.
- **Recommendation:** A custom AST-level lint or grep gate (Biome doesn't yet support custom rules natively, but `semgrep` is already in use per `.semgrep/rules/`). Forbid `catch (_x)` and `catch {}` unless the block contains either `log.*` or `throw` or `return`. Apply as a CI gate; sweep the 31 `catch (_*)` instances first because they are explicit noise and cheap to fix:
  - 8 sites in `src/app/routes/settings/sandbox/-sandbox-page.tsx` (lines 149, 298, 347, 378, 467, 494, 583 + `:128` in `-config-editor.tsx`).
  - 4 sites in `src/services/git.service.ts` and `src/services/codespace.service.ts` per above.
  - 2 sites in `src/lib/sessions/optimistic.ts:198, 222`.
  Rest fall out the other end of the same sweep.
- **Links:** April 20 F10-02; CLAUDE.md "Empty catch blocks — Never use bare `catch {}`".

### F10-19 — Rate-limit 429 trips emit nothing

- **Priority:** P2
- **Effort:** XS
- **Observation:** `src/lib/api/rate-limiter.ts:258-269` returns 429 silently. No `log.warn`, no metrics counter (the `incCounter('rate_limit.exceeded')` would be one line), no audit row. Operators have no way to detect "user X is being throttled" or "we're getting hammered by token Y" without a downstream load balancer log inspection. Compare with `event-router.ts` which logs at the global cap (`src/lib/events/event-router.ts:19` has its own logger and emits on cap).
- **Risk:** Rate-limit configuration drift goes unnoticed. A new feature that legitimately needs more headroom will look like a "the API is slow" user complaint until someone manually counts 429s. Conversely a brute-force attempt against `/api/auth/*` (which uses the same default limiter) is invisible.
- **Recommendation:** At `:258`, add `log.warn('Rate limit exceeded', { data: { key, count: entry.count, max, route: c.req.routePath } })` and `getMetricsService().incCounter('rate_limit.exceeded.${routePattern}')`. The bucketing should respect the same cardinality protections as the HTTP middleware (route patterns only). Optionally write an audit row when the key is an API token — if a token is hammering, that's worth recording.
- **Links:** `src/lib/api/rate-limiter.ts:258-269`; `src/server/router.ts:398-404` (default and per-token limiters).

### F10-20 — `serializeError` drops `cause`, `name`, and arbitrary Error properties

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/lib/logging/logger.ts:169-179` builds `LogEntry.error` from exactly three fields: `message`, `stack`, `code`. Modern Node Error objects carry `.cause` (the wrapped underlying error), and several SDKs (Anthropic, Octokit, Dockerode) attach `.response`, `.status`, `.body`, `.headers`. Those are silently dropped before reaching the masker. So a structured log line for a 401 from the Claude SDK shows just `"Error: 401 Unauthorized"` with no body, no headers, no cause — the actually-useful diagnostic is gone.
- **Risk:** Production debugging of SDK errors is harder than necessary. The Claude SDK's quota-exceeded errors come back as a generic message; the body explains the actual reason. Same pattern for GitHub 422 errors.
- **Recommendation:** Extend `serializeError` to walk `.cause` (capped depth, e.g. 5 to prevent loops), preserve `.name`, and copy enumerable own properties through `maskSensitiveData`. The masker already handles the recursion. One-file change.
- **Links:** `src/lib/logging/logger.ts:169-179, 199`.

### F10-21 — Dev-mode log formatting strips stack traces

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/lib/logging/logger.ts:156-167` (`formatEntry`). In production it serializes the full entry as JSON (stack included). In development it emits `${level} ${prefix}${reqId} ${message}${dataStr}${errStr}` where `errStr = entry.error ? \` err=${entry.error.message}\` : ''` — only the message, never the stack. Developers running `npm run dev` therefore see error messages without a stack and reach for `console.log(err)` instead of trusting the structured logger. This explains some of the residual 237 `console.*` calls in `src/app/**`.
- **Risk:** Negative reinforcement loop — the logger looks worse than `console.error` in dev, so people don't adopt it. Hidden cost.
- **Recommendation:** In dev, append `\n${entry.error.stack}` when present. Production keeps the JSON form.
- **Links:** `src/lib/logging/logger.ts:156-167`.

### F10-22 — Mask patterns miss generic Bearer/JWT/AWS/OpenAI tokens

- **Priority:** P3
- **Effort:** XS
- **Observation:** `SENSITIVE_VALUE_PATTERNS` (`src/lib/logging/logger.ts:35-41`) covers `sk-ant-*`, `ghp_*`, `ghs_*`, `gho_*`, `github_pat_*`. It does not cover:
  - `Bearer eyJ...` JWT-like (Authorization headers from non-Anthropic SDKs).
  - `AKIA[0-9A-Z]{16}` / `ASIA...` AWS access keys (the Terraform compose stack uses `@aws-sdk/client-sts`).
  - `sk-proj-*` OpenAI keys (any future OpenAI integration).
  - Slack `xox[abprs]-*`, npm `npm_*` (CLI publishing pipeline).
  Field-name masking covers most of these because objects usually wrap them in `token`/`accessToken` keys. But error messages and stack traces include them as raw substrings — e.g., a 401 stack trace from the AWS SDK can carry `AKIA…` in the request URL. The substring masker is only as good as its pattern set.
- **Risk:** Sensitive-data leak through error stacks or arbitrary string log entries that contain a token but lack a labelling field name.
- **Recommendation:** Add four patterns: `/Bearer\s+[A-Za-z0-9\-_.=]+/g`, `/\bAKIA[0-9A-Z]{16}\b/g`, `/\bsk-proj-[A-Za-z0-9\-_]+/g`, `/\bxox[abprs]-[A-Za-z0-9\-]+/g`. Already-tested infrastructure (`mask-sensitive-data.test.ts`) — add four cases.
- **Links:** `src/lib/logging/logger.ts:35-41`.

### F10-23 — No background-job heartbeat surface (still)

- **Priority:** P2
- **Effort:** S
- **Observation:** Two of the 13+ background services track `lastTickAt`:
  - `src/services/scheduler.service.ts:49, 127, 141` — exposed via `getStatus()`.
  - `src/services/event-outbox-relay.service.ts:45, 102, 132` — exposed via `getStatus()`.
  The remaining schedulers (`event-cleanup.service.ts`, `template-sync-scheduler.ts`, `terraform-sync-scheduler.ts`, `session-presence.service.ts`, `sandbox.service.ts` idle-timeout, `cli-monitor.service.ts`, `dream-scheduler.service.ts`, `task-creation.service.ts` retry queue, `agent-execution.service.ts` watchdog) have a `setInterval` but track no heartbeat. None are exposed through `/api/metrics` or `/api/admin/metrics`. So a wedged event-cleanup loop (the most dangerous: `session_events` grows unboundedly) is invisible. April 20's F10-06 called this out.
- **Risk:** Disk-fill scenario for SQLite users; exhausted PG storage for postgres users. Same class of risk as April 20.
- **Recommendation:** Two halves.
  1. Standardise — every service running a recurring tick maintains `private lastTickAt: number | null = null` and a `getHealth()` returning `{ name, lastTickAt, ok, expectedIntervalMs }`. A small registry (`src/lib/background-jobs/registry.ts`) collects these.
  2. Surface — fold the registry into `/api/metrics.gauges` (each scheduler contributes `scheduler.${name}.lastTickAt` as a gauge) so an external scraper can alert on `now() - lastTickAt > 2 * expectedInterval`.
- **Links:** April 20 F10-06; `src/services/scheduler.service.ts:49`; `src/services/event-outbox-relay.service.ts:45`.

### F10-24 — Frontend observability is still zero

- **Priority:** P2
- **Effort:** S (server endpoint) + S (browser wiring)
- **Observation:** 237 `console.*` calls across 64 files in `src/app/**`. The shared `ErrorBoundary` (`src/app/components/ui/error-boundary.tsx:37-41`) only `console.error`s — its `onError` prop is never wired to a server endpoint. There is no `POST /api/telemetry/client-error` route (grep returns nothing). No `window.addEventListener('error'|'unhandledrejection')` handler at the SPA root. No browser Sentry. April 20's F10-07 called this out and recommended a single fallback endpoint as the cheapest fix; nothing landed.
- **Risk:** A user's render crash, failed mutation, or SSE drop reaches no one unless they file a ticket with devtools open. The streaming UX is the product; blind frontends are the largest gap in the observability story.
- **Recommendation:** Three steps, smallest first:
  1. Add `POST /api/telemetry/client-error` (admin/auth required to prevent log spam) that takes `{ message, stack, route, sessionId }` and routes through `createLogger('client').error(...)`. Schema-validate the body; cap size; rate-limit the route (`rateLimiter({ max: 30, windowMs: 60_000, keyFrom: ipKeyFn })`).
  2. Wire `ErrorBoundary.onError` to call the endpoint via `fetch` with `keepalive: true`.
  3. Install a global handler at the SPA bootstrap that catches `unhandledrejection` + `error` events and forwards.
  Sentry browser SDK is the future answer; the fallback endpoint is a one-day fix that captures most of the value.
- **Links:** April 20 F10-07; `src/app/components/ui/error-boundary.tsx:37-41`.

### F10-25 — Hono access log emits no latency, no requestId, and is the wrong shape for parsers

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/server/router.ts:335` mounts Hono's built-in `logger()` middleware. That middleware calls `console.log` directly (it predates the structured logger), emits `<-- GET /path` and `--> GET /path 200 5ms` as two ad-hoc lines, and bypasses `createLogger` entirely — so it has no `requestId`, no `service`, no `environment`, no JSON shape, and no masking. The `metricsMiddleware` at `:111-130` records the count but not the duration. So the per-request latency that operations care about is not captured by either path: it's printed by Hono in plain text and immediately discarded.
- **Risk:** No way to compute p50/p95 per route from logs. No way to correlate the access entry to the structured log entries from the same request via `requestId`.
- **Recommendation:** Replace the Hono `logger()` with a small custom middleware that:
  1. Captures `start = Date.now()` before `await next()`.
  2. After `next()` emits `routerLog.info('http', { data: { method, path: c.req.routePath ?? c.req.path, status: c.res.status, durationMs: Date.now() - start } })`.
  3. Calls `metricsService.recordHttpLatency(route, durationMs)` (new method — extend the histogram surface).
  This both unifies the log stream and unblocks p95-per-route metrics. Drop the upstream `logger()` import.
- **Links:** `src/server/router.ts:11, 335`; `src/server/router.ts:111-130`; `src/services/metrics.service.ts:81-89`.

### F10-26 — `instrumentMachine.onTransition` callback is never wired

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/lib/state-machines/instrumented-machine.ts:30-31, 70` provides an `onTransition` hook that fires on every state-machine `send`. Searching for callers shows it is set nowhere. The data-shaping is done — `TransitionTelemetry` includes `from`, `to`, `event`, `success`, `durationInStateMs`, `guardFailure` — but only the `log.info`/`log.warn` lines at `:63, 65` emit anything. So we have agent/task/session/worktree state transition telemetry in logs (good) but cannot count them or produce cycle-time histograms (bad).
- **Risk:** April 20's "the data is in the log stream; it just isn't counted" continues to be true. Aggregating cycle times for Kanban velocity reports requires log mining.
- **Recommendation:** When constructing each instrumented machine, pass `onTransition: (t) => metricsService.incCounter(\`state.${t.machine}.${t.from}_to_${t.to}\`)` and additionally `metricsService.recordCycleTime(t.machine, t.from, t.durationInStateMs)` (new method). Cardinality stays bounded because the state space is small (the Kanban state count is fixed).
- **Links:** `src/lib/state-machines/instrumented-machine.ts:27-76`.

### F10-27 — `LOG_LEVEL` is read once at module load with no live-reload

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/lib/logging/logger.ts:137-148` resolves the level once on module load, with a fallback of `info` in production and `debug` otherwise. To bump verbosity in a running prod instance you must restart. There is also no per-context override (e.g. "debug for `AgentExecutionService` only") which is what you actually want during incident response.
- **Risk:** During a live incident, the operator either deploys a config change (slow) or restarts (data-loss-adjacent). The CLAUDE.md docs already warn that pre-commit hooks block fixing prod.
- **Recommendation:** Two halves.
  1. Re-evaluate `process.env.LOG_LEVEL` per call — the cost is negligible at the volume we run.
  2. Add a `LOG_LEVEL_OVERRIDE` env that is a JSON map: `{"AgentExecutionService":"debug","TaskService":"warn"}`. The logger's `createLogger(context)` checks the override map for the context name. One-file change.
- **Links:** `src/lib/logging/logger.ts:137-148`.

### F10-28 — Process unhandled rejection logs but does not exit; uncaught exception relies on Node default behaviour

- **Priority:** P2
- **Effort:** XS
- **Observation:** `src/server/api.ts:22-30` registers both handlers. Both call `log.error` and `captureException`. Neither calls `process.exit(1)`. Behaviour:
  - `uncaughtException` — without a handler, Node exits with code 1. With a handler, Node does **not** exit (handler is informational). Our handler does nothing more than log + capture, so the process stays running in an undefined state. This is the opposite of what most operators expect from "uncaught exception".
  - `unhandledRejection` — Node 24 default behaviour is `throw` (which would then crash). Adding a handler suppresses the default. So our handler effectively converts unhandled rejections from "crash" to "log and continue". Same problem.
  Combine with F10-13 (April 20 — `invariant` logs and continues in prod) and the system has three independent "log and pretend nothing is wrong" code paths. April 20's recommendation for invariant was to throw in prod; same applies here.
- **Risk:** A wedged process that has lost track of internal invariants (a Map iteration that threw mid-loop, a streaming response that aborted the response object) keeps serving traffic and produces increasingly nonsensical results until restarted manually.
- **Recommendation:** Both handlers should:
  1. Log + capture (existing behaviour).
  2. Call `process.exit(1)` after a small flush window (`setTimeout(() => process.exit(1), 250)`) so log lines reach stderr before the process dies.
  3. The container restart policy + readiness probe is the system-level recovery mechanism — let it work. Pair with F10-13: `invariant()` should also throw in prod so the same restart path catches it.
- **Links:** `src/server/api.ts:22-30`; April 20 F10-13.

## Cross-links

- **F10-14** is the missing wiring for **April 20 F10-01** — the endpoint exists but the counters don't flow into it.
- **F10-17** is the unaddressed half of **April 20 F10-12** (audit coverage) plus the missing-`requestId` half of **April 20 F10-08**.
- **F10-23** is **April 20 F10-06** unchanged.
- **F10-24** is **April 20 F10-07** unchanged.
- **F10-15** / **F10-16** are **April 20 F10-10** plus a new sub-finding about Nomad coverage.
- **F10-18** is **April 20 F10-02** unchanged.
- **F10-25** is a new latency-capture finding cross-referenced by F10-14 (the metrics surface needs the data).
- **F10-19** sits in the gap between security (`06`) and observability — should fold into the audit work in F10-17.

## Closing

The April 20 architectural map of "structured logger + masking + correlation + health + metrics endpoint + sink" has crystallised in code. What remains is the wiring between those pieces and the rest of the system: agents must call the metrics service when they start and stop, schedulers must report heartbeats, audit must cover state changes (not just tool calls), the access log must produce structured latency, the frontend must report errors, the Hono `logger()` must be replaced, and the empty-catch tail must finally be swept. None of these are large; together they're 5–8 PRs of S/M effort. The outsized win is **F10-14** — wiring the metrics surface — because it unlocks every operational question the floor was supposed to answer.
