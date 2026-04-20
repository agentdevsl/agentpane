# Service Architecture

## Summary
The service layer is reasonably well-organised: the recent facade split for `AgentService` (CRUD / Execution / Queue) and `ContainerAgentService` (state / worktree / exec / plan-approval / agentcore bridge) and the proper dependency ordering in `service-container.ts` have eliminated the old "stub-then-patch" TaskService pattern. However, four architectural habits now dominate the code and deserve attention: (1) heavy use of in-memory `Map` state with no reconciliation path on crash/restart, (2) late-binding optional setters on `TaskService`, (3) a monolithic `TaskCreationService` (~2,600 LOC) that skipped the facade treatment, and (4) a 9-step bootstrap whose background sandbox retry and API-key resolution have subtle "server up but broken" failure modes.

## Map
| Layer | Files | Purpose |
|-------|-------|---------|
| Bootstrap orchestration | `src/server/bootstrap/server-bootstrap.ts`, `src/server/bootstrap/phases/*.ts`, `src/server/bootstrap/sandbox/*.ts` | 9-step pipeline: config -> db -> recovery -> services -> api key -> router -> serve -> schedulers -> sandbox (background) |
| Service container (DI) | `src/server/bootstrap/service-container.ts`, `src/server/bootstrap/types.ts` | Factory function builds all 30+ services in dependency order; a flat `ServiceContainer` interface is passed to routes |
| Shutdown | `src/server/bootstrap/shutdown.ts` | LIFO cleanup registry with 30s force-exit guard |
| Facade services | `src/services/agent.service.ts`, `src/services/session.service.ts`, `src/services/container-agent.service.ts`, `src/services/container-agent/container-agent.service.ts` | Delegate to focused sub-services under `src/services/{agent,session,container-agent}/` |
| Non-facade large services | `src/services/task.service.ts` (907 LOC), `src/services/codespace.service.ts` (663 LOC), `src/services/task-creation.service.ts` (2,623 LOC) | Still monolithic |
| In-memory state holders | `src/services/container-agent/sandbox-state.ts`, `src/services/agent/agent-execution.service.ts`, `src/services/task-creation.service.ts`, `src/services/terraform-compose.service.ts`, `src/services/cli-monitor/cli-monitor.service.ts`, `src/services/{terraform,template}-sync-scheduler.ts` | Maps/sets keyed by taskId/sessionId/registryId with various TTL strategies |
| Recovery | `src/server/bootstrap/phases/recovery.ts`, `src/services/container-agent/plan-approval.service.ts:188` | Resets stale agents/tasks and recovers pending plans from DB on boot |

## What's working
- Facade pattern for `AgentService` and `ContainerAgentService` delivered clean sub-service boundaries (CRUD / execution / queue; state / worktree / exec / plan / agentcore) without breaking callers.
- `service-container.ts` is comment-documented with the dependency graph and constructs services in-order so constructor params enforce ordering at compile time.
- Graceful shutdown uses LIFO with a 30s force-exit safety net (`shutdown.ts:30-51`) and individual cleanups are wrapped in try/catch so one failure cannot block the rest.
- Recovery phase (`phases/recovery.ts`) resets `starting|planning|running` agents, orphaned tasks, and stale worktree refs on every boot — a rare and valuable property.
- Pending plans are persisted to the `tasks` table and recovered via `PlanApprovalService.getPendingPlan` (`plan-approval.service.ts:188-220`), so approval survives a restart.
- `CommandRunner` is already a typed interface (`worktree.service.ts:120-122`) with a sandbox-variant factory — testability boundary is in place.

## Findings

### F01-01: In-memory running-agent state has no DB reconciliation on restart
- **Priority**: P1
- **Observation**: `SandboxStateManager` (`src/services/container-agent/sandbox-state.ts:19-28`) holds `runningAgents`, `runningAgentCoreAgents`, `pendingPlans`, and `startingAgents` in process memory. Recovery (`src/server/bootstrap/phases/recovery.ts:36-85`) resets agents to `idle` and tasks to `backlog` at boot — but there is no reconciliation against live containers: if the host restarts while Docker/K8s containers are still running (or are being drained), the DB forgets them and a subsequent restart of the same task can collide with live containers on the same codespace. `pendingPlans` does recover from DB (`plan-approval.service.ts:188-220`), but `runningAgents` does not.
- **Risk**: Duplicate agents on the same task after a crash, silent capacity leaks (reserved slots without tracking), orphaned containers consuming resources.
- **Recommendation**: Add a reconciliation step to the recovery phase that lists live sandboxes via each provider and either adopts them into `SandboxStateManager` or explicitly destroys them. Document the chosen policy (adopt vs destroy) per provider.
- **Effort**: M
- **Links**: [`specs/release_plan/05-error-resilience.md`](../release_plan/05-error-resilience.md), [`specs/release_plan/06-database-integrity.md`](../release_plan/06-database-integrity.md)

### F01-02: Late-binding optional setters on TaskService bypass type-level init guarantees
- **Priority**: P2
- **Observation**: `TaskService` exposes `setContainerAgentService()` and `setAgentExecutionService()` (`src/services/task.service.ts:122-132`) called from two very different bootstrap locations — `service-container.ts:157` (synchronous, always) and `sandbox/sandbox-init.ts:139` (async background, may never fire if the provider init times out and retries fail). `approvePlan` (`task.service.ts:194-236`) then branches on which field is set, returning `NO_EXECUTION_SERVICE` (503) if neither is wired — a runtime failure mode that the type system cannot catch.
- **Risk**: Silent "feature missing" errors at runtime when sandbox init fails; brittle to refactors; tests that stub only one trigger miss code paths.
- **Recommendation**: Collapse into a single required dependency `TaskOrchestrator` interface passed at construction, or move plan-approval out of TaskService into a dedicated orchestrator that owns the decision.
- **Effort**: M
- **Links**: N/A

### F01-03: Sandbox provider initialization is fire-and-forget with no readiness gate for dependents
- **Priority**: P1
- **Observation**: `initSandboxProvider` runs as a background promise after `Bun.serve` starts (`server-bootstrap.ts:211-217`). Task/agent routes that require `containerAgentService` become usable only after sandbox init resolves. There is no readiness probe and no 503 gate — if init times out or retries back off for minutes (exponential backoff up to 5 min in non-dev, `sandbox-init.ts:185`), `taskService.setContainerAgentService` is never called and every task-move yields the `NO_EXECUTION_SERVICE` error from F01-02.
- **Risk**: "Server healthy but nothing works" silent failure; confusing UX; load balancers route traffic to an incomplete instance.
- **Recommendation**: Expose a `/ready` (vs `/health`) endpoint gated on `sandboxState.provider !== null`. Have route handlers that require the sandbox return a consistent typed error rather than relying on an optional setter.
- **Effort**: S
- **Links**: [`specs/release_plan/03-observability.md`](../release_plan/03-observability.md), [`specs/release_plan/04-release-deployment.md`](../release_plan/04-release-deployment.md)

### F01-04: CommandRunner is constructed inline in the service container, limiting test isolation
- **Priority**: P2
- **Observation**: `createBunCommandRunner` is defined in-file at `src/server/bootstrap/service-container.ts:58-79` and wired into both `WorktreeService` and `CodespaceService` (and via those, TaskService). There is no way to swap it at bootstrap — every call to `createServiceContainer` brings a real `Bun.spawn` runner. Tests substitute via direct constructor calls to `WorktreeService`, but any integration-style test of the full container inherits real shell execution.
- **Risk**: Slow/flaky integration tests; accidental shell execution in unit contexts; hard to enforce the `validateShellCommand` policy (`worktree.service.ts:128-133`) from a single choke point.
- **Recommendation**: Accept `CommandRunner` as an injected parameter to `createServiceContainer` (default to the Bun runner). Consider moving `validateShellCommand` into the runner itself so every concrete runner enforces it.
- **Effort**: S
- **Links**: [`specs/release_plan/02-security-hardening.md`](../release_plan/02-security-hardening.md)

### F01-05: Bootstrap phase failures have inconsistent exit behaviour
- **Priority**: P1
- **Observation**: Phase failure handling is uneven: `initializeDatabase` calls `process.exit(1)` on missing `DATABASE_URL` (`phases/database.ts:43`); `resolveApiKey` only exits in production and warns in dev (`phases/api-key-resolution.ts:36-42`); `runRecovery` swallows errors and returns `{errors}` which bootstrap logs but does not act on (`server-bootstrap.ts:54-58`); `startSchedulers` logs "Failed to start scheduler" and continues (`phases/schedulers.ts:51-57`); sandbox init is best-effort with retry. No single place encodes "which phases are fatal".
- **Risk**: Server boots with unusable subsystems (e.g., scheduler down, recovery silently skipped) and no operator signal.
- **Recommendation**: Introduce an explicit per-phase `{fatal: boolean}` declaration or a `BootstrapContext.reportPhaseResult()` helper. Have recovery errors bubble to a fail-fast decision configurable by env.
- **Effort**: S
- **Links**: [`specs/release_plan/03-observability.md`](../release_plan/03-observability.md)

### F01-06: Two overlapping "running agents" maps create consistency hazards
- **Priority**: P2
- **Observation**: `SandboxStateManager` tracks `runningAgents` and `runningAgentCoreAgents` as separate maps (`sandbox-state.ts:19-22`), while `AgentExecutionService` maintains its own `runningAgents: Map<string, AbortController>` plus `agentStartTimes`, `preToolHooks`, `postToolHooks`, `agentInsightIds` (`agent-execution.service.ts:80-85`). The two sides represent the same logical fact ("agent is running") keyed by different IDs (taskId vs agentId) and updated by different services. There is no invariant that they agree.
- **Risk**: UI or API returning "running" from one side while the other side has already cleaned up; orphan sweep double-stops.
- **Recommendation**: Consolidate running-agent truth in a single owner (likely `SandboxStateManager` renamed and promoted) and have AgentExecutionService register AbortControllers there. Define an invariant test that the two views never disagree.
- **Effort**: M
- **Links**: F01-01

### F01-07: TaskCreationService is a 2,623-line monolith that escaped the facade refactor
- **Priority**: P2
- **Observation**: `src/services/task-creation.service.ts` at 2,623 lines owns SDK session management, question/answer state, token batching, idle cleanup, DB history, and SSE callback plumbing — all under one class with one Map of sessions (`task-creation.service.ts:193-218`). Comparable services (Agent, Session, ContainerAgent) have been split; this one has not.
- **Risk**: High cognitive load, difficult to test in isolation, regression risk when modifying one responsibility.
- **Recommendation**: Apply the same facade pattern used for Agent/Session: split into `TaskCreationSessionStore`, `TaskCreationSdkBridge`, `TaskCreationQuestionFlow`, and a thin `TaskCreationService` facade.
- **Effort**: L
- **Links**: N/A

### F01-08: ServiceContainer is a 30-field record; routes receive the whole graph
- **Priority**: P3
- **Observation**: `ServiceContainer` (`src/server/bootstrap/types.ts:63-93`) carries 30 service fields. `createAppRouter` is given the whole container plus three `getXxxProvider()` closures (`server-bootstrap.ts:110-116`). Each route module can reach any service, including `commandRunner` — there is no sub-scope or facet type per route group.
- **Risk**: Encourages cross-boundary calls, makes it easy to introduce hidden coupling between unrelated route modules.
- **Recommendation**: Narrow the router signatures so each route group receives only the services it needs (e.g., `TaskRouterDeps`, `CodespaceRouterDeps`). Type-check unused fields away.
- **Effort**: M
- **Links**: N/A

### F01-09: Lazy GC in TerraformComposeService leaks sessions when idle
- **Priority**: P2
- **Observation**: `TerraformComposeService.cleanupSessions()` (`terraform-compose.service.ts:85-100`) only runs when a new session is created (called at line 122). Other services use scheduled `setInterval` cleanup (e.g., `TaskCreationService:214`, `SandboxStateManager:34`, `SessionPresenceService:232`). If the compose UI is unused for a period, stale SDK sessions and durable streams remain in memory indefinitely until a new compose begins.
- **Risk**: Memory growth under intermittent use; durable streams not cleaned.
- **Recommendation**: Either start a cleanup interval in the constructor and register it with shutdown, or document explicitly that compose sessions are bounded by `MAX_SESSIONS` eviction only.
- **Effort**: S
- **Links**: [`specs/events_review/README.md`](../events_review/README.md)

### F01-10: Interval timers bypass the shutdown registry in several services
- **Priority**: P2
- **Observation**: Many services start `setInterval` timers during construction but only some register cleanup with the `GracefulShutdown`. Registered: session presence (via `sessionService.destroy`), schedulers, agent orphan sweep, task-creation cleanup. Not registered: `SandboxStateManager.planCleanupInterval` (`sandbox-state.ts:34`) — it exposes `dispose()` but nothing calls it during shutdown; the containerAgentService dispose path does cover it indirectly, but only when a containerAgentService was created. If sandbox init never finishes, nothing ever calls `SandboxStateManager.dispose()`. Similarly the `AgentRetryQueue` interval (`agent-retry-queue.ts:121`) has no visible shutdown registration in bootstrap.
- **Risk**: Tests leaking timers; process hangs on shutdown waiting for unref'd intervals; inconsistent cleanup invariants.
- **Recommendation**: Make "every `setInterval` in services/* has a matching shutdown.register" a lint or review rule. Audit and register all outstanding timers.
- **Effort**: S
- **Links**: N/A

### F01-11: Memory and Dream services are constructed eagerly but initialized asynchronously post-construction
- **Priority**: P3
- **Observation**: `MemoryService` is constructed in the service container (`service-container.ts:134`) but then `memoryService.initialize()` is called in phase 4.5 (`server-bootstrap.ts:67`) — a pattern that re-introduces the two-phase-init problem the `WorktreeService`/`TaskService` refactor was designed to eliminate. `DreamService` depends on `memoryService.getStore()` at construction time (`service-container.ts:139-144`), which works only because the store is available pre-initialize, but this is an undocumented invariant.
- **Risk**: Future refactors may cause the store to be null until `initialize()` runs; easy to reintroduce the stub-then-patch pattern.
- **Recommendation**: Either make `MemoryService` fully usable after construction (move async work into a lazy init on first call) or introduce a `MemoryServiceFactory.create()` async factory that returns a ready instance.
- **Effort**: S
- **Links**: N/A

### F01-12: Plan approval branching conflates two execution modes silently
- **Priority**: P2
- **Observation**: `TaskService.approvePlan` (`task.service.ts:194-236`) silently selects between container-mode and host-mode based on which optional trigger is wired. The container path (`containerAgentService.approvePlan`) and the host path (`agentExecutionService.resume`) have materially different semantics — different prompt composition, different session resume behaviour, different error shapes. Callers (the `/tasks/:id/approve-plan` route) cannot see which mode will run and there is no observable indicator.
- **Risk**: Confusing incident debugging; divergent test coverage; feature drift between modes.
- **Recommendation**: Return the execution mode in the response, or route host-mode through a dedicated endpoint. Ensure functional tests cover both paths end-to-end and assert `phase: 'execute'` + `sdkSessionId` propagation per the project CLAUDE.md rule.
- **Effort**: S
- **Links**: project `CLAUDE.md` — "Functional Tests: Real Service Transitions"

## Resolution notes (April 2026 remediation)

### F01-01 — Resolved
Added new bootstrap phase `src/server/bootstrap/phases/sandbox-reconciliation.ts`.
After `initSandboxProvider` completes (and before `sandboxState.reconciled` is
flipped), it lists the live sandboxes via `provider.list()` and cross-references
the `sandbox_instances` table:
- Live sandbox with no DB row → inserted into DB (adopted).
- DB row in an active status (`creating`/`running`/`idle`/`stopping`) with no
  matching live sandbox → marked `stopped` with `errorMessage = 'Marked
  terminated by sandbox reconciliation on startup'`.
Terminal statuses (`stopped`/`error`) are left untouched so historical records
are preserved. Tests: `tests/integration/sandbox-reconciliation.test.ts` (6
cases: orphan DB row, orphan provider row, no-op match, terminal-status
preservation, null provider, combined pass).

### F01-03 — Resolved
`/api/health` now accepts an `isSandboxReady` callback (F01-03). The bootstrap
wires it to `sandboxState.provider !== null && sandboxState.reconciled`. When
not ready, the endpoint short-circuits with HTTP 503 and
`{ status: 'initializing', message: '...' }`. Tests:
`src/server/routes/__tests__/health.test.ts` (4 new cases inside the F01-03
sandbox readiness gate describe block).

### F01-05 — Resolved
Introduced `BootstrapPhaseResult = { ok: true } | { ok: false, fatal: boolean,
error: Error }` in `src/server/bootstrap/types.ts`. The database, api-key
resolution, and schedulers phases now return this type explicitly. A new helper
`applyPhaseResult` in `server-bootstrap.ts` centralizes the policy:
fatal → `process.exit(1)`; non-fatal → log and continue. Individual phases no
longer call `process.exit` directly. Production (`NODE_ENV=production`) is
generally treated as fatal for missing keys / scheduler failures. Tests:
`src/server/bootstrap/__tests__/bootstrap-phase-result.test.ts` (8 cases:
phase result shapes and orchestrator policy).

## Open questions
- What is the intended restart policy for containers that outlive the server? Adopt, reap, or ignore? (affects F01-01, F01-06)
- Is there an operational SLA for "sandbox provider unreachable"? The 300s max backoff means prolonged degradation can be invisible (F01-03, F01-05).
- Should `ServiceContainer` evolve into per-request scoped sub-containers for future multi-tenant isolation, or is a single global container sufficient long-term? (F01-08)
- Are per-service singletons the right choice for `TerraformComposeService` and `CliMonitorService` at scale, or do they need horizontal partitioning? (F01-09)
