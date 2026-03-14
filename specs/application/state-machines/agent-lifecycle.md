# Agent Lifecycle State Machine Specification

## Overview

Formal state machine definition for agent execution lifecycle in AgentPane. This machine governs the execution states of an AI agent, from initialization through completion or error, managing turn limits, tool access, and event publication.

---

## State Diagram

```
                                  ERROR (recoverable)
                                 +-------------------+
                                 |                   |
                                 v                   |
+--------+     START     +-----------+  PLAN_READY  +----------+    STEP    +---------+
|  idle  |-------------->| starting  |------------->| planning |---------->| running |<--+
+--------+               +-----------+              +----------+           +---------+   |
    ^                          |                         |                   |   |  |    |
    |                          |                         |                   |   |  |    |
    |       ERROR              |              ERROR      |        ERROR      |   |  +----+
    |   (unrecoverable)        |         (unrecoverable) |   (unrecoverable) |   |  STEP (continue)
    |           +              |                +        |         +         |   |
    |           |              |                |        |         |         |   |
    |           v              v                v        v         v         |   | PAUSE
    |       +----------------------------------------------+                |   |
    |       |                    error                     |                |   v
    |       +----------------------------------------------+                | +--------+
    |                     |                                                 | | paused |
    |                     |                                                 | +--------+
    |                     | (after cleanup)                                 |     |
    |                     v                                                 |     | RESUME
    +<--------------------+                                                 |     |
                                                                            |     v
                                                                            +-----+
                                                                            |
                          COMPLETE                                          |
                             +----------------------------------------------+
                             |
                             v
                      +------------+
                      | completed  |
                      +------------+


ASCII State Diagram (Execution Flow):

    +------+      +----------+      +----------+      +---------+      +--------+      +-----------+
    | idle |----->| starting |----->| planning |----->| running |----->| paused |----->| completed |
    +------+      +----------+      +----------+      +---------+      +--------+      +-----------+
       ^               |                |                 |  |             |
       |               |                |                 |  +<------------+
       |               v                v                 v  RESUME
       |          +-------+        +-------+         +-------+
       +<---------|  error|<-------|       |<--------|       |
                  +-------+        +-------+         +-------+
                       |          (on ERROR)         (on ERROR)
                       v
                  (cleanup & return to idle)
```

---

## States

| State | Description | Can Execute Tools | Emits Events | Accepts Input |
|-------|-------------|-------------------|--------------|---------------|
| `idle` | Agent available, no active task | No | No | Yes (START) |
| `starting` | Initializing execution context | No | `agent:starting` | No |
| `planning` | Exploring codebase and creating implementation plan | Yes (read-only) | `agent:planning`, `agent:plan_ready` | No |
| `running` | Actively executing steps | Yes | `agent:step`, `tool:*` | No |
| `paused` | Waiting for user input/approval | No | `agent:paused` | Yes (RESUME) |
| `error` | Execution failed, awaiting decision | No | `agent:error` | Yes (retry/abort) |
| `completed` | Task finished successfully | No | `agent:completed` | No |

### State Properties

```typescript
// db/schema/shared/enums.ts
export const AGENT_STATUS = [
  'idle',
  'starting',
  'planning',
  'running',
  'paused',
  'error',
  'completed',
] as const;
export type AgentStatus = (typeof AGENT_STATUS)[number];

// State metadata
interface AgentStateMetadata {
  idle: {
    canStart: true;
    hasActiveTask: false;
    resourcesAllocated: false;
  };
  starting: {
    canStart: false;
    hasActiveTask: true;
    resourcesAllocated: true;
  };
  planning: {
    canStart: false;
    hasActiveTask: true;
    resourcesAllocated: true;
    canExecuteTools: true;  // Read-only tools for codebase exploration
    awaitingPlanApproval: false;
  };
  running: {
    canStart: false;
    hasActiveTask: true;
    resourcesAllocated: true;
    canExecuteTools: true;
  };
  paused: {
    canStart: false;
    hasActiveTask: true;
    resourcesAllocated: true;
    awaitingInput: true;
  };
  error: {
    canStart: false;
    hasActiveTask: true;
    resourcesAllocated: true;
    requiresDecision: true;
  };
  completed: {
    canStart: true;  // Can start new task
    hasActiveTask: false;
    resourcesAllocated: false;
  };
}
```

---

## Events

| Event | Description | Payload | Source |
|-------|-------------|---------|--------|
| `START` | Begin agent execution | `{ taskId, prompt, options }` | Task workflow |
| `PLAN_READY` | Agent finished planning, plan ready for review | `{ plan, options }` | Agent SDK (ExitPlanMode tool) |
| `APPROVE_PLAN` | User approves the plan, begin execution | `{ feedback? }` | User action |
| `STEP` | Agent completed one turn | `{ turn, toolCalls, output }` | Agent SDK |
| `PAUSE` | Pause for user input | `{ reason, context }` | Agent SDK / User |
| `RESUME` | Continue execution | `{ feedback?, input? }` | User action |
| `ERROR` | Execution error occurred | `{ error, recoverable }` | Agent SDK |
| `COMPLETE` | Agent finished task | `{ result, diff?, turnCount }` | Agent SDK |
| `ABORT` | Force stop execution | `{ reason }` | User action |

### Event Type Definitions

```typescript
// lib/state-machines/agent-lifecycle/events.ts
import type { z } from 'zod';

export type AgentEvent =
  | { type: 'START'; taskId: string; prompt: string; options?: AgentOptions }
  | { type: 'PLAN_READY'; plan: string; options?: PlanOptions }
  | { type: 'APPROVE_PLAN'; feedback?: string }
  | { type: 'STEP'; turn: number; toolCalls: ToolCall[]; output?: string }
  | { type: 'PAUSE'; reason: 'user_input' | 'approval_required' | 'confirmation'; context?: unknown }
  | { type: 'RESUME'; feedback?: string; input?: string }
  | { type: 'ERROR'; error: AppError; recoverable: boolean }
  | { type: 'COMPLETE'; result: string; diff?: string; turnCount: number }
  | { type: 'ABORT'; reason: string };

interface PlanOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;
  teammateCount?: number;
  pushToRemote?: boolean;
}

interface AgentOptions {
  maxTurns?: number;
  allowedTools?: string[];
  model?: string;
  temperature?: number;
}

interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  duration?: number;
  status: 'pending' | 'running' | 'complete' | 'error';
}

// Zod schemas
export const startEventSchema = z.object({
  type: z.literal('START'),
  taskId: z.string().cuid2(),
  prompt: z.string().min(1),
  options: z.object({
    maxTurns: z.number().min(1).max(200).optional(),
    allowedTools: z.array(z.string()).optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(1).optional(),
  }).optional(),
});

export const stepEventSchema = z.object({
  type: z.literal('STEP'),
  turn: z.number().min(1),
  toolCalls: z.array(z.object({
    id: z.string(),
    tool: z.string(),
    input: z.record(z.unknown()),
    output: z.string().optional(),
    duration: z.number().optional(),
    status: z.enum(['pending', 'running', 'complete', 'error']),
  })),
  output: z.string().optional(),
});

export const errorEventSchema = z.object({
  type: z.literal('ERROR'),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number(),
    details: z.record(z.unknown()).optional(),
  }),
  recoverable: z.boolean(),
});

export const completeEventSchema = z.object({
  type: z.literal('COMPLETE'),
  result: z.string(),
  diff: z.string().optional(),
  turnCount: z.number().min(1),
});
```

---

## Guards

Guards are boolean functions that determine if a transition is allowed.

| Guard | Description | Checks |
|-------|-------------|--------|
| `withinTurnLimit` | Agent hasn't exceeded max turns | `currentTurn < maxTurns` |
| `hasValidTask` | Task exists and is assignable | Task in `backlog` or agent's current task |
| `isToolAllowed` | Tool is in agent's whitelist | Tool name in `allowedTools` |
| `isRecoverable` | Error can be retried | `error.recoverable === true` |
| `hasValidSession` | Session exists and is active | Session status is `active` |
| `canPause` | Agent is in pauseable state | Status is `running` |
| `canResume` | Agent can be resumed | Status is `paused` or `error` |

### Guard Implementations

```typescript
// lib/state-machines/agent-lifecycle/guards.ts
import type { Agent, Task, Session, Project } from '@/db/schema';
import type { AgentEvent } from './events';

export interface AgentContext {
  agent: Agent;
  task?: Task;
  session?: Session;
  project: Project;
  currentTurn: number;
  maxTurns: number;
  allowedTools: string[];
  lastError?: AppError;
}

export const guards = {
  withinTurnLimit: (ctx: AgentContext) => {
    return ctx.currentTurn < ctx.maxTurns;
  },

  hasValidTask: (ctx: AgentContext, event: Extract<AgentEvent, { type: 'START' }>) => {
    return ctx.task !== undefined &&
           (ctx.task.column === 'backlog' || ctx.task.column === 'in_progress');
  },

  isToolAllowed: (ctx: AgentContext, toolName: string) => {
    return ctx.allowedTools.includes(toolName);
  },

  isRecoverable: (ctx: AgentContext, event: Extract<AgentEvent, { type: 'ERROR' }>) => {
    return event.recoverable === true;
  },

  hasValidSession: (ctx: AgentContext) => {
    return ctx.session?.status === 'active';
  },

  canPause: (ctx: AgentContext) => {
    return ctx.agent.status === 'running';
  },

  canResume: (ctx: AgentContext) => {
    return ctx.agent.status === 'paused' || ctx.agent.status === 'error';
  },

  notAtTurnLimit: (ctx: AgentContext, event: Extract<AgentEvent, { type: 'STEP' }>) => {
    return event.turn < ctx.maxTurns;
  },

  atTurnLimit: (ctx: AgentContext, event: Extract<AgentEvent, { type: 'STEP' }>) => {
    return event.turn >= ctx.maxTurns;
  },
} as const;

export type Guard = keyof typeof guards;
```

---

## Actions

Actions are side effects executed during transitions.

| Action | Description | Async | Publishes Event |
|--------|-------------|-------|-----------------|
| `initializeExecution` | Set up agent execution context | Yes | `agent:starting` |
| `publishEvent` | Emit event to durable stream | Yes | (varies) |
| `updateStatus` | Update agent status in DB | Yes | `state:update` |
| `executeToolCall` | Run tool and capture output | Yes | `tool:start`, `tool:result` |
| `auditToolCall` | Log tool call to audit table | Yes | None |
| `cleanup` | Release resources, cleanup state | Yes | `agent:cleanup` |
| `incrementTurn` | Increment turn counter | No | None |
| `captureError` | Store error details | Yes | `agent:error` |
| `streamToken` | Emit token to stream | Yes | `stream:token` |

### Action Implementations

```typescript
// lib/state-machines/agent-lifecycle/actions.ts
import type { AgentContext } from './guards';
import type { AgentEvent } from './events';
import { publishAgentEvent, publishWorkflowEvent } from '@/lib/events';
import { AuditService } from '@/lib/services/audit';

export const actions = {
  initializeExecution: async (
    ctx: AgentContext,
    event: Extract<AgentEvent, { type: 'START' }>
  ) => {
    // Create session if needed
    const session = await SessionService.createForAgent({
      agentId: ctx.agent.id,
      projectId: ctx.project.id,
      taskId: event.taskId,
    });

    // Initialize execution context
    const executionContext: AgentExecutionContext = {
      agentId: ctx.agent.id,
      taskId: event.taskId,
      projectId: ctx.project.id,
      sessionId: session.id,
      cwd: ctx.task?.worktreePath || ctx.project.path,
      allowedTools: event.options?.allowedTools || ctx.project.config.allowedTools,
      maxTurns: event.options?.maxTurns || ctx.project.config.maxTurns,
      env: await loadEnvForWorktree(ctx.task?.worktreePath),
    };

    await publishAgentEvent(ctx.agent.id, {
      type: 'state:update',
      payload: { status: 'starting', sessionId: session.id, taskId: event.taskId },
    });

    return { ok: true, value: executionContext };
  },

  publishEvent: async (ctx: AgentContext, event: AgentEvent) => {
    const agentEvent = mapToAgentEvent(ctx, event);
    await publishAgentEvent(ctx.agent.id, agentEvent);
    return { ok: true, value: null };
  },

  updateStatus: async (ctx: AgentContext, status: Agent['status']) => {
    const result = await AgentService.updateStatus(ctx.agent.id, status);

    if (result.ok) {
      await publishAgentEvent(ctx.agent.id, {
        type: 'state:update',
        payload: { status },
      });
    }

    return result;
  },

  executeToolCall: async (
    ctx: AgentContext,
    toolCall: ToolCall
  ) => {
    // Check if tool is allowed
    if (!guards.isToolAllowed(ctx, toolCall.tool)) {
      return err(AgentErrors.TOOL_NOT_ALLOWED(toolCall.tool, ctx.allowedTools));
    }

    // Publish start event
    await publishAgentEvent(ctx.agent.id, {
      type: 'tool:start',
      tool: toolCall.tool,
      input: toolCall.input,
    });

    const startTime = Date.now();

    // Execute tool via Claude Agent SDK
    const result = await executeToolViaSDK(toolCall, {
      cwd: ctx.task?.worktreePath || ctx.project.path,
    });

    const duration = Date.now() - startTime;

    // Publish result event
    await publishAgentEvent(ctx.agent.id, {
      type: 'tool:result',
      tool: toolCall.tool,
      output: result.ok ? result.value : result.error.message,
      duration,
    });

    return result;
  },

  auditToolCall: async (ctx: AgentContext, toolCall: ToolCall, turn: number) => {
    return AuditService.logToolCall({
      agentId: ctx.agent.id,
      agentRunId: ctx.session?.id,
      taskId: ctx.task?.id,
      projectId: ctx.project.id,
      tool: toolCall.tool,
      input: toolCall.input,
      output: toolCall.output ? { result: toolCall.output } : undefined,
      duration: toolCall.duration,
      turnNumber: turn,
      status: toolCall.status,
    });
  },

  cleanup: async (ctx: AgentContext) => {
    // Update final statistics
    await AgentService.updateStats(ctx.agent.id, {
      totalTasks: ctx.agent.totalTasks + 1,
      completedTasks: ctx.agent.status === 'completed'
        ? ctx.agent.completedTasks + 1
        : ctx.agent.completedTasks,
    });

    // Clear current execution state
    await AgentService.clearExecution(ctx.agent.id);

    await publishAgentEvent(ctx.agent.id, {
      type: 'state:update',
      payload: { status: 'idle', taskId: undefined, sessionId: undefined },
    });

    return { ok: true, value: null };
  },

  incrementTurn: (ctx: AgentContext) => {
    return { ...ctx, currentTurn: ctx.currentTurn + 1 };
  },

  captureError: async (ctx: AgentContext, event: Extract<AgentEvent, { type: 'ERROR' }>) => {
    await AgentService.recordError(ctx.agent.id, {
      error: event.error.message,
      errorType: event.error.code,
      timestamp: new Date(),
    });

    await publishAgentEvent(ctx.agent.id, {
      type: 'state:update',
      payload: {
        status: 'error',
        lastError: event.error.message,
      },
    });

    return { ok: true, value: null };
  },

  streamToken: async (ctx: AgentContext, token: string) => {
    await publishAgentEvent(ctx.agent.id, {
      type: 'stream:token',
      text: token,
    });
    return { ok: true, value: null };
  },
} as const;

export type Action = keyof typeof actions;
```

---

## Transition Table

| # | From State | Event | Guard(s) | Action(s) | To State |
|---|------------|-------|----------|-----------|----------|
| 1 | `idle` | `START` | `hasValidTask` | `initializeExecution`, `updateStatus` | `starting` |
| 2 | `starting` | `STEP` | - | `incrementTurn`, `updateStatus` | `planning` |
| 3 | `starting` | `ERROR` | - | `captureError`, `updateStatus` | `error` |
| 4 | `planning` | `PLAN_READY` | - | `capturePlan`, `publishEvent`, `updateStatus` | `planning` (awaiting approval) |
| 5 | `planning` | `APPROVE_PLAN` | `hasPlan` | `updateStatus`, `publishEvent` | `running` |
| 6 | `planning` | `ERROR` | `isRecoverable` | `captureError`, `updateStatus` | `error` |
| 7 | `planning` | `ERROR` | `!isRecoverable` | `captureError`, `updateStatus`, `cleanup` | `idle` |
| 8 | `planning` | `ABORT` | - | `updateStatus`, `cleanup` | `idle` |
| 9 | `running` | `STEP` | `withinTurnLimit` | `executeToolCall`, `auditToolCall`, `incrementTurn`, `publishEvent` | `running` |
| 10 | `running` | `STEP` | `atTurnLimit` | `publishEvent`, `updateStatus` | `paused` (turn limit) |
| 11 | `running` | `PAUSE` | `canPause` | `updateStatus`, `publishEvent` | `paused` |
| 12 | `running` | `COMPLETE` | - | `updateStatus`, `publishEvent`, `cleanup` | `completed` |
| 13 | `running` | `ERROR` | `isRecoverable` | `captureError`, `updateStatus` | `error` |
| 14 | `running` | `ERROR` | `!isRecoverable` | `captureError`, `updateStatus`, `cleanup` | `idle` |
| 15 | `running` | `ABORT` | - | `updateStatus`, `cleanup` | `idle` |
| 16 | `paused` | `RESUME` | `canResume` | `updateStatus`, `publishEvent` | `running` |
| 17 | `paused` | `ABORT` | - | `updateStatus`, `cleanup` | `idle` |
| 18 | `error` | `RESUME` | `canResume`, `isRecoverable` | `updateStatus` | `running` |
| 19 | `error` | `ABORT` | - | `cleanup`, `updateStatus` | `idle` |
| 20 | `completed` | `START` | `hasValidTask` | `initializeExecution`, `updateStatus` | `starting` |

### Transition Validation Matrix

```
              | START | STEP | PLAN_READY | APPROVE_PLAN | PAUSE | RESUME | ERROR | COMPLETE | ABORT |
--------------+-------+------+------------+--------------+-------+--------+-------+----------+-------|
idle          |   X   |  -   |     -      |      -       |   -   |   -    |   -   |    -     |   -   |
starting      |   -   |  X   |     -      |      -       |   -   |   -    |   X   |    -     |   X   |
planning      |   -   |  -   |     X      |      X       |   -   |   -    |   X   |    -     |   X   |
running       |   -   |  X   |     -      |      -       |   X   |   -    |   X   |    X     |   X   |
paused        |   -   |  -   |     -      |      -       |   -   |   X    |   -   |    -     |   X   |
error         |   -   |  -   |     -      |      -       |   -   |   X    |   -   |    -     |   X   |
completed     |   X   |  -   |     -      |      -       |   -   |   -    |   -   |    -     |   -   |

Legend: X = valid transition, - = invalid/no-op
```

---

## XState Machine Configuration

```typescript
// lib/state-machines/agent-lifecycle/machine.ts
import { createMachine, assign } from 'xstate';
import type { AgentContext } from './guards';
import type { AgentEvent } from './events';
import { guards } from './guards';
import { actions } from './actions';

export const agentLifecycleMachine = createMachine({
  id: 'agentLifecycle',
  initial: 'idle',
  context: {} as AgentContext,

  states: {
    idle: {
      on: {
        START: {
          target: 'starting',
          guard: 'hasValidTask',
          actions: ['initializeExecution', 'updateStatus'],
        },
      },
    },

    starting: {
      on: {
        STEP: {
          target: 'planning',
          actions: ['incrementTurn', 'updateStatus'],
        },
        ERROR: {
          target: 'error',
          actions: ['captureError', 'updateStatus'],
        },
        ABORT: {
          target: 'idle',
          actions: ['cleanup', 'updateStatus'],
        },
      },
    },

    planning: {
      // Agent explores codebase with permissionMode: 'plan'
      // and calls ExitPlanMode tool when plan is ready
      on: {
        PLAN_READY: {
          target: 'planning',
          actions: ['capturePlan', 'publishEvent', 'updateStatus'],
        },
        APPROVE_PLAN: {
          target: 'running',
          guard: 'hasPlan',
          actions: ['updateStatus', 'publishEvent'],
        },
        ERROR: [
          {
            target: 'error',
            guard: 'isRecoverable',
            actions: ['captureError', 'updateStatus'],
          },
          {
            target: 'idle',
            guard: ({ event }) => !event.recoverable,
            actions: ['captureError', 'updateStatus', 'cleanup'],
          },
        ],
        ABORT: {
          target: 'idle',
          actions: ['updateStatus', 'cleanup'],
        },
      },
    },

    running: {
      on: {
        STEP: [
          {
            target: 'running',
            guard: 'withinTurnLimit',
            actions: ['executeToolCalls', 'auditToolCalls', 'incrementTurn', 'publishEvent'],
          },
          {
            target: 'paused',
            guard: 'atTurnLimit',
            actions: ['publishEvent', 'updateStatusTurnLimit'],
          },
        ],
        PAUSE: {
          target: 'paused',
          guard: 'canPause',
          actions: ['updateStatus', 'publishEvent'],
        },
        COMPLETE: {
          target: 'completed',
          actions: ['updateStatus', 'publishEvent', 'cleanup'],
        },
        ERROR: [
          {
            target: 'error',
            guard: 'isRecoverable',
            actions: ['captureError', 'updateStatus'],
          },
          {
            target: 'idle',
            guard: ({ event }) => !event.recoverable,
            actions: ['captureError', 'updateStatus', 'cleanup'],
          },
        ],
        ABORT: {
          target: 'idle',
          actions: ['updateStatus', 'cleanup'],
        },
      },
    },

    paused: {
      on: {
        RESUME: {
          target: 'running',
          guard: 'canResume',
          actions: ['updateStatus', 'publishEvent'],
        },
        ABORT: {
          target: 'idle',
          actions: ['cleanup', 'updateStatus'],
        },
      },
    },

    error: {
      on: {
        RESUME: {
          target: 'running',
          guard: ({ context, event }) =>
            guards.canResume(context) && context.lastError?.recoverable,
          actions: ['updateStatus'],
        },
        ABORT: {
          target: 'idle',
          actions: ['cleanup', 'updateStatus'],
        },
      },
    },

    completed: {
      type: 'final',
      on: {
        // Allow starting a new task from completed state
        START: {
          target: 'starting',
          guard: 'hasValidTask',
          actions: ['initializeExecution', 'updateStatus'],
        },
      },
    },
  },
}, {
  guards: {
    hasValidTask: (ctx, event) => guards.hasValidTask(ctx, event),
    withinTurnLimit: (ctx) => guards.withinTurnLimit(ctx),
    atTurnLimit: (ctx, event) => guards.atTurnLimit(ctx, event),
    canPause: (ctx) => guards.canPause(ctx),
    canResume: (ctx) => guards.canResume(ctx),
    isRecoverable: (ctx, event) => guards.isRecoverable(ctx, event),
  },
  actions: {
    initializeExecution: (ctx, event) => actions.initializeExecution(ctx, event),
    updateStatus: assign((ctx, event, meta) => ({
      ...ctx,
      agent: { ...ctx.agent, status: meta.state.value as Agent['status'] },
    })),
    updateStatusTurnLimit: assign((ctx) => ({
      ...ctx,
      agent: { ...ctx.agent, status: 'paused' as const },
    })),
    incrementTurn: assign((ctx) => ({
      ...ctx,
      currentTurn: ctx.currentTurn + 1,
    })),
    executeToolCalls: (ctx, event) => {
      if (event.type === 'STEP') {
        event.toolCalls.forEach(tc => actions.executeToolCall(ctx, tc));
      }
    },
    auditToolCalls: (ctx, event) => {
      if (event.type === 'STEP') {
        event.toolCalls.forEach(tc => actions.auditToolCall(ctx, tc, event.turn));
      }
    },
    publishEvent: (ctx, event) => actions.publishEvent(ctx, event),
    captureError: (ctx, event) => actions.captureError(ctx, event),
    cleanup: (ctx) => actions.cleanup(ctx),
  },
});

export type AgentLifecycleMachine = typeof agentLifecycleMachine;
```

---

## Error Integration

| Transition | Possible Errors | Error Code | Recovery |
|------------|-----------------|------------|----------|
| `START` | Task not found | `TASK_NOT_FOUND` | Select valid task |
| `START` | Agent already running | `AGENT_ALREADY_RUNNING` | Wait or use different agent |
| `STEP` | Tool not allowed | `AGENT_TOOL_NOT_ALLOWED` | Reconfigure agent permissions |
| `STEP` | Turn limit exceeded | `AGENT_TURN_LIMIT_EXCEEDED` | Increase limit or complete |
| `STEP` | Execution error | `AGENT_EXECUTION_ERROR` | Retry with feedback |
| `RESUME` | Agent not paused | `AGENT_NOT_RUNNING` | Invalid state |
| `COMPLETE` | No task assigned | `AGENT_NO_AVAILABLE_TASK` | Task may have been cancelled |

### Error Handling Flow

```typescript
// lib/state-machines/agent-lifecycle/executor.ts
import { AgentErrors } from '@/lib/errors';
import type { Result } from '@/lib/utils/result';

export async function handleAgentStep(
  ctx: AgentContext,
  event: Extract<AgentEvent, { type: 'STEP' }>
): Promise<Result<AgentContext, AppError>> {
  // Check turn limit
  if (!guards.withinTurnLimit(ctx)) {
    await actions.publishEvent(ctx, {
      type: 'PAUSE',
      reason: 'turn_limit',
      context: { turn: ctx.currentTurn, maxTurns: ctx.maxTurns },
    });

    return err(AgentErrors.TURN_LIMIT_EXCEEDED(ctx.currentTurn, ctx.maxTurns));
  }

  // Execute each tool call
  for (const toolCall of event.toolCalls) {
    // Validate tool access
    if (!guards.isToolAllowed(ctx, toolCall.tool)) {
      return err(AgentErrors.TOOL_NOT_ALLOWED(toolCall.tool, ctx.allowedTools));
    }

    // Execute and audit
    const result = await actions.executeToolCall(ctx, toolCall);
    if (!result.ok) {
      // Emit error event but continue if recoverable
      await actions.captureError(ctx, {
        type: 'ERROR',
        error: result.error,
        recoverable: true,
      });
    }

    await actions.auditToolCall(ctx, { ...toolCall, status: result.ok ? 'complete' : 'error' }, event.turn);
  }

  return ok(actions.incrementTurn(ctx));
}
```

---

## Agent Events (Durable Streams)

Events published during agent execution for real-time sync:

```typescript
// lib/events/agent.ts
type AgentEvent =
  // State updates
  | { type: 'state:update'; payload: Partial<AgentState> }
  // Execution events
  | { type: 'agent:step'; payload: { turn: number; progress?: number } }
  | { type: 'agent:starting'; payload: { taskId: string; sessionId: string } }
  | { type: 'agent:paused'; payload: { reason: string; turn: number } }
  | { type: 'agent:error'; payload: { error: string; code: string; recoverable: boolean } }
  | { type: 'agent:completed'; payload: { turnCount: number; result: string } }
  // Tool events
  | { type: 'tool:start'; tool: string; input: unknown }
  | { type: 'tool:result'; tool: string; output: string; duration?: number }
  // Token streaming
  | { type: 'stream:token'; text: string };

interface AgentState {
  status: 'idle' | 'starting' | 'planning' | 'running' | 'paused' | 'error' | 'completed';
  sessionId?: string;
  taskId?: string;
  turn?: number;
  progress?: number;
  currentTool?: string;
  diff?: string;
  feedback?: string;
  plan?: string;
  planOptions?: PlanOptions;
}
```

---

## Wireframe References

| State | Wireframe | Component |
|-------|-----------|-----------|
| `running` | [kanban-board-full.html](../wireframes/kanban-board-full.html) | Card with "Agent running..." badge |
| `paused` (approval) | [approval-dialog.html](../wireframes/approval-dialog.html) | Diff review modal |
| `idle` (queued) | [queue-waiting-state.html](../wireframes/queue-waiting-state.html) | Tasks awaiting agent |
| `error` | [error-state-expanded.html](../wireframes/error-state-expanded.html) | Error details and retry options |

---

## Turn Limit Handling

### Configuration

```typescript
// Default turn limits by agent type
const defaultTurnLimits = {
  task: 50,           // Single-task execution
  conversational: 100, // Interactive chat
  background: 200,     // Long-running process
};

// Project-level override
interface ProjectConfig {
  maxTurns: number;  // Default: 50
}

// Per-execution override
interface AgentOptions {
  maxTurns?: number;  // Override for this run
}
```

### Turn Limit Reached Behavior

When turn limit is reached:

1. Agent transitions to `paused` state
2. `AGENT_TURN_LIMIT_EXCEEDED` status returned (HTTP 200, not error)
3. User presented with options:
   - **Continue**: Increase limit and resume
   - **Complete**: Force completion with current state
   - **Abort**: Cancel task

```typescript
// Handling turn limit in task workflow
if (event.type === 'STEP' && event.turn >= ctx.maxTurns) {
  // Pause agent, await user decision
  await actions.updateStatus(ctx, 'paused');

  await publishWorkflowEvent({
    type: 'approval:requested',
    taskId: ctx.task.id,
    reason: 'turn_limit_reached',
    currentTurn: event.turn,
    maxTurns: ctx.maxTurns,
  });
}
```

---

## Testing

### Unit Tests

```typescript
// tests/state-machines/agent-lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import { agentLifecycleMachine } from '@/lib/state-machines/agent-lifecycle';

describe('Agent Lifecycle State Machine', () => {
  it('transitions from idle to starting on START', () => {
    const state = agentLifecycleMachine.transition('idle', {
      type: 'START',
      taskId: 'task-1',
      prompt: 'Build feature X',
    });
    expect(state.value).toBe('starting');
  });

  it('transitions from running to paused on PAUSE', () => {
    const state = agentLifecycleMachine.transition('running', {
      type: 'PAUSE',
      reason: 'user_input',
    });
    expect(state.value).toBe('paused');
  });

  it('transitions from paused to running on RESUME', () => {
    const state = agentLifecycleMachine.transition('paused', {
      type: 'RESUME',
      feedback: 'Continue with revised approach',
    });
    expect(state.value).toBe('running');
  });

  it('transitions to error on unrecoverable ERROR', () => {
    const ctx = { ...defaultContext, lastError: { recoverable: false } };
    const state = agentLifecycleMachine.withContext(ctx).transition('running', {
      type: 'ERROR',
      error: { code: 'FATAL', message: 'Critical failure', status: 500 },
      recoverable: false,
    });
    expect(state.value).toBe('idle'); // Cleans up and returns to idle
  });

  it('stays in running on STEP within turn limit', () => {
    const ctx = { ...defaultContext, currentTurn: 10, maxTurns: 50 };
    const state = agentLifecycleMachine.withContext(ctx).transition('running', {
      type: 'STEP',
      turn: 11,
      toolCalls: [],
    });
    expect(state.value).toBe('running');
  });
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Task Workflow](./task-workflow.md) | Triggers agent START, receives COMPLETE |
| [Database Schema](../database/schema.md) | Agent and AgentRun table definitions |
| [Error Catalog](../errors/error-catalog.md) | Agent error codes |
| [API Endpoints](../api/endpoints.md) | REST endpoints for agent control |
| [User Stories](../user-stories.md) | Agent execution requirements |
| [Durable Sessions](../integrations/durable-sessions.md) | Event publishing format |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | Tool execution interface |
