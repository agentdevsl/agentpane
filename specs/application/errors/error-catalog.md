# Error Catalog Specification

## Overview

Comprehensive error definitions for AgentPane, including domain errors, HTTP status mappings, and UI error states.

---

## Error Architecture

### Result Type Pattern

All service methods return `Result<T, E>` instead of throwing exceptions:

```typescript
// lib/utils/result.ts
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### Error Base Type

```typescript
// lib/errors/base.ts
export interface AppError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export function createError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): AppError {
  return { code, message, status, details };
}
```

---

## Domain Error Codes

### Project Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `PROJECT_NOT_FOUND` | Project not found | 404 | Project ID doesn't exist |
| `PROJECT_PATH_EXISTS` | A project with this path already exists | 409 | Duplicate path on create |
| `PROJECT_PATH_INVALID` | Invalid project path | 400 | Path doesn't exist or isn't accessible |
| `PROJECT_HAS_RUNNING_AGENTS` | Cannot delete project with running agents | 409 | Delete with active agents |
| `PROJECT_CONFIG_INVALID` | Invalid project configuration | 400 | Config validation failed |

```typescript
// lib/errors/project-errors.ts
export const ProjectErrors = {
  NOT_FOUND: createError(
    'PROJECT_NOT_FOUND',
    'Project not found',
    404
  ),
  PATH_EXISTS: createError(
    'PROJECT_PATH_EXISTS',
    'A project with this path already exists',
    409
  ),
  PATH_INVALID: (path: string) => createError(
    'PROJECT_PATH_INVALID',
    `Invalid project path: ${path}`,
    400,
    { path }
  ),
  HAS_RUNNING_AGENTS: (count: number) => createError(
    'PROJECT_HAS_RUNNING_AGENTS',
    `Cannot delete project with ${count} running agent(s)`,
    409,
    { runningAgentCount: count }
  ),
  CONFIG_INVALID: (errors: string[]) => createError(
    'PROJECT_CONFIG_INVALID',
    'Invalid project configuration',
    400,
    { validationErrors: errors }
  ),
} as const;

export type ProjectError =
  | typeof ProjectErrors.NOT_FOUND
  | typeof ProjectErrors.PATH_EXISTS
  | ReturnType<typeof ProjectErrors.PATH_INVALID>
  | ReturnType<typeof ProjectErrors.HAS_RUNNING_AGENTS>
  | ReturnType<typeof ProjectErrors.CONFIG_INVALID>;
```

---

### Task Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `TASK_NOT_FOUND` | Task not found | 404 | Task ID doesn't exist |
| `TASK_NOT_IN_COLUMN` | Task is not in expected column | 400 | Invalid column transition |
| `TASK_ALREADY_ASSIGNED` | Task is already assigned to an agent | 409 | Assign to busy task |
| `TASK_NO_DIFF` | No changes to approve | 400 | Approve with empty diff |
| `TASK_ALREADY_APPROVED` | Task has already been approved | 409 | Double approval |
| `TASK_NOT_WAITING_APPROVAL` | Task is not waiting for approval | 400 | Approve wrong state |
| `TASK_INVALID_TRANSITION` | Invalid column transition | 400 | Disallowed state change |
| `TASK_POSITION_CONFLICT` | Position conflict in column | 409 | Concurrent position update |

```typescript
// lib/errors/task-errors.ts
export const TaskErrors = {
  NOT_FOUND: createError(
    'TASK_NOT_FOUND',
    'Task not found',
    404
  ),
  NOT_IN_COLUMN: (expected: string, actual: string) => createError(
    'TASK_NOT_IN_COLUMN',
    `Task is in "${actual}" but expected "${expected}"`,
    400,
    { expected, actual }
  ),
  ALREADY_ASSIGNED: (agentId: string) => createError(
    'TASK_ALREADY_ASSIGNED',
    'Task is already assigned to an agent',
    409,
    { agentId }
  ),
  NO_DIFF: createError(
    'TASK_NO_DIFF',
    'No changes to approve',
    400
  ),
  ALREADY_APPROVED: createError(
    'TASK_ALREADY_APPROVED',
    'Task has already been approved',
    409
  ),
  NOT_WAITING_APPROVAL: (currentColumn: string) => createError(
    'TASK_NOT_WAITING_APPROVAL',
    `Task is not waiting for approval (current: ${currentColumn})`,
    400,
    { currentColumn }
  ),
  INVALID_TRANSITION: (from: string, to: string) => createError(
    'TASK_INVALID_TRANSITION',
    `Cannot move task from "${from}" to "${to}"`,
    400,
    { from, to, allowedTransitions: getValidTransitions(from) }
  ),
  POSITION_CONFLICT: createError(
    'TASK_POSITION_CONFLICT',
    'Position conflict in column. Please refresh and try again.',
    409
  ),
} as const;

export type TaskError =
  | typeof TaskErrors.NOT_FOUND
  | ReturnType<typeof TaskErrors.NOT_IN_COLUMN>
  | ReturnType<typeof TaskErrors.ALREADY_ASSIGNED>
  | typeof TaskErrors.NO_DIFF
  | typeof TaskErrors.ALREADY_APPROVED
  | ReturnType<typeof TaskErrors.NOT_WAITING_APPROVAL>
  | ReturnType<typeof TaskErrors.INVALID_TRANSITION>
  | typeof TaskErrors.POSITION_CONFLICT;
```

---

### Agent Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `AGENT_NOT_FOUND` | Agent not found | 404 | Agent ID doesn't exist |
| `AGENT_ALREADY_RUNNING` | Agent is already running | 409 | Start running agent |
| `AGENT_NOT_RUNNING` | Agent is not running | 400 | Stop idle agent |
| `AGENT_TURN_LIMIT_EXCEEDED` | Agent exceeded maximum turn limit | 200* | maxTurns reached |
| `AGENT_NO_AVAILABLE_TASK` | No available tasks for agent | 400 | Start with no tasks |
| `AGENT_TOOL_NOT_ALLOWED` | Tool not allowed for this agent | 403 | Blocked tool call |
| `AGENT_EXECUTION_ERROR` | Agent execution failed | 500 | Runtime error |

*Note: `AGENT_TURN_LIMIT_EXCEEDED` returns 200 because it's an expected workflow outcome, not an error.

```typescript
// lib/errors/agent-errors.ts
export const AgentErrors = {
  NOT_FOUND: createError(
    'AGENT_NOT_FOUND',
    'Agent not found',
    404
  ),
  ALREADY_RUNNING: (taskId?: string) => createError(
    'AGENT_ALREADY_RUNNING',
    'Agent is already running',
    409,
    { currentTaskId: taskId }
  ),
  NOT_RUNNING: createError(
    'AGENT_NOT_RUNNING',
    'Agent is not running',
    400
  ),
  TURN_LIMIT_EXCEEDED: (turns: number, maxTurns: number) => createError(
    'AGENT_TURN_LIMIT_EXCEEDED',
    `Agent completed ${turns} turns (limit: ${maxTurns})`,
    200,
    { turns, maxTurns }
  ),
  NO_AVAILABLE_TASK: createError(
    'AGENT_NO_AVAILABLE_TASK',
    'No available tasks for agent',
    400
  ),
  TOOL_NOT_ALLOWED: (tool: string, allowed: string[]) => createError(
    'AGENT_TOOL_NOT_ALLOWED',
    `Tool "${tool}" is not allowed for this agent`,
    403,
    { tool, allowedTools: allowed }
  ),
  EXECUTION_ERROR: (error: string) => createError(
    'AGENT_EXECUTION_ERROR',
    `Agent execution failed: ${error}`,
    500,
    { error }
  ),
} as const;

export type AgentError =
  | typeof AgentErrors.NOT_FOUND
  | ReturnType<typeof AgentErrors.ALREADY_RUNNING>
  | typeof AgentErrors.NOT_RUNNING
  | ReturnType<typeof AgentErrors.TURN_LIMIT_EXCEEDED>
  | typeof AgentErrors.NO_AVAILABLE_TASK
  | ReturnType<typeof AgentErrors.TOOL_NOT_ALLOWED>
  | ReturnType<typeof AgentErrors.EXECUTION_ERROR>;
```

---

### Concurrency Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `CONCURRENCY_LIMIT_EXCEEDED` | Maximum concurrent agents reached | 429 | Start agent over limit |
| `QUEUE_FULL` | Task queue is full | 429 | Too many queued tasks |
| `RESOURCE_LOCKED` | Resource is locked by another operation | 423 | Concurrent modification |

```typescript
// lib/errors/concurrency-errors.ts
export const ConcurrencyErrors = {
  LIMIT_EXCEEDED: (current: number, max: number) => createError(
    'CONCURRENCY_LIMIT_EXCEEDED',
    `Maximum concurrent agents reached (${current}/${max})`,
    429,
    { currentAgents: current, maxAgents: max }
  ),
  QUEUE_FULL: (queueSize: number, maxSize: number) => createError(
    'QUEUE_FULL',
    `Task queue is full (${queueSize}/${maxSize})`,
    429,
    { queueSize, maxSize }
  ),
  RESOURCE_LOCKED: (resource: string, lockedBy: string) => createError(
    'RESOURCE_LOCKED',
    `Resource "${resource}" is locked by another operation`,
    423,
    { resource, lockedBy }
  ),
} as const;

export type ConcurrencyError =
  | ReturnType<typeof ConcurrencyErrors.LIMIT_EXCEEDED>
  | ReturnType<typeof ConcurrencyErrors.QUEUE_FULL>
  | ReturnType<typeof ConcurrencyErrors.RESOURCE_LOCKED>;
```

---

### Worktree Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `WORKTREE_CREATION_FAILED` | Failed to create worktree | 500 | git worktree add fails |
| `WORKTREE_NOT_FOUND` | Worktree not found | 404 | Worktree ID doesn't exist |
| `WORKTREE_BRANCH_EXISTS` | Branch already exists | 409 | Create with existing branch |
| `WORKTREE_MERGE_CONFLICT` | Merge conflict detected | 409 | Conflicts on merge |
| `WORKTREE_DIRTY` | Worktree has uncommitted changes | 400 | Merge dirty worktree |
| `WORKTREE_REMOVAL_FAILED` | Failed to remove worktree | 500 | git worktree remove fails |
| `WORKTREE_ENV_COPY_FAILED` | Failed to copy environment file | 500 | .env copy fails |
| `WORKTREE_INIT_SCRIPT_FAILED` | Init script failed | 500 | Post-setup script fails |

```typescript
// lib/errors/worktree-errors.ts
export const WorktreeErrors = {
  CREATION_FAILED: (branch: string, error: string) => createError(
    'WORKTREE_CREATION_FAILED',
    `Failed to create worktree for branch "${branch}"`,
    500,
    { branch, error }
  ),
  NOT_FOUND: createError(
    'WORKTREE_NOT_FOUND',
    'Worktree not found',
    404
  ),
  BRANCH_EXISTS: (branch: string) => createError(
    'WORKTREE_BRANCH_EXISTS',
    `Branch "${branch}" already exists`,
    409,
    { branch }
  ),
  MERGE_CONFLICT: (files: string[]) => createError(
    'WORKTREE_MERGE_CONFLICT',
    'Merge conflict detected',
    409,
    { conflictingFiles: files }
  ),
  DIRTY: (files: string[]) => createError(
    'WORKTREE_DIRTY',
    'Worktree has uncommitted changes',
    400,
    { uncommittedFiles: files }
  ),
  REMOVAL_FAILED: (path: string, error: string) => createError(
    'WORKTREE_REMOVAL_FAILED',
    `Failed to remove worktree at "${path}"`,
    500,
    { path, error }
  ),
  ENV_COPY_FAILED: (error: string) => createError(
    'WORKTREE_ENV_COPY_FAILED',
    'Failed to copy environment file',
    500,
    { error }
  ),
  INIT_SCRIPT_FAILED: (script: string, error: string) => createError(
    'WORKTREE_INIT_SCRIPT_FAILED',
    `Init script failed: ${script}`,
    500,
    { script, error }
  ),
} as const;

export type WorktreeError =
  | ReturnType<typeof WorktreeErrors.CREATION_FAILED>
  | typeof WorktreeErrors.NOT_FOUND
  | ReturnType<typeof WorktreeErrors.BRANCH_EXISTS>
  | ReturnType<typeof WorktreeErrors.MERGE_CONFLICT>
  | ReturnType<typeof WorktreeErrors.DIRTY>
  | ReturnType<typeof WorktreeErrors.REMOVAL_FAILED>
  | ReturnType<typeof WorktreeErrors.ENV_COPY_FAILED>
  | ReturnType<typeof WorktreeErrors.INIT_SCRIPT_FAILED>;
```

---

### Session Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `SESSION_NOT_FOUND` | Session not found | 404 | Session ID doesn't exist |
| `SESSION_CLOSED` | Session is closed | 400 | Write to closed session |
| `SESSION_CONNECTION_FAILED` | Failed to connect to session | 502 | WebSocket/SSE failure |
| `SESSION_SYNC_FAILED` | Session sync failed | 500 | Durable Streams error |

```typescript
// lib/errors/session-errors.ts
export const SessionErrors = {
  NOT_FOUND: createError(
    'SESSION_NOT_FOUND',
    'Session not found',
    404
  ),
  CLOSED: createError(
    'SESSION_CLOSED',
    'Session is closed',
    400
  ),
  CONNECTION_FAILED: (error: string) => createError(
    'SESSION_CONNECTION_FAILED',
    'Failed to connect to session',
    502,
    { error }
  ),
  SYNC_FAILED: (error: string) => createError(
    'SESSION_SYNC_FAILED',
    'Session sync failed',
    500,
    { error }
  ),
} as const;

export type SessionError =
  | typeof SessionErrors.NOT_FOUND
  | typeof SessionErrors.CLOSED
  | ReturnType<typeof SessionErrors.CONNECTION_FAILED>
  | ReturnType<typeof SessionErrors.SYNC_FAILED>;
```

---

### GitHub Integration Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `GITHUB_AUTH_FAILED` | GitHub authentication failed | 401 | OAuth/token failure |
| `GITHUB_INSTALLATION_NOT_FOUND` | GitHub App installation not found | 404 | Invalid installation ID |
| `GITHUB_REPO_NOT_FOUND` | Repository not found | 404 | Repo doesn't exist or no access |
| `GITHUB_CONFIG_NOT_FOUND` | Configuration not found in repository | 404 | Missing .claude/ |
| `GITHUB_CONFIG_INVALID` | Invalid configuration format | 400 | Config parse error |
| `GITHUB_WEBHOOK_INVALID` | Invalid webhook signature | 401 | Signature mismatch |
| `GITHUB_RATE_LIMITED` | GitHub API rate limit exceeded | 429 | Rate limit hit |
| `GITHUB_PR_CREATION_FAILED` | Failed to create pull request | 500 | PR API error |

```typescript
// lib/errors/github-errors.ts
export const GitHubErrors = {
  AUTH_FAILED: (error: string) => createError(
    'GITHUB_AUTH_FAILED',
    'GitHub authentication failed',
    401,
    { error }
  ),
  INSTALLATION_NOT_FOUND: (installationId: string) => createError(
    'GITHUB_INSTALLATION_NOT_FOUND',
    'GitHub App installation not found',
    404,
    { installationId }
  ),
  REPO_NOT_FOUND: (owner: string, repo: string) => createError(
    'GITHUB_REPO_NOT_FOUND',
    `Repository "${owner}/${repo}" not found`,
    404,
    { owner, repo }
  ),
  CONFIG_NOT_FOUND: (path: string) => createError(
    'GITHUB_CONFIG_NOT_FOUND',
    `Configuration not found at "${path}"`,
    404,
    { path }
  ),
  CONFIG_INVALID: (errors: string[]) => createError(
    'GITHUB_CONFIG_INVALID',
    'Invalid configuration format',
    400,
    { validationErrors: errors }
  ),
  WEBHOOK_INVALID: createError(
    'GITHUB_WEBHOOK_INVALID',
    'Invalid webhook signature',
    401
  ),
  RATE_LIMITED: (resetAt: number) => createError(
    'GITHUB_RATE_LIMITED',
    'GitHub API rate limit exceeded',
    429,
    { resetAt: new Date(resetAt * 1000).toISOString() }
  ),
  PR_CREATION_FAILED: (error: string) => createError(
    'GITHUB_PR_CREATION_FAILED',
    'Failed to create pull request',
    500,
    { error }
  ),
} as const;

export type GitHubError =
  | ReturnType<typeof GitHubErrors.AUTH_FAILED>
  | ReturnType<typeof GitHubErrors.INSTALLATION_NOT_FOUND>
  | ReturnType<typeof GitHubErrors.REPO_NOT_FOUND>
  | ReturnType<typeof GitHubErrors.CONFIG_NOT_FOUND>
  | ReturnType<typeof GitHubErrors.CONFIG_INVALID>
  | typeof GitHubErrors.WEBHOOK_INVALID
  | ReturnType<typeof GitHubErrors.RATE_LIMITED>
  | ReturnType<typeof GitHubErrors.PR_CREATION_FAILED>;
```

---

### Sandbox Worktree Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `SANDBOX_WORKTREE_CREATION_FAILED` | Failed to create worktree in sandbox | 500 | Host-side `git worktree add` fails during container agent startup |
| `SANDBOX_WORKTREE_COMMIT_FAILED` | Failed to commit worktree changes | 500 | Auto-commit of agent changes fails on completion/turn limit |

```typescript
// lib/errors/sandbox-errors.ts (subset)
export const SandboxErrors = {
  WORKTREE_CREATION_FAILED: (message: string) => createError(
    'SANDBOX_WORKTREE_CREATION_FAILED',
    `Failed to create worktree in sandbox: ${message}`,
    500
  ),
  WORKTREE_COMMIT_FAILED: (message: string) => createError(
    'SANDBOX_WORKTREE_COMMIT_FAILED',
    `Failed to commit worktree changes: ${message}`,
    500
  ),
} as const;
```

---

### Validation Errors

| Code | Message | HTTP Status | When |
|------|---------|-------------|------|
| `VALIDATION_ERROR` | Validation failed | 400 | Zod validation fails |
| `INVALID_ID` | Invalid ID format | 400 | Bad CUID2 format |
| `MISSING_REQUIRED_FIELD` | Missing required field | 400 | Required field absent |
| `INVALID_ENUM_VALUE` | Invalid enum value | 400 | Value not in enum |

```typescript
// lib/errors/validation-errors.ts
export const ValidationErrors = {
  VALIDATION_ERROR: (errors: z.ZodError['errors']) => createError(
    'VALIDATION_ERROR',
    'Validation failed',
    400,
    {
      errors: errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      }))
    }
  ),
  INVALID_ID: (field: string) => createError(
    'INVALID_ID',
    `Invalid ID format for "${field}"`,
    400,
    { field }
  ),
  MISSING_REQUIRED_FIELD: (field: string) => createError(
    'MISSING_REQUIRED_FIELD',
    `Missing required field: ${field}`,
    400,
    { field }
  ),
  INVALID_ENUM_VALUE: (field: string, value: string, allowed: string[]) => createError(
    'INVALID_ENUM_VALUE',
    `Invalid value "${value}" for "${field}"`,
    400,
    { field, value, allowedValues: allowed }
  ),
} as const;

export type ValidationError =
  | ReturnType<typeof ValidationErrors.VALIDATION_ERROR>
  | ReturnType<typeof ValidationErrors.INVALID_ID>
  | ReturnType<typeof ValidationErrors.MISSING_REQUIRED_FIELD>
  | ReturnType<typeof ValidationErrors.INVALID_ENUM_VALUE>;
```

---

## Additional Error Modules

The following error modules exist in `src/lib/errors/` and are fully integrated:

### AgentCore Errors (`agentcore-errors.ts`)

AWS/AgentCore streaming and API errors with Sentry-compatible IDs (AGENTCORE-001 through AGENTCORE-701).

| Code | HTTP Status | When |
|------|-------------|------|
| `AGENTCORE-001` | 401 | AWS credentials invalid |
| `AGENTCORE-002` | 401 | AWS credentials expired |
| `AGENTCORE-003` | 400 | Invalid AWS region |
| `AGENTCORE-004` | 503 | AWS STS error |
| `AGENTCORE-600` | 502 | Streaming error |
| `AGENTCORE-601` | 502 | Session creation failed |
| `AGENTCORE-602` | 502 | Invocation failed |
| `AGENTCORE-700` | varies | API error |
| `AGENTCORE-701` | 500 | Internal error |

### Marketplace Errors (`marketplace-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `MARKETPLACE_NOT_FOUND` | 404 | Marketplace not found |
| `MARKETPLACE_ALREADY_EXISTS` | 409 | Duplicate repository |
| `MARKETPLACE_INVALID_URL` | 400 | Invalid GitHub URL |
| `MARKETPLACE_MISSING_REPO_INFO` | 400 | Missing owner/repo |
| `MARKETPLACE_CANNOT_DELETE_DEFAULT` | 403 | Delete default marketplace |
| `MARKETPLACE_CANNOT_DISABLE_DEFAULT` | 403 | Disable default marketplace |
| `MARKETPLACE_SYNC_FAILED` | 500 | Sync failure |

### Plan Mode Errors (`plan-mode-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `PLAN_SESSION_NOT_FOUND` | 404 | Plan session not found |
| `PLAN_SESSION_ALREADY_ACTIVE` | 409 | Session already active |
| `PLAN_SESSION_COMPLETED` | 400 | Session already completed |
| `PLAN_SESSION_CANCELLED` | 400 | Session cancelled |
| `PLAN_INTERACTION_NOT_FOUND` | 404 | Interaction not found |
| `PLAN_INTERACTION_ALREADY_ANSWERED` | 400 | Already answered |
| `PLAN_NOT_WAITING_FOR_USER` | 400 | Not waiting for input |
| `PLAN_CREDENTIALS_NOT_FOUND` | 401 | OAuth credentials missing |
| `PLAN_CREDENTIALS_EXPIRED` | 401 | OAuth credentials expired |
| `PLAN_API_ERROR` | 500 | Claude API error |
| `PLAN_STREAM_ERROR` | 500 | Stream error |
| `PLAN_GITHUB_ERROR` | 500 | GitHub operation failed |
| `PLAN_TASK_NOT_FOUND` | 404 | Task not found |
| `PLAN_PROJECT_NOT_FOUND` | 404 | Project not found |
| `PLAN_INVALID_TURN_ROLE` | 400 | Invalid turn role |
| `PLAN_MAX_TURNS_EXCEEDED` | 400 | Max turns exceeded |
| `PLAN_PARSING_ERROR` | 500 | Response parsing failed |
| `PLAN_DATABASE_ERROR` | 500 | Database operation failed |
| `PLAN_TOOL_INPUT_PARSE_ERROR` | 500 | Tool input parsing failed |

### Sandbox Errors (`sandbox-errors.ts`)

Container lifecycle, execution, credentials, provider, and state management errors (30+ codes). See `src/lib/errors/sandbox-errors.ts` for the complete catalog.

### Terraform Errors (`terraform-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `TERRAFORM_REGISTRY_NOT_FOUND` | 404 | Registry not found |
| `TERRAFORM_MODULE_NOT_FOUND` | 404 | Module not found |
| `TERRAFORM_REGISTRY_ALREADY_EXISTS` | 409 | Duplicate registry |
| `TERRAFORM_INVALID_TOKEN` | 401 | Invalid API token |
| `TERRAFORM_NO_MODULES_SYNCED` | 404 | No modules in registry |
| `TERRAFORM_SYNC_FAILED` | 500 | Registry sync failed |
| `TERRAFORM_REGISTRY_CREATE_FAILED` | 500 | Registry creation failed |
| `TERRAFORM_COMPOSE_FAILED` | 500 | Compose generation failed |

### Sandbox Config Errors (`sandbox-config-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `SANDBOX_CONFIG_NOT_FOUND` | 404 | Config not found |
| `SANDBOX_CONFIG_ALREADY_EXISTS` | 409 | Duplicate name |
| `SANDBOX_CONFIG_IN_USE` | 409 | Config in use by projects |
| `SANDBOX_CONFIG_INVALID_MEMORY` | 400 | Invalid memory value |
| `SANDBOX_CONFIG_INVALID_CPU` | 400 | Invalid CPU value |
| `SANDBOX_CONFIG_INVALID_PROCESSES` | 400 | Invalid max processes |
| `SANDBOX_CONFIG_INVALID_TIMEOUT` | 400 | Invalid timeout |
| `SANDBOX_CONFIG_DEFAULT_EXISTS` | 409 | Default config exists |

### Git Errors (`git-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `GIT_PROJECT_NOT_FOUND` | 404 | Project not found |
| `GIT_INVALID_BRANCH` | 400 | Invalid branch name |
| `GIT_COMMAND_FAILED` | 500 | Git command failed |
| `GIT_DATABASE_ERROR` | 500 | Database error |

### Event/Schedule Errors (`event-errors.ts`)

Event source, subscription, webhook, and schedule errors (19 codes). See `src/lib/errors/event-errors.ts`.

### Kubernetes Errors (`k8s-errors.ts`)

K8s cluster, pod, exec, image, tmux, network policy, RBAC, and warm pool errors (30+ codes with Sentry IDs K8S-001 through K8S-1105). See `src/lib/errors/k8s-errors.ts`.

### Nomad Errors (`nomad-errors.ts`)

Nomad cluster, job, exec, tmux, and API errors (18 codes with Sentry IDs NOMAD-001 through NOMAD-701). See `src/lib/errors/nomad-errors.ts`.

### Workflow Errors (`workflow-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `WORKFLOW_NOT_FOUND` | 404 | Workflow not found |
| `WORKFLOW_CREATE_FAILED` | 500 | Creation failed |
| `WORKFLOW_UPDATE_FAILED` | 500 | Update failed |
| `WORKFLOW_DATABASE_ERROR` | 500 | Database error |

### Template Errors (`template-errors.ts`)

| Code | HTTP Status | When |
|------|-------------|------|
| `TEMPLATE_NOT_FOUND` | 404 | Template not found |
| `TEMPLATE_ALREADY_EXISTS` | 409 | Duplicate repository |
| `TEMPLATE_INVALID_REPO_URL` | 400 | Invalid GitHub URL |
| `TEMPLATE_SYNC_FAILED` | 500 | Sync failed |
| `TEMPLATE_FETCH_FAILED` | 500 | Fetch failed |
| `TEMPLATE_PARSE_FAILED` | 400 | Parse failed |
| `TEMPLATE_PROJECT_REQUIRED` | 400 | Project ID required |
| `TEMPLATE_INVALID_SCOPE` | 400 | Invalid scope |

---

## UI Error State Mapping

Map error codes to wireframe components:

### Empty States

| Wireframe | Component | Trigger |
|-----------|-----------|---------|
| `empty-states.html` | EmptyProjectState | No projects exist |
| `empty-states.html` | EmptyTaskState | Project has no tasks |
| `empty-states.html` | EmptyAgentState | Project has no agents |
| `empty-states.html` | EmptySessionState | No active sessions |

### Error States

| Wireframe | Component | Error Codes |
|-----------|-----------|-------------|
| `error-state-expanded.html` | AgentErrorState | `AGENT_EXECUTION_ERROR`, `AGENT_TURN_LIMIT_EXCEEDED` |
| `error-state-expanded.html` | WorktreeErrorState | `WORKTREE_*` errors |
| `error-state-expanded.html` | ConnectionErrorState | `SESSION_CONNECTION_FAILED`, `SESSION_SYNC_FAILED` |
| `github-app-setup.html` | GitHubDisconnectedState | Initial setup, OAuth required |
| `github-app-setup.html` | GitHubOAuthFlowState | OAuth in progress, installation selection |
| `github-app-setup.html` | GitHubConnectedState | Management view, permissions, disconnect |
| `error-state-expanded.html` | GitHubErrorState | `GITHUB_*` errors |

### Loading/Progress States

| Wireframe | Component | When |
|-----------|-----------|------|
| `loading-states.html` | AgentStartingState | Agent `status === 'starting'` |
| `loading-states.html` | WorktreeCreatingState | Worktree `status === 'creating'` |
| `loading-states.html` | SyncingState | Session reconnecting |

---

## Error Response Format

### API Response Structure

```typescript
// Successful response
{
  "ok": true,
  "data": { ... }
}

// Error response
{
  "ok": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found",
    "status": 404,
    "details": { ... }
  }
}
```

### Route Catch Block Pattern (Structured Error Exposure)

Route catch blocks use `createLogger` for structured logging that preserves service error codes.
The pattern is:

```typescript
// Each route file creates a logger at module scope:
const logger = createLogger('routes:tasks');

// In catch blocks, use logger.error which serializes the error as structured JSON:
} catch (error) {
  logger.error('Create error', { error });
  return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to create task' } }, 500);
}
```

This ensures:
- Service error codes (e.g., `TASK_NOT_FOUND`) are preserved in structured logs
- Error stacks are captured for debugging
- Request IDs are automatically attached via `getRequestId()`
- Production logs are JSON for log aggregation tools

### API Error Handler

```typescript
// app/routes/api/_middleware.ts
import type { AppError } from '@/lib/errors/base';

export function handleApiError(error: AppError): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    },
    { status: error.status }
  );
}

// Usage in route
export const ServerRoute = createServerFileRoute().methods({
  GET: async ({ request }) => {
    const result = await taskService.getById(id);

    if (!result.ok) {
      return handleApiError(result.error);
    }

    return Response.json({ ok: true, data: result.value });
  },
});
```

---

## Client-Side Error Handling

### Error Boundary Component

```typescript
// app/components/error-boundary.tsx
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}
```

### useApiError Hook

```typescript
// lib/hooks/use-api-error.ts
import { useState, useCallback } from 'react';
import type { AppError } from '@/lib/errors/base';

export function useApiError() {
  const [error, setError] = useState<AppError | null>(null);

  const handleError = useCallback((err: unknown) => {
    if (isAppError(err)) {
      setError(err);
    } else if (err instanceof Error) {
      setError({
        code: 'UNKNOWN_ERROR',
        message: err.message,
        status: 500,
      });
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, handleError, clearError };
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    'status' in err
  );
}
```

---

## Error Code Index

Quick reference for all error codes:

```typescript
// lib/errors/index.ts -- exports all 21 error modules
// See the actual file for the complete list of exports.
// Total error codes: 140+ across all modules.
```

> **Note**: The `workflow-status.ts` file referenced in earlier versions of this spec does not exist.
> Workflow status codes (`APPROVAL_REQUIRED`, `AGENT_PAUSED`, `TASK_QUEUED`) are handled
> inline in route handlers, not as a separate error module.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](../api/endpoints.md) | Uses errors in response bodies |
| [Service Layer](../services/) | Returns Result types with these errors |
| [State Machines](../state-machines/) | Transition guards return these errors |
| [Database Schema](../database/schema.md) | Database constraints map to errors |
| [Test Cases](../testing/test-cases.md) | Tests verify error conditions |
