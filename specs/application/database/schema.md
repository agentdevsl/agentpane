# Database Schema Specification

## Overview

Complete Drizzle ORM schemas for AgentPane using PGlite (PostgreSQL in the browser/server).

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| PGlite | 0.3.15 | Embedded PostgreSQL (IndexedDB/OPFS) |
| Drizzle ORM | 0.45.1 | Type-safe SQL query builder |
| @paralleldrive/cuid2 | 3.0.6 | Collision-resistant IDs |
| Zod | 4.3.5 | Runtime validation |

---

## Schema Files Structure

```
db/
├── schema/
│   ├── index.ts          # Re-exports all schemas
│   ├── projects.ts       # Project configuration
│   ├── tasks.ts          # Kanban tasks
│   ├── agents.ts         # Agent definitions
│   ├── agent-runs.ts     # Execution history
│   ├── sessions.ts       # Durable session metadata
│   ├── worktrees.ts      # Git worktree tracking
│   ├── audit-logs.ts     # Tool call audit trail
│   └── github.ts         # GitHub App integration
├── client.ts             # PGlite + Drizzle setup
└── migrations/           # Generated migrations
```

---

## Enums

```typescript
// db/schema/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core';

// Task workflow states (4-column Kanban)
export const taskColumnEnum = pgEnum('task_column', [
  'backlog',
  'in_progress',
  'waiting_approval',
  'verified',
]);

// Agent execution states
export const agentStatusEnum = pgEnum('agent_status', [
  'idle',
  'starting',
  'running',
  'paused',
  'error',
  'completed',
]);

// Agent types
export const agentTypeEnum = pgEnum('agent_type', [
  'task',           // Single-task execution
  'conversational', // Interactive chat
  'background',     // Long-running process
]);

// Tool call status
export const toolStatusEnum = pgEnum('tool_status', [
  'pending',
  'running',
  'complete',
  'error',
]);

// Worktree states
export const worktreeStatusEnum = pgEnum('worktree_status', [
  'creating',
  'active',
  'merging',
  'removing',
  'removed',
  'error',
]);

// GitHub App installation status
export const installationStatusEnum = pgEnum('installation_status', [
  'active',
  'suspended',
  'deleted',
]);
```

---

## Projects Table

```typescript
// db/schema/projects.ts
import { pgTable, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

// Zod schema for project config
export const projectConfigSchema = z.object({
  worktreeRoot: z.string().default('.worktrees'),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().default('main'),
  allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),
  maxTurns: z.number().default(50),
  model: z.string().default('claude-sonnet-4-6'),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const projects = pgTable('projects', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Core fields
  name: text('name').notNull(),
  path: text('path').notNull().unique(),  // ~/git/my-project
  description: text('description'),

  // Configuration (JSONB for flexibility)
  config: jsonb('config').$type<ProjectConfig>().notNull().default({
    worktreeRoot: '.worktrees',
    defaultBranch: 'main',
    allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    model: 'claude-sonnet-4-6',
  }),

  // Concurrency settings
  maxConcurrentAgents: integer('max_concurrent_agents').notNull().default(3),

  // GitHub integration (optional)
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  githubInstallationId: text('github_installation_id'),
  configPath: text('config_path').default('.claude'),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Type exports
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
```

### Indexes

```typescript
// Projects indexes
import { index } from 'drizzle-orm/pg-core';

export const projectsIndexes = {
  pathIdx: index('projects_path_idx').on(projects.path),
  githubIdx: index('projects_github_idx').on(projects.githubOwner, projects.githubRepo),
  updatedAtIdx: index('projects_updated_at_idx').on(projects.updatedAt),
};
```

---

## Tasks Table

```typescript
// db/schema/tasks.ts
import { pgTable, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { taskColumnEnum } from './enums';
import { projects } from './projects';

export const tasks = pgTable('tasks', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id'),  // Assigned agent (null if unassigned)
  sessionId: text('session_id'),  // Active session

  // Task content
  title: text('title').notNull(),
  description: text('description'),

  // Kanban state
  column: taskColumnEnum('column').notNull().default('backlog'),
  position: integer('position').notNull().default(0),  // Order within column

  // Git integration
  branch: text('branch'),
  worktreeId: text('worktree_id'),

  // Approval workflow
  diffSummary: text('diff_summary'),
  filesChanged: integer('files_changed'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),

  // Approval metadata
  approvedAt: timestamp('approved_at'),
  approvedBy: text('approved_by'),
  rejectionReason: text('rejection_reason'),
  rejectionCount: integer('rejection_count').default(0),

  // Execution metadata
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  turnCount: integer('turn_count').default(0),

  // Labels/metadata (JSONB)
  labels: jsonb('labels').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Type exports
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskColumn = 'backlog' | 'in_progress' | 'waiting_approval' | 'verified';
```

### Indexes

```typescript
// Tasks indexes
export const tasksIndexes = {
  projectIdx: index('tasks_project_idx').on(tasks.projectId),
  columnIdx: index('tasks_column_idx').on(tasks.projectId, tasks.column),
  agentIdx: index('tasks_agent_idx').on(tasks.agentId),
  positionIdx: index('tasks_position_idx').on(tasks.projectId, tasks.column, tasks.position),
  branchIdx: index('tasks_branch_idx').on(tasks.branch),
};
```

---

## Agents Table

```typescript
// db/schema/agents.ts
import { pgTable, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { agentTypeEnum, agentStatusEnum } from './enums';
import { projects } from './projects';
import { z } from 'zod';

// Zod schema for agent config
export const agentConfigSchema = z.object({
  allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),
  maxTurns: z.number().default(50),
  model: z.string().default('claude-sonnet-4-6'),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agents = pgTable('agents', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),

  // Core fields
  name: text('name').notNull(),
  type: agentTypeEnum('type').notNull().default('task'),
  status: agentStatusEnum('status').notNull().default('idle'),

  // Configuration
  config: jsonb('config').$type<AgentConfig>().notNull().default({
    allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    model: 'claude-sonnet-4-6',
  }),

  // Current execution context
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentWorktreeId: text('current_worktree_id'),

  // Statistics
  totalTasks: integer('total_tasks').default(0),
  completedTasks: integer('completed_tasks').default(0),
  failedTasks: integer('failed_tasks').default(0),

  // Error tracking
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at'),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Type exports
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentStatus = 'idle' | 'starting' | 'running' | 'paused' | 'error' | 'completed';
```

### Indexes

```typescript
// Agents indexes
export const agentsIndexes = {
  projectIdx: index('agents_project_idx').on(agents.projectId),
  statusIdx: index('agents_status_idx').on(agents.projectId, agents.status),
  currentTaskIdx: index('agents_current_task_idx').on(agents.currentTaskId),
};
```

---

## Agent Runs Table

```typescript
// db/schema/agent-runs.ts
import { pgTable, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { agentStatusEnum } from './enums';
import { agents } from './agents';
import { tasks } from './tasks';
import { projects } from './projects';

export const agentRuns = pgTable('agent_runs', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),

  // Execution state
  status: agentStatusEnum('status').notNull().default('starting'),
  prompt: text('prompt').notNull(),
  result: text('result'),

  // Metrics
  turnCount: integer('turn_count').default(0),
  tokenInputCount: integer('token_input_count').default(0),
  tokenOutputCount: integer('token_output_count').default(0),

  // Tool usage summary
  toolCalls: jsonb('tool_calls').$type<{
    tool: string;
    count: number;
    totalDuration: number;
  }[]>().default([]),

  // Error tracking
  error: text('error'),
  errorType: text('error_type'),

  // Timing
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),

  // Duration in milliseconds
  duration: integer('duration'),
});

// Type exports
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
```

### Indexes

```typescript
// Agent runs indexes
export const agentRunsIndexes = {
  agentIdx: index('agent_runs_agent_idx').on(agentRuns.agentId),
  taskIdx: index('agent_runs_task_idx').on(agentRuns.taskId),
  projectIdx: index('agent_runs_project_idx').on(agentRuns.projectId),
  statusIdx: index('agent_runs_status_idx').on(agentRuns.status),
  startedAtIdx: index('agent_runs_started_at_idx').on(agentRuns.startedAt),
};
```

---

## Sessions Table

```typescript
// db/schema/sessions.ts
import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { projects } from './projects';
import { tasks } from './tasks';
import { agents } from './agents';

export const sessions = pgTable('sessions', {
  // Primary key (also used as URL slug)
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),

  // Session metadata
  title: text('title'),
  url: text('url').notNull().unique(),  // /sessions/{id}

  // State
  isActive: boolean('is_active').notNull().default(true),

  // Presence tracking (JSONB for flexibility)
  activeUsers: jsonb('active_users').$type<{
    userId: string;
    joinedAt: number;
    lastSeen: number;
  }[]>().default([]),

  // Event counts for quick stats
  messageCount: jsonb('message_count').$type<number>().default(0),
  toolCallCount: jsonb('tool_call_count').$type<number>().default(0),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
});

// Type exports
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
```

### Indexes

```typescript
// Sessions indexes
export const sessionsIndexes = {
  projectIdx: index('sessions_project_idx').on(sessions.projectId),
  taskIdx: index('sessions_task_idx').on(sessions.taskId),
  agentIdx: index('sessions_agent_idx').on(sessions.agentId),
  urlIdx: index('sessions_url_idx').on(sessions.url),
  activeIdx: index('sessions_active_idx').on(sessions.isActive),
};
```

---

## Worktrees Table

```typescript
// db/schema/worktrees.ts
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { worktreeStatusEnum } from './enums';
import { projects } from './projects';
import { tasks } from './tasks';

export const worktrees = pgTable('worktrees', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

  // Git metadata
  branch: text('branch').notNull(),
  baseBranch: text('base_branch').notNull().default('main'),
  path: text('path').notNull(),  // .worktrees/feature-x

  // State
  status: worktreeStatusEnum('status').notNull().default('creating'),

  // Setup tracking
  envCopied: boolean('env_copied').default(false),
  depsInstalled: boolean('deps_installed').default(false),
  initScriptRun: boolean('init_script_run').default(false),

  // Error tracking
  lastError: text('last_error'),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  mergedAt: timestamp('merged_at'),
  removedAt: timestamp('removed_at'),
});

// Type exports
export type Worktree = typeof worktrees.$inferSelect;
export type NewWorktree = typeof worktrees.$inferInsert;
export type WorktreeStatus = 'creating' | 'active' | 'merging' | 'removing' | 'removed' | 'error';
```

### Indexes

```typescript
// Worktrees indexes
export const worktreesIndexes = {
  projectIdx: index('worktrees_project_idx').on(worktrees.projectId),
  taskIdx: index('worktrees_task_idx').on(worktrees.taskId),
  branchIdx: index('worktrees_branch_idx').on(worktrees.branch),
  statusIdx: index('worktrees_status_idx').on(worktrees.status),
  pathIdx: index('worktrees_path_idx').on(worktrees.path),
};
```

---

## Audit Logs Table

```typescript
// db/schema/audit-logs.ts
import { pgTable, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { toolStatusEnum } from './enums';
import { agents } from './agents';
import { tasks } from './tasks';
import { projects } from './projects';
import { agentRuns } from './agent-runs';

export const auditLogs = pgTable('audit_logs', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Foreign keys
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),

  // Tool call details
  tool: text('tool').notNull(),  // Read, Edit, Bash, Glob, Grep
  status: toolStatusEnum('status').notNull().default('pending'),

  // Input/Output (JSONB for flexibility)
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  output: jsonb('output').$type<Record<string, unknown>>(),
  error: text('error'),

  // Performance metrics
  duration: integer('duration'),  // milliseconds

  // Turn tracking
  turnNumber: integer('turn_number').notNull(),

  // Timestamp
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

// Type exports
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
```

### Indexes

```typescript
// Audit logs indexes
export const auditLogsIndexes = {
  agentIdx: index('audit_logs_agent_idx').on(auditLogs.agentId),
  agentRunIdx: index('audit_logs_agent_run_idx').on(auditLogs.agentRunId),
  taskIdx: index('audit_logs_task_idx').on(auditLogs.taskId),
  projectIdx: index('audit_logs_project_idx').on(auditLogs.projectId),
  toolIdx: index('audit_logs_tool_idx').on(auditLogs.tool),
  timestampIdx: index('audit_logs_timestamp_idx').on(auditLogs.timestamp),
};
```

---

## GitHub Integration Tables

```typescript
// db/schema/github.ts
import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { installationStatusEnum } from './enums';

// GitHub App Installations
export const githubInstallations = pgTable('github_installations', {
  // Primary key (GitHub installation ID)
  id: text('id').primaryKey(),

  // Account info
  accountId: text('account_id').notNull(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),  // User or Organization
  accountAvatarUrl: text('account_avatar_url'),

  // Installation state
  status: installationStatusEnum('status').notNull().default('active'),

  // Permissions granted
  permissions: jsonb('permissions').$type<Record<string, string>>().default({}),

  // Repository access
  repositorySelection: text('repository_selection'),  // all or selected

  // Timestamps
  installedAt: timestamp('installed_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  suspendedAt: timestamp('suspended_at'),
});

// Repository configurations (cached from git)
export const repositoryConfigs = pgTable('repository_configs', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Repository identification
  installationId: text('installation_id').notNull().references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  fullName: text('full_name').notNull(),  // owner/repo

  // Config sync
  configPath: text('config_path').notNull().default('.claude'),
  configSha: text('config_sha'),  // Last synced commit SHA

  // Cached config content
  config: jsonb('config').$type<Record<string, unknown>>().default({}),

  // Sync state
  lastSyncedAt: timestamp('last_synced_at'),
  syncError: text('sync_error'),

  // Repository metadata
  defaultBranch: text('default_branch').default('main'),
  isPrivate: boolean('is_private').default(false),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Type exports
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type RepositoryConfig = typeof repositoryConfigs.$inferSelect;
export type NewRepositoryConfig = typeof repositoryConfigs.$inferInsert;
```

### Indexes

```typescript
// GitHub indexes
export const githubIndexes = {
  installationAccountIdx: index('github_installations_account_idx').on(githubInstallations.accountLogin),
  repoInstallationIdx: index('repository_configs_installation_idx').on(repositoryConfigs.installationId),
  repoFullNameIdx: index('repository_configs_full_name_idx').on(repositoryConfigs.fullName),
  repoOwnerRepoIdx: index('repository_configs_owner_repo_idx').on(repositoryConfigs.owner, repositoryConfigs.repo),
};
```

---

## Schema Index File

```typescript
// db/schema/index.ts
export * from './enums';
export * from './projects';
export * from './tasks';
export * from './agents';
export * from './agent-runs';
export * from './sessions';
export * from './worktrees';
export * from './audit-logs';
export * from './github';
```

---

## PGlite Client Setup

```typescript
// db/client.ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';

// Use IndexedDB for cross-browser compatibility (Safari doesn't support OPFS)
const pglite = new PGlite('idb://agentpane');
export const db = drizzle(pglite, { schema });

// Server-side (Bun) - use file system
export function createServerDb(dataDir: string = './data') {
  const serverPglite = new PGlite(`${dataDir}/agentpane.db`);
  return drizzle(serverPglite, { schema });
}
```

---

## Relations

```typescript
// db/schema/relations.ts
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import { tasks } from './tasks';
import { agents } from './agents';
import { agentRuns } from './agent-runs';
import { sessions } from './sessions';
import { worktrees } from './worktrees';
import { auditLogs } from './audit-logs';
import { githubInstallations, repositoryConfigs } from './github';

// Project relations
export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
  agents: many(agents),
  sessions: many(sessions),
  worktrees: many(worktrees),
  agentRuns: many(agentRuns),
}));

// Task relations
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  agent: one(agents, {
    fields: [tasks.agentId],
    references: [agents.id],
  }),
  worktree: one(worktrees, {
    fields: [tasks.worktreeId],
    references: [worktrees.id],
  }),
  agentRuns: many(agentRuns),
  auditLogs: many(auditLogs),
}));

// Agent relations
export const agentsRelations = relations(agents, ({ one, many }) => ({
  project: one(projects, {
    fields: [agents.projectId],
    references: [projects.id],
  }),
  currentTask: one(tasks, {
    fields: [agents.currentTaskId],
    references: [tasks.id],
  }),
  runs: many(agentRuns),
  auditLogs: many(auditLogs),
}));

// Agent runs relations
export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  agent: one(agents, {
    fields: [agentRuns.agentId],
    references: [agents.id],
  }),
  task: one(tasks, {
    fields: [agentRuns.taskId],
    references: [tasks.id],
  }),
  project: one(projects, {
    fields: [agentRuns.projectId],
    references: [projects.id],
  }),
  auditLogs: many(auditLogs),
}));

// Session relations
export const sessionsRelations = relations(sessions, ({ one }) => ({
  project: one(projects, {
    fields: [sessions.projectId],
    references: [projects.id],
  }),
  task: one(tasks, {
    fields: [sessions.taskId],
    references: [tasks.id],
  }),
  agent: one(agents, {
    fields: [sessions.agentId],
    references: [agents.id],
  }),
}));

// Worktree relations
export const worktreesRelations = relations(worktrees, ({ one }) => ({
  project: one(projects, {
    fields: [worktrees.projectId],
    references: [projects.id],
  }),
  task: one(tasks, {
    fields: [worktrees.taskId],
    references: [tasks.id],
  }),
}));

// Audit log relations
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  agent: one(agents, {
    fields: [auditLogs.agentId],
    references: [agents.id],
  }),
  agentRun: one(agentRuns, {
    fields: [auditLogs.agentRunId],
    references: [agentRuns.id],
  }),
  task: one(tasks, {
    fields: [auditLogs.taskId],
    references: [tasks.id],
  }),
  project: one(projects, {
    fields: [auditLogs.projectId],
    references: [projects.id],
  }),
}));

// GitHub installation relations
export const githubInstallationsRelations = relations(githubInstallations, ({ many }) => ({
  repositories: many(repositoryConfigs),
}));

// Repository config relations
export const repositoryConfigsRelations = relations(repositoryConfigs, ({ one }) => ({
  installation: one(githubInstallations, {
    fields: [repositoryConfigs.installationId],
    references: [githubInstallations.id],
  }),
}));
```

---

## Entity Relationship Diagram

```
┌─────────────────┐
│    projects     │
├─────────────────┤
│ id (PK)         │
│ name            │
│ path            │
│ config          │
│ github_*        │
└────────┬────────┘
         │
    ┌────┴────┬──────────┬───────────┐
    │         │          │           │
    ▼         ▼          ▼           ▼
┌─────────┐ ┌────────┐ ┌──────────┐ ┌───────────┐
│  tasks  │ │ agents │ │ sessions │ │ worktrees │
├─────────┤ ├────────┤ ├──────────┤ ├───────────┤
│ id (PK) │ │ id (PK)│ │ id (PK)  │ │ id (PK)   │
│ column  │ │ status │ │ url      │ │ branch    │
│ position│ │ config │ │ isActive │ │ status    │
│ branch  │ │        │ │          │ │ path      │
└────┬────┘ └───┬────┘ └──────────┘ └───────────┘
     │          │
     │          │
     ▼          ▼
┌─────────────────┐
│   agent_runs    │
├─────────────────┤
│ id (PK)         │
│ status          │
│ prompt/result   │
│ metrics         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐        ┌──────────────────────┐
│   audit_logs    │        │ github_installations │
├─────────────────┤        ├──────────────────────┤
│ id (PK)         │        │ id (PK)              │
│ tool            │        │ account_login        │
│ input/output    │        │ permissions          │
│ timestamp       │        └──────────┬───────────┘
└─────────────────┘                   │
                                      ▼
                          ┌───────────────────────┐
                          │  repository_configs   │
                          ├───────────────────────┤
                          │ id (PK)               │
                          │ owner/repo            │
                          │ config (cached)       │
                          └───────────────────────┘
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

## Validation Schemas (Zod)

```typescript
// db/schema/validation.ts
import { z } from 'zod';
import { projectConfigSchema } from './projects';
import { agentConfigSchema } from './agents';

// Create project input
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  description: z.string().max(500).optional(),
  config: projectConfigSchema.optional(),
  maxConcurrentAgents: z.number().min(1).max(10).optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
});

// Create task input
export const createTaskSchema = z.object({
  projectId: z.string().cuid2(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  labels: z.array(z.string()).max(10).optional(),
});

// Create agent input
export const createAgentSchema = z.object({
  projectId: z.string().cuid2(),
  name: z.string().min(1).max(100),
  type: z.enum(['task', 'conversational', 'background']).optional(),
  config: agentConfigSchema.optional(),
});

// Move task input
export const moveTaskSchema = z.object({
  column: z.enum(['backlog', 'in_progress', 'waiting_approval', 'verified']),
  position: z.number().min(0),
});

// Approval input
export const approveTaskSchema = z.object({
  approvedBy: z.string().optional(),
});

// Rejection input
export const rejectTaskSchema = z.object({
  reason: z.string().min(1).max(1000),
});

// Export types
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
export type ApproveTaskInput = z.infer<typeof approveTaskSchema>;
export type RejectTaskInput = z.infer<typeof rejectTaskSchema>;
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](../api/endpoints.md) | Uses validation schemas for request bodies |
| [Service Layer](../services/) | Performs CRUD operations on these tables |
| [State Machines](../state-machines/) | Defines valid column/status transitions |
| [Error Catalog](../errors/error-catalog.md) | Database error types |
| [Durable Sessions](../integrations/durable-sessions.md) | Sessions table stores metadata |
| [Git Worktrees](../integrations/git-worktrees.md) | Worktrees table tracks git state |
| [GitHub App](../integrations/github-app.md) | GitHub tables store App data |
