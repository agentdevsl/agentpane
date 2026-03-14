# Git Worktrees Integration Specification

## Overview

Git worktrees enable parallel agent execution by providing isolated working directories for each task. This specification defines the complete worktree lifecycle, from creation through merge and cleanup.

**Wireframe Reference**: [worktree-management.html](../wireframes/worktree-management.html)

---

## Architecture

### Directory Structure

```text
project/
├── .git/                                      # Shared git directory
├── main/                                      # Primary worktree (main branch)
└── .worktrees/                                # Agent worktrees directory (configurable via project.config.worktreeRoot)
    ├── fix-login-validation-abc123/           # Agent 1 isolated workspace
    ├── add-user-authentication-def456/        # Agent 2 isolated workspace
    └── refactor-api-endpoints-789abc/         # Agent 3 isolated workspace
```

### Branch Naming Convention

All agent branches follow the pattern:

```
{task-slug}-{short-id}
```

| Component | Description | Example |
|-----------|-------------|---------|
| `task-slug` | Kebab-case slugified task title | `fix-login-validation`, `add-user-auth` |
| `short-id` | First 6 characters of task CUID2 | `abc123`, `def456` |

**Full Example**: `fix-login-validation-abc123`

The branch name is derived from the task title via `slugify()` and appended with the first 6 characters of the task ID for uniqueness. There is no type prefix or slash separator.

---

## Worktree Service API

### Interface Definition

```typescript
// src/services/worktree.service.ts
import type { Result } from '../lib/utils/result';
import type { Worktree, WorktreeStatus } from '../db/schema';
import type { WorktreeError } from '../lib/errors/worktree-errors';
import type { Database } from '../types/database';

export type WorktreeCreateInput = {
  projectId: string;
  agentId: string;
  taskId: string;
  taskTitle: string;
  baseBranch?: string; // defaults to 'main'
};

export type WorktreeSetupOptions = {
  skipEnvCopy?: boolean;
  skipDepsInstall?: boolean;
  skipInitScript?: boolean;
};

export type WorktreeStatusInfo = {
  id: string;
  branch: string;
  status: WorktreeStatus;
  path: string;
  updatedAt: string | null;
};

export type PruneResult = {
  pruned: number;
  failed: Array<{ worktreeId: string; branch: string; error: string }>;
};

export type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
};

// WorktreeService is a class that takes (db: Database, runner: CommandRunner) in its constructor.
// It uses dependency-injected command execution, enabling both local (Bun shell)
// and sandboxed (Docker container) execution via createSandboxCommandRunner().

export class WorktreeService {
  constructor(private db: Database, private runner: CommandRunner) {}

  create(input: WorktreeCreateInput, options?: WorktreeSetupOptions): Promise<Result<Worktree, WorktreeError>>;
  merge(worktreeId: string, targetBranch?: string): Promise<Result<void, WorktreeError>>;
  remove(worktreeId: string, force?: boolean): Promise<Result<void, WorktreeError>>;
  getStatus(worktreeId: string): Promise<Result<WorktreeStatusInfo, WorktreeError>>;
  list(projectId: string): Promise<Result<WorktreeStatusInfo[], never>>;
  prune(projectId: string): Promise<Result<PruneResult, WorktreeError>>;
  commit(worktreeId: string, message: string): Promise<Result<string, WorktreeError>>;
  getDiff(worktreeId: string): Promise<Result<GitDiff, WorktreeError>>;
  getByBranch(projectId: string, branch: string): Promise<Result<Worktree | null, never>>;
  copyEnv(worktreeId: string): Promise<Result<void, WorktreeError>>;
  installDeps(worktreeId: string): Promise<Result<void, WorktreeError>>;
  runInitScript(worktreeId: string): Promise<Result<void, WorktreeError>>;
}
```

---

## Creation Workflow

### Step-by-Step Process

```typescript
// src/services/worktree.service.ts (create method)

async create(
  input: WorktreeCreateInput,
  options?: WorktreeSetupOptions
): WorktreeServiceResult<Worktree> {
  const { projectId, agentId, taskId, taskTitle, baseBranch = 'main' } = input;

  // 1. Get project and agent records
  const project = await this.db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) {
    return err(WorktreeErrors.CREATION_FAILED('unknown', 'Project not found'));
  }

  const agent = await this.db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) {
    return err(WorktreeErrors.CREATION_FAILED('unknown', 'Agent not found'));
  }

  // 2. Build branch name and worktree path from task title
  const taskSlug = slugify(taskTitle);
  const shortId = taskId.slice(0, 6);
  const branch = `${taskSlug}-${shortId}`;
  const root = project.config?.worktreeRoot ?? '.worktrees';
  const worktreePath = path.join(project.path, root, branch);

  // 3. Check if branch already exists
  const branchCheck = await this.runner.exec(
    `git branch --list "${escapeShellString(branch)}"`,
    project.path
  );
  if (branchCheck.stdout.trim()) {
    return err(WorktreeErrors.BRANCH_EXISTS(branch));
  }

  // 4. Create git worktree FIRST (before DB insert)
  try {
    await this.runner.exec(
      `git worktree add "${escapeShellString(worktreePath)}" -b "${escapeShellString(branch)}" "${escapeShellString(baseBranch)}"`,
      project.path
    );
  } catch (error) {
    return err(WorktreeErrors.CREATION_FAILED(branch, String(error)));
  }

  // 5. Create database record with 'creating' status
  const [insertedWorktree] = await this.db.insert(worktrees).values({
    projectId,
    agentId,
    taskId,
    branch,
    path: worktreePath,
    baseBranch,
    status: 'creating',
  }).returning();

  const worktreeId = insertedWorktree.id;

  // 6. Run setup steps (env copy, deps install, init script)
  //    Each step can be skipped via WorktreeSetupOptions.
  //    Failures set status to 'error' and return early.
  if (!options?.skipEnvCopy) {
    const envResult = await this.copyEnv(worktreeId);
    if (!envResult.ok) {
      await this.db.update(worktrees)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));
      return envResult;
    }
  }

  if (!options?.skipDepsInstall) {
    const depsResult = await this.installDeps(worktreeId);
    if (!depsResult.ok) {
      await this.db.update(worktrees)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));
      return depsResult;
    }
  }

  if (!options?.skipInitScript && project.config?.initScript) {
    const initResult = await this.runInitScript(worktreeId);
    if (!initResult.ok) {
      await this.db.update(worktrees)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));
      return initResult;
    }
  }

  // 7. Update status to 'active'
  const [updatedWorktree] = await this.db.update(worktrees)
    .set({ status: 'active', updatedAt: new Date().toISOString() })
    .where(eq(worktrees.id, worktreeId))
    .returning();

  return ok(updatedWorktree);
}
```

### Creation Sequence Diagram

```
┌─────────┐     ┌───────────────┐     ┌─────────┐     ┌────────────┐
│ TaskSvc │     │ WorktreeSvc   │     │ CmdRunner│    │     DB     │
└────┬────┘     └───────┬───────┘     └────┬────┘     └─────┬──────┘
     │                  │                  │                │
     │ create(input)    │                  │                │
     │─────────────────>│                  │                │
     │                  │                  │                │
     │                  │ git branch --list│                │
     │                  │─────────────────>│                │
     │                  │                  │                │
     │                  │ git worktree add │                │
     │                  │─────────────────>│                │
     │                  │                  │                │
     │                  │ INSERT (creating)│                │
     │                  │─────────────────────────────────->│
     │                  │                  │                │
     │                  │ cp .env          │                │
     │                  │─────────────────>│                │
     │                  │                  │                │
     │                  │ bun install      │                │
     │                  │─────────────────>│                │
     │                  │                  │                │
     │                  │ initScript       │                │
     │                  │─────────────────>│                │
     │                  │                  │                │
     │                  │ UPDATE (active)  │                │
     │                  │─────────────────────────────────->│
     │                  │                  │                │
     │ Result<Worktree> │                  │                │
     │<─────────────────│                  │                │
```

Note: The git worktree is created *before* the database record. This ensures the filesystem state is valid before tracking it. If git worktree creation fails, no orphaned DB record is left behind.

---

## Merge Workflow

### On Task Approval

When a task is approved, the worktree branch is merged into the base branch. Merge and removal are **separate operations** -- after a successful merge the worktree stays in `active` status with a `mergedAt` timestamp. Call `remove()` separately to clean up the worktree.

```typescript
// src/services/worktree.service.ts (merge method)

async merge(worktreeId: string, targetBranch?: string): WorktreeServiceResult<void> {
  // 1. Get worktree and project
  const worktree = await this.db.query.worktrees.findFirst({
    where: eq(worktrees.id, worktreeId),
    with: { project: true },
  });

  if (!worktree) {
    return err(WorktreeErrors.NOT_FOUND);
  }

  const target = targetBranch ?? worktree.baseBranch;

  // 2. Update status to 'merging'
  await this.db.update(worktrees)
    .set({ status: 'merging', updatedAt: new Date().toISOString() })
    .where(eq(worktrees.id, worktreeId));

  // 3. Auto-commit any uncommitted changes before merge
  const commitResult = await this.commit(worktreeId, `Auto-commit before merge to ${target}`);
  if (!commitResult.ok) {
    return commitResult;
  }

  try {
    // 4. Checkout target branch, pull latest, merge
    await this.runner.exec(`git checkout "${escapeShellString(target)}"`, worktree.project.path);
    await this.runner.exec('git pull --rebase', worktree.project.path);
    const mergeMessage = escapeShellString(`Merge branch '${worktree.branch}'`);
    const merge = await this.runner.exec(
      `git merge "${escapeShellString(worktree.branch)}" --no-ff -m "${mergeMessage}"`,
      worktree.project.path
    );

    // 5. Check for merge conflicts
    if (merge.stderr.includes('CONFLICT')) {
      const conflicts = await this.runner.exec(
        'git diff --name-only --diff-filter=U',
        worktree.project.path
      );

      try {
        await this.runner.exec('git merge --abort', worktree.project.path);
      } catch {
        // Merge abort can fail if merge wasn't in progress
      }

      // Reset status back to 'active' (not stuck in 'merging')
      await this.db.update(worktrees)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));

      return err(WorktreeErrors.MERGE_CONFLICT(
        conflicts.stdout.trim().split('\n').filter(Boolean)
      ));
    }

    // 6. Update status back to 'active' with mergedAt timestamp
    //    The worktree is NOT automatically removed after merge.
    await this.db.update(worktrees)
      .set({
        mergedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
      })
      .where(eq(worktrees.id, worktreeId));

    return ok(undefined);

  } catch (error) {
    // Reset status on merge failure
    await this.db.update(worktrees)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId));

    return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error)));
  }
}
```

### Removal (separate from merge)

Worktree removal is a distinct operation. It transitions through `removing` to `removed`:

```typescript
// src/services/worktree.service.ts (remove method)

async remove(worktreeId: string, force = false): WorktreeServiceResult<void> {
  // 1. Set status to 'removing'
  // 2. git worktree remove (with --force if requested)
  // 3. git branch -D to delete the local branch
  // 4. Set status to 'removed' with removedAt timestamp
  // On failure: set status to 'error'
}
```

---

## Cleanup and Pruning

### Stale Worktree Detection

The `prune()` method finds and removes worktrees that have been inactive for more than 7 days (based on `updatedAt` timestamp). It queries for `active` worktrees with `updatedAt` older than the threshold and force-removes them.

```typescript
// src/services/worktree.service.ts (prune method)

async prune(projectId: string): WorktreeServiceResult<PruneResult> {
  // Use ISO string for comparison since SQLite stores dates as TEXT
  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const stale = await this.db.query.worktrees.findMany({
    where: and(
      eq(worktrees.projectId, projectId),
      eq(worktrees.status, 'active'),
      lt(worktrees.updatedAt, staleThreshold)
    ),
  });

  let pruned = 0;
  const failed: PruneResult['failed'] = [];

  for (const worktree of stale) {
    const result = await this.remove(worktree.id, true);
    if (result.ok) {
      pruned += 1;
    } else {
      failed.push({
        worktreeId: worktree.id,
        branch: worktree.branch,
        error: String(result.error),
      });
    }
  }

  return ok({ pruned, failed });
}
```

### Filesystem Sync

The `list()` method performs a filesystem consistency check: it verifies each worktree path still exists on disk using `existsSync()`. Any records pointing to missing directories are automatically cleaned up (deleted from the database) in the background.

---

## Error Handling

### Worktree-Specific Errors

All worktree errors are defined in the error catalog. Key error codes:

| Code | HTTP Status | Trigger |
|------|-------------|---------|
| `WORKTREE_CREATION_FAILED` | 500 | `git worktree add` fails |
| `WORKTREE_NOT_FOUND` | 404 | Worktree ID doesn't exist |
| `WORKTREE_BRANCH_EXISTS` | 409 | Branch already exists |
| `WORKTREE_MERGE_CONFLICT` | 409 | Merge has conflicts |
| `WORKTREE_DIRTY` | 400 | Uncommitted changes present |
| `WORKTREE_REMOVAL_FAILED` | 500 | `git worktree remove` fails |
| `WORKTREE_ENV_COPY_FAILED` | 500 | `.env` copy fails |
| `WORKTREE_INIT_SCRIPT_FAILED` | 500 | Post-setup script fails |

### Error Recovery Strategies

Recovery from stuck states is handled by setting the worktree status to `error` via `updatedAt` timestamp updates. The `remove()` method with `force=true` can clean up any worktree regardless of its current state.

```typescript
// Force remove a stuck worktree via the service
const result = await worktreeService.remove(worktreeId, true);
// This will:
// 1. Set status to 'removing'
// 2. Run `git worktree remove --force`
// 3. Run `git branch -D` to delete the local branch
// 4. Set status to 'removed' with removedAt timestamp
// On failure: set status to 'error'
```

Note: The worktrees table does not have `lastError` or tracking columns for individual setup steps (`envCopied`, `depsInstalled`, `initScriptRun`). Errors during creation set status to `error` and return the error via the `Result` type.

---

## Command Execution

### CommandRunner Abstraction

All shell commands are executed through a `CommandRunner` interface, not directly via Bun's `$` shell. This enables both local and sandboxed (Docker container) execution:

```typescript
export type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
};
```

For sandboxed execution, use `createSandboxCommandRunner()` which wraps commands in `sh -c` calls inside the container. All command arguments are escaped via `escapeShellString()` and validated against injection patterns via `validateShellCommand()`.

### Common Operations

```typescript
// Create worktree with new branch
await runner.exec(`git worktree add "${path}" -b "${branch}" "${baseBranch}"`, projectPath);

// Remove worktree
await runner.exec(`git worktree remove "${path}"`, projectPath);

// Force remove worktree
await runner.exec(`git worktree remove "${path}" --force`, projectPath);

// Check if branch exists
const check = await runner.exec(`git branch --list "${branch}"`, projectPath);

// Copy environment file
await runner.exec(`cp "${envSource}" "${envTarget}"`, projectPath);

// Install dependencies
await runner.exec('bun install', worktreePath);

// Stage all changes and commit
await runner.exec('git add -A', worktreePath);
await runner.exec(`git commit -m "${message}"`, worktreePath);

// Check for uncommitted changes
const status = await runner.exec('git status --porcelain', worktreePath);

// Merge branch (from main worktree)
await runner.exec(`git checkout "${target}"`, projectPath);
await runner.exec('git pull --rebase', projectPath);
await runner.exec(`git merge "${branch}" --no-ff -m "${message}"`, projectPath);

// Delete branch
await runner.exec(`git branch -D "${branch}"`, projectPath);

// Get diff against base branch
await runner.exec(`git diff --numstat "${baseBranch}"...HEAD`, worktreePath);
```

---

## Database Integration

### Worktree Table Schema

Defined in `src/db/schema/sqlite/worktrees.ts`:

```typescript
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { WorktreeStatus } from '../shared/enums';

export const worktrees = sqliteTable('worktrees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references((): AnySQLiteColumn => agents.id, { onDelete: 'set null' }),
  taskId: text('task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'set null' }),
  branch: text('branch').notNull(),
  path: text('path').notNull(),
  baseBranch: text('base_branch').default('main').notNull(),
  status: text('status').$type<WorktreeStatus>().default('creating').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
  mergedAt: text('merged_at'),
  removedAt: text('removed_at'),
});
```

### Status Enum

SQLite does not have native enums. Status values are defined as a const array in `src/db/schema/shared/enums.ts` and validated at the application level:

```typescript
export const WORKTREE_STATUS = [
  'creating',   // Worktree being set up
  'active',     // Ready for agent use
  'merging',    // Being merged to base
  'removing',   // Being cleaned up
  'removed',    // Successfully removed
  'error',      // Failed state
] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUS)[number];
```

---

## Workflow Events

Published via Durable Streams when worktree state changes. The event types are defined in `src/lib/sessions/schema.ts` and `src/lib/integrations/durable-streams/schema.ts`:

```typescript
// Only three worktree event types are emitted:
type WorktreeEventType =
  | 'worktree:created'   // Worktree successfully created and active
  | 'worktree:merged'    // Worktree branch merged into base
  | 'worktree:removed';  // Worktree cleaned up and removed
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | Worktrees table definition |
| [Error Catalog](../errors/error-catalog.md) | Worktree error codes |
| [User Stories](../user-stories.md) | Isolation requirements |
| [Test Cases](../testing/test-cases.md) | Worktree lifecycle tests |
| [GitHub App](./github-app.md) | Branch/PR operations |

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/services/worktree.service.ts` | WorktreeService class with all worktree operations |
| `src/db/schema/sqlite/worktrees.ts` | SQLite table definition (sqliteTable, text columns) |
| `src/db/schema/shared/enums.ts` | WORKTREE_STATUS const array (6 states) |
| `src/lib/errors/worktree-errors.ts` | Worktree error definitions |
| `src/lib/utils/slugify.ts` | Task title to branch name conversion |
