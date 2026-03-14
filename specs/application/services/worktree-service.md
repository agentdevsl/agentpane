# WorktreeService Specification

## Overview

The WorktreeService manages git worktree lifecycle for isolated agent execution environments. Each agent task runs in its own worktree, preventing conflicts between concurrent agents and enabling clean branch-based workflows with approval gates.

The service uses a `CommandRunner` abstraction that allows git operations to execute on the host or inside sandbox containers (Docker, K8s).

## Related Wireframes

- [Worktree Management](../wireframes/worktree-management.html) - Worktree status and cleanup UI
- [Error State Expanded](../wireframes/error-state-expanded.html) - Worktree error handling

---

## Constructor

```typescript
constructor(db: Database, runner: CommandRunner)
```

```typescript
type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
};
```

A `createSandboxCommandRunner()` factory is also exported to create a `CommandRunner` that executes commands inside a Docker/K8s container.

---

## Worktree Status Lifecycle (6 states)

```
creating -> active -> merging -> active (after merge)
                 \-> removing -> removed
                 \-> error
```

| Status | Description |
|--------|-------------|
| `creating` | Worktree is being created |
| `active` | Worktree is ready for use |
| `merging` | Branch is being merged to target |
| `removing` | Worktree is being removed |
| `removed` | Worktree has been removed |
| `error` | Operation failed |

Valid transitions:

| From | To | Trigger |
|------|----|---------|
| `creating` | `active` | Setup complete |
| `creating` | `error` | Setup failed |
| `active` | `merging` | Merge started |
| `active` | `removing` | Remove requested |
| `active` | `error` | Git operation failed |
| `merging` | `active` | Merge complete (status returns to active) |
| `merging` | `active` | Merge conflict (abort, return to active) |
| `removing` | `removed` | Removal complete |
| `removing` | `error` | Removal failed |

**Note:** After a successful merge, the worktree status returns to `active` (not `removed`). The worktree is separately removed via `remove()` after task approval.

---

## Type Definitions

```typescript
type WorktreeCreateInput = {
  projectId: string;
  agentId: string;
  taskId: string;
  taskTitle: string;
  baseBranch?: string;    // default: 'main'
};

type WorktreeSetupOptions = {
  skipEnvCopy?: boolean;
  skipDepsInstall?: boolean;
  skipInitScript?: boolean;
};

type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
};

type DiffFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

type GitDiff = {
  files: DiffFile[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
};

type WorktreeStatusInfo = {
  id: string;
  branch: string;
  status: WorktreeStatus;
  path: string;
  updatedAt: string | null;
};

type PruneResult = {
  pruned: number;
  failed: Array<{ worktreeId: string; branch: string; error: string }>;
};
```

---

## Lifecycle Management

### create

Creates a new git worktree for an agent task.

```typescript
async create(
  input: WorktreeCreateInput,
  options?: WorktreeSetupOptions
): Promise<Result<Worktree, WorktreeError>>
```

**Flow:**
1. Validate project and agent exist
2. Generate branch name from task title: `{taskSlug}-{shortId}` (e.g., `fix-login-validation-abc123`)
3. Build worktree path: `{project.path}/{worktreeRoot}/{branch}`
4. Check if branch already exists
5. Run `git worktree add` via CommandRunner
6. Insert worktree record with status `creating`
7. Run setup operations (unless skipped):
   - Copy `.env` file
   - Run `bun install`
   - Run project init script
8. Update status to `active`
9. Return worktree record

**Shell safety:** All branch names and paths are escaped via `escapeShellString()` before interpolation into shell commands.

### remove

Removes a worktree and its branch.

```typescript
async remove(worktreeId: string, force?: boolean): Promise<Result<void, WorktreeError>>
```

**Flow:**
1. Set status to `removing`
2. Run `git worktree remove`
3. Run `git branch -D` to delete the branch
4. Set status to `removed` with `removedAt` timestamp
5. On error, set status to `error`

### prune

Removes stale worktrees (no recent activity).

```typescript
async prune(projectId: string): Promise<Result<PruneResult, WorktreeError>>
```

Finds worktrees that are `active` but haven't been updated in 7 days. Returns a count of pruned and an array of failures.

---

## Setup Operations

### copyEnv

Copies the project's `.env` file to the worktree.

```typescript
async copyEnv(worktreeId: string): Promise<Result<void, WorktreeError>>
```

### installDeps

Runs `bun install` in the worktree.

```typescript
async installDeps(worktreeId: string): Promise<Result<void, WorktreeError>>
```

### runInitScript

Runs the project's configured init script. Sanitizes the script by removing null bytes and control characters.

```typescript
async runInitScript(worktreeId: string): Promise<Result<void, WorktreeError>>
```

---

## Git Operations

### commit

Creates a commit in the worktree with all staged changes.

```typescript
async commit(worktreeId: string, message: string): Promise<Result<string, WorktreeError>>
```

Returns the commit SHA or empty string if no changes.

### merge

Merges the worktree branch into the target branch.

```typescript
async merge(worktreeId: string, targetBranch?: string): Promise<Result<void, WorktreeError>>
```

**Flow:**
1. Set status to `merging`
2. Auto-commit any uncommitted changes
3. Checkout target branch in main worktree
4. Pull latest with rebase
5. Merge feature branch with `--no-ff`
6. If merge conflict: abort merge, reset status to `active`, return `MERGE_CONFLICT` error
7. On success: set `mergedAt`, reset status to `active`
8. On other failure: reset status to `active`

### getDiff

Gets the git diff comparing the worktree branch against the base branch.

```typescript
async getDiff(worktreeId: string): Promise<Result<GitDiff, WorktreeError>>
```

Uses `git diff --numstat` for file statistics and `git diff` for full patches.

---

## Status Operations

### getStatus

Gets basic status information for a worktree from the database.

```typescript
async getStatus(worktreeId: string): Promise<Result<WorktreeStatusInfo, WorktreeError>>
```

### list

Lists all worktrees for a project with filesystem validation.

```typescript
async list(projectId: string): Promise<Result<WorktreeStatusInfo[], never>>
```

**Key behavior:** Syncs with the filesystem - if a worktree path no longer exists on disk, its database record is cleaned up in the background.

### getByBranch

Gets a worktree by its branch name.

```typescript
async getByBranch(projectId: string, branch: string): Promise<Result<Worktree | null, never>>
```

---

## Branch Naming

Branch names are derived from task titles using `slugify()`:

```
Pattern: {taskSlug}-{shortId}
Example: fix-login-validation-abc123
```

The `slugify()` utility from `src/lib/utils/slugify.ts` converts task titles to filesystem-safe branch names.

---

## Security

### Shell Injection Prevention

All shell command arguments are escaped via `escapeShellString()`:
- Removes null bytes
- Escapes: backslash, double quote, backtick, dollar sign, newlines

A `validateShellCommand()` function rejects commands containing dangerous metacharacters (`;`, `|`, backtick, `$(`, `&&`, `||`, newlines).

### Sandbox CommandRunner

A `createSandboxCommandRunner()` factory creates a `CommandRunner` that executes commands inside sandbox containers, providing additional isolation.

---

## Error Conditions

| Error Code | HTTP | Condition |
|------------|------|-----------|
| `WORKTREE_CREATION_FAILED` | 500 | git worktree add fails |
| `WORKTREE_NOT_FOUND` | 404 | Worktree ID doesn't exist |
| `WORKTREE_BRANCH_EXISTS` | 409 | Branch already has worktree |
| `WORKTREE_MERGE_CONFLICT` | 409 | Merge conflicts detected |
| `WORKTREE_REMOVAL_FAILED` | 500 | git worktree remove fails |
| `WORKTREE_ENV_COPY_FAILED` | 500 | .env copy failed |
| `WORKTREE_INIT_SCRIPT_FAILED` | 500 | Init script exited non-zero |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/worktree.service.ts` | WorktreeService implementation |
| `src/lib/utils/slugify.ts` | Branch name generation |
| `src/db/schema/sqlite/worktrees.ts` | Worktree table schema |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | `worktrees` table |
| [Error Catalog](../errors/error-catalog.md) | Worktree errors |
| [AgentService](./agent-service.md) | Creates/uses worktrees for agent execution |
| [TaskService](./task-service.md) | Tasks reference worktrees |
| [ContainerAgentService](./container-agent-service.md) | Creates worktrees inside containers |
