# AgentPane Architecture Review — April 29 2026

## Scope & method

- **Date**: 2026-04-29
- **Branch**: `main` at commit `25c1c4f0` (post-PR #176, #178, #179, plus the Dependabot batch #180–#189 merged on review day).
- **Reviewer**: 12 max-effort Opus subagents in parallel, each pinned to a single theme. Each agent read the corresponding April 20 file as a baseline, verified every prior finding against current code, and produced its own `path:line`-anchored findings. No agent invented issues; every claim is traceable to a file at HEAD.
- **Hard constraint applied to every agent**: **no new infrastructure**. Recommendations may not introduce Redis, Kafka, RabbitMQ, NATS, Temporal, Vault, ArgoCD, OpenTelemetry collectors, Datadog, or any new service. Every fix lives within the existing stack: SQLite/Postgres + Drizzle, Hono, Durable Streams + Caddy, Docker/K8s/Nomad, TanStack, Vitest/Playwright/Stryker, the in-process structured logger, and the existing CI on GitHub Actions.
- **What was reviewed** (12 themes — same structure as April 20 for comparability):
  1. [Service architecture](01-service-architecture.md)
  2. [Data layer](02-data-layer.md)
  3. [Agent execution](03-agent-execution.md)
  4. [Sandbox providers](04-sandbox-providers.md)
  5. [Event streaming](05-event-streaming.md)
  6. [Security](06-security.md)
  7. [API surface](07-api-surface.md)
  8. [Frontend](08-frontend.md)
  9. [Testing](09-testing.md)
  10. [Observability](10-observability.md)
  11. [Operations & deployment](11-operations-deployment.md)
  12. [Cross-cutting](12-cross-cutting.md)

## Priority key

- **P0** — release blocker: data loss, RCE, auth bypass, supply-chain hole, dual-dialect runtime break.
- **P1** — must-fix before next major release: silent-failure surface, dead infrastructure that *looks* wired, scaling wall, material security or compliance gap.
- **P2** — should-fix in next 2–3 sprints: type-safety, consistency drift, test gaps, debuggability.
- **P3** — opportunistic cleanup, docs, minor polish.

## Effort key

XS (<2h) · S (<1d) · M (1–3d) · L (1–2wk) · XL (>2wk)

## Executive summary

PRs #176 / #178 / #179 substantively closed many April 20 findings — most of the **mechanism** for outbox dual-write, plan-approval host-mode resume, tool-use hooks, schema-drift coverage, request-ID propagation, error-sink correlation, OAuth credentials-file injection, default image hardening, agent-shutdown phase, durable-streams sidecar Helm parity, CD pipeline, Postgres migration parity, and many smaller items now exists in the tree. The dominant pattern of remaining risk is **mechanism-shipped-but-not-wired**: code that looks like a fix but has no caller, no boot-time registration, or only one of the three providers patched. The reviewer-level summary is "the second 80% of every refactor is missing", and that pattern produces six of the seven P0s and a majority of the P1s in this pass.

The seven P0s cluster in three buckets:
1. **Supply chain & sandbox boundary** still leak through the K8s template manifest, the agent-sandbox Dockerfile `BASE_IMAGE`, the integration-test fixtures, and the Settings `PUT /api/settings` endpoint that admin-overrides the default image without re-validating it (F04-01, F04-02). Agentic shell-injection has been substantially mitigated but the `CommandRunner.exec` `sh -c` path is still the default and several callers still compose strings (F06-NEW-01); `escapeShellString` does not actually escape `;`, `|`, `&`, `\r`, `(`, `)`, or `\\n` (F06-NEW-03). Shared sandbox mode is still single-credential and single-FS-namespace (F06-NEW-02).
2. **Dead-but-believed-live infrastructure**. The `EventOutboxRelayService` and `event_outbox` table exist with full migration and tests but the relay is never instantiated (F01-03, F05-19). `DurableStreamsService.publish()` still uses the prior best-effort dual-write. `PlanModeService` is in the router but never constructed in bootstrap (F01-04). `MetricsService` is mostly a hollow shell with zero call sites (F10-14). `containerAgentService.reconcile()` is never called from boot (F03-12). Tool-use hooks are wired into the SDK loop but no caller registers them (F03-01).
3. **Postgres-mode runtime break**. 12+ services issue SQLite-specific SQL (`json_extract`, `json_set`, `datetime('now')`, `PRAGMA wal_checkpoint`) on the dual-dialect `Database` type (F02-15). This is a P0: enabling `DB_MODE=postgres` today fails at runtime in the scheduler.

Net read: AgentPane is closer to production-ready than it was on April 20 — the floor is materially higher, the test surface and the structured-log/correlation surface are in much better shape, and the supply-chain hardening exists conceptually. But the gap between "fix exists in code" and "fix runs in production" is wider than it looks; the priority of this cycle is *finishing the second 80%* — registering, calling, and testing what was already built — rather than green-fielding new layers.

## Priority snapshot

| Priority | Total | Themes contributing most |
| --- | --- | --- |
| **P0** | **7** | 06-security (3), 04-sandbox (2), 02-data (1), 05-streaming (1) |
| **P1** | **60** | 04-sandbox (10), 06-security (9), 11-operations (7), 02-data (6), 05-streaming (6), 03-agent-execution (5), 07-api (5) |
| **P2** | ~80 | broadly distributed: 08-frontend (8), 09-testing (8), 07-api (8), 01-service (8), 02-data (6), 10-observability (7) |
| **P3** | ~44 | 10-observability (7), 03-agent-execution (6), 12-cross-cutting (5), 07-api (5), 08-frontend (5) |
| **Total findings** | **~191** | across 12 themes |

(The April 20 review reported 175 findings: 4 P0, 59 P1, 81 P2, 31 P3. The April 29 finding count is *higher* because the prior review's resolved items are documented in each theme's "verified resolved" section and not double-counted as findings, while a number of new issues — most from the "mechanism shipped, never wired" pattern — were uncovered.)

## What was fixed since April 20

These are verified at HEAD `25c1c4f0` and called out as resolved in each themed file. Cite the proof-line if you reopen any of them.

| Area | Resolved item | Where it landed |
| --- | --- | --- |
| Service | Sandbox reconciliation phase | `phases/sandbox-reconciliation.ts`, wired in `sandbox-init.ts:183-198,242,291` |
| Service | Bootstrap readiness gate | `server-bootstrap.ts:141`, `routes/health.ts:67-81` |
| Service | Bootstrap phase result type + 3 phases migrated | `BootstrapPhaseResult`, `applyPhaseResult` |
| Service | Agent shutdown phase with 10s budget | `phases/agent-shutdown.ts` |
| Data | SQLite ↔ Postgres parity catch-up | `migrations-pg/0004_schema_catchup.sql` consolidated |
| Data | Schema-drift suite expanded | `tests/integration/*-schema-drift.test.ts` covers 49 tables (was 2/42) |
| Data | Postgres migration safety test added | `tests/integration/pg-migration-safety.test.ts` |
| Agent | Tool-use hooks installed at SDK loop | `stream-handler.ts:1150-1190,1509-1528` (but unregistered — F03-01) |
| Agent | `launchSwarm`/`teammateCount` removed | (cleaned out of plan options) |
| Agent | Host-mode SDK session resume across approval | `agent-execution.service.ts:932`, `stream-handler.ts:947` |
| Agent | Host-mode `rejectPlan` fallback | `task.service.ts:242-250` |
| Agent | OAuth `expiresAt` flows host→runner | (host side; refresh token still null — F03-09) |
| Sandbox | `srlynch1/agent-sandbox:latest` defaults patched | `SANDBOX_DEFAULTS.image` (but K8s manifest + Dockerfile BASE_IMAGE not — F04-01) |
| Sandbox | Provider `recover()` orphan cleanup added | (Docker only fully — F04-15) |
| Sandbox | YAML injection on SKILL.md frontmatter | `skill-injector.ts` now uses `yaml.stringify` (host side; agent-runner inside container still hand-rolls — F06-NEW-04) |
| Sandbox | Tool whitelist default deny (`[]` denies, `['*']` opens) | `tool-whitelist.ts:8` |
| Sandbox | API key & GitHub token rotation columns | (rotation columns in `api_keys` schema) |
| Streaming | SSE connection cap unified across subsystems | `durable-streams.service.ts` |
| Streaming | Container-agent token batching with ordering preserved | `ChunkBatcher` + token batching service |
| Security | YAML injection in skill metadata | (host-side `yaml.stringify`) |
| Security | Plan content → GitHub issue body sanitization | `issue-creator.ts` |
| Security | Dev-auth helper hardened | `rbac-middleware.ts` |
| Security | DOMPurify wrapper around Shiki HTML | `markdown-content.tsx`, `terraform-right-panel.tsx` |
| Security | Dependabot advisory count: 42 → 12 | (`gh api` verified at review time) |
| API | Cursor pagination shipped on 3 endpoints | `pagination.ts` helper |
| API | Request-ID propagation regression test | (added in PR #176) |
| Frontend | `ConnectionStatusBanner` mounted | `__root.tsx:79`, `useGlobalConnectionStatus` |
| Frontend | DialogLoadingFallback / PanelLoadingFallback at 6 sites | (replaced `fallback={null}`) |
| Frontend | ErrorBoundary on three top-level features | `KanbanBoard`, `WorkflowDesigner`, `SessionHistory` |
| Testing | Mutation testing matrix wired | (`stryker.config.json` — but with caveats — F09-22) |
| Testing | Schema-drift test coverage expanded | (49 tables — F09-21 partial) |
| Observability | `correlationId` plumbed through envelope + agent-runner | (PR #176 step 1) |
| Observability | `captureException()` sink at five canonical sites | (April 20 F10-04) |
| Observability | Structured logger in agent-runner | (1 fallback `console.error` survives) |
| Observability | Plan-mode drop counter exposed via `/api/admin/metrics/plan-mode` | (replaces invisible getter) |
| Operations | CD pipeline (`release.yml`) | (April 20 F11-01) |
| Operations | Helm durable-streams sidecar parity | (April 20 F11-02) |
| Operations | `agent-shutdown.ts` flushes runs | (April 20 F11-03) |
| Operations | Postgres migration parity check | `check-migration-parity.ts` |
| Operations | Pre-upgrade migration Job, PVC, PDB, RollingUpdate | (Helm chart) |
| Operations | `publish-cli-monitor.yml` with `--provenance` | (April 20 F11-08) |
| Cross-cutting | `BackgroundJobRegistry` adopted by 3 services | (partial — F12-07) |
| Cross-cutting | `src/lib/streams/stream-id.ts` typed factory | (36 sites bypass it — F12-05) |

## Top recommendations (master priority table)

Sorted by priority DESC, then theme number ASC. Includes every P0 (7) and every P1 (60).

| # | Priority | Theme | Finding | Primary file refs | Effort | Link |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P0 | 02 Data | Services issue SQLite-specific SQL on dual-dialect `Database` — `DB_MODE=postgres` is broken at runtime | `scheduler.service.ts` (12+ sites), `event-cleanup.service.ts:236` | M | [F02-15](02-data-layer.md#f02-15) |
| 2 | P0 | 04 Sandbox | "P0-01 supply-chain fix" only patched the TS constant; K8s manifest + Dockerfile + integration fixtures still pin `srlynch1/...:latest` | `k8s/manifests/agentpane-sandbox-template.yaml:29`, `docker/Dockerfile.agent-sandbox:23` | M | [F04-01](04-sandbox-providers.md#f04-01) |
| 3 | P0 | 04 Sandbox | Settings `PUT /api/settings` accepts `sandbox.defaults.image` as `z.unknown()` — admins bypass `validateImage` and re-introduce tag-only refs | `src/server/routes/settings.ts`, `loadSandboxDefaultsFromDb()` | S | [F04-02](04-sandbox-providers.md#f04-02) |
| 4 | P0 | 05 Stream | `event_outbox` table + `EventOutboxRelayService` + tests exist; relay is **never instantiated** in `service-container.ts`. `publish()` still uses old best-effort dual-write | `durable-streams.service.ts:789-808`, no caller of relay | S | [F05-19](05-event-streaming.md#f05-19) |
| 5 | P0 | 06 Security | `CommandRunner.exec` `sh -c` path is the default and several callers still compose strings; `execArgs` is optional | `worktree.service.ts:368, 447, 525, 572-575, 651-655` | M | [F06-NEW-01](06-security.md#f06-new-01) |
| 6 | P0 | 06 Security | Shared sandbox = single Anthropic OAuth file, single FS namespace; no `MULTI_TENANT` gate | `container-exec.service.ts:242`, `credentials-injector.ts:14-16` | L | [F06-NEW-02](06-security.md#f06-new-02) |
| 7 | P0 | 06 Security | `escapeShellString` does NOT escape `;`, `|`, `&`, `\r`, `(`, `)`; the `\\n→\\\\n` replacement is a literal-ization | `worktree.service.ts:73-81` | XS | [F06-NEW-03](06-security.md#f06-new-03) |
| 8 | P1 | 01 Service | `EventOutboxRelayService` exists, migrated, tested — never registered in `service-container.ts` | (paired with F05-19) | S | [F01-03](01-service-architecture.md#f01-03) |
| 9 | P1 | 01 Service | `PlanModeService` is declared in the router but never constructed in server bootstrap; metric endpoint reports zeros | `service-container.ts`, `routes/admin.ts` | XS | [F01-04](01-service-architecture.md#f01-04) |
| 10 | P1 | 01 Service | `TaskCreationService` constructed without `settingsService` — admin defaults silently ignored | `service-container.ts` | XS | [F01-05](01-service-architecture.md#f01-05) |
| 11 | P1 | 02 Data | `check-schema-drift.ts` only compares names, missing real type drifts (text vs jsonb, text vs timestamptz) | `scripts/check-schema-drift.ts` | S | [F02-16](02-data-layer.md#f02-16) |
| 12 | P1 | 02 Data | F02-05 PG pool fix landed at 1 of 3 PG client constructors | `db/client.ts:94`, `lib/bootstrap/phases/postgres.ts:21` | XS | [F02-17](02-data-layer.md#f02-17) |
| 13 | P1 | 02 Data | `event_outbox` JSON/timestamp drift between SQLite and PG | `db/schema/event-outbox.ts` | S | [F02-18](02-data-layer.md#f02-18) |
| 14 | P1 | 02 Data | `codespace_tags.assigned_at notNull()` declared but never created in SQLite | `migrations/0019_*.sql` | S | [F02-19](02-data-layer.md#f02-19) |
| 15 | P1 | 02 Data | SQLite `api_tokens.scope_codespace_id` is `ON DELETE CASCADE`, Drizzle + PG say `SET NULL`; codespace delete revokes tokens silently on SQLite | (Drizzle schema vs SQLite migration) | S | [F02-20](02-data-layer.md#f02-20) |
| 16 | P1 | 03 Agent | Tool-use hooks wired into SDK loop but **no caller registers them**; whitelist hook, audit hook, streaming hooks all dead infrastructure | `stream-handler.ts:1150-1190,1509-1528`, no register caller | M | [F03-01](03-agent-execution.md#f03-01) |
| 17 | P1 | 03 Agent | Host-mode `runAgentPlanning` runs no pre-tool-use hooks even if registered | `stream-handler.ts:575-638` | S | [F03-02](03-agent-execution.md#f03-02) |
| 18 | P1 | 03 Agent | Host-mode execution catch leaves task `in_progress` on error (F14 unaddressed) | `agent-execution.service.ts` (catch path) | S | [F03-06](03-agent-execution.md#f03-06) |
| 19 | P1 | 03 Agent | OAuth `refreshToken` plumbing dead-end on host side; `apiKeys` schema has no `refreshToken` column | `container-exec.service.ts:722` | S | [F03-09](03-agent-execution.md#f03-09) |
| 20 | P1 | 03 Agent | `containerAgentService.reconcile()` is dead code — bootstrap never calls it | (paired with April 20 F9 unfix) | XS | [F03-12](03-agent-execution.md#f03-12) |
| 21 | P1 | 04 Sandbox | K8s `indexOf('exec ')` env-injection bug from F04-P2-02 still ships; Nomad uses `lastIndexOf` | (K8s sandbox provider) | XS | [F04-03](04-sandbox-providers.md#f04-03) |
| 22 | P1 | 04 Sandbox | AgentCore is "feature-flagged" but `AgentCoreBridgeService` (561 LOC) is statically imported & instantiated regardless | (`AgentCoreBridgeService`) | M | [F04-04](04-sandbox-providers.md#f04-04) |
| 23 | P1 | 04 Sandbox | Hand-rolled SigV4 signer (~110 LOC of crypto) ships even when `AGENTCORE_ENABLED=false` | `agentcore-sandbox-instance.ts` | S | [F04-05](04-sandbox-providers.md#f04-05) |
| 24 | P1 | 04 Sandbox | Credentials-injection `writeFile` only landed on Docker; K8s + Nomad still use `sh -c 'echo "<base64>" \| base64 -d > path'` | (K8s, Nomad providers) | S | [F04-06](04-sandbox-providers.md#f04-06) |
| 25 | P1 | 04 Sandbox | `CLAUDE_OAUTH_TOKEN` still passed via container env, visible in `/proc/<pid>/environ` | `container-exec.service.ts:798` | S | [F04-07](04-sandbox-providers.md#f04-07) |
| 26 | P1 | 04 Sandbox | `sandbox_instances.codespace_id UNIQUE` blocks the natural stop→create lifecycle | (Drizzle schema constraint) | S | [F04-08](04-sandbox-providers.md#f04-08) |
| 27 | P1 | 04 Sandbox | Default Docker network is `bridge`; `SANDBOX_DEFAULT_NETWORK_MODE=none` silently ineffective on K8s/Nomad | (provider configs) | M | [F04-09](04-sandbox-providers.md#f04-09) |
| 28 | P1 | 04 Sandbox | `SandboxConfigService.assertQuota()` exists with zero callers | `SandboxService.create()` | XS | [F04-10](04-sandbox-providers.md#f04-10) |
| 29 | P1 | 04 Sandbox | K8s bootstrap `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/...` — supply chain via `latest` | `k8s-init.ts:354-358` | S | [F04-11](04-sandbox-providers.md#f04-11) |
| 30 | P1 | 04 Sandbox | GitHub token still embedded in `https://x-access-token:${token}@...` argv | `k8s-workspace-initializer.ts:89-128` | S | [F04-12](04-sandbox-providers.md#f04-12) |
| 31 | P1 | 05 Stream | `validateStreamIdKind` is `log.warn`-only and skipped on `publishSessionEvent`; branded types unused | `durable-streams.service.ts:738-743` | XS | [F05-20](05-event-streaming.md#f05-20) |
| 32 | P1 | 05 Stream | `useSessionSubscription` does not proxy `onGapDetected`/`onTerminalDisconnect`; `TruncationBanner` + `StreamReconnectBanner` never imported | `useSessionSubscription:64-86` | S | [F05-21](05-event-streaming.md#f05-21) |
| 33 | P1 | 05 Stream | Caddy `forward_auth` only checks "logged in", not "logged in to this stream" | `auth.ts:319-322`, Caddyfile | M | [F05-23](05-event-streaming.md#f05-23) |
| 34 | P1 | 05 Stream | `session_events.sessionId` mixes stream kinds with no FK or `streamKind` discriminator | (April 20 F05-09 unchanged) | S | [F05-25](05-event-streaming.md#f05-25) |
| 35 | P1 | 05 Stream | `@durable-streams/*` pinned with carets across 0.x major boundary | `package.json` | XS | [F05-27](05-event-streaming.md#f05-27) |
| 36 | P1 | 05 Stream | Reconnect attempt counter never resets on success — sleeping laptops re-enter dead state | `client.ts` | XS | [F05-28](05-event-streaming.md#f05-28) |
| 37 | P1 | 06 Security | Agent-runner inside container parses skill/agent YAML frontmatter via hand-rolled regex, bypassing host-side `yaml.stringify` fix | `agent-runner/src/index.ts:80-115` | S | [F06-NEW-04](06-security.md#f06-new-04) |
| 38 | P1 | 06 Security | OAuth token still passed as container env var — credentials-file fix is duplicated, not replacing | `container-exec.service.ts:798` | S | [F06-NEW-05](06-security.md#f06-new-05) |
| 39 | P1 | 06 Security | `validateShellCommand` bypassable via `\\t` and Unicode line separators | (validator) | S | [F06-NEW-06](06-security.md#f06-new-06) |
| 40 | P1 | 06 Security | RBAC tag-access skipped on collection endpoints — tag-restricted tokens see all tags via list APIs | (RBAC middleware) | S | [F06-NEW-07](06-security.md#f06-new-07) |
| 41 | P1 | 06 Security | In-process rate limiter has no graceful-shutdown checkpoint; recommend SQLite-backed persistence (no Redis) | `rate-limit.ts` | M | [F06-NEW-08](06-security.md#f06-new-08) |
| 42 | P1 | 06 Security | `/api/*` and `/hooks/*` accept unbounded request bodies; only cli-monitor caps at 5MB | (router middleware) | XS | [F06-NEW-09](06-security.md#f06-new-09) |
| 43 | P1 | 06 Security | CSP missing `wasm-unsafe-eval` (Shiki) and missing avatar / GitHub allow-list | `router.ts:110` | XS | [F06-NEW-10](06-security.md#f06-new-10) |
| 44 | P1 | 06 Security | `/v1/stream/sessions/:id` direct subscribe bypasses Hono auth + tenant isolation | (Caddy stream route) | M | [F06-NEW-11](06-security.md#f06-new-11) |
| 45 | P1 | 06 Security | 12 open Dependabot advisories — 3 critical (protobufjs RCE, Trivy supply-chain, golang.org/x/crypto auth bypass) | GitHub security alerts | S | [F06-NEW-12](06-security.md#f06-new-12) |
| 46 | P1 | 07 API | Pagination consistency: 3 of ~25 list endpoints adopt the canonical envelope; placeholder `{nextCursor:null,hasMore:false}` is misleading | `codespaces.ts:61-77`, `templates.ts:28-37` | L | [F07-01](07-api-surface.md#f07-01) |
| 47 | P1 | 07 API | 4 distinct list envelopes still in production; contract test only covers `/api/sessions` | (across routes) | M | [F07-02](07-api-surface.md#f07-02) |
| 48 | P1 | 07 API | 31 raw `c.req.json()` calls bypass Zod entirely on writes | `agents.ts:74,120,196`, `templates.ts:41,133`, `tasks.ts:248,278,318` | M | [F07-03](07-api-surface.md#f07-03) |
| 49 | P1 | 07 API | `endpoints.md` is two renames behind code — 17 references to `/api/projects` (renamed to `/api/codespaces`) | `specs/application/api/endpoints.md` | S | [F07-04](07-api-surface.md#f07-04) |
| 50 | P1 | 07 API | `tasks/:id/move` returns `{ok:true, data:{task, agentError}}` when agent auto-start failed — same anti-pattern F07-03 closed | `tasks.ts:201-227` | XS | [F07-06](07-api-surface.md#f07-06) |
| 51 | P1 | 08 Frontend | Tailwind `warning` tokens are silent no-ops — 24+ sites across 15 files | (use `attention` per CLAUDE.md) | S | [F08-01](08-frontend.md#f08-01) |
| 52 | P1 | 08 Frontend | Hardcoded SVG hex colors violate the theme contract — 30+ violations | `agentpane-logo.tsx`, `ai-action-button.tsx`, `settings-sidebar.tsx`, `sidebar.tsx` | S | [F08-02](08-frontend.md#f08-02) |
| 53 | P1 | 09 Testing | Schema-drift generator skips 19 of ~50 tables in test DB | `tests/helpers/database.ts` | S | [F09-21](09-testing.md#f09-21) |
| 54 | P1 | 09 Testing | Stryker `orchestration` matrix entry is `schedule_only: true` + `continue-on-error: true` — PRs touching `task.service.ts` get zero mutation signal | `.github/workflows/mutation-testing.yml` | S | [F09-22](09-testing.md#f09-22) |
| 55 | P1 | 09 Testing | 3 raw `db.update(tasks)` writes in functional tests bypass real services without `// TEST-SETUP:` justification | `task-lifecycle-e2e.test.ts:537,322`, `prove-plan-approval-bugs.test.ts:332` | S | [F09-23](09-testing.md#f09-23) |
| 56 | P1 | 10 Observability | `MetricsService` is a hollow shell — zero call sites for `incAgentStarted`, `setAgentGauge`, `incSse`/`decSse`, `recordDbLatency` | `MetricsService` + `/api/metrics` | M | [F10-14](10-observability.md#f10-14) |
| 57 | P1 | 11 Operations | agent-runner ships TWO lockfiles in git — `bun.lock` and `package-lock.json` (drifted 67 days); CI uses bun, Dockerfile uses `npm install` against stale npm lockfile | `agent-runner/bun.lock`, `agent-runner/package-lock.json` | S | [F11-15](11-operations-deployment.md#f11-15) |
| 58 | P1 | 11 Operations | `release.yml` only builds main app image; `Dockerfile.agent-sandbox` + `Dockerfile.agentcore` not built/pushed — runtime digest pinning enforces stale images | `.github/workflows/release.yml` | S | [F11-16](11-operations-deployment.md#f11-16) |
| 59 | P1 | 11 Operations | `migrate-check-only.ts` exists but not wired into `start.sh`/`database.ts`/initContainer — "refuse to start on stale schema" non-functional | `docker/start.sh` | XS | [F11-17](11-operations-deployment.md#f11-17) |
| 60 | P1 | 11 Operations | Dockerfiles use `npm install` not `npm ci` — transitive deps drift on every rebuild | (3 Dockerfiles) | XS | [F11-18](11-operations-deployment.md#f11-18) |
| 61 | P1 | 11 Operations | `npm install -g @anthropic-ai/claude-code` no version pin in agent-sandbox or agentcore | `docker/Dockerfile.agent-sandbox:41` | XS | [F11-19](11-operations-deployment.md#f11-19) |
| 62 | P1 | 11 Operations | Helm `sandbox.image` value is decorative — runtime reads from DB, not chart | `helm/values.yaml` | XS | [F11-20](11-operations-deployment.md#f11-20) |
| 63 | P1 | 11 Operations | Backup scripts well-written but never invoked; no Helm CronJob; restore drill undocumented | `scripts/backup.sh`, `helm/templates/` | M | [F11-21](11-operations-deployment.md#f11-21) |
| 64 | P1 | 12 Cross-cutting | `src/lib/api/schemas.ts` has 41 Zod schemas — only 4 used; 5 names *conflict* with canonical `src/server/validation.ts` (e.g. `updateTaskSchema.title.max(200)` vs `max(500)`) | `src/lib/api/schemas.ts` | M | [F12-01](12-cross-cutting.md#f12-01) |
| 65 | P1 | 12 Cross-cutting | `ALLOW_ALL_TOOLS` exported twice with incompatible types — `'*'` (string) at `tool-whitelist.ts:8`, `['*']` (array) at `constants/tools.ts:32` | (both files) | XS | [F12-02](12-cross-cutting.md#f12-02) |
| 66 | P1 | 12 Cross-cutting | Project→codespace rename incomplete at API surface — `/api/project-folders`, `addProjectMemberSchema`, `project-members.ts`, `'scope must be "org" or "project"'` error string | `validation.ts:161,167`, `routes/project-members.ts`, `templates.ts:71` | M | [F12-06](12-cross-cutting.md#f12-06) |

## Suggested first cycle (next 2 sprints)

This list is opinionated — these are the P0/P1 items with the best ratio of "operational risk reduction × cost":

1. **Wire the dead infrastructure** (one PR per item, all XS–S):
   - F01-03 / F05-19 register `EventOutboxRelayService` in `service-container.ts` and switch `DurableStreamsService.publish()` to `enqueueOutboxEvent`. Tests already exist.
   - F01-04 construct `PlanModeService` in bootstrap so the admin metric stops reporting zeros.
   - F01-05 inject `settingsService` into `TaskCreationService`.
   - F03-12 call `containerAgentService.reconcile()` from the recovery phase.
   - F04-10 invoke `SandboxConfigService.assertQuota()` from `SandboxService.create()`.
   - F05-21 add `onGapDetected` + `onTerminalDisconnect` to the `useSessionSubscription` callback proxy keys list and import the banners.
   - F03-01 either register tool-use hooks during `start()` or delete the dead `createAgentHooks` scaffolding (CLAUDE.md says don't keep half-finished implementations).

2. **Close the supply-chain trio** (F04-01 + F04-02 + F04-11): pin the K8s `SandboxTemplate` manifest to a digest, lock down `BASE_IMAGE`, validate `sandbox.defaults.image` in the Settings PUT path, and replace the `kubectl apply -f https://.../latest/...` bootstrap with a vendored manifest at a known SHA. Add a CI grep gate that fails on `:latest` in any image ref.

3. **Finish the credentials-injection migration** (F04-06 + F04-07 + F06-NEW-05 + F04-12): drop the env-var path everywhere, port `writeFile` to K8s and Nomad, stop embedding GitHub tokens in clone-URL argv. The Docker fix is the template.

4. **Postgres-mode block** (F02-15 + F02-17): replace SQLite-specific SQL in the scheduler / event-cleanup / session-stream / memory routes with dialect-neutral Drizzle ops (`json` accessors at the Drizzle layer, not raw `json_extract`). Apply the PG pool config to the two remaining client constructors. Adds a `DB_MODE=postgres` smoke test to CI to keep this from regressing.

5. **Agent-runner lockfile + image build** (F11-15 + F11-16 + F11-18 + F11-19): pin claude-code version, switch to `bun install --frozen-lockfile` + drop `package-lock.json`, build agent-sandbox & agentcore in `release.yml` so the digest pinning isn't enforcing stale images.

6. **API write-validation pass** (F07-03): replace 31 bare `c.req.json()` calls with Zod-parsed bodies. This is mechanical and high-value; pair it with a CI grep guard.

7. **Schema duplication purge** (F12-01 + F12-02): delete `src/lib/api/schemas.ts` entirely (4 of 41 schemas used, names conflict with active validation), reconcile `ALLOW_ALL_TOOLS` to a single shape.

8. **Dependabot critical advisories** (F06-NEW-12): triage the 3 critical advisories (protobufjs RCE, Trivy supply-chain, golang.org/x/crypto auth bypass).

## Out of scope

- Memory / Honcho deep review (CLAUDE.md notes Honcho is not installed; in-app memory was reviewed only at the API boundary in theme 07).
- Terraform Compose UX / topology-designer UX.
- Roadmap items in `specs/roadmap/` (explicitly future work).
- `@agentpane/cli-monitor` package internals beyond the packaging layer in theme 11.
- Multi-tenant billing/usage metering (no implementation to review).
- Performance benchmarking (no observability data set captured).

## How to read each themed file

Each themed file is self-contained: every finding has `Where`/`What`/`Why it matters`/`Fix`/`Status vs April 20`. The "Status vs April 20" line is the most useful filter — it tells you whether something is **New**, **Unchanged**, **Partially fixed**, or **Regressed**. When triaging which items to take into the next cycle, sort by Priority then by Effort and start with the XS/S band; many of the "wire the dead infrastructure" items are XS one-liners that close P1s.
