# 01 — Service Architecture (April 29 Review)

## Summary
The April 2026 P0/P1 remediation (PRs #176, #178, #179) genuinely landed three of the larger items: F01-01 sandbox reconciliation, F01-03 readiness gate, and F01-05 phase-result orchestration are now in code with tests. However, six of the original twelve findings are entirely unchanged (F01-02 partially, F01-06, F01-07, F01-08, F01-09, F01-12), and the bootstrap continues to harbor concrete defects unrelated to the prior review: the `EventOutboxRelayService` (F05-05) is wired in nowhere; `PlanModeService` is referenced by the router but never constructed in the server container; `TaskCreationService` is built without `settingsService`, silently disabling the configurable system prompt; codespace deletion never deletes Caddy durable streams; and the bootstrap-level `ContainerAgentService.setOnAgentComplete` callback is never wired so container-mode auto-dequeue is dead code. The "what changed" line: F01-01/03/05 are real fixes; F01-04/10/11 are partially mitigated by F12-04's BackgroundJobRegistry; the remaining items either survived intact or regressed.

## Findings

### F01-01: ServiceContainer.containerAgentService field is mutated post-construction and never read (P2, effort XS)
**Where**: `src/server/bootstrap/types.ts:107`, `src/server/bootstrap/service-container.ts:263`, `src/server/bootstrap/sandbox/sandbox-init.ts:141`
**What**: `ServiceContainer.containerAgentService` is declared in the type, initialized to `null` (`service-container.ts:263`), then mutated by `sandbox-init.ts:141` (`services.containerAgentService = sandboxState.containerAgentService;`). A `grep` for readers across `src/server/routes/`, `src/server/router.ts`, and `src/services/` finds zero non-test consumers — the only writer is sandbox-init, the only readers are tests.
**Why it matters**: Encourages new code to read it (since the field exists), discovers it is `null` for the full bootstrap pre-sandbox window, and re-introduces the very late-binding pattern the facade refactor was supposed to eliminate. Makes the `ServiceContainer` invariant lie ("this is a fully-built container").
**Fix**: Delete the field from `ServiceContainer` and from `sandbox-init.ts:141`. Routes should reach the container agent service through `taskService` (which is correctly wired via `setContainerAgentService`).
**Status vs April 20**: New finding (regression of F01-08 — the wider review).

### F01-02: TaskService.setWorktreeService() is dead code from the pre-CB-004 stub-then-patch era (P3, effort XS)
**Where**: `src/services/task.service.ts:364-370`
**What**: `setWorktreeService()` exists on `TaskService` and accepts a fresh worktree facet. `grep -rn 'setWorktreeService' src/` shows zero callers in production or in tests. The CB-004 refactor (referenced in `service-container.ts:154`) made the worktree service a constructor dependency, eliminating the need for late binding, but the setter was left behind.
**Why it matters**: Any code reviewer encountering this method might believe TaskService still tolerates partial init — opens the door to reintroducing the old anti-pattern. Knip could remove this, but it is a genuine incarnation of F01-02's late-binding hazard surviving the rename.
**Fix**: Delete the method.
**Status vs April 20**: Partially fixed. F01-02's broader concern (`setContainerAgentService`/`setAgentExecutionService` late-binding) is partly mitigated since `setAgentExecutionService` is now always called from `service-container.ts:192`, but `setContainerAgentService` is still only called from background `sandbox-init.ts:140`, and this orphan setter remains.

### F01-03: EventOutboxRelayService is implemented and migrated but never registered or started (P1, effort S)
**Where**: `src/services/event-outbox-relay.service.ts:39-60`, `src/db/migrations/0018_add_event_outbox.sql`, `src/db/migrations-pg/0012_add_event_outbox.sql`, `src/lib/background/job.ts:11`
**What**: The service is fully implemented as a `BackgroundJob` and is documented in `lib/background/job.ts:11` as "the first to adopt the interface" alongside `EventCleanupService` and `SchedulerService`. The DB migrations create the `event_outbox` table on both SQLite and Postgres. Yet `grep -rn 'EventOutboxRelay' src/server/ src/services/` outside the file itself finds nothing — `phases/schedulers.ts` registers `EventCleanupService` and the task scheduler, but never instantiates this relay.
**Why it matters**: The F05-05 contract says producers will insert into `event_outbox` inside the same transaction as the state change ("converts the previous best-effort dual-write into a durable, eventually-consistent publish pipeline"). Today nothing calls the relay, so any producer that adopts the contract will silently accumulate rows that never reach Caddy streams. Combined with the absence of producers (`grep -rn 'eventOutbox' src/services/` finds zero), this is dead infrastructure: the comment lies, the wiring is broken, and a future engineer who trusts the comment will introduce a real data-loss bug.
**Fix**: Either delete the service + migration entirely, or instantiate it in `phases/schedulers.ts` alongside `EventCleanupService` and register with the `BackgroundJobRegistry`. If keeping, also add a producer integration with the wiring (e.g., one in `session-stream.service`) so the path is exercised.
**Status vs April 20**: New (the service was added between April 20 and April 29).

### F01-04: PlanModeService is declared in the router but never constructed in the server bootstrap (P1, effort XS)
**Where**: `src/server/router.ts:37,290,653,666`, `src/services/plan-mode.service.ts:777-784`, `src/app/services/services.ts:95-101`
**What**: `RouterDependencies.planModeService?: PlanModeService` is declared in `router.ts:290`. The router passes it through to `createAdminMetricsRoutes` and `createMetricsRoutes` (`router.ts:653,666`). `service-container.ts` and `server-bootstrap.ts` never construct it. The factory `createPlanModeService` is called only in browser-side `src/app/services/services.ts:95-101` (which is a different service tree). Therefore `/api/admin/metrics/plan-mode` always returns the empty stub branch (`admin-metrics.ts:24-37`).
**Why it matters**: F05-02 was specifically about surfacing dropped event counters via this endpoint. The endpoint pretends to work (returns 200, returns zeros) but is never connected to the actual `PlanModeService` instance that browser clients use, so any drops there are invisible from the server's metrics endpoint. False signal.
**Fix**: Construct `PlanModeService` in `service-container.ts` after `durableStreamsService`, add it to `ServiceContainer` and `RouterDependencies`, and pass through `phases/router.ts`.
**Status vs April 20**: New (April 20 didn't surface this; the router was simpler then).

### F01-05: TaskCreationService is constructed without settingsService — silent feature regression (P1, effort XS)
**Where**: `src/server/bootstrap/service-container.ts:166`, `src/services/task-creation.service.ts:207-217,598-599,915-916,2616-2622`
**What**: `createTaskCreationService(db, durableStreamsService, sessionService)` is the server-side call (line 166). The factory signature is `createTaskCreationService(db, streams, sessionService?, settingsService?)`. The browser-side equivalent at `src/app/services/services.ts:104-109` correctly passes `settingsService` as the fourth argument. Server-side does not. Inside the service:
- `task-creation.service.ts:598-599`: `this.settingsService ? await this.settingsService.getTaskCreationModel() : ...` — server-side falls back to `DEFAULT_TASK_CREATION_MODEL` regardless of admin override.
- `task-creation.service.ts:915-916`: `this.settingsService ? await resolvePromptServer('task-creation', this.settingsService) : ...` — server-side uses the hard-coded prompt.
**Why it matters**: Every customisation knob the admin UI provides for task creation (model override, custom system prompt) silently does nothing on the server side. Users see the setting accepted by the API but task creation behaves identically.
**Fix**: Pass `settingsService` as the fourth argument in `service-container.ts:166`.
**Status vs April 20**: New (April 20 reviewed task-creation as a monolith but didn't catch the missing wire).

### F01-06: ContainerAgentService.setOnAgentComplete callback is never wired in bootstrap, leaving container-mode auto-dequeue dead (P2, effort S)
**Where**: `src/services/container-agent/container-agent.service.ts:159-161`, `src/services/container-agent/container-exec.service.ts:1191-1200`, `src/services/container-agent/agentcore-bridge.service.ts:530-540`
**What**: `ContainerAgentService.setOnAgentComplete(callback)` exists. The container-exec and agentcore-bridge handlers read it via `this.onAgentCompleteCallback?.()` and call the returned function on completion. `grep -rn 'setOnAgentComplete' src/` outside the service itself returns no production hits — neither `service-container.ts`, `sandbox-init.ts`, `server-bootstrap.ts`, nor any route module ever calls it. Every container-mode agent completion therefore returns `undefined` from the getter and skips auto-dequeue.
**Why it matters**: Host-mode auto-dequeue works (`agent-execution.service.ts:828` and `:1346` via `tryDequeueAndStart`), so users see the queue advance after their host-mode agent finishes — but in container-mode (the default for sandboxed deployments) the queue never advances, completed tasks pile up, and operators have to manually move queued tasks. This is a silent regression of F01-12-class behaviour: the path looks wired but is half-stubbed.
**Fix**: In `service-container.ts` after both `agentService` and `containerAgentService` are available, wire the callback. Concretely: in `sandbox-init.ts` after `services.taskService.setContainerAgentService(...)`, also call `sandboxState.containerAgentService.setOnAgentComplete((codespaceId, taskId) => services.agentService.tryDequeueForCodespace(codespaceId, taskId))` (where `tryDequeueForCodespace` is exposed publicly from `AgentExecutionService.tryDequeueAndStart`'s logic, currently private).
**Status vs April 20**: New.

### F01-07: Codespace deletion does not delete Caddy durable streams (only DB rows) (P2, effort S)
**Where**: `src/services/codespace.service.ts:394-453`, `src/services/durable-streams.service.ts:652-657`, `src/services/session/session-crud.service.ts:270-290`
**What**: `CodespaceService.delete()` correctly deletes `session_events` rows for the codespace's sessions, plans, and sandbox lifecycles (`codespace.service.ts:441-447`). However it never calls `streams.deleteStream(...)` for any of those stream IDs, and the constructor (`codespace.service.ts:111-125`) does not even take a `DurableStreamsService` reference. `SessionCrudService.delete()` at line 270-290 has the same problem: it deletes the DB row and presence map but does not call `streams.deleteStream(id)`. Compare `terraform-compose.service.ts:90,103,139,166,533,556` — every Terraform path explicitly calls `deleteStream`.
**Why it matters**: Caddy retains the stream metadata indefinitely. Over time the durable streams server accumulates dead streams. The CLAUDE.md "Durable Stream ID Patterns" table explicitly states that session, plan, and sandbox streams have "Durable (DB + Caddy)" persistence and are cleaned up by codespace deletion — the current code only cleans the DB half.
**Fix**: Inject `DurableStreamsService` into `CodespaceService` (and `SessionCrudService`'s delete path); for each `eventSessionId` in `codespace.service.ts:441-445`, call `await durableStreams.deleteStream(eventSessionId)` (or `Promise.allSettled` for parallel best-effort).
**Status vs April 20**: New (this was alluded to in the events-streams review on April 20 but not surfaced as a service-architecture finding).

### F01-08: Three of the original April 20 findings remain entirely unchanged (P2 each, effort varies)
**Where**:
- F01-06 (two overlapping running-agent maps): `src/services/container-agent/sandbox-state.ts:19-22`, `src/services/agent/agent-execution.service.ts:83-88`
- F01-07 (TaskCreationService 2,623-line monolith): `src/services/task-creation.service.ts` still 2,623 lines (`wc -l` confirms unchanged)
- F01-08 (ServiceContainer carries 30 fields, routes receive whole graph): `src/server/router.ts:250-291` still 30+ fields in `RouterDependencies`
- F01-09 (TerraformComposeService lazy GC only): `src/services/terraform-compose.service.ts:85-108,122` still calls `cleanupSessions()` only at start of new compose; no `setInterval`, no shutdown registration, no constructor-side timer
- F01-12 (plan approval branching conflates container/host modes silently): `src/services/task.service.ts:271-314` still selects mode based on which optional service is wired, no observable indicator
**What**: Each is verifiable as unchanged by reading the current files at the cited lines.
**Why it matters**: The April 20 review estimated effort at S/M for each. Six months of remediation has not allocated any of them.
**Fix**: See April 20 findings. F01-06 in particular interacts with F01-01 reconciliation: if reconciliation is called (`sandbox-init.ts:190`) it consults SandboxStateManager, but nothing reconciles `AgentExecutionService.runningAgents` against DB so host-mode crashes leak Map entries between provider/db/in-process.
**Status vs April 20**: Unchanged (5 individual findings rolled into one entry).

### F01-09: server-config.ts still calls process.exit(1) directly, bypassing F01-05 phase-result mechanism (P2, effort XS)
**Where**: `src/server/bootstrap/server-config.ts:100,127,141,155,167`
**What**: F01-05 was supposed to centralise fatal-vs-non-fatal phase decisions through `applyPhaseResult`. The fix was applied to `database.ts`, `api-key-resolution.ts`, and `schedulers.ts` (which now return `BootstrapPhaseResult`). However `parseServerConfig()` — which is Phase 1 in `server-bootstrap.ts:63` — still calls `process.exit(1)` directly five times for: invalid Postgres pool config, invalid env, missing `DATABASE_URL` for Postgres, `SKIP_AUTH=true` in production, dev-auth helper disagreement.
**Why it matters**: Tests cannot exercise the config phase under failure modes without the test harness inheriting `process.exit`. More importantly, the comment at `database.ts:37` ("Replaces the old `process.exit` call with a fatal phase result (F01-05)") is misleading because the partner phase right above it still uses raw exit.
**Fix**: Make `parseServerConfig` either return `BootstrapPhaseResult | ServerConfig` or throw a typed error class that `server-bootstrap.ts:63` translates via `applyPhaseResult('config', ...)`. Mirrors the `MissingDatabaseUrlError` pattern in `phases/database.ts:28-33`.
**Status vs April 20**: Partially fixed (F01-05 covered phases 2/4/8 but not phase 1).

### F01-10: Recovery phase result is not surfaced through applyPhaseResult, errors are silently logged-only (P2, effort XS)
**Where**: `src/server/bootstrap/server-bootstrap.ts:74-80`, `src/server/bootstrap/phases/recovery.ts:163-194`
**What**: `runRecovery()` returns `{ errors: Error[] }` rather than `BootstrapPhaseResult`. The bootstrap (lines 76-80) only logs a warning when errors are non-empty. The four sub-phases inside `runRecovery` each individually catch and log, then accumulate errors. There is no path by which a recovery failure is fatal even in production, regardless of how broken the DB state is.
**Why it matters**: F01-05's stated goal was uniform fatal/non-fatal policy across all phases. Recovery — which resets stale agents/tasks — is the one phase where a silent failure produces the most operator confusion: agents stay marked `running` in the DB after a crash, the UI shows them as alive, and the operator has no signal.
**Fix**: Either upgrade `runRecovery` to return `BootstrapPhaseResult` (with `fatal: process.env.NODE_ENV === 'production'`), or accept that recovery is best-effort and add a metric/log line counting accumulated `errors.length` to the regular bootstrap output rather than only on the warn branch.
**Status vs April 20**: Partially fixed (the F01-05 mechanism exists, but recovery wasn't migrated).

### F01-11: SIGTERM during early bootstrap window has no signal handler installed (P2, effort XS)
**Where**: `src/server/bootstrap/server-bootstrap.ts:154-261`
**What**: `Bun.serve()` starts at line 154-158. `shutdown.installSignalHandlers()` runs at line 261, after registering all cleanups and after starting schedulers. There is roughly a ~100ms window where the server accepts traffic but no `SIGINT`/`SIGTERM` handler is registered. In that window, signal delivery defaults to Node's behaviour: SIGTERM = `process.exit(0)` immediately; SIGINT = print stack and exit. None of the registered LIFO cleanups (database close, sandbox flush, agent flush) run.
**Why it matters**: Container orchestrators (k8s, ECS) routinely send SIGTERM during pod startup if the deploy is rolled back or a readiness probe fails. The 30s grace period from `GracefulShutdown` doesn't help if the handlers aren't yet installed.
**Fix**: Move `shutdown.installSignalHandlers()` to run BEFORE `Bun.serve()` (e.g., right after `new GracefulShutdown()` is created). Cleanups can be registered later — `installSignalHandlers` only attaches `process.on('SIGINT', ...)` listeners, which are safe to attach to an empty cleanups array (the handler reads `this.cleanups` lazily).
**Status vs April 20**: New finding (the April 20 review did not look at signal-handler ordering).

### F01-12: Agent-runner has no SIGTERM/SIGINT handler — graceful container stop loses the agent:error event (P2, effort S)
**Where**: `agent-runner/src/index.ts:312-357,1580-1594`
**What**: `agent-runner/src/index.ts` registers `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` but no signal handlers. When the host calls `container-exec.service.ts:826` to write the sentinel stop file, the agent inspects the file and exits cleanly. But if the host (or the orchestrator) instead sends `SIGTERM` directly to the container (e.g., `docker stop` from outside the host's stop path, k8s pod eviction), the agent process dies without flushing the agent-completion or agent-error event, leaving the host's `ContainerExecService.handleAgentComplete` path waiting on a stream that will never produce more events. The host eventually times out via `agentcore-bridge.service.ts:306-310`'s `setTimeout(maxRuntimeMs)`, but that's hours later.
**Why it matters**: The F11-03 host-side `flushRunningAgents` path (`server-bootstrap.ts:245-259`) emits `agent:interrupted` events for the UI on host shutdown — but the symmetric agent-side response (catch the SIGTERM, write a final event) is missing, so a host-initiated container stop produces a truncated event stream that doesn't say *why* the agent stopped.
**Fix**: In `agent-runner/src/index.ts` near line 308 (where config is parsed), add `process.on('SIGTERM', signalHandler)` and `process.on('SIGINT', signalHandler)` where `signalHandler` (a) emits an `agent:error` event with `code: 'INTERRUPTED'`, (b) calls `flushAndExit(143)` (standard SIGTERM exit code).
**Status vs April 20**: New (April 20 reviewed agent-runner only superficially).

### F01-13: AgentExecutionService.stopAll() is never called on shutdown — host-mode AbortControllers leak (P2, effort XS)
**Where**: `src/services/agent/agent-execution.service.ts:1665-1675`, `src/server/bootstrap/server-bootstrap.ts:184-259`
**What**: `AgentExecutionService.stopAll()` aborts every entry in `runningAgents`, clears all the maps. `grep -rn 'stopAll' src/server/` shows it is only called by tests and by `BackgroundJobRegistry.stopAll()` (which iterates registered BackgroundJobs — AgentExecutionService is not one). The `flushRunningAgents` shutdown step (line 245-259) marks agents as `paused` in DB and emits `agent:interrupted` events but does NOT abort the in-process AbortControllers. Result: on shutdown, host-mode agents continue running their Claude SDK calls and write to a DB connection that is about to close.
**Why it matters**: SQLite handle close in `database` cleanup runs LAST (line 166), but in-flight DB writes from host-mode agents racing the close produce `SQLITE_MISUSE` errors at shutdown. Postgres pool close (`pgClient.end()`) waits for in-flight queries by default, but the agents are still running their Claude SDK calls and consuming API quota.
**Fix**: Add `shutdown.register('agentExecutionStop', () => services.agentService.stopAll())` after `flushRunningAgents` is registered. Since LIFO, this runs after flush sets DB state but before the database close. (`stopAll` exists on `AgentExecutionService` but is not exposed on the `AgentService` facade — also fix that surface.)
**Status vs April 20**: New (the F11-03 agent-shutdown phase was added in PR #176 but only handles the DB-and-events side; the in-process AbortController side was missed).

### F01-14: Sandbox provider lazy re-init in dev triggers from a getter, racing with `initializing` flag (P3, effort XS)
**Where**: `src/server/bootstrap/server-bootstrap.ts:111-133`
**What**: `getSandboxProvider` is called by every route that needs the provider (e.g., sandbox-status, K8s, Nomad, container-agent). In dev mode, when the provider is null, the getter triggers an async re-init in the background and returns null synchronously. The guard `!sandboxState.retryTimer && !sandboxState.initializing` prevents concurrent re-inits, but `sandboxState.initializing = true` is set on the same line as the call to `initSandboxProvider`, then reset in `.finally()`. If two requests hit `getSandboxProvider` in the same microtask before the assignment runs, both pass the guard and both kick off re-init. (Realistically rare given Bun's single-threaded event loop, but possible if `Promise.all([fetch1, fetch2])` happens.)
**Why it matters**: Concurrent provider init can race in `initSandboxProviderCore` (no internal mutex), which may double-register heal intervals or call `services.taskService.setContainerAgentService` twice with two different ContainerAgentService instances. The first ContainerAgentService becomes orphaned (no shutdown registration since it was overwritten in `sandboxState`).
**Fix**: Set `sandboxState.initializing = true` before the conditional block check, or use `Promise.resolve().then()` to enforce a tick ordering. Alternatively, check `sandboxState.initializing` first and bail.
**Status vs April 20**: New.

### F01-15: Bootstrap phase comment numbering is off-by-one and gives misleading documentation (P3, effort XS)
**Where**: `src/server/bootstrap/server-bootstrap.ts:46-60`
**What**: The class doc comment lists 10 phases, numbered 1-10. The implementation phases are labeled in code as 1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9, 10, 11. Phase 4.5 (Memory init, line 88-89) is undocumented; phases 6 (Sandbox state init) and 7 (Router) are documented as 5 and 6 in the doc comment; the comment claims "Initialize sandbox provider (background, non-blocking)" is phase 9 but the code calls it phase 11. The reader cannot match doc to code.
**Why it matters**: Future review and migration relies on this list. The next reviewer cannot trust the comment. Already two distinct phase number schemes exist in the same file.
**Fix**: Rewrite the comment to match the code labels (1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9, 10, 11) and explicitly note Phase 4.5 (Memory). Or better, remove the duplicated numbered list — the inline phase comments are the source of truth.
**Status vs April 20**: New (the doc was added during the F01-05 fix and immediately drifted).

## What was fixed since April 20
- **F01-01 reconciliation phase landed** — `src/server/bootstrap/phases/sandbox-reconciliation.ts` (new file, 240 lines) implements adopt-or-terminate cross-reference between `sandbox_instances` DB rows and provider `list()` output. Wired in `sandbox-init.ts:183-198` as `runSandboxReconciliation`, called both on initial init success (`sandbox-init.ts:291`) and on retry success (`sandbox-init.ts:242`). Tests at `tests/integration/sandbox-reconciliation.test.ts` cover six cases.
- **F01-03 readiness gate landed** — `server-bootstrap.ts:141` defines `isSandboxReady = () => sandboxState.provider !== null && sandboxState.reconciled`, passed to router (`phases/router.ts:22`), enforced in `src/server/routes/health.ts:67-81` returning HTTP 503 with `status: 'initializing'` until both flags flip true.
- **F01-05 phase-result orchestration landed** — `BootstrapPhaseResult` type at `bootstrap/types.ts:149`, `applyPhaseResult` helper at `server-bootstrap.ts:35-44`. `tryInitializeDatabase`, `resolveApiKey`, and `startSchedulers` now return this shape. Tests at `bootstrap/__tests__/bootstrap-phase-result.test.ts`. Caveat: phase 1 (config) still uses raw exit (see F01-09).
- **F12-04 BackgroundJobRegistry partial migration** — `src/lib/background/job.ts` defines the interface and registry. `EventCleanupService`, `SchedulerService`, and `EventOutboxRelayService` implement `BackgroundJob`. The registry is registered via `phases/schedulers.ts:50-61`. This indirectly mitigates F01-10 for the migrated services. Caveat: `EventOutboxRelayService` is implemented but never instantiated (see F01-03 above); other timer owners (`SandboxStateManager`, `TaskCreationService`, `AgentExecutionService.orphanSweep`, `CliMonitorService`) still register cleanup via the older `shutdown.register` API directly.
- **F11-03 agent-shutdown phase added** — `src/server/bootstrap/phases/agent-shutdown.ts` (new file) snapshots running agents at SIGTERM, publishes `agent:interrupted` events, marks rows `paused`, and best-effort stops backing sandboxes. Bounded by 10s budget. Registered last (runs first via LIFO) in `server-bootstrap.ts:245-259`. Tests at `bootstrap/__tests__/agent-shutdown.test.ts`. Caveat: in-process AbortControllers are not aborted (see F01-13).

## Out of scope (intentionally not reviewed here)
- Specific Drizzle ORM patterns (covered in 04/06 reviews)
- Stream protocol / event envelopes (covered in 05-event-streaming)
- RBAC / auth / sandbox security model (covered in 06-security)
- Test-infrastructure quality and shard balance (covered in 09-testing)
- CI/CD, Docker images, deployment config (covered in 11-operations-deployment)
- The `cli-monitor` service's missing `await` on `db.query.settings.findFirst` at `src/services/cli-monitor/cli-monitor.service.ts:293` — a real bug but not service-architecture
