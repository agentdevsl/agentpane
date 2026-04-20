# Testing

## Summary
Runner: Vitest 4.1.4, five projects (`unit` / `jsdom` / `db` / `integration` / `functional`), CI-sharded 3-way for `unit+jsdom+db` and 2-way for `integration+functional`. Stryker 9.6.1 is wired on state-machines + RBAC only; fast-check 4.7.0 is installed but used in two files. Disk count: **158 integration files, 6 functional files, 26 `route-*.test.ts`, 342 Vitest-project files + 20 Playwright/agent-browser E2E**. Prior readiness (`specs/release_plan/01-test-suite-health.md`, 2026-03-28) logged 7,328 passing / 0 failing at ~67 s; still broadly true after #156 (coverage uplift) and #161 (integration-cache fix). Material gaps: (a) 40 of 42 Drizzle tables have no schema-drift guard, (b) Stryker scope is 6 files so everything else leans on line coverage, (c) `src/app/**` has zero tests (cross-link `08-frontend.md` F08-02). No P0.

## Map
| Layer | Files | Purpose |
|-------|-------|---------|
| Config | `vitest.config.ts`, `vitest.e2e.config.ts`, `stryker.config.json` | Five-project split; e2e `maxWorkers: 1` |
| CI | `.github/workflows/ci.yml`, `mutation-testing.yml` | 3-shard main, 2-shard integration, weekly Stryker |
| Schema drift | `tests/integration/{agents,session}-schema-drift.test.ts`, `scripts/check-schema-drift.ts` | 2 of 42 tables |
| Factories | `tests/factories/*.factory.ts` | 7 entities — no RBAC/skill/workflow/template/settings |
| Unit | `tests/lib/**`, `tests/mocks/**`, `tests/routes/**`, `src/**/__tests__/**` | Threads pool |
| jsdom | `tests/components/**`, `tests/hooks/**`, `**/*.test.tsx` | Zero matches under `src/app/**` |
| db | `tests/services/**`, `tests/api/**`, `tests/server/**`, `tests/db/**` | Forks (SQLite PRAGMA isolation) |
| Integration | `tests/integration/**` (158 files) | Hono route + service + SQLite |
| Functional | `tests/functional/**` (6 files, ~80 tests) | Real-service lifecycle |
| E2E | `tests/e2e/**` + `K8S_E2E=true` | `.skipIf(!serverRunning)` |
| Property | `src/lib/state-machines/__tests__/{state-machines.property,task-workflow.model}.test.ts` | Only 2 fast-check files |
| Mutation | `mutate:state-machines`, `mutate:rbac`, `mutate:incremental` | Scope ~6 files, thresholds 90/80/75 |

## What's working
- Five-project topology is deliberate: forks for DB (SQLite PRAGMA isolation), threads for pure code. Integration is a separate CI job gated on `[test, lint-and-typecheck, build, semgrep]`.
- Functional tests honour the contract: `task-lifecycle-e2e.test.ts` drives the full task lifecycle through real service methods, mocking only Claude SDK / sandbox / git / DurableStreams.
- Schema-drift fast-fails in `lint-and-typecheck` via `scripts/check-schema-drift.ts` before any shard boots.
- Stryker is incremental (cached), typescript-checked, thresholds real (break=75), runs per PR on touch + weekdays 04:00 UTC.
- Factory discipline: seven factories funnel through `tests/helpers/database.ts` — one idiom, not N.
- RBAC is best-covered: 12 test files across service unit + middleware + route integration + cross-service + token-ceiling + tag-access + role-resolution.
- No `.only` leaks on `main`.

## Findings

### F09-01: Schema-drift coverage is 2 of 42 tables
- **Priority**: P1
- **Observation**: Drizzle defines 88 `sqliteTable` / `pgTable` declarations across `src/db/schema/` (42 logical tables × 2 dialects). Only `agents` and `sessions` have runtime drift tests. `tasks`, `worktrees`, `codespaces`, `sandboxInstances`, `sessionEvents`, `settings`, `teams`, `api_keys`, `rbac_tokens`, `workflows`, `skills`, `templates`, `github_tokens`, `plan_sessions`, `webhooks`, `schedules` — no drift guard.
- **Risk**: The very bug class CLAUDE.md's "Preventing Regressions" section calls out is caught on 2 of 42 tables. Drift on `sandboxInstances` (sandbox ID consistency) or `sessionEvents` (no FK on `sessionId`) ships green.
- **Recommendation**: Factor the existing test into a parameterised helper iterating `src/db/schema/index.ts` exports. One file, 42 assertions. Cross-link `02-data-layer.md`.

### F09-02: Frontend project is zero-tests
- **Priority**: P1
- **Observation**: `find src/app -name "*.test.*"` returns 0. The `jsdom` `include` pattern has no `src/app/**` matches. 81 tests live under `src/**/__tests__/` — zero under `src/app/**`. 40+ components use `apiServerFetch<T>` with no UI-layer guard that `T` maps to `data`, not the envelope.
- **Risk**: Silent regressions in `use-session` (rAF batching, seen-event dedupe), `DurableStreamsClient` reconnect, Kanban DnD, plan approval. CLAUDE.md cites `tests/api/sessions.test.ts` for the double-wrap bug — but that's a server test; a client change bypasses it.
- **Recommendation**: Seed three jsdom tests: session dedupe across reconnect; `apiClient.sessions.listEvents()` returns flat array; `TopologyErrorBoundary` recovers. Don't chase parity. Cross-link `08-frontend.md` F08-02.

### F09-03: Functional tests mix real-service flow with raw DB writes
- **Priority**: P1
- **Observation**: CLAUDE.md §"Functional Tests: Real Service Transitions" bans simulating transitions with raw DB updates. Violations: `prove-plan-approval-bugs.test.ts:330` (`db.update(tasks).set({ lastAgentStatus })`), `prove-task-service-bugs.test.ts:286,383` (raw session insert + lastAgentStatus), `state-guard-vulnerabilities.test.ts:306` (same), `prove-session-worktree-bugs.test.ts` (raw worktree inserts, session deletes).
- **Risk**: Arrange-phase shortcuts bypass the orchestration being tested. Guards inside `updateTaskOnAgentComplete` go uncovered in the exact scenarios `prove-*` was written to expose.
- **Recommendation**: Route preconditions through services where an API path exists; annotate `// intentional: no API path` for real out-of-band corruption tests. Add a CI grep rule against `db\.(update|insert|delete)` in `tests/functional/` that requires the comment.

### F09-04: Stryker coverage is 6 files; ~400 source files rely on line coverage
- **Priority**: P1
- **Observation**: `stryker.config.json` mutates only state-machines + `rbac{,-token}.service.ts` + `{auth,rbac}-middleware.ts`. Agent execution (`agent-execution.service.ts`, `stream-handler.ts`, `container-agent/*`), sandbox providers, `src/lib/crypto/*`, skill-injection shell-escaping helpers — all unmutated.
- **Risk**: A branch-deleting mutant (`if (!token) return` → `if (true) return`) in `github-token.service.ts` ships green. Semgrep covers some patterns but doesn't replace mutation scoring on crypto round-trip or FK-cascade invariants.
- **Recommendation**: Expand scope incrementally — one critical service per sprint, starting with `src/lib/crypto/` and `github-token.service.ts`. Add `mutate:crypto` + `mutate:agent-execution` scripts with `continue-on-error: true` until baseline, then promote to blocking.

### F09-05: fast-check installed but used in 2 files
- **Priority**: P2
- **Observation**: `fast-check@4.7.0` pinned. Uses: `state-machines.property.test.ts` + `task-workflow.model.test.ts`. Obvious candidates use hand-rolled example tables: `session-event-validation.test.ts` (Zod), `terraform-parsers.test.ts` (HCL round-trip), `crypto.test.ts` (encrypt→decrypt identity), skill-id validator, `path-safety.test.ts`, `streams-client-parsing.test.ts`.
- **Risk**: Corner-case input classes (Unicode skill IDs, empty SSE chunks, CRLF/BOM HCL) stay unexplored.
- **Recommendation**: Convert 3 targets — crypto round-trip, Zod event validator, skill-ID validator — to properties. Goal: 6–8 property files by quarter end.

### F09-06: E2E has 20 files but no full task-lifecycle scenario
- **Priority**: P2
- **Observation**: Top-level E2E files: `smoke`, `agent-session`, `kanban-workflow`, `project-workflow`, `workflow`, `topology-subagent`. `kanban-workflow` covers column moves; `agent-session` covers session rendering — neither drives backlog→planning→approval→execution→verified end-to-end. Terraform compose, team mode (`launchSwarm`), workflow designer, webhook-triggered tasks, RBAC-token scope denial — no E2E.
- **Risk**: UI-only regressions (e.g. plan approval dialog dropping `phase: 'execute'`) ship without signal. Functional covers the service contract; E2E must cover the human contract.
- **Recommendation**: One E2E per user story: (1) task happy path backlog→verified, (2) plan reject→revise, (3) team mode spawn, (4) terraform compose, (5) webhook task creation, (6) RBAC token denial. Keep `skipIf(!serverRunning)`.

### F09-07: Integration shard balance is unverified
- **Priority**: P2
- **Observation**: `integration+functional` is 2-way sharded with no timing artefact and no `slowTestThreshold` reporter. 158 files, 26 heavy `route-*.test.ts` on 30 s timeouts; hash-based sharding is deterministic per filename so uneven allocation caps critical-path wall clock.
- **Risk**: Silent CI wall-clock creep as new files land unbalanced.
- **Recommendation**: `--reporter=junit` + per-file timing on the integration job, upload as artefact. Consider splitting into `integration-route` (forks, slow) and `integration-service` (threads, fast).

### F09-08: Coverage threshold exists but coverage tooling has been broken
- **Priority**: P2
- **Observation**: `vitest.config.ts` declares 50 % thresholds with v8. Prior readiness (2026-03-28) documented `BaseCoverageProvider` export missing in vitest 4.0.16. Current pins: vitest 4.1.4 + `@vitest/coverage-v8@4.1.4`, but CI never runs `test:coverage` — the upgrade is unverified.
- **Risk**: Threshold is theoretical; a delete that drops lines below 50 % fires no signal.
- **Recommendation**: Non-blocking `coverage` job running `bun vitest run --coverage --reporter=text-summary`, upload lcov.info. After two green weeks flip to hard gate.

### F09-09: No retry / no flake detection
- **Priority**: P2
- **Observation**: Zero `retry:` in configs, no quarantine list. `concurrency-*.test.ts` (3 files) + `transaction-{atomicity,cascade}.test.ts` test real timing races with no instrumentation to distinguish flake from bug.
- **Risk**: Flakes get `it.skip`'d (dead weight) or trained-around via `gh run rerun`, masking intermittent real bugs.
- **Recommendation**: Keep `retry: 0`. Nightly job runs `integration+functional` 5× sequentially, count non-deterministic failures into `FLAKY_TESTS.md`. >2 weeks unfixed → quarantine with linked issue.

### F09-10: Integration-cache regression (#161) had no post-mortem test
- **Priority**: P2
- **Observation**: `install` job caches on `hashFiles('**/bun.lock', '**/package.json')`; a stale hit against a lockfile mismatch was the #161 mode. No test asserts the test DB reflects current Drizzle schema; `--frozen-lockfile` catches structural mismatch, not logical drift in `agent-runner/bun.lock` (separate CLAUDE.md note).
- **Risk**: Same class of cache-mismatch recurs on a different keying vector.
- **Recommendation**: Micro-test asserting `drizzle-kit check` clean; bump `CACHE_VERSION` on migration-set changes via a PR-check script, not human habit.

### F09-11: Mock strategy mixed; no `vi.mock` lint guard
- **Priority**: P2
- **Observation**: Functional follows "real services + I/O mocks" well. Service unit + integration mix module `vi.mock`, DI fakes, direct imports. Nothing prevents `vi.mock('drizzle-orm')`, which silently defeats DB guarantees. Per-file `exclude` overrides in `vitest.config.ts` re-route `git-token-resolver.test.ts` / `container-bridge.test.ts` to the `db` project — correct but hidden.
- **Risk**: A DB-touching test lands in `tests/lib/`, mocks the client, ships green; production path uncovered.
- **Recommendation**: Document project rules in `tests/AGENTS.md`. Semgrep rule: `vi.mock('drizzle-orm'|'better-sqlite3'|'@/db/client')` = ERROR in integration/functional. Move excluded files into `tests/integration/`.

### F09-12: `vitest.ai-ui.config.ts` is not in CI
- **Priority**: P3
- **Observation**: Separate AI-UI config + `tests/ai-ui-tests/` not referenced in `ci.yml`. Manual via `bun scripts/run-ui-tests.ts`. No schedule.
- **Risk**: AI-UI regressions invisible; contributors reading CI assume coverage doesn't exist.
- **Recommendation**: Add `workflow_dispatch` + weekly cron, or document the local-only intent in `tests/AGENTS.md`.

### F09-13: Factories cover 7 entities; 5 obvious ones missing
- **Priority**: P3
- **Observation**: Factories exist for agent/agent-run/event-source/project/session/task/worktree. Tests needing RBAC roles, skills, workflows, templates, settings, team-memberships, sandbox configs build inline via `db.insert(...)`.
- **Risk**: Duplication across ~30 files; enables F09-03 by offering no service-aligned arrange helpers.
- **Recommendation**: Add `rbac-token`, `skill`, `workflow`, `template`, `settings` factories. Wire through `tests/factories/index.ts`.

## Cross-references
- Prior state: `specs/release_plan/01-test-suite-health.md`
- Frontend zero-tests: `specs/arch_review_april/08-frontend.md` F08-02
- Schema context: `specs/arch_review_april/02-data-layer.md`
- CLAUDE.md §"Functional Tests: Real Service Transitions", §"Preventing Regressions: Lessons Learned"
