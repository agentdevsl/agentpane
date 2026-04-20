# Agent Execution Subsystem — Architecture Review (April 2026)

## Summary

AgentPane runs Claude agents through two nearly-parallel pipelines: a **host-mode** path (`AgentExecutionService` → `runAgentPlanning`/`runAgentExecution`) that embeds the Claude Agent SDK directly in the Bun process, and a **container-mode** path (`ContainerAgentService` → `ContainerExecService` → `agent-runner` in Docker/K8s/Nomad) that shells out to a separate package via JSON-over-stdout. A third path for **AWS Bedrock AgentCore** is fully scaffolded but is no longer reachable from bootstrap after migration `0011_drop_agentcore_columns.sql`. The two live paths have drifted substantially in behaviour (plan/execution transitions, error bubbling, plan-option propagation, session resume, hook support). A single planning → approval → execution state machine exists in the spec but is realised differently on each side, and several `ExitPlanMode` affordances (`launchSwarm`, `teammateCount`, `allowedPrompts`) are carried through the data pipe but never executed by either runtime. Plan TTL and orphan sweeps are in place, but both have fragile single-timer designs that will silently stop running on a single throw.

## Map

| Layer | File | Role |
|-------|------|------|
| Facade | `src/services/agent.service.ts:50` | Composes CRUD/Execution/Queue services; wires orphan sweep |
| Host-mode lifecycle | `src/services/agent/agent-execution.service.ts:74` | `start`/`stop`/`pause`/`resume`; in-memory `runningAgents`, `agentStartTimes`, `preToolHooks`, `postToolHooks` |
| Host-mode SDK loop | `src/lib/agents/stream-handler.ts:431,866` | `runAgentPlanning` / `runAgentExecution` — direct Claude SDK session, topology, chunk batching |
| SDK env helper | `src/lib/agents/agent-sdk-utils.ts:48` | `buildSdkEnv` — strips `CLAUDECODE`, DB creds, secrets before spawning subprocess |
| Container facade | `src/services/container-agent/container-agent.service.ts:46` | Routes `startAgent` to container-exec or AgentCore bridge; owns reconcile |
| Container state | `src/services/container-agent/sandbox-state.ts:17` | `runningAgents`, `runningAgentCoreAgents`, `pendingPlans`, `startingAgents`; plan TTL interval |
| Container exec path | `src/services/container-agent/container-exec.service.ts` | Docker/K8s/Nomad lifecycle, env propagation, stdout bridge wiring |
| Plan approval | `src/services/container-agent/plan-approval.service.ts:26` | `handlePlanReady`/`approvePlan`/`rejectPlan`, skill-chain swap, sandbox-change detection |
| Container → DS bridge | `src/lib/agents/container-bridge.ts` | Parses JSON-lines from container stdout, maps to durable-stream events |
| AgentCore → DS bridge | `src/lib/agents/agentcore-bridge.ts` | Mirror of container-bridge for AWS AgentCore SSE invocations (dead from bootstrap) |
| Agent runner | `agent-runner/src/index.ts`, `agent-runner/src/agentcore-handler.ts` | Child-process entry points; reads OAuth into `~/.claude/.credentials.json`; resumes SDK session on plan approval |
| Recovery | `src/server/bootstrap/phases/recovery.ts` | Boot-time reset of `starting/planning/running` agents to `idle`; orphan task rollback; worktree-ref clearing |
| Orphan sweep | `src/services/agent/agent-execution.service.ts:1347` | 10-minute `setInterval` aborting agents past `getAgentMaxRuntimeMs` (default 4 h) |
| Hooks (wired only to host path) | `src/lib/agents/hooks/*` | Whitelist/streaming/audit PreToolUse / PostToolUse — constructed but never installed in SDK session |

## What's working

- **Clean lifecycle decomposition.** `AgentService` is a thin facade; CRUD, Execution, Queue are separated and test-friendly.
- **Transactional `start`.** `src/services/agent/agent-execution.service.ts:391` wraps the task-column / agent-status / agent-run insert in a single Drizzle transaction and compensates (worktree + session deletion) on failure.
- **Recovery on boot.** `resetStaleAgents`/`recoverOrphanedTasks`/`cleanOrphanedWorktrees` fire before services are wired, preventing phantom "running" UI state.
- **Host-mode runtime timeout.** Both planning and execution install `setTimeout(maxRuntimeMs)` that aborts the SDK stream and emits a structured `agent:stopped{reason:'timeout'}` event (`stream-handler.ts:447,877`). External abort signals also fan in.
- **Topology tracking.** `handleTopologySystemMessage` maps SDK `task_id` to a generated `nodeId`, emits `topology:agent_spawned/progress/completed`, and on error flushes any in-flight nodes to `status:'failed'` (`stream-handler.ts:1304`).
- **Idempotency guards on plan approval.** `handlePlanReady` checks `hasPendingPlan` and also CAS-updates the task with `where(column='in_progress')` (`plan-approval.service.ts:55,117`); `rejectPlan` CAS-updates with `where(lastAgentStatus='planning')` (`plan-approval.service.ts:502`).
- **Plan persistence + recovery across restart.** Plan text, `sdkSessionId`, and `planningSandboxId` are written to `tasks.plan`/`tasks.planOptions` and re-hydrated by `getPendingPlan` (`plan-approval.service.ts:195`).
- **Sandbox-change detection on approval.** `planData.sandboxId` is compared against the current codespace sandbox; on mismatch the `sdkSessionId` is discarded so the resumed agent-runner falls back to a fresh session with full plan text (`plan-approval.service.ts:366`).
- **Env sanitisation.** `buildSdkEnv` (`agent-sdk-utils.ts:48`) blocks `CLAUDECODE`, `DATABASE_URL`, `DB_*`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `GITHUB_APP_PRIVATE_KEY` before subprocess launch — a real footgun for SDK-in-process runs.
- **agent-runner hardening.** `resolveWorkspacePath`/`resolveStopFilePath` (`agent-runner/src/index.ts:351,362`) enforce that `AGENT_CWD` stays inside `/workspace` and `AGENT_STOP_FILE` inside `/workspace` or `/tmp`; `uncaughtException`/`unhandledRejection` handlers best-effort emit an `error` event and sync-exit.

## Findings

### F1 — AgentCore path is dead code but still present in two packages

**Priority:** P1
**Observation:** `ContainerAgentService.setAgentCoreProvider` (`container-agent.service.ts:153`) is invoked only from tests; nothing in `server-bootstrap.ts` or `sandbox-init.ts` calls it. Migration `src/db/migrations/0011_drop_agentcore_columns.sql` removed the storage that previously drove configuration. Meanwhile the entire AgentCore stack is still shipped: `src/lib/agents/agentcore-bridge.ts`, `src/services/container-agent/agentcore-bridge.service.ts`, `src/lib/sandbox/providers/agentcore-sandbox-*.ts`, and `agent-runner/src/agentcore-handler.ts` (577 LOC) all compile into the build. `agent-runner/package.json:16` still ships `bedrock-agentcore@^0.2.2` as a runtime dep.
**Risk:** Dual runtimes to test and maintain for a feature users cannot enable. Fresh changes to plan-approval, skill-chaining, team-mode, event shapes must be mirrored to the AgentCore branch by contributors who cannot exercise it. `'agentcore'` enum member (`src/db/schema/shared/enums.ts:62`) keeps the concept "real" to type-checks while there is no boot path.
**Recommendation:** Either (a) archive AgentCore behind a feature flag and delete the bridge/handler/provider from the default build; or (b) restore a configuration surface (settings table + UI) and add at least one functional test that starts an AgentCore agent end-to-end. Document the decision in `specs/diagrams/02-agent-execution-flow.md`.
**Effort:** M (1–2 d) to excise; L to restore parity.
**Links:** `specs/application/state-machines/agent-lifecycle.md`, `specs/sandbox/` (provider matrix).

### F2 — Tool-use hooks are registered but never installed in the SDK session

**Priority:** P1
**Observation:** `AgentExecutionService` maintains `preToolHooks` and `postToolHooks` maps (`agent-execution.service.ts:82-83`), exposes `registerPreToolUseHook`/`registerPostToolUseHook` (`agent-execution.service.ts:1328,1337`), and deletes the entries on six cleanup paths. `src/lib/agents/hooks/index.ts` constructs a `createAgentHooks({ PreToolUse: [whitelist, streaming], PostToolUse: [audit, streaming] })`. `stream-handler.ts` contains **zero** references to either map — `runAgentPlanning`/`runAgentExecution` only wire a local `canUseTool` callback and never accept hooks through `StreamHandlerOptions`.
**Risk:** Silent security regression. The tool-whitelist hook, audit hook, and streaming hook are not enforcing or recording anything for host-mode runs. `allowedTools` passed via config is honoured by the SDK's own permission layer, but any richer logic added to `createToolWhitelistHook` (e.g. deny-list, per-skill allow lists, path scoping) is inert. No caller notices because the hook registration API returns `void`.
**Recommendation:** Either thread the hook arrays through `StreamHandlerOptions` into `canUseTool` (run PreToolUse before `{behavior:'allow'}`, PostToolUse on `tool:result`), or remove the dead registration API. Add a unit test that asserts a registered PreToolUse hook is invoked when a tool fires in planning/execution.
**Effort:** M.
**Links:** `specs/application/security/` (tool permission model), `specs/events_review/` (event ordering).

### F3 — Plan-option fields (`launchSwarm`, `teammateCount`) are carried end-to-end but never acted on

**Priority:** P1
**Status:** Resolved (theme-03). Fields `launchSwarm`, `teammateCount`, and `pushToRemote` deleted from `ExitPlanModeOptions`, `PlanData`, `PlanReadyData`, `AgentCorePlanReadyData`, `ContainerAgentPlanReadyEvent`, `AgentPlanReadyData`, and the in-flight `handlePlanReady` callback shapes on both `container-agent.service.ts` and `container-exec.service.ts`. The SDK's own `task_started` subagent spawning continues to provide concurrency. CLAUDE.md "Team Mode" documentation is out of scope for this worktree; flagged as a follow-up doc fix.
**Observation (archived):** `ExitPlanModeOptions` (`stream-handler.ts:92`) declared `launchSwarm` and `teammateCount`; `PlanReadyData`/`PlanData`/`AgentCorePlanReadyData` propagated them. Plan approval logged them but passed only `prompt`, `phase`, `sdkSessionId` to `startAgentFn`. `runAgentExecution` never read these fields. Nothing in `container-exec.service.ts` spawned multiple `agent-runner` processes.

### F4 — `allowedPrompts` are captured but never added to the execution `allowedTools`

**Priority:** P2
**Observation:** Host-mode `runAgentPlanning` captures `exitPlanModeOptions.allowedPrompts` into `planOptions` (`stream-handler.ts:799`) and publishes them on `agent:plan_ready`. On approval, `executeAgentExecution` (`agent-execution.service.ts:1111`) passes only `agent.config.allowedTools` to `runAgentExecution`. The `allowedPrompts` array — a per-plan whitelist of pre-approved Bash invocations — is not merged into the SDK permission layer. Container mode has the same gap: `container-exec.service.ts` emits `AGENT_ALLOWED_TOOLS` but `allowedPrompts` are never serialised.
**Risk:** The plan author's contract ("these bash commands are safe to run without per-invocation prompts") is ignored; agents will still hit interactive Bash prompts. Users see "plan approved" then the agent stalls waiting for a permission approval that never comes.
**Recommendation:** In both paths, derive a Bash-prompt allow list from `planOptions.allowedPrompts` and feed it into the SDK permission layer (SDK v0.2.113 exposes `canUseTool` — compare `input` prompt against the list). Add a functional test asserting a pre-approved Bash command executes without prompting.
**Effort:** M.
**Links:** `specs/application/security/` (tool permission model).

### F5 — Host-mode cannot resume an SDK session across plan approval

**Priority:** P1
**Observation:** The container-runner supports `AGENT_SDK_SESSION_ID` and calls `unstable_v2_resumeSession` so the execution phase inherits the planning conversation (`agent-runner/src/index.ts:914`). Host-mode `runAgentExecution` has no analogue — it calls `unstable_v2_createSession` unconditionally with a freshly-built "Execute the following approved plan: …" prompt (`agent-execution.service.ts:932`, `stream-handler.ts:947`). There is no `sdkSessionId` plumbing in `StreamHandlerOptions`.
**Risk:** Host mode pays full context cost (plan restatement) and loses the planning-phase reasoning/tool-use history. Behaviour is semantically different from container mode, invalidating shared functional tests. The CLAUDE.md "Functional Tests" rule that plan approval must pass `sdkSessionId` describes container-mode only.
**Recommendation:** Either thread `sdkSessionId` into host-mode (capture it from the SDK `init` message the same way agent-runner does, persist it on the agent row or task plan options, resume on approval) or document host-mode as a compatibility layer with explicit behavioural differences.
**Effort:** M.
**Links:** `specs/application/state-machines/agent-lifecycle.md` (plan → execute edge).

### F6 — `rejectPlan` has no host-mode fallback

**Priority:** P1
**Observation:** `TaskService.approvePlan` (`task.service.ts:196-236`) has both a container path and a host-mode path (`agentExecutionService.resume`). `TaskService.rejectPlan` (`task.service.ts:242-250`) short-circuits with `CONTAINER_AGENT_SERVICE_UNAVAILABLE` status 503 when the container service is not wired.
**Risk:** In a deployment running host-mode agents (no Docker/K8s), users hit an un-rejectable plan. Tasks sit in `waiting_approval` forever and the worktree leaks. The state machine's `plan → backlog` edge is unreachable.
**Recommendation:** Add a host-mode reject path that (a) updates `task.column='backlog'`, clears `plan`/`planOptions`/`lastAgentStatus`, and (b) calls `agentExecutionService.stop(agentId)` or sets agent back to idle and removes the worktree via `worktreeService.remove`. Mirror the atomic CAS (`where lastAgentStatus='planning'`) from container mode.
**Effort:** S.
**Links:** `specs/application/state-machines/agent-lifecycle.md`, `specs/application/state-machines/task-workflow.md`.

### F7 — Orphan sweep timer silently dies if any one iteration throws

**Priority:** P2
**Observation:** `startOrphanSweep` (`agent-execution.service.ts:1347`) uses `setInterval` with a synchronous callback. `sweepOrphanedAgents` does fire-and-forget `void getAgentMaxRuntimeMs(this.db).then(...).catch(...)` and the DB update is `.catch(...)`, but if a synchronous throw ever escapes the loop (e.g. future refactor introduces a bug in the `for…of` iteration or a logger throw), the timer keeps firing but every subsequent iteration sees stale state. Worse, there is no test ensuring the sweep still runs after a first exception.
**Risk:** Long-tail leak: one bad interval → sweeps stop forever → agents that crash without cleanup stay "running" until server restart. Discoverable only through UI stuck-state reports.
**Recommendation:** Wrap the body in `try/catch` that logs but does not rethrow. Add a health metric (`agent.orphan_sweep.last_run_at`) and a test that throws inside the loop and verifies the next tick still executes. Consider replacing the field-based interval with a `setTimeout`-chain that is explicitly rescheduled after each iteration.
**Effort:** S.
**Links:** `specs/events_review/` (observability of background work).

### F8 — Plan-TTL cleanup has the same single-timer fragility and no metric

**Priority:** P2
**Observation:** `SandboxStateManager` constructs a `setInterval(cleanupExpiredPlans, PLAN_CLEANUP_INTERVAL_MS)` in its constructor (`sandbox-state.ts:34`). `cleanupExpiredPlans` (`sandbox-state.ts:176`) is synchronous and only touches a Map, but the same pattern as F7 applies. TTL is 60 min with a 5 min sweep; no DB-level expiry — expired plans persist in `tasks.plan`/`tasks.planOptions` because cleanup only removes the in-memory cache. On server restart, `getPendingPlan` (`plan-approval.service.ts:188`) re-hydrates plans with no TTL check, so a 10-day-old plan is still approvable.
**Risk:** In-memory expiry is a UX convenience, not an actual policy. Stale plans can be approved and re-execute against a long-changed codebase.
**Recommendation:** Either enforce TTL on re-hydration (reject `getPendingPlan` if `task.updatedAt` older than 1 h and `column='waiting_approval'`) or persist a `planExpiresAt` column and surface it in the UI. Add the same `try/catch` guard as F7.
**Effort:** S.
**Links:** `specs/application/state-machines/agent-lifecycle.md` (plan validity window).

### F9 — Recovery phase and orphan sweep can race with incoming requests

**Priority:** P2
**Observation:** `runRecovery` (`server-bootstrap.ts:53`) sets all `starting/planning/running` agents to idle before services are constructed. `ContainerAgentService.reconcile` (`container-agent.service.ts:175`) is similar but is **never called** from bootstrap — it's a dead method. After recovery finishes, Bun.serve binds (`server-bootstrap.ts:119`) and HTTP requests can arrive before the later `services.agentService.startOrphanSweep()` executes and before `initSandboxProvider` completes — so the first minute of uptime runs without orphan protection.
**Risk:** An agent-start that crashes mid-setup during the bootstrap window leaves a phantom running agent until the next 10-minute sweep. `reconcile` being unreachable means in-memory maps and DB can diverge after container-agent.service restart if ever bolted onto the bootstrap path.
**Recommendation:** Call `containerAgentService.reconcile()` right after `runRecovery` (or during Phase 4 after services construction, before `Bun.serve`). Document that recovery happens under a startup "maintenance" banner. Consider rejecting task-move to `in_progress` until orphan sweep has run at least once.
**Effort:** S.
**Links:** `specs/application/state-machines/agent-lifecycle.md`, `specs/diagrams/01-system-architecture.md`.

### F10 — Two separate lockfiles in `agent-runner/` (npm and bun)

**Priority:** P2
**Observation:** `agent-runner/` ships both `bun.lock` and `package-lock.json`. CLAUDE.md explicitly states "CI uses `--frozen-lockfile` and will fail if the lockfile is stale. The lockfile is `agent-runner/bun.lock` (not `bun.lockb`)." `package-lock.json` is never referenced by scripts but sits in the repo.
**Risk:** Contributor drift — running `npm install` inside `agent-runner/` will update the wrong file, pass local build, fail CI. Dependency resolution discrepancies between bun and npm can yield different transitive versions for the shipped Docker image.
**Recommendation:** Delete `agent-runner/package-lock.json`; add a pre-commit guard that asserts only `bun.lock` exists in `agent-runner/`.
**Effort:** XS.
**Links:** CLAUDE.md "agent-runner Lockfile" section.

### F11 — `agent-runner` mints fake OAuth `expiresAt` and a null `refreshToken`

**Priority:** P1
**Observation:** `writeCredentialsFile` (`agent-runner/src/index.ts:303`) writes `expiresAt: Date.now() + 86_400_000` and `refreshToken: null` regardless of the actual token lifetime. The host supplies only `CLAUDE_OAUTH_TOKEN`; there is no mechanism to refresh a rotated token mid-run. Multiple agents per host share the same container-user credentials file (`~/.claude/.credentials.json`) under the node user.
**Risk:** A token revoked externally still appears "valid for 24 h" to the SDK; actual 401s surface as opaque "assistant errors" mid-stream. Concurrent agents racing on the credentials file (two container starts within the same per-project container) can interleave writes — the 0o600 file is not atomic on overwrite. No mechanism to refresh a short-lived token (future OAuth PKCE rotation).
**Recommendation:** (a) carry real `expiresAt` from the host token registry and emit a pre-run validation event when the token is expired/near-expiry; (b) write the credentials file under a unique `HOME` per agent-runner (set `HOME=/tmp/agents/<taskId>` at container start) to isolate writers; (c) if refresh tokens ever become available, plumb them in.
**Effort:** M.
**Links:** CLAUDE.md "Authentication Configuration"; `specs/application/security/`.

### F12 — Two stream handlers evolved in parallel and drifted

**Priority:** P2
**Observation:** `src/lib/agents/stream-handler.ts` and `agent-runner/src/index.ts` both implement almost the same loop: `canUseTool` tool tracking, `tool_use_summary` fan-out, `rate_limit_event`, `tool_progress`, `compact_boundary`, topology `task_started/progress/notification`, `ExitPlanMode` capture. The in-file comment at `stream-handler.ts:422` acknowledges this ("AE-010: Deferred - functions share ~70% code"). There is a shared `src/lib/agents/event-type-map.ts` and `agent-runner/src/shared-session.ts`, but they cover only event-type mapping and credential/file-change helpers — not the message-loop dispatch.
**Risk:** Bug fixes and new SDK features (e.g. upcoming `tool_use_summary` payload changes) must be applied in two places. The current SDK pin is `^0.2.113` in agent-runner vs `^0.2.76` originally assumed in CLAUDE.md (tech-stack table still says `0.2.76`) — version skew between the host facade and the container.
**Recommendation:** Extract a shared dispatcher (pure function taking a message and callbacks for each event class) into `packages/agent-sdk-loop` that both host and agent-runner consume. Pin a single `@anthropic-ai/claude-agent-sdk` version across root and agent-runner; update CLAUDE.md tech-stack table.
**Effort:** L.
**Links:** `specs/events_review/` (single-source event mapping).

### F13 — Model resolution ignores `task.modelOverride` on the execution phase

**Priority:** P2
**Observation:** In `AgentExecutionService.start` (`agent-execution.service.ts:478`) `taskModelOverride` is cast from `task as typeof task & { modelOverride?: string | null }` — the schema cast suggests the column exists but typed tasks don't expose it (schema drift with tests per CLAUDE.md "Tests: Keep in Sync"). In `executeAgentExecution` (`agent-execution.service.ts:1064`) the same cast is applied to a much thinner `{ id, worktreeId }` task object, so `taskModelOverride` is **always `undefined`** on the execution phase — the override is silently dropped after plan approval.
**Risk:** Task-scoped model overrides only work for the planning phase, execution silently reverts to agent/project/global default. Users setting an Opus override for a critical plan will see their execution run on Sonnet.
**Recommendation:** Pass the full task row (or at minimum `{ id, worktreeId, modelOverride }`) into `executeAgentExecution`, and lift `modelOverride` into the typed schema so the cast is no longer needed. Add a functional test: task.modelOverride='opus-x' → planning + execution both see the same resolved model.
**Effort:** S.
**Links:** `specs/application/database/schema.md`.

### F14 — `executeAgentExecution` catches too broadly; agent stays "starting" on sub-failures

**Priority:** P2
**Observation:** The outer try in `executeAgentExecution` (`agent-execution.service.ts:1019`) wraps the agent lookup, worktree lookup, codespace lookup, model resolution, `agentRuns` insert, memory-session start, and the SDK loop. On any early throw (e.g. codespace deleted mid-run), `runId` is still the synthetic one from `createId()` at line 1014, so the `agentRuns` row may never be inserted before the catch tries to update by `runId` → no-op. The agent is set to `error` and maps cleared, but **no task column update happens** — the task is stuck at `in_progress` until recovery on next restart.
**Risk:** Silent task orphaning without a corresponding `agent:error` propagation to the task state. Error message reaches the UI session but the Kanban board still shows "in progress" with no agent.
**Recommendation:** Narrow the try-block per CLAUDE.md "Try/catch scope" guidance. Track whether `agentRuns.id` was obtained and update the task column to `waiting_approval` (with failure status) on catch, mirroring the planning-error path. Add a functional test: simulate a codespace-lookup throw during execution and assert task ends in a terminal column with a logged error.
**Effort:** M.
**Links:** CLAUDE.md "Error bubbling"; `specs/events_review/`.

### F15 — `agent.config.maxTurns` default (50) is hard-coded in three places; `ExitPlanMode` forced into allowed tools inside the container only

**Priority:** P3
**Observation:** Hard-coded `50` appears at `agent-execution.service.ts:551,1116,1247` and `agent-runner/src/index.ts:192`. `essentialPlanningTools = ['ExitPlanMode']` is injected into `allowedTools` only inside agent-runner (`index.ts:515`); host-mode `runAgentPlanning` does not enforce the same — if a caller forgets to include `ExitPlanMode`, host-mode planning can never exit plan mode and will time out on the 4 h runtime cap.
**Risk:** Silent incompatibility between paths; hard-to-diagnose planning stalls on host mode. Defaults drift.
**Recommendation:** Centralise defaults in `src/lib/agents/constants.ts` (maxTurns, essentialPlanningTools, default model). Apply the same `essentialPlanningTools` injection in `stream-handler.ts:runAgentPlanning` before the `unstable_v2_createSession` call.
**Effort:** S.
**Links:** `specs/application/configuration/`.

### F16 — Planning path moves task to `waiting_approval` on `turn_limit`/`paused`, execution path mirrors — but host-mode planning also emits `agent:completed` on completion (not `agent:plan_ready`)

**Priority:** P3
**Observation:** Compare `stream-handler.ts:688` ("result.status === 'completed'" in the planning outer handler `executeAgentAsync`) — which maps task to `waiting_approval` — with the SDK-level `result` handler at `stream-handler.ts:765-802` that always returns `status: 'planning'` after a `result` message, regardless of whether `ExitPlanMode` was called. The executeAgentAsync switch then has both a `result.status === 'completed'` branch and a `result.status === 'planning'` branch; the `completed` branch is dead for the planning phase because `runAgentPlanning` never returns `'completed'`.
**Risk:** Minor code-reading trap; the `completed` branch in `executeAgentAsync` is dead but reads as live; future refactors could make it live accidentally with wrong task transitions.
**Recommendation:** Either delete the `completed`/`error` branches from `executeAgentAsync` (they are unreachable for `runAgentPlanning`), or tighten the return type of `runAgentPlanning` to `'planning' | 'paused' | 'error'`.
**Effort:** XS.
**Links:** `specs/application/state-machines/agent-lifecycle.md`.

### F17 — Host mode never publishes `agent:started` on planning (only `agent:planning`); container mode emits both `agent:started` and `agent:plan_ready`

**Priority:** P3
**Observation:** `runAgentPlanning` (`stream-handler.ts:459`) publishes `type: 'agent:planning'` at entry and then only `agent:plan_ready` at finish. `runAgentExecution` publishes `agent:started`. Container agent-runner emits `agent:started` for both phases (`agent-runner/src/index.ts:407`). The event-map (`src/lib/agents/event-type-map.ts`) and UI (`specs/events_review/`) assume `agent:started` fires at least once per run.
**Risk:** UI subscribers that key on `agent:started` to reset per-run state miss the planning phase in host-mode. Event ordering invariants documented in `specs/events_review/` may not hold uniformly.
**Recommendation:** Emit `agent:started{phase:'planning'}` from `runAgentPlanning` before the SDK session create, matching `runAgentExecution`. Keep `agent:planning` as an additional breadcrumb or retire it.
**Effort:** XS.
**Links:** `specs/events_review/`.

## Open questions

1. **Is AgentCore coming back?** If the intent is to reintroduce it post-migration-0011, the config surface needs re-specifying. Otherwise the ~1.5 kLOC across `agentcore-*` plus the `bedrock-agentcore` runtime dep is pure overhead (F1).
2. **Should host mode be deprecated?** Container mode has gained features (SDK session resume, stop-file cancellation, `AGENT_HAS_SKILL` bypass-mode, stderr error capture) that host mode lacks. If the long-term target is container-only, several findings (F5, F6, F12, F17) dissolve. If both remain first-class, they need a shared dispatcher and a parity test matrix.
3. **What is the canonical plan TTL?** 60 min in memory, no DB expiry — the product intent is unclear (F8).
4. **Are tool hooks a planned feature or abandoned?** The scaffolding is invasive (`createAgentHooks`, two maps on the service, six cleanup call sites). If hooks are staying, F2 is a bug. If not, delete the infrastructure.
5. **Team mode commitment.** CLAUDE.md documents `launchSwarm`/`teammateCount` as a live mechanism. The code treats them as data-only breadcrumbs. Which is the target? (F3).
6. **Credential isolation per-agent.** When multiple per-project containers each run one agent, the OAuth write is contained; when the "Shared Container" mode is used with two concurrent tasks, they share `/home/node/.claude/.credentials.json`. Is concurrent-run-in-shared-container a supported topology? (F11).
