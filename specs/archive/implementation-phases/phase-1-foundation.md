# Phase 1: Foundation Layer

## Overview

**Duration:** Weeks 1-3
**Tasks:** ~69
**Test Cases:** ~376

The Foundation Layer establishes core infrastructure: utilities, database, bootstrap, state machines, and configuration.

---

## 1.1 Core Utilities

### Result Type (`lib/utils/result.ts`)

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Helper functions
function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T };
function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E };
function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F>;
function unwrap<T, E>(result: Result<T, E>): T; // throws on error
function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T;
```

**Tests (8):**

- `ok()` returns success result
- `err()` returns error result
- Type narrowing works correctly with `isOk`/`isErr`
- `map()` transforms success value
- `mapErr()` transforms error value
- `unwrap()` returns value on success
- `unwrap()` throws on error
- `unwrapOr()` returns default on error

### Deep Merge (`lib/utils/deep-merge.ts`)

```typescript
function deepMerge<T extends object>(target: T, ...sources: Partial<T>[]): T;
```

**Tests (6):**

- Shallow merge works
- Deep nested merge works
- Arrays are replaced (not merged)
- Undefined values don't override existing
- Null values do override existing
- Handles circular references gracefully

### Error Base (`lib/errors/base.ts`)

```typescript
interface AppError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

function createError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): AppError;

class AppErrorClass extends Error implements AppError {
  constructor(
    public code: string,
    public message: string,
    public status: number,
    public details?: Record<string, unknown>
  );
}
```

---

## 1.2 Error Catalog (44 Error Codes)

### Project Errors (5) - `lib/errors/project-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| PROJECT_NOT_FOUND | 404 | Project ID doesn't exist |
| PROJECT_PATH_EXISTS | 409 | Duplicate path on create |
| PROJECT_PATH_INVALID | 400 | Path doesn't exist or not git repo |
| PROJECT_HAS_RUNNING_AGENTS | 409 | Cannot delete with active agents |
| PROJECT_CONFIG_INVALID | 400 | Config validation failed |

```typescript
export const ProjectErrors = {
  NOT_FOUND: (id: string) => createError('PROJECT_NOT_FOUND', `Project ${id} not found`, 404),
  PATH_EXISTS: (path: string) => createError('PROJECT_PATH_EXISTS', `Project at ${path} already exists`, 409),
  PATH_INVALID: (path: string) => createError('PROJECT_PATH_INVALID', `Invalid path: ${path}`, 400),
  HAS_RUNNING_AGENTS: (count: number) => createError('PROJECT_HAS_RUNNING_AGENTS', `Project has ${count} running agents`, 409),
  CONFIG_INVALID: (errors: string[]) => createError('PROJECT_CONFIG_INVALID', 'Invalid configuration', 400, { errors }),
};
```

### Task Errors (8) - `lib/errors/task-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| TASK_NOT_FOUND | 404 | Task ID doesn't exist |
| TASK_NOT_IN_COLUMN | 400 | Invalid column transition |
| TASK_ALREADY_ASSIGNED | 409 | Task already has agent |
| TASK_NO_DIFF | 400 | Approve with empty diff |
| TASK_ALREADY_APPROVED | 409 | Double approval |
| TASK_NOT_WAITING_APPROVAL | 400 | Wrong state for approval |
| TASK_INVALID_TRANSITION | 400 | Disallowed column change |
| TASK_POSITION_CONFLICT | 409 | Concurrent position update |

### Agent Errors (7) - `lib/errors/agent-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| AGENT_NOT_FOUND | 404 | Agent ID doesn't exist |
| AGENT_ALREADY_RUNNING | 409 | Start running agent |
| AGENT_NOT_RUNNING | 400 | Stop idle agent |
| AGENT_TURN_LIMIT_EXCEEDED | 200 | maxTurns reached (workflow status) |
| AGENT_NO_AVAILABLE_TASK | 400 | Start with no tasks |
| AGENT_TOOL_NOT_ALLOWED | 403 | Blocked tool call |
| AGENT_EXECUTION_ERROR | 500 | Runtime error |

### Concurrency Errors (3) - `lib/errors/concurrency-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| CONCURRENCY_LIMIT_EXCEEDED | 429 | Max concurrent agents reached |
| QUEUE_FULL | 429 | Too many queued tasks |
| RESOURCE_LOCKED | 423 | Concurrent modification |

### Worktree Errors (8) - `lib/errors/worktree-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| WORKTREE_CREATION_FAILED | 500 | git worktree add fails |
| WORKTREE_NOT_FOUND | 404 | Worktree ID doesn't exist |
| WORKTREE_BRANCH_EXISTS | 409 | Branch already exists |
| WORKTREE_MERGE_CONFLICT | 409 | Conflicts on merge |
| WORKTREE_DIRTY | 400 | Uncommitted changes |
| WORKTREE_REMOVAL_FAILED | 500 | git worktree remove fails |
| WORKTREE_ENV_COPY_FAILED | 500 | .env copy fails |
| WORKTREE_INIT_SCRIPT_FAILED | 500 | Post-setup script fails |

### Session Errors (4) - `lib/errors/session-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| SESSION_NOT_FOUND | 404 | Session ID doesn't exist |
| SESSION_CLOSED | 400 | Write to closed session |
| SESSION_CONNECTION_FAILED | 502 | WebSocket/SSE failure |
| SESSION_SYNC_FAILED | 500 | Durable Streams error |

### GitHub Errors (8) - `lib/errors/github-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| GITHUB_AUTH_FAILED | 401 | OAuth/token failure |
| GITHUB_INSTALLATION_NOT_FOUND | 404 | Invalid installation ID |
| GITHUB_REPO_NOT_FOUND | 404 | Repo doesn't exist |
| GITHUB_CONFIG_NOT_FOUND | 404 | Missing .claude/ |
| GITHUB_CONFIG_INVALID | 400 | Config parse error |
| GITHUB_WEBHOOK_INVALID | 401 | Signature mismatch |
| GITHUB_RATE_LIMITED | 429 | Rate limit hit |
| GITHUB_PR_CREATION_FAILED | 500 | PR API error |

### Validation Errors (4) - `lib/errors/validation-errors.ts`

| Code | HTTP | Description |
|------|------|-------------|
| VALIDATION_ERROR | 400 | Zod validation fails |
| INVALID_ID | 400 | Bad CUID2 format |
| MISSING_REQUIRED_FIELD | 400 | Required field absent |
| INVALID_ENUM_VALUE | 400 | Value not in enum |

**Spec Reference:** `/specs/application/errors/error-catalog.md`

---

## 1.3 Database Schema (9 Tables)

### Enums (`db/schema/enums.ts`)

```typescript
import { pgEnum } from 'drizzle-orm/pg-core';

export const taskColumnEnum = pgEnum('task_column', [
  'backlog',
  'in_progress',
  'waiting_approval',
  'verified'
]);

export const agentStatusEnum = pgEnum('agent_status', [
  'idle',
  'starting',
  'running',
  'paused',
  'error',
  'completed'
]);

export const agentTypeEnum = pgEnum('agent_type', [
  'task',
  'conversational',
  'background'
]);

export const worktreeStatusEnum = pgEnum('worktree_status', [
  'creating',
  'active',
  'merging',
  'removing',
  'removed',
  'error'
]);

export const toolStatusEnum = pgEnum('tool_status', [
  'pending',
  'running',
  'complete',
  'error'
]);

export const sessionStatusEnum = pgEnum('session_status', [
  'idle',
  'initializing',
  'active',
  'paused',
  'closing',
  'closed',
  'error'
]);
```

### Projects Table (`db/schema/projects.ts`)

```typescript
import { pgTable, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const projects = pgTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: jsonb('config').$type<ProjectConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
```

### Tasks Table (`db/schema/tasks.ts`)

```typescript
export const tasks = pgTable('tasks', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  worktreeId: text('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  column: taskColumnEnum('column').default('backlog').notNull(),
  position: integer('position').default(0).notNull(),
  labels: jsonb('labels').$type<string[]>().default([]),
  branch: text('branch'),
  diffSummary: jsonb('diff_summary').$type<DiffSummary>(),
  approvedAt: timestamp('approved_at'),
  approvedBy: text('approved_by'),
  rejectionCount: integer('rejection_count').default(0),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

### Agents Table (`db/schema/agents.ts`)

```typescript
export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: agentTypeEnum('type').default('task').notNull(),
  status: agentStatusEnum('status').default('idle').notNull(),
  config: jsonb('config').$type<AgentConfig>(),
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentTurn: integer('current_turn').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
```

### Agent Runs Table (`db/schema/agent-runs.ts`)

```typescript
export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  status: agentStatusEnum('status').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  turnsUsed: integer('turns_used').default(0),
  tokensUsed: integer('tokens_used').default(0),
  errorMessage: text('error_message'),
});

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
```

### Sessions Table (`db/schema/sessions.ts`)

```typescript
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  status: sessionStatusEnum('status').default('idle').notNull(),
  title: text('title'),
  url: text('url').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
```

### Worktrees Table (`db/schema/worktrees.ts`)

```typescript
export const worktrees = pgTable('worktrees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  branch: text('branch').notNull(),
  path: text('path').notNull(),
  baseBranch: text('base_branch').default('main').notNull(),
  status: worktreeStatusEnum('status').default('creating').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  mergedAt: timestamp('merged_at'),
  removedAt: timestamp('removed_at'),
});

export type Worktree = typeof worktrees.$inferSelect;
export type NewWorktree = typeof worktrees.$inferInsert;
```

### Audit Logs Table (`db/schema/audit-logs.ts`)

```typescript
export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  status: toolStatusEnum('status').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  turnNumber: integer('turn_number'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
```

### GitHub Tables (`db/schema/github.ts`)

```typescript
export const githubInstallations = pgTable('github_installations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: integer('installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const repositoryConfigs = pgTable('repository_configs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  config: jsonb('config').$type<ProjectConfig>(),
  syncedAt: timestamp('synced_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

### Relations (`db/schema/relations.ts`)

```typescript
import { relations } from 'drizzle-orm';

export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
  agents: many(agents),
  sessions: many(sessions),
  worktrees: many(worktrees),
  auditLogs: many(auditLogs),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  session: one(sessions, { fields: [tasks.sessionId], references: [sessions.id] }),
  worktree: one(worktrees, { fields: [tasks.worktreeId], references: [worktrees.id] }),
  agentRuns: many(agentRuns),
  auditLogs: many(auditLogs),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  project: one(projects, { fields: [agents.projectId], references: [projects.id] }),
  tasks: many(tasks),
  agentRuns: many(agentRuns),
  sessions: many(sessions),
  auditLogs: many(auditLogs),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  project: one(projects, { fields: [sessions.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [sessions.taskId], references: [tasks.id] }),
  agent: one(agents, { fields: [sessions.agentId], references: [agents.id] }),
}));

export const worktreesRelations = relations(worktrees, ({ one, many }) => ({
  project: one(projects, { fields: [worktrees.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [worktrees.taskId], references: [tasks.id] }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(agents, { fields: [agentRuns.agentId], references: [agents.id] }),
  task: one(tasks, { fields: [agentRuns.taskId], references: [tasks.id] }),
  project: one(projects, { fields: [agentRuns.projectId], references: [projects.id] }),
  session: one(sessions, { fields: [agentRuns.sessionId], references: [sessions.id] }),
}));
```

### PGlite Client (`db/client.ts`)

```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';

// Use IndexedDB for cross-browser compatibility (Safari doesn't support OPFS)
const pglite = new PGlite('idb://agentpane');
export const db = drizzle(pglite, { schema });
```

**Spec Reference:** `/specs/application/database/schema.md`

---

## 1.4 Bootstrap Service (6 Phases)

### Phase Types (`lib/bootstrap/types.ts`)

```typescript
export type BootstrapPhase =
  | 'pglite'
  | 'schema'
  | 'collections'
  | 'streams'
  | 'github'
  | 'seeding';

export interface BootstrapState {
  phase: BootstrapPhase;
  progress: number; // 0-100
  error?: AppError;
  isComplete: boolean;
}

export interface BootstrapContext {
  db?: PGliteDatabase<typeof schema>;
  collections?: Collections;
  streams?: DurableStreamsClient;
  githubToken?: string;
}

export interface BootstrapPhaseConfig {
  name: BootstrapPhase;
  fn: (ctx: BootstrapContext) => Promise<Result<unknown, AppError>>;
  timeout: number;
  recoverable: boolean;
}
```

### Phase 1: PGlite (`lib/bootstrap/phases/pglite.ts`)

```typescript
export async function initializePGlite(): Promise<Result<PGlite, BootstrapError>> {
  // 1. Check IndexedDB availability
  if (!window.indexedDB) {
    return err(BootstrapErrors.INDEXEDDB_NOT_AVAILABLE);
  }

  // 2. Detect Safari private browsing (IndexedDB quota = 0)
  try {
    const testDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open('__test__');
      request.onerror = () => reject(new Error('IndexedDB blocked'));
      request.onsuccess = () => resolve(request.result);
    });
    (testDb as IDBDatabase).close();
    indexedDB.deleteDatabase('__test__');
  } catch {
    return err(BootstrapErrors.PRIVATE_BROWSING);
  }

  // 3. Create PGlite instance
  const pglite = new PGlite('idb://agentpane');

  // 4. Test connection
  try {
    await pglite.query('SELECT 1');
    return ok(pglite);
  } catch (error) {
    return err(BootstrapErrors.PGLITE_INIT_FAILED(error));
  }
}
```

**Timeout:** 30 seconds

### Phase 2: Schema (`lib/bootstrap/phases/schema.ts`)

```typescript
export async function validateSchema(
  ctx: BootstrapContext
): Promise<Result<void, BootstrapError>> {
  const { db } = ctx;
  if (!db) return err(BootstrapErrors.NO_DATABASE);

  // 1. Check if migrations are needed
  const migrator = createMigrator(db);

  // 2. Run pending migrations
  try {
    await migrator.migrate();
    return ok(undefined);
  } catch (error) {
    return err(BootstrapErrors.MIGRATION_FAILED(error));
  }
}
```

**Timeout:** 30 seconds

### Phase 3: Collections (`lib/bootstrap/phases/collections.ts`)

```typescript
export async function initializeCollections(
  ctx: BootstrapContext
): Promise<Result<Collections, BootstrapError>> {
  const { db } = ctx;
  if (!db) return err(BootstrapErrors.NO_DATABASE);

  // 1. Create TanStack DB collections
  const collections = {
    projects: createCollection<Project>({ id: 'projects', primaryKey: 'id' }),
    tasks: createCollection<Task>({ id: 'tasks', primaryKey: 'id' }),
    agents: createCollection<Agent>({ id: 'agents', primaryKey: 'id' }),
    sessions: createCollection<Session>({ id: 'sessions', primaryKey: 'id' }),
  };

  // 2. Hydrate from PGlite
  const [projects, tasks, agents, sessions] = await Promise.all([
    db.select().from(schema.projects),
    db.select().from(schema.tasks),
    db.select().from(schema.agents),
    db.select().from(schema.sessions),
  ]);

  collections.projects.insertMany(projects);
  collections.tasks.insertMany(tasks);
  collections.agents.insertMany(agents);
  collections.sessions.insertMany(sessions);

  return ok(collections);
}
```

### Phase 4: Streams (`lib/bootstrap/phases/streams.ts`)

```typescript
export async function connectStreams(): Promise<Result<DurableStreamsClient, BootstrapError>> {
  const client = new DurableStreamsClient({
    url: '/api/streams',
    reconnect: {
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffFactor: 2,
    },
  });

  try {
    await client.connect();
    return ok(client);
  } catch (error) {
    return err(BootstrapErrors.STREAMS_CONNECTION_FAILED(error));
  }
}
```

**Timeout:** 30 seconds

### Phase 5: GitHub (`lib/bootstrap/phases/github.ts`)

```typescript
export async function validateGitHub(
  ctx: BootstrapContext
): Promise<Result<void, BootstrapError>> {
  const token = process.env.GITHUB_TOKEN;

  // Optional - skip if no token
  if (!token) {
    return ok(undefined);
  }

  try {
    const octokit = new Octokit({ auth: token });
    await octokit.users.getAuthenticated();
    ctx.githubToken = token;
    return ok(undefined);
  } catch (error) {
    // Non-fatal - continue without GitHub
    console.warn('GitHub authentication failed:', error);
    return ok(undefined);
  }
}
```

**Behavior:** Optional - continues without GitHub if no token

### Phase 6: Seeding (`lib/bootstrap/phases/seeding.ts`)

```typescript
export async function seedDefaults(
  ctx: BootstrapContext
): Promise<Result<void, BootstrapError>> {
  const { db } = ctx;
  if (!db) return err(BootstrapErrors.NO_DATABASE);

  // Check if first run
  const existingProjects = await db.select().from(schema.projects).limit(1);
  if (existingProjects.length > 0) {
    return ok(undefined); // Already seeded
  }

  // Create default project pointing to current directory
  const defaultProject = await db.insert(schema.projects).values({
    name: 'Default Project',
    path: process.cwd(),
    description: 'Default project created on first run',
  }).returning();

  // Create default agent
  await db.insert(schema.agents).values({
    projectId: defaultProject[0].id,
    name: 'Default Agent',
    type: 'task',
    config: {
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
    },
  });

  return ok(undefined);
}
```

### Bootstrap Service (`lib/bootstrap/service.ts`)

```typescript
export class BootstrapService {
  private state: BootstrapState = {
    phase: 'pglite',
    progress: 0,
    isComplete: false,
  };
  private context: BootstrapContext = {};
  private listeners: Set<(state: BootstrapState) => void> = new Set();

  async run(): Promise<Result<BootstrapContext, BootstrapError>> {
    const phases: BootstrapPhaseConfig[] = [
      { name: 'pglite', fn: initializePGlite, timeout: 30000, recoverable: false },
      { name: 'schema', fn: validateSchema, timeout: 30000, recoverable: false },
      { name: 'collections', fn: initializeCollections, timeout: 30000, recoverable: true },
      { name: 'streams', fn: connectStreams, timeout: 30000, recoverable: true },
      { name: 'github', fn: validateGitHub, timeout: 10000, recoverable: true },
      { name: 'seeding', fn: seedDefaults, timeout: 10000, recoverable: true },
    ];

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      this.updateState({ phase: phase.name, progress: (i / phases.length) * 100 });

      const result = await this.executeWithTimeout(
        () => phase.fn(this.context),
        phase.timeout
      );

      if (!result.ok) {
        if (!phase.recoverable) {
          this.updateState({ error: result.error });
          return result;
        }
        // Log and continue for recoverable phases
        console.warn(`Phase ${phase.name} failed:`, result.error);
      }
    }

    this.updateState({ isComplete: true, progress: 100 });
    return ok(this.context);
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<Result<T, AppError>>,
    timeout: number
  ): Promise<Result<T, AppError>> {
    return Promise.race([
      fn(),
      new Promise<Result<T, AppError>>((resolve) =>
        setTimeout(() => resolve(err(BootstrapErrors.TIMEOUT)), timeout)
      ),
    ]);
  }

  subscribe(listener: (state: BootstrapState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateState(partial: Partial<BootstrapState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => listener(this.state));
  }
}
```

### React Hook (`lib/bootstrap/hooks.ts`)

```typescript
export function useBootstrap(): {
  state: BootstrapState;
  context: BootstrapContext | null;
  retry: () => Promise<void>;
} {
  const [state, setState] = useState<BootstrapState>({
    phase: 'pglite',
    progress: 0,
    isComplete: false,
  });
  const [context, setContext] = useState<BootstrapContext | null>(null);
  const serviceRef = useRef<BootstrapService | null>(null);

  useEffect(() => {
    const service = new BootstrapService();
    serviceRef.current = service;

    const unsubscribe = service.subscribe(setState);

    service.run().then((result) => {
      if (result.ok) {
        setContext(result.value);
      }
    });

    return unsubscribe;
  }, []);

  const retry = useCallback(async () => {
    if (serviceRef.current) {
      const result = await serviceRef.current.run();
      if (result.ok) {
        setContext(result.value);
      }
    }
  }, []);

  return { state, context, retry };
}
```

### React Provider (`app/providers/bootstrap-provider.tsx`)

```typescript
const BootstrapContext = createContext<BootstrapContext | null>(null);

export function BootstrapProvider({ children }: { children: React.ReactNode }) {
  const { state, context, retry } = useBootstrap();

  if (!state.isComplete) {
    return <BootstrapLoadingUI phase={state.phase} progress={state.progress} />;
  }

  if (state.error) {
    return <BootstrapErrorUI error={state.error} onRetry={retry} />;
  }

  return (
    <BootstrapContext.Provider value={context}>
      {children}
    </BootstrapContext.Provider>
  );
}

export function useBootstrapContext() {
  const context = useContext(BootstrapContext);
  if (!context) {
    throw new Error('useBootstrapContext must be used within BootstrapProvider');
  }
  return context;
}
```

**Spec Reference:** `/specs/application/architecture/app-bootstrap.md`

---

## 1.5 State Machines (4 Machines)

### Agent Lifecycle Machine

**Location:** `lib/state-machines/agent-lifecycle/`

**States:** `idle` → `starting` → `running` → `paused` → `completed` | `error`

**Events:**

| Event | Description | Payload |
|-------|-------------|---------|
| START | Begin execution | `{ taskId: string }` |
| STEP | Agent completed turn | `{ turn: number }` |
| PAUSE | Pause for input | `{ reason: string }` |
| RESUME | Continue execution | `{ feedback?: string }` |
| ERROR | Execution error | `{ error: AppError }` |
| COMPLETE | Task finished | `{ result: unknown }` |
| ABORT | Force stop | - |

**Guards:**

```typescript
const guards = {
  withinTurnLimit: (ctx) => ctx.currentTurn < ctx.maxTurns,
  hasValidTask: (ctx) => ctx.task && ['backlog', 'in_progress'].includes(ctx.task.column),
  isToolAllowed: (ctx, event) => ctx.allowedTools.includes(event.tool),
  canStart: (ctx) => ctx.status === 'idle' && ctx.task !== null,
  canPause: (ctx) => ctx.status === 'running',
  canResume: (ctx) => ctx.status === 'paused',
};
```

**Actions:**

```typescript
const actions = {
  incrementTurn: assign({ currentTurn: (ctx) => ctx.currentTurn + 1 }),
  setError: assign({ error: (_, event) => event.error }),
  clearTask: assign({ task: null, currentTurn: 0 }),
  publishStateChange: (ctx) => publishAgentState(ctx.sessionId, ctx.status),
  createAuditLog: (ctx, event) => db.insert(auditLogs).values({
    agentId: ctx.agentId,
    tool: event.tool,
    status: 'complete',
    input: event.input,
    output: event.output,
    turnNumber: ctx.currentTurn,
  }),
};
```

### Task Workflow Machine

**Location:** `lib/state-machines/task-workflow/`

**States:** `backlog` → `in_progress` → `waiting_approval` → `verified`

**Valid Transitions:**

```typescript
const VALID_TRANSITIONS: Record<TaskColumn, TaskColumn[]> = {
  backlog: ['in_progress'],
  in_progress: ['waiting_approval', 'backlog'],
  waiting_approval: ['verified', 'in_progress'],
  verified: [],
};
```

**Events:**

| Event | Description | From → To |
|-------|-------------|-----------|
| ASSIGN | Assign to agent | backlog → in_progress |
| COMPLETE | Agent finished | in_progress → waiting_approval |
| APPROVE | User approves | waiting_approval → verified |
| REJECT | User rejects | waiting_approval → in_progress |
| CANCEL | Cancel task | any → backlog |

**Guards:**

```typescript
const guards = {
  canAssign: (ctx) => ctx.task.column === 'backlog' && !ctx.task.agentId,
  withinConcurrencyLimit: (ctx) => ctx.runningAgents < ctx.project.maxConcurrentAgents,
  hasDiff: (ctx) => ctx.diffSummary && ctx.diffSummary.filesChanged > 0,
  canApprove: (ctx) => ctx.task.column === 'waiting_approval',
  canReject: (ctx) => ctx.task.column === 'waiting_approval',
};
```

### Session Lifecycle Machine

**Location:** `lib/state-machines/session-lifecycle/`

**States:** `idle` → `initializing` → `active` → `paused` → `closing` → `closed` | `error`

**Events:**

| Event | Description |
|-------|-------------|
| INITIALIZE | Begin session setup |
| READY | Resources ready |
| JOIN | User joins session |
| LEAVE | User leaves session |
| HEARTBEAT | Keep-alive ping |
| PAUSE | Suspend session |
| RESUME | Resume session |
| CLOSE | Graceful shutdown |
| TIMEOUT | Idle/connection timeout |

**Guards:**

```typescript
const guards = {
  hasCapacity: (ctx) => ctx.participants.length < ctx.maxParticipants,
  isParticipant: (ctx, event) => ctx.participants.includes(event.userId),
  isStale: (ctx) => Date.now() - ctx.lastActivity > 60000,
  canClose: (ctx) => ctx.status !== 'closed' && ctx.status !== 'closing',
};
```

### Worktree Lifecycle Machine

**Location:** `lib/state-machines/worktree-lifecycle/`

**States:** `creating` → `initializing` → `active` → `dirty` → `committing` → `merging` → `conflict` | `removing` → `removed` | `error`

**Events:**

| Event | Description |
|-------|-------------|
| CREATE | Create git worktree |
| INIT_COMPLETE | Setup finished |
| MODIFY | File changes detected |
| COMMIT | Stage and commit |
| MERGE | Merge to target branch |
| RESOLVE_CONFLICT | Handle conflicts |
| REMOVE | Delete worktree |

**Guards:**

```typescript
const guards = {
  canCreate: (ctx) => !ctx.branchExists && ctx.pathAvailable,
  canMerge: (ctx) => !ctx.hasUncommittedChanges && !ctx.hasConflicts,
  canRemove: (ctx) => !['creating', 'merging', 'committing'].includes(ctx.status),
  isStale: (ctx) => Date.now() - ctx.lastActivity > 7 * 24 * 60 * 60 * 1000,
  hasConflicts: (ctx) => ctx.conflictFiles.length > 0,
};
```

**Spec Reference:** `/specs/application/state-machines/*.md`

---

## 1.6 Configuration Management

### Config Types (`lib/config/types.ts`)

```typescript
export interface ProjectConfig {
  worktreeRoot: string;           // Default: '.worktrees'
  initScript?: string;            // e.g., 'bun install'
  envFile?: string;               // Relative path to .env
  defaultBranch: string;          // Default: 'main'
  maxConcurrentAgents: number;    // Default: 3, max: 10
  allowedTools: string[];         // Default: ['Read', 'Edit', 'Bash', 'Glob', 'Grep']
  maxTurns: number;               // Default: 50, max: 500
  model?: string;                 // Default: 'claude-sonnet-4-6'
  systemPrompt?: string;
  temperature?: number;           // 0-1
}

export interface GlobalConfig {
  anthropicApiKey: string;
  githubToken?: string;
  databaseUrl?: string;           // Default: idb://agentpane
  appUrl?: string;                // Default: http://localhost:5173
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  worktreeRoot: '.worktrees',
  defaultBranch: 'main',
  maxConcurrentAgents: 3,
  allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
};
```

### Config Hierarchy

Priority (highest to lowest):

1. Environment Variables
2. Per-Project Config (`{project}/.claude/settings.json`)
3. Global User Config (`~/.claude/settings.json`)
4. Application Defaults

### Zod Schemas (`lib/config/schemas.ts`)

```typescript
export const projectConfigSchema = z.object({
  worktreeRoot: z.string().default('.worktrees'),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().default('main'),
  maxConcurrentAgents: z.number().min(1).max(10).default(3),
  allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),
  maxTurns: z.number().min(1).max(500).default(50),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

export const globalConfigSchema = z.object({
  anthropicApiKey: z.string(),
  githubToken: z.string().optional(),
  databaseUrl: z.string().optional(),
  appUrl: z.string().optional(),
});
```

### Secret Detection (`lib/config/validate-secrets.ts`)

```typescript
const BLOCKED_PATTERNS = [
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /_TOKEN$/i, // except GITHUB_TOKEN
  /_API_KEY$/i, // except ANTHROPIC_API_KEY
];

const ALLOWED_KEYS = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
];

export function containsSecrets(config: Record<string, unknown>): string[] {
  const violations: string[] = [];

  for (const key of Object.keys(config)) {
    if (ALLOWED_KEYS.includes(key)) continue;

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(key)) {
        violations.push(key);
        break;
      }
    }
  }

  return violations;
}
```

### Hot Reload (`lib/config/hot-reload.ts`)

```typescript
export function watchConfig(
  projectPath: string,
  onConfigChange: (config: ProjectConfig) => void
): () => void {
  const configPath = path.join(projectPath, '.claude', 'settings.json');

  const watcher = fs.watch(configPath, async (eventType) => {
    if (eventType === 'change') {
      try {
        const content = await Bun.file(configPath).text();
        const parsed = JSON.parse(content);
        const validated = projectConfigSchema.parse(parsed);
        onConfigChange(validated);
      } catch (error) {
        console.error('Config reload failed:', error);
      }
    }
  });

  return () => watcher.close();
}
```

**Spec Reference:** `/specs/application/configuration/config-management.md`

---

## File Structure

```
src/
├── db/
│   ├── schema/
│   │   ├── index.ts              # Re-exports all schemas
│   │   ├── enums.ts              # PostgreSQL enums (6 enums)
│   │   ├── projects.ts           # Projects table
│   │   ├── tasks.ts              # Tasks table
│   │   ├── agents.ts             # Agents table
│   │   ├── agent-runs.ts         # Agent runs table
│   │   ├── sessions.ts           # Sessions table
│   │   ├── worktrees.ts          # Worktrees table
│   │   ├── audit-logs.ts         # Audit logs table
│   │   ├── github.ts             # GitHub tables
│   │   └── relations.ts          # Drizzle relations
│   ├── client.ts                 # PGlite + Drizzle setup
│   └── migrations/               # Generated migrations
│
├── lib/
│   ├── utils/
│   │   ├── result.ts             # Result<T, E> type
│   │   └── deep-merge.ts         # Config merge utility
│   │
│   ├── errors/
│   │   ├── base.ts               # AppError interface
│   │   ├── index.ts              # Re-exports
│   │   ├── project-errors.ts
│   │   ├── task-errors.ts
│   │   ├── agent-errors.ts
│   │   ├── concurrency-errors.ts
│   │   ├── worktree-errors.ts
│   │   ├── session-errors.ts
│   │   ├── github-errors.ts
│   │   └── validation-errors.ts
│   │
│   ├── bootstrap/
│   │   ├── types.ts
│   │   ├── service.ts
│   │   ├── hooks.ts
│   │   └── phases/
│   │       ├── pglite.ts
│   │       ├── schema.ts
│   │       ├── collections.ts
│   │       ├── streams.ts
│   │       ├── github.ts
│   │       └── seeding.ts
│   │
│   ├── config/
│   │   ├── types.ts
│   │   ├── schemas.ts
│   │   ├── config-service.ts
│   │   ├── validate-secrets.ts
│   │   └── hot-reload.ts
│   │
│   └── state-machines/
│       ├── agent-lifecycle/
│       │   ├── types.ts
│       │   ├── events.ts
│       │   ├── guards.ts
│       │   ├── actions.ts
│       │   └── machine.ts
│       ├── task-workflow/
│       ├── session-lifecycle/
│       └── worktree-lifecycle/
│
└── app/
    └── providers/
        └── bootstrap-provider.tsx
```

## Testing Strategy

### Unit Tests (~376 tests)

| Component | Test Count |
|-----------|------------|
| Result utilities | 8 |
| Deep merge | 6 |
| Error types | 44 |
| Database schemas | 84 |
| Config validation | 65 |
| Bootstrap phases | 65 |
| State machines | 100 |
| Test infrastructure | 4 |

### Coverage Targets

```typescript
thresholds: {
  statements: 80,
  branches: 80,
  functions: 80,
  lines: 80,
}
```
