# 09 — Testing (April 29 Review)

## Summary

Runner: Vitest 4.1.4, five projects (`unit` / `jsdom` / `db` / `integration` / `functional`), CI-sharded 3-way for `unit+jsdom+db` and 2-way for `integration+functional`. Stryker 9.6.1 mutates **13 globs** across state-machines, RBAC, crypto, and orchestration. Fast-check 4.7.0 still used in only 2 files.

Disk count (verified): **167 integration files** (52,587 lines, ~315 lines/file mean), **7 functional files**, 26 `route-*.test.ts`, **94 in-source `.test.ts` files**, 5 jsdom tests under `src/app/__tests__/` (404 lines total), and **20 E2E files** under `tests/e2e/` (Playwright via thin wrapper in `tests/e2e/setup.ts`).

What shifted since April 20 (PR #176, #178, #179):
- F09-01 schema-drift: `tests/integration/schema-drift-all-tables.test.ts:88` now iterates every `sqliteTable` export — but **19 of ~50 SQLite tables remain skipped** via `MISSING_IN_TEST_DB` (`schema-drift-all-tables.test.ts:30-50`) because the test-harness migration chain in `tests/helpers/database.ts` does not run them.
- F09-02 frontend zero-tests: 5 jsdom seed tests landed in `src/app/__tests__/` (`api-client-shape`, `connection-status-banner`, `error-boundary`, `session-dedupe`, `suspense-fallbacks`) plus `highlighted-code.test.tsx` under `src/app/components/ui/__tests__/`. Roughly 6 of ~328 frontend files.
- F09-03 functional tests: every raw `db.update/insert/delete` in `tests/functional/` now carries a `// TEST-SETUP:` annotation (14 sites observed) and two helpers (`enableSandboxDefaults`, `setTaskLastAgentStatus` in `state-guard-vulnerabilities.test.ts:82-109`) centralise the pattern. Three sites in `task-lifecycle-e2e.test.ts:537,322`, `task-lifecycle-advanced.test.ts:410,419`, and `prove-plan-approval-bugs.test.ts:332` are still raw `db.update(tasks)` writes.
- F09-04 Stryker: scope expanded from 6 to 13 mutate globs. New `mutate:security` script targets crypto + github-token. PR #179 promoted `agent-execution.service`, `plan-approval.service`, `task.service`, `stream-handler.ts` into `stryker.config.json:20-23` and added an `orchestration` matrix entry in `mutation-testing.yml:42-44` flagged `schedule_only: true`. **No published baseline score exists yet** — the orchestration job is `continue-on-error: true` (`mutation-testing.yml:79`) and runs only on cron, so PRs touching those files do not trigger a mutation gate.
- New gates landed: a dedicated `e2e-smoke` CI job (`ci.yml:159`) runs `tests/functional/smoke.test.ts` before integration; a `coverage` job (`ci.yml:173`) is wired but `continue-on-error: true`; thresholds raised from 50 % to 60/50/55/60 (`vitest.config.ts:178-183`). Coverage gate is still soft.

Material gaps: (a) Stryker break threshold is 75 but the orchestration scope ships unmeasured; (b) functional smoke covers backlog→in_progress only — no plan-ready or approval E2E in the gate; (c) integration shard split is by hash (no timing-balance heuristic); (d) `tests/integration/cli-monitor-service.test.ts:310,385` and 4 other files still use `setTimeout(resolve, …)` to wait for fire-and-forget persistence, which is an inherent flake source; (e) coverage job is still soft. No P0.

## Map

| Layer | Files | Lines | Purpose |
|-------|-------|-------|---------|
| Config | `vitest.config.ts`, `vitest.e2e.config.ts`, `vitest.ai-ui.config.ts`, `stryker.config.json` | 187 / 26 / 24 / 58 | Five-project split; e2e `maxWorkers: 1`; ai-ui `maxWorkers: 1`, 120 s |
| CI | `.github/workflows/ci.yml`, `mutation-testing.yml` | 222 / 99 | 3-shard main; 2-shard integration; `e2e-smoke` job; `coverage` job (soft); weekly Stryker, with `orchestration` schedule-only |
| Schema drift | `tests/integration/schema-drift-all-tables.test.ts` (auto-gen), `agents-schema-drift.test.ts`, `session-schema-drift.test.ts`, `scripts/check-schema-drift.ts` | 178 + 60 + 60 + 360 | Generator skips 19 tables in test DB |
| Factories | `tests/factories/*.factory.ts` | 7 entities | agent, agent-run, event-source, project, session, task, worktree — still **no** rbac-token, skill, workflow, template, settings, team-member, sandbox-config |
| Unit | `tests/lib/**`, `tests/mocks/**`, `tests/routes/**`, `src/**/__tests__/**` | 94 in-source tests | Threads pool |
| jsdom | `tests/components/**`, `tests/hooks/**`, `**/*.test.tsx` | 6 src/app/* tests | Seeds landed; ~6 of 328 frontend files |
| db | `tests/services/**`, `tests/api/**`, `tests/server/**`, `tests/db/**` + 4 carve-outs | Forks (SQLite PRAGMA isolation) |
| Integration | `tests/integration/**` | 167 files / 52,587 lines | Hono route + service + SQLite |
| Functional | `tests/functional/**` | 7 files / ~6,500 lines | Real-service lifecycle |
| E2E | `tests/e2e/**` (vitest config, NOT in CI except smoke) + `K8S_E2E=true` opt-in | 20 files | `skipIf(!serverRunning)` — runs locally only |
| AI-UI | `tests/ai-ui-tests/**` (5 .sh files, not .ts) | 5 shell scripts | Local-only, never in CI |
| Property | 2 files in `src/lib/state-machines/__tests__/` | 4 describe blocks | Only fast-check users in repo |
| Mutation | `mutate:state-machines`, `mutate:rbac`, `mutate:security`, `mutate:incremental` | 13 globs | Only state-machines + RBAC paths gate PRs; orchestration cron-only |

## What's working

- **Schema-drift generator**: `tests/integration/schema-drift-all-tables.test.ts:88-100` reflects over `getTableColumns(value as SQLiteTable)` for every export — adding a new table automatically gets coverage in the runtime path (subject to F09-01).
- **Functional contract**: 4 of 7 functional files keep all transitions through real services. `task-lifecycle-e2e.test.ts:106-336` drives backlog → in_progress → plan_ready → approve → execute → complete → verify with only Claude SDK / sandbox / git / DurableStreams mocked.
- **Helper centralisation**: `state-guard-vulnerabilities.test.ts:82-109` exposes `enableSandboxDefaults` and `setTaskLastAgentStatus`. The pattern enables the rule "raw write needs a justification comment" because every site now has one place to look.
- **TEST-SETUP annotations**: 14 explicit `// TEST-SETUP:` comments now justify each raw `db.update/insert/delete` in `tests/functional/` (verified in 7 files). The April review's recommendation landed almost verbatim.
- **CI early-fail wedge**: `ci.yml:60-61` fast-fails `lint-and-typecheck` on `bun run scripts/check-schema-drift.ts` before any test shard boots; `e2e-smoke` runs the smoke functional before the slow integration jobs.
- **Stryker scope expansion**: PR #179 added `agent-execution.service.ts` (1 of the 4 critical orchestration files) to `stryker.config.json:20-23` and to a `mutation-testing.yml:42-44` matrix entry. The wiring is correct; the gate is missing (see F09-04).
- **Coverage thresholds tightened**: `vitest.config.ts:178-183` 50/50/50/50 → 60/50/55/60, and a baseline comment dated 2026-04-21 documents the actual numbers. The gate is still soft, but the trajectory is right.
- **No `.only` leaks**: `grep -E "(it|test|describe)\\.only\\(" tests/ src/` returns 0.
- **Functional bug-proof tests**: `prove-plan-approval-bugs.test.ts` and `prove-task-service-bugs.test.ts` document each verdict (FIXED/NOT A BUG/BUG EXISTS) inline — these read like a regression-prevention catalogue and should not be lost.

## Findings

### F09-21: Schema-drift generator skips 19 of ~50 tables in the test DB

- **Priority**: P1
- **Effort**: M
- **Observation**: `tests/integration/schema-drift-all-tables.test.ts:30-50` declares `MISSING_IN_TEST_DB` with 19 entries — `workflows`, `plan_sessions`, `terraform_modules`, `terraform_registries`, `sandbox_instances`, `sandbox_tmux_sessions`, `schedule_executions`, `memory_insights`, `memory_messages`, `dream_sessions`, `skill_executions`, `skill_metrics`, `skill_suggestions`, `users`, `user_sessions`, `team_invitations`, `team_members`, `team_project_folders`, `cli_sessions`. The generator's per-test block returns early for these (`schema-drift-all-tables.test.ts:141,160`). Looking at `tests/helpers/database.ts:99-234`, the test-harness migration chain only runs `MIGRATION_SQL` + `RBAC_MIGRATION_SQL` + `EVENT_SYSTEM_MIGRATION_SQL` + `PROJECT_FOLDERS_MIGRATION_SQL` + a handful of inline `ALTER TABLE` statements — so half the production schema simply never lands in the in-memory test DB.
- **Risk**: Schema drift on `sandbox_instances`, `cli_sessions`, `plan_sessions`, `skill_executions`, `team_members`, `users` ships green. The April review claimed F09-01 was resolved; in practice the resolution covered only the tables the harness happens to migrate, and the skip list grows silently with each new module.
- **Recommendation**: Move every production migration SQL block into `tests/helpers/database.ts` so the harness mirrors the runtime chain. As an interim, add a single CI test that asserts `MISSING_IN_TEST_DB.size === 0` once the harness gains parity. Cross-link with `02-data-layer.md` (F02 follow-up).

### F09-22: Stryker `orchestration` scope ships unmeasured (PR #179 wired the matrix but not the gate)

- **Priority**: P1
- **Effort**: S
- **Observation**: `stryker.config.json:20-23` lists `agent-execution.service.ts`, `plan-approval.service.ts`, `task.service.ts`, `stream-handler.ts`. `mutation-testing.yml:36-44` adds an `orchestration` matrix entry covering those exact files but flagged `schedule_only: true` (`mutation-testing.yml:44`); the run step is `continue-on-error: true` (`mutation-testing.yml:79`); the matrix's `schedule_only` skip means PRs touching those files trigger nothing (`mutation-testing.yml:81-83`). The PR-level `paths:` filter (`mutation-testing.yml:7-14`) does not include any orchestration paths, so a `task.service.ts` change has no Stryker signal at all on the PR. The April review's resolution documented this as "follow-up to set baseline" — that follow-up has not landed.
- **Risk**: A branch-deleting mutant in `task.service.ts.moveColumn()` (e.g. `if (lastAgentStatus === 'planning')` → `if (true)`) ships green on PR. The mutant catalogue F09-04 cited (`if (!token) return` → `if (true) return`) is now inside the configured-but-ungated scope.
- **Recommendation**:
  1. Run `npm run mutate:incremental -- --mutate src/services/task.service.ts` once on `main`, commit the resulting `reports/mutation/stryker-incremental.json` snapshot, and push thresholds for orchestration to `low: 60, break: 50` initially.
  2. Promote the orchestration matrix entry to PR-time by adding `src/services/task.service.ts`, `src/services/agent/agent-execution.service.ts`, `src/services/container-agent/plan-approval.service.ts`, `src/lib/agents/stream-handler.ts` to the `paths:` filter (`mutation-testing.yml:7-14`).
  3. Drop `continue-on-error: true` (`mutation-testing.yml:79`) for state-machines and rbac (already fully covered) and keep it for orchestration until the baseline stabilises.

### F09-23: Three raw `db.update(tasks)` writes in functional tests still bypass real services without `// TEST-SETUP:` justification

- **Priority**: P1
- **Effort**: XS
- **Observation**: PR #176 added `// TEST-SETUP:` comments at most violations, but three remaining sites are unannotated raw writes that simulate state transitions:
  - `tests/functional/task-lifecycle-e2e.test.ts:537-540` — `db.update(tasks).set({ plan: 'Refactoring plan text', planOptions: { sdkSessionId: 'sdk-turns' } })` — comment says "simulating handlePlanReady → approve → executing"; this is exactly the violation CLAUDE.md §"Functional Tests: Real Service Transitions" forbids.
  - `tests/functional/task-lifecycle-e2e.test.ts:322-325, 593-596` — re-link worktree/branch after `updateTaskOnAgentComplete()` cleared them; defensible (post-completion fixture re-link) but undocumented.
  - `tests/functional/task-lifecycle-advanced.test.ts:419-422` — re-link worktree/branch; same situation.
- **Risk**: The contract-stating CI grep rule recommended in F09-03 was not added. New PRs can keep adding raw transitions without the comment, exactly the regression mode the original finding warned about.
- **Recommendation**:
  1. Replace `task-lifecycle-e2e.test.ts:537-540` with `await planService.handlePlanReady(taskId, sessionId, codespace.id, { plan: 'Refactoring plan text', turnCount: 1, sdkSessionId: 'sdk-turns' }); await planService.approvePlan(taskId);` — that's the real-service path being simulated.
  2. Add the missing `// TEST-SETUP:` comments at the three re-link sites.
  3. Add to `.semgrep/rules/test-discipline.yml` (or a new rule file): `pattern: 'await db.$METHOD(tasks).set(...)'` with `paths.include: tests/functional/`, `severity: ERROR`, `message: "Raw db.update on tasks in functional/ — must have // TEST-SETUP: justification or route through service"`. The existing semgrep job (`ci.yml:118-141`) excludes `tests/**` so add a separate `semgrep-test-discipline` job, scoped to `tests/`.

### F09-24: Functional `smoke.test.ts` is the CI gate but does not test plan approval

- **Priority**: P2
- **Effort**: S
- **Observation**: `ci.yml:159-171` declares `e2e-smoke` running `tests/functional/smoke.test.ts` before the integration shard. `tests/functional/smoke.test.ts:42-117` covers exactly one transition: `taskService.create()` → `taskService.moveColumn(taskId, 'in_progress')` → assert prompt content. There's no plan-ready, no approve, no agent-completion, no `verified`. The richer `task-lifecycle-e2e.test.ts` runs in the slower 30 min `integration-test` shard alongside 167 other files.
- **Risk**: A regression in `PlanApprovalService.approvePlan()` (e.g. `phase: 'execute'` dropped, `sdkSessionId` not propagated) only fails after ~20 min of integration shards rather than the 1–2 min smoke gate. Reviewers wait, then context-switch.
- **Recommendation**: Add a second smoke test at `tests/functional/smoke.test.ts` (or a sibling `smoke-plan-approval.test.ts`) that drives a complete `handlePlanReady → approvePlan → updateTaskOnAgentComplete → approve` cycle against mocks. Aim for sub-30 s. Include in the `e2e-smoke` job (`ci.yml:171`).

### F09-25: Coverage gate still soft three weeks after thresholds raised

- **Priority**: P2
- **Effort**: XS
- **Observation**: `ci.yml:173-196` runs `bun vitest run --project unit --project jsdom --project db --coverage` but `continue-on-error: true` (`ci.yml:179`). `vitest.config.ts:178-183` sets thresholds 60/50/55/60. The April review's F09-08 said "after two green weeks flip to hard gate" — six weeks later the flag is still on. The dated comment on `vitest.config.ts:174-176` claims the actual numbers (`statements 68.19%, branches 59.44%, functions 62.96%, lines 68.70%`) all clear the floor with 5+ pp of headroom.
- **Risk**: Threshold is theoretical; a delete that drops coverage below 60 % surfaces only as a soft warning that nobody reads. The `coverage` artifact retains for 14 days but no PR comment / annotation surfaces the result.
- **Recommendation**:
  1. Drop `continue-on-error: true` (`ci.yml:179`).
  2. Add `--reporter=text-summary` and grep-test the line `Statements   :` against ≥60% in a follow-up step — produces a clear PR check name. Alternative: `vitest-action` or `davelosert/vitest-coverage-report-action` for inline annotations.

### F09-26: Integration shard balance is hash-based, no timing artefact

- **Priority**: P2
- **Effort**: S
- **Observation**: 167 files / 52,587 lines, sharded `--shard=1/2` and `2/2` (`ci.yml:213-214`). Hash-based sharding is deterministic per filename. Naive line-count split (alphabetic name): shard 1 ≈ 26,697 lines, shard 2 ≈ 25,890 lines (verified). Largest single file `container-agent-services.test.ts` (1,740 lines) lives next to `container-agent-service.test.ts` (singular, 510 lines) — both contain heavy mocking and DB assertions. There is no `slowTestThreshold`, no `--reporter=junit`, no per-file timing artefact uploaded.
- **Risk**: Wall-clock creep is invisible. As new heavy `route-*` files land they may all hash to one shard, and the team will discover it as a 32-min vs 16-min split rather than fix it preemptively. PR #179 increased coverage of integration tests significantly without rebalancing.
- **Recommendation**:
  1. Add `--reporter=default --reporter=junit --outputFile.junit=test-results/integration-{shard-id}.xml` to `ci.yml:214`.
  2. Upload as artefact (15-day retention).
  3. Add a one-shot `scripts/measure-shard-balance.ts` that parses junit XML and prints per-shard totals. Run it once a sprint to decide whether to add a third shard or split route tests into a separate job.

### F09-27: `tests/integration/cli-monitor-service.test.ts` uses `setTimeout(150ms)` to wait for fire-and-forget persistence — flake hazard

- **Priority**: P2
- **Effort**: S
- **Observation**: `cli-monitor-service.test.ts:310` and `:385` use `await new Promise((resolve) => setTimeout(resolve, 100))` and `(resolve, 150)` to wait for `service.ingestSessions()` to flush to DB. `agent-execution-service.test.ts:591` uses `setTimeout(r, 10)` for the same reason. `agent-pause-resume-queue.test.ts:32` uses `setTimeout(resolve, 10)` to ensure `updatedAt` differs. `prove-session-worktree-bugs.test.ts:248` uses `setTimeout(resolve, 10)` to ensure `closedAt` timestamps differ. None of these are wrapped in a poll-until-condition helper.
- **Risk**: On a slow CI runner under contention, 100 ms is sometimes not enough — the test asserts on the post-write state and gets the pre-write empty state. The existing CI shard timeout is generous (20 min for unit, 30 min for integration) so flakes don't surface as hard failures, they surface as `Expected 5, received 0` then pass on rerun. The April review's F09-09 recommended a quarantine list; that hasn't landed.
- **Recommendation**:
  1. Add a `tests/helpers/async.ts` `waitForCondition(predicate, { timeoutMs: 2000, intervalMs: 25 })` helper (already exists at `tests/helpers/async.ts` per `ls` — verify and use it).
  2. Replace the 4 sleep sites with `await waitForCondition(() => db.select().from(cliSessions).all().length > 0)` style.
  3. For timestamp-difference cases, use `vi.setSystemTime()` or compare `>=` instead of `>`.

### F09-28: Five obvious property-test candidates remain example-table tests; fast-check usage hasn't grown

- **Priority**: P2
- **Effort**: M
- **Observation**: `grep -rE "import.*'fast-check'"` returns 2 files, both in `src/lib/state-machines/__tests__/`. Three rich candidates ship as hand-rolled example-tables:
  - `tests/lib/crypto/crypto.test.ts` — encrypt → decrypt round-trip is the canonical property test, currently a fixed-input table.
  - `tests/integration/terraform-parsers.test.ts` (651 lines) — HCL ↔ JSON round-trip exercised with a fixed corpus.
  - `tests/integration/session-event-validation.test.ts` — Zod validator with a hand-rolled example list.
  - `src/lib/sandbox/__tests__/skill-injector.test.ts` — skill-id validator regex; fuzz with random unicode would catch the edge cases the regex was hardened against.
  - `src/services/__tests__/path-safety.test.ts` (path traversal) — fuzz across `..`, NULs, mixed slashes, BOM, RTL marks.
- **Risk**: The corpus tests catch the bugs the author thought of. Crypto round-trip identity, HCL CRLF/BOM tolerance, skill-id Unicode handling — all stay unexplored. The April review recommended converting 3 targets; none have been.
- **Recommendation**: One PR per quarter target. Start with `crypto.test.ts` (lowest risk, highest signal): `fc.assert(fc.property(fc.string(), (plain) => decrypt(encrypt(plain)) === plain))`. Add fast-check to `tests/AGENTS.md` as the preferred style for parsers and validators.

### F09-29: `tests/ai-ui-tests/` is `.sh` files, not `.ts`, and has zero CI integration

- **Priority**: P2
- **Effort**: S
- **Observation**: `vitest.ai-ui.config.ts:8` declares `include: ['tests/ai-ui-tests/**/*.test.ts']`. Listing the directory: `navigation.sh`, `projects.sh`, `run-all.sh`, `settings.sh`, `smoke.sh` (5 shell scripts dated 2026-01-18). There are zero `.test.ts` files. The vitest config matches nothing, and `package.json` `test:ui` runs `bun scripts/run-ui-tests.ts`, not the vitest config. CI references neither.
- **Risk**: A vitest config that matches no files is dead infrastructure. New contributors reading `vitest.ai-ui.config.ts` think the AI-UI suite is wired and will not write tests there.
- **Recommendation**:
  1. Delete `vitest.ai-ui.config.ts` if shell-script approach is intentional.
  2. Or: convert the shell scripts to `.test.ts` driving `agent-browser` (the package is already installed at 0.26.0) and add a weekly cron job in `ci.yml`. The April review's F09-12 recommendation matches.

### F09-30: 9 new factories needed; team-members and skill factories block writing the team-mode functional test

- **Priority**: P3
- **Effort**: M
- **Observation**: `tests/factories/index.ts` exports 7 factories (agent, agent-run, event-source, project, session, task, worktree). Tests needing RBAC roles, skills, workflows, templates, settings, team-members, codespace-members, sandbox-configs build inline via `db.insert(...)`. `state-guard-vulnerabilities.test.ts:82-87` had to invent `enableSandboxDefaults` because no `settings` factory exists. `prove-task-service-bugs.test.ts:53-65` does an upsert dance for the same reason. `route-teams.test.ts` (638 lines) and `cross-service-rbac-team.test.ts` (high-volume RBAC) have to construct teams inline. There is no functional test for team-mode swarm because the lifecycle requires inline team + member + RBAC token + skill — too much arrangement to write without factories.
- **Risk**: Duplication across ~30 files; enables F09-23 by offering no service-aligned arrange helpers. New developers copy-paste the inline DB writes from the nearest test, drifting from the service contract.
- **Recommendation**: Add factories: `tests/factories/{rbac-token,skill,workflow,template,settings,team-member,codespace-member,sandbox-config,user}.factory.ts`. Wire through `tests/factories/index.ts`. Each factory is ≤30 lines. Goal: get the inline `db.insert(settings)` count to zero outside the `enableSandboxDefaults` helper.

### F09-31: E2E suite is 20 files of Playwright tests but only the 72-line `smoke.test.ts` runs in CI (and only as a functional test against the test DB, not against the real server)

- **Priority**: P2
- **Effort**: L
- **Observation**: `tests/e2e/setup.ts:6-7` imports playwright (`Browser, Page` from `playwright`). `tests/e2e/agent-session.test.ts:5` checks `serverRunning ? describe : describe.skip`. `tests/e2e/k8s/agent-sandbox-e2e.test.ts:1259` is the largest — gated on `K8S_E2E=true`. None of `vitest.e2e.config.ts` or `package.json:"test:e2e"` is referenced from any GitHub Actions YAML (verified: `grep -nE "vitest.e2e|test:e2e" .github/workflows/*.yml` returns 0). The `e2e-smoke` CI job (`ci.yml:159-171`) runs `tests/functional/smoke.test.ts`, **not** `tests/e2e/smoke.test.ts`.
- **Risk**: ~3,300 lines of UI-driven E2E tests are write-only documentation. Visual regressions, dnd-kit interactions, plan approval modal, terraform composer, kanban drag handling — all rely on humans running them locally. Same recommendation as April review F09-06; same lack of progress.
- **Recommendation**:
  1. Stand up a Vite preview server in CI (`bun run build && bun run preview &`) and run `bun vitest --config vitest.e2e.config.ts` against it. Set `maxWorkers: 1` (already configured), gate on a 12-min timeout.
  2. Add as a separate `e2e-real` GitHub job, blocking only `kanban-workflow.test.ts`, `agent-session.test.ts`, `smoke.test.ts` initially. Promote others as they stabilise.
  3. Until that lands, document at the top of `tests/e2e/setup.ts` that the suite is local-only and removable from CI consideration.

### F09-32: `vi.mock('drizzle-orm', …)` lives in two integration-adjacent tests with no Semgrep guard

- **Priority**: P2
- **Effort**: S
- **Observation**:
  - `src/server/routes/__tests__/sandbox-nomad-validation.test.ts:286` — `vi.mock('drizzle-orm', () => ({...}))` together with mocking `db/schema/index.js`, `lib/crypto/server-encryption.js`, and `@agentpane/nomad-sandbox-sdk`. This file is in `src/**/__tests__/**` so it lands in the `unit` project (`vitest.config.ts:51-52`). It bypasses Drizzle entirely.
  - `src/lib/sandbox/__tests__/git-token-resolver.test.ts:13` — same `vi.mock('drizzle-orm', …)` pattern. This file is explicitly carved out into the `db` project (`vitest.config.ts:113`) **but the carve-out exists precisely because the original placement was wrong**, and the mock is still active in the `db` project.
  - The April review's F09-11 recommended a Semgrep rule. PR #179 expanded Semgrep aggressively but added no rule against `vi.mock('drizzle-orm'|'better-sqlite3'|'@/db/client')` in tests under integration/functional folders.
- **Risk**: A test that mocks Drizzle stops exercising real query construction — the very layer the schema-drift tests (F09-21) are designed to protect. CLAUDE.md §"Functional Tests: Real Service Transitions" says only Claude SDK / sandbox / git / streams may be mocked; drizzle-orm is not on that list.
- **Recommendation**:
  1. Add `.semgrep/rules/test-discipline.yml` rule banning `vi.mock` of `drizzle-orm`, `better-sqlite3`, `postgres`, `@/db/client`, `@/db/schema/sqlite`, `@/db/schema/postgres` in any file under `tests/integration/`, `tests/functional/`, `tests/services/`. Severity ERROR.
  2. Audit `git-token-resolver.test.ts` — if the test only validates pure parsing logic, move it to `tests/lib/sandbox/` and remove the `db/client` carve-out from `vitest.config.ts:60,113`.

### F09-33: No retry config, no flake quarantine, and 5 `setTimeout` flake-triggers landed since the April review

- **Priority**: P3
- **Effort**: S
- **Observation**: `vitest.config.ts` has no `retry:` config. `package.json` has no `:retry` script variant. The April review's F09-09 recommendation to maintain a `FLAKY_TESTS.md` and a nightly 5x-rerun job has not landed. New `setTimeout` waits added since (cli-monitor `:310,385`, agent-execution `:591`) compound the original 4-file flake surface from April. Per the user's CLAUDE feedback ("commit_frequently"), a flake quarantine doc is exactly the kind of small-loop document that should live in the repo.
- **Risk**: Flakes get rerun-ed to green via `gh run rerun` (the team's habit), masking intermittent real bugs. The team has no signal on which tests are flaky vs. broken because there's no count.
- **Recommendation**:
  1. Keep `retry: 0` (correct).
  2. Add `.github/workflows/flake-detector.yml` running `--project integration --project functional` 3 times sequentially weekly; collect failure tests into a generated `FLAKY_TESTS.md`.
  3. After 2 weeks of data, gate the CI on the resulting list — failures of unflaky tests are blocking; failures of known-flaky tests post a comment with the issue link.

## Cross-references

- Prior review (April 20): `specs/arch_review_april/09-testing.md` — F09-01 through F09-13.
- Schema drift: this review F09-21 → `02-data-layer.md` follow-up needed.
- Frontend tests: `08-frontend.md` (April 20) F08-02 closed by 5 new src/app/__tests__ files; broader coverage is the next review's problem.
- Mutation testing baseline: PR #179 commit `a5ac9de4`. The orchestration scope landed but never ran on `main` to produce a baseline.
- Functional rules: `CLAUDE.md` §"Functional Tests: Real Service Transitions" — the contract is correct, the enforcement is partially absent (F09-23, F09-32).
- User feedback (memory): `feedback_drizzle_only.md` aligns with F09-32.
