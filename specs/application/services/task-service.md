# TaskService Specification

## Overview

The TaskService manages CRUD operations for tasks, Kanban board operations (column transitions, reordering), and the approval workflow. It enforces a **5-column** workflow state machine and integrates with container agent services for automatic agent triggering.

The implementation is split across:

- **TaskService** (`src/services/task.service.ts`) - Core CRUD, Kanban, approval, container agent integration
- **TaskCreationService** (`src/services/task-creation.service.ts`) - AI-powered task decomposition
- **Task Transitions** (`src/services/task-transitions.ts`) - Column transition rules

**Related Wireframes:**

- [Kanban Board](../wireframes/kanban-board-full.html) - Task board with drag-and-drop
- [Task Detail Dialog](../wireframes/task-detail-dialog.html) - Task creation and editing
- [Approval Dialog](../wireframes/approval-dialog.html) - Diff review and approval workflow

---

## Type Definitions

```typescript
// 5 columns (includes 'queued')
type TaskColumn = 'backlog' | 'queued' | 'in_progress' | 'waiting_approval' | 'verified';

type TaskPriority = 'high' | 'medium' | 'low';

type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;   // default: 'medium'
};

type UpdateTaskInput = {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;
  modelOverride?: string | null;  // Short model ID like 'claude-opus-4'
};

type MoveTaskResult = {
  task: Task;
  agentError?: string;  // Error if agent failed to start (task move still succeeded)
};

type ApproveInput = {
  approvedBy?: string;
  createMergeCommit?: boolean;  // default: true
};

type RejectInput = {
  reason: string;  // 1-1000 characters
};
```

---

## Task Schema

```typescript
tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  agentId: text('agent_id').references(() => agents.id),
  sessionId: text('session_id').references(() => sessions.id),
  worktreeId: text('worktree_id').references(() => worktrees.id),
  title: text('title').notNull(),
  description: text('description'),
  column: text('column').$type<TaskColumn>().default('backlog').notNull(),
  position: integer('position').default(0).notNull(),
  labels: text('labels', { mode: 'json' }).$type<string[]>().default([]),
  priority: text('priority').$type<TaskPriority>().default('medium'),
  branch: text('branch'),
  diffSummary: text('diff_summary', { mode: 'json' }).$type<DiffSummary>(),
  approvedAt: text('approved_at'),
  approvedBy: text('approved_by'),
  rejectionCount: integer('rejection_count').default(0),
  rejectionReason: text('rejection_reason'),
  modelOverride: text('model_override'),
  planOptions: text('plan_options', { mode: 'json' }).$type<StoredPlanOptions>(),
  plan: text('plan'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  lastAgentStatus: text('last_agent_status').$type<
    'completed' | 'cancelled' | 'error' | 'turn_limit' | 'planning'
  >(),
});
```

Key fields beyond basic CRUD:
- `priority` - Task priority (`high`, `medium`, `low`)
- `modelOverride` - Per-task model override (short model ID)
- `plan` / `planOptions` - Stores the agent's generated plan and `ExitPlanModeOptions` (includes `sdkSessionId`, `planningSandboxId`)
- `lastAgentStatus` - Status of the last agent run for this task
- `diffSummary` - JSON `DiffSummary` type (not a string)

---

## Column Transition State Machine

```
Valid Transitions (any column can move to any other column):
  backlog          -> queued, in_progress, waiting_approval, verified
  queued           -> backlog, in_progress, waiting_approval, verified
  in_progress      -> backlog, queued, waiting_approval, verified
  waiting_approval -> backlog, queued, in_progress, verified
  verified         -> backlog, queued, in_progress, waiting_approval
```

The transition rules are intentionally permissive to allow flexible task management. All transitions between different columns are allowed.

### Transition Implementation

```typescript
// src/services/task-transitions.ts
const ALL_COLUMNS: TaskColumn[] = ['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'];

export const VALID_TRANSITIONS: Record<TaskColumn, TaskColumn[]> = {
  backlog: ALL_COLUMNS.filter(c => c !== 'backlog'),
  queued: ALL_COLUMNS.filter(c => c !== 'queued'),
  in_progress: ALL_COLUMNS.filter(c => c !== 'in_progress'),
  waiting_approval: ALL_COLUMNS.filter(c => c !== 'waiting_approval'),
  verified: ALL_COLUMNS.filter(c => c !== 'verified'),
};

export const canTransition = (from: TaskColumn, to: TaskColumn): boolean =>
  VALID_TRANSITIONS[from]?.includes(to) ?? false;
```

---

## Constructor

```typescript
constructor(
  db: Database,
  worktreeService: {
    getDiff: (worktreeId: string) => Promise<Result<GitDiff, TaskError>>;
    merge: (worktreeId: string, targetBranch?: string) => Promise<Result<void, TaskError>>;
    remove: (worktreeId: string) => Promise<Result<void, TaskError>>;
  }
)
```

### Container Agent Integration

The TaskService optionally integrates with a container agent service:

```typescript
setContainerAgentService(service: ContainerAgentTrigger): void
```

```typescript
interface ContainerAgentTrigger {
  readonly providerName: string;
  startAgent: (input: StartAgentInput) => Promise<Result<void, unknown>>;
  stopAgent: (taskId: string) => Promise<Result<void, unknown>>;
  isAgentRunning: (taskId: string) => boolean;
  approvePlan: (taskId: string) => Promise<Result<void, unknown>>;
  rejectPlan: (taskId: string, reason?: string) => Promise<Result<void, unknown>>;
}
```

When set, moving a task to `in_progress` automatically triggers a container agent if the project has sandbox enabled (either project-level or global defaults).

---

## Method Specifications

### create

Creates a new task in the backlog column.

```typescript
async create(input: CreateTaskInput): Promise<Result<Task, TaskError>>
```

**Business Rules:**
1. Validates project exists
2. New tasks start in `backlog` column
3. Position set to end of backlog
4. Default priority is `medium`

### getById / list / update / delete

Standard CRUD operations. `update` supports `modelOverride` and `priority` fields.

### moveColumn

Moves a task to a different column, optionally triggering container agents.

```typescript
async moveColumn(
  id: string,
  column: TaskColumn,
  position?: number
): Promise<Result<MoveTaskResult, TaskError>>
```

**Key behaviors:**
1. No-op if task is already in the target column
2. Validates transition via `canTransition()`
3. Auto-calculates position if not provided (end of target column)
4. Sets `startedAt` when moving to `in_progress`
5. Sets `completedAt` when moving to `verified`
6. When moving to `in_progress` with container agent service configured:
   - Pre-generates a `sessionId`
   - Creates a session record in the database
   - Sets `sandboxProvider` on the session
   - Triggers container agent via `triggerContainerAgent()`
   - Returns any agent startup error in `MoveTaskResult.agentError`

### stopAgent

Stops a running container agent for a task.

```typescript
async stopAgent(taskId: string): Promise<Result<void, TaskError>>
```

If agent is not in memory (e.g., container died), cleans up task state by clearing `agentId`, `sessionId`, and setting `lastAgentStatus` to `cancelled`.

### approvePlan / rejectPlan

Delegates plan approval/rejection to the container agent service.

```typescript
async approvePlan(taskId: string): Promise<Result<void, TaskError>>
async rejectPlan(taskId: string, reason?: string): Promise<Result<void, TaskError>>
```

### reorder

Reorders a task within its current column.

```typescript
async reorder(id: string, position: number): Promise<Result<Task, TaskError>>
```

### getByColumn

Gets all tasks in a specific column, ordered by position (descending).

```typescript
async getByColumn(projectId: string, column: TaskColumn): Promise<Result<Task[], TaskError>>
```

### approve

Approves a task in `waiting_approval`, merges worktree, and moves to `verified`.

```typescript
async approve(id: string, input: ApproveInput): Promise<Result<Task, TaskError>>
```

**Flow:**
1. Validate task is in `waiting_approval` and not already approved
2. Get diff from worktree - must have changes
3. Merge worktree to target branch (unless `createMergeCommit: false`)
4. Update task with `column: 'verified'`, `approvedAt`, `approvedBy`, `diffSummary`, `completedAt`
5. Remove worktree after merge

### reject

Rejects a task and moves it back to `in_progress` with feedback.

```typescript
async reject(id: string, input: RejectInput): Promise<Result<Task, TaskError>>
```

Validates reason is 1-1000 characters. Increments `rejectionCount` and stores `rejectionReason`.

### getDiff

Generates a diff for a task's changes by delegating to worktree service.

```typescript
async getDiff(id: string): Promise<Result<DiffResult, TaskError>>
```

---

## Task Creation Service

The `TaskCreationService` (`src/services/task-creation.service.ts`) provides AI-powered task decomposition using the Claude Agent SDK:

- Takes a natural language description and uses an agent to break it into subtasks
- Supports clarifying questions with multi-select options
- Creates tasks with suggested titles, descriptions, labels, and priorities
- Uses `unstable_v2_createSession()` from the Claude Agent SDK
- Configurable model via `DEFAULT_TASK_CREATION_MODEL`

This is a separate service from the core `TaskService`.

---

## Error Conditions

| Error Code | HTTP | Condition |
|------------|------|-----------|
| `TASK_NOT_FOUND` | 404 | Task ID doesn't exist |
| `TASK_INVALID_TRANSITION` | 400 | Invalid column transition |
| `TASK_NOT_WAITING_APPROVAL` | 400 | Task not in waiting_approval |
| `TASK_NO_DIFF` | 400 | No worktree/changes to review |
| `TASK_ALREADY_APPROVED` | 400 | Task already approved |
| `TASK_AGENT_STOP_FAILED` | 500 | Failed to stop container agent |
| `PROJECT_NOT_FOUND` | 404 | Project not found |
| `VALIDATION_ERROR` | 400 | Invalid input (e.g., reason length) |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/task.service.ts` | Core task service with container agent integration |
| `src/services/task-creation.service.ts` | AI-powered task decomposition |
| `src/services/task-transitions.ts` | Column transition rules |
| `src/db/schema/sqlite/tasks.ts` | Task table schema |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | Task table definition |
| [Error Catalog](../errors/error-catalog.md) | TaskError types |
| [ProjectService](./project-service.md) | Tasks belong to projects |
| [AgentService](./agent-service.md) | Agents are assigned to tasks |
| [WorktreeService](./worktree-service.md) | Worktrees created for tasks |
| [ContainerAgentService](./container-agent-service.md) | Container agent triggering |
| [API Endpoints](../api/endpoints.md) | HTTP routes for task operations |
