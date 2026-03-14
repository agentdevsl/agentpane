# Worktree Lifecycle State Machine Specification

## Overview

Formal state machine definition for git worktree lifecycle management in AgentPane. This machine governs the complete lifecycle of isolated agent execution environments, from creation through cleanup. Uses a simplified 6-state model where the `active` state absorbs uncommitted-change tracking and commit operations internally.

---

## State Diagram

```
                                    +----------+
                                    |  (none)  |
                                    +----------+
                                         |
                                         | CREATE
                                         v
                                    +----------+
                               +--->| creating |---+
                               |    +----------+   |
                               |         |         |
                               |  CREATED |         | ERROR
                               |         v         |
                               |    +--------+     |
                               |    | active |<-+  |
                               |    +--------+  |  |
                               |      |    |    |  |
                               |      |    |    |  |
                         RETRY |      |    |    |  |
                               |      |    |  ABORT_MERGE
                               |      |    |    |  |
                               |      |    |    |  |
                               |  REMOVE  MERGE |  |
                               |      |    |    |  |
                               |      |    v    |  |
                               |      | +---------+|
                               |      | | merging ||
                               |      | +---------+|
                               |      |    |    |  |
                               |      |    |    +--+
                               |      |   ERROR    |
                               |      |    |       |
                               |      v    v       v
                               |    +---------+
                               +----| error   |
                                    +---------+
                                      |
                                      | REMOVE
                                      v
                                    +----------+
                               +--->| removing |
                               |    +----------+
                               |         |
                               |         | COMPLETE
                               |         v
                               |    +---------+
                               |    | removed |
                               |    +---------+
                               |    (terminal)
                               |
                    (from active via REMOVE)


ASCII State Diagram (Primary Flow):

    +----------+      +----------+      +--------+      +---------+
    |  CREATE  |----->| creating |----->| active |----->| merging |
    +----------+      +----------+      +--------+      +---------+
                           |                |                |
                           v                |                v
                       +-------+            |           +-------+
                       | error |<-----------+           | error |
                       +-------+            |           +-------+
                           |                v
                           v           +----------+      +---------+
                      +---------+      | removing |----->| removed |
                      | removed |      +----------+      +---------+
                      +---------+
```

---

## States

| State | Description | Git Ops Allowed | Agent Access | Cleanup Allowed |
|-------|-------------|-----------------|--------------|-----------------|
| `creating` | Worktree being created via git | None | No | No |
| `active` | Worktree ready for agent use (includes uncommitted changes and commits) | All local | Yes | Yes |
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
| `CREATED` | Worktree creation completed | `{}` | WorktreeService |
| `MERGE` | Merge branch to target | `{ targetBranch?, strategy? }` | Approval workflow |
| `MERGE_COMPLETE` | Merge completed successfully | `{}` | WorktreeService |
| `ABORT_MERGE` | Abort merge operation | `{ reason? }` | User |
| `REMOVE` | Remove worktree | `{ force?: boolean, pruneBranch?: boolean }` | Cleanup / User |
| `COMPLETE` | Removal completed | `{}` | WorktreeService |
| `ERROR` | Operation failed | `{ error, operation, recoverable }` | Any operation |
| `RETRY` | Retry failed operation | `{ operation }` | User |
| `PRUNE` | Stale worktree cleanup | `{ reason: 'stale' \| 'orphaned' \| 'manual' }` | Scheduler |

### Event Type Definitions

```typescript
// lib/state-machines/worktree-lifecycle/events.ts
import type { z } from 'zod';

export type WorktreeEvent =
  | { type: 'CREATE'; projectId: string; taskId: string; branch: string; baseBranch?: string; options?: WorktreeOptions }
  | { type: 'CREATED' }
  | { type: 'MERGE'; targetBranch?: string; strategy?: MergeStrategy }
  | { type: 'MERGE_COMPLETE' }
  | { type: 'ABORT_MERGE'; reason?: string }
  | { type: 'REMOVE'; force?: boolean; pruneBranch?: boolean }
  | { type: 'COMPLETE' }
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

export const mergeEventSchema = z.object({
  type: z.literal('MERGE'),
  targetBranch: z.string().optional(),
  strategy: z.enum(['merge', 'squash', 'rebase']).optional().default('merge'),
});

export const removeEventSchema = z.object({
  type: z.literal('REMOVE'),
  force: z.boolean().optional().default(false),
  pruneBranch: z.boolean().optional().default(true),
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
| `canMerge` | Can merge to target branch | Worktree is active, no active conflicts |
| `canRemove` | Can remove worktree | Not in use by agent, not in transient state |
| `canForceRemove` | Can force remove worktree | Admin permission or cleanup task |
| `isStale` | Worktree is stale | No activity for 7+ days |
| `isOrphaned` | Branch no longer exists | Remote branch deleted |
| `agentNotActive` | No agent using worktree | Task not in in_progress state |
| `canRetry` | Error is recoverable | Error marked as recoverable |

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

  canMerge: async (ctx: WorktreeContext) => {
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
| `createWorktree` | Execute git worktree add | Yes | `worktree:creating` |
| `copyEnvFile` | Copy .env to worktree | Yes | None |
| `installDependencies` | Run bun install | Yes | None |
| `runInitScript` | Execute project init script | Yes | None |
| `mergeBranch` | Merge branch to target | Yes | `worktree:merging` |
| `abortMerge` | Abort in-progress merge | Yes | `worktree:merge_aborted` |
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
  createBranch: async (
    ctx: WorktreeContext,
    event: Extract<WorktreeEvent, { type: 'CREATE' }>
  ) => {
    const baseBranch = event.baseBranch ?? ctx.project.config.defaultBranch ?? 'main';

    try {
      // Check if branch already exists
      const branchExists = await $`cd ${ctx.project.path} && git show-ref --verify --quiet refs/heads/${event.branch}`.nothrow();

      if (branchExists.exitCode !== 0) {
        // Create new branch from base
        await $`cd ${ctx.project.path} && git branch ${event.branch} ${baseBranch}`;
      }

      return ok(undefined);
    } catch (error) {
      return err({
        code: 'BRANCH_CREATION_FAILED',
        message: `Failed to create branch ${event.branch}: ${error}`,
      });
    }
  },

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
        // Branch exists, create worktree from existing branch
        await $`cd ${ctx.project.path} && git worktree add ${worktreePath} ${event.branch}`;
      } else {
        // Create new branch from base
        await $`cd ${ctx.project.path} && git worktree add ${worktreePath} -b ${event.branch} ${baseBranch}`;
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

  copyEnvFile: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.path) return ok(false);

    const envFile = ctx.project.config.envFile ?? '.env';
    const sourcePath = path.join(ctx.project.path, envFile);
    const destPath = path.join(ctx.worktree.path, envFile);

    try {
      const sourceExists = await Bun.file(sourcePath).exists();
      if (!sourceExists) {
        return ok(false); // No env file to copy, not an error
      }

      await $`cp ${sourcePath} ${destPath}`;

      await db.update(worktrees).set({
        envCopied: true,
        updatedAt: new Date(),
      }).where(eq(worktrees.id, ctx.worktree.id));

      return ok(true);
    } catch (error) {
      return err({
        code: 'ENV_COPY_FAILED',
        message: `Failed to copy env file: ${error}`,
      });
    }
  },

  installDependencies: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.path) return ok(false);

    try {
      await $`cd ${ctx.worktree.path} && bun install`.timeout(300_000); // 5 min timeout

      await db.update(worktrees).set({
        depsInstalled: true,
        updatedAt: new Date(),
      }).where(eq(worktrees.id, ctx.worktree.id));

      return ok(true);
    } catch (error) {
      const errorMessage = error.stderr?.toString() ?? String(error);
      return err({
        code: 'DEPS_INSTALL_FAILED',
        message: `Failed to install dependencies: ${errorMessage}`,
      });
    }
  },

  runInitScript: async (ctx: WorktreeContext) => {
    if (!ctx.worktree?.path) return ok(false);

    const initScript = ctx.project.config.initScript;
    if (!initScript) {
      return ok(false); // No script to run
    }

    try {
      await $`cd ${ctx.worktree.path} && ${initScript}`.timeout(600_000); // 10 min timeout

      await db.update(worktrees).set({
        initScriptRun: true,
        updatedAt: new Date(),
      }).where(eq(worktrees.id, ctx.worktree.id));

      return ok(true);
    } catch (error) {
      const errorMessage = error.stderr?.toString() ?? String(error);
      return err({
        code: 'INIT_SCRIPT_FAILED',
        message: `Init script failed: ${errorMessage}`,
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

  abortMerge: async (ctx: WorktreeContext) => {
    try {
      await $`cd ${ctx.project.path} && git merge --abort`.nothrow();
      await $`cd ${ctx.project.path} && git rebase --abort`.nothrow();

      // Publish event
      if (ctx.worktree) {
        await publishWorktreeEvent(ctx.worktree.id, {
          type: 'worktree:merge_aborted',
          payload: { worktreeId: ctx.worktree.id },
          timestamp: Date.now(),
        });
      }

      return ok(undefined);
    } catch (error) {
      return err({
        code: 'ABORT_FAILED',
        message: String(error),
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
| 2 | `creating` | `CREATED` | - | `copyEnvFile`, `installDependencies`, `runInitScript`, `updateStatus` | `active` |
| 3 | `creating` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 4 | `active` | `MERGE` | `canMerge` | `mergeBranch`, `updateStatus` | `merging` |
| 5 | `active` | `REMOVE` | `canRemove`, `agentNotActive` | `removeWorktree`, `pruneBranch`, `updateStatus` | `removing` |
| 6 | `active` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 7 | `active` | `PRUNE` | `isStale` or `isOrphaned` | `markStale`, `removeWorktree`, `updateStatus` | `removing` |
| 8 | `merging` | `MERGE_COMPLETE` | - | `removeWorktree`, `pruneBranch`, `updateStatus` | `removing` |
| 9 | `merging` | `ERROR` | - | `recordError`, `updateStatus` | `error` |
| 10 | `merging` | `ABORT_MERGE` | - | `abortMerge`, `updateStatus` | `active` |
| 11 | `removing` | `COMPLETE` | - | `pruneBranch`, `cleanupDirectory`, `updateStatus` | `removed` |
| 12 | `removing` | `ERROR` | - | `recordError`, `cleanupDirectory`, `updateStatus` | `error` |
| 13 | `error` | `RETRY` | `canRetry` | `updateStatus` | `active` |
| 14 | `error` | `REMOVE` | - | `cleanupDirectory`, `updateStatus` | `removed` |
| 15 | `removed` | - | - | - | (terminal) |

### Transition Validation Matrix

```
               | CREATE | CREATED | MERGE | MERGE_COMPLETE | ABORT_MERGE | REMOVE | COMPLETE | ERROR | RETRY | PRUNE |
---------------+--------+---------+-------+----------------+-------------+--------+----------+-------+-------+-------|
(none)         |   X    |    -    |   -   |       -        |      -      |   -    |    -     |   -   |   -   |   -   |
creating       |   -    |    X    |   -   |       -        |      -      |   -    |    -     |   X   |   -   |   -   |
active         |   -    |    -    |   X   |       -        |      -      |   X    |    -     |   X   |   -   |   X   |
merging        |   -    |    -    |   -   |       X        |      X      |   -    |    -     |   X   |   -   |   -   |
removing       |   -    |    -    |   -   |       -        |      -      |   -    |    X     |   X   |   -   |   -   |
error          |   -    |    -    |   -   |       -        |      -      |   X    |    -     |   -   |   X   |   -   |
removed        |   -    |    -    |   -   |       -        |      -      |   -    |    -     |   -   |   -   |   -   |

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
          actions: ['createWorktree', 'updateStatusCreating'],
        },
      },
    },

    creating: {
      entry: ['copyEnvFile', 'installDependencies', 'runInitScript'],
      on: {
        CREATED: {
          target: 'active',
          actions: ['updateStatusActive', 'publishCreatedEvent'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatusError'],
        },
      },
    },

    active: {
      on: {
        MERGE: {
          target: 'merging',
          guard: 'canMerge',
          actions: ['mergeBranch', 'updateStatusMerging'],
        },
        REMOVE: {
          target: 'removing',
          guard: { type: 'and', guards: ['canRemove', 'agentNotActive'] },
          actions: ['removeWorktree', 'pruneBranch', 'updateStatusRemoving'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatusError'],
        },
        PRUNE: {
          target: 'removing',
          guard: { type: 'or', guards: ['isStale', 'isOrphaned'] },
          actions: ['markStale', 'removeWorktree', 'updateStatusRemoving'],
        },
      },
    },

    merging: {
      on: {
        MERGE_COMPLETE: {
          target: 'removing',
          actions: ['removeWorktree', 'pruneBranch', 'updateStatusRemoving'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'updateStatusError'],
        },
        ABORT_MERGE: {
          target: 'active',
          actions: ['abortMerge', 'updateStatusActive'],
        },
      },
    },

    removing: {
      on: {
        COMPLETE: {
          target: 'removed',
          actions: ['pruneBranch', 'cleanupDirectory', 'updateStatusRemoved'],
        },
        ERROR: {
          target: 'error',
          actions: ['recordError', 'cleanupDirectory', 'updateStatusError'],
        },
      },
    },

    error: {
      on: {
        RETRY: {
          target: 'active',
          guard: 'canRetry',
          actions: ['clearError', 'updateStatusActive'],
        },
        REMOVE: {
          target: 'removed',
          actions: ['cleanupDirectory', 'updateStatusRemoved'],
        },
      },
    },

    removed: {
      type: 'final',
    },
  },
}, {
  guards: {
    canCreate: (ctx, event) => guards.canCreate(ctx, event),
    canMerge: (ctx) => guards.canMerge(ctx),
    canRemove: (ctx, event) => guards.canRemove(ctx, event),
    canForceRemove: (ctx) => guards.canForceRemove(ctx),
    isStale: (ctx) => guards.isStale(ctx),
    isOrphaned: (ctx) => guards.isOrphaned(ctx),
    agentNotActive: (ctx) => guards.agentNotActive(ctx),
    canRetry: (ctx) => guards.canRetry(ctx),
  },
  actions: {
    createWorktree: (ctx, event) => actions.createWorktree(ctx, event),
    copyEnvFile: (ctx) => actions.copyEnvFile(ctx),
    installDependencies: (ctx) => actions.installDependencies(ctx),
    runInitScript: (ctx) => actions.runInitScript(ctx),
    mergeBranch: (ctx, event) => actions.mergeBranch(ctx, event),
    abortMerge: (ctx) => actions.abortMerge(ctx),
    removeWorktree: (ctx, event) => actions.removeWorktree(ctx, event),
    pruneBranch: (ctx) => actions.pruneBranch(ctx),
    cleanupDirectory: (ctx) => actions.cleanupDirectory(ctx),
    recordError: (ctx, event) => actions.recordError(ctx, event),
    markStale: (ctx) => actions.markStale(ctx),
    publishCreatedEvent: (ctx) => actions.publishEvent(ctx, { type: 'CREATE', ...ctx }),
    updateStatusCreating: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'creating' }) }),
    updateStatusActive: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'active' }) }),
    updateStatusMerging: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'merging' }) }),
    updateStatusRemoving: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'removing' }) }),
    updateStatusRemoved: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'removed' }) }),
    updateStatusError: assign({ worktree: (ctx) => ({ ...ctx.worktree, status: 'error' }) }),
    clearError: assign({ lastError: undefined }),
  },
});

export type WorktreeLifecycleMachine = typeof worktreeLifecycleMachine;
```

---

## Git Operations

### Allowed Operations by State

| State | Read Ops | Write Ops | Branch Ops | Merge Ops |
|-------|----------|-----------|------------|-----------|
| `creating` | - | - | - | - |
| `active` | status, log, diff, show | add, restore, commit, reset | checkout (local) | - |
| `merging` | status, log, diff | - | - | - |
| `removing` | - | - | - | - |
| `error` | status, log | - | - | - |

### Blocked Operations

The following git operations are **blocked** in all worktree states:

| Operation | Reason | Alternative |
|-----------|--------|-------------|
| `git push` | Remote sync managed by merge workflow | Use MERGE event |
| `git pull` | Conflicts with worktree isolation | Create new worktree |
| `git fetch` | Managed at project level | Use project git operations |
| `git rebase -i` | Interactive operations not supported | Use merge strategy |
| `git reset --hard` | Destructive, may lose agent work | Use REMOVE with force |
| `git stash` | Worktrees should not use stash | Commit or discard |
| `git checkout <remote>` | May break worktree | Create new worktree |

### Command Validation

```typescript
// lib/state-machines/worktree-lifecycle/git-validator.ts
import type { WorktreeContext } from './guards';

export const BLOCKED_COMMANDS = [
  'push',
  'pull',
  'fetch',
  'rebase -i',
  'reset --hard',
  'stash',
] as const;

export const STATE_ALLOWED_COMMANDS: Record<WorktreeStatus, string[]> = {
  creating: [],
  active: ['status', 'log', 'diff', 'show', 'add', 'restore', 'commit', 'reset', 'checkout'],
  merging: ['status', 'log', 'diff'],
  removing: [],
  removed: [],
  error: ['status', 'log'],
};

export function validateGitCommand(
  ctx: WorktreeContext,
  command: string
): { allowed: boolean; reason?: string } {
  const status = ctx.worktree?.status;
  if (!status) return { allowed: false, reason: 'No worktree context' };

  // Check blocked commands first
  const baseCommand = command.split(' ')[0];
  for (const blocked of BLOCKED_COMMANDS) {
    if (command.startsWith(blocked)) {
      return {
        allowed: false,
        reason: getBlockedReason(blocked),
      };
    }
  }

  // Check state-specific allowed commands
  const allowedCommands = STATE_ALLOWED_COMMANDS[status] ?? [];

  if (!allowedCommands.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command '${baseCommand}' not allowed in state '${status}'`,
    };
  }

  return { allowed: true };
}

function getBlockedReason(command: string): string {
  switch (command) {
    case 'push': return 'Use the merge workflow to sync changes.';
    case 'pull': return 'Worktrees are isolated. Create a new worktree for latest changes.';
    case 'fetch': return 'Fetch is managed at the project level.';
    case 'rebase -i': return 'Interactive rebase is not supported.';
    case 'reset --hard': return 'Use REMOVE with force flag instead.';
    case 'stash': return 'Commit or discard changes instead.';
    default: return '';
  }
}
```

---

## Cleanup

### Stale Worktree Detection

Worktrees are considered **stale** after 7 days of inactivity (configurable per project).

```typescript
// lib/state-machines/worktree-lifecycle/cleanup.ts
import { db } from '@/db/client';
import { worktrees, tasks, projects } from '@/db/schema';
import { eq, and, lt, isNull, ne } from 'drizzle-orm';

export interface StaleWorktreeInfo {
  worktreeId: string;
  branch: string;
  lastActivity: Date;
  daysSinceActivity: number;
  reason: PruneReason;
  taskStatus?: string;
}

export async function findStaleWorktrees(
  projectId: string,
  options?: { maxAgeDays?: number }
): Promise<StaleWorktreeInfo[]> {
  const maxAgeDays = options?.maxAgeDays ?? 7;
  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - maxAgeDays);

  // Query for potentially stale worktrees
  const candidates = await db.query.worktrees.findMany({
    where: and(
      eq(worktrees.projectId, projectId),
      eq(worktrees.status, 'active'),
      lt(worktrees.updatedAt, staleThreshold),
      isNull(worktrees.removedAt)
    ),
    with: {
      task: true,
    },
  });

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  const staleWorktrees: StaleWorktreeInfo[] = [];

  for (const worktree of candidates) {
    // Skip if task is actively in progress
    if (worktree.task?.column === 'in_progress') {
      continue;
    }

    // Calculate days since activity
    const daysSinceActivity = Math.floor(
      (Date.now() - new Date(worktree.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    // Determine reason
    let reason: PruneReason = 'stale';

    // Check if branch still exists
    const branchExists = await checkBranchExists(project?.path ?? '', worktree.branch);
    if (!branchExists) {
      reason = 'branch_deleted';
    }

    // Check if task is completed
    if (worktree.task?.column === 'verified') {
      reason = 'task_completed';
    }

    staleWorktrees.push({
      worktreeId: worktree.id,
      branch: worktree.branch,
      lastActivity: worktree.updatedAt,
      daysSinceActivity,
      reason,
      taskStatus: worktree.task?.column,
    });
  }

  return staleWorktrees;
}
```

### Automatic Cleanup Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| Task Verified | Task moved to verified column | Schedule removal (24h delay) |
| Branch Deleted | Remote branch removed | Immediate prune |
| Inactivity | No updates for 7+ days | Mark stale, notify user |
| Disk Space | Worktree root > threshold | Prune oldest stale first |
| Manual | User requests cleanup | Immediate removal |

```typescript
// lib/state-machines/worktree-lifecycle/auto-cleanup.ts
import { CronJob } from 'cron';

export interface CleanupConfig {
  maxAgeDays: number;        // Default: 7
  autoCleanupEnabled: boolean;
  diskThresholdGB: number;   // Default: 10
  cleanupSchedule: string;   // Cron expression, default: '0 2 * * *' (2am daily)
}

export function setupAutoCleanup(config: CleanupConfig) {
  if (!config.autoCleanupEnabled) return;

  const job = new CronJob(config.cleanupSchedule, async () => {
    console.log('[Worktree Cleanup] Starting scheduled cleanup...');

    // Get all projects
    const allProjects = await db.query.projects.findMany();

    for (const project of allProjects) {
      // Find stale worktrees
      const stale = await findStaleWorktrees(project.id, {
        maxAgeDays: config.maxAgeDays,
      });

      // Prune each stale worktree
      for (const worktreeInfo of stale) {
        try {
          await worktreeService.remove(worktreeInfo.worktreeId, true);
          console.log(`[Worktree Cleanup] Removed stale worktree: ${worktreeInfo.branch}`);
        } catch (error) {
          console.error(`[Worktree Cleanup] Failed to remove ${worktreeInfo.branch}:`, error);
        }
      }
    }

    // Check disk space
    await checkDiskSpaceAndCleanup(config.diskThresholdGB);

    console.log('[Worktree Cleanup] Scheduled cleanup complete');
  });

  job.start();
  return job;
}

async function checkDiskSpaceAndCleanup(thresholdGB: number) {
  // Get worktree root disk usage
  const worktreeRoots = await db.query.projects.findMany({
    columns: { id: true, path: true, config: true },
  });

  for (const project of worktreeRoots) {
    const worktreeRoot = project.config.worktreeRoot ?? '.worktrees';
    const fullPath = `${project.path}/${worktreeRoot}`;

    try {
      const usage = await $`du -sg ${fullPath}`.text();
      const sizeGB = parseInt(usage.split('\t')[0]) || 0;

      if (sizeGB > thresholdGB) {
        console.log(`[Worktree Cleanup] ${fullPath} exceeds ${thresholdGB}GB (${sizeGB}GB)`);
        // Additional aggressive cleanup could be triggered here
      }
    } catch {
      // Directory might not exist
    }
  }
}
```

### Manual Cleanup API

```typescript
// lib/services/worktree-cleanup.ts
export interface CleanupResult {
  removed: string[];
  failed: Array<{ id: string; error: string }>;
  skipped: string[];
}

export async function cleanupWorktrees(
  projectId: string,
  options?: {
    filter?: 'stale' | 'orphaned' | 'completed' | 'all';
    dryRun?: boolean;
    force?: boolean;
  }
): Promise<CleanupResult> {
  const filter = options?.filter ?? 'stale';
  const dryRun = options?.dryRun ?? false;
  const force = options?.force ?? false;

  const result: CleanupResult = {
    removed: [],
    failed: [],
    skipped: [],
  };

  // Find worktrees to clean based on filter
  let candidates: StaleWorktreeInfo[];

  switch (filter) {
    case 'stale':
      candidates = await findStaleWorktrees(projectId);
      break;
    case 'orphaned':
      candidates = (await findStaleWorktrees(projectId)).filter(w => w.reason === 'branch_deleted');
      break;
    case 'completed':
      candidates = (await findStaleWorktrees(projectId)).filter(w => w.reason === 'task_completed');
      break;
    case 'all':
      candidates = await findStaleWorktrees(projectId, { maxAgeDays: 0 });
      break;
  }

  for (const candidate of candidates) {
    if (dryRun) {
      result.removed.push(candidate.worktreeId);
      continue;
    }

    try {
      const removeResult = await worktreeService.remove(candidate.worktreeId, force);
      if (removeResult.ok) {
        result.removed.push(candidate.worktreeId);
      } else {
        result.failed.push({ id: candidate.worktreeId, error: removeResult.error.message });
      }
    } catch (error) {
      result.failed.push({ id: candidate.worktreeId, error: String(error) });
    }
  }

  return result;
}
```

---

## Error Handling

### Error Categories

| Category | Error Codes | Recoverable | User Action |
|----------|-------------|-------------|-------------|
| **Creation** | `BRANCH_EXISTS`, `PATH_EXISTS`, `BRANCH_CREATION_FAILED` | Yes | Fix conflict, retry |
| **Git Operation** | `MERGE_FAILED`, `CHECKOUT_FAILED` | Usually | Review output, retry |
| **Permission** | `PERMISSION_DENIED`, `READONLY_FS` | No | Fix permissions |
| **Disk Space** | `NO_SPACE_LEFT`, `QUOTA_EXCEEDED` | No | Free space, retry |
| **Network** | `FETCH_FAILED`, `TIMEOUT` | Yes | Check connection, retry |
| **Internal** | `WORKTREE_NOT_FOUND`, `INVALID_STATE` | No | Report bug |

### Error Type Definitions

```typescript
// lib/state-machines/worktree-lifecycle/errors.ts
export type WorktreeErrorCode =
  // Creation errors
  | 'BRANCH_EXISTS'
  | 'BRANCH_CHECKED_OUT'
  | 'PATH_EXISTS'
  | 'BRANCH_CREATION_FAILED'
  | 'WORKTREE_CREATION_FAILED'
  // Setup errors
  | 'ENV_COPY_FAILED'
  | 'DEPS_INSTALL_FAILED'
  | 'INIT_SCRIPT_FAILED'
  // Git operation errors
  | 'MERGE_FAILED'
  | 'CHECKOUT_FAILED'
  | 'ABORT_FAILED'
  // Removal errors
  | 'WORKTREE_REMOVAL_FAILED'
  | 'WORKTREE_IN_USE'
  // General errors
  | 'NO_WORKTREE'
  | 'INVALID_STATE'
  | 'PERMISSION_DENIED'
  | 'NO_SPACE_LEFT';

export interface WorktreeError {
  code: WorktreeErrorCode;
  message: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
  suggestedAction?: string;
}

export const WorktreeErrors = {
  BRANCH_EXISTS: (branch: string): WorktreeError => ({
    code: 'BRANCH_EXISTS',
    message: `Branch '${branch}' already exists`,
    recoverable: true,
    suggestedAction: 'Use a different branch name or delete the existing branch',
  }),

  BRANCH_CHECKED_OUT: (branch: string): WorktreeError => ({
    code: 'BRANCH_CHECKED_OUT',
    message: `Branch '${branch}' is already checked out in another worktree`,
    recoverable: true,
    suggestedAction: 'Remove the other worktree first or use a different branch',
  }),

  PATH_EXISTS: (path: string): WorktreeError => ({
    code: 'PATH_EXISTS',
    message: `Worktree path already exists: ${path}`,
    recoverable: true,
    suggestedAction: 'Remove the existing directory or use git worktree prune',
  }),

  WORKTREE_IN_USE: (agentId: string): WorktreeError => ({
    code: 'WORKTREE_IN_USE',
    message: 'Worktree is being used by an active agent',
    details: { agentId },
    recoverable: false,
    suggestedAction: 'Wait for agent to complete or abort the agent first',
  }),

  NO_SPACE_LEFT: (required: number, available: number): WorktreeError => ({
    code: 'NO_SPACE_LEFT',
    message: `Not enough disk space. Required: ${required}MB, Available: ${available}MB`,
    details: { required, available },
    recoverable: false,
    suggestedAction: 'Free up disk space and retry',
  }),
} as const;
```

### Recovery Procedures

```typescript
// lib/state-machines/worktree-lifecycle/recovery.ts
export interface RecoveryProcedure {
  errorCode: WorktreeErrorCode;
  steps: RecoveryStep[];
  automatic: boolean;
}

export interface RecoveryStep {
  description: string;
  action: () => Promise<Result<void, WorktreeError>>;
  rollback?: () => Promise<void>;
}

export const recoveryProcedures: Record<string, RecoveryProcedure> = {
  BRANCH_EXISTS: {
    errorCode: 'BRANCH_EXISTS',
    automatic: false,
    steps: [
      {
        description: 'Check if branch is used by another worktree',
        action: async () => {
          // Implementation
        },
      },
      {
        description: 'Delete branch if orphaned',
        action: async () => {
          // Implementation
        },
      },
    ],
  },

  NO_SPACE_LEFT: {
    errorCode: 'NO_SPACE_LEFT',
    automatic: true,
    steps: [
      {
        description: 'Prune stale worktrees to free space',
        action: async () => {
          // Implementation
        },
      },
      {
        description: 'Retry operation',
        action: async () => {
          // Retry the failed operation
        },
      },
    ],
  },
};

export async function attemptRecovery(
  ctx: WorktreeContext,
  error: WorktreeError
): Promise<Result<void, WorktreeError>> {
  const procedure = recoveryProcedures[error.code];

  if (!procedure) {
    return err(error); // No recovery procedure available
  }

  if (!procedure.automatic) {
    // Requires user intervention
    await publishWorktreeEvent(ctx.worktree?.id ?? 'system', {
      type: 'worktree:recovery_needed',
      payload: {
        error,
        procedure: procedure.steps.map(s => s.description),
      },
      timestamp: Date.now(),
    });
    return err(error);
  }

  // Attempt automatic recovery
  for (const step of procedure.steps) {
    const result = await step.action();
    if (!result.ok) {
      // Rollback if available
      if (step.rollback) {
        await step.rollback();
      }
      return result;
    }
  }

  return ok(undefined);
}
```

---

## Implementation

### Service Integration

```typescript
// lib/services/worktree-service.ts
import { interpret } from 'xstate';
import { worktreeLifecycleMachine } from '@/lib/state-machines/worktree-lifecycle';
import type { WorktreeContext } from '@/lib/state-machines/worktree-lifecycle/guards';
import type { WorktreeEvent } from '@/lib/state-machines/worktree-lifecycle/events';
import { db } from '@/db/client';
import { worktrees, projects, tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';

export class WorktreeService implements IWorktreeService {
  private machines: Map<string, ReturnType<typeof interpret>> = new Map();

  private async getMachine(worktreeId: string) {
    if (this.machines.has(worktreeId)) {
      return this.machines.get(worktreeId)!;
    }

    // Load context from database
    const worktree = await this.getWorktree(worktreeId);
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, worktree?.projectId ?? ''),
    });
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.worktreeId, worktreeId),
    });

    const context: WorktreeContext = {
      worktree,
      project: project!,
      task,
    };

    const machine = interpret(
      worktreeLifecycleMachine.withContext(context)
    ).start(worktree?.status ?? 'idle');

    this.machines.set(worktreeId, machine);
    return machine;
  }

  async send(worktreeId: string, event: WorktreeEvent): Promise<Result<void, WorktreeError>> {
    const machine = await this.getMachine(worktreeId);
    const currentState = machine.getSnapshot();

    // Check if transition is valid
    const nextState = worktreeLifecycleMachine.transition(currentState, event);

    if (!nextState.changed) {
      return err({
        code: 'INVALID_STATE',
        message: `Cannot process ${event.type} in state ${currentState.value}`,
        recoverable: false,
      });
    }

    // Execute transition
    machine.send(event);

    // Wait for actions to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Sync state to database
    const newState = machine.getSnapshot();
    await this.updateStatus(worktreeId, newState.value as WorktreeStatus);

    return ok(undefined);
  }

  // Lifecycle methods delegate to state machine
  async create(input: WorktreeCreateInput, options?: WorktreeSetupOptions) {
    // Create initial record
    const [worktree] = await db.insert(worktrees).values({
      projectId: input.projectId,
      taskId: input.taskId,
      branch: input.branch,
      baseBranch: input.baseBranch ?? 'main',
      path: '', // Will be set by action
      status: 'creating',
    }).returning();

    // Send CREATE event
    return this.send(worktree.id, {
      type: 'CREATE',
      ...input,
      options,
    });
  }

  async merge(worktreeId: string, targetBranch?: string) {
    return this.send(worktreeId, { type: 'MERGE', targetBranch });
  }

  async remove(worktreeId: string, force?: boolean) {
    return this.send(worktreeId, { type: 'REMOVE', force });
  }

  // ... other methods
}

export const worktreeService = new WorktreeService();
```

### Database Status Sync

```typescript
// lib/state-machines/worktree-lifecycle/db-sync.ts
import { db } from '@/db/client';
import { worktrees } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface WorktreeDbState {
  status: WorktreeStatus;
  lastError?: string;
  envCopied: boolean;
  depsInstalled: boolean;
  initScriptRun: boolean;
  mergedAt?: Date;
  removedAt?: Date;
}

export async function syncStateToDb(
  worktreeId: string,
  state: WorktreeDbState
): Promise<void> {
  await db.update(worktrees).set({
    status: state.status,
    lastError: state.lastError ?? null,
    envCopied: state.envCopied,
    depsInstalled: state.depsInstalled,
    initScriptRun: state.initScriptRun,
    mergedAt: state.mergedAt,
    removedAt: state.removedAt,
    updatedAt: new Date(),
  }).where(eq(worktrees.id, worktreeId));
}

export async function loadStateFromDb(worktreeId: string): Promise<WorktreeDbState | null> {
  const worktree = await db.query.worktrees.findFirst({
    where: eq(worktrees.id, worktreeId),
  });

  if (!worktree) return null;

  return {
    status: worktree.status,
    lastError: worktree.lastError ?? undefined,
    envCopied: worktree.envCopied,
    depsInstalled: worktree.depsInstalled,
    initScriptRun: worktree.initScriptRun,
    mergedAt: worktree.mergedAt ?? undefined,
    removedAt: worktree.removedAt ?? undefined,
  };
}

// Subscription for real-time updates
export function subscribeToStateChanges(
  worktreeId: string,
  callback: (state: WorktreeDbState) => void
): () => void {
  // Implementation depends on your real-time infrastructure
  // Could use SQLite triggers, Durable Streams, etc.
  return () => {};
}
```

---

## Worktree Events (Durable Streams)

Events published during worktree lifecycle for real-time sync:

```typescript
// lib/events/worktree.ts
type WorktreeStreamEvent =
  // Lifecycle events
  | { type: 'worktree:creating'; payload: { worktreeId: string; branch: string; path: string } }
  | { type: 'worktree:created'; payload: { worktreeId: string; branch: string; path: string } }
  | { type: 'worktree:removing'; payload: { worktreeId: string; branch: string } }
  | { type: 'worktree:removed'; payload: { worktreeId: string; branch: string } }
  // Git operation events
  | { type: 'worktree:merging'; payload: { worktreeId: string; targetBranch: string; strategy: string } }
  | { type: 'worktree:merged'; payload: { worktreeId: string; branch: string; targetBranch: string } }
  | { type: 'worktree:merge_aborted'; payload: { worktreeId: string } }
  // Error and status events
  | { type: 'worktree:error'; payload: { worktreeId: string; error: string; message: string; recoverable: boolean } }
  | { type: 'worktree:stale'; payload: { worktreeId: string; lastActivity: Date } }
  | { type: 'worktrees:pruned'; payload: { projectId: string; count: number } }
  // State updates
  | { type: 'state:update'; payload: { status: WorktreeStatus; error?: string } }
  // Recovery events
  | { type: 'worktree:recovery_needed'; payload: { error: WorktreeError; procedure: string[] } };

interface WorktreeState {
  status: WorktreeStatus;
  branch?: string;
  path?: string;
  lastError?: string;
}
```

---

## Testing

### Unit Tests

```typescript
// tests/state-machines/worktree-lifecycle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { worktreeLifecycleMachine } from '@/lib/state-machines/worktree-lifecycle';

describe('Worktree Lifecycle State Machine', () => {
  describe('Creation flow', () => {
    it('transitions from idle to creating on CREATE', () => {
      const state = worktreeLifecycleMachine.transition('idle', {
        type: 'CREATE',
        projectId: 'project-1',
        taskId: 'task-1',
        branch: 'feature/test',
      });
      expect(state.value).toBe('creating');
    });

    it('transitions from creating to active on CREATED', () => {
      const state = worktreeLifecycleMachine.transition('creating', {
        type: 'CREATED',
      });
      expect(state.value).toBe('active');
    });
  });

  describe('Merge flow', () => {
    it('transitions from active to merging on MERGE', () => {
      const state = worktreeLifecycleMachine.transition('active', {
        type: 'MERGE',
        targetBranch: 'main',
      });
      expect(state.value).toBe('merging');
    });

    it('transitions from merging to removing on MERGE_COMPLETE', () => {
      const state = worktreeLifecycleMachine.transition('merging', {
        type: 'MERGE_COMPLETE',
      });
      expect(state.value).toBe('removing');
    });

    it('transitions from merging to active on ABORT_MERGE', () => {
      const state = worktreeLifecycleMachine.transition('merging', {
        type: 'ABORT_MERGE',
      });
      expect(state.value).toBe('active');
    });

    it('transitions from merging to error on ERROR', () => {
      const state = worktreeLifecycleMachine.transition('merging', {
        type: 'ERROR',
        error: { code: 'MERGE_FAILED', message: 'Merge failed' },
        operation: 'merge',
        recoverable: true,
      });
      expect(state.value).toBe('error');
    });
  });

  describe('Removal flow', () => {
    it('transitions from active to removing on REMOVE', () => {
      const state = worktreeLifecycleMachine.transition('active', {
        type: 'REMOVE',
      });
      expect(state.value).toBe('removing');
    });

    it('transitions from removing to removed on COMPLETE', () => {
      const state = worktreeLifecycleMachine.transition('removing', {
        type: 'COMPLETE',
      });
      expect(state.value).toBe('removed');
    });
  });

  describe('Error handling', () => {
    it('transitions from creating to error on ERROR', () => {
      const state = worktreeLifecycleMachine.transition('creating', {
        type: 'ERROR',
        error: { code: 'WORKTREE_CREATION_FAILED', message: 'Failed' },
        operation: 'create',
        recoverable: true,
      });
      expect(state.value).toBe('error');
    });

    it('transitions from error to active on RETRY', () => {
      const state = worktreeLifecycleMachine.transition('error', {
        type: 'RETRY',
        operation: 'create',
      });
      expect(state.value).toBe('active');
    });

    it('transitions from error to removed on REMOVE', () => {
      const state = worktreeLifecycleMachine.transition('error', {
        type: 'REMOVE',
      });
      expect(state.value).toBe('removed');
    });
  });

  describe('Invalid transitions', () => {
    it('rejects CREATE in active state', () => {
      const state = worktreeLifecycleMachine.transition('active', {
        type: 'CREATE',
        projectId: 'project-1',
        taskId: 'task-1',
        branch: 'feature/test',
      });
      expect(state.changed).toBe(false);
    });

    it('rejects MERGE from creating state', () => {
      const state = worktreeLifecycleMachine.transition('creating', {
        type: 'MERGE',
        targetBranch: 'main',
      });
      expect(state.changed).toBe(false);
    });
  });
});
```

---

## Wireframe References

| State | Wireframe | Component |
|-------|-----------|-----------|
| All states | [worktree-management.html](../wireframes/worktree-management.html) | Worktree status list |
| `error` | [error-state-expanded.html](../wireframes/error-state-expanded.html) | Error details and recovery |
| Cleanup | [worktree-cleanup.html](../wireframes/worktree-cleanup.html) | Stale worktree cleanup UI |

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
| [User Stories](../user-stories.md) | Worktree lifecycle requirements |
