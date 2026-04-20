# AgentPane Architecture Review — April 2026

## Scope & method

- **Date**: 2026-04-20
- **Branch**: `arch-review-april` (forked from `main` at commit `f9605383`)
- **Reviewer**: generated via multi-agent pass. Each themed file was authored by a focused agent reading current code on the branch head; findings are anchored to real file paths and line numbers at that commit.
- **What was reviewed** (12 themes):
  1. [Service architecture](01-service-architecture.md) — bootstrap, DI container, facade services, state holders
  2. [Data layer](02-data-layer.md) — Drizzle schemas (SQLite + Postgres), migrations, JSON columns, transactions
  3. [Agent execution](03-agent-execution.md) — host-mode vs container-mode, plan/approval/execute, AgentCore remnant
  4. [Sandbox providers](04-sandbox-providers.md) — Docker / K8s (`Sandbox` CRD) / Nomad parity, image supply chain
  5. [Event streaming](05-event-streaming.md) — Durable Streams, SSE, SQLite event table, Caddy fan-out
  6. [Security](06-security.md) — injection surfaces, RBAC parity, OAuth/tokens, CSP, supply chain, sandbox escape
  7. [API surface](07-api-surface.md) — envelopes, pagination, rate limits, request-ID, OpenAPI gap
  8. [Frontend](08-frontend.md) — TanStack Start routing, shell providers, tests, theming
  9. [Testing](09-testing.md) — Vitest projects, Stryker, fast-check, E2E, schema-drift coverage
  10. [Observability](10-observability.md) — logging, metrics, tracing, silent catches, audit logs
  11. [Operations & deployment](11-operations-deployment.md) — CI/CD, Docker, Helm, backups, release process
  12. [Cross-cutting](12-cross-cutting.md) — type escapes, `Result<T,E>` discipline, timers, config, magic numbers
- **What was NOT reviewed**: roadmap items in `specs/roadmap/` (explicitly future work); scope consciously skipped includes memory/Honcho deep review, Terraform Compose UX, topology-designer UX, and `@agentpane/cli-monitor` package internals (it was reviewed only at the packaging layer in theme 11).

## How to read this review

- **Priority key**
  - **P0** — release blocker: data-loss, silent data corruption, RCE, auth bypass, or an operational dead-end we cannot ship past.
  - **P1** — must-fix before the next major release: silent failure modes, scaling walls, material security gaps, compliance risk, or foundational debt that multiplies the cost of every future feature.
  - **P2** — should-fix in the next 2–3 sprints: maintainability, type-safety, test-coverage gaps, consistency drift, polish that materially affects debuggability.
  - **P3** — opportunistic: docs, minor cleanup, feature-flagged improvements, candidates for "cleanup Friday".
- **Effort key**
  - **XS** — < 2 hours
  - **S** — < 1 day
  - **M** — 1–3 days
  - **L** — 1–2 weeks
  - **XL** — > 2 weeks
- **File refs** use `path:line` format; line numbers were verified against the branch head (`f9605383`). Where a finding cites multiple files, the master table lists the primary reference.
- **Cross-links** to prior reviews — consolidated against `specs/events_review/` (streaming) and `specs/release_plan/` (01 test-suite, 02 security, 03 observability, 04 release, 05 error-resilience, 06 database-integrity, 08 frontend). See the "What this supersedes" table below.
- **Anchor format** — GitHub renders `### F06-02: Title` as a full slug anchor like `#f06-02--title-words`. The master table uses full title slugs for consistency with how GitHub actually renders headings. Themes 03 and 04 use non-standard anchor conventions internally (03 uses `#f1`..`#f17`, 04 uses `#p0-01`/`#p1-03` etc.); links into those files respect each file's actual heading format.

## Executive summary

AgentPane is a **pre-production, late-beta** system: the service skeleton is sound (30+ services with a properly ordered DI container, a 7/8-subsystem `/api/health` probe, a structured JSON logger with redaction, a comprehensive Vitest + integration + functional test split, Drizzle with dual SQLite/Postgres schemas, and a real facade refactor on Agent/ContainerAgent/Session), and the core Kanban→plan→execute loop works end-to-end. The three biggest risks to a production launch are (1) **supply-chain / sandbox boundary** — the default agent-sandbox image is an unpinned personal Docker Hub tag (`srlynch1/agent-sandbox:latest`) pulled by every tenant, with no signing, scanning, or reproducible build, while Dependabot carries 2 critical and 17 high advisories against the main branch; (2) **no CD, no release artefact, Postgres migrations 19 versions behind SQLite, Helm stores state in `emptyDir`, backups exist but never run** — so a Helm-based production deployment today would fail on first rollout and have no rollback path; and (3) **silent-failure surface** — plan-mode drops events into a getter nobody reads, three sandbox providers disagree on `list()`/`execAsRoot()` semantics, schema-drift tests cover 2 of 42 tables, the in-memory rate limiter can be bypassed by restart, and two execution paths (host-mode vs container-mode) have drifted on plan→execute resume. Net read: **production-ready with caveats** for a trusted-tenant self-hosted install on SQLite + single-host Docker; **pre-production** for multi-tenant, K8s, or Postgres deployments.

## Priority snapshot

| Priority | Count | Themes contributing most |
| --- | --- | --- |
| **P0** | 4 | 06-security (3), 04-sandbox-providers (1) |
| **P1** | 59 | 11-operations (8), 06-security (8), 05-event-streaming (7), 04-sandbox-providers (7), 03-agent-execution (6), 10-observability (5) |
| **P2** | 81 | 02-data-layer (10), 01-service-architecture (7), 03-agent-execution (8), 04-sandbox-providers (8), 05-event-streaming (8), 08-frontend (7), 09-testing (7), 12-cross-cutting (8), 10-observability (6) |
| **P3** | 31 | 04-sandbox-providers (5), 07-api-surface (4), 08-frontend (4), 11-operations (2), others |
| **Total** | **175** | across 12 themes |

## Top recommendations (prioritized)

Master table sorted by priority DESC, then theme number ASC. Includes every P0 (4) and every P1 (59), plus top P2 and P3 by operational blast radius.

| # | Priority | Theme | Finding | File refs | Effort | Link |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P0 | 04 Sandbox | Container-escape blast radius hinges on unpinned `srlynch1/agent-sandbox:latest` | `src/lib/sandbox/types.ts:91`, `docker/Dockerfile.agent-sandbox` | L | [P0-01](04-sandbox-providers.md#p0-01-container-escape-blast-radius-hinges-on-one-undocumented-docker-image-tag-srlynch1agent-sandboxlatest-with-no-signature-pinning-no-scanning-and-no-reproducible-build) |
| 2 | P0 | 06 Security | Dependabot: 42 open advisories (2 critical, 17 high) | GitHub security alerts | M | [F06-01](06-security.md#f06-01--p0--dependabot-42-open-advisories-2-critical-17-high) |
| 3 | P0 | 06 Security | Shell interpolation in `createBunCommandRunner` | `src/server/bootstrap/service-container.ts:62`, `src/services/codespace.service.ts:528` | M | [F06-02](06-security.md#f06-02--p0--shell-interpolation-in-createbuncommandrunner) |
| 4 | P0 | 06 Security | YAML injection via skill/agent metadata → SKILL.md frontmatter | `src/lib/sandbox/skill-injector.ts:42-132` | S | [F06-03](06-security.md#f06-03--p0--yaml-injection-via-skillagent-metadata--skillmd-frontmatter) |
| 5 | P1 | 01 Service | In-memory running-agent state has no DB reconciliation on restart | `src/services/container-agent/sandbox-state.ts:19-28`, `phases/recovery.ts:36-85` | M | [F01-01](01-service-architecture.md#f01-01-in-memory-running-agent-state-has-no-db-reconciliation-on-restart) |
| 6 | P1 | 01 Service | Sandbox provider initialization is fire-and-forget with no readiness gate | `src/server/bootstrap/server-bootstrap.ts:211-217`, `sandbox-init.ts:185` | S | [F01-03](01-service-architecture.md#f01-03-sandbox-provider-initialization-is-fire-and-forget-with-no-readiness-gate-for-dependents) |
| 7 | P1 | 01 Service | Bootstrap phase failures have inconsistent exit behaviour | `phases/database.ts:43`, `phases/api-key-resolution.ts:36-42`, `phases/schedulers.ts:51-57` | S | [F01-05](01-service-architecture.md#f01-05-bootstrap-phase-failures-have-inconsistent-exit-behaviour) |
| 8 | P1 | 02 Data | PostgreSQL migration chain lives in one 590-line mega-migration | `src/db/migrations-pg/0004_schema_catchup.sql` | M | [F02-01](02-data-layer.md#f02-01-postgresql-migration-chain-lives-in-one-590-line-mega-migration) |
| 9 | P1 | 02 Data | Schema-drift tests cover 2 of 42 tables | `tests/integration/*-schema-drift.test.ts`, `scripts/check-schema-drift.ts` | M | [F02-02](02-data-layer.md#f02-02-schema-drift-tests-cover-2-of-42-tables) |
| 10 | P1 | 02 Data | PostgreSQL client has no pool/timeout tuning | `src/server/bootstrap/phases/database.ts:46` | S | [F02-05](02-data-layer.md#f02-05-postgresql-client-has-no-pooltimeout-tuning) |
| 11 | P1 | 02 Data | PostgreSQL path has no runtime migration-safety tests | `src/db/migrations-pg/`, `tests/integration/` | M | [F02-13](02-data-layer.md#f02-13-postgresql-path-has-no-runtime-migration-safety-tests) |
| 12 | P1 | 03 Agent | AgentCore path is dead code but still present in two packages | `src/services/container-agent/agentcore-*`, `packages/agentcore-*` | M | [F1](03-agent-execution.md#f1--agentcore-path-is-dead-code-but-still-present-in-two-packages) |
| 13 | P1 | 03 Agent | Tool-use hooks are registered but never installed in the SDK session | `src/lib/agents/stream-handler.ts`, `agent-execution.service.ts:80-85` | M | [F2](03-agent-execution.md#f2--tool-use-hooks-are-registered-but-never-installed-in-the-sdk-session) |
| 14 | P1 | 03 Agent | `launchSwarm`/`teammateCount` carried end-to-end but never acted on | `src/lib/agents/stream-handler.ts`, `agent-runner/src/index.ts` | S/XL | [F3](03-agent-execution.md#f3--plan-option-fields-launchswarm-teammatecount-are-carried-end-to-end-but-never-acted-on) |
| 15 | P1 | 03 Agent | Host-mode cannot resume an SDK session across plan approval | `src/services/agent/agent-execution.service.ts:932`, `stream-handler.ts:947` | M | [F5](03-agent-execution.md#f5--host-mode-cannot-resume-an-sdk-session-across-plan-approval) |
| 16 | P1 | 03 Agent | `rejectPlan` has no host-mode fallback | `src/services/task.service.ts:242-250` | S | [F6](03-agent-execution.md#f6--rejectplan-has-no-host-mode-fallback) |
| 17 | P1 | 03 Agent | `agent-runner` mints fake OAuth `expiresAt` and null `refreshToken` | `agent-runner/src/index.ts:303` | M | [F11](03-agent-execution.md#f11--agent-runner-mints-fake-oauth-expiresat-and-a-null-refreshtoken) |
| 18 | P1 | 04 Sandbox | `SandboxProvider` interface is not uniform; three providers diverge on `list`/`execAsRoot`/errors | `src/lib/sandbox/sandbox-provider.ts:124-167`, `agent-sandbox-provider.ts`, `nomad-sandbox-provider.ts` | L | [P1-01](04-sandbox-providers.md#p1-01-the-sandboxprovider-interface-is-not-actually-uniform--agentcore-is-a-fourth-execution-path-that-doesnt-implement-it-and-the-three-crd-style-providers-diverge-on-key-contracts) |
| 19 | P1 | 04 Sandbox | AgentCore half-deleted; dynamic-import AWS SDK not declared as dependency | `agentcore-sandbox-provider.ts:247-337`, `package.json` | M | [P1-02](04-sandbox-providers.md#p1-02-agentcore-is-half-deleted--migration-0011-dropped-the-db-columns-but-1200-loc-of-providerinstancebridgeerrors-code-remains-reachable-and-the-health-path-uses-a-dynamic-import-aws-sdk-that-is-never-declared-as-a-dependency) |
| 20 | P1 | 04 Sandbox | K8s/Nomad have no orphan cleanup on startup | `agent-sandbox-provider.ts`, `nomad-sandbox-provider.ts`, `src/server/bootstrap/sandbox/` | M | [P1-03](04-sandbox-providers.md#p1-03-provider-cleanup-of-orphans-only-exists-for-docker--kubernetes-podspvcs-and-nomad-jobs-have-no-startup-sweep-so-a-crash-leaves-cluster-side-resources-running-forever) |
| 21 | P1 | 04 Sandbox | `POD_ALREADY_EXISTS`/`JOB_ALREADY_EXISTS` guards check only in-memory state | `agent-sandbox-provider.ts:125-137`, `nomad-sandbox-provider.ts:130-143` | M | [P1-04](04-sandbox-providers.md#p1-04-pod_already_exists--job_already_exists-guards-check-only-in-memory-state-so-a-server-restart-with-a-still-running-k8snomad-sandbox-creates-a-duplicate) |
| 22 | P1 | 04 Sandbox | Credentials injected via shell exec — token visible in argv | `src/lib/sandbox/credentials-injector.ts:71-87`, `container-exec.service.ts:767` | S | [P1-05](04-sandbox-providers.md#p1-05-credentials-injection-writes-the-oauth-token-via-a-shell-exec-that-embeds-it-in-the-command-string--base64-helps-but-a-compromisedhostile-image-can-still-capture-it-from-argv) |
| 23 | P1 | 04 Sandbox | No network policy, egress filtering, or east-west isolation on any provider | `docker-provider.ts:568`, `SandboxBuilder`, `nomad-sandbox-provider.ts` | L | [P1-06](04-sandbox-providers.md#p1-06-no-network-policy-egress-filtering-or-east-west-isolation-on-any-provider) |
| 24 | P1 | 04 Sandbox | Resource limits not validated per-tenant (32GB/16CPU global cap only) | `src/lib/sandbox/types.ts:104-115`, `SandboxConfigService` | M | [P1-07](04-sandbox-providers.md#p1-07-resource-limits-are-not-validated-per-tenant--sandboxconfigschema-caps-at-32-gb-memory--16-cpu-cores-globally-but-nothing-enforces-a-per-tenant-ceiling) |
| 25 | P1 | 05 Stream | No code enforcement of stream-ID conventions (`plan:`/`sandbox:`/`terraform:`) | `src/services/durable-streams.service.ts:422-482`, `src/lib/streams/caddy-producer.ts:12-22` | S | [F05-01](05-event-streaming.md#f05-01--no-code-enforcement-of-stream-id-conventions) |
| 26 | P1 | 05 Stream | `droppedEventCount` is invisible beyond a getter (13 drop sites, 0 consumers) | `src/services/plan-mode.service.ts:67-116,194,206,263,386,403,453,532,545,570,600,667,679` | S | [F05-02](05-event-streaming.md#f05-02--droppedeventcount-is-invisible-beyond-a-getter) |
| 27 | P1 | 05 Stream | SSE connection cap still 50 with two separate counters | `src/services/durable-streams.service.ts`, `src/lib/streams/` | S | [F05-03](05-event-streaming.md#f05-03--sse-connection-cap-still-50-with-two-separate-counters) |
| 28 | P1 | 05 Stream | `MAX_CHUNKS=5000` silently drops history on the client | `src/app/hooks/useSession.ts` | S | [F05-04](05-event-streaming.md#f05-04--max_chunks5000-silently-drops-history-on-the-client) |
| 29 | P1 | 05 Stream | Dual-write still best-effort; no transactional outbox | `src/services/durable-streams.service.ts`, `session_events` table | M | [F05-05](05-event-streaming.md#f05-05--dual-write-still-best-effort-no-transactional-outbox) |
| 30 | P1 | 05 Stream | No client-side gap detection on reconnect | `src/lib/streams/client.ts` | S-M | [F05-06](05-event-streaming.md#f05-06--no-client-side-gap-detection-on-reconnect) |
| 31 | P1 | 05 Stream | Caddy SSE endpoints still unauthenticated | `Caddyfile`, `src/lib/streams/caddy-producer.ts` | M | [F05-07](05-event-streaming.md#f05-07--caddy-sse-endpoints-still-unauthenticated) |
| 32 | P1 | 06 Security | Plan content → GitHub issue body is neither escaped nor sanitized | `src/lib/github/issue-creator.ts:47-54,169,202` | S | [F06-04](06-security.md#f06-04--p1--plan-content--github-issue-body-is-neither-escaped-nor-sanitized) |
| 33 | P1 | 06 Security | Dev-mode bypass depends on env-var alignment across two layers | `src/server/middleware/rbac-middleware.ts:62`, `server-config.ts` | S | [F06-05](06-security.md#f06-05--p1--dev-mode-bypass-depends-on-env-var-alignment-across-two-layers) |
| 34 | P1 | 06 Security | Default-allow tool whitelist when `allowedTools` is empty | `src/lib/agents/tool-whitelist.ts:8-9` | XS | [F06-06](06-security.md#f06-06--p1--default-allow-tool-whitelist-when-allowedtools-is-empty) |
| 35 | P1 | 06 Security | In-memory rate limiter: bypassable by restart + multi-instance drift | `src/server/middleware/rate-limit.ts` | M | [F06-07](06-security.md#f06-07--p1--in-memory-rate-limiter-bypassable-by-restart--multi-instance-drift) |
| 36 | P1 | 06 Security | Tenant isolation in shared sandbox mode | `docker-provider.ts`, `~/.claude/.credentials.json` injection path | L | [F06-08](06-security.md#f06-08--p1--tenant-isolation-in-shared-sandbox-mode) |
| 37 | P1 | 06 Security | API keys and GitHub OAuth tokens: no rotation, no expiry | `src/services/api-key.service.ts`, `src/services/github-token.service.ts` | M | [F06-09](06-security.md#f06-09--p1--api-keys-and-github-oauth-tokens-no-rotation-no-expiry) |
| 38 | P1 | 06 Security | CSP blocks required external resources; likely unused in production | `src/server/router.ts:110` | S | [F06-10](06-security.md#f06-10--p1--csp-blocks-required-external-resources-likely-unused-in-production) |
| 39 | P1 | 06 Security | Markdown rendering trusts Shiki HTML; agent-controlled input | `src/app/components/markdown-content.tsx:82`, `terraform-right-panel.tsx:242` | S | [F06-11](06-security.md#f06-11--p1--markdown-rendering-trusts-shikis-html-but-the-input-path-is-agent-controlled) |
| 40 | P1 | 07 API | Pagination: cursor spec vs offset reality | `src/server/routes/*.ts`, `specs/application/api/pagination.md` | L | [F07-01](07-api-surface.md#f07-01--pagination-cursor-spec-vs-offset-reality) |
| 41 | P1 | 07 API | `{ok:true, data:[]}` used to mask infrastructure failures | `src/server/routes/events.ts`, `sandbox.ts` | S | [F07-03](07-api-surface.md#f07-03--oktrue-data-used-to-mask-infrastructure-failures) |
| 42 | P1 | 07 API | Rate limit is per-IP, in-process, multiplies across instances | `src/server/middleware/rate-limit.ts` | M | [F07-04](07-api-surface.md#f07-04--rate-limit-is-per-ip-in-process-multiplies-across-instances) |
| 43 | P1 | 07 API | Request-ID never reaches services or event payloads | `src/lib/context/request-context.ts`, services, event publishers | M | [F07-05](07-api-surface.md#f07-05--request-id-never-reaches-services-or-event-payloads) |
| 44 | P1 | 08 Frontend | Every prior readiness critical is still open (14 MB bundle, missing error boundaries, 120 console.*) | `src/app/routes/**`, `src/app/components/**` | M | [F08-01](08-frontend.md#f08-01-every-prior-readiness-critical-is-still-open) |
| 45 | P1 | 08 Frontend | Frontend test directory is empty | `src/app/__tests__/`, `vitest.config.ts` | M | [F08-02](08-frontend.md#f08-02-frontend-test-directory-is-empty) |
| 46 | P1 | 09 Testing | Schema-drift coverage is 2 of 42 tables | `tests/integration/*-schema-drift.test.ts` | M | [F09-01](09-testing.md#f09-01-schema-drift-coverage-is-2-of-42-tables) |
| 47 | P1 | 09 Testing | Frontend project is zero-tests | `src/app/**` | M | [F09-02](09-testing.md#f09-02-frontend-project-is-zero-tests) |
| 48 | P1 | 09 Testing | Functional tests mix real-service flow with raw DB writes | `tests/functional/**` | M | [F09-03](09-testing.md#f09-03-functional-tests-mix-real-service-flow-with-raw-db-writes) |
| 49 | P1 | 09 Testing | Stryker coverage is 6 files; ~400 source files rely on line coverage | `stryker.config.json` | L | [F09-04](09-testing.md#f09-04-stryker-coverage-is-6-files-400-source-files-rely-on-line-coverage) |
| 50 | P1 | 10 Observability | No `/metrics` endpoint at all | `src/server/routes/` | S-M | [F10-01](10-observability.md#f10-01--no-metrics-endpoint-at-all) |
| 51 | P1 | 10 Observability | No distributed tracing across the agent hot path | `src/lib/context/`, Claude SDK call sites | S-L | [F10-03](10-observability.md#f10-03--no-distributed-tracing-across-the-agent-hot-path) |
| 52 | P1 | 10 Observability | No error reporting integration (Sentry/Datadog) | `src/server/api.ts`, `uncaughtException` handler | S | [F10-04](10-observability.md#f10-04--no-error-reporting-integration) |
| 53 | P1 | 10 Observability | Agent-runner logs are raw `console.*`, not structured | `agent-runner/src/index.ts` (79 sites) | M | [F10-05](10-observability.md#f10-05--agent-runner-logs-are-raw-console-not-structured) |
| 54 | P1 | 10 Observability | `droppedEventCount` is still invisible (duplicate F05-02) | `src/services/plan-mode.service.ts:67-116` | XS | [F10-09](10-observability.md#f10-09--droppedeventcount-is-still-invisible) |
| 55 | P1 | 11 Operations | No CD pipeline — zero automated path from main to running image | `.github/workflows/` | L | [F11-01](11-operations-deployment.md#f11-01-no-cd-pipeline--zero-automated-path-from-main-to-a-running-image) |
| 56 | P1 | 11 Operations | Docker image and Helm chart expose divergent runtime architectures (Caddy absent in K8s) | `docker/start.sh`, `charts/agentpane/templates/deployment.yaml:41-44` | M | [F11-02](11-operations-deployment.md#f11-02-docker-image-and-helm-chart-expose-divergent-runtime-architectures) |
| 57 | P1 | 11 Operations | Graceful shutdown does not flush in-flight agent runs or sandbox containers | `src/server/bootstrap/shutdown.ts`, `phases/recovery.ts` | M | [F11-03](11-operations-deployment.md#f11-03-graceful-shutdown-does-not-flush-in-flight-agent-runs-or-sandbox-containers) |
| 58 | P1 | 11 Operations | PostgreSQL migrations are 19 versions behind SQLite | `src/lib/bootstrap/migrations/index.ts`, `src/db/migrations-pg/` | L | [F11-04](11-operations-deployment.md#f11-04-postgresql-migrations-are-19-versions-behind-sqlite) |
| 59 | P1 | 11 Operations | Migrations race on multi-replica rollouts | `src/server/bootstrap/phases/database.ts`, `charts/agentpane/` | M | [F11-05](11-operations-deployment.md#f11-05-migrations-race-on-multi-replica-rollouts) |
| 60 | P1 | 11 Operations | Helm chart persists application data in `emptyDir` | `charts/agentpane/templates/deployment.yaml:131-136` | M | [F11-06](11-operations-deployment.md#f11-06-helm-chart-persists-application-data-in-emptydir) |
| 61 | P1 | 11 Operations | Agent sandbox base image is a personal DockerHub tag with `:latest` | `docker/Dockerfile.agent-sandbox:13-15` | M | [F11-07](11-operations-deployment.md#f11-07-agent-sandbox-base-image-is-a-personal-dockerhub-tag-with-latest) |
| 62 | P1 | 11 Operations | CLI monitor publishing puts the npm token in a spec directory | `/specs/CLI_monitor/.env`, `packages/cli-monitor/package.json` | S | [F11-08](11-operations-deployment.md#f11-08-cli-monitor-publishing-puts-the-npm-token-in-a-spec-directory) |
| 63 | P1 | 12 Cross-cutting | Background timer lifecycle is inconsistent (11 `setInterval` producers) | `src/services/{scheduler,event-cleanup,task-creation,…}.service.ts` | S | [F12-04](12-cross-cutting.md#f12-04-background-timer-lifecycle-is-inconsistent) |
| 64 | P2 | 01 Service | Late-binding optional setters on TaskService bypass type-level guarantees | `src/services/task.service.ts:122-132,194-236` | M | [F01-02](01-service-architecture.md#f01-02-late-binding-optional-setters-on-taskservice-bypass-type-level-init-guarantees) |
| 65 | P2 | 01 Service | Two overlapping "running agents" maps create consistency hazards | `sandbox-state.ts:19-22`, `agent-execution.service.ts:80-85` | M | [F01-06](01-service-architecture.md#f01-06-two-overlapping-running-agents-maps-create-consistency-hazards) |
| 66 | P2 | 01 Service | TaskCreationService is a 2,623-line monolith | `src/services/task-creation.service.ts` | L | [F01-07](01-service-architecture.md#f01-07-taskcreationservice-is-a-2623-line-monolith-that-escaped-the-facade-refactor) |
| 67 | P2 | 02 Data | Raw SQL in `/api/health` violates "Never bypass Drizzle" | `src/server/routes/health.ts:99-114` | S | [F02-03](02-data-layer.md#f02-03-raw-sql-in-apihealth-violates-never-bypass-drizzle-rule) |
| 68 | P2 | 02 Data | `as unknown as TaskPlanRow` indicates schema/query shape mismatch | `plan-approval.service.ts:197,474,485`, `container-exec.service.ts:1186` | S | [F02-04](02-data-layer.md#f02-04-as-unknown-as-taskplanrow-indicates-schemaquery-shape-mismatch) |
| 69 | P2 | 02 Data | Migration runner swallows every "duplicate column" exception | `src/lib/bootstrap/migrations/runner.ts:41-47,53-60` | M | [F02-07](02-data-layer.md#f02-07-migration-runner-swallows-every-duplicate-column-exception) |
| 70 | P2 | 02 Data | Task-delete and many multi-step writes skip transactions | `src/services/task.service.ts`, `codespace.service.ts` | M | [F02-11](02-data-layer.md#f02-11-task-delete-and-many-multi-step-writes-skip-transactions) |
| 71 | P2 | 02 Data | Two parallel migration chains — inline runner vs Drizzle Kit | `src/lib/bootstrap/migrations/`, `src/db/migrations-pg/` | L | [F02-12](02-data-layer.md#f02-12-two-parallel-migration-chains--inline-runner-vs-drizzle-kit) |
| 72 | P2 | 03 Agent | Two stream handlers evolved in parallel and drifted | `src/lib/agents/stream-handler.ts`, `agent-runner/src/index.ts` | L | [F12](03-agent-execution.md#f12--two-stream-handlers-evolved-in-parallel-and-drifted) |
| 73 | P2 | 03 Agent | `executeAgentExecution` catches too broadly; agent stays "starting" on sub-failures | `src/services/agent/agent-execution.service.ts` | M | [F14](03-agent-execution.md#f14--executeagentexecution-catches-too-broadly-agent-stays-starting-on-sub-failures) |
| 74 | P2 | 04 Sandbox | Three near-identical tmux implementations across providers | `docker-provider.ts:120-217`, `agent-sandbox-instance.ts:210-313`, `nomad-sandbox-instance.ts:268-397` | M | [P2-01](04-sandbox-providers.md#p2-01-three-near-identical-tmux-implementations-across-dockersandbox-agentsandboxinstance-and-nomadsandboxinstance) |
| 75 | P2 | 04 Sandbox | `shellEscape` implemented three times; K8s `indexOf('exec ')` is latent bug | `agent-sandbox-instance.ts:100-102,154`, `nomad-sandbox-instance.ts:137-139,182` | S | [P2-02](04-sandbox-providers.md#p2-02-shellescape-is-implemented-three-times-with-subtle-differences-and-execstream-env-injection-logic-differs-between-nomad-lastindexofexec--and-k8s-indexofexec-) |
| 76 | P2 | 04 Sandbox | `validateContainers`/`validateSandboxes` silently remove entries | `docker-provider.ts:680-686`, `agent-sandbox-provider.ts:240-248`, `nomad-sandbox-provider.ts:274-283` | S | [P2-05](04-sandbox-providers.md#p2-05-validatecontainersvalidatesandboxes-silently-remove-entries--no-event-no-db-reconciliation) |
| 77 | P2 | 04 Sandbox | Health checks don't probe sandbox liveness, only provider connectivity | `docker-provider.ts`, `agent-sandbox-provider.ts`, `nomad-sandbox-provider.ts` | M | [P2-07](04-sandbox-providers.md#p2-07-health-checks-dont-probe-sandbox-liveness-only-provider-connectivity) |
| 78 | P2 | 05 Stream | Three parallel SSE subsystems, three connection counters | `src/services/durable-streams.service.ts`, `cli-monitor.service.ts`, plan-mode | M | [F05-08](05-event-streaming.md#f05-08--three-parallel-sse-subsystems-three-connection-counters) |
| 79 | P2 | 05 Stream | `session_events.sessionId` stores unrelated stream IDs with no FK | `src/db/schema/*/session-events.ts` | M | [F05-09](05-event-streaming.md#f05-09--session_eventssessionid-stores-unrelated-stream-ids-with-no-fk) |
| 80 | P2 | 05 Stream | SQLite single-writer serialises all event persistence | `src/db/client.ts`, `session_events` table | S-L | [F05-10](05-event-streaming.md#f05-10--sqlite-single-writer-serialises-all-event-persistence) |
| 81 | P2 | 06 Security | RBAC enforcement parity: six route modules miss `useRoleGuard` | `src/server/router.ts`, `src/server/routes/{tags,rbac-tokens,codespace-members}.ts` | M | [F06-12](06-security.md#f06-12--p2--rbac-enforcement-parity-six-route-modules-miss-useroleguard) |
| 82 | P2 | 06 Security | Session cookie `Secure` flag keyed on NODE_ENV, not protocol | `src/server/routes/auth.ts:196,236,252,276,295` | S | [F06-13](06-security.md#f06-13--p2--session-cookie-secure-flag-keyed-on-nodeenv-not-protocol) |
| 83 | P2 | 06 Security | Plan/sandbox/terraform stream IDs cross boundaries without origin checks | `src/services/durable-streams.service.ts`, `Caddyfile` | L | [F06-14](06-security.md#f06-14--p2--plansandboxterraform-stream-ids-cross-boundaries-without-origin-checks) |
| 84 | P2 | 07 API | No OpenAPI schema; frontend types duplicate server types | `src/lib/api/client.ts`, `src/server/routes/` | M-L | [F07-06](07-api-surface.md#f07-06--no-openapi-schema-frontend-types-duplicate-server-types) |
| 85 | P2 | 07 API | Two route modules (events.ts, sandbox.ts) are oversized and mix concerns | `src/server/routes/events.ts` (1168 LOC), `sandbox.ts` (1341 LOC) | M | [F07-07](07-api-surface.md#f07-07--two-route-modules-are-oversized-and-mix-concerns) |
| 86 | P2 | 08 Frontend | Hardcoded SVG hex colours violate the theme contract | `src/app/components/**/*.tsx` (SVG inlines) | S | [F08-04](08-frontend.md#f08-04-hardcoded-svg-hex-colours-violate-the-theme-contract) |
| 87 | P2 | 08 Frontend | Stream event contract is stringly-typed on the client | `src/app/hooks/useSession.ts`, `src/lib/streams/client.ts` | M | [F08-07](08-frontend.md#f08-07-stream-event-contract-is-stringly-typed-on-the-client) |
| 88 | P2 | 08 Frontend | No per-route `errorComponent` — route crash unmounts the shell | `src/app/routes/**` | S | [F08-09](08-frontend.md#f08-09-no-per-route-errorcomponent--route-crash-unmounts-the-shell) |
| 89 | P2 | 09 Testing | fast-check installed but used in 2 files | `tests/**`, `package.json` | M | [F09-05](09-testing.md#f09-05-fast-check-installed-but-used-in-2-files) |
| 90 | P2 | 09 Testing | E2E has 20 files but no full task-lifecycle scenario | `tests/e2e/**` | M | [F09-06](09-testing.md#f09-06-e2e-has-20-files-but-no-full-task-lifecycle-scenario) |
| 91 | P2 | 09 Testing | No retry / no flake detection | `vitest.config.ts`, `.github/workflows/ci.yml` | S | [F09-09](09-testing.md#f09-09-no-retry--no-flake-detection) |
| 92 | P2 | 10 Observability | Silent-catch tail across 78 server files and 168 occurrences | `src/**/*.ts` (catch blocks) | S | [F10-02](10-observability.md#f10-02--silent-catch-tail-across-78-server-files-and-168-occurrences) |
| 93 | P2 | 10 Observability | Frontend observability is effectively zero (241 console.* in 70 files) | `src/app/**` | S | [F10-07](10-observability.md#f10-07--frontend-observability-is-effectively-zero) |
| 94 | P2 | 10 Observability | Request ID not attached to durable-stream events or audit entries | `src/lib/context/request-context.ts`, event publishers | S | [F10-08](10-observability.md#f10-08--request-id-is-not-attached-to-durable-stream-events-or-audit-entries) |
| 95 | P2 | 10 Observability | `invariant()` violations log-and-continue in prod | `src/lib/assert/invariant.ts`, call sites | XS | [F10-13](10-observability.md#f10-13--invariant-violations-log-and-continue-in-prod) |
| 96 | P2 | 11 Operations | Secret management differs between Compose and Helm with no parity | `docker/docker-compose*.yml`, `charts/agentpane/values.yaml` | S | [F11-09](11-operations-deployment.md#f11-09-secret-management-differs-between-compose-and-helm-with-no-parity) |
| 97 | P2 | 11 Operations | Backup scripts exist but nothing runs them | `scripts/backup-db.sh`, `scripts/backup-db-pg.sh` | S | [F11-10](11-operations-deployment.md#f11-10-backup-scripts-exist-but-nothing-runs-them) |
| 98 | P2 | 12 Cross-cutting | Drizzle polymorphism forces three runtime type holes | `src/db/schema/**`, `src/services/**` (29 casts) | M | [F12-01](12-cross-cutting.md#f12-01-drizzle-polymorphism-forces-three-runtime-type-holes) |
| 99 | P2 | 12 Cross-cutting | `@ts-nocheck` on five test files hides schema drift | `tests/**/*.ts` (5 files) | S | [F12-10](12-cross-cutting.md#f12-10-ts-nocheck-on-five-test-files-hides-schema-drift) |
| 100 | P3 | 06 Security | Env vars injected into sandbox containers are visible in `ps auxe` | `docker-provider.ts:562`, `container-exec.service.ts:767` | S | [F06-16](06-security.md#f06-16--p3--env-vars-injected-into-sandbox-containers-are-visible-in-ps-auxe) |
| 101 | P3 | 04 Sandbox | `SandboxMetrics` returns zeroes on K8s/Nomad; UI renders misleading "0 MB used" | `agent-sandbox-instance.ts:327-335`, `nomad-sandbox-instance.ts:411-419` | M | [P3-05](04-sandbox-providers.md#p3-05-the-sandboxmetrics-interface-typests39-47-promises-cpu--memory-mb-disk-mb-network-bytes-uptime-k8s-and-nomad-return-zero-for-everything-except-uptime-agent-sandbox-instancets327-335-nomad-sandbox-instancets411-419-the-uis-sandbox-indicator-panel-renders-these-zeros-as-0-mb-used-which-is-materially-misleading-either-wire-them-up-via-metrics-server-k8s--nomad-alloc-status--stats-nomad-or-mark-them--null-in-the-type-and-render-unavailable-in-the-ui) |
| 102 | P3 | 11 Operations | `prepare` script only reminds, never installs pre-commit hooks | `package.json:50` | XS | [F11-13](11-operations-deployment.md#f11-13-prepare-script-only-reminds-never-installs-pre-commit-hooks) |
| 103 | P3 | 11 Operations | No release notes, no CHANGELOG, no documented rollback | repo root | S | [F11-14](11-operations-deployment.md#f11-14-no-release-notes-no-changelog-no-documented-rollback) |
| 104 | P3 | 07 API | No OpenAPI schema / endpoint discoverability (docs stale) | `specs/application/api/endpoints.md` | S | [F07-09](07-api-surface.md#f07-09--endpoint-discoverability-no-live-index-docs-stale) |

## Theme index

| File | Theme | Findings | P0 / P1 / P2 / P3 |
| --- | --- | --- | --- |
| [01](01-service-architecture.md) | Service architecture | 12 | 0 / 3 / 7 / 2 |
| [02](02-data-layer.md) | Data layer (Drizzle, migrations, JSON, TX) | 14 | 0 / 4 / 10 / 0 |
| [03](03-agent-execution.md) | Agent execution (host + container, plan/exec) | 17 | 0 / 6 / 8 / 3 |
| [04](04-sandbox-providers.md) | Sandbox providers (Docker/K8s/Nomad) | 21 | 1 / 7 / 8 / 5 |
| [05](05-event-streaming.md) | Event streaming & SSE | 18 | 0 / 7 / 8 / 3 |
| [06](06-security.md) | Security (injection, RBAC, supply chain) | 16 | 3 / 8 / 4 / 1 |
| [07](07-api-surface.md) | API surface (envelopes, RL, OpenAPI) | 12 | 0 / 4 / 4 / 4 |
| [08](08-frontend.md) | Frontend (TanStack Start, theming, tests) | 13 | 0 / 2 / 7 / 4 |
| [09](09-testing.md) | Testing (Vitest, Stryker, E2E, drift) | 13 | 0 / 4 / 7 / 2 |
| [10](10-observability.md) | Observability (logs, metrics, tracing) | 13 | 0 / 5 / 6 / 2 |
| [11](11-operations-deployment.md) | Ops & deployment (CI/CD, Docker/Helm) | 14 | 0 / 8 / 4 / 2 |
| [12](12-cross-cutting.md) | Cross-cutting (types, timers, config) | 12 | 0 / 1 / 8 / 3 |
| **Total** | | **175** | **4 / 59 / 81 / 31** |

## What this supersedes

Consolidated from the "What this supersedes" / "Prior-review disposition" tables in themes 05, 06, and 10. Every item below was audited against current code; new findings carry the `FXX-NN` pointer to the new home, resolved items have no new finding.

| Prior finding | Location | Disposition | New home |
| --- | --- | --- | --- |
| 2.1 Unbounded retention | `events_review/README.md` §2.1 | **Resolved** — `EventCleanupService` delivers P0-2 | — |
| 2.2 SQLite single-writer serialisation | `events_review/README.md` §2.2 | Still valid | [F05-10](05-event-streaming.md#f05-10--sqlite-single-writer-serialises-all-event-persistence) |
| 2.3 No chunk batching | `events_review/README.md` §2.3 | **Resolved** — `ChunkBatcher` | — |
| 2.4 O(n²) accumulated-text bloat | `events_review/README.md` §2.4 | **Resolved** — `accumulated` removed | — |
| 2.5 Single-node Caddy | `events_review/README.md` §2.5 | Still valid | [F05-17](05-event-streaming.md#f05-17--single-node-caddy-is-the-live-delivery-spof) |
| 2.6 50-connection SSE cap | `events_review/README.md` §2.6 | Still valid, promoted to P1 | [F05-03](05-event-streaming.md#f05-03--sse-connection-cap-still-50-with-two-separate-counters) |
| 2.7 Silent chunk truncation | `events_review/README.md` §2.7 | Still valid | [F05-04](05-event-streaming.md#f05-04--max_chunks5000-silently-drops-history-on-the-client) |
| 3.1 No backpressure | `events_review/README.md` §3.1 / RS-008 | Still valid | [F05-13](05-event-streaming.md#f05-13--publish-path-has-no-application-level-backpressure) |
| 3.2 No dead-letter queue | `events_review/README.md` §3.2 | Folded; webhook-specific DLQ out of scope | [F05-05](05-event-streaming.md#f05-05--dual-write-still-best-effort-no-transactional-outbox), [F05-02](05-event-streaming.md#f05-02--droppedeventcount-is-invisible-beyond-a-getter) |
| 3.3 Container-agent double-hop | `events_review/README.md` §3.3 | Still valid | [F05-11](05-event-streaming.md#f05-11--container-agent-double-hop-latency-and-parse-cost) |
| 3.5 Offset-based pagination fragility | `events_review/README.md` §3.5 | Partially mitigated; P3 polish | — |
| 3.6 Memory accumulation in stream handler | `events_review/README.md` §3.6 | Mitigated by batching | — |
| RS-001 Producer pool unbounded growth | events_review hybrid §2 | **Resolved** — LRU + idle sweep | — |
| RS-002 Duplicate SSE tracking | events_review hybrid §2 | Still valid | [F05-08](05-event-streaming.md#f05-08--three-parallel-sse-subsystems-three-connection-counters) |
| RS-006 No gap detection | events_review hybrid §2 | Still valid | [F05-06](05-event-streaming.md#f05-06--no-client-side-gap-detection-on-reconnect) |
| RS-009 Three disconnected systems | events_review hybrid §2 | Still valid | [F05-08](05-event-streaming.md#f05-08--three-parallel-sse-subsystems-three-connection-counters) |
| RS-010 Shared subscription map cleanup | events_review hybrid §2 | **Resolved** — 60s orphan audit | — |
| RS-011 `useSession` unbounded array | events_review hybrid §2 | **Resolved** for growth; surface gap | [F05-04](05-event-streaming.md#f05-04--max_chunks5000-silently-drops-history-on-the-client) |
| RS-013 Dual-write inconsistency | events_review hybrid §2 | Still valid | [F05-05](05-event-streaming.md#f05-05--dual-write-still-best-effort-no-transactional-outbox) |
| RS-014 Offset collision retry limited to 3 | events_review hybrid §2 | **Resolved** by atomic INSERT | — |
| RS-019 Caddy unauthenticated | events_review hybrid §2 | Still valid, raised to P1 | [F05-07](05-event-streaming.md#f05-07--caddy-sse-endpoints-still-unauthenticated) |
| C1 Docker CapDrop/SecurityOpt | `release_plan/02-security-hardening.md` | **Resolved** | — |
| C2 Path traversal in GitHub clone | `release_plan/02-security-hardening.md` | **Resolved** | — |
| C3 Shell interpolation in `codespace.service.cloneRepository` | `release_plan/02-security-hardening.md` | **Partially resolved** — runner path still interpolates | [F06-02](06-security.md#f06-02--p0--shell-interpolation-in-createbuncommandrunner) |
| C4 Hardcoded CORS origin in SSE | `release_plan/02-security-hardening.md` | **Resolved** | — |
| H1 No expired session cleanup | `release_plan/02-security-hardening.md` | **Resolved** | — |
| H2 XFF spoofing in rate limiter | `release_plan/02-security-hardening.md` | **Resolved** | — |
| H3 Audit hook empty catch | `release_plan/02-security-hardening.md` | **Resolved** | — |
| H4 In-memory rate limiting | `release_plan/02-security-hardening.md` | Still valid | [F06-07](06-security.md#f06-07--p1--in-memory-rate-limiter-bypassable-by-restart--multi-instance-drift) |
| H5 Empty tool whitelist allows all | `release_plan/02-security-hardening.md` | Still valid | [F06-06](06-security.md#f06-06--p1--default-allow-tool-whitelist-when-allowedtools-is-empty) |
| H6 `Secure` cookie only in NODE_ENV=production | `release_plan/02-security-hardening.md` | Still valid | [F06-13](06-security.md#f06-13--p2--session-cookie-secure-flag-keyed-on-nodeenv-not-protocol) |
| Sensitive data masking in logger | `release_plan/03-observability.md` | **Resolved** — `maskSensitiveData()`, 18 tests | — |
| Fix silent catch blocks (50+) | `release_plan/03-observability.md` | **Partially resolved** — loud ones fixed, 168 occurrences remain | [F10-02](10-observability.md#f10-02--silent-catch-tail-across-78-server-files-and-168-occurrences) |
| Replace `console.*` with structured logger | `release_plan/03-observability.md` | **Resolved for server**; agent-runner + frontend untouched | [F10-05](10-observability.md#f10-05--agent-runner-logs-are-raw-console-not-structured), [F10-07](10-observability.md#f10-07--frontend-observability-is-effectively-zero) |
| Add `service`/`environment` fields | `release_plan/03-observability.md` | **Resolved** | — |
| `/api/metrics` endpoint | `release_plan/03-observability.md` | Still open | [F10-01](10-observability.md#f10-01--no-metrics-endpoint-at-all) |
| Sentry / error reporting | `release_plan/03-observability.md` | Still open | [F10-04](10-observability.md#f10-04--no-error-reporting-integration) |
| OpenTelemetry tracing | `release_plan/03-observability.md` | Still open | [F10-03](10-observability.md#f10-03--no-distributed-tracing-across-the-agent-hot-path) |
| Pino migration / Prometheus / Grafana / Alerts | `release_plan/03-observability.md` | Still open, downgraded | Follow F10-01 / F10-03 |

## Not in scope

- **Roadmap items in `specs/roadmap/`** — explicitly future work, marked NOT FOR IMPLEMENTATION in each file. Examples: phase-2 sandbox plugins, durable-execution Inngest, CQRS snapshots, webhook DLQ.
- **Open work already owned by PR #158** — agent approval mode, auto-start, skill visibility fixes.
- **Open work already owned by issue #143** — `secureexec.dev` integration for task creation isolation.
- **`@agentpane/cli-monitor` runtime internals** — reviewed only at the packaging/publishing layer ([F11-08](11-operations-deployment.md#f11-08-cli-monitor-publishing-puts-the-npm-token-in-a-spec-directory)). Deep review deferred.
- **Memory / Honcho / Dream services** — noted only where they cross other themes ([F01-11](01-service-architecture.md#f01-11-memory-and-dream-services-are-constructed-eagerly-but-initialized-asynchronously-post-construction)).
- **Terraform Compose UX** — stream delivery covered in [F05-12](05-event-streaming.md#f05-12--ephemeral-terraform-streams-lose-data-on-caddy-restart-mid-compose); product UX not covered.
- **Topology designer / workflow designer UX** — bundle size flagged in [F08-06](08-frontend.md#f08-06-elkbundled-145-mb-lazy-only-for-topology-check-workflow-designer); product UX not covered.
- **AgentCore (AWS Bedrock) path** — reviewed only to recommend deletion ([P1-02](04-sandbox-providers.md#p1-02-agentcore-is-half-deleted--migration-0011-dropped-the-db-columns-but-1200-loc-of-providerinstancebridgeerrors-code-remains-reachable-and-the-health-path-uses-a-dynamic-import-aws-sdk-that-is-never-declared-as-a-dependency), [F1](03-agent-execution.md#f1--agentcore-path-is-dead-code-but-still-present-in-two-packages)); no deep review.

## Reading order

- **Executives / lead eng**: `README.md` → [06 Security](06-security.md) → [11 Operations & deployment](11-operations-deployment.md) — the P0s, supply chain, and production-readiness picture.
- **Platform eng (infra + data)**: `README.md` → [01 Service](01-service-architecture.md) → [02 Data](02-data-layer.md) → [03 Agent](03-agent-execution.md) → [04 Sandbox](04-sandbox-providers.md) → [05 Streaming](05-event-streaming.md).
- **Product eng**: `README.md` → [07 API](07-api-surface.md) → [08 Frontend](08-frontend.md) — consumer-visible surface.
- **QA / DevEx**: `README.md` → [09 Testing](09-testing.md) → [10 Observability](10-observability.md) → [11 Operations & deployment](11-operations-deployment.md) — CI/CD, coverage, debugging.
- **Security review / audit**: `README.md` → [06 Security](06-security.md) → [04 Sandbox](04-sandbox-providers.md) P0-01/P1-05/P1-06 → [11 Operations & deployment](11-operations-deployment.md) F11-07/F11-08.

## Next steps

1. **P0s become release blockers this sprint.** Four items: (a) pin + sign the agent-sandbox image with digest and Trivy scan (04 P0-01 / 11 F11-07), (b) clear the 2 critical + 17 high Dependabot advisories (06 F06-01), (c) convert `CommandRunner` to positional argv and delete the `sh -c` shim (06 F06-02), (d) route SKILL.md frontmatter through a YAML serializer and tighten tag validation (06 F06-03). Assign each an owner by end of week; track in a dedicated GitHub milestone.
2. **P1s triage into the next 2–3 sprints as theme-scoped epics.** Each of the 12 theme files becomes an epic, with its P1 list as the initial task breakdown. The three heaviest epics by count are 11-operations (8 P1s, needs a CD + Helm push), 06-security (8 P1s, mostly platform controls), and 05-event-streaming (7 P1s, clusters around auth, backpressure, and dual-write). Expect 6–8 weeks of focused work to drain the P1 list.
3. **P2/P3 become "cleanup Friday" candidates and dependabot-group work.** Most P2s are maintainability debt that unlocks future velocity (e.g. F02-12 two-migration-chain merge, F01-07 TaskCreationService split, P2-01/P2-02 sandbox-provider shared utilities) — schedule one per engineer per fortnight. P3s ship opportunistically.
4. **Re-run this review at the next major release.** The 12-theme scaffolding is designed to be re-executed: each file has a "Summary" / "What's working" / "Findings" / "Open questions" block, so the same agent pass can diff findings and produce a delta. Target cadence: every 8–12 weeks, or immediately after a subsystem rewrite.
