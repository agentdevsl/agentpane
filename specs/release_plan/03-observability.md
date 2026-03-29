# Observability & Monitoring Assessment

## Current State

### Structured Logger (`src/lib/logging/logger.ts`)
- ~140-line custom logger using `createLogger(context: string)` returning `{ debug, info, warn, error }` methods.
- Outputs JSON in production (`NODE_ENV=production`), human-readable strings in development.
- Level filtering via `LOG_LEVEL` env var (defaults to `info` in production, `debug` in development).
- Includes `requestId` correlation via `AsyncLocalStorage` (`src/lib/context/request-context.ts`).
- Error serialization extracts `message`, `stack`, and `code` from Error objects.
- **Widely adopted**: Used in 106 files across routes, services, bootstrap, sandbox providers, and state machines.

### Request Context (`src/server/router.ts`)
- `requestIdMiddleware` generates or propagates `X-Request-Id` header.
- Request ID propagated via `AsyncLocalStorage` -- available to all downstream logger calls without threading.
- Request counter uses simple incrementing integer (not collision-resistant).

### HTTP Request Logging
- Hono's built-in `logger()` middleware in `src/server/router.ts` logs method, path, and status for every request.

### Health Checks (`src/server/routes/health.ts`)
- **Comprehensive** -- 284 lines covering:
  - `GET /api/health` -- Full health with database, GitHub, sandbox (Docker), Kubernetes, durable streams, API key presence, and sandbox initialization status. Includes DB latency, version, and overall response time.
  - `GET /api/health/liveness` -- Simple alive check.
  - `GET /api/health/readiness` -- DB connectivity probe with latency.
- Health checks are **production-ready** for container orchestration (K8s liveness/readiness probes).

### Global Error Handling
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` in `src/server/api.ts` log via structured logger.
- `app.onError()` in `src/server/router.ts` logs unhandled route errors with request ID, returns sanitized error messages (full message only in dev mode).
- `GracefulShutdown` class (`src/server/bootstrap/shutdown.ts`) with LIFO-ordered cleanup and 30-second timeout safety net.

### State Machine Telemetry (`src/lib/state-machines/instrumented-machine.ts`)
- Wraps state machine `send()` to log all transitions with duration-in-state, guard failures, and transition results.
- Good foundation for operational visibility into agent/task/session state flows.

### Agent Execution Logging
- `agent-execution.service.ts` logs at key lifecycle points: start, planning complete, execution errors, auto-start, memory injection.
- Stream handler logs tool progress, turn events, and completion metrics.

---

## Critical Gaps

### 1. No Sensitive Data Masking in Logs
**Risk: HIGH**

The logger has **zero redaction/masking** of sensitive data. The `maskSensitiveData` function described in the monitoring spec (`specs/application/operations/monitoring.md`, line 332) is documented as "planned" and does not exist in code.

Specific exposure vectors found:

- **`src/server/routes/auth.ts:105`** -- Logs GitHub OAuth error data which may contain token fragments: `log.error('GitHub OAuth token exchange failed', { data: { error: tokenData.error } })`.
- **`src/services/container-agent/shared-helpers.ts:234-239`** -- Logs whether a token starts with `sk-ant-oat` (revealing token type/prefix): `data: { hasToken: !!oauthToken, isOAuth: oauthToken?.startsWith('sk-ant-oat') ?? false }`. While this does not log the full token, it reveals metadata that should be opaque.
- **Error stack traces** -- The `serializeError()` function in the logger captures full stack traces including function arguments. If an error occurs during token handling, the stack may include token values in closure variables.
- **`src/server/bootstrap/phases/api-key-resolution.ts`** -- Logs API key source but not the key itself (safe).
- **`src/services/container-agent/container-exec.service.ts:137`** -- Deliberately redacts `CLAUDE_OAUTH_TOKEN` to `'[REDACTED]'` in the env var data structure logged. This is good practice but is a one-off manual redaction, not systematic.

**Mitigation status**: One manual `[REDACTED]` pattern exists in container-exec. No automatic masking layer.

### 2. No Metrics Collection
- No Prometheus client (`prom-client`) or equivalent.
- No `/metrics` endpoint.
- No counters for: API requests, agent starts/completions/errors, task state transitions, tool executions, Claude API token usage.
- No histograms for: request latency, agent execution duration, DB query time.
- No gauges for: active agents, queued tasks, connected SSE clients, DB pool size.
- The monitoring spec defines extensive metric interfaces (lines 444-500+) but none are implemented.

### 3. No Distributed Tracing
- No OpenTelemetry SDK integration.
- No trace/span propagation across service boundaries.
- Request IDs provide basic correlation but do not support trace hierarchies (parent-child spans).
- Agent execution spans (planning -> approval -> execution) have no trace linkage.

### 4. No Alerting/Error Reporting Integration
- No Sentry, Datadog, PagerDuty, or equivalent.
- `uncaughtException` and `unhandledRejection` are logged to stdout but never forwarded to an alerting service.
- Invariant violations in production are logged but not alerted on (`src/lib/utils/invariant.ts` line 29 -- logs and continues).

### 5. No Log Rotation/Retention
- Logs go exclusively to `console.log/error/warn/debug`.
- No file-based logging, no rotation, no retention policies.
- Relies entirely on external log collection (Docker logs, journald, etc.) which may not be configured.
- The monitoring spec describes planned `LOG_CONFIG` with file rotation (line 412) but this does not exist.

### 6. Extensive Silent Error Swallowing
Found **50+ instances** of silently swallowed errors across services:

- **`terraform-compose.service.ts`** -- 6 instances of `.catch(() => {})` on stream deletion (lines 90, 101, 135, 156, 506, 527).
- **`template-sync-scheduler.ts`** -- 4 instances of empty catch blocks (lines 99, 101, 107, 128).
- **`cli-monitor.service.ts`** -- 4 instances: persist sessions, publish, upsert, delete (lines 146, 376, 383, 448).
- **`plan-mode.service.ts`** -- 7 instances of caught `_streamError` with no logging (lines 183, 194, 250, 388, 437, 515, 527).
- **`workflow.service.ts`** -- 6 instances of `catch (_error)` with empty bodies (lines 104, 120, 155, 202, 221, 264).
- **`durable-streams.service.ts`** -- 2 instances of empty catch on Caddy errors (lines 691, 963).
- **`api-key.service.ts`** -- 2 instances of silent catch (lines 134, 164).
- **`session-stream.service.ts`** -- 1 instance: `catch (_streamErr) {}` (line 167).

These represent significant blind spots in production debugging. Errors in stream publishing, state persistence, and API key operations are silently discarded.

### 7. Console.log Leakage
69 occurrences of `console.(log|error|warn|debug)` in 22 source files, mostly in frontend hooks and service files. These bypass the structured logger entirely, producing unstructured output that cannot be parsed, filtered, or correlated.

---

## Sensitive Data Risk

### Current Protections (Positive)
- **Container exec env vars**: `CLAUDE_OAUTH_TOKEN` is manually redacted to `'[REDACTED]'` before logging (`container-exec.service.ts:137`).
- **API key resolution**: Logs the source of the key (`env`, `database`) but not the key value itself.
- **GitHub token service**: Logs `tokenId` (database row ID) rather than the token value.
- **Token encryption**: API keys stored in DB are encrypted (`src/lib/crypto/server-encryption.ts`, `src/lib/crypto/token-encryption.ts`).
- **OAuth state**: Uses `HttpOnly; Secure; SameSite=Lax` cookies for CSRF state.

### Unprotected Areas (Risk)
1. **Error objects logged with full context**: The `serializeError()` function in the logger captures the full error `message` and `stack`. If an error occurs during token decryption or API key handling, the error message may contain token fragments or decrypted values.
2. **`data` field is logged without filtering**: Any `data: Record<string, unknown>` passed to logger methods is serialized to JSON as-is. There is no field-level redaction. A developer accidentally passing `{ token: 'sk-ant-...' }` in the data field would log the full token.
3. **No automated scanning**: No CI checks or runtime guards prevent sensitive data from entering log output.
4. **GitHub OAuth error responses**: The `tokenData.error` from GitHub's OAuth endpoint is logged directly. While unlikely to contain secrets, external API error responses should be treated with caution.
5. **Nomad token decryption failure**: `src/server/bootstrap/sandbox/nomad-init.ts:89` logs error context from decryption failures which could leak partial token data in error messages.

### Risk Level: **MEDIUM-HIGH**
No current evidence of actual token/key values being logged, but the absence of systematic masking means one careless `log.error('failed', { data: { key: apiKey } })` call would leak credentials in production logs. The risk grows linearly with codebase size and contributor count.

---

## Recommended Minimum for Production

### P0 -- Must Have Before Go-Live

#### 1. Implement Sensitive Data Masking in Logger
Add a `maskSensitiveData()` filter in the logger's `formatEntry()` path. Apply it to `data` and `error` fields before serialization. Use the pattern already designed in the monitoring spec (line 332-406). Field names to mask: `token`, `key`, `secret`, `password`, `credential`, `authorization`, `cookie`, `apiKey`, `api_key`, `privateKey`, `private_key`. Value patterns to mask: strings matching `sk-ant-*`, `ghp_*`, `ghs_*`, `gho_*`, `github_pat_*`.

**Effort**: 1 day. No external dependencies.

#### 2. Add Error Logging to Silent Catch Blocks
Replace the 50+ empty `catch` blocks and `.catch(() => {})` with `log.warn()` or `log.debug()` calls. Priority targets:
- `plan-mode.service.ts` (7 instances -- stream event publishing failures invisible)
- `workflow.service.ts` (6 instances -- workflow CRUD failures invisible)
- `cli-monitor.service.ts` (4 instances -- session persistence failures invisible)
- `terraform-compose.service.ts` (6 instances -- stream cleanup failures)

**Effort**: 1 day.

#### 3. Replace Direct `console.*` Calls with Structured Logger
Audit and replace the 69 `console.*` calls in 22 source files with `createLogger()`. Frontend code (hooks, components) can use `console.*` since they run in the browser, but all `src/server/` and `src/services/` and `src/lib/` code should use the structured logger.

**Effort**: 0.5 days.

#### 4. Add Basic Operational Metrics Endpoint
Implement a lightweight `/api/metrics` endpoint returning key counts as JSON (not necessarily Prometheus format yet):
- Active agents count, tasks by column, connected SSE clients
- Process uptime, memory usage (`process.memoryUsage()`), event loop utilization
- Agent execution counts (started, completed, errored) since boot

This can be implemented without external dependencies using in-memory counters.

**Effort**: 1-2 days.

### P1 -- Should Have Within First Sprint Post-Launch

#### 5. Structured Error Reporting Integration
Add Sentry (or equivalent) for error capture with source maps, breadcrumbs, and user context. Wire into:
- `process.on('uncaughtException')` and `process.on('unhandledRejection')`
- `app.onError()` global handler
- `invariant()` violations in production
- Agent execution failures

**Effort**: 1-2 days. Package: `@sentry/bun` or `@sentry/node`.

#### 6. Log Output to Structured Destination
Configure log output for the deployment environment:
- Docker: stdout JSON is already correct for Docker log drivers (Fluentd, Loki, CloudWatch).
- Add `service` and `environment` fields to every log entry for multi-service filtering.
- Consider `pino` for higher-throughput structured logging (10-30x faster than `console.log` for JSON serialization).

**Effort**: 1 day for field enrichment, 2 days if migrating to Pino.

---

## Nice-to-Have Improvements

### Post-Launch Enhancements

#### A. Prometheus Metrics with `prom-client`
Full Prometheus-compatible `/metrics` endpoint with:
- HTTP request duration histogram by route
- Agent execution duration histogram
- Claude API token usage counters
- Task state transition counters
- Database query latency histogram
- SSE connection gauge

**Effort**: 3-5 days. Package: `prom-client` (~8KB).

#### B. OpenTelemetry Distributed Tracing
Instrument request-to-agent execution flow with spans:
- HTTP request span -> service method span -> agent SDK span -> tool execution span
- Propagate trace context through durable streams for cross-process correlation
- Integrate with Jaeger or Grafana Tempo for visualization

**Effort**: 5-7 days. Packages: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`.

#### C. Grafana Dashboards
Pre-built dashboards for:
- System health (CPU, memory, DB latency, uptime)
- Agent activity (starts, completions, errors, avg duration, turn counts)
- Task flow (throughput by column, cycle time, approval wait time)
- API performance (p50/p95/p99 latency, error rate, throughput)

**Effort**: 2-3 days (assumes Prometheus + Grafana infrastructure exists).

#### D. Log Sampling for High-Volume Events
Add configurable sampling for debug/info-level logs to reduce volume in high-throughput scenarios. The monitoring spec describes planned sampling rates (10% debug, 100% info/warn/error).

**Effort**: 0.5 days.

#### E. Alerting Rules
Define alerting thresholds:
- Agent error rate > 10% over 5 minutes
- Health check failures for > 1 minute
- Unhandled exception rate > 0/5min (any is an alert)
- DB latency p99 > 500ms
- Agent stuck in `planning` or `running` for > 30 minutes

**Effort**: 1-2 days (rules definition), depends on monitoring backend.

---

## Implementation Recommendations

Ordered by priority and dependency:

| # | Item | Effort | Dependencies | Package | Status |
|---|------|--------|-------------|---------|--------|
| 1 | Sensitive data masking in logger | 1 day | None | None (pure TypeScript) | DONE |
| 2 | Fix silent catch blocks (50+ instances) | 1 day | None | None | DONE |
| 3 | Replace `console.*` with structured logger | 0.5 day | None | None | DONE |
| 4 | Add `service`/`environment` fields to log entries | 0.5 day | None | None | DONE |
| 5 | Basic `/api/metrics` endpoint (in-memory counters) | 1-2 days | None | None | TODO |
| 6 | Sentry error reporting integration | 1-2 days | Sentry account | `@sentry/bun` or `@sentry/node` | TODO |
| 7 | Migrate logger to Pino (optional, for perf) | 2 days | None | `pino` + `pino-pretty` | TODO |
| 8 | Prometheus metrics with `prom-client` | 3-5 days | Item 5 (refine counters) | `prom-client` | TODO |
| 9 | OpenTelemetry tracing | 5-7 days | Tracing backend (Jaeger/Tempo) | `@opentelemetry/sdk-node` | TODO |
| 10 | Grafana dashboards | 2-3 days | Items 8-9, Grafana instance | None | TODO |
| 11 | Alerting rules | 1-2 days | Item 8, alerting backend | None | TODO |

**Recommended approach**: Items 1-5 (3-5 days total) constitute the minimum viable observability for production. They require no external services or new dependencies. Items 6-7 should follow within the first sprint. Items 8-11 are infrastructure-dependent and can be planned alongside deployment architecture decisions.

### Key Architectural Notes

- The existing logger architecture (`createLogger` + `AsyncLocalStorage` for request IDs) is a solid foundation. The masking layer and field enrichment can be added as middleware in the existing `log()` function without changing any call sites.
- The 106 files already using `createLogger` mean the adoption problem is solved -- the issue is feature gaps in the logger itself, not adoption.
- The health check implementation is production-ready and well-designed for Kubernetes. No changes needed.
- The state machine instrumentation (`instrumented-machine.ts`) provides excellent transition telemetry. Wiring this to a metrics counter would give immediate visibility into agent/task lifecycle performance.
- The biggest operational risk is the 50+ silent catch blocks. These create invisible failure modes that will be extremely difficult to debug in production without the ability to reproduce the issue.

---

## Implementation Status

### Item 1: Sensitive Data Masking (COMPLETED)

- **File**: `src/lib/logging/logger.ts`
- **What**: Added `maskSensitiveData()` function that recursively walks objects/arrays and redacts:
  - Field names: `token`, `key`, `secret`, `password`, `credential`, `authorization`, `cookie`, `apiKey`, `api_key`, `privateKey`, `private_key` (case-insensitive)
  - Value patterns: `sk-ant-*`, `ghp_*`, `ghs_*`, `gho_*`, `github_pat_*`
- **Integration**: Applied automatically in `log()` function to both `data` and `error` fields before serialization
- **Tests**: 18 tests in `src/lib/logging/__tests__/mask-sensitive-data.test.ts`
- **Commits**: `c96933d`, `4b32cd1`

### Item 2: Silent Catch Blocks (COMPLETED)

- **Files modified**: 16 files across services and lib
- **Instances fixed**: 47+ empty catch blocks replaced with structured logging
- **Approach**: `log.debug()` for expected failures (stream cleanup, event publishing), `log.warn()` for unexpected failures (DB operations, CRUD, persistence)
- **Key files**: terraform-compose (6), plan-mode (8), workflow (6), cli-monitor (6), template-sync-scheduler (4), git.service (4), docker-provider (5), durable-streams (2), api-key (2), k8s-workspace-initializer (2), session-stream (1), sessions/router (1), registry-client (1), task-creation/sync (1), git-token-resolver (1), agents/hooks/audit (1)
- **Commit**: `3d7806f`

### Item 3: Console.* Replacement (COMPLETED)

- **Files modified**: 2 server-side files
  - `src/lib/bootstrap/phases/streams.ts`: `console.warn` -> `log.warn`
  - `src/lib/task-creation/hooks.ts`: `console.error` -> `log.error`
- **Note**: Only 2 real instances found in server code (the 69 mentioned in spec included frontend code and logger internals which are intentional)
- **Commit**: `bd6e2f7`

### Item 4: Service/Environment Fields (COMPLETED)

- **File**: `src/lib/logging/logger.ts`
- **What**: Added `service` and `environment` fields to `LogEntry` interface
- **Defaults**: `SERVICE_NAME` env var (fallback: `'agentpane'`), `NODE_ENV` (fallback: `'development'`)
- **Behavior**: Fields appear in every JSON log entry in production; omitted from dev human-readable output for cleanliness
- **Commit**: `c96933d`
