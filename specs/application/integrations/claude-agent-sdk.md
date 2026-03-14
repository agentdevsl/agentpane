# Claude Agent SDK Integration Specification

## Overview

Specification for integrating the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.63) into AgentPane. This document covers the `unstable_v2_createSession` API, plan mode with `ExitPlanMode`, execution mode with `acceptEdits`, streaming event handling, stored plan options, and session events published to Durable Streams.

---

## Package Information

| Package | Version | Purpose |
|---------|---------|---------|
| @anthropic-ai/claude-agent-sdk | 0.2.63 | Agentic AI execution with session-based API |
| zod | 4.3.6 | Schema validation for tool inputs |

---

## Core Concepts

### unstable_v2_createSession API

The SDK's primary entry point is `unstable_v2_createSession()`, which creates a session object for sending prompts and streaming responses.

```typescript
import { type CanUseTool, unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  env: buildSdkEnv(),
  permissionMode: 'plan',           // or 'acceptEdits'
  allowedTools: ['Read', 'Edit'],   // optional tool whitelist
  executableArgs: ['--add-dir', cwd],
  canUseTool,                        // optional tool interception callback
});

// Send prompt and stream responses
await session.send(prompt);
for await (const msg of session.stream()) {
  // Handle messages...
}
session.close();
```

### Permission Modes

| Mode | Purpose | Behavior |
|------|---------|----------|
| `'plan'` | Planning phase | Agent can read/explore but will call `ExitPlanMode` when plan is ready |
| `'acceptEdits'` | Execution phase | Agent auto-accepts file edits, executes the approved plan |
| _(none)_ | Compose / utility | No permission system injected; agent follows custom system prompt directly |

> **CRITICAL**: Never use `permissionMode: 'plan'` for the Terraform Compose service. It injects Claude Code's planning system instructions, causing the model to ask for approval ("The plan is ready for your review") instead of generating HCL code. The session should be created without a `permissionMode` so the model follows the compose system prompt directly.

### Environment Setup

```typescript
// src/lib/agents/agent-sdk-utils.ts

/**
 * Build a clean env object for Claude Agent SDK subprocess sessions.
 * Strips CLAUDECODE (prevents "nested session" crash) and sensitive vars.
 */
export function buildSdkEnv(extra: Record<string, string> = {}): Record<string, string> {
  const blocked =
    /^(CLAUDECODE|DATABASE_URL|DB_.*|ENCRYPTION_KEY|SESSION_SECRET|GITHUB_APP_PRIVATE_KEY)$/i;
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.test(key))
  ) as Record<string, string>;
  return { ...base, ...extra };
}
```

---

## Two-Phase Agent Execution

AgentPane uses a plan-then-execute flow for task agents. The `AgentExecutionService` orchestrates the lifecycle: creating worktrees, sessions, and agent runs, then delegating to `runAgentPlanning()` for the planning phase.

### Phase 1: Planning (`runAgentPlanning`)

```typescript
// src/lib/agents/stream-handler.ts

export async function runAgentPlanning(options: StreamHandlerOptions): Promise<AgentRunResult> {
  // Creates session with permissionMode: 'plan'
  const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
    if (toolName === 'ExitPlanMode') {
      exitPlanModeOptions = input as ExitPlanModeOptions | undefined;
    }
    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    permissionMode: 'plan',
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  });

  await session.send(prompt);
  for await (const msg of session.stream()) {
    // Stream tokens, handle turns, detect ExitPlanMode...
  }
  session.close();
}
```

During planning:
- Agent explores the codebase and creates an implementation plan
- The `canUseTool` callback intercepts `ExitPlanMode` to capture plan options
- Token streaming is published as `chunk` events with `phase: 'planning'`
- When `ExitPlanMode` is detected via `tool_use_summary`, planning completes
- An `agent:plan_ready` event is published with the plan and options
- Agent status is set to `'planning'` in the database
- Plan content and options are stored on the task record

### ExitPlanMode Tool and Plan Options

The `ExitPlanMode` tool is called by the agent when it has finished creating its implementation plan. The tool carries options that configure the subsequent execution phase.

```typescript
// src/lib/agents/stream-handler.ts

export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  // Team and remote session features
  launchSwarm?: boolean;
  teammateCount?: number;
  pushToRemote?: boolean;
}
```

**Team fields** for parallel agent spawning:

```typescript
interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;      // Enable team mode
  teammateCount?: number;     // Number of parallel agents
  pushToRemote?: boolean;     // Remote session support
}
```

The `ExitPlanMode` options are captured in two ways (for reliability):
1. **`canUseTool` callback** (preferred): The `CanUseTool` callback always receives the full tool input, including `ExitPlanMode` options. This is the primary capture mechanism.
2. **`tool_use_summary` event** (fallback): Used if `canUseTool` didn't fire. Note that newer SDK versions may not include `tool_input` in this event.

### StoredPlanOptions

Plan options are persisted on the task record as `planOptions`, using the `StoredPlanOptions` type which extends `ExitPlanModeOptions` with SDK session context:

```typescript
// src/db/schema/sqlite/tasks.ts (also in postgres/tasks.ts)

export interface StoredPlanOptions extends ExitPlanModeOptions {
  sdkSessionId?: string;
  planningSandboxId?: string;
}
```

The `plan` and `planOptions` columns are set on the task after planning completes:

```typescript
// src/services/agent/agent-execution.service.ts

await this.db
  .update(tasks)
  .set({
    plan: result.plan,
    planOptions: result.planOptions,
    updatedAt: new Date().toISOString(),
  })
  .where(eq(tasks.id, taskId));
```

### Phase 2: Execution (`runAgentExecution`)

```typescript
// src/lib/agents/stream-handler.ts

export async function runAgentExecution(options: StreamHandlerOptions): Promise<AgentRunResult> {
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    allowedTools,
    permissionMode: 'acceptEdits',
    executableArgs: ['--add-dir', cwd],
  });

  await session.send(prompt);
  for await (const msg of session.stream()) {
    // Stream tokens, handle turns, tool events, turn limits...
  }
  session.close();
}
```

During execution:
- Agent has `acceptEdits` permission to auto-accept file modifications
- Turn count is tracked; `agent:turn_limit` event published at `maxTurns`
- Tool use is published as `tool:start` and `tool:result` events
- Tool results are truncated to 1000 characters for the `tool:result` event
- On completion, `agent:completed` event with usage metrics
- On turn limit, task moves to `waiting_approval` and agent status becomes `paused`

---

## Team Mode

Team mode enables parallel agent execution for complex tasks. When the planning agent determines that a task can be decomposed into independent subtasks, it requests team execution via `ExitPlanModeOptions`.

The execution flow is:

1. Agent calls `ExitPlanMode` with `launchSwarm: true` and `teammateCount: N`
2. `runAgentExecution` detects team configuration in `planOptions`
3. Multiple agent sessions are spawned in parallel, each working on a subset of the plan
4. Each sub-agent gets its own worktree for isolated work
5. If `pushToRemote: true`, agents can work in remote sessions
6. The parent agent coordinates results and merges changes on completion

---

## Stream Message Types

The session's `stream()` yields these message types:

| Message Type | Description | Key Fields |
|-------------|-------------|------------|
| `stream_event` | Token-by-token streaming | `event.delta.text` for text deltas |
| `assistant` | Complete assistant turn | `message.content[]`, `message.usage` |
| `tool_use_summary` | Tool call summary | `tool_name`, `tool_input`, `tool_result`, `is_error` |
| `tool_progress` | Long-running tool progress | `tool_use_id`, `tool_name`, `elapsed_time_seconds` |
| `system` (subtype: `compact_boundary`) | Context compaction boundary | `compact_metadata.trigger`, `compact_metadata.pre_tokens` |
| `result` | Session completed | `total_cost_usd`, `duration_ms`, `num_turns`, `stop_reason`, `usage`, `modelUsage` |

---

## Session Events Published

Events are published to Durable Streams via `sessionService.publish()` for real-time UI updates.

### Planning Phase Events

| Event Type | Data | When |
|------------|------|------|
| `agent:planning` | `{ agentId, runId, model }` | Planning session started |
| `chunk` | `{ agentId, delta, accumulated, phase: 'planning' }` | Each text delta |
| `agent:turn` | `{ agentId, turn, phase: 'planning' }` | Assistant turn completed |
| `tool:start` | `{ agentId, tool, input, phase: 'planning' }` | Tool invocation |
| `agent:tool_progress` | `{ agentId, toolUseId, toolName, elapsedSeconds }` | Long-running tool update |
| `agent:compacted` | `{ agentId, trigger, preTokens }` | Context compacted |
| `agent:plan_ready` | `{ agentId, runId, plan, allowedPrompts }` | Plan ready for review |
| `agent:metrics` | `{ agentId, runId, totalCostUsd, ... }` | Post-session metrics |
| `agent:error` | `{ agentId, runId, error, phase: 'planning' }` | Planning failed |

### Execution Phase Events

| Event Type | Data | When |
|------------|------|------|
| `agent:started` | `{ agentId, runId, maxTurns, model, phase: 'execution' }` | Execution started |
| `chunk` | `{ agentId, delta, accumulated, phase: 'execution' }` | Each text delta |
| `agent:turn` | `{ agentId, turn, maxTurns, remaining, usage }` | Turn completed |
| `tool:start` | `{ agentId, tool, input }` | Tool invocation began |
| `tool:result` | `{ agentId, tool, output, isError }` | Tool returned result |
| `agent:tool_progress` | `{ agentId, toolUseId, toolName, elapsedSeconds }` | Long tool progress |
| `agent:compacted` | `{ agentId, trigger, preTokens }` | Context compacted |
| `agent:turn_limit` | `{ agentId, turn, maxTurns }` | Max turns reached |
| `agent:completed` | `{ agentId, runId, turnCount, usage }` | Finished successfully |
| `agent:metrics` | `{ agentId, runId, totalCostUsd, ... }` | Post-session metrics |
| `agent:error` | `{ agentId, runId, error }` | Execution failed |

### Metrics Event Detail

The `agent:metrics` event includes per-model usage breakdown when available:

```typescript
{
  agentId: string;
  runId: string;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    costUSD: number;
  }>;
  stopReason?: string | null;
}
```

---

## StreamHandlerOptions

```typescript
// src/lib/agents/stream-handler.ts

export interface StreamHandlerOptions {
  agentId: string;
  sessionId: string;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  cwd: string;
  hooks: AgentHooks;
  sessionService: {
    publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
  };
}
```

---

## AgentRunResult

```typescript
export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
  turnCount: number;
  result?: string;
  plan?: string;
  planOptions?: ExitPlanModeOptions;
  error?: string;
  metrics?: {
    totalCostUsd?: number;
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    stopReason?: string | null;
  };
}
```

### Status Mapping to Database

The `AgentRunResult.status` values map to database enum values in `AgentExecutionService`:

| SDK Status | DB Agent Status | DB Run Status | Task Column |
|-----------|----------------|---------------|-------------|
| `planning` | `planning` | `running` | stays `in_progress` |
| `completed` | `idle` | `completed` | `waiting_approval` |
| `turn_limit` | `paused` | `paused` | `waiting_approval` |
| `paused` | `paused` | `paused` | `waiting_approval` |
| `error` | `error` | `error` | unchanged |

---

## Agent Execution Lifecycle

The `AgentExecutionService` manages the full agent lifecycle:

1. **Start** (`start(agentId, taskId?)`):
   - Validates agent is idle and task is in backlog
   - Checks project concurrency limits
   - Creates worktree, session, and agent run records
   - Sets agent status to `planning`
   - Resolves model via cascade: Task.modelOverride -> Agent.config.model -> Project.config.model -> Global setting -> Default
   - Fires `executeAgentAsync()` which calls `runAgentPlanning()`

2. **Planning completes**:
   - Plan and planOptions stored on task record
   - Agent status remains `planning`
   - Task stays in `in_progress` awaiting user approval

3. **Approval** (user action triggers execution phase):
   - `runAgentExecution()` called with approved plan
   - Agent status set to `running`

4. **Execution completes**:
   - Agent status set to `idle`, task moves to `waiting_approval`
   - Agent run record updated with turn count and metrics

5. **Stop** (`stop(agentId)`):
   - Aborts via `AbortController`
   - Agent status set to `idle`

6. **Error handling**:
   - `handleAgentError()` determines recovery action (pause vs error)
   - Error event published to session

---

## Utility Query Function

For non-task SDK usage (workflow analysis, task creation), the `agentQuery()` utility provides a simplified interface:

```typescript
// src/lib/agents/agent-sdk-utils.ts

export async function agentQuery(
  prompt: string,
  options?: AgentQueryOptions
): Promise<AgentQueryResult> {
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
  });
  // ... stream and collect response
}
```

This creates a session without `permissionMode` (no planning/execution flow) and returns the accumulated text with usage information. The session is always closed in a `finally` block.

---

## PreToolUse / PostToolUse Hooks

Tool hooks provide interception points for policy enforcement, event publishing, and audit logging.

```typescript
// src/lib/agents/types.ts

export interface AgentHooks {
  PreToolUse: Array<{
    hooks: Array<(input: {
      tool_name: string;
      tool_input: Record<string, unknown>;
    }) => Promise<{ decision?: 'block'; message?: string }>>;
  }>;
  PostToolUse: Array<{
    hooks: Array<(input: {
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_response: ToolResponse;
      duration_ms: number;
    }) => Promise<Record<string, unknown>>>;
  }>;
}
```

Hooks are used in the `executeToolWithHooks()` function for custom tool execution with policy enforcement. The `createAgentHooks()` factory in `src/lib/agents/hooks/index.ts` builds hooks with agent context (agentId, sessionId, taskId, etc.) for streaming and audit purposes.

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/lib/agents/stream-handler.ts` | `runAgentPlanning()`, `runAgentExecution()`, `ExitPlanModeOptions` |
| `src/lib/agents/agent-sdk-utils.ts` | `buildSdkEnv()`, `agentQuery()` utility |
| `src/lib/agents/types.ts` | AgentHooks, ToolResponse, ToolContext types |
| `src/lib/agents/hooks/index.ts` | `createAgentHooks()` factory |
| `src/lib/agents/tools/index.ts` | Tool handler registry |
| `src/services/agent/agent-execution.service.ts` | Agent lifecycle management, plan storage |
| `src/services/agent/types.ts` | AgentStartResult, service interfaces |
| `src/db/schema/sqlite/tasks.ts` | `StoredPlanOptions` type, task schema |
| `src/db/schema/postgres/tasks.ts` | `StoredPlanOptions` type (Postgres variant) |
| `src/services/container-agent.service.ts` | Container-based agent execution |
| `src/lib/agents/container-bridge.ts` | Container stdout event bridge |
| `src/lib/agents/agentcore-bridge.ts` | AgentCore SSE event bridge |
| `src/lib/agents/recovery.js` | `handleAgentError()` for error recovery |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Durable Sessions](./durable-sessions.md) | Receives agent events via session publish |
| [Database Schema](../database/schema.md) | Agent, Session, Task tables; `StoredPlanOptions` type |
| [Agent Service](../services/agent-service.md) | Agent lifecycle state machine |
| [Task Service](../services/task-service.md) | Task workflow including plan approval |
| [Error Catalog](../errors/error-catalog.md) | AgentError types |
| [Sandbox](../security/sandbox.md) | Container execution environment |
| [Wireframes](../wireframes/) | Stream view, tool output display |
