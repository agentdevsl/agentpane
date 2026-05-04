# AgentPane Architecture Review - May 2026

## Scope and method

- Date: 2026-05-04
- Branch: `main`
- Commit reviewed: `1cfa897f80e24faad3b8f7f56f8a649d46fd79db`
- Baselines: `specs/arch_review_april/` and `specs/arch_review_april29/`
- Method: one local verification pass plus five concurrent read-only review agents:
  - service architecture, bootstrap, DI, background jobs
  - data layer, migrations, dual-database behavior
  - agent execution, plan approval, sandbox providers
  - event streaming, outbox, metrics, observability
  - API surface, security, frontend, testing, operations
- Worktree note: unrelated pre-existing deletions under `.agents/skills/terraform-mcp-as-code/*` were present before this review and were not touched.

This directory started as the review output. Production code has since been remediated for the
top findings below; see [remediation-status.md](remediation-status.md) for implementation evidence
and verification commands.

## Executive verdict

AgentPane has improved materially since the April reviews. Several old release blockers are no longer current: the default sandbox image is digest-pinned, `allowedTools: []` is now failure-closed, body-size limits are mounted on public API surfaces, the outbox relay is constructed and registered, plan-mode metrics exist, stream-ID kind mismatches are rejected, and raw route `c.req.json()` usage has mostly been replaced by schema parsing.

The current architecture risk is different from April's: less "missing mechanism", more "split mechanism". There are now multiple ways to do the same critical things:

- two stream publish paths, only one of which uses the outbox
- two database schema realities, with runtime code still typed as SQLite while Postgres boot exists
- two execution readiness stories, with HTTP accepting task moves before sandbox init/reconciliation completes
- multiple RBAC layers, with some powerful GitHub routes mounted at viewer level
- several sandbox creation paths, with container auto-create bypassing sandbox profiles and quotas

Net read: suitable for trusted single-tenant/self-hosted operation with careful operators; not production-ready for hosted multi-tenant, K8s-isolated, or horizontally scaled deployments until the P0/P1 items below are closed.

## Priority snapshot

This review is intentionally focused on decision-grade architecture findings rather than restating every April item.

| Priority | Count | Main themes |
| --- | ---: | --- |
| P0 | 3 | GitHub App RBAC, K8s fail-open network isolation, conditional multi-tenant credential isolation |
| P1 | 18 | execution readiness, stream delivery, DB dialect seams, sandbox lifecycle, GitHub mutation routes, command execution, rate limiting |
| P2 | 22 | background jobs, migrations, recovery UX, API contracts, frontend data paths, testing/coverage, observability depth |
| P3 | 4 | SQLite pragma tuning, ops ergonomics, hook setup, documentation drift |

## Top findings

| ID | Pri | Theme | Finding | Primary refs | Status |
| --- | --- | --- | --- | --- | --- |
| MAY-01 | P0 | API/Security | GitHub App administration is mounted under viewer-level GitHub RBAC but can create manifests, save/delete global app credentials, and register/delete installations. | `src/server/router.ts:504`, `src/server/router.ts:614`, `src/server/routes/github-app.ts:51`, `src/server/routes/github-app.ts:159`, `src/server/routes/github-app.ts:258` | Addressed |
| MAY-02 | P0 | Sandbox | K8s network isolation can fail open: Sandbox CRD is created before the NetworkPolicy, and the catch path throws without deleting the CRD. | `src/lib/sandbox/providers/agent-sandbox-provider.ts:286`, `src/lib/sandbox/providers/agent-sandbox-provider.ts:294`, `src/lib/sandbox/providers/agent-sandbox-provider.ts:330` | Addressed |
| MAY-03 | P0 conditional | Sandbox/Security | Shared sandbox credential safety depends on explicit `MULTI_TENANT=true`; default false allows shared-mode global OAuth injection in any accidentally multi-tenant deployment. | `src/lib/sandbox/credentials-injector.ts:63`, `src/services/container-agent/container-exec.service.ts:316`, `src/server/bootstrap/server-config.ts:127` | Addressed |
| MAY-04 | P1 | Service | Task moves can succeed before container execution is ready, leaving an `in_progress` task with no agent/session start. | `src/server/bootstrap/server-bootstrap.ts:153`, `src/server/bootstrap/server-bootstrap.ts:275`, `src/services/task.service.ts:593`, `src/services/task.service.ts:655` | Addressed |
| MAY-05 | P1 | Streaming | Core `SessionService` events bypass the outbox and still do DB-first plus best-effort Caddy publish. | `src/server/bootstrap/service-container.ts:175`, `src/services/session/session-stream.service.ts:149`, `src/services/session/session-stream.service.ts:165` | Addressed |
| MAY-06 | P1 | Streaming/Data | Even the outbox-backed path inserts `session_events` and `event_outbox` in separate writes, so a crash between them loses live delivery. | `src/services/durable-streams.service.ts:790`, `src/services/durable-streams.service.ts:826`, `src/services/event-outbox-relay.service.ts:217` | Addressed |
| MAY-07 | P1 | Data | Runtime Postgres still depends on SQLite schema objects and a SQLite-typed `Database`, hiding dialect differences. | `src/types/database.ts:13`, `src/db/schema/index.ts:1`, `src/services/event-outbox-relay.service.ts:23`, `src/server/router.ts:13` | Addressed |
| MAY-08 | P1 | API/Security | `/api/github/clone` and `/api/github/create-from-template` are viewer-level but perform filesystem writes and GitHub mutations. | `src/server/router.ts:504`, `src/server/routes/github.ts:105`, `src/server/routes/github.ts:220`, `src/server/routes/github.ts:332` | Addressed |
| MAY-09 | P1 | Sandbox | Container auto-create bypasses sandbox profiles, quotas, and configured image/resources. | `src/services/container-agent/container-exec.service.ts:354`, `src/services/sandbox.service.ts:156`, `src/services/codespace.service.ts:160` | Addressed |
| MAY-10 | P1 | Execution | Container agent errors can leave tasks stuck `in_progress` with `agentId` cleared until a later startup reconciliation. | `src/services/container-agent/shared-helpers.ts:223`, `src/services/container-agent/container-exec.service.ts:1398`, `src/services/container-agent/container-agent.service.ts:280` | Addressed |
| MAY-11 | P1 | Security | Deprecated `sh -c` command runner remains live and `GitService` still uses it for many operations. | `src/server/bootstrap/service-container.ts:68`, `src/server/bootstrap/service-container.ts:92`, `src/services/git.service.ts:128`, `src/services/git.service.ts:315` | Addressed |
| MAY-12 | P1 | Streaming | Gap detection exists but recovery is disabled; `fetchGapEvents()` is unused. | `src/app/hooks/use-session.ts:466`, `src/app/hooks/use-session.ts:472`, `src/lib/streams/client.ts:1504` | Addressed |
| MAY-13 | P1 | Sandbox | K8s/Nomad duplicate prevention is still in-memory before provider provisioning; DB uniqueness happens too late for multi-process races. | `src/lib/sandbox/providers/agent-sandbox-provider.ts:232`, `src/lib/sandbox/providers/nomad-sandbox-provider.ts:187`, `src/services/sandbox.service.ts:203` | Addressed |
| MAY-14 | P1 | Data | Legacy SQLite `plan_sessions` drift is acknowledged but explicitly skipped by drift tests. | `src/db/schema/sqlite/plan-sessions.ts:52`, `src/lib/bootstrap/migrations/v19-project-folders.ts:135`, `tests/integration/schema-drift-all-tables.test.ts:70` | Addressed |
| MAY-15 | P1 | Ops/Security | Rate limiting now survives restarts, but remains single-instance; multi-pod deployments multiply quotas. | `src/lib/api/rate-limiter.ts:17`, `src/lib/api/rate-limiter.ts:208`, `src/lib/api/rate-limiter.ts:219` | Addressed |

## Detailed files

- [01-service-data.md](01-service-data.md) - bootstrap, readiness, background jobs, dual database, migrations
- [02-execution-sandbox.md](02-execution-sandbox.md) - agents, plan approval, credentials, K8s/Nomad/Docker sandbox behavior
- [03-streaming-observability.md](03-streaming-observability.md) - Durable Streams, session events, outbox, metrics, telemetry
- [04-api-security-frontend-testing.md](04-api-security-frontend-testing.md) - route RBAC, API contracts, frontend data paths, tests, ops
- [05-remediation-plan.md](05-remediation-plan.md) - suggested order of work

## Verified improvements since April

- `SANDBOX_DEFAULTS.image` is digest-pinned and image validation rejects tag-only overrides in settings.
- Tool whitelist behavior is failure-closed: `[]` denies all, `['*']` explicitly allows all.
- `EventOutboxRelayService` is constructed and registered in the scheduler background job registry.
- `PlanModeService` is constructed in the service container and exposed to metrics routes.
- `/api/*` and `/hooks/*` body limits are mounted.
- Raw route JSON parsing is largely replaced by `parseJsonBody`/Zod; only a special optional-body memory route still calls `c.req.json()`.
- Scheduler JSON updates now use dialect helpers rather than raw SQLite-only `json_set`/`json_extract`.
- Stream-ID kind mismatch is rejected at publish time.
- Caddy stream auth is stronger for session/plan/sandbox streams.
- Frontend truncation state is visible, though not yet recoverable.

## Verification performed

- Local source reads with `rg`, `sed`, `nl`, and `find`
- Concurrent explorer reviews for five architecture slices
- Current branch/commit captured with `git rev-parse`
- Current dirty worktree checked with `git status --short`
- Data review agent reported:
  - `bun run scripts/check-migration-parity.ts` passed
  - `bun run scripts/check-schema-drift.ts` passed

Full `bun test`, Agent Browser E2E, Postgres integration, and K8s/Nomad live tests were not run as part of this review.
