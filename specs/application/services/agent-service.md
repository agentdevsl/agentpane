# AgentService Specification

## Overview

The AgentService manages agent lifecycle, execution, and concurrency control for the AgentPane multi-agent task management system. It is implemented as a **facade pattern** composing three focused services:

- **AgentCrudService** (`src/services/agent/agent-crud.service.ts`) - CRUD operations
- **AgentExecutionService** (`src/services/agent/agent-execution.service.ts`) - Lifecycle and execution
- **AgentQueueService** (`src/services/agent/agent-queue.service.ts`) - Queue management (stub)

The facade (`src/services/agent.service.ts`) re-exports all methods for backward compatibility. New code may import the focused services directly from `src/services/agent/index.ts`.

## Related Wireframes

- [Agent Configuration Dialog](../wireframes/agent-config-dialog.html) - Agent creation/update UI
- [Error State Expanded](../wireframes/error-state-expanded.html) - Error handling and retry UI
- [Queue Waiting State](../wireframes/queue-waiting-state.html) - Concurrency and queue management UI

---

## Agent Types

Agents have a `type` field with three variants:

| Type | Description |
|------|-------------|
| `task` | Default. Executes a specific task from the Kanban board |
| `conversational` | Interactive agent for user conversations |
| `background` | Long-running background agent |

---

## Agent Status Lifecycle

```
idle -> starting -> planning -> running -> paused -> running -> completed
                          \-> error
                          \-> completed (turn limit)
```

### Status Values

| Status | Description |
|--------|-------------|
| `idle` | Agent is not executing |
| `starting` | Agent is initializing (worktree, session created) |
| `planning` | Agent is in plan mode, exploring codebase and creating implementation plan |
| `running` | Agent is actively executing (post-plan approval) |
| `paused` | Agent paused for user input or turn limit reached |
| `error` | Agent encountered an error |
| `completed` | Agent finished execution |

---

## Interface Definition

```typescript
// src/services/agent.service.ts (facade)
import type { AgentConfig, NewAgent } from '../db/schema';
import type { AgentError } from '../lib/errors/agent-errors';
import type { ConcurrencyError } from '../lib/errors/concurrency-errors';
import type { ValidationError } from '../lib/errors/validation-errors';
import type { Result } from '../lib/utils/result';

export type AgentExecutionContext = {
  agentId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  cwd: string;
  allowedTools: string[];
  maxTurns: number;
  env: Record<string, string>;
};

export type AgentRunResult = {
  runId: string;
  status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
  turnCount: number;
  result?: string;
  error?: string;
  plan?: string;
  planOptions?: ExitPlanModeOptions;
};

export type AgentStartResult = {
  agent: Agent;
  task: Task;
  session: Session;
  worktree: Worktree;
};

export type QueuePosition = {
  taskId: string;
  position: number;
  totalQueued: number;
  estimatedWaitMinutes: number;
  estimatedWaitMs: number;
  estimatedWaitFormatted: string;
};

export type QueueStats = {
  totalQueued: number;
  averageCompletionMs: number;
  recentCompletions: number;
};

export type PreToolUseHook = (input: {
  tool_name: string;
  tool_input: Record<string, unknown>;
}) => Promise<{ deny?: boolean; reason?: string }>;

export type PostToolUseHook = (input: {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}) => Promise<void>;
```

---

## Constructor

The AgentService facade accepts injected dependencies:

```typescript
constructor(
  db: Database,
  worktreeService: WorktreeService,
  taskService: TaskService,
  sessionService: SessionServiceInterface
)
```

Each sub-service receives only the dependencies it needs.

---

## CRUD Operations (AgentCrudService)

### create

Creates a new agent with configuration defaults inherited from the project.

```typescript
async create(input: NewAgent): Promise<Result<Agent, ValidationError>>
```

**Business Rules:**
1. Validates `projectId` references an existing project
2. Merges config with project defaults: `allowedTools`, `maxTurns`, `model`, `systemPrompt`, `temperature`
3. Returns the created agent record

### getById

```typescript
async getById(id: string): Promise<Result<Agent, AgentError>>
```

### list

Lists agents for a project, ordered by most recently updated.

```typescript
async list(projectId: string): Promise<Result<Agent[], never>>
```

### listAll

Lists all agents across all projects.

```typescript
async listAll(): Promise<Result<Agent[], never>>
```

### getRunningCountAll

Gets the count of all running agents across all projects.

```typescript
async getRunningCountAll(): Promise<Result<number, never>>
```

### update

Updates agent configuration. Prevents updating `allowedTools` or `model` while agent is running.

```typescript
async update(id: string, input: Partial<AgentConfig>): Promise<Result<Agent, AgentError | ValidationError>>
```

### delete

Deletes an agent by ID. No running-status guard (any agent can be deleted).

```typescript
async delete(id: string): Promise<Result<void, AgentError>>
```

---

## Execution Operations (AgentExecutionService)

### start

Starts an agent on a task. If no `taskId` is specified, picks the next available task from the backlog.

```typescript
async start(
  agentId: string,
  taskId?: string
): Promise<Result<AgentStartResult, AgentError | ConcurrencyError>>
```

**Execution Flow:**

1. Validate agent exists and is `idle`
2. Find or validate the target task (must be in `backlog`)
3. Check concurrency limits via `checkAvailability()`
4. Move task to `in_progress` via `taskService.moveColumn()`
5. Create worktree via `worktreeService.create()`
6. Create session via `sessionService.create()`
7. Update task with `agentId`, `sessionId`, `worktreeId`, `branch`
8. Set agent status to `starting`, then `planning`
9. Create `agentRuns` record
10. **Start planning phase** via `runAgentPlanning()` (fire-and-forget)
11. Return `AgentStartResult` with all created resources

**Planning Phase:**

The agent enters `planning` status and runs with `permissionMode: 'plan'` in the Claude Agent SDK. During planning:
- Agent explores the codebase
- Agent creates an implementation plan
- Agent calls the `ExitPlanMode` tool when the plan is ready
- Plan content and `ExitPlanModeOptions` are stored on the task record (`plan`, `planOptions`)
- Agent status remains `planning`
- An `agent:plan_ready` event is published

**Model Resolution:**

The model is resolved using a cascade priority:
```
Task.modelOverride -> Agent.config.model -> Project.config.model -> Global setting -> Default
```
This uses `resolveModel()` from `src/lib/utils/resolve-model.ts`.

### executeAgentAsync (private)

Handles async agent execution and updates state based on results:

| Result Status | Agent Status | Task Column |
|---------------|-------------|-------------|
| `planning` | `planning` | stays `in_progress` |
| `completed` | `idle` | `waiting_approval` |
| `turn_limit` | `paused` | `waiting_approval` |
| `paused` | `paused` | `waiting_approval` |
| `error` | `error` or `paused` | unchanged |

Plan content and options are stored on the task record when status is `planning`.

### stop

Stops a running agent by aborting its execution via AbortController.

```typescript
async stop(agentId: string): Promise<Result<void, AgentError>>
```

Resets agent to `idle` with `currentTaskId` and `currentSessionId` cleared.

### pause

Pauses a running agent.

```typescript
async pause(agentId: string): Promise<Result<void, AgentError>>
```

### resume

Resumes a paused agent with optional feedback. Sets agent to `running` and publishes an `approval:rejected` event to the session.

```typescript
async resume(agentId: string, feedback?: string): Promise<Result<AgentRunResult, AgentError>>
```

### checkAvailability

Checks if a project has capacity for another running agent.

```typescript
async checkAvailability(projectId: string): Promise<Result<boolean, never>>
```

Compares running agent count against `project.maxConcurrentAgents` (default: 3).

### getRunningCount

Gets the count of running agents for a specific project.

```typescript
async getRunningCount(projectId: string): Promise<Result<number, never>>
```

### Hook Registration

```typescript
registerPreToolUseHook(agentId: string, hook: PreToolUseHook): void
registerPostToolUseHook(agentId: string, hook: PostToolUseHook): void
```

Hooks are created via `createAgentHooks()` from `src/lib/agents/hooks/index.ts` and handle:
- Streaming events to the session
- Audit logging of tool calls
- Tool whitelist enforcement

---

## Queue Operations (AgentQueueService)

Queue functionality is **not yet implemented**. All methods return stub values:

- `queueTask()` - Returns `QUEUE_FULL` error
- `getQueuePosition()` - Returns `null`
- `getQueueStats()` - Returns empty stats
- `getQueuedTasks()` - Returns empty array

---

## Swarm Mode

When the agent calls `ExitPlanMode`, it can request swarm execution via `ExitPlanModeOptions`:

```typescript
interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;
  teammateCount?: number;
  pushToRemote?: boolean;
}
```

Plan options are stored on the task record as `planOptions` (type `StoredPlanOptions`) which extends `ExitPlanModeOptions` with `sdkSessionId` and `planningSandboxId`.

Swarm children reference their parent via `parentAgentId` on the agent record.

---

## Agent Record Schema

```typescript
agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  type: text('type').$type<AgentType>().default('task').notNull(),
  status: text('status').$type<AgentStatus>().default('idle').notNull(),
  config: text('config', { mode: 'json' }).$type<AgentConfig>(),
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentTurn: integer('current_turn').default(0),
  parentAgentId: text('parent_agent_id'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});
```

Key fields:
- `type` - One of `task`, `conversational`, `background`
- `currentTurn` - Tracks the current turn count during execution
- `parentAgentId` - References parent agent for swarm children

---

## Business Rules

### Turn Limits
- Default max turns: 50 (configurable per agent)
- Turn limit results in `paused` status and task moved to `waiting_approval`

### Concurrency Rules
- Default max concurrent agents: 3 per project (configurable via `project.maxConcurrentAgents`)
- Concurrency checked before starting execution
- Exceeding limit returns `CONCURRENCY_LIMIT_EXCEEDED` error

### Error Recovery
- Errors are handled via `handleAgentError()` from `src/lib/agents/recovery.ts`
- Recovery action may be `pause` (recoverable) or `error` (terminal)

---

## Side Effects

### Database Operations

| Operation | Tables Affected |
|-----------|-----------------|
| `create` | `agents` |
| `start` | `agents`, `agent_runs`, `tasks`, `worktrees`, `sessions` |
| `stop` | `agents` |
| `pause` | `agents` |
| `resume` | `agents` |
| `executeAgentAsync` | `agents`, `agent_runs`, `tasks` |

### Event Publishing

Events published via `sessionService.publish()`:

| Event Type | When |
|------------|------|
| `state:update` | Agent starting |
| `agent:plan_ready` | Planning phase complete |
| `agent:error` | Execution failed |
| `approval:rejected` | Agent resumed with feedback |

---

## Error Conditions

| Error Code | HTTP | Condition |
|------------|------|-----------|
| `AGENT_NOT_FOUND` | 404 | Agent ID doesn't exist |
| `AGENT_ALREADY_RUNNING` | 409 | Attempting to start non-idle agent |
| `AGENT_NOT_RUNNING` | 400 | Attempting to stop agent that isn't running |
| `AGENT_NO_AVAILABLE_TASK` | 400 | No backlog task to execute |
| `AGENT_EXECUTION_ERROR` | 500 | Runtime execution failure |
| `CONCURRENCY_LIMIT_EXCEEDED` | 429 | Max agents reached |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/agent.service.ts` | Facade composing all three sub-services |
| `src/services/agent/agent-crud.service.ts` | CRUD operations |
| `src/services/agent/agent-execution.service.ts` | Agent lifecycle and execution |
| `src/services/agent/agent-queue.service.ts` | Queue management (stub) |
| `src/services/agent/types.ts` | Shared type definitions |
| `src/services/agent/index.ts` | Barrel file |
| `src/lib/agents/stream-handler.ts` | `runAgentPlanning()` - Claude SDK integration |
| `src/lib/agents/hooks/index.ts` | `createAgentHooks()` - streaming and audit |
| `src/lib/agents/recovery.ts` | `handleAgentError()` - error recovery |
| `src/lib/utils/resolve-model.ts` | Model resolution cascade |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | `agents`, `agent_runs` tables |
| [Error Catalog](../errors/error-catalog.md) | Agent and concurrency errors |
| [WorktreeService](./worktree-service.md) | Worktree lifecycle coordination |
| [SessionService](./session-service.md) | Session creation and event publishing |
| [TaskService](./task-service.md) | Task column transitions |
| [ContainerAgentService](./container-agent-service.md) | Container-based agent execution |
| [State Machines](../state-machines/) | Agent status transitions |
