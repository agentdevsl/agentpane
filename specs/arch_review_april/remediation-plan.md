# April 2026 Architecture Review — Remediation Plan

## Context
The April review (`specs/arch_review_april/`) catalogued **4 P0 and ~59 P1 findings** across 12 themes. This plan specifies how they get fixed, in what order, with what test bar, and how completion is verified.

**Scope rule** — **all P0 + all P1 whose effort is S / M / L**. XL-effort P1 items (e.g. NATS JetStream, CloudEvents envelope, OpenTelemetry full stack wire-up, full Stryker expansion) are explicitly deferred with a follow-up tracking issue.

**Fix bar** — **code landed + at least one test**. Every finding marked *Resolved* must have:
1. The recommended change (or an equivalent rationalised change) landed in code.
2. At least one new or updated test that exercises the new behaviour (unit / integration / functional / jsdom / e2e — whichever fits the theme).
3. A cross-reference in the commit message back to the finding ID.

**Branch** — all work lands on `p0-p1-april` (already created at `f9605383` lineage, up-to-date with `main@7981ed73`).

---

## Delivery shape
**One PR per theme**, 12 PRs total. Each PR:
- Branches from `p0-p1-april` (e.g. `p0-p1-april/01-service-architecture`), targets `p0-p1-april`.
- After all 12 merge into `p0-p1-april`, one final PR merges `p0-p1-april → main`.
- Title: `fix(arch-review): theme NN — <short>`.
- Body: lists every finding ID addressed, each with its resolution and test reference.

This contains review surface and keeps revert easy. The compact "one-sprint" scope (~60 findings, 12 themes) fits the one-PR-per-theme pattern without over-fragmenting.

## Theme ordering (dependency-aware)
Security and data/bootstrap first — other themes can assume those foundations. UI and cross-cutting last.

1. **06 — Security** (3 P0 + 8 P1) — unblocks everything; contains the release-blocker P0s.
2. **02 — Data layer** (4 P1) — Postgres parity, schema-drift coverage, pool tuning. Unblocks operations and testing themes.
3. **01 — Service architecture** (3 P1) — bootstrap hardening + DB reconciliation.
4. **04 — Sandbox providers** (1 P0 + 7 P1) — image pinning + provider parity + orphan sweep.
5. **03 — Agent execution** (6 P1) — hooks, AgentCore removal, host-mode parity, OAuth expiry.
6. **05 — Event streaming** (7–11 P1 depending on sub-effort) — stream-ID tagging, dropped-event observability, SSE cap lift, auth on Caddy, gap detection.
7. **10 — Observability** (5 P1) — `/metrics`, Sentry, structured logs, request-ID correlation.
8. **11 — Ops & deployment** (8 P1) — CD workflow, Helm/Docker parity, graceful shutdown, PG parity, CLI token move.
9. **07 — API surface** (4 P1) — pagination, error shape consistency, rate-limit store, request-ID plumb.
10. **09 — Testing** (4 P1) — schema-drift generator, frontend test seed, functional-test hygiene, Stryker expansion.
11. **08 — Frontend** (2 P1) — error boundaries, frontend test seed (overlaps with 09).
12. **12 — Cross-cutting** (1 P1) — background-job lifecycle standardisation.

---

## Test loop

**Per PR (theme)**
```bash
# Tier 1: after each atomic fix inside the theme
bun run typecheck

# Tier 2: before pushing the theme PR
bunx vitest run --project <theme-relevant-projects>
# e.g. security/data/agents → --project unit --project db --project integration --project functional
# frontend → --project jsdom
# testing theme → --project unit --project db (the new seed tests)
```

**After all 12 themes merged into `p0-p1-april`**
```bash
bun install                       # refresh if any lockfile moved
bun run typecheck
bun run build                     # root + agent-runner
bun vitest run                    # full suite, every project, no shard
```

All must be green before opening `p0-p1-april → main`.

---

## Applicability gate (before each finding is actioned)

Since this plan runs over several days and the review was authored at `f9605383` (before PR #158, #160, #161, #162 merged), every finding has to pass a **currency check** before being fixed:

1. Read the finding's file refs at current `HEAD`.
2. If the observation still holds — fix.
3. If the observation is already resolved by a recent merge — add a line to the themed file with the resolving commit SHA and mark the finding **Resolved (pre-existing)** in the PR body.
4. If the observation has moved (file renamed, refactor landed) — note the new location in the finding and still fix if the underlying risk remains.

Implementer MUST NOT blindly apply the review's recommendation without re-reading current code.

---

## Per-theme work items

Each theme's PR addresses the findings listed. IDs use the source file's own anchor convention.

### 06 — Security (first PR, release-blocker)
- **F06-01 (P0, M)** — Triage 42 Dependabot advisories (2 critical, 17 high). Close duplicates, bump versions, record acceptable risks in `specs/arch_review_april/06-security.md` dispositions.
- **F06-02 (P0, M)** — Convert `createBunCommandRunner` to positional argv API; migrate every caller in `src/server/bootstrap/service-container.ts:62` + downstream users. Test: fuzz a call with shell metacharacters and assert literal pass-through.
- **F06-03 (P0, S)** — Use the `yaml` package for SKILL.md frontmatter emission in `src/lib/sandbox/skill-injector.ts:42-48`; validate tags with a safe regex. Test: hostile tag (`"\n---\nevil: true\n"`) produces valid YAML with the hostile content as a single string value.
- **F06-04 (P1, S)** — Sanitise/escape `closes|fixes|resolves` keywords, `@mentions`, and label-regex-invalid chars in `src/lib/github/issue-creator.ts:47-54`. Test: plan body containing `Closes #1` does not auto-close issue #1.
- **F06-05 (P1, S)** — Helper `isDevAuthAllowed()`; require BOTH `NODE_ENV!=='production'` AND `SKIP_AUTH==='true'`. Test: `SKIP_AUTH=true NODE_ENV=production` boots with auth enforced.
- **F06-06 (P1, S)** — Empty `allowedTools` array must **deny**; require `['*']` for open access. Test: empty array denies every tool.
- **F06-07 (P1, M)** — Redis/Valkey adapter with in-memory fallback documented as non-production; key on `(tenantId|userId, endpoint, window)`. Test: 429 returned after limit with Redis backend (use `ioredis-mock` or testcontainer).
- **F06-08 (P1, M)** — Gate shared-sandbox mode on `MULTI_TENANT=false`. Test: creating a 2nd codespace with `MULTI_TENANT=true` + mode=shared produces an error.
- **F06-09 (P1, S)** — Add `expiresAt`, `rotatedAt` columns (migration) to `api_tokens` + github OAuth stores. Surface `/api/admin/tokens/rotation-due` endpoint. Test: token with expiresAt in the past returns 401.
- **F06-10 (P1, M)** — CSP-Report-Only for 1 week, then tuned directive set. Test: Playwright smoke against each major route reports zero violations.
- **F06-11 (P1, S)** — `HighlightedCode` wrapper running DOMPurify on Shiki output in `markdown-content.tsx:82` and `terraform-right-panel.tsx:242`. Test: payload `<img src=x onerror=alert(1)>` is rendered as text.

### 02 — Data layer
- **F02-01 (P1, M)** — Split `0004_schema_catchup.sql` into per-change Postgres migrations. Add CI check: every `src/db/migrations/*.sql` must have a matching `src/db/migrations-pg/*.sql` within N commits. Test: CI script runs green on current state.
- **F02-02 (P1, M)** — Parametrised schema-drift helper iterates every exported table in `src/db/schema/sqlite/index.ts`. Test: generator produces ≥40 drift tests; running them all passes.
- **F02-05 (P1, S)** — Postgres pool config from env: `max`, `idle_timeout`, `max_lifetime`, `connect_timeout`, `application_name`, `ssl`. Test: invalid config throws a typed error at boot.
- **F02-13 (P1, M)** — Add testcontainers-based Postgres integration test (`bun vitest run --project integration` optional gate) exercising migration runner end-to-end.

### 01 — Service architecture
- **F01-01 (P1, M)** — At boot (in a new `phases/sandbox-reconciliation.ts`), list live sandboxes per provider and reconcile against `sandbox_instances` table: adopt orphans into memory maps or destroy them. Test: seed a DB row without a live container; reconcile marks row terminated.
- **F01-03 (P1, S)** — Gate `/api/health` sandbox subsystem on `sandboxState.provider !== null`; readiness returns 503 until init completes. Test: call `/api/health` before sandbox init completes returns `status:'degraded'` with subsystem reason.
- **F01-05 (P1, S)** — Introduce `BootstrapPhaseResult` with `fatal: boolean`; every phase reports explicitly. Test: non-fatal phase failure does NOT exit the process; fatal phase does.

### 04 — Sandbox providers
- **P0-01 (P0, M)** — Mirror `srlynch1/agent-sandbox:latest` into `ghcr.io/agentdevsl/agent-sandbox:@sha256:<digest>`. Update `src/lib/sandbox/types.ts` default. Add Trivy scan to CI. Test: `SandboxConfigService.validate()` rejects an unpinned image reference (no `@sha256:`).
- **P1-01 (P1, M)** — Promote `SandboxProvider` interface to include `recover()`, `list()`, `execAsRoot()` uniformly; discriminated union error type. Test: each provider satisfies the interface at compile time and produces identical error shapes in a shared test suite.
- **P1-02 (P1, M)** — Delete AgentCore path from default build. Guard any remaining code behind `AGENTCORE_ENABLED=true`. Test: `grep -r agentcore src/` in default build yields no import chain from `server-bootstrap.ts`.
- **P1-03 (P1, M)** — Add `recover()` to K8s + Nomad providers; startup sweep cross-references DB. Test: orphan pod in fake K8s client gets deleted on recover.
- **P1-04 (P1, M)** — Bundle with P1-03: unique index on `sandbox_instances(codespaceId) WHERE status = 'running'`. Test: race creating two sandboxes for same codespace triggers constraint violation.
- **P1-05 (P1, M)** — Inject OAuth via `docker cp` / K8s `exec -i` stdin, never env-var arg. Test: `docker inspect` of a sandbox shows the env block has no `CLAUDE_OAUTH_TOKEN`.
- **P1-06 (P1, M)** — Default `networkMode: 'none'` for execute phase; K8s `NetworkPolicy`; Nomad Consul Connect config. Test: container can reach allowlisted git host, not arbitrary egress.
- **P1-07 (P1, M)** — Per-tenant quota in settings; enforce in `SandboxConfigService`. Test: exceeding quota returns `SANDBOX_QUOTA_EXCEEDED`.

### 03 — Agent execution
- **F1 (P1, M)** — Archive `agentcore-bridge.ts`, `agentcore-handler.ts`, `agentcore-sandbox-provider.ts` behind `AGENTCORE_ENABLED=true` OR delete outright. Coordinate with 04-P1-02. Test: default CI run does not load bedrock-agentcore module.
- **F2 (P1, M)** — Thread `preToolHooks` / `postToolHooks` arrays into the `canUseTool` callback inside `runAgentExecution`. Test: registered hook actually runs on a mock tool invocation.
- **F3 (P1, S)** — **Delete** `launchSwarm`, `teammateCount`, `pushToRemote` fields end-to-end. Team mode is deferred to an XL follow-up. Update `CLAUDE.md` to remove the "Team Mode" section. Test: existing ExitPlanMode tests continue to pass after schema shrink.
- **F5 (P1, M)** — Thread `sdkSessionId` into host-mode stream options, mirroring container-mode behaviour. Test: host-mode resume reuses the prior session id.
- **F6 (P1, S)** — Add host-mode fallback to `rejectPlan` with atomic CAS on column transition. Test: host-mode reject moves task to backlog and removes worktree.
- **F11 (P1, M)** — Plumb real `expiresAt` from host into agent-runner credentials; unique `HOME` per agent-runner invocation. Test: two concurrent agent-runners don't collide on `~/.claude/.credentials.json`.

### 05 — Event streaming
- **F05-01 (P1, S)** — Branded types `PlanStreamId`, `SandboxStreamId`, `TerraformStreamId`, `SessionStreamId` with prefix-prepending constructors. Test: TS compilation fails if a `SessionStreamId` is passed where `PlanStreamId` is expected.
- **F05-02 (P1, S)** — `log.warn` at every `droppedEventCount` increment with streamId + eventType. Expose `GET /api/admin/metrics/plan-mode` returning the counter. Test: force a publish error; admin endpoint returns count ≥1.
- **F05-03 (P1, S)** — Unified event router; cap 200; per-user quota. Test: 201st connection for same user returns 429 with Retry-After.
- **F05-04 (P1, S)** — `truncated: boolean` + `truncatedAt: offset` on the client state; banner with "Load earlier" backed by REST. Test: exceeding MAX_CHUNKS sets `truncated=true`.
- **F05-05 (P1, M)** — `event_outbox` table with 50ms relay service. Test: insert via outbox visible in stream within 100ms; kill relay, events queue up; restart, events flush in order.
- **F05-06 (P1, S)** — On reconnect compare `getLastOffset()` with first received event's offset; fetch gap from REST. Test: simulated 5-event gap on reconnect triggers gap-fill REST call.
- **F05-07 (P1, M)** — Caddy `forward_auth` against `POST /api/auth/verify-stream`. Test: unauthenticated `/v1/stream/*` request returns 401; authenticated with scoped token succeeds.
- **F05-11 (P1, M)** — Container-side chunk batcher (10 tokens or 50ms). Test: agent-runner emits batched JSON line; host bridge decodes into individual events.
- **F05-13 (P1, S)** — Emit `publish_lag_ms` gauge. Test: gauge metric recorded at each publish.
- **F05-14 (P1, S)** — Pin exact versions of `@durable-streams/{client,server,state}`; add contract test verifying subscribe/publish round-trip. Test: contract test passes against current pinned versions.
- **F05-15 (P1, S)** — Add `onTerminalDisconnect` callback; render Reconnect button; reset counter on success. Test: forcing 8 retries fires callback; subsequent connect resets counter.

### 10 — Observability
- **F10-01 (P1, S)** — Add `GET /api/metrics` returning JSON (request counts, agent counters, SSE gauge, DB-latency histogram). Test: hitting the endpoint after N requests reports `request_total:N`.
- **F10-03 (P1, S)** — Propagate `requestId` → `correlationId` field on durable-streams envelope and agent-runner JSON log lines. Test: correlation chains across three hops.
- **F10-04 (P1, S)** — Sentry wired into `process` handlers, `app.onError`, `invariant` prod branch, agent-execution catch. Test: throwing in a route calls Sentry mock with expected context.
- **F10-05 (P1, M)** — Replace `console.*` in `agent-runner/src/index.ts` with structured JSON logger. Host `container-bridge.ts` parses both events and logs. Test: agent-runner logs are valid JSON with `correlationId` field.
- **F10-09 (P1, XS)** — Already fixed if F05-02 lands (same finding, different theme). Cross-link in both PRs.

### 11 — Ops & deployment
- **F11-01 (P1, M)** — `release.yml` workflow: matrix multi-arch build, Trivy scan, push to `ghcr.io`, `helm package`, create GitHub Release with artifacts. Test: PR with `[release]` label triggers workflow in dry-run mode.
- **F11-02 (P1, M)** — Ship `durable-streams-server` as a named sidecar in Helm chart OR a separate chart dependency. Align Docker Compose and Helm env vars. Test: `helm template` output contains the sidecar container spec.
- **F11-03 (P1, M)** — In `shutdown.ts`: mark running agents `interrupted`, write pre-shutdown event, best-effort stop containers. Test: shutdown during active run writes `agent:interrupted` event.
- **F11-04 (P1, M)** — Regenerate all PG migrations from Drizzle schema; add functional test exercising task lifecycle on PG. Overlap with F02-01. Test: `drizzle-kit check --config drizzle.config.pg.ts` passes.
- **F11-05 (P1, M)** — Helm `pre-upgrade` hook Job runs migrations; app container verifies schema only. Test: `helm upgrade` with a pending migration runs the hook and does not race across replicas.
- **F11-06 (P1, M)** — Optional PVC in Helm values; PDB `maxUnavailable: 0`; README warns SQLite is unsupported on K8s. Test: `helm template --set persistence.enabled=true` produces PVC spec.
- **F11-07 (P1, M)** — Overlap with 04-P0-01: ship `ghcr.io/agentdevsl/agent-sandbox` at pinned digest. Test: integration test pulls by digest, not tag.
- **F11-08 (P1, S)** — Move npm publish token to repo secret `NPM_PUBLISH_TOKEN`. Add `publish-cli-monitor.yml` workflow with `--provenance`. Delete `/specs/CLI_monitor/.env` entry. Test: workflow dry-run uses the secret, not the env file.

### 07 — API surface
- **F07-01 (P1, L)** — Pick one pagination strategy (cursor recommended); implement `paginate<T>()` helper; migrate existing offset callers. Rewrite `specs/application/api/pagination.md` to match code. Test: pagination invariants (stable ordering, no dupes, no skips) on a 1000-row fixture.
- **F07-03 (P1, S)** — Replace the `{ok:true, data:[]}` masking pattern at `codespaces.ts:430,434`, `events.ts:193,675,682` with `{data:{items:[], source:'degraded'}}` or `{ok:false, error}`. Test: forcing upstream failure returns the non-ok shape; frontend handles it.
- **F07-04 (P1, M)** — Same fix as F06-07 (Redis rate-limit). One implementation, two findings resolved. Cross-link.
- **F07-05 (P1, M)** — Add `requestId` to logger context via middleware; thread as explicit field on `durable-streams.publish`. Test: a single request's log lines share a `requestId`; downstream events include it.

### 09 — Testing
- **F09-01 (P1, M)** — Parametrised schema-drift helper (overlap with F02-02, one implementation). Expand to all tables. Test: the generator produces ≥40 tests and they all pass.
- **F09-02 (P1, M)** — Seed three `jsdom` tests: session dedupe, `apiClient` response shape, error boundary recovery. Test: these three tests pass and run in `--project jsdom`.
- **F09-03 (P1, S)** — Audit `tests/functional/` for raw-DB writes that bypass services; route preconditions through real service methods per CLAUDE.md functional-tests rule. Test: one fixed functional test still exercises the full transition.
- **F09-04 (P1, M)** — Expand Stryker scope incrementally to include `crypto` and `github-token` services. Add `mutate:security` npm script. Test: mutation score ≥70% on the expanded scope.

### 08 — Frontend
- **F08-01 (P1, S)** — Wrap Kanban, Workflow Designer, Session History in error boundaries; replace `fallback={null}` with skeletons at the 6 flagged sites. Test: forcing a throw inside each wrapped view renders the boundary fallback.
- **F08-02 (P1, S)** — Overlap with F09-02: same seed tests satisfy both.

### 12 — Cross-cutting
- **F12-04 (P1, M)** — `BackgroundJob` interface with `start()`, `stop()`, `healthSnapshot()`. All `setInterval` timer owners implement it and register with `ServerBootstrap`. Test: shutdown calls `stop()` on every registered job.

---

## Subagent review protocol (after all PRs merge into `p0-p1-april`)

1. Launch **3 parallel reviewer Agents**, one per 4-theme block (01–04, 05–08, 09–12).
2. Each reviewer:
   - Opens every themed file and every P0/non-XL P1 finding.
   - Runs `git diff main...p0-p1-april -- <files_referenced>` to see what landed.
   - Runs the relevant test(s) added in this round (mapped by commit-message back-reference to the finding).
   - Produces a table: `| id | resolved? | commit | test file | notes |`.
3. Any row with `resolved? = no` or ambiguous becomes a residual-gap item. The leader agent consolidates the three tables into a single residual-gap report at `specs/arch_review_april/remediation-gaps.md`.
4. Residual gaps block the final `p0-p1-april → main` PR until either fixed or deliberately re-classified with rationale.

## Exit criteria

1. All P0 findings resolved (code + test).
2. All non-XL P1 findings resolved OR explicitly deferred with a rationale in the residual-gap report.
3. Full `bun vitest run` + `bun run build` + `bun run typecheck` green on `p0-p1-april`.
4. Three reviewer agents agree on the resolution map (or documented disagreements become residual gaps).
5. Final PR merged into `main`.

## Out of scope (explicit)

- All P2 and P3 findings (documented, not fixed here).
- XL-effort P1s (tracked as follow-ups). Known XL items:
  - Team mode implementation (vs. deletion, which is the P1 fix above).
  - Full NATS JetStream event-bus swap (F05 adjacent, deferred).
  - Full OpenTelemetry tracing + Grafana stack (F10 adjacent).
  - Dual-database full parity beyond what the catchup-split buys.
- Roadmap items in `specs/roadmap/` (explicitly not for implementation).
