# Database Schema Specification

## Overview

Complete Drizzle ORM schemas for AgentPane using better-sqlite3 (SQLite) as the primary database. The project also supports PostgreSQL as a secondary option via a parallel schema directory (`src/db/schema/postgres/`).

All tables use `sqliteTable` from `drizzle-orm/sqlite-core`. Enums are implemented as `const` arrays with TypeScript type inference (SQLite has no native enum support). JSON columns use `text({ mode: 'json' })`. Timestamps are stored as ISO datetime text strings using `(datetime('now'))` defaults.

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| better-sqlite3 | 12.6.2 | Embedded SQLite database |
| Drizzle ORM | 0.45.1 | Type-safe SQL query builder |
| drizzle-kit | 0.31.8 | Migration generation and studio |
| @paralleldrive/cuid2 | 3.0.6 | Collision-resistant IDs |
| Zod | 4.3.6 | Runtime validation |

---

## Schema Files Structure

```
src/db/schema/
├── shared/                        # Shared between SQLite and PostgreSQL
│   ├── enums.ts                   # Const array enums with type inference
│   ├── types.ts                   # ProjectConfig, AgentConfig, SandboxStatus types
│   └── cron-config.ts             # CronBudgetConfig, CronEventSourceConfig interfaces
│
├── sqlite/                        # Primary SQLite schema (38 files)
│   ├── index.ts                   # Re-exports all schemas and enums
│   ├── relations.ts               # Drizzle ORM relation definitions
│   │
│   │  # Core
│   ├── projects.ts                # Project configuration
│   ├── tasks.ts                   # Kanban tasks
│   ├── agents.ts                  # Agent definitions
│   ├── agent-runs.ts              # Execution history
│   ├── sessions.ts                # Agent session metadata
│   ├── session-events.ts          # Durable stream events
│   ├── session-summaries.ts       # Session metrics/cost summaries
│   ├── worktrees.ts               # Git worktree tracking
│   ├── plan-sessions.ts           # Multi-turn planning conversations
│   ├── audit-logs.ts              # Tool call audit trail
│   ├── settings.ts                # Key-value settings store
│   ├── cli-sessions.ts            # CLI monitor session tracking
│   │
│   │  # Auth / RBAC
│   ├── users.ts                   # GitHub OAuth users
│   ├── user-sessions.ts           # Authentication sessions
│   ├── teams.ts                   # Team organizations
│   ├── team-members.ts            # Team membership (junction)
│   ├── team-projects.ts           # Team-project associations (junction)
│   ├── team-invitations.ts        # Team invitation tokens
│   ├── project-members.ts         # Project-level access (junction)
│   │
│   │  # Tags
│   ├── tags.ts                    # Tag definitions (team-scoped)
│   ├── project-tags.ts            # Project-tag associations (junction)
│   ├── task-tags.ts               # Task-tag associations (junction)
│   │
│   │  # Sandbox
│   ├── sandbox-configs.ts         # Sandbox configuration presets
│   ├── sandboxes.ts               # Sandbox instances + tmux sessions
│   │
│   │  # Templates
│   ├── templates.ts               # Template definitions
│   ├── template-projects.ts       # Template-project associations (junction)
│   │
│   │  # GitHub
│   ├── github.ts                  # GitHub tokens, installations, repo configs
│   │
│   │  # Events
│   ├── event-sources.ts           # Webhook/cron event sources
│   ├── event-subscriptions.ts     # Event routing subscriptions
│   ├── event-log.ts               # Inbound event log
│   ├── schedule-executions.ts     # Cron execution history
│   │
│   │  # Terraform
│   ├── terraform.ts               # Terraform registries and modules
│   │
│   │  # API
│   ├── api-keys.ts                # Encrypted service API keys
│   ├── api-tokens.ts              # User-scoped API tokens
│   │
│   │  # Other
│   ├── marketplaces.ts            # Plugin marketplace registries
│   └── workflows.ts               # Visual workflow definitions
│
└── postgres/                      # Secondary PostgreSQL schema (parallel structure)
```

---

## Enums (Const Arrays)

SQLite has no native enum support. Enums are defined as `const` arrays in `src/db/schema/shared/enums.ts` with inferred union types. Validation is performed at the application level.

```typescript
// src/db/schema/shared/enums.ts

export const TASK_COLUMNS = ['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

export const AGENT_STATUS = ['idle', 'starting', 'planning', 'running', 'paused', 'error', 'completed'] as const;
export type AgentStatus = (typeof AGENT_STATUS)[number];

export const AGENT_TYPES = ['task', 'conversational', 'background'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const WORKTREE_STATUS = ['creating', 'active', 'merging', 'removing', 'removed', 'error'] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUS)[number];

export const TOOL_STATUS = ['pending', 'running', 'complete', 'error'] as const;
export type ToolStatus = (typeof TOOL_STATUS)[number];

export const SESSION_STATUS = ['idle', 'initializing', 'active', 'paused', 'closing', 'closed', 'error'] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const SANDBOX_TYPES = ['docker', 'devcontainer', 'kubernetes', 'nomad', 'agentcore'] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];

export const RBAC_ROLES = ['owner', 'admin', 'agent_operator', 'viewer'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

export const INVITATION_STATUS = ['pending', 'accepted', 'declined', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];

export const API_TOKEN_STATUS = ['active', 'revoked', 'expired'] as const;
export type ApiTokenStatus = (typeof API_TOKEN_STATUS)[number];

export const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook', 'cron'] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

export const EVENT_SOURCE_STATUS = ['active', 'error', 'disabled'] as const;
export type EventSourceStatus = (typeof EVENT_SOURCE_STATUS)[number];

export const EVENT_LOG_STATUS = ['received', 'matched', 'task_created', 'ignored', 'error'] as const;
export type EventLogStatus = (typeof EVENT_LOG_STATUS)[number];

export const SCHEDULE_EXECUTION_STATUS = ['executed', 'skipped_budget', 'skipped_disabled', 'error'] as const;
export type ScheduleExecutionStatus = (typeof SCHEDULE_EXECUTION_STATUS)[number];

export const BUDGET_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
```

RBAC roles have numeric levels for hierarchy comparison via `RBAC_ROLE_LEVEL`: owner=4, admin=3, agent_operator=2, viewer=1. Helper functions `isValidRbacRole()` and `resolveHighestRole()` are also exported.

---

## Shared Types

```typescript
// src/db/schema/shared/types.ts

export type ProjectConfig = {
  worktreeRoot: string;
  initScript?: string;
  envFile?: string;
  defaultBranch: string;
  allowedTools: string[];
  maxTurns: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  envVars?: Record<string, string>;
  sandbox?: ProjectSandboxConfig | null;
};

export type AgentConfig = {
  allowedTools: string[];
  maxTurns: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
};

export type SandboxStatus = 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

export interface VolumeMountRecord {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}
```

---

## Core Tables

### projects

```typescript
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: text('config', { mode: 'json' }).$type<ProjectConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  githubInstallationId: text('github_installation_id').references(() => githubInstallations.id),
  sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id),
  configPath: text('config_path').default('.claude'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | text | PK, cuid2 | |
| name | text | NOT NULL | |
| path | text | NOT NULL, UNIQUE | Filesystem path, e.g. ~/git/my-project |
| description | text | | |
| config | text (json) | | `ProjectConfig` shape |
| maxConcurrentAgents | integer | default 3 | |
| githubOwner | text | | |
| githubRepo | text | | |
| githubInstallationId | text | FK -> github_installations.id | |
| sandboxConfigId | text | FK -> sandbox_configs.id | |
| configPath | text | default '.claude' | |
| createdAt | text | NOT NULL, default now | |
| updatedAt | text | NOT NULL, default now | |

---

### tasks

```typescript
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  worktreeId: text('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
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
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  lastAgentStatus: text('last_agent_status').$type<'completed' | 'cancelled' | 'error' | 'turn_limit' | 'planning'>(),
});
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | text | PK, cuid2 | |
| projectId | text | NOT NULL, FK cascade | |
| agentId | text | FK set null | Currently assigned agent |
| sessionId | text | FK set null | Active session |
| worktreeId | text | FK set null | Active worktree |
| title | text | NOT NULL | |
| description | text | | |
| column | text | NOT NULL, default 'backlog' | TaskColumn enum |
| position | integer | NOT NULL, default 0 | Order within column |
| labels | text (json) | default [] | string array |
| priority | text | default 'medium' | TaskPriority enum |
| branch | text | | Git branch name |
| diffSummary | text (json) | | DiffSummary object |
| approvedAt | text | | |
| approvedBy | text | | |
| rejectionCount | integer | default 0 | |
| rejectionReason | text | | |
| modelOverride | text | | Model short ID override |
| planOptions | text (json) | | StoredPlanOptions (ExitPlanModeOptions + SDK context) |
| plan | text | | Generated plan content |
| createdAt | text | NOT NULL, default now | |
| updatedAt | text | NOT NULL, default now | |
| startedAt | text | | |
| completedAt | text | | |
| lastAgentStatus | text | | 'completed'\|'cancelled'\|'error'\|'turn_limit'\|'planning' |

---

### agents

```typescript
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<AgentType>().default('task').notNull(),
  status: text('status').$type<AgentStatus>().default('idle').notNull(),
  config: text('config', { mode: 'json' }).$type<AgentConfig>(),
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentTurn: integer('current_turn').default(0),
  parentAgentId: text('parent_agent_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | text | PK, cuid2 | |
| projectId | text | NOT NULL, FK cascade | |
| name | text | NOT NULL | |
| type | text | NOT NULL, default 'task' | AgentType enum |
| status | text | NOT NULL, default 'idle' | AgentStatus enum |
| config | text (json) | | AgentConfig shape |
| currentTaskId | text | | Currently assigned task |
| currentSessionId | text | | Active session |
| currentTurn | integer | default 0 | Current turn counter |
| parentAgentId | text | | For team sub-agents |
| createdAt | text | NOT NULL, default now | |
| updatedAt | text | NOT NULL, default now | |

---

### agent_runs

```typescript
export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  status: text('status').$type<AgentStatus>().notNull(),
  startedAt: text('started_at').default(sql`(datetime('now'))`).notNull(),
  completedAt: text('completed_at'),
  turnsUsed: integer('turns_used').default(0),
  tokensUsed: integer('tokens_used').default(0),
  errorMessage: text('error_message'),
});
```

---

### sessions

```typescript
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  status: text('status').$type<SessionStatus>().default('idle').notNull(),
  title: text('title'),
  url: text('url').notNull(),
  sandboxProvider: text('sandbox_provider'),
  sandboxContainerId: text('sandbox_container_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
  closedAt: text('closed_at'),
});
```

---

### session_events

```typescript
export const sessionEvents = sqliteTable('session_events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  offset: integer('offset').notNull(),
  type: text('type').notNull(),        // chunk, tool:start, tool:result, etc.
  channel: text('channel').notNull(),  // chunks, toolCalls, terminal, presence
  data: text('data', { mode: 'json' }).notNull(),
  timestamp: integer('timestamp').notNull(),
  userId: text('user_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index('session_events_session_idx').on(table.sessionId),
  index('session_events_offset_idx').on(table.sessionId, table.offset),
  uniqueIndex('session_events_unique_offset').on(table.sessionId, table.offset),
]);
```

---

### session_summaries

```typescript
export const sessionSummaries = sqliteTable('session_summaries', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  sessionId: text('session_id').notNull().unique().references(() => sessions.id, { onDelete: 'cascade' }),
  durationMs: integer('duration_ms'),
  turnsCount: integer('turns_count').default(0),
  tokensUsed: integer('tokens_used').default(0),
  filesModified: integer('files_modified').default(0),
  linesAdded: integer('lines_added').default(0),
  linesRemoved: integer('lines_removed').default(0),
  finalStatus: text('final_status').$type<'success' | 'failed' | 'cancelled'>(),
  costUsd: real('cost_usd'),
  durationApiMs: integer('duration_api_ms'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheCreationTokens: integer('cache_creation_tokens'),
  stopReason: text('stop_reason'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### worktrees

```typescript
export const worktrees = sqliteTable('worktrees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
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

---

### plan_sessions

```typescript
export const planSessions = sqliteTable('plan_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').$type<PlanSessionStatus>().default('active').notNull(),
  turns: text('turns', { mode: 'json' }).$type<PlanTurnRecord[]>().default([]),
  githubIssueUrl: text('github_issue_url'),
  githubIssueNumber: integer('github_issue_number'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

`PlanSessionStatus`: `'active' | 'waiting_user' | 'completed' | 'cancelled'`

`PlanTurnRecord` stores role, content, optional interaction (questions with options), and timestamps.

---

### audit_logs

```typescript
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  status: text('status').$type<ToolStatus>().notNull(),
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  turnNumber: integer('turn_number'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### settings

```typescript
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

Key-value store for user preferences. Keys follow dot notation (e.g., `'taskCreation.model'`, `'taskCreation.tools'`). Values are JSON-encoded strings.

---

### cli_sessions

```typescript
export const cliSessions = sqliteTable('cli_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  sessionId: text('session_id').notNull().unique(),
  filePath: text('file_path').notNull(),
  cwd: text('cwd').notNull(),
  projectName: text('project_name').notNull(),
  projectHash: text('project_hash').notNull(),
  gitBranch: text('git_branch'),
  status: text('status').$type<CliSessionStatus>().notNull().default('idle'),
  messageCount: integer('message_count').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  goal: text('goal'),
  recentOutput: text('recent_output'),
  pendingToolUse: text('pending_tool_use'),      // JSON string
  tokenUsage: text('token_usage'),               // JSON string
  performanceMetrics: text('performance_metrics'), // JSON string
  model: text('model'),
  startedAt: integer('started_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  isSubagent: integer('is_subagent', { mode: 'boolean' }).notNull().default(false),
  parentSessionId: text('parent_session_id'),
  slug: text('slug'),
  cliVersion: text('cli_version'),
  permissionMode: text('permission_mode'),
  topology: text('topology'),                    // JSON string
  queueOperations: text('queue_operations'),     // JSON string
  toolInvocations: text('tool_invocations'),     // JSON string
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index('idx_cli_sessions_project').on(table.projectHash, table.lastActivityAt),
  index('idx_cli_sessions_status').on(table.status),
  index('idx_cli_sessions_last_activity').on(table.lastActivityAt),
]);
```

Note: `startedAt` and `lastActivityAt` use integer timestamps (Unix epoch), unlike most other tables which use text datetimes.

---

## Auth / RBAC Tables

### users

```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  githubId: integer('github_id').notNull().unique(),
  githubLogin: text('github_login').notNull(),
  name: text('name'),
  email: text('email'),
  githubEmail: text('github_email'),  // Immutable, from OAuth, used for invitation verification
  avatarUrl: text('avatar_url'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### user_sessions

```typescript
export const userSessions = sqliteTable('user_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### teams

```typescript
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### team_members (junction)

```typescript
export const teamMembers = sqliteTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<RbacRole>().default('viewer').notNull(),
  joinedAt: text('joined_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.userId] }),
]);
```

---

### team_projects (junction)

```typescript
export const teamProjects = sqliteTable('team_projects', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.projectId] }),
]);
```

---

### team_invitations

```typescript
export const teamInvitations = sqliteTable('team_invitations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  invitedBy: text('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').$type<RbacRole>().default('viewer').notNull(),
  token: text('token').notNull().unique(),
  status: text('status').$type<InvitationStatus>().default('pending').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### project_members (junction)

```typescript
export const projectMembers = sqliteTable('project_members', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<RbacRole>().notNull(),
  grantedByTeamId: text('granted_by_team_id').references(() => teams.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId] }),
]);
```

---

## Tags Tables

### tags

```typescript
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#6B7280'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  uniqueIndex('tags_team_name_unique').on(table.teamId, table.name),
]);
```

---

### project_tags (junction)

```typescript
export const projectTags = sqliteTable('project_tags', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.tagId] }),
]);
```

---

### task_tags (junction)

```typescript
export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.tagId] }),
]);
```

---

## Sandbox Tables

### sandbox_configs

```typescript
export const sandboxConfigs = sqliteTable('sandbox_configs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type', { enum: SANDBOX_TYPES }).notNull().default('docker'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  baseImage: text('base_image').notNull().default('node:22-slim'),
  memoryMb: integer('memory_mb').notNull().default(4096),
  cpuCores: real('cpu_cores').notNull().default(2.0),
  maxProcesses: integer('max_processes').notNull().default(256),
  timeoutMinutes: integer('timeout_minutes').notNull().default(60),
  volumeMountPath: text('volume_mount_path'),
  // Kubernetes-specific
  kubeConfigPath: text('kube_config_path'),
  kubeContext: text('kube_context'),
  kubeNamespace: text('kube_namespace').default('agentpane-sandboxes'),
  networkPolicyEnabled: integer('network_policy_enabled', { mode: 'boolean' }).default(true),
  allowedEgressHosts: text('allowed_egress_hosts', { mode: 'json' }).$type<string[]>(),
  // Nomad-specific
  nomadAddress: text('nomad_address'),
  nomadToken: text('nomad_token'),
  nomadNamespace: text('nomad_namespace').default('default'),
  nomadDatacenter: text('nomad_datacenter'),
  nomadRegion: text('nomad_region'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### sandbox_instances

```typescript
export const sandboxInstances = sqliteTable('sandbox_instances', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  containerId: text('container_id').notNull(),
  status: text('status').$type<SandboxStatus>().default('stopped').notNull(),
  image: text('image').notNull(),
  memoryMb: integer('memory_mb').notNull(),
  cpuCores: integer('cpu_cores').notNull(),
  idleTimeoutMinutes: integer('idle_timeout_minutes').notNull(),
  volumeMounts: text('volume_mounts', { mode: 'json' }).$type<VolumeMountRecord[]>().default([]),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  errorMessage: text('error_message'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  lastActivityAt: text('last_activity_at').default(sql`(datetime('now'))`).notNull(),
  stoppedAt: text('stopped_at'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

One sandbox instance per project (enforced by unique constraint on `projectId`).

---

### sandbox_tmux_sessions

```typescript
export const sandboxTmuxSessions = sqliteTable('sandbox_tmux_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  sandboxId: text('sandbox_id').notNull().references(() => sandboxInstances.id, { onDelete: 'cascade' }),
  sessionName: text('session_name').notNull(),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  windowCount: integer('window_count').default(1).notNull(),
  attached: integer('attached', { mode: 'boolean' }).default(false).notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  lastActivityAt: text('last_activity_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  unique('sandbox_session_unique').on(table.sandboxId, table.sessionName),
]);
```

---

## Template Tables

### templates

```typescript
export const templates = sqliteTable('templates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  scope: text('scope').notNull().$type<TemplateScope>(),       // 'org' | 'project'
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  configPath: text('config_path').default('.claude'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').default('active').$type<TemplateStatus>(),  // 'active'|'syncing'|'error'|'disabled'
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),
  syncIntervalMinutes: integer('sync_interval_minutes'),
  nextSyncAt: text('next_sync_at'),
  cachedSkills: text('cached_skills', { mode: 'json' }).$type<CachedSkill[]>(),
  cachedCommands: text('cached_commands', { mode: 'json' }).$type<CachedCommand[]>(),
  cachedAgents: text('cached_agents', { mode: 'json' }).$type<CachedAgent[]>(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### template_projects (junction)

```typescript
export const templateProjects = sqliteTable('template_projects', {
  templateId: text('template_id').notNull().references(() => templates.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.templateId, table.projectId] }),
]);
```

---

## GitHub Tables

### github_tokens

```typescript
export const githubTokens = sqliteTable('github_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  encryptedToken: text('encrypted_token').notNull(),
  tokenType: text('token_type').notNull().default('pat'),  // 'pat' | 'oauth'
  scopes: text('scopes'),                                   // Comma-separated
  githubLogin: text('github_login'),
  githubId: text('github_id'),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

Tokens are encrypted using AES-GCM before storage. `encryptedToken` is base64-encoded.

---

### github_installations

```typescript
export const githubInstallations = sqliteTable('github_installations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

### repository_configs

```typescript
export const repositoryConfigs = sqliteTable('repository_configs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  syncedAt: text('synced_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

## Event System Tables

### event_sources

```typescript
export const eventSources = sqliteTable('event_sources', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<EventSourceType>().notNull(),
  slug: text('slug').notNull().unique(),
  webhookSecret: text('webhook_secret'),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  eventCount: integer('event_count').default(0).notNull(),
  lastEventAt: text('last_event_at'),
  status: text('status').$type<EventSourceStatus>().default('active').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index('event_sources_team_idx').on(table.teamId),
  uniqueIndex('event_sources_slug_idx').on(table.slug),
]);
```

For cron-type sources, `config` stores `CronEventSourceConfig` with schedule settings, budget limits, and execution state.

---

### event_subscriptions

```typescript
export const eventSubscriptions = sqliteTable('event_subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  eventSourceId: text('event_source_id').notNull().references(() => eventSources.id, { onDelete: 'cascade' }),
  targetProjectId: text('target_project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),
  eventTypes: text('event_types', { mode: 'json' }).$type<string[]>().default([]),
  filters: text('filters', { mode: 'json' }).$type<SubscriptionFilter[]>().default([]),
  promptTemplate: text('prompt_template').notNull(),
  autoStartAgent: integer('auto_start_agent', { mode: 'boolean' }).default(false).notNull(),
  taskColumn: text('task_column').$type<TaskColumn>().default('backlog').notNull(),
  taskPriority: text('task_priority').$type<TaskPriority>().default('medium').notNull(),
  taskLabels: text('task_labels', { mode: 'json' }).$type<string[]>().default([]),
  matchedCount: integer('matched_count').default(0).notNull(),
  lastMatchedAt: text('last_matched_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index('event_subscriptions_source_idx').on(table.eventSourceId),
  index('event_subscriptions_project_idx').on(table.targetProjectId),
  index('event_subscriptions_source_enabled_idx').on(table.eventSourceId, table.isEnabled),
]);
```

---

### event_log

```typescript
export const eventLog = sqliteTable('event_log', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventSourceId: text('event_source_id').references(() => eventSources.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  action: text('action'),
  status: text('status').$type<EventLogStatus>().default('received').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  matchedSubscriptions: text('matched_subscriptions', { mode: 'json' })
    .$type<Array<{ subscriptionId: string; taskId?: string }>>().default([]),
  error: text('error'),
  deliveryId: text('delivery_id').notNull(),
  receivedAt: text('received_at').default(sql`(datetime('now'))`).notNull(),
  processedAt: text('processed_at'),
}, (table) => [
  index('event_log_source_idx').on(table.eventSourceId),
  index('event_log_received_at_idx').on(table.receivedAt),
  index('event_log_source_status_idx').on(table.eventSourceId, table.status),
  uniqueIndex('event_log_delivery_idx').on(table.eventSourceId, table.deliveryId),
]);
```

---

### schedule_executions

```typescript
export const scheduleExecutions = sqliteTable('schedule_executions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventSourceId: text('event_source_id').notNull().references(() => eventSources.id, { onDelete: 'cascade' }),
  status: text('status').$type<ScheduleExecutionStatus>().notNull(),
  scheduledAt: text('scheduled_at').notNull(),
  executedAt: text('executed_at').notNull(),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  subscriptionId: text('subscription_id').references(() => eventSubscriptions.id, { onDelete: 'set null' }),
  budgetWindow: text('budget_window').$type<BudgetWindow>(),
  windowExecutionCount: integer('window_execution_count').default(0).notNull(),
  error: text('error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index('schedule_executions_event_source_idx').on(table.eventSourceId),
  index('schedule_executions_source_status_idx').on(table.eventSourceId, table.status),
  index('schedule_executions_source_executed_at_idx').on(table.eventSourceId, table.executedAt),
  index('schedule_executions_source_scheduled_at_idx').on(table.eventSourceId, table.scheduledAt),
]);
```

---

## Terraform Tables

### terraform_registries

```typescript
export const terraformRegistries = sqliteTable('terraform_registries', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  orgName: text('org_name').notNull(),
  tokenSettingKey: text('token_setting_key').notNull(),
  status: text('status').notNull().default('active').$type<TerraformRegistryStatus>(),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),
  moduleCount: integer('module_count').default(0),
  syncIntervalMinutes: integer('sync_interval_minutes'),
  nextSyncAt: text('next_sync_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

`TerraformRegistryStatus`: `'active' | 'syncing' | 'error'`

---

### terraform_modules

```typescript
export const terraformModules = sqliteTable('terraform_modules', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  registryId: text('registry_id').notNull(),
  name: text('name').notNull(),
  namespace: text('namespace').notNull(),
  provider: text('provider').notNull(),
  version: text('version').notNull(),
  source: text('source').notNull(),
  description: text('description'),
  readme: text('readme'),
  inputs: text('inputs', { mode: 'json' }).$type<TerraformVariable[]>(),
  outputs: text('outputs', { mode: 'json' }).$type<TerraformOutput[]>(),
  dependencies: text('dependencies', { mode: 'json' }).$type<string[]>(),
  publishedAt: text('published_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

## API Tables

### api_keys

```typescript
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  service: text('service').notNull().unique(),
  encryptedKey: text('encrypted_key').notNull(),
  maskedKey: text('masked_key').notNull(),      // e.g. "sk-ant-...abc123"
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

Stores encrypted API keys for external services (e.g., 'anthropic', 'openai'). Encrypted with AES-GCM, stored as base64.

---

### api_tokens

```typescript
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  role: text('role').$type<RbacRole>().notNull(),
  scopeTags: text('scope_tags', { mode: 'json' }).$type<string[] | null>(),
  scopeProjectId: text('scope_project_id').references(() => projects.id, { onDelete: 'set null' }),
  status: text('status').$type<ApiTokenStatus>().default('active').notNull(),
  expiresAt: text('expires_at'),
  useCount: integer('use_count').default(0),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});
```

---

## Other Tables

### marketplaces

```typescript
export const marketplaces = sqliteTable('marketplaces', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  pluginsPath: text('plugins_path').default('plugins'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true),
  status: text('status').default('active').$type<MarketplaceStatus>(),
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),
  cachedPlugins: text('cached_plugins', { mode: 'json' }).$type<CachedPlugin[]>(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

`MarketplaceStatus`: `'active' | 'syncing' | 'error'`

---

### workflows

```typescript
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  nodes: text('nodes', { mode: 'json' }).$type<WorkflowNode[]>(),
  edges: text('edges', { mode: 'json' }).$type<WorkflowEdge[]>(),
  sourceTemplateId: text('source_template_id').references(() => templates.id, { onDelete: 'set null' }),
  sourceTemplateName: text('source_template_name'),
  viewport: text('viewport', { mode: 'json' }).$type<WorkflowViewport>(),
  status: text('status').default('draft').$type<WorkflowStatus>(),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  thumbnail: text('thumbnail'),
  aiGenerated: integer('ai_generated', { mode: 'boolean' }),
  aiModel: text('ai_model'),
  aiConfidence: integer('ai_confidence'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

`WorkflowStatus`: `'draft' | 'published' | 'archived'`

---

## Relations

All Drizzle ORM relations are defined in `src/db/schema/sqlite/relations.ts`. Key relationships:

### Core Relations

- **projects** has many: tasks, agents, sessions, worktrees, auditLogs, templates, templateProjects, planSessions, teamProjects, projectMembers, projectTags, eventSubscriptions; has one: sandboxInstance, sandboxConfig
- **tasks** belongs to: project, agent, session, worktree; has many: agentRuns, auditLogs, planSessions, tmuxSessions, taskTags
- **agents** belongs to: project; has many: tasks, agentRuns, sessions, auditLogs
- **sessions** belongs to: project, task, agent; has many: events; has one: summary
- **worktrees** belongs to: project, task
- **agentRuns** belongs to: agent, task, project, session

### Auth/RBAC Relations

- **users** has many: sessions (userSessions), teamMemberships, projectMemberships, apiTokens, invitationsSent
- **teams** has many: members, projects, tags, apiTokens, invitations, eventSources
- **teamMembers** belongs to: team, user
- **teamProjects** belongs to: team, project
- **projectMembers** belongs to: project, user, grantedByTeam
- **teamInvitations** belongs to: team, invitedByUser

### Tags Relations

- **tags** belongs to: team; has many: projectTags, taskTags
- **projectTags** belongs to: project, tag
- **taskTags** belongs to: task, tag

### Template Relations

- **templates** belongs to: project (legacy); has many: templateProjects
- **templateProjects** belongs to: template, project

### Sandbox Relations

- **sandboxConfigs** has many: projects
- **sandboxInstances** belongs to: project; has many: tmuxSessions
- **sandboxTmuxSessions** belongs to: sandbox, task

### GitHub Relations

- **githubInstallations** has many: repositories (repositoryConfigs)
- **repositoryConfigs** belongs to: installation

### Event Relations

- **eventSources** belongs to: team; has many: subscriptions, eventLogs
- **eventSubscriptions** belongs to: eventSource, targetProject
- **eventLog** belongs to: eventSource

### Terraform Relations

- **terraformRegistries** has many: modules
- **terraformModules** belongs to: registry

### API Relations

- **apiTokens** belongs to: user, team, scopeProject

---

## Table Summary

| # | Table | Domain | PK | FK Count | Notable Indexes |
|---|-------|--------|-----|----------|----------------|
| 1 | projects | Core | cuid2 | 2 | path (unique) |
| 2 | tasks | Core | cuid2 | 4 | |
| 3 | agents | Core | cuid2 | 1 | |
| 4 | agent_runs | Core | cuid2 | 4 | |
| 5 | sessions | Core | cuid2 | 3 | |
| 6 | session_events | Core | cuid2 | 1 | session+offset (unique), session, offset |
| 7 | session_summaries | Core | cuid2 | 1 | sessionId (unique) |
| 8 | worktrees | Core | cuid2 | 3 | |
| 9 | plan_sessions | Core | cuid2 | 2 | |
| 10 | audit_logs | Core | cuid2 | 4 | |
| 11 | settings | Core | text key | 0 | |
| 12 | cli_sessions | Core | cuid2 | 0 | project+activity, status, lastActivity |
| 13 | users | Auth | cuid2 | 0 | githubId (unique) |
| 14 | user_sessions | Auth | cuid2 | 1 | token (unique) |
| 15 | teams | Auth | cuid2 | 0 | slug (unique) |
| 16 | team_members | Auth | composite | 2 | |
| 17 | team_projects | Auth | composite | 2 | |
| 18 | team_invitations | Auth | cuid2 | 2 | token (unique) |
| 19 | project_members | Auth | composite | 3 | |
| 20 | tags | Tags | cuid2 | 1 | team+name (unique) |
| 21 | project_tags | Tags | composite | 2 | |
| 22 | task_tags | Tags | composite | 2 | |
| 23 | sandbox_configs | Sandbox | cuid2 | 0 | |
| 24 | sandbox_instances | Sandbox | cuid2 | 1 | projectId (unique) |
| 25 | sandbox_tmux_sessions | Sandbox | cuid2 | 2 | sandbox+sessionName (unique) |
| 26 | templates | Templates | cuid2 | 1 | |
| 27 | template_projects | Templates | composite | 2 | |
| 28 | github_tokens | GitHub | cuid2 | 1 | |
| 29 | github_installations | GitHub | cuid2 | 0 | installationId (unique) |
| 30 | repository_configs | GitHub | cuid2 | 1 | |
| 31 | event_sources | Events | cuid2 | 1 | team, slug (unique) |
| 32 | event_subscriptions | Events | cuid2 | 2 | source, project, source+enabled |
| 33 | event_log | Events | cuid2 | 1 | source, receivedAt, source+status, source+deliveryId (unique) |
| 34 | schedule_executions | Events | cuid2 | 3 | source, source+status, source+executedAt, source+scheduledAt |
| 35 | terraform_registries | Terraform | cuid2 | 0 | |
| 36 | terraform_modules | Terraform | cuid2 | 0 | registryId (no FK constraint) |
| 37 | api_keys | API | cuid2 | 0 | service (unique) |
| 38 | api_tokens | API | cuid2 | 3 | tokenHash (unique) |
| 39 | marketplaces | Other | cuid2 | 0 | |
| 40 | workflows | Other | cuid2 | 1 | |

**Total: 40 tables** (including 7 junction tables with composite primary keys)

---

## Entity Relationship Diagram

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐
│    users     │────<│ user_sessions│     │    teams      │
│ (GitHub OAuth│     └──────────────┘     │ (slug unique) │
│  githubId)   │                          └───────┬───────┘
└──────┬───────┘                                  │
       │                                          │
  ┌────┴─────────────────────────┐     ┌──────────┴──────────┐
  │                              │     │                     │
  ▼                              ▼     ▼                     ▼
┌──────────────┐  ┌──────────────────┐ ┌──────────────┐ ┌────────────────┐
│ team_members │  │ project_members  │ │ team_projects│ │team_invitations│
│ (composite)  │  │ (composite)      │ │ (composite)  │ │                │
└──────────────┘  └──────────────────┘ └──────────────┘ └────────────────┘
                         │                    │
                         ▼                    ▼
                  ┌─────────────────────────────┐
                  │          projects            │
                  │ (path unique, config JSON)   │
                  └──────────┬──────────────────┘
                             │
          ┌────────┬─────────┼──────────┬───────────┐
          │        │         │          │           │
          ▼        ▼         ▼          ▼           ▼
      ┌────────┐┌────────┐┌──────────┐┌───────────┐┌──────────────┐
      │ tasks  ││ agents ││ sessions ││ worktrees ││sandbox_inst. │
      │(column,││(status,││(status,  ││(branch,   ││(1:1 project) │
      │ plan)  ││ type)  ││ url)     ││ status)   │└──────┬───────┘
      └───┬────┘└───┬────┘└────┬─────┘└───────────┘       │
          │         │          │                           ▼
          │    ┌────┴────┐     │              ┌───────────────────┐
          │    │         │     │              │sandbox_tmux_sess. │
          ▼    ▼         │     ▼              └───────────────────┘
      ┌──────────────┐   │  ┌───────────────┐
      │  agent_runs  │   │  │session_events │
      │(status, turns│   │  │(offset unique │
      │ tokens)      │   │  │ per session)  │
      └──────────────┘   │  └───────────────┘
                         │
          ┌──────────────┤
          ▼              ▼
      ┌──────────┐  ┌───────────────────┐
      │audit_logs│  │session_summaries  │
      │(tool,    │  │(cost, tokens,     │
      │ status)  │  │ duration)         │
      └──────────┘  └───────────────────┘

┌─────────────────────────────────────┐
│           Event System              │
│                                     │
│  event_sources ──< event_subs       │
│       │              │              │
│       ▼              ▼              │
│  event_log      target_project      │
│                                     │
│  schedule_executions                │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│          GitHub / Tags / Other      │
│                                     │
│  github_tokens  github_installations│
│                       │             │
│                       ▼             │
│                 repository_configs  │
│                                     │
│  tags ──< project_tags, task_tags   │
│                                     │
│  templates ──< template_projects    │
│                                     │
│  terraform_registries ──< modules   │
│                                     │
│  api_keys   api_tokens              │
│  marketplaces   workflows           │
│  plan_sessions  settings            │
│  sandbox_configs  cli_sessions      │
└─────────────────────────────────────┘
```

---

## Migration Commands

```bash
# Generate migration from schema changes
bun run db:generate

# Apply migrations
bun run db:migrate

# Open Drizzle Studio for visual inspection
bun run db:studio

# Push schema directly (development only)
bun run db:push
```

---

## PostgreSQL Support

The project maintains a parallel schema directory at `src/db/schema/postgres/` that mirrors the SQLite schema using PostgreSQL-specific types (`pgTable`, `timestamp`, `jsonb`, etc.). The shared enums and types in `src/db/schema/shared/` are used by both dialects. The SQLite schema is the primary/default configuration.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](../api/endpoints.md) | Uses validation schemas for request bodies |
| [Service Layer](../services/) | Performs CRUD operations on these tables |
| [State Machines](../state-machines/) | Defines valid column/status transitions |
| [Error Catalog](../errors/error-catalog.md) | Database error types |
| [Durable Sessions](../integrations/durable-sessions.md) | Sessions + session_events tables |
| [Git Worktrees](../integrations/git-worktrees.md) | Worktrees table tracks git state |
| [GitHub App](../integrations/github-app.md) | GitHub tables store tokens and installations |
| [Security Model](../security/security-model.md) | RBAC tables (users, teams, project_members) |
| [Sandbox](../security/sandbox.md) | Sandbox configs and instances |
