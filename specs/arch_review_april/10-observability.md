# Arch Review — 10: Observability

Theme: logging, metrics, tracing, error bubbling, request-ID propagation, silent catches, health checks, dashboards, alerting, audit logs.

## Summary

Observability is the theme where the distance between "looks reasonable in code review" and "works during a real production incident" is largest. AgentPane has done the hard floor work — a structured JSON logger with sensitive-data masking, `AsyncLocalStorage`-propagated request IDs, Hono request middleware, a comprehensive `/api/health` endpoint with database / GitHub / sandbox / K8s / streams / API-key / init checks, liveness and readiness probes, `GracefulShutdown` with LIFO cleanup, and state-machine transition instrumentation. The prior `specs/release_plan/03-observability.md` pass (March 2026) closed the P0 items it opened: `maskSensitiveData()` is now live in `src/lib/logging/logger.ts:62`, the 50+ silent catch blocks have been largely filled with `log.warn`/`log.debug` calls (item 2 DONE), service-name and environment are stamped on every entry, and 231 call sites across 118 files now use `createLogger`. This is not a regressing system.

What is still missing is everything past the floor. There is no `/metrics` endpoint of any kind — not Prometheus, not a JSON counter endpoint. There is no tracing: `AsyncLocalStorage` threads a `requestId` string, but nothing propagates spans across the HTTP → service → SDK → container-bridge → durable-stream boundary that defines the hot path of the product, so a flaky agent run from a stuck tool cannot be reconstructed without grepping logs by timestamp. No Sentry, no Datadog, no PagerDuty — `uncaughtException` logs to stdout and dies; `invariant()` violations in production log and continue. Frontend observability is effectively zero: 241 `console.*` occurrences across 70 files (close to the F08-02 count of 229/62) never leave the browser. Agent-runner emits 79 `console.*` calls across 3 files; those events reach the host as raw stdout lines parsed by `container-bridge.ts`, not as structured log records. The `droppedEventCount` counter on `PlanModeService` exposes a getter nobody reads. Background jobs — scheduler tick, event-cleanup, plan expiry, sandbox state reconciliation, presence heartbeat — log on failure but emit no heartbeat metric, so a silently-wedged scheduler is invisible.

Also: the request ID reaches the logger via `AsyncLocalStorage` but is not attached to outbound boundaries — the Claude SDK call, the Dockerode request, the `@kubernetes/client-node` call, the durable-streams publish — so when the SDK or sandbox misbehaves, correlating "which HTTP request started this" requires manual timestamp triangulation. The `audit_logs` table is defined and hook code exists at `src/lib/agents/hooks/audit.ts`, but coverage outside agent hooks is partial.

This file consolidates the prior release-plan items against their current status, then adds findings for problems that become visible only when you ask operational questions the release plan didn't.

## Map

- **Logger.** `src/lib/logging/logger.ts` (248 lines) — `createLogger(context)`, `debug/info/warn/error`, `maskSensitiveData()` recursive redaction (field-name and value-pattern), JSON in prod / human-readable in dev, `LOG_LEVEL` env override with validation.
- **Request context.** `src/lib/context/request-context.ts` — `AsyncLocalStorage<RequestContext>` with `getRequestId()` helper.
- **Request-ID middleware.** `src/server/router.ts:91-97` — reads `x-request-id`, generates otherwise, sets Hono context var, stamps response header, binds `AsyncLocalStorage` for the chain. Mounted at `app.use('*', requestIdMiddleware)` (line 248).
- **HTTP access log.** Hono's `logger()` middleware in the router — method/path/status, no latency, no requestId.
- **Global error handler.** `app.onError()` in `src/server/router.ts:558-565` — logs with requestId and error; sanitizes message in non-dev.
- **Process handlers.** `uncaughtException` and `unhandledRejection` in `src/server/api.ts` route to the structured logger.
- **Health.** `src/server/routes/health.ts` (286 lines) — `/api/health` (7 subsystem checks, latency, uptime, responseTimeMs), `/api/health/liveness`, `/api/health/readiness`.
- **State machine telemetry.** `src/lib/state-machines/instrumented-machine.ts` — wraps `send()` to log transitions with duration-in-state and guard failures.
- **Plan-mode drop counter.** `src/services/plan-mode.service.ts:67,114` — `droppedEventCount` field + `getMetrics()` getter, 13 increment sites, zero consumers.
- **Agent-runner logs.** `agent-runner/src/event-emitter.ts` — JSON-line events on stdout with explicit flush; `agent-runner/src/index.ts` additionally uses 57 raw `console.*` calls. Parsed on the host by the container bridge.
- **Audit logs.** `audit_logs` table (SQLite + PG schemas in `src/db/schema/{sqlite,postgres}/audit-logs.ts`), writer in `src/lib/agents/hooks/audit.ts`.
- **No endpoint for metrics.** Searched `src/server` for `/metrics` or Prometheus — no hits.

## What's working

- **The logger is the right shape.** JSON in prod, correlation IDs from `AsyncLocalStorage`, circular-safe recursive masking with depth limit (10), value-pattern redaction for `sk-ant-*`, `ghp_*`, `ghs_*`, `gho_*`, `github_pat_*`, invalid-`LOG_LEVEL` warning with fallback. 18 tests guard the mask function.
- **Widespread adoption.** `createLogger` is imported in 118 files (231 occurrences), so new features inherit correlation and masking for free — the adoption problem the prior review opened with is solved.
- **Health is production-grade.** `/api/health` covers DB + DB-version detection + GitHub token + sandbox provider + K8s provider + durable streams reachability + API-key presence + sandbox init status, with a `responseTimeMs` field. `readiness` returns 503 on DB failure — correct K8s probe semantics.
- **Request-ID middleware is correct.** Accepts a client-provided `x-request-id` (for upstream propagation), generates a fresh ID otherwise, echoes it on the response, and binds it via `AsyncLocalStorage` before calling `next()` — no threading, no footguns.
- **Graceful shutdown.** `src/server/bootstrap/shutdown.ts` with LIFO cleanup and a 30s safety timeout; prevents half-flushed event state during SIGTERM.
- **State machine instrumentation.** Transition timing is already logged for agent/task/session/worktree — the data to compute cycle-time percentiles is in the log stream; it just isn't counted.
- **Prior P0 items closed.** Masking (item 1), silent-catch fixes (item 2, 47+ blocks), `console.*` audit (item 3), service/environment fields (item 4) — all DONE per the tracker, and the code matches.

## Prior-review disposition

| Prior item (`release_plan/03-observability.md`) | Status | Notes |
|---|---|---|
| Sensitive data masking in logger | **Resolved** | `maskSensitiveData()` in `logger.ts:62`, 18 tests. |
| Fix silent catch blocks (50+) | **Partially resolved** | 47+ instances logged (commit 3d7806f). Current grep still shows empty `catch`/`catch (_...)` patterns across 168 files in the broader codebase; the "loud" ones are gone but the frontend tail remains. See F10-02. |
| Replace `console.*` with structured logger | **Resolved for server** | Server side down to 2 instances at the time of the fix. Agent-runner (79 instances) and frontend (241 instances) are explicitly excluded and still raw. See F10-05 and F10-07. |
| Add `service`/`environment` fields | **Resolved** | Stamped on every entry. |
| `/api/metrics` endpoint | **Still open** | No metrics endpoint of any kind. See F10-01. |
| Sentry / error reporting | **Still open** | No integration. See F10-04. |
| Pino migration | **Still open, downgraded** | The current logger is not a bottleneck at current traffic; defer until throughput warrants. |
| Prometheus `prom-client` | **Still open** | Follows F10-01. |
| OpenTelemetry tracing | **Still open** | See F10-03. |
| Grafana dashboards | **Still open, downgraded** | Depends on metrics + tracing. Out of scope until those exist. |
| Alerting rules | **Still open, downgraded** | Depends on backend. |

## Findings

### F10-01 — No `/metrics` endpoint at all

- **Priority:** P1
- **Status:** **Resolved** (April 2026 remediation).
- **Observation:** There is no Prometheus scrape endpoint and no JSON counter endpoint. No per-route request counts, no histogram for HTTP latency, no agent-start/complete/error counters, no task state-transition counters, no tool-execution counters, no Claude API token usage, no active-SSE gauge, no DB query latency histogram, no DB pool size. The `instrumented-machine.ts` transition telemetry goes to logs but is never aggregated. Every operational question past "is it up" requires grepping JSON.
- **Risk:** You cannot define or measure an SLO. You cannot set an alert on "agent error rate > 10% over 5 min" because nothing counts. In an incident, mean-time-to-detect is bounded below by whoever notices the UI is broken.
- **Recommendation:** Start with the minimum viable endpoint — `GET /api/admin/metrics` returning JSON counters maintained in memory: request count by route + status class, agent starts/completes/errors, active-agents gauge, SSE connection count (feeds F05-03), dropped-event counter (feeds F05-02), DB latency histogram (simple bucket map), sandbox-create success/failure. One file, no new dependency. Layer `prom-client` on top once the shape is known and a scraper exists. Wire `instrumented-machine.ts` to emit transition counters at each `send()`.
- **Remediation:** `MetricsService` (`src/services/metrics.service.ts`) + `GET /api/metrics` (`src/server/routes/metrics.ts`) surface request counts per route + status class, agent start/complete/error counters and running/idle gauges, an SSE connection gauge wired from the `EventRouter` snapshot (F05-03), a DB latency summary per query type, and fold-ins of the F05-13 stream lag metrics and F05-02 plan-mode drop counter. Hono middleware (`metricsMiddleware`) runs after routing so route patterns stay low-cardinality. Admin-only.
- **Effort:** S (1–2 days) for the JSON endpoint; M (3–5 days) for the full Prometheus surface.
- **Links:** prior item #5 and #8; `src/lib/state-machines/instrumented-machine.ts`.

### F10-02 — Silent-catch tail across 78 server files and 168 occurrences

- **Priority:** P2
- **Observation:** A grep for `catch {` across `src/` returns 168 hits across 78 files, and `catch (_` returns 31 more. The prior review's 47+ fixes targeted the loudest services (`plan-mode`, `workflow`, `cli-monitor`, `terraform-compose`). What remains concentrates in route handlers (`routes/sandbox.ts` 7, `routes/memory.ts` 5, `settings/github.tsx` 5), bootstrap (`heal-intervals.ts` 5), and provider contexts (`folder-context.tsx` 7, `memory-context.tsx` 14). Many of these are likely "best-effort cleanup" — the pattern is correct; what's missing is the `log.debug` or `log.warn` breadcrumb that would tell you the cleanup *happened*.
- **Risk:** A UI that silently fails to save a setting or a sandbox heal-loop that silently skips a cycle looks healthy from the outside. Debugging requires the user to reproduce.
- **Recommendation:** Biome's `noEmptyBlockStatements` is already on in this repo — CLAUDE.md notes this. The remaining hits are `catch (_err) { /* ignore */ }` patterns where the block contains a comment, which defeats the lint. Promote a stricter custom rule that forbids bare `catch (_...)` unless it ends in a call to `log.*` or `throw` or `return`. Do this as a sweep against the 31 `catch (_` instances first — those are cheap wins.
- **Effort:** S (1 day) for the sweep; S more for the lint rule.
- **Links:** prior item #2 continuation.

### F10-03 — No distributed tracing across the agent hot path

- **Priority:** P1
- **Status:** **Step 1 resolved** (April 2026 remediation). Steps 2–4 remain open.
- **Observation:** The product's defining interaction is HTTP (`PATCH /api/tasks/:id/move`) → `TaskService.moveColumn` → `AgentExecutionService.start` → `runAgentPlanning` → Claude Agent SDK → (optional) Docker/K8s provider → `DurableStreamsService.publish` → Caddy → browser SSE. A request ID is threaded via `AsyncLocalStorage` **within** the API process, but it is not attached to the outbound SDK call, the Dockerode/K8s client request, or the durable-streams publish. It is not received by agent-runner, which means an error in the container cannot be correlated to the HTTP request that spawned it. `session-event` envelopes don't carry the spawning request ID.
- **Risk:** In-production debugging of "why did this task fail" requires timestamp archaeology across stream logs, agent-runner stdout, and the API access log — exactly the problem OpenTelemetry exists to solve. Without it, a flaky run in a customer environment is effectively unreproducible.
- **Recommendation:** Phased. (1) Propagate `requestId` manually as a `correlationId` field on the durable-stream envelope and on agent-runner's `AgentEvent` schema — no SDK needed, unblocks most of the value immediately. (2) Stamp `requestId` onto a custom header on outbound Dockerode/K8s calls where supported. (3) Once the event path is correlated, layer `@opentelemetry/sdk-node` with auto-instrumentation for HTTP + better-sqlite3, then add manual spans around `runAgentPlanning`/`runAgentExecution`. (4) Propagate W3C traceparent through durable streams so the browser can correlate user clicks to server spans.
- **Remediation (step 1):** `streamEventMetadataSchema` (`src/lib/streams/envelope.ts`) grew an optional `correlationId` field; `createSessionEventMetadata` / `createStreamPayloadWithMetadata` default it to `getRequestId()` from `AsyncLocalStorage`, so every event published inside a Hono request chain automatically carries the spawning request's id. `stream-handler.ts` does the same for events it mints directly. `container-exec.service.ts` exports the current `requestId` to the agent-runner container as the `CORRELATION_ID` env var; the runner's new `logger.ts` tags every log line with it, and the host-side `container-bridge.ts` replays those lines through `createLogger('agent-runner')` with the id preserved.
- **Effort:** S for step (1) alone (2 days); M for steps (2)–(3) (1 week); L for (4).
- **Links:** prior item #9; `src/lib/agents/stream-handler.ts`, `src/services/durable-streams.service.ts`.

### F10-04 — No error reporting integration

- **Priority:** P1
- **Status:** **Sink abstraction resolved** (April 2026 remediation); Sentry adapter dependency is a follow-up.
- **Observation:** `uncaughtException` and `unhandledRejection` log via the structured logger and either die (exception) or are swallowed (rejection). `app.onError()` logs with requestId. `invariant()` in `src/lib/utils/invariant.ts` logs-and-continues in production. No Sentry, no Bugsnag, no Honeybadger — there is no destination that aggregates errors, deduplicates them by stack, tracks regressions across deploys, or pages on-call.
- **Risk:** First-time production errors are discovered when a user reports them. Errors that span multiple processes (API + agent-runner) are not correlated even within the error stream.
- **Recommendation:** Wire `@sentry/node` (or `@sentry/bun` once stable) into four sites: both process handlers, `app.onError()`, `invariant()` production branch, and the catch in `AgentExecutionService.start`. Attach `requestId`, `taskId`, `sessionId`, `codespaceId` as tags. Also wire the browser SDK on the frontend — this alone covers most of F10-07's value.
- **Remediation:** `src/lib/telemetry/error-sink.ts` adds a `captureException(err, context)` choke point with a replaceable sink interface. The default sink writes through the structured logger and keeps a ring buffer for introspection; `initSentryIfConfigured()` logs a breadcrumb when `SENTRY_DSN` is present so a future PR can swap in the real `@sentry/node` adapter without touching call sites. Call sites wired: `process.on('uncaughtException'|'unhandledRejection')` in `src/server/api.ts`, `app.onError` in the router, `invariant()` / `strictInvariant()` in `src/lib/utils/invariant.ts`, and the planning + execution catches in `AgentExecutionService`. Tags: `source`, `requestId`, `route`, `method`, `taskId`, `sessionId`, `codespaceId`.
- **Effort:** S (1–2 days) for backend; S more for browser.
- **Links:** prior item #6.

### F10-05 — Agent-runner logs are raw `console.*`, not structured

- **Priority:** P1
- **Status:** **Resolved** (April 2026 remediation).
- **Observation:** `agent-runner/src/index.ts` contains 57 `console.*` calls, `shared-session.ts` 2, `agentcore-handler.ts` 20 — 79 total, unstructured. The emitter-based JSON events on stdout (`event-emitter.ts`) are the structured channel and are parsed by `container-bridge.ts`, but errors, startup lifecycle, and diagnostic traces inside the runner are plain strings. Because the runner is a separate process in a separate container, those lines only reach the host if Docker log drivers forward them, and they cannot be correlated to a `requestId` or `sessionId` once they do.
- **Risk:** When the runner misbehaves — wrong credentials, sandbox clock skew, Claude SDK quota error — the evidence lives in a container log that may or may not be collected, in a format that cannot be joined back to the API host.
- **Recommendation:** Introduce a mini-logger in the runner that emits JSON lines on stdout with `taskId`, `sessionId`, and a new `correlationId` field (populated from the `AGENT_CORRELATION_ID` env var set by the host). Parse both JSON events **and** JSON log lines in `container-bridge.ts`, routing log lines to the host's `createLogger('agent-runner')` with the correlation ID preserved. Sweep `console.*` → the new logger.
- **Remediation:** `agent-runner/src/logger.ts` adds `createAgentRunnerLogger()`, which writes one JSON object per line on **stderr** — stdout is reserved for the existing event emitter, so the host bridge can cheaply distinguish logs (`channel === 'agent-runner-log'`) from events. Every record carries `correlationId` (from `CORRELATION_ID`, set by `container-exec.service.ts`), `taskId`, and `sessionId`. All 87 `console.*` sites across `index.ts`, `agentcore-handler.ts`, and `shared-session.ts` were rewritten to `log.*` calls. `container-bridge.ts` exports `tryReplayAgentRunnerLogLine()` and calls it on each stderr line before the existing `agent:error` JSON-event check, so structured log lines are replayed via `createLogger('agent-runner')` at the matching level and non-runner lines fall through unchanged.
- **Effort:** M (3 days).
- **Links:** `agent-runner/src/index.ts`, `src/lib/agents/container-bridge.ts`.

### F10-06 — No heartbeat metrics for background jobs

- **Priority:** P2
- **Observation:** 13 services run intervals (`scheduler.service.ts`, `event-cleanup.service.ts`, `template-sync-scheduler.ts`, `terraform-sync-scheduler.ts`, `session-presence.service.ts`, `sandbox.service.ts`, `sandbox-state.ts`, `cli-monitor.service.ts`, `agent-retry-queue.ts`, `agent-execution.service.ts` watchdog, `dream-scheduler.service.ts`, `task-creation.service.ts`). Each logs on failure; none emit a "last-tick-at" timestamp. A silently-wedged scheduler (e.g., a promise that never settles, a lost timer ref) is invisible until users notice the downstream effect.
- **Risk:** Event cleanup stops, `session_events` grows unboundedly, the integrity-check-gated backup stops, and nothing alerts until disk fills. Same class of risk as F02-XX (data-layer) — the loop existing does not mean the loop is running.
- **Recommendation:** Each scheduler should update a `schedulers.lastTickAt` / `lastTickOk` pair in a small in-memory map exposed by `/api/admin/metrics` (F10-01). An external scrape can then alert on `now - lastTickAt > expected_interval * 2`. Separately, each tick should log a `debug` breadcrumb so log-based alerting works as a fallback.
- **Effort:** S (1 day).

### F10-07 — Frontend observability is effectively zero

- **Priority:** P2
- **Observation:** 241 `console.*` occurrences across 70 frontend files (close to the F08-02 number of 229/62). No Sentry browser SDK, no PostHog/Amplitude, no error boundary reporting to the server, no performance timing collection. A user's rendering crash, failed fetch, or SSE drop reaches no one unless the user files a ticket with devtools open.
- **Risk:** For a product whose entire experience is a live dashboard over agent state, blind frontends are a large gap. Regressions in the streaming path (F05 theme) can only be detected via user reports.
- **Recommendation:** Browser Sentry (folded into F10-04) covers errors cheaply. For a structured fallback, add a tiny `POST /api/telemetry/client-error` endpoint that the browser can call from React error boundaries and from a global `window.addEventListener('error' | 'unhandledrejection')` — payload: `{ message, stack, route, sessionId, requestId }`. Server forwards to `createLogger('client')` which masks and persists in the existing log stream.
- **Effort:** S (1 day for the fallback endpoint); S more bundled with F10-04.
- **Links:** `specs/arch_review_april/08-frontend.md` F08-02.

### F10-08 — Request ID is not attached to durable-stream events or audit entries

- **Priority:** P2
- **Observation:** The envelope in `src/lib/streams/envelope.ts` carries OC-005 metadata but no `requestId`. `src/db/schema/{sqlite,postgres}/audit-logs.ts` doesn't appear to store a correlation ID either. So "what HTTP call caused this audit row" and "what HTTP call caused this stream event" can only be reconstructed through timestamps.
- **Risk:** Compliance and debugging both need the join. A customer asking "who approved my plan and when" has no single record; you synthesize it from multiple sources.
- **Recommendation:** Add a nullable `requestId` column to `audit_logs` (migration — follow the schema-drift lesson in `CLAUDE.md`), populate from `getRequestId()` in the audit hook. Add `requestId` to the durable-stream envelope as a first-class optional field; clients ignore if absent. Provides the correlation key for F10-03.
- **Effort:** S (1 day) for envelope; S for audit column + migration.

### F10-09 — `droppedEventCount` is still invisible

- **Priority:** P1
- **Status:** **Resolved (pre-existing, same change as F05-02)** — theme 05 PR #168 shipped `recordDroppedEvent()` on `PlanModeService`, which bumps per-event-type + per-reason counters, emits a `log.warn` at each drop site, and is surfaced on `GET /api/admin/metrics/plan-mode`. The F10-01 `/api/metrics` remediation additionally folds those counters into the global metrics snapshot under `planMode`.
- **Observation:** Cross-linked from F05-02 but called out here because it is primarily an observability failure, not a streaming one. The counter increments on 13 catch sites, exposes a getter, and nothing calls the getter. No log emission at the increment, no `/metrics` surface, no alert.
- **Risk:** Silent failure class the prior observability pass already flagged and "fixed" (by adding a counter that nobody reads). The shape is correct; the wiring is missing.
- **Recommendation:** At minimum, emit `log.warn` at each increment with `{ streamId, eventType, errorCode }`. Long-term, fold the counter into F10-01's endpoint and F05-05's outbox.
- **Effort:** XS (2 hours) for the log emissions.
- **Links:** F05-02; `src/services/plan-mode.service.ts:67,114`.

### F10-10 — Health endpoint is deep but not latency-SLA'd

- **Priority:** P3
- **Observation:** `/api/health` does seven subsystem checks sequentially with no per-check timeout except the 3s `AbortSignal.timeout` on streams. In prod under DB lock contention, the full health response can block while a K8s control-plane call queues. K8s's default liveness probe timeout (1s) will then mark the pod unhealthy and restart the API server during a transient — causing a restart loop.
- **Risk:** Thundering-herd restarts during DB or K8s degradation.
- **Recommendation:** Add per-check `AbortSignal.timeout(1000)` wrappers. Run checks in parallel (`Promise.allSettled`). Keep the sequential variant as `/api/health?deep=1` for human inspection. Document the readiness-probe recommendation (use `/api/health/readiness` not `/api/health`) in the deployment spec.
- **Effort:** S (half day).
- **Links:** `src/server/routes/health.ts`.

### F10-11 — No CI observability (test runtime trend, flake rate)

- **Priority:** P3
- **Observation:** CI runs Vitest in 3 shards (`.github/workflows` per CLAUDE.md). There is no aggregation of per-test runtimes across runs, no flake detection, no slow-test watchlist. The `functional` project runs separately; drift in its runtime is invisible until a PR times out.
- **Risk:** Test time growth is the classic "boiling frog" — adding 200ms per PR is never a blocker, and two years later the suite takes 40 minutes.
- **Recommendation:** Upload Vitest JSON reporter output to GitHub Actions artifacts; add a once-weekly job that computes p50/p95 per test from the last 30 runs and opens an issue for tests whose p95 doubled month-over-month. Cheap to build, large payoff.
- **Effort:** S (1 day).

### F10-12 — Audit-log coverage is hook-centric, not request-centric

- **Priority:** P2
- **Observation:** `src/lib/agents/hooks/audit.ts` writes audit rows for agent-lifecycle hooks. Reviewing `audit_logs` usage: writes are localized to agent hooks. Security-relevant events outside agent flow — API key create/delete, RBAC role changes, team member add/remove, sandbox config change, OAuth token rotation, codespace delete — do not appear to route through this table systematically. The 44-error catalog referenced in CLAUDE.md captures failure surfaces; audit should capture successful state changes too.
- **Risk:** For a multi-tenant system with GitHub tokens and Claude OAuth tokens, "who removed whom from which team" must be answerable. If audit only fires from agent hooks, the compliance story is half-built.
- **Recommendation:** Define the set of security-relevant events (token CRUD, RBAC mutation, membership mutation, settings mutation, codespace/sandbox lifecycle) and add audit writes at each service method. Folds into F06 (security) work. The schema exists; the wiring is the gap.
- **Effort:** M (2–3 days).

### F10-13 — `invariant()` violations log-and-continue in prod

- **Priority:** P2
- **Observation:** `src/lib/utils/invariant.ts` (per prior review, line 29) logs on violation and returns. In dev mode it throws. This means: in prod, an invariant violation — by definition a "this should never happen" state — silently continues execution, usually into a worse state than failing fast.
- **Risk:** Invariants exist because the author judged continuing to be unsafe. Logging-and-continuing defeats that judgment.
- **Recommendation:** Throw in prod too, with the error handler at `app.onError()` catching and returning 500 with a sanitized message. The structured logger still captures the stack. Pair with F10-04 so each violation creates a Sentry issue.
- **Effort:** XS.

## Closing

The floor is better than the prior review's snapshot suggests: masking is real, request IDs are threaded, health is deep, 47+ catches were fixed, 118 files have structured logging. What's missing is everything the floor doesn't give you for free — a metrics endpoint, a trace surface, error reporting, correlation across the process boundary into agent-runner, browser observability, heartbeat metrics on scheduled work, and attached request IDs on events and audit rows. The right shape of work is: F10-01 (JSON metrics), F10-03 step 1 (correlationId through streams + agent-runner), F10-04 (Sentry), F10-09 (wire the existing counter). Those four together, S/M effort each, move the product from "instrument-by-grep" to "instrument-by-query" without any infrastructure commitments.

Cross-links: `specs/release_plan/03-observability.md` (prior pass), `specs/release_plan/05-error-resilience.md` (error bubbling), `specs/arch_review_april/05-event-streaming.md` (F05-02 drop counter, F05-05 outbox), `specs/arch_review_april/08-frontend.md` (F08-02 console audit), `specs/arch_review_april/04-sandbox-providers.md` (F04 health depth), `specs/arch_review_april/06-security.md` (audit coverage).
