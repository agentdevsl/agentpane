# Task Workflow State Machine Specification

## Overview

Formal state machine definition for task lifecycle in the AgentPane Kanban workflow. This machine governs transitions between the 5-column Kanban board and orchestrates agent assignment, queuing, work execution, approval flow, and git operations.

---

## State Diagram

```
                                         CANCEL
        +----------------------------------------------------------------------+
        |                                                                      |
        v                                                                      |
+-------------+      QUEUE       +--------+     ASSIGN     +---------------+   |
|   backlog   |----------------->| queued |--------------->|  in_progress  |-->|
+-------------+                  +--------+                +---------------+   |
      ^                               |                         |   ^          |
      |                               |                         |   |          |
      |   REJECT (with feedback)      | CANCEL                  |   | REJECT   |
      |   +---------------------------)-------------------------+   | (retry)  |
      |   |                           |                             |          |
      |   v                           v                             |          |
      |  +-------------------+   +---------+                        |          |
      +--|  waiting_approval |<--|         |<-----------------------+          |
         +-------------------+   +---------+           COMPLETE                |
                |                                                              |
                | APPROVE                                                      |
                v                                                              |
         +-------------+                                                       |
         |  verified   |-------------------------------------------------------+
         +-------------+


ASCII State Diagram (Simplified Flow):

    +-----------+        +--------+        +--------------+        +------------------+        +----------+
    |  BACKLOG  |------->| QUEUED |------->| IN_PROGRESS  |------->| WAITING_APPROVAL |------->| VERIFIED |
    +-----------+        +--------+        +--------------+        +------------------+        +----------+
         |                   |                   ^   |                    |     |
         |                   |                   |   |                    |     |
         |                   |                   +---+--------------------+     |
         |                   |                       REJECT                     |
         |                   |                                                  |
         +<------------------+<-------------------------------------------------+
                           CANCEL (from any non-verified state)
```

---

## States

| State | Description | UI Column | Agent Status | Worktree |
|-------|-------------|-----------|--------------|----------|
| `backlog` | Task awaiting assignment | Backlog | None | None |
| `queued` | Task waiting for an available agent | Queued | None (all agents busy) | None |
| `in_progress` | Agent actively working | In Progress | `planning` or `running` | Active |
| `waiting_approval` | Work complete, pending review | Waiting Approval | `paused` | Active (read-only) |
| `verified` | Approved and merged | Verified | `completed` | Removed |

### State Properties

```typescript
// db/schema/shared/enums.ts
export const TASK_COLUMNS = [
  'backlog',
  'queued',
  'in_progress',
  'waiting_approval',
  'verified',
] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

// State metadata
interface TaskStateMetadata {
  backlog: {
    allowsManualMove: true;
    requiresAgent: false;
    hasWorktree: false;
  };
  queued: {
    allowsManualMove: false;  // Automatically dequeued when agent available
    requiresAgent: false;     // Waiting for agent to become idle
    hasWorktree: false;
  };
  in_progress: {
    allowsManualMove: false;  // Only via COMPLETE event
    requiresAgent: true;
    hasWorktree: true;
  };
  waiting_approval: {
    allowsManualMove: false;  // Only via APPROVE/REJECT
    requiresAgent: true;      // Agent paused
    hasWorktree: true;
  };
  verified: {
    allowsManualMove: true;   // Can archive
    requiresAgent: false;
    hasWorktree: false;       // Cleaned up
  };
}
```

---

## Events

| Event | Description | Payload | Source |
|-------|-------------|---------|--------|
| `QUEUE` | Queue task for agent assignment | `{ priority? }` | User drag / Auto-scheduler |
| `ASSIGN` | Assign task to agent (dequeue) | `{ agentId, priority? }` | Auto-scheduler (agent becomes idle) |
| `COMPLETE` | Agent finished work | `{ diff, filesChanged, turnCount }` | Agent SDK |
| `APPROVE` | User approves changes | `{ approver, feedback? }` | Approval Dialog |
| `REJECT` | User rejects with feedback | `{ reason, feedback }` | Approval Dialog |
| `CANCEL` | Cancel task execution | `{ reason? }` | User action |

### Event Type Definitions

```typescript
// lib/state-machines/task-workflow/events.ts
import type { z } from 'zod';

export type TaskEvent =
  | { type: 'ASSIGN'; agentId: string; priority?: 'high' | 'medium' | 'low' }
  | { type: 'COMPLETE'; diff: string; filesChanged: number; linesAdded: number; linesRemoved: number; turnCount: number }
  | { type: 'APPROVE'; approver: string; feedback?: string }
  | { type: 'REJECT'; reason: string; feedback?: string }
  | { type: 'CANCEL'; reason?: string };

// Zod schemas for validation
export const assignEventSchema = z.object({
  type: z.literal('ASSIGN'),
  agentId: z.string().cuid2(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

export const completeEventSchema = z.object({
  type: z.literal('COMPLETE'),
  diff: z.string(),
  filesChanged: z.number().min(0),
  linesAdded: z.number().min(0),
  linesRemoved: z.number().min(0),
  turnCount: z.number().min(1),
});

export const approveEventSchema = z.object({
  type: z.literal('APPROVE'),
  approver: z.string().optional(),
  feedback: z.string().max(1000).optional(),
});

export const rejectEventSchema = z.object({
  type: z.literal('REJECT'),
  reason: z.string().min(1).max(1000),
  feedback: z.string().max(5000).optional(),
});

export const cancelEventSchema = z.object({
  type: z.literal('CANCEL'),
  reason: z.string().max(500).optional(),
});
```

---

## Guards

Guards are boolean functions that determine if a transition is allowed.

| Guard | Description | Checks |
|-------|-------------|--------|
| `canAssign` | Task can be assigned to agent | Task in backlog, no current agent |
| `hasAvailableAgent` | Agent is idle and available | Agent status is `idle`, within concurrency limit |
| `hasDiff` | Changes exist to review | `diffSummary` is non-empty |
| `isValidApprover` | User has approval permission | User in project members |
| `withinConcurrencyLimit` | Project hasn't exceeded max agents | `runningAgents < maxConcurrentAgents` |
| `hasValidWorktree` | Worktree exists and is active | Worktree status is `active` |
| `canCancel` | Task can be cancelled | Task not in `verified` state |

### Guard Implementations

```typescript
// lib/state-machines/task-workflow/guards.ts
import type { Task, Agent, Project, Worktree } from '@/db/schema';
import type { TaskEvent } from './events';

export interface TaskContext {
  task: Task;
  agent?: Agent;
  project: Project;
  worktree?: Worktree;
  runningAgentCount: number;
}

export const guards = {
  canQueue: (ctx: TaskContext) => {
    return ctx.task.column === 'backlog' && ctx.task.agentId === null;
  },

  canAssign: (ctx: TaskContext, event: Extract<TaskEvent, { type: 'ASSIGN' }>) => {
    return (
      (ctx.task.column === 'backlog' || ctx.task.column === 'queued') &&
      ctx.task.agentId === null &&
      ctx.runningAgentCount < ctx.project.maxConcurrentAgents
    );
  },

  hasAvailableAgent: (ctx: TaskContext, event: Extract<TaskEvent, { type: 'ASSIGN' }>) => {
    return ctx.agent?.status === 'idle';
  },

  hasDiff: (ctx: TaskContext) => {
    return Boolean(ctx.task.diffSummary && ctx.task.diffSummary.trim().length > 0);
  },

  isValidApprover: (ctx: TaskContext, event: Extract<TaskEvent, { type: 'APPROVE' }>) => {
    // In single-user mode, always valid
    // In team mode, check membership
    return true;
  },

  withinConcurrencyLimit: (ctx: TaskContext) => {
    return ctx.runningAgentCount < ctx.project.maxConcurrentAgents;
  },

  hasValidWorktree: (ctx: TaskContext) => {
    return ctx.worktree?.status === 'active';
  },

  canCancel: (ctx: TaskContext) => {
    return ctx.task.column !== 'verified';
  },

  canReject: (ctx: TaskContext) => {
    return ctx.task.column === 'waiting_approval' && ctx.hasDiff(ctx);
  },
} as const;

export type Guard = keyof typeof guards;
```

---

## Actions

Actions are side effects executed during transitions.

| Action | Description | Async | Publishes Event |
|--------|-------------|-------|-----------------|
| `createWorktree` | Create git worktree for task | Yes | `worktree:created` |
| `assignAgent` | Link agent to task, start execution | Yes | `agent:assigned` |
| `generateDiff` | Generate git diff summary | Yes | `approval:requested` |
| `pauseAgent` | Pause agent execution | Yes | `agent:paused` |
| `mergeBranch` | Merge feature branch to main | Yes | `worktree:merged` |
| `cleanupWorktree` | Remove worktree and prune | Yes | `worktree:removed` |
| `resumeAgent` | Resume agent with feedback | Yes | `agent:resumed` |
| `updateTaskColumn` | Update task column in DB | Yes | None |
| `incrementRejectionCount` | Track rejection attempts | No | None |
| `publishWorkflowEvent` | Emit event to durable stream | Yes | (varies) |

### Action Implementations

```typescript
// lib/state-machines/task-workflow/actions.ts
import type { TaskContext } from './guards';
import type { TaskEvent } from './events';
import { WorktreeService } from '@/lib/services/worktree';
import { AgentService } from '@/lib/services/agent';
import { publishWorkflowEvent } from '@/lib/events/workflow';

export const actions = {
  createWorktree: async (ctx: TaskContext, event: Extract<TaskEvent, { type: 'ASSIGN' }>) => {
    const branchName = `task/${ctx.task.id}`;
    const worktreePath = `${ctx.project.config.worktreeRoot}/${branchName}`;

    const result = await WorktreeService.create({
      projectId: ctx.project.id,
      taskId: ctx.task.id,
      branch: branchName,
      baseBranch: ctx.project.config.defaultBranch,
      path: worktreePath,
    });

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'worktree:created',
        branch: branchName,
        path: worktreePath,
        taskId: ctx.task.id,
      });
    }

    return result;
  },

  assignAgent: async (ctx: TaskContext, event: Extract<TaskEvent, { type: 'ASSIGN' }>) => {
    const result = await AgentService.assignToTask({
      agentId: event.agentId,
      taskId: ctx.task.id,
      prompt: ctx.task.description || ctx.task.title,
    });

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'agent:assigned',
        agentId: event.agentId,
        taskId: ctx.task.id,
      });
    }

    return result;
  },

  generateDiff: async (ctx: TaskContext, event: Extract<TaskEvent, { type: 'COMPLETE' }>) => {
    // Diff is provided by the COMPLETE event from agent
    const result = await TaskService.updateDiff(ctx.task.id, {
      diffSummary: event.diff,
      filesChanged: event.filesChanged,
      linesAdded: event.linesAdded,
      linesRemoved: event.linesRemoved,
      turnCount: event.turnCount,
    });

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'approval:requested',
        taskId: ctx.task.id,
        diff: event.diff,
      });
    }

    return result;
  },

  pauseAgent: async (ctx: TaskContext) => {
    if (!ctx.agent) return { ok: false, error: AgentErrors.NOT_FOUND };

    const result = await AgentService.pause(ctx.agent.id);

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'agent:paused',
        agentId: ctx.agent.id,
        taskId: ctx.task.id,
        reason: 'awaiting_approval',
      });
    }

    return result;
  },

  mergeBranch: async (ctx: TaskContext, event: Extract<TaskEvent, { type: 'APPROVE' }>) => {
    if (!ctx.worktree) return { ok: false, error: WorktreeErrors.NOT_FOUND };

    const result = await WorktreeService.merge({
      worktreeId: ctx.worktree.id,
      message: `Merge task #${ctx.task.id}: ${ctx.task.title}`,
    });

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'worktree:merged',
        branch: ctx.worktree.branch,
        taskId: ctx.task.id,
        approver: event.approver,
      });
    }

    return result;
  },

  cleanupWorktree: async (ctx: TaskContext) => {
    if (!ctx.worktree) return { ok: true, value: null };

    const result = await WorktreeService.remove(ctx.worktree.id);

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'worktree:removed',
        branch: ctx.worktree.branch,
        taskId: ctx.task.id,
      });
    }

    return result;
  },

  resumeAgent: async (ctx: TaskContext, event: Extract<TaskEvent, { type: 'REJECT' }>) => {
    if (!ctx.agent) return { ok: false, error: AgentErrors.NOT_FOUND };

    const result = await AgentService.resume(ctx.agent.id, {
      feedback: event.feedback || event.reason,
    });

    if (result.ok) {
      await publishWorkflowEvent({
        type: 'agent:resumed',
        agentId: ctx.agent.id,
        taskId: ctx.task.id,
        feedback: event.reason,
      });
    }

    return result;
  },

  updateTaskColumn: async (ctx: TaskContext, column: Task['column']) => {
    return TaskService.updateColumn(ctx.task.id, column);
  },

  incrementRejectionCount: async (ctx: TaskContext) => {
    return TaskService.incrementRejection(ctx.task.id);
  },
} as const;

export type Action = keyof typeof actions;
```

---

## Transition Table

| # | From State | Event | Guard(s) | Action(s) | To State |
|---|------------|-------|----------|-----------|----------|
| 1 | `backlog` | `QUEUE` | `canQueue` | `updateTaskColumn` | `queued` |
| 2 | `backlog` | `ASSIGN` | `canAssign`, `hasAvailableAgent`, `withinConcurrencyLimit` | `createWorktree`, `assignAgent`, `updateTaskColumn` | `in_progress` |
| 3 | `queued` | `ASSIGN` | `canAssign`, `hasAvailableAgent`, `withinConcurrencyLimit` | `createWorktree`, `assignAgent`, `updateTaskColumn` | `in_progress` |
| 4 | `queued` | `CANCEL` | `canCancel` | `updateTaskColumn` | `backlog` |
| 5 | `in_progress` | `COMPLETE` | - | `generateDiff`, `pauseAgent`, `updateTaskColumn` | `waiting_approval` |
| 6 | `in_progress` | `CANCEL` | `canCancel` | `cleanupWorktree`, `updateTaskColumn` | `backlog` |
| 7 | `waiting_approval` | `APPROVE` | `hasDiff`, `isValidApprover` | `mergeBranch`, `cleanupWorktree`, `updateTaskColumn` | `verified` |
| 8 | `waiting_approval` | `REJECT` | `canReject` | `incrementRejectionCount`, `resumeAgent`, `updateTaskColumn` | `in_progress` |
| 9 | `waiting_approval` | `CANCEL` | `canCancel` | `cleanupWorktree`, `updateTaskColumn` | `backlog` |
| 10 | `verified` | - | - | - | (terminal) |

### Transition Validation Matrix

```
              | QUEUE | ASSIGN | COMPLETE | APPROVE | REJECT | CANCEL |
--------------+-------+--------+----------+---------+--------+--------|
backlog       |   X   |   X    |    -     |    -    |   -    |   -    |
queued        |   -   |   X    |    -     |    -    |   -    |   X    |
in_progress   |   -   |   -    |    X     |    -    |   -    |   X    |
waiting_appr. |   -   |   -    |    -     |    X    |   X    |   X    |
verified      |   -   |   -    |    -     |    -    |   -    |   -    |

Legend: X = valid transition, - = invalid/no-op
```

---

## XState Machine Configuration

```typescript
// lib/state-machines/task-workflow/machine.ts
import { createMachine, assign } from 'xstate';
import type { TaskContext } from './guards';
import type { TaskEvent } from './events';
import { guards } from './guards';
import { actions } from './actions';

export const taskWorkflowMachine = createMachine({
  id: 'taskWorkflow',
  initial: 'backlog',
  context: {} as TaskContext,

  states: {
    backlog: {
      on: {
        QUEUE: {
          target: 'queued',
          guard: 'canQueue',
          actions: ['updateTaskColumn'],
        },
        ASSIGN: {
          target: 'in_progress',
          guard: 'canAssignAndHasCapacity',
          actions: ['createWorktree', 'assignAgent', 'updateTaskColumn'],
        },
      },
    },

    queued: {
      on: {
        ASSIGN: {
          target: 'in_progress',
          guard: 'canAssignAndHasCapacity',
          actions: ['createWorktree', 'assignAgent', 'updateTaskColumn'],
        },
        CANCEL: {
          target: 'backlog',
          guard: 'canCancel',
          actions: ['updateTaskColumn'],
        },
      },
    },

    in_progress: {
      on: {
        COMPLETE: {
          target: 'waiting_approval',
          actions: ['generateDiff', 'pauseAgent', 'updateTaskColumn'],
        },
        CANCEL: {
          target: 'backlog',
          guard: 'canCancel',
          actions: ['cleanupWorktree', 'updateTaskColumn'],
        },
      },
    },

    waiting_approval: {
      on: {
        APPROVE: {
          target: 'verified',
          guard: 'hasDiffAndValidApprover',
          actions: ['mergeBranch', 'cleanupWorktree', 'updateTaskColumn'],
        },
        REJECT: {
          target: 'in_progress',
          guard: 'canReject',
          actions: ['incrementRejectionCount', 'resumeAgent', 'updateTaskColumn'],
        },
        CANCEL: {
          target: 'backlog',
          guard: 'canCancel',
          actions: ['cleanupWorktree', 'updateTaskColumn'],
        },
      },
    },

    verified: {
      type: 'final',
    },
  },
}, {
  guards: {
    canQueue: (ctx) => guards.canQueue(ctx),
    canAssignAndHasCapacity: (ctx, event) =>
      guards.canAssign(ctx, event) &&
      guards.hasAvailableAgent(ctx, event) &&
      guards.withinConcurrencyLimit(ctx),
    hasDiffAndValidApprover: (ctx, event) =>
      guards.hasDiff(ctx) && guards.isValidApprover(ctx, event),
    canCancel: (ctx) => guards.canCancel(ctx),
    canReject: (ctx) => guards.canReject(ctx),
  },
  actions: {
    createWorktree: (ctx, event) => actions.createWorktree(ctx, event),
    assignAgent: (ctx, event) => actions.assignAgent(ctx, event),
    generateDiff: (ctx, event) => actions.generateDiff(ctx, event),
    pauseAgent: (ctx) => actions.pauseAgent(ctx),
    mergeBranch: (ctx, event) => actions.mergeBranch(ctx, event),
    cleanupWorktree: (ctx) => actions.cleanupWorktree(ctx),
    incrementRejectionCount: (ctx) => actions.incrementRejectionCount(ctx),
    resumeAgent: (ctx, event) => actions.resumeAgent(ctx, event),
    updateTaskColumn: assign((ctx, event, meta) => ({
      ...ctx,
      task: { ...ctx.task, column: meta.state.value as Task['column'] },
    })),
  },
});

export type TaskWorkflowMachine = typeof taskWorkflowMachine;
```

---

## Error Integration

| Transition | Possible Errors | Error Code | Recovery |
|------------|-----------------|------------|----------|
| `ASSIGN` | Agent not found | `AGENT_NOT_FOUND` | Select different agent |
| `ASSIGN` | Agent busy | `AGENT_ALREADY_RUNNING` | Wait or use different agent |
| `ASSIGN` | Concurrency limit | `CONCURRENCY_LIMIT_EXCEEDED` | Task remains in `queued` |
| `ASSIGN` | Worktree creation failed | `WORKTREE_CREATION_FAILED` | Retry or manual cleanup |
| `COMPLETE` | No diff generated | `TASK_NO_DIFF` | Task returns to in_progress |
| `APPROVE` | Merge conflict | `WORKTREE_MERGE_CONFLICT` | Manual resolution required |
| `APPROVE` | Dirty worktree | `WORKTREE_DIRTY` | Commit pending changes |
| `REJECT` | Agent not found | `AGENT_NOT_FOUND` | Re-assign new agent |

### Error Handling Example

```typescript
// lib/state-machines/task-workflow/executor.ts
import { TaskErrors, WorktreeErrors, ConcurrencyErrors } from '@/lib/errors';
import type { Result } from '@/lib/utils/result';

export async function executeTransition(
  ctx: TaskContext,
  event: TaskEvent
): Promise<Result<TaskContext, AppError>> {
  const machine = taskWorkflowMachine.withContext(ctx);
  const nextState = machine.transition(machine.initialState, event);

  if (!nextState.changed) {
    return err(TaskErrors.INVALID_TRANSITION(ctx.task.column, event.type));
  }

  // Execute actions in sequence
  for (const action of nextState.actions) {
    const result = await executeAction(ctx, event, action);
    if (!result.ok) {
      // Rollback logic here
      return result;
    }
  }

  return ok({ ...ctx, task: { ...ctx.task, column: nextState.value } });
}
```

---

## Workflow Events (Durable Streams)

Events published during transitions for real-time sync:

```typescript
// lib/events/workflow.ts
type WorkflowEvent =
  // Task lifecycle
  | { type: 'task:assigned'; taskId: string; agentId: string }
  | { type: 'task:completed'; taskId: string; diff: string }
  | { type: 'task:approved'; taskId: string; approver: string }
  | { type: 'task:rejected'; taskId: string; reason: string }
  | { type: 'task:cancelled'; taskId: string; reason?: string }
  // Worktree lifecycle
  | { type: 'worktree:created'; branch: string; path: string; taskId: string }
  | { type: 'worktree:merged'; branch: string; taskId: string }
  | { type: 'worktree:removed'; branch: string; taskId: string }
  // Approval workflow
  | { type: 'approval:requested'; taskId: string; diff: string }
  | { type: 'approval:approved'; taskId: string; approver: string }
  | { type: 'approval:rejected'; taskId: string; reason: string };
```

---

## Wireframe References

| State | Wireframe | Component |
|-------|-----------|-----------|
| All states | [kanban-board-full.html](../wireframes/kanban-board-full.html) | Task cards in 5 columns |
| `queued` | [queue-waiting-state.html](../wireframes/queue-waiting-state.html) | Tasks waiting for available agent |
| `waiting_approval` | [approval-dialog.html](../wireframes/approval-dialog.html) | Diff review modal |
| Error during transition | [error-state-expanded.html](../wireframes/error-state-expanded.html) | Error recovery UI |

---

## Testing

### Unit Tests

```typescript
// tests/state-machines/task-workflow.test.ts
import { describe, it, expect } from 'vitest';
import { taskWorkflowMachine } from '@/lib/state-machines/task-workflow';

describe('Task Workflow State Machine', () => {
  it('transitions from backlog to in_progress on ASSIGN', () => {
    const state = taskWorkflowMachine.transition('backlog', { type: 'ASSIGN', agentId: 'agent-1' });
    expect(state.value).toBe('in_progress');
  });

  it('transitions from in_progress to waiting_approval on COMPLETE', () => {
    const state = taskWorkflowMachine.transition('in_progress', {
      type: 'COMPLETE',
      diff: '+ new code',
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 0,
      turnCount: 5,
    });
    expect(state.value).toBe('waiting_approval');
  });

  it('rejects invalid transition from backlog to verified', () => {
    const state = taskWorkflowMachine.transition('backlog', { type: 'APPROVE', approver: 'user' });
    expect(state.changed).toBe(false);
  });
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Agent Lifecycle](./agent-lifecycle.md) | Agent status transitions during task execution |
| [Database Schema](../database/schema.md) | Task and Worktree table definitions |
| [Error Catalog](../errors/error-catalog.md) | Error codes for failed transitions |
| [API Endpoints](../api/endpoints.md) | REST endpoints for task operations |
| [User Stories](../user-stories.md) | Kanban workflow requirements |
| [Git Worktrees](../integrations/git-worktrees.md) | Worktree creation/cleanup details |
