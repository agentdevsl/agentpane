# Functional Test Improvements — May 2026

**Reviewers:** 6 concurrent Opus agents
**Scope:** `tests/functional/*.test.ts` (10 files, ~8.8k LOC) plus `tests/factories/`, `tests/helpers/`, `tests/setup*.ts`, `tests/integration/*.test.ts` (sampled), and the real services they exercise
**Reference rule:** `.claude/CLAUDE.md` §"Functional Tests: Real Service Transitions" — every state transition flows through real service code; only Claude SDK, sandbox providers, git CommandRunner, and DurableStreams may be mocked
**Date:** 2026-05-08
**Branch:** `feat/topology-small-tweaks`

---

## Executive Summary

The functional test suite is **mostly well-disciplined for the plan-approval lifecycle** — `task-lifecycle-e2e.test.ts` is a strong reference model and the 7 critical transitions in CLAUDE.md are covered for the docker-host happy path. The systemic weaknesses are concentrated in five places:

1. **Cancel paths are entirely untested through the real `ContainerExecService.stopAgent()`.** Existing tests bypass the stop chain by calling `updateTaskOnAgentComplete(db, taskId, 'cancelled')` directly. Sentinel-write, exec.kill, worktree-cleanup, and the `container-agent:cancelled` publish branches are uncovered.
2. **`AgentReviewService` (auto-approval mode) has zero functional coverage.** No file references `agentReview`/`reviewPlan`/`'agent'` approval mode. The `resetToPlanning` safety-net catch is not exercised.
3. **Concurrency tests cannot prove what they claim.** The `transaction()` monkey-patch in `tests/helpers/database.ts:71-98` passes the outer `testDb` instead of the transactional `tx`, defeating Drizzle's serialization. One test admits this in a comment. All 7 concurrent-race tests in `prove-plan-approval-bugs.test.ts` and `state-guard-vulnerabilities.test.ts` are protocol tests, not semantic tests.
4. **`host-mode-error-recovery.test.ts` over-mocks.** Three of four collaborating services (`WorktreeService`, `SessionService`, `TaskService`) are mocks while the file claims to "exercise real service code". Asserts use mock-call inspection rather than real DB/event state.
5. **`clearTestDatabase()` has drifted out of sync with the schema.** SQLite path omits `settings`, `sandbox_instances`, `cli_sessions`, `plan_sessions`, `users`, all 5 `memory_*` tables, `api_keys`, `templates`, terraform tables, and more. PG path omits a different (also incomplete) set. At least 5 functional tests have invented their own `DELETE FROM settings` workarounds.

**Aggregate findings across the 6 reviews:** 6 critical false-pass tests; 66 mocking-discipline violations; 11 high-severity flake risks; 33 medium flake risks; 18 weak/missing-negative assertions; 10 service-side scenarios with zero functional coverage; ~430 lines of inline migration patches duplicating production migrations.

**Recommended top-3 actions** (impact ÷ effort):
1. Fix `clearTestDatabase()` table-list drift by auto-deriving from `Object.values(schema)` — eliminates 5+ `DELETE FROM settings` workarounds and a class of order-dependent flakes in one S-effort change.
2. Add `tests/helpers/mocks.ts` and `tests/helpers/lifecycle-harness.ts` — collapses ~250 lines of wiring per test into ~25 lines, unblocks broader coverage.
3. Write `tests/functional/AGENTS.md` codifying the boundary policy + write `tests/functional/cancel-paths.test.ts`, `agent-review-lifecycle.test.ts`, `plan-revision-loop.test.ts` (the three highest-impact missing test files).

---

## Section 1 — Coverage Gaps

### 1.1 The 7 critical transitions × scenarios coverage matrix

Legend: `OK` = covered with real services; `partial` = covered but with significant gap; **`MISSING`** = no functional test.

| # | Transition | Happy | Error path | Cancel/abort | Concurrent | Cross-mode (host vs container) |
|---|------------|-------|-----------|--------------|------------|-------------------------------|
| 1 | `TaskService.create()` | OK (`task-lifecycle-e2e.test.ts:119`) | OK (validation in unit) | n/a | partial — `prove-task-service-bugs.test.ts:148` covers create-create only | **MISSING** |
| 2 | `TaskService.moveColumn()` backlog → in_progress | OK | partial — only generic `startAgent` failure (`prove-task-service-bugs.test.ts:95`); **MISSING**: sandbox-throw, credential-fail, TOCTOU not-running | **MISSING** — no race between move-to-in-progress and move-back-to-backlog mid-startup | partial — no two-task move race | partial — host mode only tested for throws |
| 3 | `PlanApprovalService.handlePlanReady()` | OK | OK — duplicate event; **MISSING**: DB-persist failure path | **MISSING** — race with user `moveColumn(backlog)` | partial — sequential duplicate covered; **MISSING**: true `Promise.all` concurrency | **MISSING** — no test runs through AgentCore bridge |
| 4a | `PlanApprovalService.approvePlan()` | OK | OK — `startAgentFn` failure with rollback; **MISSING**: skill-chaining DB read failure | **MISSING** — concurrent `stopAgent` + `approvePlan` | OK — `state-guard-vulnerabilities.test.ts:823` | OK both branches |
| 4b | `PlanApprovalService.rejectPlan()` | OK | partial — DB-update failure not asserted; **MISSING**: worktree-cleanup throw | n/a | OK — concurrent reject+approve; **MISSING**: concurrent reject+reject | n/a |
| 5 | `updateTaskOnAgentComplete()` | OK for `completed`, `turn_limit`. **MISSING** for `cancelled` driven by real `stopAgent()` flow | OK — column guard | **MISSING** — late completion arriving after user cancel | OK | n/a |
| 6 | `TaskService.approve()` | OK | OK | **MISSING** — concurrent stopAgent + approve | partial — `state-guard-vulnerabilities.test.ts:931` covers double-approve; **MISSING**: two HTTP clients | n/a |

### 1.2 Cross-cutting concerns

| Concern | Coverage |
|---------|----------|
| Mid-planning cancel via real `ContainerExecService.stopAgent()` | **MISSING (P0)** |
| Mid-execution cancel via real `ContainerExecService.stopAgent()` | **MISSING (P0)** |
| AgentReviewService auto-approval (any path) | **MISSING (P0)** |
| Skill chaining (`executionSkillId` swap + rollback) | **MISSING (P0)** |
| Host-mode happy-path completion (success branch) | **MISSING (P0)** |
| `agent:plan_ready` after `agent:error` (idempotency / suppression) | **MISSING (P0)** |
| Plan revision loop (sdkSessionId continuity across rounds) | partial (`task-lifecycle-e2e.test.ts:441`) |
| Two concurrent `approvePlan` calls (double-click) | **MISSING (P0)** |
| `plan:` / `sandbox:` stream-prefix routing | **MISSING (P0)** |
| Sandbox ID consistency (config.id → DB → stream → provider map) | **MISSING (P1)** |
| Empty / malformed plan from `ExitPlanMode` | **MISSING (P1)** |
| `cancelTask` during `agent_reviewing` (auto-review in flight) | **MISSING (P1)** |
| Worktree merge `git pull --rebase` failure mid-merge (status stuck) | **MISSING (P1)** |
| Sandbox provider failure cascade (provider.get throws/hangs) | **MISSING (P1)** |
| `TaskService.delete` on in_progress task with running container agent | **MISSING (P1)** |
| Orphan sweep / `recoverOrphanedTasks` | **MISSING (P1)** |
| Multi-codespace isolation | **MISSING (P1)** |
| onAgentCompleteCallback / queue auto-dequeue | **MISSING (P1)** |
| SDK session resume across restart via real `AgentExecutionService.resume()` | **MISSING (P1)** |
| Container vs host mode lifecycle parity | **MISSING (P1)** |

### 1.3 P0 — Highest-impact missing tests (would catch real bugs today)

| # | Proposed test file | Test name | Real services |
|---|---|---|---|
| P0-1 | `tests/functional/container-cancel.test.ts` | `stopAgent() during planning writes sentinel, kills exec, cleans worktree, publishes container-agent:cancelled` | `ContainerExecService.stopAgent`, real bridge → `updateTaskOnAgentComplete` |
| P0-2 | `tests/functional/container-cancel.test.ts` | `stopAgent() during execution after approvePlan reverts task safely` | Same + `PlanApprovalService.approvePlan` |
| P0-3 | `tests/functional/agent-review-mode.test.ts` | `handlePlanReady with approval.mode='agent' triggers reviewPlan, auto-approves, calls approvePlan with approvedBy='agent-review'` | `PlanApprovalService.handlePlanReady`, real `AgentReviewService` |
| P0-4 | `tests/functional/agent-review-mode.test.ts` | `agent review SDK throw triggers resetToPlanning safety net` | Same |
| P0-5 | `tests/functional/skill-chaining.test.ts` | `approvePlan swaps task.skillId from planning skill to executionSkillId atomically` + rollback on `startAgentFn` failure | `PlanApprovalService.approvePlan` |
| P0-6 | extend `host-mode-error-recovery.test.ts` | `host-mode start → planning succeeds → resume → execution completes → task moves to waiting_approval` | Real `AgentExecutionService.start`/`resume`, real `handleAgentComplete` |
| P0-7 | extend `task-lifecycle-e2e.test.ts` | `bridge fires onPlanReady twice in rapid succession — second is rejected by handlePlanReady idempotency, plan A preserved` | Real `createContainerBridge` + `handlePlanReady` |
| P0-8 | extend `state-guard-vulnerabilities.test.ts` | `updateTaskOnAgentError on a task in waiting_approval/planning is rejected by column guard, plan preserved` | Real `handlePlanReady` + `updateTaskOnAgentError` |
| P0-9 | `tests/functional/plan-revision-loop.test.ts` | `round-1 rejection feedback flows into round-2 plan prompt; sdkSessionId chain documented` | Real plan-approval round-trip |
| P0-10 | `tests/functional/concurrent-approve-double-click.test.ts` | `two parallel approvePlan calls — exactly one startAgentFn invocation, exactly one in_progress task` | Real `approvePlan` × 2 |
| P0-11 | `tests/functional/stream-id-prefix-routing.test.ts` | `plan:* and sandbox:* events do NOT appear in session.getEventsBySession()` | Real `SessionService.publish`, real `DurableStreamsService` |

### 1.4 P1 — Known fragile areas

- Orphan sweep / `recoverOrphanedTasks` (`agent-execution.service.ts:1876-1920`)
- Concurrent `moveColumn` on the same agent (single agent, two tasks racing the auto-start)
- Worktree merge failure → retry behaviour (the second-try after `WORKTREE_MERGE_FAILED`)
- Real `AgentExecutionService.resume()` post-restart (currently only the `startAgentFn` is asserted)
- Sandbox provisioning failures beyond quota: `CONTAINER_NOT_RUNNING`, `IMAGE_PULL_FAILED`, credential injection failure
- Multi-codespace isolation
- Container vs host mode parity for the lifecycle
- Queue auto-dequeue via `onAgentCompleteCallback`
- Sandbox ID consistency through stream/DB/provider map
- Empty / malformed plan from `ExitPlanMode`
- `cancelTask` during `agent_reviewing`
- `TaskService.delete` on in_progress task
- AgentCore branch SDK session resume

### 1.5 P2 — Defensive

- `handlePlanReady` when running agent's `sandboxId` is `undefined`
- Container bridge — partial JSON line at end of stream
- Skill tracking branch (`shared-helpers.ts:120-191`)
- `softInvariant` violations in restore paths
- Worktree-cleanup failure during `rejectPlan` (non-fatal swallow)
- `getPendingPlan` DB-fallback when leftover plan exists
- `moveColumn` from `verified` → other columns

---

## Section 2 — Mocking Discipline

### 2.1 Violation summary (66 total)

| # | Violation Type | Count | Severity Mix |
|---|---|---|---|
| 1 | Raw DB updates simulating state transitions instead of real service call | **23** | 1 Critical, 11 High, 11 Medium |
| 2 | Mocked services that should be real (`TaskService`/`SessionService`/`WorktreeService` etc.) | **6** | 2 Critical, 4 High |
| 3 | Fake event publishing (mock streams used as oracle) | **9** | 3 High, 6 Medium |
| 4 | Mock leakage (module-level `vi.mock` without per-test reset) | **4** | 2 High, 2 Medium |
| 5 | Over-mocking I/O (mocking entire service when only SDK should be mocked) | **3** | 2 High, 1 Medium |
| 6 | Under-mocking I/O (transaction monkey-patch alters production semantics) | **2** | 1 Critical, 1 High |
| 7 | State assertions limited to DB only (no `SandboxStateManager` memory check) | **5** | 5 Medium |
| 8 | Silent test passes (try/catch swallowing real errors) | **6** | 1 High, 5 Medium |
| 9 | DurableStreams "mock that lies" — accepts any payload | **8** | 4 High, 4 Medium |

### 2.2 Critical violations

#### CRIT-1 — `host-mode-error-recovery.test.ts:60-83` — Three real services replaced with mocks

The test claims to "exercise real service code" but `WorktreeService`, `SessionService`, AND `TaskService` are all mocks. `mockTaskService.moveColumn` is never asserted on — a regression rewiring the catch path through `TaskService` (the right architecture) would silently break.

**Fix:** Use real `TaskService`, `SessionService`, and `WorktreeService` (latter wired with mocked `CommandRunner` per CLAUDE.md boundary).

#### CRIT-2 — `host-mode-error-recovery.test.ts:43-50` — Module-level `vi.mock` with `clearAllMocks` not `resetAllMocks`

`vi.clearAllMocks()` clears call history but not `mockResolvedValue`/`mockRejectedValue` settings. Tests inherit prior implementations.

**Fix:** Use `mockReset()` (clears implementation + history) in `beforeEach`.

#### CRIT-3 — `tests/helpers/database.ts:71-98` — `transaction()` monkey-patch passes outer `testDb` instead of `tx`

The fallback path passes the non-transactional `testDb` to the callback. CAS guards (`WHERE column = 'in_progress'`) evaluate against the live DB without isolation. `prove-task-service-bugs.test.ts:178-181` admits this in a comment.

**Translation:** All 7 concurrent-race tests in `prove-plan-approval-bugs.test.ts` and `state-guard-vulnerabilities.test.ts` (Tests 8, 8b, 10) cannot prove production CAS guards work — they could pass with the test wrapper accidentally serialising things or fail spuriously and be silenced by `expect(approveOk || rejectOk).toBe(true)` (always true).

**Fix:** Either (a) switch the functional project to a real PostgreSQL test DB (`DB_MODE=postgres`); or (b) explicitly document that concurrency tests are *protocol* tests, not *semantic* tests, and add a parallel integration suite running against PG.

### 2.3 Recurring high-severity patterns

- **6 instances** of the "worktreeId/branch re-link after `updateTaskOnAgentComplete` cleared them" pattern. The tests assert on a `(waiting_approval, completed, worktreeId set)` state that never exists in production. Locations: `state-guard-vulnerabilities.test.ts:304/385`, `task-lifecycle-e2e.test.ts:335/526/640`, `task-lifecycle-advanced.test.ts:424`.
- **`prove-session-worktree-bugs.test.ts:586-666`** — entire test never invokes a real service. Pure DB shape test masquerading as a functional test. The next test in the same describe block (line 669) does it correctly via real `WorktreeService.merge()` with a failing `CommandRunner`. Delete the earlier one.
- **`prove-session-worktree-bugs.test.ts:781-789, 863-868`** — FK cascade tests belong in `tests/integration/`, not functional. CLAUDE.md "Durable Stream ID Patterns" notes `session_events.session_id` has **no FK constraint** — directly contradicts what these tests assert.
- **`tool-deny-hook.test.ts:64-78`** — real services replaced with minimal hash-shaped mocks. The line 177-187 assertion checks call payload structure but not whether the event would actually persist/stream.
- **`host-mode-error-recovery.test.ts:220-229, 312-318`** — asserts against `mockSessionService.publish.mock.calls` rather than real event persistence. The OC-005d outbox migration means real `SessionStreamService.publish()` writes to the outbox, never directly invoking `streams.publish`. The mock assertions are at the wrong layer.

### 2.4 Universal "mock that lies" — `createMockStreams()` (8 files)

Every functional test uses some variant of:
```ts
function createMockStreams(): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(), subscribe: vi.fn(), close: vi.fn(),
  } as unknown as DurableStreamsService;
}
```

The real `DurableStreamsService.publish()` validates the OC-005d structured envelope. The mock accepts anything. The better in-memory implementation in `prove-session-worktree-bugs.test.ts:25-48` (with offset bookkeeping) should be promoted to `tests/helpers/mocks.ts` as `createInMemoryStreams()`.

### 2.5 Proposed `tests/functional/AGENTS.md` (boundary policy)

```markdown
# Functional Tests — Mocking & Real Service Discipline

## The Single Rule
> Every state transition MUST flow through real service code.

## Allowed Mock Boundaries (and ONLY these)
| Boundary | Why | Mock Helper |
|---|---|---|
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | External API | `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` |
| Sandbox providers (Docker / K8s / AgentCore) | External daemon | `makeStubProvider()` |
| `CommandRunner` (git, shell) | Touches host filesystem | `{ exec: vi.fn(), execArgs: vi.fn() }` |
| `DurableStreamsService` | Caddy-side proxy | `createInMemoryStreams()` (NOT the all-`undefined` `createMockStreams()`) |
| Settings reads (when not under test) | Cross-cutting concern | `vi.mock('../../src/services/settings.service.js', ...)` |

## Forbidden — Common Anti-Patterns
1. `vi.mock('TaskService' | 'SessionService' | 'WorktreeService' | 'PlanApprovalService' | 'SandboxStateManager' | 'AgentService')` — these are the units under test.
2. Direct `db.update(tasks).set({ column: 'X' })` to simulate a column transition — call `taskService.moveColumn()` instead.
3. Direct `db.update(tasks).set({ lastAgentStatus: 'completed' })` — call `updateTaskOnAgentComplete(db, taskId, 'completed')` instead.
4. Direct `db.insert(session_events)` to simulate event publishing — call `sessionService.publish()`.
5. Module-level `vi.fn()` not reset between tests — use `mockReset()` (not `mockClear()`).
6. Mock streams that accept any payload silently — use the in-memory streams.
7. Bare `} catch {}` blocks — narrow to the specific expected error.

## Allowed Direct DB Writes (Fixture-Only)
- `db.insert(settings)` for sandbox/agent runtime config (annotate `// TEST-SETUP:`).
- `db.insert(sessions)` only when satisfying a FK precondition AND the test is NOT about session creation. Prefer `createTestSession()`.
- `execRawSql('PRAGMA foreign_keys = ON')` for environment control.

## Memory State Assertions
Every plan or running-agent lifecycle test MUST assert on BOTH DB state AND `SandboxStateManager` memory state.

## Concurrency Tests Caveat
The default test DB is in-memory SQLite with a monkey-patched async transaction wrapper that does NOT enforce production transaction semantics. Do NOT rely on the SQLite functional suite to prove concurrent CAS guards work — write a parallel test in `tests/integration/` using `DB_MODE=postgres`.
```

---

## Section 3 — Assertion Quality

### 3.1 False-pass risks per file

| File | Critical | Important | Weak/Missing-negative |
|------|---------:|----------:|---------------------:|
| `prove-plan-approval-bugs.test.ts` | 2 | 3 | 4 |
| `prove-task-service-bugs.test.ts` | 1 | 2 | 3 |
| `prove-session-worktree-bugs.test.ts` | 2 | 3 | 5 |
| `state-guard-vulnerabilities.test.ts` | 0 | 1 | 1 |
| `task-lifecycle-e2e.test.ts` | 0 | 1 | 2 |
| `task-lifecycle-advanced.test.ts` | 0 | 1 | 1 |
| `host-mode-error-recovery.test.ts` | 0 | 1 | 1 |
| `sandbox-quota-enforcement.test.ts` | 0 | 0 | 1 |
| `tool-deny-hook.test.ts` | 1 | 1 | 1 |
| **Totals** | **6** | **13** | **18** |

### 3.2 Critical false-pass tests (test passes even with the bug present)

#### C-1 — `prove-plan-approval-bugs.test.ts:738` — Concurrent approve+reject asserts OR not XOR

```ts
expect(approveOk || rejectOk).toBe(true);  // BAD — both succeeding still passes
if (approveOk && rejectOk) { /* allowed: documents the buggy behaviour */ }
```

A regression that allows BOTH `approve` AND `reject` to succeed (corrupting state) would pass. The contradicting test in `state-guard-vulnerabilities.test.ts:823` asserts the correct invariant `expect(approveOk !== rejectOk).toBe(true)`.

**Fix:** Replace with XOR check; remove the `if (approveOk && rejectOk)` documentation branch.

#### C-2 — `prove-plan-approval-bugs.test.ts:475` — Test asserts a known-bad behaviour as expected

```ts
expect(callOrder).toEqual(['error:SDK crashed:1', 'plan_ready:Ghost plan']);
// FINDING: The bridge does NOT stop processing after error events.
// This means a plan_ready arriving after an error will still trigger
// the onPlanReady callback, potentially storing a plan for a failed agent.
```

A correct fix that suppresses `plan_ready` after `error` would BREAK this test. **Fix:** Either rename to `documents current behaviour: bridge does not buffer/reorder` or rewrite to assert the orchestrator's downstream guard.

#### C-3 — `prove-task-service-bugs.test.ts:148` — Position-collision test is tautological

```ts
expect(allTasks.length).toBeGreaterThanOrEqual(2);  // trivially true after 2 creates
if (seqResult1.ok && seqResult2.ok) {                // dead branch
  expect(seqResult1.value.position).not.toBe(seqResult2.value.position);
}
```

The concurrent-path uniqueness check never runs. **Fix:** Drop the `if` guard; assert `expect(new Set(positions).size).toBe(positions.length)`.

#### C-4 — `prove-session-worktree-bugs.test.ts:101` — `events >= successes` is trivially true

```ts
expect(allEvents.length).toBeGreaterThanOrEqual(successes.length);  // always true
```

A regression that loses both events silently would still satisfy this (both sides 0). **Fix:** `expect(allEvents.length).toBe(successes.length)` and verify each success's offset is in DB.

#### C-5 — `prove-session-worktree-bugs.test.ts:290` — `if (result2.ok) expect(...)` with no else

If `result2.ok` is `false`, the orphan-detection block is silently skipped. Both directions silently pass — tester cannot tell whether the bug exists. **Fix:** Add `else` branch asserting expected error code.

#### C-6 — `tool-deny-hook.test.ts:157, 213, 251` — Polling without state assertion + missing negative

The "allow" test asserts the verdict but does NOT assert that NO `tool:result{isError:true}` event was published. A regression producing deny side-effects WHILE returning allow would pass.

### 3.3 Style guide — 10 patterns to adopt

1. **Pair every positive assertion with a negative.** `task.column === 'verified'` AND `streams.publish` not called for the wrong event AND `agentError === null`.
2. **Avoid `expect(x).toBeDefined()` after creating x** — assert the contract (`result.ok === true` AND `result.value.id` matches).
3. **Never use `if (result.ok) expect(...)` without an `else`.** Use type-narrowing: `expect(result.ok).toBe(true); if (!result.ok) return;`
4. **Strict equality over `expect.objectContaining`** for state assertions. Reserve `objectContaining` for cross-cutting metadata.
5. **For race tests: assert mutual exclusion (XOR), not "at least one".** `expect(approveOk !== rejectOk).toBe(true)`.
6. **For DB-mutating operations: assert both the service result AND the DB row.**
7. **Async work: poll on the target state, not a side proxy.** Use `vi.waitFor` not raw `setTimeout(50)`.
8. **Never use `not.toBe(...)` as the primary contract assertion** — `not.toBe('SANDBOX_QUOTA_EXCEEDED')` passes for any other code. State the positive.
9. **Mock-call assertions must include the FULL argument shape** — exact stream id, exact event type, full `data` shape with `taskId`/`phase`.
10. **Tests named "should X" must assert X.** If the test documents existing non-ideal behaviour, name it "documents current behaviour: ...".

---

## Section 4 — Test Infrastructure (Factories / Helpers / Setup)

### 4.1 Top 5 ergonomic wins

| # | Win | Effort |
|---|---|---|
| 1 | Lifecycle harness (`createLifecycleHarness`) — collapses the 5-piece object graph wiring repeated across 7 tests | M |
| 2 | Centralised mock factories (`tests/helpers/mocks.ts`) — `createInMemoryStreams`, `createMockWorktreeService`, `createMockContainerAgent`, `createMockWorktreeInit` | S |
| 3 | Fix `clearTestDatabase()` table-list drift (auto-derive from `Object.values(schema)`) | S |
| 4 | Split `tests/helpers/database.ts` (716 lines) into `connection.ts` + `migrations.ts` + `cleanup.ts` + `seed.ts`; replace inline migration patches with the real production migration runner | L |
| 5 | Stream simulation v2 — fluent builders for SDK message stream and agent-runner JSON-line stream | M |

### 4.2 Missing factories

| Entity | Currently built by hand at | Proposed factory |
|---|---|---|
| Settings rows | 5+ tests | `enableSandboxDefaults(db, opts?)` |
| Sandbox instances | `sandbox-quota-enforcement.test.ts:107-134` | `createTestSandboxInstance(codespaceId, opts?)` |
| Plan session / pending plan | `task-lifecycle-advanced.test.ts:101-112` | `createTestRunningAgent`, `createTestPendingPlan` |
| Team + members + folder + codespace member | 7+ integration tests | `createTestTeam`, `createTestTeamMember`, `createRbacFixture` |
| Plan session row | none yet — schema exists | `createTestPlanSession` |
| User | inline | `createTestUser` |
| Session event | `prove-session-worktree-bugs.test.ts:60-78` (`buildSessionEvent`) | promote to `tests/factories/session-event.factory.ts` |

### 4.3 Existing factory smells

- `factories/project.factory.ts:60-67` — uses **string interpolation** with manual escape for SQL. Replace with parameterised `prepare().run()`.
- `factories/project.factory.ts:7-18` — `try {} catch {}` swallows all errors. Use `INSERT OR IGNORE` and drop the catch.
- `factories/event-source.factory.ts:43-61` — `eventSourceId` and `targetCodespaceId` default to fresh `createId()` — FK violations waiting to happen. Require as positional args.
- `factories/index.ts` — `container-agent.factory.ts` not re-exported. Discovery hazard.
- `factories/agent.factory.ts:6-7` — local string-literal unions for `AgentStatus`/`AgentType` will silently drift from schema.
- `factories/task.factory.ts:7-14` — `withApproval`/`withRejection` toggles set magic constants (`'test-user'`). Drop in favour of `createApprovedTask` / `createRejectedTask` with explicit defaults.

### 4.4 Helper bugs in `tests/helpers/database.ts`

- **Lines 71-98**: `transaction()` monkey-patch detects async callbacks by string-matching error messages (`e?.message?.includes('promise')`). Brittle.
- **Lines 60-61**: `foreign_keys = OFF` set unconditionally. Every functional test runs without FK enforcement. Cascade tests in `prove-session-worktree-bugs.test.ts:783-870` re-enable mid-test.
- **Lines 100-533**: 430+ lines of `try { sqlite.exec(...) } catch {}` migration patches mirroring production. Delete and use the real production migration runner against `:memory:`.

### 4.5 `clearTestDatabase()` table-list drift

**SQLite path omits these tables that tests insert into:** `settings`, `sandbox_instances`, `sandbox_tmux_sessions`, `cli_sessions`, `plan_sessions`, `terraform_modules`, `terraform_registries`, `templates`, `template_codespaces`, `workflows`, `memory_insights`, `memory_messages`, `skill_executions`, `skill_metrics`, `dream_sessions`, `skill_suggestions`, `schedule_executions`, `api_keys`, `users`.

The PG path (lines 559-571) lists a different (also incomplete) subset. Inconsistency means the same test can pass on SQLite but flake on PG.

**Fix:** Derive the truncate list dynamically from `Object.values(schema)` filtered to tables; maintain a single canonical `EXCLUDED_TABLES` set with a runtime assertion that every Drizzle table is either in `TRUNCATED_TABLES` or `EXCLUDED_TABLES`.

### 4.6 Lifecycle harness API sketch

The single biggest ergonomic win. Today every functional test repeats the same wiring (~30-60 lines). Proposed:

```ts
const harness = await createLifecycleHarness();
const cs = harness.forCodespace({ name: 'E2E Project' });
const { task, capturedStartInput } = await cs.startTask({ title, skillId, ... });
expect(capturedStartInput.prompt).toContain('.claude/skills/auth-toolkit/SKILL.md');
await cs.emitPlanReady(task.id, { plan, sdkSessionId });
expect(harness.stateManager.hasPendingPlan(task.id)).toBe(true);
const approveResult = await cs.approvePlan(task.id);
await cs.completeAgent(task.id, 'completed');
const verified = await cs.approveAndMerge(task.id, { approvedBy: 'test-user' });
expect(verified.ok && verified.value.column).toBe('verified');
await harness.teardown();
```

`task-lifecycle-e2e.test.ts:102` (currently 258 lines) collapses to ~25 lines. All transitions still go through real `TaskService`/`PlanApprovalService`/`updateTaskOnAgentComplete` — the harness only replaces wiring boilerplate, not the assertions.

### 4.7 Stream simulation v2

Today's `tests/helpers/simulate-agent-stream.ts` (78 lines, 3 helpers) cannot model:
- Multi-turn conversations (`assistant → user(tool_result) → assistant → ...`)
- Real `tool_use` / `tool_result` blocks (only abridged `tool_use_summary`)
- `result(error)`, abort, turn-limit (only `result(success)`)
- Agent-runner JSON-line events (the container-agent path uses a different format; two tests reinvented this — `prove-plan-approval-bugs.test.ts:82-105` and `task-lifecycle-e2e.test.ts:33-36`)
- Permission prompts (`canUseTool`)

Proposed:

```ts
// tests/helpers/streams/sdk-stream.builder.ts
export function sdkStream(): SdkStreamBuilder; // .systemInit().messageStart().textDelta()
                                                // .toolUse().toolResult().exitPlanMode()
                                                // .resultSuccess().resultError().resultTurnLimit()

// tests/helpers/streams/agent-runner-stream.builder.ts
export function agentRunnerStream(taskId, sessionId, codespaceId?): AgentRunnerStreamBuilder;
// .planReady().toolStart().toolResult().chunk().complete().error().build()
```

---

## Section 5 — Isolation, Flakiness, Environment Leaks

### 5.1 Risk summary (60 total)

| Category | High | Medium | Low |
|---|---|---|---|
| 1. Shared module-level singletons | 3 | 4 | 1 |
| 2. DB residue (tables not truncated) | 2 | 3 | 0 |
| 3. Time-based flakes (`setTimeout`/`setInterval` not faked) | 1 | 5 | 2 |
| 4. Async race conditions | 2 | 3 | 1 |
| 5. Filesystem leaks | 0 | 2 | 4 |
| 6. Process leaks (`spawnSync`, child processes) | 0 | 1 | 1 |
| 7. Network/external calls | 0 | 2 | 0 |
| 8. Env variable mutation | 2 | 3 | 1 |
| 9. Mock leakage across files | 0 | 2 | 3 |
| 10. Order-dependent passes | 1 | 4 | 2 |
| 11. CUID/Date determinism | 0 | 1 | 1 |
| 12. Pool='forks' assumptions | 0 | 1 | 0 |
| 13. Hook ordering bugs | 0 | 1 | 0 |
| 14. Timeout cliffs | 0 | 2 | 1 |
| **Totals** | **11** | **33** | **16** |

### 5.2 High-severity risks (CI-breaking within weeks)

1. **`clearTestDatabase()` table-list drift** (`tests/helpers/database.ts:580-615`) — see §4.5 above.
2. **`event-outbox-relay.test.ts:39-141` has no `afterEach` to stop the relay.** `await relay.stop()` is the *last* statement of each test body — if any earlier assertion throws, the `setInterval` keeps firing into subsequent tests.
3. **`agent-execution-service.test.ts:56-76` never calls `service.stopAll()`.** Metrics gauge singleton accumulates. Compare to `metrics-wire-up.test.ts:90-93` which does it correctly.
4. **`agent-oauth-refresh.test.ts:158-161`** does raw `delete process.env.X` without restoration, bypassing `vi.stubEnv` tracking.
5. **`middleware-auth.test.ts`** sets `NODE_ENV='production'` in many tests; only some describes restore. Production gate logic is the most dangerous env to leak.
6. **`SandboxStateManager` plan-cleanup `setInterval`** keeps process alive. Already documented as a known leak class in `agentcore-lazy-load.test.ts:111-116`. Some functional tests dispose, some don't. Need a static `disposeAll()` called from a global `afterEach` in `setup.ts`.
7. **`host-mode-error-recovery.test.ts:104-111`** uses magic `setTimeout(100)` for "settle after abort" — slow CI killer.
8. **`agentcore-lazy-load.test.ts:189-211`** `spawnSync` with full parent env. Env-sensitive on dev machines (real AWS credentials could trigger real STS calls).
9. **`cli-monitor-service.test.ts:84-120`** redefines schema inline that diverges from `database.ts:329-332`. Schema drift bomb that hides from CI until someone adds a column.
10. **File-scope `vi.mock` in functional tests** (`host-mode-error-recovery.test.ts:43-56`, `tool-deny-hook.test.ts:49-62`, `sandbox-quota-enforcement.test.ts:31-36`). Currently safe under `pool: 'forks'`, but a future move to `pool: 'threads'` or `singleThread: true` would break catastrophically.
11. **`setupTestDatabase()` short-circuits** but tests assume fresh state per call. Adding a test that calls `closeTestDatabase()` then `setupTestDatabase()` would skip the monkey-patch reapplication.

### 5.3 Recommended test isolation contract

#### a. Database
- Never insert into a table that `clearTestDatabase()` does not truncate.
- Always use factories from `tests/factories/`. Direct `db.insert(...)` allowed only for test-infrastructure rows AND must have a matching `db.delete` in `afterEach`.

#### b. Process & module state
- Any service holding in-memory state must expose `dispose()`/`stop()`/`stopAll()` and the test must call it in `afterEach`.
- Module-level singletons must be reset in `beforeEach` via an exported `__resetXForTests()` helper.

#### c. Environment variables
- Never use `process.env.X = '...'` or `delete process.env.X`. Always `vi.stubEnv(key, value)`.

#### d. Time and async
- Never `await new Promise(r => setTimeout(r, N))` for ordering. Use `vi.waitFor(...)` with an explicit assertion.
- Fake timers in one test only: setup in the `it()` block, teardown with try/finally.

#### e. Mocking
- Prefer per-test `vi.doMock(...)` over file-scope `vi.mock(...)` when some tests in the same file might need real.
- File-scope `vi.mock(...)` only for genuine external I/O (Claude SDK, AWS SDK, Octokit).

#### f. Filesystem and processes
- Always `os.tmpdir() + createId()` for temp paths, never hard-coded `/tmp/foo`.
- `mkdtempSync` always paired with guaranteed `rmSync` in `afterAll`.
- `spawnSync` always with explicit `env` — never `...process.env`.

### 5.4 Per-test setup/teardown checklist

```
[ ] beforeEach calls setupTestDatabase() (or relies on global setup)
[ ] beforeEach constructs all services freshly — no module-level reuse
[ ] beforeEach calls vi.clearAllMocks() if file-scope mocks exist
[ ] beforeEach calls __resetX() for any singletons used
[ ] afterEach disposes every service with dispose/stop/stopAll/stopCleanupTimer
[ ] afterEach calls clearTestDatabase()
[ ] afterEach does NOT use setTimeout for "settling" — use vi.waitFor
[ ] No test mutates process.env directly — only vi.stubEnv
[ ] No test inserts into tables not in clearTestDatabase() (until §4.5 fixed)
[ ] No await new Promise(r => setTimeout(r, N)) outside vi-fake-timer blocks
[ ] No hard-coded /tmp/* paths — use os.tmpdir() + createId()
[ ] vi.useFakeTimers() paired with vi.useRealTimers() in try/finally
[ ] AgentExecutionService / EventOutboxRelayService / schedulers stopAll()'d
[ ] SandboxStateManager dispose()'d
[ ] Tests near 60s/30s timeout: split or reduce mock latency
[ ] No spawnSync(... { env: process.env }) — explicit minimal env
[ ] Tests depending on optional binaries (helm, docker) FAIL (not skip) when missing
```

---

## Section 6 — High-Impact Missing Scenarios (Service-Side Walk)

### 6.1 Top 10 missing scenarios ranked by bug-catching impact

1. **P0 — Plan revision loop sdkSessionId continuity.** Round-2 plan creation does not preserve round-1 rejection feedback in the prompt; `sdkSessionId` chain semantics undocumented. (`task-lifecycle-e2e.test.ts:441` checks lifecycle but not continuity.)
2. **P0 — Two concurrent `approvePlan` calls (double-click).** No test verifies `startAgentFn` is called only once.
3. **P0 — `plan:` / `sandbox:` stream-prefix routing.** Explicitly called out as a footgun in CLAUDE.md, zero functional coverage.
4. **P1 — Sandbox ID consistency** (config.id → DB → stream → provider map).
5. **P1 — Empty / malformed plan from `ExitPlanMode`** flowing through to `startAgentFn` with no guard.
6. **P1 — `cancelTask` during `agent_reviewing`** — auto-review SDK session is not aborted.
7. **P1 — `git pull --rebase` failure mid-merge** leaves worktree row stuck in `status='merging'`.
8. **P1 — Sandbox provider failure cascade** (`provider.get()` throws/hangs during `approvePlan`).
9. **P1 — `TaskService.delete` on `in_progress` task with running container agent** — leak in `SandboxStateManager.runningAgents` map.
10. **P1 — SDK session resume after restart (AgentCore branch)** — line 374-433 of `plan-approval.service.ts` has zero coverage.

### 6.2 Per-service scenario coverage matrix

| Service | Notable missing scenarios |
|---|---|
| `PlanApprovalService` | Two concurrent `approvePlan`; AgentCore plan recovery; empty plan; `provider.get()` throws |
| `AgentReviewService` | **Entire feature has zero functional tests** — resolveApprovalMode cascade, auto-approve happy path, flag_for_review path, review-during-cancel, SDK throw fallback |
| `TaskService` | `cancelTask` during `agent_reviewing`; `delete` on in_progress with running agent; plan revision feedback flow |
| `AgentExecutionService` (host) | `resume after pause`; `stop()` while planning; `rejectPlanForTask` (lines 1690-1799); tool-deny during EXECUTION; memory injection failure; `tryDequeueAndStart` after auto-completion; `sweepOrphanedAgents` |
| `WorktreeService` | `git pull --rebase` failure mid-merge; prune of stale worktrees |
| `SessionService` / `SessionStreamService` | `plan:` / `sandbox:` prefix routing; cross-codespace event contamination; `subscribe` after close |
| `SandboxService` / `SandboxStateManager` | ID consistency through stream/DB/provider; `assertSharedSandboxAllowed` multi-tenant gate |
| `ContainerAgentService.reconcile` | `flushOrphanToolStartsForTask` synthetic event shape |
| `ContainerExecService` | agent-runner exits 0 with no events; agent-runner crashes mid-execution + reconnect |

### 6.3 Recommended new test files (≤6)

1. **`tests/functional/plan-revision-loop.test.ts`** (P0) — round-1 rejection feedback into round-2; concurrent approve double-click; rejectionReason history; reject mid-planning.
2. **`tests/functional/stream-id-prefix-routing.test.ts`** (P0) — `plan:*` / `sandbox:*` routing; bare CUID treated as session event (regression doc).
3. **`tests/functional/empty-and-malformed-plan.test.ts`** (P1) — empty plan sentinel; AgentReview JSON parsing edge cases; review timeout.
4. **`tests/functional/agent-review-lifecycle.test.ts`** (P1) — full AgentReview path including resolveApprovalMode cascade; auto-approve happy; flag_for_review; cancel during review; SDK throw fallback.
5. **`tests/functional/sandbox-provider-and-id-cascade.test.ts`** (P1) — sandbox ID consistency; provider.get throws; mismatched id; assertSharedSandboxAllowed.
6. **`tests/functional/host-mode-plan-reject-and-cancel.test.ts`** (P1) — `rejectPlanForTask` CAS; abort controller cleanup; worktree cleanup; `TaskService.delete` on in_progress.

### 6.4 "Worth a property test?" callouts

- **State-machine soundness** for the `(column × lastAgentStatus × event)` matrix — ~350 cells; fast-check fuzz would surface gaps no example test reaches.
- **Concurrent approve/reject/cancel triple race** — 6 orderings; `fast-check` shuffle the operation list.
- **Stream-id prefix invariant** — `forall id in (random valid + invalid stream IDs), classify(id) is consistent across `stream-id.ts` and `durable-streams.service.ts`.
- **`sanitizeForPrompt` injection guards** in `agent-review.service.ts:63` — no occurrence of `</plan>` or `</task_description>` for any input.
- **Position assignment under concurrent inserts** — `forall N in {5, 50, 200}, len(distinct positions) === N`.

---

## Section 7 — Consolidated Goals & Roadmap

### Phase 1 — Foundation Fixes (Week 1, S effort)

| # | Goal | Files | Owner |
|---|---|---|---|
| 1.1 | Fix `clearTestDatabase()` table-list drift (auto-derive from schema) | `tests/helpers/database.ts` | TBD |
| 1.2 | Add `tests/functional/AGENTS.md` with the boundary policy | new file | TBD |
| 1.3 | Add `tests/helpers/mocks.ts` with `createInMemoryStreams`, `createMockWorktreeService`, `createMockContainerAgent`, `createMockWorktreeInit`. Promote `createInMemoryStreams` from `prove-session-worktree-bugs.test.ts:25-48`. Delete `createMockStreams()` everywhere | new + 7 functional tests | TBD |
| 1.4 | Reconcile `ANTHROPIC_API_KEY` value between `tests/setup.ts:5` and `tests/helpers/env.ts:4` | both files | TBD |
| 1.5 | Re-export `container-agent.factory.ts` from `tests/factories/index.ts` | factories index | TBD |
| 1.6 | Replace `process.env.X = '...'` / `delete process.env.X` with `vi.stubEnv` in `agent-oauth-refresh.test.ts`, `middleware-auth.test.ts` | 2 integration tests | TBD |
| 1.7 | Fix the 6 critical false-pass tests (C-1..C-6 in §3.2) | 4 functional tests | TBD |

### Phase 2 — Critical False-Pass Fixes & High-Severity Mocking Cleanup (Week 2, M effort)

| # | Goal | Files |
|---|---|---|
| 2.1 | Replace `host-mode-error-recovery.test.ts` mocked services with real `TaskService`/`SessionService`/`WorktreeService` (CRIT-1) | `host-mode-error-recovery.test.ts` |
| 2.2 | Use `mockReset()` (not `mockClear()`) for module-level mocks in functional tests (CRIT-2) | 3 functional tests |
| 2.3 | Document concurrency tests as protocol-only, OR move to a PG harness (CRIT-3) | Add `tests/integration/concurrency-pg/` suite |
| 2.4 | Replace 23 raw `db.update(tasks).set({ ... })` state simulations with real service calls (HIGH-1..HIGH-11 + 6 worktreeId re-link cases) | All functional tests |
| 2.5 | Move FK-cascade tests from functional to integration suite | `prove-session-worktree-bugs.test.ts:781-789, 863-868` |
| 2.6 | Delete `prove-session-worktree-bugs.test.ts:586-666` (pure DB shape test) | Same file |
| 2.7 | Add `EventOutboxRelayService.stop()` to `afterEach` in `event-outbox-relay.test.ts` (H-2) | Integration test |
| 2.8 | Add `service.stopAll()` to `afterEach` in `agent-execution-service.test.ts` (H-3) | Integration test |
| 2.9 | Add static `SandboxStateManager.disposeAll()` and call from global `afterEach` in `tests/setup.ts` (H-6) | `tests/setup.ts` + `SandboxStateManager` |

### Phase 3 — Test Infrastructure (Weeks 3-4, M effort)

| # | Goal | Files |
|---|---|---|
| 3.1 | Build stream simulation v2: `sdkStream()` and `agentRunnerStream()` builders | `tests/helpers/streams/` |
| 3.2 | Build `createLifecycleHarness` (depends on 1.3, 3.1) | `tests/helpers/lifecycle-harness.ts` |
| 3.3 | Migrate `task-lifecycle-e2e.test.ts` and 2-3 other tests to the harness as proof points | Multiple |
| 3.4 | Add missing factories: settings, sandbox-instance, pending-plan, team+members, user, session-event | `tests/factories/` |
| 3.5 | Fix factory smells (string interpolation in `project.factory.ts`, FK-violation defaults in `event-source.factory.ts`, etc.) | `tests/factories/` |
| 3.6 | Add `tests/helpers/clock.ts` with `useFrozenClock` for plan TTL tests | new file |
| 3.7 | Add `tests/helpers/wait.ts` with `waitForCondition`, `waitForEvent` | new file |

### Phase 4 — New Functional Test Files (Weeks 4-6)

P0 (must ship):
1. `tests/functional/cancel-paths.test.ts` — mid-planning + mid-execution cancel via real `ContainerExecService.stopAgent()` (P0-1, P0-2)
2. `tests/functional/agent-review-mode.test.ts` — auto-approval happy + threshold + `resetToPlanning` safety net (P0-3, P0-4)
3. `tests/functional/skill-chaining.test.ts` — `executionSkillId` swap + rollback (P0-5)
4. `tests/functional/plan-revision-loop.test.ts` — sdkSessionId continuity + concurrent approve double-click (P0-9, P0-10)
5. `tests/functional/stream-id-prefix-routing.test.ts` — prefix invariants (P0-11)
6. Extend `host-mode-error-recovery.test.ts` with happy-path completion (P0-6)
7. Extend `task-lifecycle-e2e.test.ts` with bridge double-fire (P0-7)
8. Extend `state-guard-vulnerabilities.test.ts` with planning-state guard for `updateTaskOnAgentError` (P0-8)

P1 (next quarter):
1. `tests/functional/empty-and-malformed-plan.test.ts`
2. `tests/functional/sandbox-provider-and-id-cascade.test.ts`
3. `tests/functional/host-mode-plan-reject-and-cancel.test.ts`
4. `tests/functional/multi-codespace-isolation.test.ts`
5. `tests/functional/sandbox-provisioning-failures.test.ts`
6. `tests/functional/host-mode-lifecycle-parity.test.ts`
7. `tests/functional/agent-queue-dequeue.test.ts`

### Phase 5 — Long-Term (Quarter, L effort)

| # | Goal |
|---|---|
| 5.1 | Split `tests/helpers/database.ts` into 4 files; replace 430 lines of inline migration patches with the real production migration runner against `:memory:` |
| 5.2 | Migrate concurrency tests to a PG-backed harness with proper transaction semantics |
| 5.3 | Add property-based tests with fast-check for the 5 callouts in §6.4 |
| 5.4 | Enable `foreign_keys = ON` by default in test SQLite; migrate legacy `project_id NOT NULL` columns to nullable |

---

## Section 8 — Files Referenced

### Functional tests reviewed
- `tests/functional/host-mode-error-recovery.test.ts`
- `tests/functional/prove-plan-approval-bugs.test.ts`
- `tests/functional/prove-session-worktree-bugs.test.ts`
- `tests/functional/prove-task-service-bugs.test.ts`
- `tests/functional/sandbox-quota-enforcement.test.ts`
- `tests/functional/smoke.test.ts`
- `tests/functional/state-guard-vulnerabilities.test.ts`
- `tests/functional/task-lifecycle-advanced.test.ts`
- `tests/functional/task-lifecycle-e2e.test.ts`
- `tests/functional/tool-deny-hook.test.ts`

### Test infrastructure
- `tests/factories/*.ts` (8 files)
- `tests/helpers/database.ts` (716 lines)
- `tests/helpers/simulate-agent-stream.ts`
- `tests/helpers/async.ts`
- `tests/helpers/env.ts`
- `tests/setup.ts`, `tests/setup-unit.ts`, `tests/setup-jsdom.ts`
- `vitest.config.ts`

### Production services audited
- `src/services/container-agent/plan-approval.service.ts`
- `src/services/container-agent/container-exec.service.ts`
- `src/services/container-agent/agent-review.service.ts`
- `src/services/container-agent/shared-helpers.ts`
- `src/services/container-agent/container-agent.service.ts`
- `src/services/agent/agent-execution.service.ts`
- `src/services/task.service.ts`
- `src/services/worktree.service.ts`
- `src/services/session.service.ts`
- `src/services/sandbox.service.ts`
- `src/services/durable-streams.service.ts`
- `src/services/plan-mode.service.ts`
- `src/lib/streams/stream-id.ts`

### Authoritative reference
- `.claude/CLAUDE.md` — particularly: §"Functional Tests: Real Service Transitions", §"Preventing Regressions: Lessons Learned", §"Container Execution Flow", §"Durable Stream ID Patterns"

---

## Appendix — Methodology

This report consolidates findings from 6 concurrent Opus sub-agents, each focused on a non-overlapping review angle:

1. **Coverage gaps** — service-side walk against the 7 critical CLAUDE.md transitions (P0/P1/P2 ranked)
2. **Mocking discipline** — 9-category violation audit against the "real services" rule
3. **Assertion quality** — false-pass risks, tautological assertions, missing negatives
4. **Test infrastructure** — factories, helpers, lifecycle harness API design
5. **Isolation/flakiness** — 14 categories of leak/race/order-dependency risks
6. **High-impact missing scenarios** — service-walk to map bug classes → tests

Each agent produced a structured markdown report (~30k tokens each, ~3,200 lines total) at `/tmp/test_review_may/agent{1-6}_*.md`. This document is the consolidated deliverable.
