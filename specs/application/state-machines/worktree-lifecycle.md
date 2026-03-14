# Worktree Lifecycle State Machine Specification

## Overview

Formal state machine definition for git worktree lifecycle management in AgentPane. This machine governs the complete lifecycle of isolated agent execution environments, from creation through cleanup, managing git operations and automatic pruning. Uses a simplified 6-state model.

---

## State Diagram

```
                                    ERROR
                              +---------------+
                              |               |
                              v               |
+----------+    CREATE    +----------+    READY    +--------+
|  (none)  |------------->| creating |------------>| active |
+----------+              +----------+             +--------+
                               |                     |   |
                               |                     |   |
                               |  ERROR              |   | MERGE
                               |                     |   |
                               v                     |   v
                         +---------+                 | +---------+
                         |  error  |<----------------+ | merging |
                         +---------+                 | +---------+
                               ^                     |     |
                               |                     |     | COMPLETE
                               |     +---------------+     |
                               |     |                     v
                               |     |  REMOVE        +----------+
                               |     |                | removing |
                               |     |                +----------+
                               |     v                     |
                               +--+----------+             |
                                  | removing |<------------+
                                  +----------+
                                       |
                                       v
                                  +---------+
                                  | removed |
                                  +---------+
                                  (terminal)


ASCII State Diagram (Primary Flow):

    +----------+      +----------+      +--------+      +---------+      +----------+      +---------+
    |  CREATE  |----->| creating |----->| active |----->| merging |----->| removing |----->| removed |
    +----------+      +----------+      +--------+      +---------+      +----------+      +---------+
                           |                |                |                |
                           v                v                v                v
                       +-------+        +-------+       +-------+        +-------+
                       | error |<-------| error |<------| error |<-------| error |
                       +-------+        +-------+       +-------+        +-------+
```

---

## States

| State | Description | Git Ops Allowed | Agent Access | Cleanup Allowed |
|-------|-------------|-----------------|--------------|-----------------|
| `creating` | Worktree being created via git (includes branch creation, env copy, dep install) | None | No | No |
| `active` | Worktree ready for agent use | All local | Yes | Yes |
| `merging` | Merge to base branch in progress | None | No | No |
| `removing` | Cleanup in progress | None | No | No |
| `removed` | Terminal state, worktree deleted | N/A | No | N/A |
| `error` | Error state, requires intervention | None | No | Yes |

### State Properties

```typescript
// db/schema/shared/enums.ts
export const WORKTREE_STATUS = [
  'creating',
  'active',
  'merging',
  'removing',
  'removed',
  'error',
] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUS)[number];

// State metadata
interface WorktreeStateMetadata {
  creating: {
    isTransient: true;
    allowsAgentAccess: false;
    allowsRemoval: false;
    requiresCleanup: false;
  };
  active: {
    isTransient: false;
    allowsAgentAccess: true;
    allowsRemoval: true;
    requiresCleanup: false;
  };
  merging: {
    isTransient: true;
    allowsAgentAccess: false;
    allowsRemoval: false;
    requiresCleanup: false;
  };
  removing: {
    isTransient: true;
    allowsAgentAccess: false;
    allowsRemoval: false;
    requiresCleanup: false;
  };
  removed: {
    isTerminal: true;
    allowsAgentAccess: false;
    allowsRemoval: false;
    requiresCleanup: false;
  };
  error: {
    isTransient: false;
    allowsAgentAccess: false;
    allowsRemoval: true;
    requiresCleanup: true;
    requiresIntervention: true;
  };
}
```

---

## Events

| Event | Description | Payload | Source |
|-------|-------------|---------|--------|
| `CREATE` | Create new worktree | `{ projectId, taskId, branch, baseBranch? }` | Task workflow |
| `READY` | Worktree creation complete, ready for use | `{ path, branch }` | WorktreeService |
| `MERGE` | Merge branch to target | `{ targetBranch?, strategy? }` | Approval workflow |
| `MERGE_COMPLETE` | Merge finished successfully | `{ commitHash }` | Git operation |
| `REMOVE` | Remove worktree | `{ force?: boolean, pruneBranch?: boolean }` | Cleanup / User |
| `REMOVE_COMPLETE` | Removal finished | `{}` | Git operation |
| `ERROR` | Operation failed | `{ error, operation, recoverable }` | Any operation |
| `RETRY` | Retry failed operation | `{ operation }` | User |
| `PRUNE` | Stale worktree cleanup | `{ reason: 'stale' \| 'orphaned' \| 'manual' }` | Scheduler |

### Event Type Definitions

```typescript
// lib/state-machines/worktree-lifecycle/events.ts
import type { z } from 'zod';

export type WorktreeEvent =
  | { type: 'CREATE'; projectId: string; taskId: string; branch: string; baseBranch?: string; options?: WorktreeOptions }
  | { type: 'READY'; path: string; branch: string }
  | { type: 'MERGE'; targetBranch?: string; strategy?: MergeStrategy }
  | { type: 'MERGE_COMPLETE'; commitHash: string }
  | { type: 'REMOVE'; force?: boolean; pruneBranch?: boolean }
  | { type: 'REMOVE_COMPLETE' }
  | { type: 'ERROR'; error: WorktreeError; operation: WorktreeOperation; recoverable: boolean }
  | { type: 'RETRY'; operation: WorktreeOperation }
  | { type: 'PRUNE'; reason: PruneReason };

interface WorktreeOptions {
  copyEnv?: boolean;
  installDeps?: boolean;
  runInitScript?: boolean;
}

type MergeStrategy = 'merge' | 'squash' | 'rebase';
type WorktreeOperation = 'create' | 'merge' | 'remove';
type PruneReason = 'stale' | 'orphaned' | 'branch_deleted' | 'task_completed' | 'manual';

// Zod schemas for validation
export const createEventSchema = z.object({
  type: z.literal('CREATE'),
  projectId: z.string().cuid2(),
  taskId: z.string().cuid2(),
  branch: z.string().min(1).max(100).regex(/^[a-zA-Z0-9\-_\/]+$/),
  baseBranch: z.string().optional(),
  options: z.object({
    copyEnv: z.boolean().optional().default(true),
    installDeps: z.boolean().optional().default(true),
    runInitScript: z.boolean().optional().default(true),
  }).optional(),
});

export const readyEventSchema = z.object({
  type: z.literal('READY'),
  path: z.string(),
  branch: z.string(),
});

export const mergeEventSchema = z.object({
  type: z.literal('MERGE'),
  targetBranch: z.string().optional(),
  strategy: z.enum(['merge', 'squash', 'rebase']).optional().default('merge'),
});

export const mergeCompleteEventSchema = z.object({
  type: z.literal('MERGE_COMPLETE'),
  commitHash: z.string(),
});

export const removeEventSchema = z.object({
  type: z.literal('REMOVE'),
  force: z.boolean().optional().default(false),
  pruneBranch: z.boolean().optional().default(true),
});

export const removeCompleteEventSchema = z.object({
  type: z.literal('REMOVE_COMPLETE'),
});

export const errorEventSchema = z.object({
  type: z.literal('ERROR'),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
  operation: z.enum(['create', 'merge', 'remove']),
  recoverable: z.boolean(),
});
```

---

## Guards

Guards are boolean functions that determine if a transition is allowed.

| Guard | Description | Checks |
|-------|-------------|--------|
| `canCreate` | Can create new worktree | Branch doesn't exist, path available, project exists |
| `canMerge` | Can merge to target branch | Worktree is active, agent not running |
| `canRemove` | Can remove worktree | Not in use by agent, not in transient state |
| `canForceRemove` | Can force remove worktree | Admin permission or cleanup task |
| `isStale` | Worktree is stale | No activity for 7+ days |
| `isOrphaned` | Branch no longer exists | Remote branch deleted |
| `agentNotActive` | No agent using worktree | Task not in in_progress state |

### Guard Implementations

```typescript
// lib/state-machines/worktree-lifecycle/guards.ts
import type { Worktree, Project, Task, Agent } from '@/db/schema';
import type { WorktreeEvent } from './events';
import { $ } from 'bun';

export interface WorktreeContext {
  worktree?: Worktree;
  project: Project;
  task?: Task;
  agent?: Agent;
  lastError?: WorktreeError;
}

export const guards = {
  canCreate: async (ctx: WorktreeContext, event: Extract<WorktreeEvent, { type: 'CREATE' }>) => {
    // Check branch doesn't exist
    const branchExists = await checkBranchExists(ctx.project.path, event.branch);
    if (branchExists) return false;

    // Check worktree path is available
    const worktreePath = buildWorktreePath(ctx.project, event.branch);
    const pathExists = await Bun.file(worktreePath).exists();
    if (pathExists) return false;

    // Check project exists and is configured
    return ctx.project !== undefined && ctx.project.path !== undefined;
  },

  canMerge: (ctx: WorktreeContext) => {
    if (!ctx.worktree) return false;

    // Must be in active state
    return ctx.worktree.status === 'active';
  },

  canRemove: (ctx: WorktreeContext, event: Extract<WorktreeEvent, { type: 'REMOVE' }>) => {
    if (!ctx.worktree) return false;

    // Cannot remove worktrees in transient states (unless force)
    const transientStates = ['creating', 'merging', 'removing'];
    if (transientStates.includes(ctx.worktree.status) && !event.force) {
      return false;
    }

    // Check if agent is actively using it
    if (ctx.task?.column === 'in_progress' && ctx.agent?.status === 'running' && !event.force) {
      return false;
    }

    return true;
  },

  canForceRemove: (ctx: WorktreeContext) => {
    // Can always force remove if not in removing state
    return ctx.worktree?.status !== 'removing';
  },

  isStale: (ctx: WorktreeContext) => {
    if (!ctx.worktree?.updatedAt) return false;

    const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    const lastActivity = new Date(ctx.worktree.updatedAt).getTime();
    const now = Date.now();

    return now - lastActivity > staleThreshold;
  },

  isOrphaned: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.branch || !ctx.project?.path) return false;

    try {
      // Check if branch exists locally
      const localExists = await $`cd ${ctx.project.path} && git show-ref --verify --quiet refs/heads/${ctx.worktree.branch}`.nothrow();
      return localExists.exitCode !== 0;
    } catch {
      return false;
    }
  },

  agentNotActive: (ctx: WorktreeContext) => {
    // No task assigned
    if (!ctx.task) return true;

    // Task not in progress
    if (ctx.task.column !== 'in_progress') return true;

    // No agent assigned
    if (!ctx.agent) return true;

    // Agent not running
    return ctx.agent.status !== 'running';
  },

  canRetry: (ctx: WorktreeContext) => {
    return ctx.worktree?.status === 'error' && ctx.lastError?.recoverable === true;
  },
} as const;

// Helper functions
async function checkBranchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    const result = await $`cd ${projectPath} && git show-ref --verify --quiet refs/heads/${branch}`.nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function buildWorktreePath(project: Project, branch: string): string {
  const worktreeRoot = project.config.worktreeRoot ?? '.worktrees';
  const safeBranch = branch.toLowerCase().replace(/[^a-z0-9\-_\/]/g, '-').replace(/-+/g, '-');
  return `${project.path}/${worktreeRoot}/${safeBranch}`;
}

export type Guard = keyof typeof guards;
```

---

## Actions

Actions are side effects executed during transitions.

| Action | Description | Async | Publishes Event |
|--------|-------------|-------|-----------------|
| `createBranch` | Create git branch from base | Yes | None |
| `createWorktree` | Execute git worktree add, copy env, install deps | Yes | `worktree:creating` |
| `mergeBranch` | Merge branch to target | Yes | `worktree:merging` |
| `removeWorktree` | Execute git worktree remove | Yes | `worktree:removing` |
| `pruneBranch` | Delete branch after removal | Yes | None |
| `cleanupDirectory` | Remove orphaned directory | Yes | None |
| `updateStatus` | Update worktree status in DB | Yes | `state:update` |
| `publishEvent` | Emit event to durable stream | Yes | (varies) |
| `recordError` | Store error details | Yes | `worktree:error` |
| `markStale` | Mark worktree as stale | Yes | `worktree:stale` |

### Action Implementations

```typescript
// lib/state-machines/worktree-lifecycle/actions.ts
import type { WorktreeContext } from './guards';
import type { WorktreeEvent } from './events';
import { $ } from 'bun';
import * as path from 'path';
import { db } from '@/db/client';
import { worktrees } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ok, err } from '@/lib/utils/result';
import { publishWorktreeEvent } from '@/lib/streams/server';

export const actions = {
  createWorktree: async (
    ctx: WorktreeContext,
    event: Extract<WorktreeEvent, { type: 'CREATE' }>
  ) => {
    const baseBranch = event.baseBranch ?? ctx.project.config.defaultBranch ?? 'main';
    const worktreeRoot = ctx.project.config.worktreeRoot ?? '.worktrees';
    const safeBranch = event.branch.toLowerCase().replace(/[^a-z0-9\-_\/]/g, '-').replace(/-+/g, '-');
    const worktreePath = path.join(ctx.project.path, worktreeRoot, safeBranch);

    try {
      // Create worktree record first
      const [worktree] = await db.insert(worktrees).values({
        projectId: event.projectId,
        taskId: event.taskId,
        branch: event.branch,
        baseBranch,
        path: worktreePath,
        status: 'creating',
      }).returning();

      // Publish creating event
      await publishWorktreeEvent(worktree.id, {
        type: 'worktree:creating',
        payload: { worktreeId: worktree.id, branch: event.branch, path: worktreePath },
        timestamp: Date.now(),
      });

      // Check if branch exists
      const branchExists = await $`cd ${ctx.project.path} && git show-ref --verify --quiet refs/heads/${event.branch}`.nothrow();

      if (branchExists.exitCode === 0) {
        await $`cd ${ctx.project.path} && git worktree add ${worktreePath} ${event.branch}`;
      } else {
        await $`cd ${ctx.project.path} && git worktree add ${worktreePath} -b ${event.branch} ${baseBranch}`;
      }

      // Copy env file if configured
      if (event.options?.copyEnv !== false) {
        const envFile = ctx.project.config.envFile ?? '.env';
        const sourcePath = path.join(ctx.project.path, envFile);
        const sourceExists = await Bun.file(sourcePath).exists();
        if (sourceExists) {
          await $`cp ${sourcePath} ${path.join(worktreePath, envFile)}`;
        }
      }

      // Install dependencies if configured
      if (event.options?.installDeps !== false) {
        await $`cd ${worktreePath} && bun install`.timeout(300_000).nothrow();
      }

      return ok(worktree);
    } catch (error) {
      const errorMessage = error.stderr?.toString() ?? String(error);

      if (errorMessage.includes('already checked out')) {
        return err({
          code: 'BRANCH_CHECKED_OUT',
          message: `Branch '${event.branch}' is already checked out in another worktree`,
        });
      }
      if (errorMessage.includes('already exists')) {
        return err({
          code: 'PATH_EXISTS',
          message: `Worktree path already exists: ${worktreePath}`,
        });
      }

      return err({
        code: 'WORKTREE_CREATION_FAILED',
        message: errorMessage,
      });
    }
  },

  mergeBranch: async (
    ctx: WorktreeContext,
    event: Extract<WorktreeEvent, { type: 'MERGE' }>
  ) => {
    if (!ctx.worktree) return err({ code: 'NO_WORKTREE', message: 'Worktree not found' });

    const targetBranch = event.targetBranch ?? ctx.worktree.baseBranch ?? ctx.project.config.defaultBranch ?? 'main';
    const strategy = event.strategy ?? 'merge';

    try {
      // Publish merging event
      await publishWorktreeEvent(ctx.worktree.id, {
        type: 'worktree:merging',
        payload: { worktreeId: ctx.worktree.id, targetBranch, strategy },
        timestamp: Date.now(),
      });

      // Switch to target branch in main worktree
      await $`cd ${ctx.project.path} && git checkout ${targetBranch}`;

      // Pull latest
      await $`cd ${ctx.project.path} && git pull --rebase`.nothrow();

      // Execute merge based on strategy
      let mergeResult;
      switch (strategy) {
        case 'squash':
          mergeResult = await $`cd ${ctx.project.path} && git merge --squash ${ctx.worktree.branch}`.nothrow();
          if (mergeResult.exitCode === 0) {
            await $`cd ${ctx.project.path} && git commit -m "Squash merge branch '${ctx.worktree.branch}'"`;
          }
          break;
        case 'rebase':
          mergeResult = await $`cd ${ctx.project.path} && git rebase ${ctx.worktree.branch}`.nothrow();
          break;
        default:
          mergeResult = await $`cd ${ctx.project.path} && git merge ${ctx.worktree.branch} --no-ff -m "Merge branch '${ctx.worktree.branch}'"`.nothrow();
      }

      if (mergeResult.exitCode !== 0) {
        // Check for merge conflicts
        const conflictFiles = await $`cd ${ctx.project.path} && git diff --name-only --diff-filter=U`.text();

        if (conflictFiles.trim()) {
          // Update context with conflict files
          return err({
            code: 'MERGE_CONFLICT',
            message: 'Merge conflicts detected',
            conflictFiles: conflictFiles.trim().split('\n'),
          });
        }

        return err({
          code: 'MERGE_FAILED',
          message: mergeResult.stderr?.toString() ?? 'Merge failed',
        });
      }

      // Update database
      await db.update(worktrees).set({
        mergedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(worktrees.id, ctx.worktree.id));

      // Publish merged event
      await publishWorktreeEvent(ctx.worktree.id, {
        type: 'worktree:merged',
        payload: { worktreeId: ctx.worktree.id, branch: ctx.worktree.branch, targetBranch },
        timestamp: Date.now(),
      });

      return ok(undefined);
    } catch (error) {
      return err({
        code: 'MERGE_FAILED',
        message: error.stderr?.toString() ?? String(error),
      });
    }
  },

  removeWorktree: async (
    ctx: WorktreeContext,
    event: Extract<WorktreeEvent, { type: 'REMOVE' }>
  ) => {
    if (!ctx.worktree) return err({ code: 'NO_WORKTREE', message: 'Worktree not found' });

    try {
      // Publish removing event
      await publishWorktreeEvent(ctx.worktree.id, {
        type: 'worktree:removing',
        payload: { worktreeId: ctx.worktree.id, branch: ctx.worktree.branch },
        timestamp: Date.now(),
      });

      // Remove git worktree
      const forceFlag = event.force ? '--force' : '';
      await $`cd ${ctx.project.path} && git worktree remove ${ctx.worktree.path} ${forceFlag}`;

      return ok(undefined);
    } catch (error) {
      return err({
        code: 'WORKTREE_REMOVAL_FAILED',
        message: error.stderr?.toString() ?? String(error),
      });
    }
  },

  pruneBranch: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.branch) return ok(undefined);

    try {
      // Try to delete branch (will fail if not fully merged, which is ok)
      await $`cd ${ctx.project.path} && git branch -d ${ctx.worktree.branch}`.nothrow();
      return ok(undefined);
    } catch {
      // Branch might not exist or might be current, ignore
      return ok(undefined);
    }
  },

  cleanupDirectory: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.path) return ok(undefined);

    try {
      // Check if directory still exists
      const exists = await Bun.file(ctx.worktree.path).exists();
      if (exists) {
        await $`rm -rf ${ctx.worktree.path}`.nothrow();
      }
      return ok(undefined);
    } catch {
      return ok(undefined); // Ignore cleanup errors
    }
  },

  updateStatus: async (ctx: WorktreeContext, status: Worktree['status'], error?: string) => {
    if (!ctx.worktree) return err({ code: 'NO_WORKTREE', message: 'Worktree not found' });

    await db.update(worktrees).set({
      status,
      lastError: error ?? null,
      updatedAt: new Date(),
      ...(status === 'removed' ? { removedAt: new Date() } : {}),
    }).where(eq(worktrees.id, ctx.worktree.id));

    // Publish state update
    await publishWorktreeEvent(ctx.worktree.id, {
      type: 'state:update',
      payload: { status, error },
      timestamp: Date.now(),
    });

    return ok(undefined);
  },

  recordError: async (
    ctx: WorktreeContext,
    event: Extract<WorktreeEvent, { type: 'ERROR' }>
  ) => {
    if (!ctx.worktree) return;

    await db.update(worktrees).set({
      status: 'error',
      lastError: event.error.message,
      updatedAt: new Date(),
    }).where(eq(worktrees.id, ctx.worktree.id));

    await publishWorktreeEvent(ctx.worktree.id, {
      type: 'worktree:error',
      payload: {
        worktreeId: ctx.worktree.id,
        error: event.error.code,
        message: event.error.message,
        operation: event.operation,
        recoverable: event.recoverable,
      },
      timestamp: Date.now(),
    });
  },

  markStale: async (ctx: WorktreeContext) => {
    if (!ctx.worktree) return;

    await publishWorktreeEvent(ctx.worktree.id, {
      type: 'worktree:stale',
      payload: {
        worktreeId: ctx.worktree.id,
        lastActivity: ctx.worktree.updatedAt,
      },
      timestamp: Date.now(),
    });
  },

  publishEvent: async (ctx: WorktreeContext, event: WorktreeEvent) => {
    if (!ctx.worktree) return;

    await publishWorktreeEvent(ctx.worktree.id, {
      type: `worktree:${event.type.toLowerCase()}`,
      payload: { worktreeId: ctx.worktree.id, ...event },
      timestamp: Date.now(),
    });
  },
} as const;

export type Action = keyof typeof actions;
```

---

## Transition Table

| # | From State | Event | Guard(s) | Action(s) | To State |
|---|------------|-------|----------|-----------|----------|
| 1 | `(none)` | `CREATE` | `canCreate` | `createWorktree`, `updateStatus` | `creating` |
| 2 | `creating` | `READY` | - | `updateStatus`, `publishEvent` | `active` |
| 3 | `creating` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 4 | `active` | `MERGE` | `canMerge`, `agentNotActive` | `mergeBranch`, `updateStatus` | `merging` |
| 5 | `active` | `REMOVE` | `canRemove`, `agentNotActive` | `removeWorktree`, `pruneBranch`, `updateStatus` | `removing` |
| 6 | `active` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 7 | `active` | `PRUNE` | `isStale` or `isOrphaned` | `markStale`, `removeWorktree`, `updateStatus` | `removing` |
| 8 | `merging` | `MERGE_COMPLETE` | - | `updateStatus`, `publishEvent` | `removing` |
| 9 | `merging` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 10 | `removing` | `REMOVE_COMPLETE` | - | `pruneBranch`, `cleanupDirectory`, `updateStatus` | `removed` |
| 11 | `removing` | `ERROR` | - | `recordError`, `cleanupDirectory`, `updateStatus` | `error` |
| 12 | `error` | `RETRY` | `canRetry` | `updateStatus` | (previous state) |
| 13 | `error` | `REMOVE` | - | `cleanupDirectory`, `updateStatus` | `removed` |
| 14 | `removed` | - | - | - | (terminal) |

### Transition Validation Matrix

```
               | CREATE | READY | MERGE | MERGE_COMPLETE | REMOVE | REMOVE_COMPLETE | ERROR | RETRY | PRUNE |
---------------+--------+-------+-------+----------------+--------+-----------------+-------+-------+-------|
(none)         |   X    |   -   |   -   |       -        |   -    |        -        |   -   |   -   |   -   |
creating       |   -    |   X   |   -   |       -        |   -    |        -        |   X   |   -   |   -   |
active         |   -    |   -   |   X   |       -        |   X    |        -        |   X   |   -   |   X   |
merging        |   -    |   -   |   -   |       X        |   -    |        -        |   X   |   -   |   -   |
removing       |   -    |   -   |   -   |       -        |   -    |        X        |   X   |   -   |   -   |
error          |   -    |   -   |   -   |       -        |   X    |        -        |   -   |   X   |   -   |
removed        |   -    |   -   |   -   |       -        |   -    |        -        |   -   |   -   |   -   |

Legend: X = valid transition, - = invalid/no-op
```

---


## XState Machine Configuration

```typescript
// lib/state-machines/worktree-lifecycle/machine.ts
import { createMachine, assign } from 'xstate';
import type { WorktreeContext } from './guards';
import type { WorktreeEvent } from './events';
import { guards } from './guards';
import { actions } from './actions';

export const worktreeLifecycleMachine = createMachine({
  id: 'worktreeLifecycle',
  initial: 'idle',
  context: {} as WorktreeContext,

  states: {
    idle: {
      on: {
        CREATE: {
          target: 'creating',
          guard: 'canCreate',
          actions: ['createWorktree', 'updateStatus'],
        },
      },
    },

    creating: {
      on: {
        READY: {
          target: 'active',
          actions: ['updateStatus', 'publishEvent'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatus'],
        },
      },
    },

    active: {
      on: {
        MERGE: {
          target: 'merging',
          guard: 'canMergeAndAgentNotActive',
          actions: ['mergeBranch', 'updateStatus'],
        },
        REMOVE: {
          target: 'removing',
          guard: 'canRemoveAndAgentNotActive',
          actions: ['removeWorktree', 'pruneBranch', 'updateStatus'],
        },
        PRUNE: {
          target: 'removing',
          guard: 'isStaleOrOrphaned',
          actions: ['markStale', 'removeWorktree', 'updateStatus'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatus'],
        },
      },
    },

    merging: {
      on: {
        MERGE_COMPLETE: {
          target: 'removing',
          actions: ['updateStatus', 'publishEvent'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatus'],
        },
      },
    },

    removing: {
      on: {
        REMOVE_COMPLETE: {
          target: 'removed',
          actions: ['pruneBranch', 'cleanupDirectory', 'updateStatus'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'cleanupDirectory', 'updateStatus'],
        },
      },
    },

    error: {
      on: {
        RETRY: {
          target: 'active',
          guard: 'canRetry',
          actions: ['clearError', 'updateStatus'],
        },
        REMOVE: {
          target: 'removed',
          actions: ['cleanupDirectory', 'updateStatus'],
        },
      },
    },

    removed: {
      type: 'final',
    },
  },
});

export type WorktreeLifecycleMachine = typeof worktreeLifecycleMachine;
```

---

## Wireframe References

| State | Wireframe | Component |
|-------|-----------|-----------|
| All states | [worktree-management.html](../wireframes/worktree-management.html) | Worktree status list |
| `error` | [error-state-expanded.html](../wireframes/error-state-expanded.html) | Error details and recovery |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [WorktreeService](../services/worktree-service.md) | Service implementation details |
| [Task Workflow](./task-workflow.md) | Triggers worktree creation via ASSIGN |
| [Agent Lifecycle](./agent-lifecycle.md) | Agent executes in worktree context |
| [Database Schema](../database/schema.md) | `worktrees` table definition |
| [Error Catalog](../errors/error-catalog.md) | Worktree error codes |
| [Git Worktrees](../integrations/git-worktrees.md) | Git worktree technical details |
