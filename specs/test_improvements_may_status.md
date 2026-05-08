# Functional Test Improvements — Remediation Status

Updated: 2026-05-08

## Completed In This Pass

| Spec item | Evidence |
| --- | --- |
| Phase 1.1 — derive `clearTestDatabase()` cleanup from schema | `tests/helpers/database.ts` uses `Object.values(schema).filter(isTable)` plus schema table names for SQLite and Postgres cleanup. |
| Phase 1.2 — functional test boundary policy | `tests/functional/AGENTS.md` documents allowed mock boundaries, forbidden state-transition shortcuts, fixture-write exceptions, and concurrency caveats. |
| Phase 1.3 — central mock helpers and shared stream helper | `tests/helpers/mocks.ts` exports `createInMemoryStreams`, `createMockWorktreeService`, `createMockContainerAgent`, and `createMockWorktreeInit`; functional-local `createMockStreams()` helpers were removed. |
| Phase 1.4 — reconcile test `ANTHROPIC_API_KEY` | `tests/setup.ts` reads `TEST_ENV.ANTHROPIC_API_KEY` from `tests/helpers/env.ts`. |
| Phase 1.5 — factory barrel export | `tests/factories/index.ts` re-exports `container-agent.factory.ts`. |
| Phase 1.6 — env mutation cleanup | `tests/integration/agent-oauth-refresh.test.ts` and `tests/integration/middleware-auth.test.ts` use `vi.stubEnv` instead of raw `process.env` mutation/deletion. |
| Phase 1.7 — critical false-pass cleanup | C-1, C-3, C-4, C-5, and C-6 assertions were tightened; C-2 was renamed to explicitly document current behavior. |
| P0-5 — skill chaining | `tests/functional/prove-plan-approval-bugs.test.ts` covers execution-skill swap and rollback. |
| P0-10 — concurrent approve double-click | `tests/functional/prove-plan-approval-bugs.test.ts` verifies exactly one `startAgentFn` call. |
| P0-11 — stream prefix routing | `tests/functional/stream-id-prefix-routing.test.ts` covers plan/sandbox stream separation and bare-session mismatch rejection. |
| Phase 2.2 — module-level mock reset | `host-mode-error-recovery.test.ts` and `tool-deny-hook.test.ts` reset implementations, not just call history. |
| Phase 2.7 — relay teardown | `tests/integration/event-outbox-relay.test.ts` stops the relay in `afterEach`. |
| Phase 2.8 — agent execution teardown | `tests/services/agent-execution.service.test.ts` already calls `service.stopAll()` in `afterEach`; verified. |
| Phase 2.9 — global sandbox-state cleanup | `SandboxStateManager.disposeAll()` is called from `tests/setup.ts` after each test. |
| Phase 2.1 — reduce host-mode service mocks | `host-mode-error-recovery.test.ts` now wires real `WorktreeService`, `SessionService`, and `TaskService`; assertions check persisted `session_events` instead of mock publish calls. |
| Phase 2.3 — Postgres-backed concurrency harness | `tests/integration/concurrency-pg/plan-approval-pg.test.ts` adds semantic approve/reject and double-approve concurrency assertions for real Postgres transactions; the suite skips unless `DB_MODE=postgres` and `DATABASE_URL` are present. |
| Phase 2.5 — FK/cascade coverage moved to integration | `tests/integration/codespace-cascade.test.ts` covers codespace FK cascade behavior and documents session-event stream independence. |
| Phase 2.6 — pure DB-shape functional case deleted | `tests/functional/prove-session-worktree-bugs.test.ts` now keeps the real `WorktreeService.merge()` failure-status test and drops the direct DB shape probe. |
| Phase 2.4 — reduce direct task-state simulations | Merge-approval setup in `prove-task-service-bugs.test.ts` and `task-lifecycle-advanced.test.ts` now drives `lastAgentStatus='completed'` through `updateTaskOnAgentComplete()`; remaining direct updates are documented guard/race preconditions with no narrow service setup path. |
| Phase 3.1 — stream simulation v2 | `tests/helpers/streams/` exports `sdkStream()` and `agentRunnerStream()`; bridge proof tests now use the agent-runner builder instead of local JSON-line helpers. |
| Phase 3.4 — missing factories | Added settings, sandbox-instance, plan-session/pending-plan, user, team/RBAC, and session-event factories; the factory barrel exports them. |
| Phase 3.5 — factory smells | `project.factory.ts` uses parameterized SQL for legacy `projects`; event source/subscription factories require real FK IDs; agent factory status/type derives from schema; task approval/rejection helpers are explicit. |
| Phase 3.6 and 3.7 — clock/wait helpers | `tests/helpers/clock.ts` and `tests/helpers/wait.ts` provide reusable frozen-clock and polling/event helpers. |
| P0-1/P0-2 — cancel paths | `tests/functional/cancel-paths.test.ts` covers planning and execution cancellation through real `ContainerExecService.stopAgent()`. |
| P0-3/P0-4 — agent review mode | `tests/functional/agent-review-mode.test.ts` covers auto-approval and SDK-failure fallback through real `AgentReviewService`. |
| P0-6 — host-mode happy path | `host-mode-error-recovery.test.ts` now covers start → planning → resume → execution completion with real host-mode services. |
| P0-7 — bridge double-fire | `task-lifecycle-e2e.test.ts` covers two rapid `agent:plan_ready` events through the real bridge and PlanApprovalService idempotency. |
| P0-8 — planning-state error guard | `state-guard-vulnerabilities.test.ts` covers `updateTaskOnAgentError` preserving an already stored plan. |
| P0-9 — plan revision loop | `tests/functional/plan-revision-loop.test.ts` covers rejection feedback flowing into the next planning prompt and sdkSessionId continuity into execution. |
| Phase 4 named P0 files | Added `cancel-paths.test.ts`, `agent-review-mode.test.ts`, `skill-chaining.test.ts`, and `plan-revision-loop.test.ts`; `stream-id-prefix-routing.test.ts` already covers P0-11. |
| P1 — empty/malformed plan | `tests/integration/plan-approval-flow.test.ts` now rejects empty or malformed `ExitPlanMode` plan payloads before persistence and marks the real task error path. |
| P1 — sandbox provider/id cascade | `tests/integration/sandbox-provider-and-id-cascade.test.ts` covers per-codespace sandbox lookup isolation and provider lookup failure falling back to a fresh SDK session. |
| P1 — running task cleanup | `tests/integration/task-update-delete.test.ts` now proves `TaskService.delete()` and `TaskService.cancelTask()` stop container-runtime and host-mode agents before deleting/cancelling an in-progress task. |
| P1 — agent queue dequeue and isolation | `tests/integration/agent-queue-service.test.ts` now rejects cross-codespace queue requests without mutation and covers simultaneous dequeues claiming a queued task at most once. |
| P1 — host-mode plan approval parity | `tests/integration/task-plan-approval.test.ts` now proves host-mode `approvePlan()` rejects tasks without a persisted pending plan instead of blindly resuming an agent. |
| P1 — sandbox lifecycle lookup parity | `tests/integration/sandbox-unique-lifecycle.test.ts` now proves `SandboxService.getByCodespaceId()` prefers the active sandbox row when older stopped/error rows coexist under the partial unique-index lifecycle. |
| Phase 5.2 — PG-backed concurrency harness | Covered by `tests/integration/concurrency-pg/plan-approval-pg.test.ts`; local default runs skip it unless the Postgres env is configured. |
| Phase 5.3 — property-test callouts | Added fast-check coverage for stream-id prefix/routing invariants, `AgentReviewService` prompt-boundary sanitization, concurrent `TaskService.create()` position assignment, approve/reject/cancel ordering around pending plans, and task workflow state-machine parity with the `TaskService` transition matrix. |
| Phase 5.1 — database helper split and production runner adoption | `tests/helpers/database/cleanup.ts`, `connection.ts`, `schema-metadata.ts`, and `seed.ts` now own focused helper responsibilities while `tests/helpers/database.ts` remains the stable public import path and initializes SQLite through the production `runMigrations(testSqlite, MIGRATIONS)` path. |
| Phase 5.4 — SQLite FK enforcement | `tests/integration/database-helper-fk.test.ts` proves SQLite foreign keys are enabled immediately after `setupTestDatabase()`; FK-on fallout was fixed in `plan-recovery.test.ts` plus `scheduler-event-pipeline.test.ts` fixtures. |
| Runtime migration drift fixes | Added v41 `codespace-era-table-rebuilds` for current Drizzle writes without legacy `project_id` columns and v42 `sqlite-schema-parity-catchup` for remaining Drizzle/runtime SQLite drift; `migration-ordering.test.ts` now covers codespace-era writes through the production runner. |

## Still Roadmap Work

- Phase 3.2 and 3.3: lifecycle harness/proof-point migration is intentionally superseded by the newer direction to prefer fewer mock abstractions and more integration coverage.
- Phase 4: remaining P1 scenario files: deeper sandbox provisioning failure paths beyond active-row lookup and retry safety.
- Integration-first follow-up: move suitable plan approval/concurrency assertions into integration or PG-backed suites rather than adding more functional mocks.
- Phase 5.4 remaining follow-up: audit any explicit test-local `PRAGMA foreign_keys = OFF` blocks and legacy schema table rewrites; FK enforcement is now on by default after setup.

## Validation

- `bunx vitest run --project functional` passed: 15 files, 103 tests.
- `bunx biome check src/services/agent/agent-queue.service.ts src/services/container-agent/sandbox-state.ts src/services/container-agent/plan-approval.service.ts src/services/container-agent/agent-review.service.ts src/services/container-agent/__tests__/agent-review-sanitize.property.test.ts src/services/task.service.ts tests specs` passed: 451 files.
- `bunx vitest run --project integration` passed: 186 files passed, 3 skipped; 2362 tests passed, 11 skipped.
- `bunx vitest run --project unit src/lib/state-machines/__tests__/state-machines.property.test.ts src/lib/state-machines/__tests__/task-workflow.model.test.ts src/lib/state-machines/__tests__/state-machines.test.ts` passed: 3 files, 256 tests.
- `bunx biome check tests/helpers/database.ts tests/helpers/database/cleanup.ts tests/helpers/database/schema-metadata.ts tests/helpers/database/seed.ts tests/integration/database-helper-fk.test.ts tests/integration/plan-recovery.test.ts tests/integration/scheduler-event-pipeline.test.ts specs/test_improvements_may_status.md` passed: 7 files.
- `bunx vitest run --project integration tests/integration/database-helper-fk.test.ts tests/integration/plan-recovery.test.ts tests/integration/scheduler-event-pipeline.test.ts` passed: 3 files, 14 tests.
- `bunx vitest run --project integration tests/integration/database-helper-fk.test.ts tests/integration/codespace-cascade.test.ts tests/integration/codespace-cascade-delete.test.ts tests/integration/codespace-delete-api-tokens.test.ts` passed: 4 files, 10 tests.
- `bunx vitest run --project unit src/lib/bootstrap/__tests__/migration-ordering.test.ts` passed: 1 file, 7 tests.
- `bunx vitest run --project integration tests/integration/schema-drift-all-tables.test.ts tests/integration/database-helper-fk.test.ts tests/integration/api-keys-schema-drift.test.ts tests/integration/codespace-cascade.test.ts tests/integration/codespace-cascade-delete.test.ts tests/integration/codespace-delete-api-tokens.test.ts` passed: 6 files, 67 tests.
- `bunx vitest run --project integration tests/integration/concurrency-pg/plan-approval-pg.test.ts` passed in default local mode: 1 file skipped, 2 tests skipped.
- `bunx vitest run --project integration tests/integration/codespace-cascade.test.ts` passed: 1 file, 3 tests.
- `bunx vitest run --project integration tests/integration/plan-approval-flow.test.ts` passed: 1 file, 26 tests.
- `bunx vitest run --project integration tests/integration/sandbox-provider-and-id-cascade.test.ts` passed: 1 file, 2 tests.
- `bunx vitest run --project integration tests/integration/sandbox-unique-lifecycle.test.ts tests/integration/sandbox-service.test.ts` passed: 2 files, 26 tests.
- `bunx vitest run --project integration tests/integration/task-plan-approval.test.ts` passed: 1 file, 9 tests.
- `bunx vitest run --project integration tests/integration/task-update-delete.test.ts` passed: 1 file, 10 tests.
- `bunx vitest run --project integration tests/integration/agent-queue-service.test.ts` passed: 1 file, 24 tests.
- `bunx vitest run --project integration tests/integration/task-creation.test.ts` passed: 1 file, 8 tests.
- `bunx vitest run --project unit tests/lib/streams/stream-id.property.test.ts src/services/container-agent/__tests__/agent-review-sanitize.property.test.ts` passed: 2 files, 5 tests.
- `bun run typecheck` passed.
- `git diff --check -- tests specs src` passed.
