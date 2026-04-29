# 03 — Agent Execution (April 29 Review)

HEAD verified: `25c1c4f0` (chore(deps): bump @tailwindcss/vite from 4.2.2 to 4.2.4 (#188)).

## Scope

Host-mode (`AgentExecutionService` → `runAgentPlanning`/`runAgentExecution`) vs container-mode (`ContainerAgentService` → `ContainerExecService` → `agent-runner`). Plan/approval/execute lifecycle, Claude Agent SDK integration, tool-use hooks, AgentCore remnants, agent-runner package, plan resume, session continuity. Verifies April 20 P0/P1 remediation in PRs #176/#178/#179.

## Map

| Layer | File | Role |
|-------|------|------|
| Facade | `src/services/agent.service.ts:50` | Composes CRUD/Execution/Queue services; wires orphan sweep |
| Host-mode lifecycle | `src/services/agent/agent-execution.service.ts:77` | `start`/`stop`/`pause`/`resume`/`rejectPlanForTask`; in-memory `runningAgents`, `agentStartTimes`, `preToolHooks`, `postToolHooks` |
| Host-mode SDK loop | `src/lib/agents/stream-handler.ts:518,1058` | `runAgentPlanning`/`runAgentExecution` — direct Claude SDK session, topology, chunk batching |
| SDK env helper | `src/lib/agents/agent-sdk-utils.ts:48` | `buildSdkEnv` — strips `CLAUDECODE`, DB creds, secrets before subprocess |
| Container facade | `src/services/container-agent/container-agent.service.ts:62` | Routes `startAgent` to container-exec or AgentCore bridge |
| Container exec | `src/services/container-agent/container-exec.service.ts:52` | Docker/K8s/Nomad lifecycle, env propagation, stdout bridge wiring |
| Plan approval | `src/services/container-agent/plan-approval.service.ts:27` | `handlePlanReady`/`approvePlan`/`rejectPlan`, skill-chain swap, sandbox-change detection |
| Agent review | `src/services/container-agent/agent-review.service.ts:81` | Optional automated plan review via Anthropic API |
| Plan-state | `src/services/container-agent/sandbox-state.ts:17` | `runningAgents`, `runningAgentCoreAgents`, `pendingPlans`, `startingAgents`; plan TTL interval |
| Container → DS bridge | `src/lib/agents/container-bridge.ts:150` | Parses JSON-lines from container stdout |
| AgentCore → DS bridge | `src/lib/agents/agentcore-bridge.ts:71` / `src/services/container-agent/agentcore-bridge.service.ts:43` | SSE-event bridge for AWS AgentCore |
| Agent runner | `agent-runner/src/index.ts:1`, `agent-runner/src/agentcore-handler.ts:1` | Child-process entry points; `~/.claude/.credentials.json` writer |
| Hook scaffolding (host) | `src/lib/agents/hooks/{audit,streaming,tool-whitelist}.ts`, `index.ts` | `createAgentHooks` builds SDK-format hook bundles |
| Recovery | `src/server/bootstrap/phases/recovery.ts:36,66,88,116` | Boot-time reset of stale agents, agent_reviewing, orphan tasks |
| Bootstrap | `src/server/bootstrap/server-bootstrap.ts:75,86` | Calls `runRecovery` then `services.agentService.startOrphanSweep()` |

## Verification of April 20 P0/P1 remediation

Confirmed resolved at HEAD:

- **F2 (host hooks installed)** — `runAgentExecution.canUseTool` now drains `preToolUseHooks` first and returns `{behavior:'deny', message}` on the first deny verdict (`stream-handler.ts:1144-1190`). `tool_use_summary` handler runs `postToolUseHooks` after publishing the `tool:result` event (`stream-handler.ts:1506-1528`). Wired through `executeAgentExecution` (`agent-execution.service.ts:1208,1225,1229`). **However see F03-01 below — nothing in production calls `registerPreToolUseHook`/`registerPostToolUseHook`, so the maps are always empty.**
- **F3 (`launchSwarm`/`teammateCount`/`pushToRemote` removed)** — Greps clean across `src/`, `agent-runner/`, `tests/` (one residual comment in `tests/integration/plan-approval-flow.test.ts:175` documenting the removal).
- **F5 (host SDK session resume)** — `runAgentPlanning` captures `session.sessionId` (`stream-handler.ts:673-684`), threads it onto `AgentRunResult.sdkSessionId` and the `agent:plan_ready` event. `executeAgentAsync` persists it under `tasks.planOptions.sdkSessionId` (`agent-execution.service.ts:732-748`). `executeAgentExecution` reads it back (`agent-execution.service.ts:1196-1202,1224`). `runAgentExecution` tries `unstable_v2_resumeSession` first and falls back to `createSession` on any throw (`stream-handler.ts:1268-1289`).
- **F6 (host-mode reject-plan fallback)** — `AgentExecutionService.rejectPlanForTask` (`agent-execution.service.ts:1475`) aborts the agent, CAS-updates the task back to `backlog` where `lastAgentStatus='planning'`, removes the worktree. `TaskService.rejectPlan` delegates to host-mode when the container service is absent (`task.service.ts:341-342`).
- **F11 (OAuth `expiresAt` fiction removed)** — agent-runner uses far-future sentinel when host sends none, accepts `CLAUDE_OAUTH_EXPIRES_AT` from env (`agent-runner/src/index.ts:273-296`). Host-side `resolveOAuthExpiresAtMs` reads `api_keys.expires_at` (`container-agent/shared-helpers.ts:307`) and passes it through to both container-exec (`container-exec.service.ts:507`) and AgentCore (`agentcore-bridge.service.ts:238`). **However see F03-09 — refresh-token plumbing is dead-end (host hardcodes null at `container-exec.service.ts:722`); F03-09 records this regression.**

Confirmed unresolved or partially-resolved at HEAD:

- **F1** (AgentCore code reachable) — partial. AWS-SDK provider gated behind `AGENTCORE_ENABLED`, but bridge service & lib bridge still loaded eagerly. Re-raised as F03-04.
- **F8** (plan TTL fragility, no DB expiry) — Not addressed. `getPendingPlan` rehydrates from DB without TTL check (`plan-approval.service.ts:225-244`). Re-raised as F03-08.
- **F9** (container-mode `reconcile()` not called from bootstrap) — Not addressed. `containerAgentService.reconcile()` (`container-agent.service.ts:210`) is still unreferenced from `src/server/bootstrap/`. Re-raised as F03-12.
- **F10** (two lockfiles in `agent-runner/`) — Not addressed. Both `bun.lock` and `package-lock.json` present. Re-raised as F03-10.
- **F13** (model override on execution phase) — Partially mis-stated in April 20. Cast at `agent-execution.service.ts:1146` does read `task.modelOverride` at runtime when called via `resume()` (which passes the full task row), but the parameter type narrows the field away — a refactor that copies fields would silently drop it. Recorded as F03-13.
- **F14** (broad `executeAgentExecution` catch leaves task stuck `in_progress`) — Not addressed. Catch at `agent-execution.service.ts:1354` updates `agentRuns`, agents, but never moves the task column. Re-raised as F03-06.
- **F15** (host-mode planning does not inject `ExitPlanMode` into `allowedTools`) — Not addressed. Container-side has the injection (`agent-runner/src/index.ts:691-699`); host-side does not. Re-raised as F03-15.
- **F4** (`allowedPrompts` ignored on execution) — Partial. Host execution still does not consume `allowedPrompts`. Container-side AgentCore handler has a logging-only check (`agent-runner/src/agentcore-handler.ts:264-275`) that does not actually grant anything. Re-raised as F03-11.
- **F12** (parallel stream loops) — Not addressed in code; SDK pin is now aligned (`^0.2.113` in both root and `agent-runner/package.json`).
- **F16/F17** (event drift between host paths) — Not addressed; minor, P3.

## What's working

- Host-mode SDK session resume across approval is now real (F5 fix; tested in `stream-handler.test.ts`).
- Host-mode plan rejection works end-to-end (F6 fix; aborts agent, CAS-clears plan, removes worktree).
- Plan persistence + recovery across restart still works for both modes; `resetStaleAgentReviewing` (`recovery.ts:66`) also resets transient `agent_reviewing` so review-failed plans return to human-approval.
- Plan-approval CAS guards on `column='waiting_approval'` (container) and `lastAgentStatus='planning'` (reject) prevent racing user moves.
- Sandbox-change detection on container-mode approval still discards `sdkSessionId` so the agent reseeds with full plan text (`plan-approval.service.ts:391-426`).
- Skill-chaining (`executionSkillId`) builds a full skill-aware execution prompt with subagent-delegation directives (`plan-approval.service.ts:286-305`); rollback on agent-start failure restores original skill.
- agent-runner sandbox path validation (`resolveWorkspacePath`/`resolveStopFilePath`) and `uncaughtException`/`unhandledRejection` handlers preserved.
- `processAgentOutput` race guard (`completionHandled` flag at `container-exec.service.ts:1075,1258`) prevents the bridge-callback / process-exit race condition.

## Findings

### F03-01 — Tool-use hooks are wired into the SDK loop but **no caller registers them**

**Priority:** P1
**Observation:** `runAgentExecution.canUseTool` correctly invokes `options.preToolUseHooks` before allowing a tool (`stream-handler.ts:1150-1190`) and runs `options.postToolUseHooks` after each `tool_use_summary` (`stream-handler.ts:1509-1528`). `AgentExecutionService.executeAgentExecution` reads from `this.preToolHooks`/`this.postToolHooks` (`agent-execution.service.ts:1208-1245`). The registration APIs `registerPreToolUseHook`/`registerPostToolUseHook` exist (`agent-execution.service.ts:1574,1583`). However, a grep across `src/` (excluding `__tests__/`, `.stryker-tmp`, `.worktrees/`) finds **zero callers** of either register method or of `createAgentHooks` (`src/lib/agents/hooks/index.ts:21`). The `preToolHooks`/`postToolHooks` maps are populated only by tests; production code never calls them. Net effect: F2 from April 20 is fixed at the SDK-loop level but unreachable end-to-end. The whitelist hook (`tool-whitelist.ts:26`), streaming hooks, and audit hook (`audit.ts:7`) are dead infrastructure.
**Risk:** Tool whitelist enforcement is silently disabled — every agent run effectively allows every tool listed in `agent.config.allowedTools`/`['*']` without any pre-tool-use deny gate, audit logging, or streaming-hook tool:start/result events. Spec `specs/application/security/` describes whitelist enforcement as a layer that does not exist at runtime. The `auditLogs` table is never written from production agent execution.
**Recommendation:** Decide: (a) install hooks unconditionally during `start()` by calling `createAgentHooks(...)` and threading the result to `executeAgentAsync`/`executeAgentExecution`, OR (b) remove the dead scaffolding (`createAgentHooks`, `register{Pre,Post}ToolUseHook`, both maps, all six cleanup call sites) and the four hook files. If (a), also wire host-mode planning's `canUseTool` (`stream-handler.ts:575-638`) to the same pre-hook gate so allowed-tool denials can fire during plan exploration. Add a functional test that exercises a Bash-deny pre-hook.
**Effort:** M (option a) / S (option b).
**Links:** `specs/application/security/` (tool permission model), `specs/application/state-machines/agent-lifecycle.md`.

### F03-02 — Host-mode `runAgentPlanning` does not run pre-tool-use hooks

**Priority:** P1
**Observation:** `runAgentExecution` runs `options.preToolUseHooks`/`postToolUseHooks` (`stream-handler.ts:1150-1190,1509-1528`). The planning sibling `runAgentPlanning` accepts the same `StreamHandlerOptions` shape (which now includes both hook arrays from the F2 fix), but its `canUseTool` (`stream-handler.ts:575-638`) never inspects the hook arrays. Pre-hook denies do not fire during planning. This is independent of F03-01: even if a caller did register hooks, they would only run during execution, not while the agent explores the codebase in plan mode.
**Risk:** The planning phase has access to all read tools (and on `bypassPermissions` mode used in the container path when a skill is assigned, all tools full-stop) without any whitelist or audit gate. An audit log that omits the planning phase is incomplete for compliance use cases.
**Recommendation:** Mirror the execution-side hook block in `runAgentPlanning.canUseTool` before the existing `ExitPlanMode` capture branch. Reuse the same deny-publishes-tool:result pattern. Add a unit test with a deny-hook for `Bash` and assert that the planning session emits `tool:result{isError:true}` and proceeds without aborting.
**Effort:** S.
**Links:** `tests/lib/agents/stream-handler.test.ts` (extend the existing F2 tests to planning).

### F03-03 — Plan/execution prompts diverge: host-mode uses `task.plan` verbatim while container-mode wraps it in skill-aware framing

**Priority:** P2
**Observation:** Host-mode `resume()` builds the execution prompt as `Execute the following approved plan:\n\n${task.plan}\n\nOriginal task: ${task.title}` (`agent-execution.service.ts:1009-1011`). Container-mode `PlanApprovalService.approvePlan` (`plan-approval.service.ts:286-305`) prepends a six-bullet skill-delegation header instructing the agent to read `.claude/skills/{id}/SKILL.md` and to launch subagents via the `Agent` tool. Tasks with `executionSkillId` set get the skill prompt only on the container path; on host mode they reuse the planning prompt and silently drop the chained skill — `executionSkillId` is never read by `agent-execution.service.ts`.
**Risk:** Skill chaining (planning skill → execution skill) is a documented feature only honored by container mode. Users on host mode see "approved" but the agent runs against the original `task.skillId`; observability shows the wrong skill in `skill-tracking`.
**Recommendation:** Extract the skill-aware prompt builder (currently inline in `plan-approval.service.ts:286-305`) into a shared helper, e.g. `src/lib/agents/build-execution-prompt.ts`, and call it from `AgentExecutionService.resume()` when `task.executionSkillId` is set. Mirror the same `skillId`/`skillName` swap on the task row before launching `executeAgentExecution`. Add a host-mode functional test asserting skill chaining works.
**Effort:** M.
**Links:** `src/services/container-agent/plan-approval.service.ts:259-311`.

### F03-04 — AgentCore code path remains statically loaded into the host process

**Priority:** P2
**Observation:** April 20 F1 was marked "Resolved" because `AgentCoreSandboxProvider` (the AWS-SDK-pulling module) is now lazy-imported behind `AGENTCORE_ENABLED=true` (`container-agent.service.ts:178-189`). However, `AgentCoreBridgeService` is still statically imported (`container-agent.service.ts:42`) and constructed unconditionally in the constructor (`container-agent.service.ts:132-139`). It in turn statically imports `createAgentCoreBridge` (`agentcore-bridge.service.ts:15` → `src/lib/agents/agentcore-bridge.ts`), which imports `SSEEvent` types from `agentcore-sandbox-instance.ts`. The instance file (`agentcore-sandbox-instance.ts:13`) imports `AgentCoreErrors` from `errors/agentcore-errors.ts`. None of these are tree-shaken by a default Bun build. End result: ~1500 LoC of AgentCore bridge / instance / error code is loaded into every server process that disables AgentCore.
**Risk:** Bundle size + cold-start impact + maintenance surface for code that is supposedly disabled. The `bedrock-agentcore@^0.2.2` runtime dep in `agent-runner/package.json:18` is similarly always shipped in the agent-runner Docker image even when AgentCore is unused. Tests in `tests/integration/agentcore-bridge-service.test.ts` exist for code that is by default unreachable in production.
**Recommendation:** Either (a) lazy-construct `AgentCoreBridgeService` only when `setAgentCoreProvider` succeeds (move construction into the same dynamic-import branch) — this requires routing `startAgentCoreAgent`/`stopAgentCoreAgent` through a getter that returns null when disabled — or (b) commit to deletion: remove `AgentCoreBridgeService`, `agentcore-bridge.ts`, `agentcore-sandbox-{provider,instance}.ts`, the `agent-runner/src/agentcore-handler.ts` entry point, the `bedrock-agentcore` agent-runner dep, the `docker/Dockerfile.agentcore` image, the migrations 0010/0011 columns scaffolding, and the `sandbox.agentcore` setting. Currently the `start:agentcore` npm script (`agent-runner/package.json:12`) and `Dockerfile.agentcore` advertise a feature with no first-class entry point.
**Effort:** L (option b) / M (option a).
**Links:** `src/db/migrations/0011_drop_agentcore_columns.sql`, `docker/Dockerfile.agentcore`, `tests/integration/agentcore-bridge-service.test.ts`.

### F03-05 — `setAgentCoreProvider` is exposed but no boot phase calls it

**Priority:** P3
**Observation:** `ContainerAgentService.setAgentCoreProvider` (`container-agent.service.ts:178`) reads `AGENTCORE_ENABLED` and dynamic-imports the provider. Greps across `src/server/bootstrap/`, `src/services/`, and `src/lib/sandbox/` find no caller. The flag therefore controls only a no-op log line. Even if a user sets `AGENTCORE_ENABLED=true` and provides a `sandbox.agentcore` setting, nothing in the bootstrap calls `setAgentCoreProvider({region, runtimeArn, ...})`. The whole AgentCore branch is unreachable from a clean install.
**Risk:** Confusing UX: settings UI exposes the AgentCore secret and runtime ARN (`src/server/routes/settings.ts:24,51`, `src/server/routes/sandbox.ts:44`), saving them takes effect for the schema but never connects to the runtime. A user toggling the flag would see no behavior change. Compounds the case for F03-04 deletion.
**Recommendation:** Delete the `setAgentCoreProvider`/`clearAgentCoreProvider` methods and the entire AgentCore code path; or wire a phase in `src/server/bootstrap/sandbox/` that reads the setting and calls `setAgentCoreProvider` when `AGENTCORE_ENABLED=true`. Document the chosen direction in `specs/sandbox/`.
**Effort:** S.
**Links:** `specs/sandbox/`, `src/server/routes/settings.ts:24-51`.

### F03-06 — Host-mode execution catch leaves task stuck `in_progress`

**Priority:** P1
**Observation:** `executeAgentExecution`'s outer try (`agent-execution.service.ts:1101-1424`) wraps agent lookup, worktree lookup, codespace lookup, model resolution, the `agentRuns` insert, the SDK loop, and post-result task transitions. On any throw inside that block, the catch at line 1354 updates `agentRuns.status='error'` and `agents.status='error'`, publishes `agent:error` to the session, and clears the in-memory maps. **No `tasks.column` update happens** — the task remains in `in_progress` with stale `agentId`/`sessionId`. The same flaw exists in `executeAgentAsync`'s planning catch at line 836-902. This is the F14 issue from April 20, still unaddressed.
**Risk:** Silent task orphaning. Errors during execution (e.g. SDK 401, provider lookup throw, worktree resolution failure) leave the kanban board showing "in progress" with no agent until the next server restart fires `recoverOrphanedTasks` or until the orphan sweep aborts the (already-dead) agent. The error reaches the session UI but not the task state. PR review tools (the `pr-review-toolkit`) and other consumers querying `column='in_progress'` see ghost tasks.
**Recommendation:** Mirror the success-path handling: in both catches, `await this.db.update(tasks).set({ column: 'waiting_approval', lastAgentStatus: 'error' }).where(eq(tasks.id, taskId))`. Apply CLAUDE.md "Try/catch scope" guidance — narrow the try-block so codespace-lookup-throws don't poison the SDK-loop's invariants. Add functional tests `IT-F03-06-{a,b}` that mock a codespace-lookup throw mid-execution and a worktree-resolution throw, and assert the task ends in `waiting_approval` with `lastAgentStatus='error'`.
**Effort:** M.
**Links:** CLAUDE.md "Error bubbling", `specs/application/state-machines/agent-lifecycle.md`.

### F03-07 — `agent.currentTaskId` may be null after recovery; `resume()` still proceeds

**Priority:** P2
**Observation:** `recoverOrphanedTasks` sets `agentId=null, sessionId=null` on tasks (`recovery.ts:88-110`) and `resetStaleAgents` sets `currentTaskId=null, currentSessionId=null` on agents (`recovery.ts:36-56`). After recovery, `AgentExecutionService.resume(agentId, feedback)` (line 978) checks `if (agent.status === 'planning' && agent.currentTaskId && agent.currentSessionId)`. The order is correct, but the guard does not consider that an agent could have been left in `idle`/`paused` after recovery yet the **task** still reads `lastAgentStatus='planning'` (because `resetStaleAgentReviewing` only resets `agent_reviewing`, not `planning`). A subsequent `approvePlan` call hits the host-mode fallback at `task.service.ts:294-299` — if the task's `agentId` field is still set to a now-idle agent, `agentExecutionService.resume(task.agentId)` returns `NOT_RUNNING` because the agent's status is `idle`, not `planning`. The user sees "approve" return 500 with no recovery hint.
**Risk:** Recovery leaves plans approvable in the UI (task is in `waiting_approval`) but unactionable on host-mode. Container mode is not affected because `getPendingPlan` re-hydrates from DB and starts a fresh agent-runner. Host-mode lacks the equivalent rehydration.
**Recommendation:** Either (a) extend `recoverOrphanedTasks` to clear `tasks.lastAgentStatus`/`tasks.plan`/`tasks.column` for tasks whose agent is no longer present, OR (b) make `AgentExecutionService.resume()` accept a missing-agent case by spawning a fresh agent against the persisted plan and `sdkSessionId`. Option (b) reuses the F5 resume infrastructure and gives users a real "approve after restart" experience on host-mode.
**Effort:** M.
**Links:** `src/server/bootstrap/phases/recovery.ts:36-110`, F03-12.

### F03-08 — Plan TTL is purely in-memory; DB rehydration ignores age

**Priority:** P2
**Observation:** `SandboxStateManager.cleanupExpiredPlans` (`sandbox-state.ts:176-193`) sweeps the in-memory `pendingPlans` map every 5 minutes against a 60-minute TTL. `getPendingPlan` (`plan-approval.service.ts:214-247`) checks the in-memory cache first, then falls back to `db.query.tasks.findFirst({where: eq(tasks.id, taskId)})` and rehydrates with **no TTL check**. There is no `planExpiresAt` column. After server restart, a 10-day-old plan is still approvable and re-executes against a long-changed codebase. This is the F8 issue from April 20.
**Risk:** Stale plans approved post-restart re-execute against drifted code. Worse, if the worktree was cleaned up by `cleanOrphanedWorktrees` (`recovery.ts:116`) but the task's `worktreeId` wasn't (because `lastAgentStatus='planning'` is excluded from the cleanup at line 128), approval starts a new agent-runner against a worktree that no longer exists on disk.
**Recommendation:** Either (a) gate `getPendingPlan`'s DB rehydration on `task.updatedAt` age (reject when older than `PENDING_PLAN_TTL_MS`), OR (b) add a `planExpiresAt` column populated at `handlePlanReady` time; show the expiry in the UI and refuse approval after expiry. Combined with F03-07, also clean stale `tasks.plan`/`tasks.lastAgentStatus` rows on boot.
**Effort:** S (option a) / M (option b).
**Links:** `specs/application/state-machines/agent-lifecycle.md`, `specs/application/database/schema.md`.

### F03-09 — OAuth refresh token plumbing is dead-end on the host side

**Priority:** P2
**Observation:** April 20 F11 was marked "Resolved" — agent-runner accepts `CLAUDE_OAUTH_REFRESH_TOKEN` env (`agent-runner/src/index.ts:296`) and AgentCore handler accepts `oauthRefreshToken` in the payload (`agent-runner/src/agentcore-handler.ts:81`). The shared writer threads it into the credentials file (`agent-runner/src/shared-session.ts:38-78`). However, on the host side, `container-exec.service.ts:722` hardcodes `oauthRefreshToken: null` with the inline comment "refreshToken storage is not yet wired through the registry". `agentcore-bridge.service.ts:241-252` constructs the AgentCore payload without `oauthRefreshToken` at all. The `apiKeys` schema (`src/db/schema/sqlite/api-keys.ts:9-31` and the PG variant) has no `refreshToken` column — so even if a host wanted to populate it, there is no storage. The fix is half-complete: the runner pipe accepts a refresh token but no host can populate it.
**Risk:** When the OAuth access token expires inside a long-running agent (~4h max runtime + Claude OAuT lifetimes), the SDK has no refresh-token to silently rotate. The user sees an opaque 401 mid-stream — exactly the symptom F11 was supposed to fix. The half-fix is worse than no fix because it suggests the path works.
**Recommendation:** Either (a) add a `refreshToken` column to `apiKeys` (encrypted, like `encryptedKey`), populate it at OAuth grant time, expose `getDecryptedRefreshToken(service)` on `ApiKeyService`, and thread it through `container-exec.service.ts:707-723` and `agentcore-bridge.service.ts:241-252`. OR (b) document explicitly that refresh-token rotation is unsupported and remove the `oauthRefreshToken` parameter from agent-runner shared-session API.
**Effort:** M (option a) / S (option b).
**Links:** `src/db/schema/sqlite/api-keys.ts:9-31`, `src/services/api-key.service.ts`.

### F03-10 — `agent-runner/` still ships two lockfiles

**Priority:** P3
**Observation:** April 20 F10 was not addressed. `agent-runner/bun.lock` (76 KB, last modified 2026-04-20) and `agent-runner/package-lock.json` (13 KB, last modified 2026-02-12) both exist. CLAUDE.md "agent-runner Lockfile" explicitly says "the lockfile is `agent-runner/bun.lock` (not `bun.lockb`)" — the npm lockfile is unused. The npm lockfile predates current dependencies (`@anthropic-ai/claude-agent-sdk` was bumped to `^0.2.113` in `package.json` but `package-lock.json` does not reflect this).
**Risk:** Contributor drift. Running `npm install` inside `agent-runner/` updates the wrong file, passes local build, fails CI which uses `bun install --frozen-lockfile`. Stale `package-lock.json` resolves different transitive versions, masking SDK breakage.
**Recommendation:** Delete `agent-runner/package-lock.json`. Add a pre-commit hook (or CI guard) that fails when `package-lock.json` exists in `agent-runner/`.
**Effort:** XS.
**Links:** CLAUDE.md "agent-runner Lockfile".

### F03-11 — `allowedPrompts` is captured but never grants tool permission on either path

**Priority:** P2
**Observation:** Both paths capture `exitPlanModeOptions.allowedPrompts` and pass it on the `agent:plan_ready` event (`stream-handler.ts:962-964`, `agent-runner/src/index.ts:773-774`). The container `agent-runner/src/index.ts` execution phase does not consume the field. The AgentCore handler (`agent-runner/src/agentcore-handler.ts:264-275`) checks if a Bash command matches an entry but **only emits a log line** — `return { behavior: 'allow' as const }` is unconditional, so the match never grants anything beyond what `permissionMode: 'bypassPermissions'` already allows. Host execution never reads the field. The contract documented in the plan ("these bash commands are pre-approved") is fictional. This is the F4 issue from April 20.
**Risk:** Plan authors believe pre-approved Bash invocations skip permission prompts; the agent in fact still hits SDK permission prompts when running outside `bypassPermissions` mode (host execution always runs in `acceptEdits`, not bypass). Tasks stall waiting for approval that never comes.
**Recommendation:** In `runAgentExecution.canUseTool` (and the agent-runner equivalents), when `toolName === 'Bash'` and the input matches an `allowedPrompts` entry from `task.planOptions`, return `{behavior: 'allow'}` explicitly without consulting any pre-hook. Otherwise, fall through to the existing pre-hook logic. Add a functional test asserting a pre-approved Bash command runs without a permission prompt and a non-allowed one is blocked.
**Effort:** M.
**Links:** `specs/application/security/`.

### F03-12 — `containerAgentService.reconcile()` is dead code; bootstrap never calls it

**Priority:** P2
**Observation:** `reconcile()` (`container-agent.service.ts:210-230`) sweeps `tasks.column='in_progress'` rows that have no live in-memory agent and moves them to `backlog`. Greps across `src/server/bootstrap/` and `src/services/` find no caller — the only `reconcile`/`reconciled` references in bootstrap (`server-bootstrap.ts:106,141,283,290`, `sandbox/sandbox-init.ts:177-196`) are for **sandbox** reconciliation. Recovery is handled instead by `recoverOrphanedTasks` (`recovery.ts:88-110`) which uses a different predicate (`agentId IS NOT NULL`). The two paths overlap in 90% of cases but diverge: `reconcile()` calls `state.hasAnyRunningAgent(taskId)` (memory check) so it is safe to call after services are up; `recoverOrphanedTasks` runs before services are constructed and only checks the DB.
**Risk:** A late-arriving recovery (e.g. a sandbox that came up after `runRecovery` completed) cannot retroactively clean orphan tasks. After the bootstrap window, dead container agents that crashed on startup leave tasks at `in_progress` until the next 10-min orphan sweep — and that sweep targets agent runtimes, not orphan tasks. Tasks can sit stuck for hours.
**Recommendation:** Call `containerAgentService.reconcile()` once in `server-bootstrap.ts` after `services` is constructed and before `services.agentService.startOrphanSweep()` (line 86). Alternatively, delete `reconcile()` and broaden `recoverOrphanedTasks` to handle the post-services case, scheduling it as a recurring sweep alongside orphan sweep.
**Effort:** XS (wire it) / S (recurring schedule).
**Links:** `src/server/bootstrap/server-bootstrap.ts:75-86`, `src/server/bootstrap/phases/recovery.ts:88-110`.

### F03-13 — `task.modelOverride` is read via an unsound type cast

**Priority:** P3
**Observation:** Both `start()` (`agent-execution.service.ts:524`) and `executeAgentExecution()` (`agent-execution.service.ts:1146`) read `taskModelOverride` via `(task as typeof task & { modelOverride?: string | null }).modelOverride`. The schema column exists (`db/schema/sqlite/tasks.ts:63`, PG mirror at line 60). The runtime read works correctly **only because** the calling code happens to pass full task rows. The parameter type of `executeAgentExecution` declares `task: { id: string; worktreeId: string | null; skillId?: ...; skillName?: ... }` — the cast widens the type by intersection but does not make the field part of the structural contract. A future refactor that copies fields explicitly (e.g., `executeAgentExecution(agentId, sessionId, prompt, { id: task.id, worktreeId: task.worktreeId, skillId: task.skillId })`) silently drops `modelOverride` with no type error. April 20 F13 mis-stated this as "always undefined" — it is correct *now*, but unsound.
**Risk:** Type-unsafe `as` casts for fields that exist on the schema invite silent data loss. CLAUDE.md "Type design" guidance forbids this pattern.
**Recommendation:** Lift `modelOverride` into the parameter type of both `executeAgentExecution` and `executeAgentAsync`. Drop the casts. Add a type-check that fails if a future schema change drops `modelOverride`.
**Effort:** XS.
**Links:** `specs/application/database/schema.md`, CLAUDE.md "Tests: Keep in Sync with Renames".

### F03-14 — Orphan sweep silently dies on synchronous throw; no metric

**Priority:** P3
**Observation:** April 20 F7 unaddressed. `startOrphanSweep` (`agent-execution.service.ts:1593`) creates a `setInterval(() => this.sweepOrphanedAgents(), ORPHAN_SWEEP_INTERVAL_MS)`. `sweepOrphanedAgents` (`agent-execution.service.ts:1615-1655`) does fire-and-forget `void getAgentMaxRuntimeMs(this.db).then(...).catch(...)` and the DB update has its own `.catch()`. But if a synchronous throw escapes the for-loop (e.g. logger error, future map-iteration bug), `setInterval` keeps the timer alive with no callback execution, and there is no metric to detect this. There is also no test that throws inside the sweep and asserts the next tick still executes. The same single-timer fragility applies to `SandboxStateManager.planCleanupInterval` (`sandbox-state.ts:34-37`).
**Risk:** Long-tail leak: one bad iteration → sweeps stop forever → agents that crash without cleanup remain "running" until server restart. Discoverable only via UI stuck-state reports.
**Recommendation:** Wrap both sweep bodies in `try/catch` that logs but does not rethrow. Replace the field-based `setInterval` with a `setTimeout`-chain that reschedules after each iteration, so an asynchronous error in the catch-handler still progresses. Add a health metric `agent.orphan_sweep.last_run_at` exposed via the existing observability spec. Add tests `tests/services/agent-execution-orphan-sweep.test.ts` that throw and verify the next tick fires.
**Effort:** S.
**Links:** `specs/events_review/` (observability of background work).

### F03-15 — Host-mode planning still does not inject `ExitPlanMode` into `allowedTools`

**Priority:** P3
**Observation:** April 20 F15 unaddressed. `agent-runner/src/index.ts:691-699` injects an `essentialPlanningTools = ['ExitPlanMode']` array into `allowedTools` before creating the planning SDK session. `runAgentPlanning` (`stream-handler.ts:518-652`) passes `allowedTools` straight through to `unstable_v2_createSession` with no equivalent injection. If a host-mode caller's agent config has a tight whitelist that omits `ExitPlanMode`, the agent enters plan mode and can never exit — the SDK permission layer blocks the tool before `canUseTool` runs. Combined with the 4 h `maxRuntimeMs`, the agent times out without producing a plan and the task moves to `waiting_approval` with no `tasks.plan` set.
**Risk:** Silent stall in host mode for any caller that customizes `allowedTools`. Container mode is unaffected. The codebase default (`ALLOW_ALL_TOOLS = ['*']`) hides the bug for all built-in flows.
**Recommendation:** Centralise `essentialPlanningTools` (and `DEFAULT_AGENT_MAX_TURNS = 50`) in `src/lib/agents/constants.ts`. Apply the same injection in `runAgentPlanning` before `unstable_v2_createSession` (`stream-handler.ts:645-652`). Update CLAUDE.md "Use this tech stack" if the SDK permission semantics change.
**Effort:** XS.
**Links:** `specs/application/configuration/`, `specs/application/state-machines/agent-lifecycle.md`.

### F03-16 — agent-runner default model `claude-opus-4-5-20251101` lags host default `claude-opus-4-6`

**Priority:** P3
**Observation:** `agent-runner/src/index.ts:303` defaults to `model: 'claude-opus-4-5-20251101'`. `src/lib/constants/models.ts:50` declares `DEFAULT_AGENT_MODEL = 'claude-opus-4-6'`. The host-side env propagation in `container-exec.service.ts:148-167` sets `AGENT_MODEL` from `agentConfig.model` (always — it's a non-optional field), so in practice the runner default is unused for production flows. However, `agent-runner/src/agentcore-handler.ts:131` defaults to `'claude-sonnet-4-6'` (a different model again), which IS reachable when AgentCore invocations omit `model` in their payload (`agentcore-bridge.service.ts:241-252` only includes `model` because `agentConfig.model` is constructed). If a future caller forgets to set `model`, the AgentCore path silently uses Sonnet while the container path uses Opus 4.5 — neither matching the host default.
**Risk:** Silent model drift between paths. CLAUDE.md tech-stack table does not mention `claude-opus-4-6`/`-4-5-20251101`/`-sonnet-4-6` defaults; the only listed name is `claude-opus-4-5-20251101` which is now stale.
**Recommendation:** Centralise the default in a single `DEFAULT_AGENT_MODEL` constant shared by host and runner. Since the runner is a separate package, copy the constant via a small `agent-runner/src/constants.ts` and add a build-time check (or test in `agent-runner/__tests__`) that asserts it matches the host's `getFullModelId(DEFAULT_AGENT_MODEL)`. Update CLAUDE.md.
**Effort:** XS.
**Links:** `src/lib/constants/models.ts:50`, `agent-runner/src/index.ts:303`, `agent-runner/src/agentcore-handler.ts:131`.

### F03-17 — `runAgentPlanning` planning event is `agent:planning`, execution emits `agent:started`; container mode emits `agent:started` for both

**Priority:** P3
**Observation:** April 20 F17 unaddressed. Host `runAgentPlanning` publishes `type: 'agent:planning'` at entry (`stream-handler.ts:553`) and never emits `agent:started`. Host `runAgentExecution` emits `agent:started` (line 1099). Container `agent-runner/src/index.ts:531,1070` emits `agent:started` for both phases. UI subscribers that key on `agent:started` to reset per-run state miss the planning phase in host-mode only. The April 20 review noted this; `specs/events_review/` documents the invariant. Combined with the duplication risk (F12), it's an event-contract drift.
**Risk:** UI components keying on `agent:started` for per-run reset (e.g. token counters, timeline render) will not reset on host-mode planning — small visual bug that compounds with F03-01/F03-02 (host-mode planning has the most divergent contract).
**Recommendation:** Emit `agent:started{phase:'planning'}` from `runAgentPlanning` immediately after the SDK session create (`stream-handler.ts:645`), matching `runAgentExecution`. Keep `agent:planning` as an additional breadcrumb or retire it; `event-type-map.ts` already has a slot.
**Effort:** XS.
**Links:** `specs/events_review/`, `src/lib/agents/event-type-map.ts`.

## Open questions

1. **Hooks: keep or kill?** Findings F03-01 and F03-02 hinge on whether hook scaffolding is a feature or abandoned infrastructure. Tool whitelisting and audit logging are "supposed" features per `specs/application/security/`; the runtime reality is they are off. A binding decision is needed.
2. **AgentCore: kill date?** F03-04/F03-05 plus the existing F1 from April 20 ("dead code behind a flag") accumulate. The migrations 0010/0011 + the `Dockerfile.agentcore` + the `bedrock-agentcore` runtime dep plus ~1500 LoC of bridge/instance code now exist behind `AGENTCORE_ENABLED` that nothing in the codebase ever sets. If the path is not coming back in the next quarter, deletion is cheaper than maintaining the disabled scaffolding.
3. **Plan TTL semantics.** F03-08 — is the 60-min TTL a UX hint or a security/quality boundary? If the latter, DB enforcement is required.
4. **Skill chaining on host mode.** F03-03 — is it a documented feature or container-only? If documented, add the host implementation; if not, remove the `executionSkillId` schema column from the `tasks` table.
5. **`reconcile()` vs `recoverOrphanedTasks()`.** F03-12 — two near-identical paths. Pick one and delete the other. Recommend keeping `recoverOrphanedTasks` (broader, runs without services) and dropping `reconcile()`.
