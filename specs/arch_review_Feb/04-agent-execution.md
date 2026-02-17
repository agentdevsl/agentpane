# 04 - Agent Execution Architecture Review

## 1. Overview

The agent execution subsystem is the core engine of AgentPane, orchestrating the full lifecycle of AI coding agents from task pickup through planning, execution, and completion. The architecture follows a two-phase model (plan then execute) backed by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), with real-time event streaming via Durable Streams.

**Key components:**

| File | Purpose |
|------|---------|
| `src/services/agent/agent-execution.service.ts` | Agent lifecycle management, start/stop/pause/resume |
| `src/lib/agents/stream-handler.ts` | Claude SDK session creation, streaming, event processing |
| `src/lib/agents/agent-sdk-utils.ts` | Utility for single-query SDK sessions |
| `src/lib/agents/recovery.ts` | Error classification and retry logic |
| `src/lib/agents/hooks/index.ts` | Hook factory: streaming, audit, tool whitelist |
| `src/lib/agents/hooks/streaming.ts` | Tool start/result event publishing |
| `src/lib/agents/hooks/audit.ts` | Audit log insertion per tool call |
| `src/lib/agents/hooks/tool-whitelist.ts` | Pre-tool-use allow/block policy |
| `src/lib/agents/tools/index.ts` | Tool registry (read_file, edit_file, write_file, bash, glob, grep) |
| `src/lib/agents/types.ts` | Zod schemas, hook interfaces, ToolResponse type |
| `src/services/agent/types.ts` | Service-layer type exports, queue types |
| `src/lib/errors/agent-errors.ts` | Error constants (NOT_FOUND, ALREADY_RUNNING, etc.) |
| `src/lib/errors/concurrency-errors.ts` | Concurrency limit errors |
| `src/lib/utils/resolve-model.ts` | Model cascade resolution |
| `src/server/routes/agents.ts` | REST endpoints for agent CRUD, start/stop/pause/resume |
| `src/server/routes/tasks.ts` | Task move endpoint, plan approve/reject |

**Assessment:** The architecture is well-structured with clear separation between orchestration (execution service), SDK integration (stream handler), and cross-cutting concerns (hooks, error handling). However, there are several significant issues around state consistency, missing abort signal propagation, incomplete swarm mode, and a recovery system that is defined but never actually retries.

---

## 2. Agent Lifecycle

### State Machine (Spec vs. Implementation)

The specification (`specs/application/state-machines/agent-lifecycle.md`) defines an XState-based formal state machine with six states: `idle`, `starting`, `running`, `paused`, `error`, `completed`. The implementation does **not** use XState or any formal state machine library. Instead, status transitions are performed by direct database UPDATE statements scattered across `AgentExecutionService` methods.

**Implemented states in execution service:**

| Status | Set in | Context |
|--------|--------|---------|
| `starting` | `start()` line 145 | After concurrency check, before planning |
| `planning` | `start()` line 175 | Immediately after `starting`, before SDK session |
| `running` | `resume()` line 505 | When resuming paused agent |
| `paused` | `executeAgentAsync()` line 377 | On turn_limit or paused result |
| `error` | `executeAgentAsync()` line 395 | On error result |
| `idle` | `stop()` line 460, `executeAgentAsync()` line 354 | On stop or completed |

**Key observation:** The `planning` status is used in the implementation but does not exist in the spec's state machine. The spec defines six statuses; the implementation effectively uses seven (`idle`, `starting`, `planning`, `running`, `paused`, `error` -- `completed` is transient, agent goes back to `idle`).

### State Transitions

The `start()` method (`agent-execution.service.ts:58-255`) performs the following sequence:

1. Validate agent exists and is `idle` (line 62-72)
2. Find task (specific or next from backlog) (line 74-93)
3. Check concurrency availability (line 96-104)
4. Move task to `in_progress` (line 106)
5. Create worktree (line 108-116)
6. Create session (line 118-127)
7. Update task with agentId, sessionId, worktreeId (line 129-140)
8. Set agent to `starting` (line 142-151)
9. Publish `state:update` event (line 153-158)
10. Insert agent run record (line 160-169)
11. Create AbortController and store in module-level map (line 171-172)
12. Set agent to `planning` (line 175)
13. Fire-and-forget `executeAgentAsync()` (line 214-227)
14. Re-read all entities from DB (line 229-243)
15. Return updated entities (line 249-254)

---

## 3. Planning Phase

### Plan Mode Implementation

The planning phase is handled by `runAgentPlanning()` in `stream-handler.ts:89-371`. It creates a Claude Agent SDK session with `permissionMode: 'plan'`, which restricts the agent to read-only operations and provides the `ExitPlanMode` tool.

**SDK Session Creation (`stream-handler.ts:122-128`):**

```typescript
const session = unstable_v2_createSession({
  model,
  env: { ...process.env },
  permissionMode: 'plan',
  executableArgs: ['--add-dir', cwd],
  canUseTool,
});
```

### ExitPlanMode Capture

The plan options are captured through two mechanisms:

1. **`canUseTool` callback** (line 109-117): Intercepts tool invocations before they execute. When `ExitPlanMode` is called, the callback stores the input as `exitPlanModeOptions`. This is the primary/reliable path.

2. **`tool_use_summary` event** (line 185-221): Fallback path that checks the tool_use_summary message. Only used if `canUseTool` didn't fire (e.g., SDK version differences).

### Plan Content

The plan text is derived from `accumulated` -- the concatenation of all streamed text deltas. When `ExitPlanMode` fires, whatever has been accumulated becomes the plan content (`stream-handler.ts:220`).

### Swarm Mode

The `ExitPlanModeOptions` interface (`stream-handler.ts:21-30`) shows that swarm-related fields (`launchSwarm`, `teammateCount`, `pushToRemote`) are **commented out** with a `TODO: Pending GA` note. The CLAUDE.md documents swarm mode as a feature, but the implementation has it disabled.

---

## 4. Execution Phase

### Execution Flow

`runAgentExecution()` (`stream-handler.ts:376-643`) creates a session with `permissionMode: 'acceptEdits'` -- the agent can modify files without user confirmation.

The stream loop processes:

| Message Type | Handler | Purpose |
|-------------|---------|---------|
| `stream_event` (content_block_delta) | Lines 408-429 | Token-by-token text streaming |
| `assistant` | Lines 433-480 | Turn counting, turn limit enforcement |
| `tool_use_summary` | Lines 483-509 | Tool start/result event publishing |
| `tool_progress` | Lines 512-529 | Long-running tool progress updates |
| `system` (compact_boundary) | Lines 532-544 | Context compaction events |
| `result` | Lines 547-606 | Final result with metrics |

### Turn Limit Enforcement

Turn limit checking occurs in the `assistant` message handler (`stream-handler.ts:464-479`). When `turn >= maxTurns`, the session is closed and a `turn_limit` result is returned. This is handled upstream in `executeAgentAsync()` which maps it to `paused` status.

### Tool Result Truncation

Tool results are truncated to 1000 characters in the execution phase (`stream-handler.ts:505`):
```typescript
output: toolSummary.tool_result?.slice(0, 1000),
```

This truncation only applies to the event published to the session stream for UI display -- the actual tool result is still available to the SDK.

---

## 5. Swarm Mode

**Status: Not Implemented.**

The CLAUDE.md documentation describes a swarm mode where `ExitPlanMode` can request `launchSwarm: true` with a `teammateCount` to spawn multiple parallel agents. However, in the actual `ExitPlanModeOptions` interface (`stream-handler.ts:21-30`), all swarm-related fields are commented out:

```typescript
export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  // TODO: Pending GA -- swarm and remote session features
  // pushToRemote?: boolean;
  // remoteSessionId?: string;
  // remoteSessionUrl?: string;
  // remoteSessionTitle?: string;
  // launchSwarm?: boolean;
  // teammateCount?: number;
}
```

The `agent:plan_ready` event only publishes `allowedPrompts`, not any swarm configuration. There is no multi-agent spawning logic anywhere in the codebase for host-mode execution.

---

## 6. Stream Handler

### Event Processing

Both `runAgentPlanning` and `runAgentExecution` follow the same streaming pattern:

1. Create SDK session with `unstable_v2_createSession`
2. Send prompt via `session.send(prompt)`
3. Iterate `session.stream()` async generator
4. Match on `msg.type` with if-else chain
5. Publish typed events via `sessionService.publish()`
6. Close session on `result` message or error

### Message Accumulation

Both functions accumulate text in a local `accumulated` variable. Text deltas from `stream_event` messages are appended (`accumulated += event.delta.text`), but `assistant` messages **overwrite** the accumulated text (`accumulated = textContent` at lines 172 and 448). This means:

- During streaming, `accumulated` grows incrementally from deltas
- When the full assistant message arrives, `accumulated` is replaced with the final content
- If no text deltas were streamed (e.g., SDK version change), `accumulated` still gets set from the assistant message

### Metrics Collection

The `result` message handler extracts SDK metrics including:
- `total_cost_usd` -- Total API cost
- `duration_ms` -- Wall-clock duration
- `duration_api_ms` -- API-only duration
- `num_turns` -- SDK-reported turn count
- `modelUsage` -- Per-model token breakdown (input, output, cache read, cost)
- `stop_reason` -- Why the session ended

These are published as `agent:metrics` events.

### Type Safety

The stream handler uses extensive `as` type assertions for SDK messages (`stream-handler.ts:138, 162, 186, 226, 246, 261`). The SDK types come from an `unstable_v2` API surface, so the message shapes are not formally typed. This is pragmatic but fragile -- SDK updates could silently break message handling.

---

## 7. Error Recovery

### Recovery Module (`recovery.ts`)

The module defines:

1. **`isRetryableError()`** (line 15-28): Pattern-matches error messages against retryable patterns (rate limit, timeout, connection, 503, 529, overloaded).

2. **`withRetry()`** (line 34-62): Generic retry wrapper with exponential backoff. Default: 3 retries, 1s initial delay, 30s max delay, 2x backoff factor.

3. **`handleAgentError()`** (line 79-128): Classifies errors into recovery actions:
   - Rate limit / 429 --> `pause` (with `shouldRetry: true`)
   - Turn limit exceeded --> `pause`
   - Context length exceeded --> `retry` (with `shouldRetry: true`)
   - Network errors --> `retry`
   - Unknown --> `fail`

### Recovery Usage in Execution Service

In the `catch` block of `executeAgentAsync()` (line 404-443):

```typescript
const recovery = handleAgentError(error, { agentId, taskId, maxTurns, currentTurn: 0 });
```

The recovery result is used **only** to decide between `paused` and `error` status:
```typescript
status: recovery.action === 'pause' ? 'paused' : 'error',
```

**Critical gap:** The `shouldRetry` and `retry` action are never acted upon. If `handleAgentError` returns `{ action: 'retry', shouldRetry: true }`, the execution service does **not** retry. It sets the agent to `error` status. The `withRetry()` utility is defined but never called for agent execution.

---

## 8. Findings

### AE-001: AbortController Created But Never Passed to SDK Session

**Severity:** High

An `AbortController` is created and stored in the `runningAgents` map (`agent-execution.service.ts:171-172`) for each agent run. However, it is **never passed** to `runAgentPlanning()` or the SDK session as a signal. When `stop()` calls `controller.abort()` (`agent-execution.service.ts:455`), the abort signal does not reach the Claude Agent SDK session, so the agent may continue running despite being "stopped".

**Affected files:**
- `src/services/agent/agent-execution.service.ts:171-172` (creation)
- `src/services/agent/agent-execution.service.ts:455` (abort call)
- `src/lib/agents/stream-handler.ts:122-128` (session creation, no signal parameter)

**Recommendation:** Pass the `AbortController.signal` to both `runAgentPlanning` and `runAgentExecution`, and wire it into the SDK session or use it to break out of the stream loop. Alternatively, use `session.close()` triggered by the abort signal.

---

### AE-002: Race Condition Between Task Move and Concurrency Check

**Severity:** High

In `start()`, the task is moved to `in_progress` at line 106 (`this.taskService.moveColumn(task.id, 'in_progress')`) **before** the worktree, session, and agent are fully set up. If the worktree or session creation fails (lines 108-127), the task remains in `in_progress` with no agent working on it -- an orphaned state.

The concurrency check happens before the move (line 96), but two concurrent `start()` calls could both pass the check before either has incremented the running count, since `getRunningCount` queries agents with status `running` but the agent status at this point is still `idle` (it becomes `starting` only at line 145).

**Affected files:**
- `src/services/agent/agent-execution.service.ts:96-106` (check then move)
- `src/services/agent/agent-execution.service.ts:108-127` (can fail after move)

**Recommendation:** Wrap the entire start sequence in a database transaction. Move the task to `in_progress` only after all resources (worktree, session) are successfully created. Consider using an optimistic locking pattern or a `FOR UPDATE` row lock on the agent record.

---

### AE-003: Recovery System Defines Retry Logic But Never Retries

**Severity:** Medium

The `recovery.ts` module defines `withRetry()` with exponential backoff and `handleAgentError()` that returns `{ shouldRetry: true, action: 'retry' }` for network errors and context length issues. However, `executeAgentAsync()` never calls `withRetry()` and ignores the `shouldRetry` flag entirely. The recovery result is only used to decide between `paused` and `error` DB status.

**Affected files:**
- `src/lib/agents/recovery.ts:34-62` (`withRetry` -- never called for agent execution)
- `src/lib/agents/recovery.ts:79-128` (`handleAgentError` -- `shouldRetry` ignored)
- `src/services/agent/agent-execution.service.ts:404-443` (catch block)

**Recommendation:** Either implement actual retry logic using `withRetry()` for retryable errors, or remove the retry-related code to avoid confusion. If retry is implemented, add a maximum retry count and ensure the AbortController signal is checked between retries.

---

### AE-004: `planning` Status Not in Spec State Machine, Causes DB Enum Mismatch

**Severity:** Medium

The agent execution service uses a `planning` status (`agent-execution.service.ts:175, 333`), and the stream handler returns `{ status: 'planning' }`. However, the spec state machine (`specs/application/state-machines/agent-lifecycle.md`) does not include `planning` as a valid state. The `executeAgentAsync` status mapping (line 293-315) explicitly maps `'planning'` to `'running'` for the `agentRuns` table because `planning` is not a valid DB enum for runs -- but it is used directly for the `agents` table status.

This dual representation (planning in agents table, running in agentRuns table) can cause confusion and inconsistent UI display.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:175` (sets `planning`)
- `src/services/agent/agent-execution.service.ts:293-315` (status mapping)
- `src/lib/agents/stream-handler.ts:34` (`AgentRunResult.status` includes `'planning'`)
- `specs/application/state-machines/agent-lifecycle.md` (no `planning` state)

**Recommendation:** Either add `planning` to the formal state machine spec and DB enum, or use an existing state (`starting`) combined with a separate `phase` field to distinguish planning from execution.

---

### AE-005: Swarm Mode Documented But Not Implemented

**Severity:** Medium

The CLAUDE.md documentation describes swarm mode as a feature where `ExitPlanMode` can request `launchSwarm: true` with `teammateCount`. The `ExitPlanModeOptions` interface has all swarm fields commented out with `TODO: Pending GA`. The `agent:plan_ready` event does not include swarm data. There is no swarm spawning logic in the codebase.

**Affected files:**
- `src/lib/agents/stream-handler.ts:21-30` (commented-out fields)
- `CLAUDE.md` (documents swarm as implemented)

**Recommendation:** Either implement swarm mode or update CLAUDE.md to mark it as planned/future. The current state is misleading for developers referencing the documentation.

---

### AE-006: Fire-and-Forget Execution With No Status Guarantee

**Severity:** Medium

`executeAgentAsync()` is called as fire-and-forget (`agent-execution.service.ts:214-227`). The `start()` method immediately re-reads entities from the database and returns them (lines 229-254). Since `executeAgentAsync` is asynchronous, the returned agent status may be stale -- it might show `planning` even though the planning session has already errored out. There is no mechanism to detect if the fire-and-forget execution fails immediately.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:214-227` (fire-and-forget)
- `src/services/agent/agent-execution.service.ts:229-254` (read-after-fire)

**Recommendation:** Consider adding a short initial health check (e.g., confirming the SDK session is created successfully) before returning from `start()`. Alternatively, use the AbortController signal to detect immediate failures and return an error response.

---

### AE-007: Module-Level `runningAgents` Map Not Process-Safe

**Severity:** Medium

The `runningAgents` map (`agent-execution.service.ts:30`) is module-level state. If the application is deployed with multiple processes or workers, each process has its own map. A `stop()` call on one process cannot abort an agent running on another process. The comment acknowledges this is module-level but doesn't address multi-process scenarios.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:30` (module-level Map)
- `src/services/agent/agent-execution.service.ts:449-468` (stop relies on Map)

**Recommendation:** For single-process deployments (current), this is acceptable. For future scaling, store agent run state (including a cancellation flag) in the database and have the stream loop poll for cancellation. Alternatively, use the database-backed stop file pattern used by the container agent service.

---

### AE-008: `getRunningCount` Queries Only `running` Status, Missing `starting` and `planning`

**Severity:** Medium

`getRunningCount()` (`agent-execution.service.ts:544-550`) only counts agents with `status = 'running'`. Agents in `starting` or `planning` status are actively consuming resources but are not counted toward the concurrency limit. This allows more agents than `maxConcurrentAgents` to be running simultaneously.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:544-550`
- `src/services/agent/agent-execution.service.ts:96-104` (concurrency check using getRunningCount)

**Recommendation:** Include `starting` and `planning` statuses in the running count query:
```typescript
where: and(
  eq(agents.projectId, projectId),
  inArray(agents.status, ['running', 'starting', 'planning'])
)
```

---

### AE-009: `resume()` Does Not Actually Resume Agent Execution

**Severity:** High

The `resume()` method (`agent-execution.service.ts:494-522`) sets the agent status to `running` and publishes an `approval:rejected` event, but it does **not** restart the SDK session or continue execution. It returns a hardcoded `{ status: 'paused' }` result. The agent remains inert with no active SDK session processing turns.

There is no call to `runAgentExecution()` after plan approval either -- `approvePlan()` delegates to `containerAgentService.approvePlan()`, which is the container-based path. The host-mode agent has no execution continuation path after planning completes.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:494-522` (resume method)
- `src/server/routes/tasks.ts:259-281` (approve-plan route)
- `src/services/task.service.ts:146-169` (approvePlan delegates to container service)

**Recommendation:** The `resume()` method needs to create a new SDK session (via `runAgentExecution`) with the plan context and continue execution. For plan approval, add a host-mode execution path in `approvePlan` that calls `runAgentExecution` with the approved plan as the prompt and the `allowedPrompts` from `ExitPlanMode`.

---

### AE-010: Hooks Created But Not Passed to SDK Session

**Severity:** Medium

Agent hooks (streaming, audit, tool whitelist) are created in `start()` (`agent-execution.service.ts:201-210`) and passed to `executeAgentAsync()`. However, `executeAgentAsync()` passes them to `runAgentPlanning()`, which only uses the `canUseTool` callback and does **not** use the hooks for tool call interception. The SDK handles tool execution internally; the hooks created by `createAgentHooks` are designed for a custom tool execution model (via `executeToolWithHooks`), but the stream handler relies on `tool_use_summary` events instead.

The `executeToolWithHooks` function exists (`stream-handler.ts:657-690`) but is never called by the main execution flow.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:201-210` (hooks created)
- `src/lib/agents/stream-handler.ts:89` (hooks parameter accepted but not used for tool interception)
- `src/lib/agents/stream-handler.ts:657-690` (`executeToolWithHooks` -- unused)

**Recommendation:** Either integrate the hooks into the SDK session's `canUseTool`/`afterToolUse` callbacks, or remove the hook system from the planning flow and rely solely on `tool_use_summary` events for streaming and audit. The current hybrid approach is confusing.

---

### AE-011: Accumulated Text Overwrite in Assistant Message Handler

**Severity:** Low

In both `runAgentPlanning` (line 171-173) and `runAgentExecution` (line 447-449), when a complete `assistant` message arrives, the accumulated text is **replaced** rather than appended:

```typescript
if (textContent) {
  accumulated = textContent; // Overwrites streamed deltas
}
```

This is intentional (the assistant message contains the final version), but it means that if multiple assistant messages are sent (multi-turn), `accumulated` only retains the **last** message's text. For planning, this means the plan content may only capture the agent's final response, not the full conversation.

**Affected files:**
- `src/lib/agents/stream-handler.ts:171-173` (planning)
- `src/lib/agents/stream-handler.ts:447-449` (execution)

**Recommendation:** If full conversation history is needed, accumulate across turns instead of overwriting. For the current use case (plan = last message), this behavior is acceptable but should be documented with a comment.

---

### AE-012: Environment Passed to SDK Includes Full `process.env`

**Severity:** Low

Both `runAgentPlanning` and `runAgentExecution` pass `env: { ...process.env }` to the SDK session (`stream-handler.ts:124, 395`). This exposes all server environment variables to the agent subprocess, including potentially sensitive values (database URLs, API keys, internal service tokens).

**Affected files:**
- `src/lib/agents/stream-handler.ts:124` (planning session)
- `src/lib/agents/stream-handler.ts:395` (execution session)
- `src/lib/agents/agent-sdk-utils.ts:70` (utility query session)

**Recommendation:** Create a filtered environment object that only includes variables needed by the agent (e.g., `ANTHROPIC_API_KEY`, `PATH`, `HOME`). This follows the principle of least privilege and prevents accidental exposure of secrets.

---

### AE-013: Tool Whitelist Hook Has Empty-List Bypass

**Severity:** Low

The `createToolWhitelistHook` (`tool-whitelist.ts:3-23`) allows all tools when `allowedTools.length === 0`. This is a design choice (no list = no restrictions), but it means that newly created agents with default empty config get unrestricted tool access. If the intent is for the agent to use all SDK-managed tools, this is fine, but it could be surprising if someone expects "no allowed tools" to mean "block everything".

**Affected files:**
- `src/lib/agents/hooks/tool-whitelist.ts:7-9`
- `src/services/agent/agent-execution.service.ts:207,219` (defaults to `[]`)

**Recommendation:** Add a comment documenting this behavior. Consider whether a default set of safe tools should be used when no explicit list is provided.

---

### AE-014: Streaming Hook Tool Call Pairing Can Fail for Identical Concurrent Calls

**Severity:** Low

The streaming hook (`hooks/streaming.ts:40-58`) pairs PreToolUse and PostToolUse events using a key derived from `toolName + JSON.stringify(toolInput)`. If the same tool is invoked twice with identical inputs before either completes, the Map will overwrite the first entry, and the first PostToolUse will get the second PreToolUse's ID. The code has a comment acknowledging this FIFO assumption (line 38-39).

**Affected files:**
- `src/lib/agents/hooks/streaming.ts:40-58` (key generation)
- `src/lib/agents/hooks/streaming.ts:67` (Map-based tracking)

**Recommendation:** Use a composite key that includes a sequence counter or the SDK's `tool_use_id` if available, to disambiguate concurrent identical calls. This is a low-probability issue in practice since identical simultaneous tool calls are rare.

---

### AE-015: Duplicate Task Move to `in_progress`

**Severity:** Low

In `start()`, the task is moved to `in_progress` via `this.taskService.moveColumn(task.id, 'in_progress')` at line 106. Then at lines 129-140, the task is updated again with the same `column: 'in_progress'` plus additional fields (agentId, sessionId, worktreeId, branch, startedAt). This results in two database writes for the same column transition, with an intermediate state where the task is `in_progress` but has no agent assigned.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:106` (first move)
- `src/services/agent/agent-execution.service.ts:129-140` (second update with same column)

**Recommendation:** Combine these into a single update that sets both the column and the associated agent/session/worktree fields atomically. This eliminates the window where the task is in_progress without an agent.

---

### AE-016: `currentTurn` Hardcoded to 0 in Error Handler Context

**Severity:** Low

In the catch block of `executeAgentAsync()` (`agent-execution.service.ts:413`), the `currentTurn` is hardcoded to `0`:

```typescript
const recovery = handleAgentError(error, {
  agentId,
  taskId,
  maxTurns: options.maxTurns,
  currentTurn: 0, // Always 0, regardless of actual turn count
});
```

The actual turn count from the stream handler is not available in the catch block, so the `handleAgentError` function's turn-limit check (`context.currentTurn >= context.maxTurns`) will never trigger from this path.

**Affected files:**
- `src/services/agent/agent-execution.service.ts:408-413`

**Recommendation:** Accept the turn count as part of the error propagation, or wrap the stream handler to always include the current turn in thrown errors.

---

## 9. Summary

### Severity Distribution

| Severity | Count | Finding IDs |
|----------|-------|-------------|
| High | 3 | AE-001, AE-002, AE-009 |
| Medium | 5 | AE-003, AE-004, AE-005, AE-006, AE-007, AE-008, AE-010 |
| Low | 6 | AE-011, AE-012, AE-013, AE-014, AE-015, AE-016 |

### Top Priorities

1. **AE-009 (High):** `resume()` and plan approval do not restart execution for host-mode agents. This is a functional gap -- agents that complete planning cannot proceed to execution without the container service.

2. **AE-001 (High):** AbortController is created but never wired to the SDK session. Agent stop is a no-op at the SDK level.

3. **AE-002 (High):** Race condition in `start()` can leave tasks orphaned in `in_progress` with no agent, and the concurrency check has a TOCTOU window.

4. **AE-008 (Medium):** Concurrency counting excludes `starting` and `planning` agents, allowing resource overcommitment.

5. **AE-003 (Medium):** Dead retry code creates false confidence that retries are happening.

### Architecture Strengths

- Clean separation between orchestration (execution service) and SDK integration (stream handler)
- Well-designed hook system for tool interception (streaming, audit, whitelist)
- Comprehensive event publishing for real-time UI updates
- Model cascade resolution (task > agent > project > global > default)
- Exhaustive status mapping with TypeScript `never` check for new statuses
- Good error classification taxonomy in recovery module
- Metrics capture from SDK (cost, duration, token usage)
