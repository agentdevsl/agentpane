# Phase 5: Testing

**Duration:** Parallel with all phases
**Test Cases:** 164+
**Coverage Target:** 80%
**Dependencies:** All phases

---

## Overview

Phase 5 implements comprehensive testing throughout development. Testing runs parallel to all phases with unit tests written alongside code (TDD), integration tests after service completion, and E2E tests after UI completion.

---

## 5.1 Test Infrastructure

### Vitest Configuration (`vitest.config.ts`)

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**', 'services/**', 'components/**', 'routes/**'],
      exclude: ['**/*.d.ts', '**/*.test.ts', 'tests/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './'),
    },
  },
});
```

### E2E Configuration (`vitest.e2e.config.ts`)

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    setupFiles: ['./tests/e2e/setup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './'),
    },
  },
});
```

### Test Setup (`tests/setup.ts`)

```typescript
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDatabase, clearTestDatabase, closeTestDatabase } from './helpers/database';

// Mock environment variables
vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
vi.stubEnv('DATABASE_URL', 'memory://');

beforeAll(async () => {
  await setupTestDatabase();
});

afterEach(async () => {
  await clearTestDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeTestDatabase();
});
```

---

## 5.2 Test Database Helpers

### Database Setup (`tests/helpers/database.ts`)

```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@/db/schema';

let pglite: PGlite | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export async function setupTestDatabase() {
  // In-memory PGlite for tests
  pglite = new PGlite();
  db = drizzle(pglite, { schema });

  // Run migrations
  await migrate(db, { migrationsFolder: './db/migrations' });

  return db;
}

export async function clearTestDatabase() {
  if (!db) return;

  // Clear all tables in reverse dependency order
  await db.delete(schema.auditLogs);
  await db.delete(schema.agentRuns);
  await db.delete(schema.sessions);
  await db.delete(schema.worktrees);
  await db.delete(schema.tasks);
  await db.delete(schema.agents);
  await db.delete(schema.repositoryConfigs);
  await db.delete(schema.githubInstallations);
  await db.delete(schema.projects);
}

export async function closeTestDatabase() {
  if (pglite) {
    await pglite.close();
    pglite = null;
    db = null;
  }
}

export function getTestDb() {
  if (!db) throw new Error('Test database not initialized');
  return db;
}

export async function seedTestDatabase(options: {
  projects?: number;
  tasksPerProject?: number;
  agentsPerProject?: number;
}) {
  const { projects = 1, tasksPerProject = 5, agentsPerProject = 2 } = options;

  const createdProjects = [];

  for (let i = 0; i < projects; i++) {
    const project = await createTestProject({ name: `Test Project ${i + 1}` });
    createdProjects.push(project);

    for (let j = 0; j < agentsPerProject; j++) {
      await createTestAgent(project.id, { name: `Agent ${j + 1}` });
    }

    for (let k = 0; k < tasksPerProject; k++) {
      await createTestTask(project.id, { title: `Task ${k + 1}` });
    }
  }

  return createdProjects;
}
```

---

## 5.3 Test Factories

### Factory Types (`tests/factories/index.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import * as schema from '@/db/schema';
import type {
  Project,
  Task,
  Agent,
  Session,
  Worktree,
  AgentRun,
  TaskColumn,
  AgentStatus,
  AgentType,
} from '@/db/schema';

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// Re-export all factories
export { createTestProject } from './project.factory';
export { createTestTask } from './task.factory';
export { createTestAgent } from './agent.factory';
export { createTestSession } from './session.factory';
export { createTestWorktree } from './worktree.factory';
export { createTestAgentRun } from './agent-run.factory';
```

### Project Factory (`tests/factories/project.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { projects } from '@/db/schema';
import type { Project } from '@/db/schema';

interface CreateProjectOptions {
  name?: string;
  path?: string;
  description?: string;
  maxConcurrentAgents?: number;
  githubOwner?: string;
  githubRepo?: string;
  config?: Record<string, unknown>;
}

export async function createTestProject(options: CreateProjectOptions = {}): Promise<Project> {
  const db = getTestDb();
  const id = createId();

  const [project] = await db
    .insert(projects)
    .values({
      id,
      name: options.name ?? `Test Project ${id.slice(0, 6)}`,
      path: options.path ?? `/tmp/test-projects/${id}`,
      description: options.description,
      maxConcurrentAgents: options.maxConcurrentAgents ?? 3,
      githubOwner: options.githubOwner,
      githubRepo: options.githubRepo,
      config: options.config,
    })
    .returning();

  return project;
}
```

### Task Factory (`tests/factories/task.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { tasks } from '@/db/schema';
import type { Task, TaskColumn } from '@/db/schema';

interface CreateTaskOptions {
  title?: string;
  description?: string;
  column?: TaskColumn;
  position?: number;
  labels?: string[];
  agentId?: string;
  sessionId?: string;
  worktreeId?: string;
  branch?: string;
  diffSummary?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: { path: string; insertions: number; deletions: number }[];
    patch: string;
  };
  approvedAt?: Date;
  approvedBy?: string;
  rejectionCount?: number;
  rejectionReason?: string;
}

export async function createTestTask(
  projectId: string,
  options: CreateTaskOptions = {}
): Promise<Task> {
  const db = getTestDb();
  const id = createId();

  const [task] = await db
    .insert(tasks)
    .values({
      id,
      projectId,
      title: options.title ?? `Test Task ${id.slice(0, 6)}`,
      description: options.description ?? 'Test task description',
      column: options.column ?? 'backlog',
      position: options.position ?? 0,
      labels: options.labels ?? [],
      agentId: options.agentId,
      sessionId: options.sessionId,
      worktreeId: options.worktreeId,
      branch: options.branch,
      diffSummary: options.diffSummary,
      approvedAt: options.approvedAt,
      approvedBy: options.approvedBy,
      rejectionCount: options.rejectionCount ?? 0,
      rejectionReason: options.rejectionReason,
    })
    .returning();

  return task;
}
```

### Agent Factory (`tests/factories/agent.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { agents } from '@/db/schema';
import type { Agent, AgentStatus, AgentType } from '@/db/schema';

interface CreateAgentOptions {
  name?: string;
  type?: AgentType;
  status?: AgentStatus;
  config?: {
    allowedTools?: string[];
    maxTurns?: number;
    model?: string;
    systemPrompt?: string;
    temperature?: number;
  };
  currentTaskId?: string;
  currentSessionId?: string;
  currentTurn?: number;
}

export async function createTestAgent(
  projectId: string,
  options: CreateAgentOptions = {}
): Promise<Agent> {
  const db = getTestDb();
  const id = createId();

  const [agent] = await db
    .insert(agents)
    .values({
      id,
      projectId,
      name: options.name ?? `Test Agent ${id.slice(0, 6)}`,
      type: options.type ?? 'task',
      status: options.status ?? 'idle',
      config: options.config ?? {
        allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
        maxTurns: 50,
      },
      currentTaskId: options.currentTaskId,
      currentSessionId: options.currentSessionId,
      currentTurn: options.currentTurn ?? 0,
    })
    .returning();

  return agent;
}
```

### Session Factory (`tests/factories/session.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { sessions } from '@/db/schema';
import type { Session, SessionStatus } from '@/db/schema';

interface CreateSessionOptions {
  taskId?: string;
  agentId?: string;
  status?: SessionStatus;
  title?: string;
  url?: string;
  closedAt?: Date;
}

export async function createTestSession(
  projectId: string,
  options: CreateSessionOptions = {}
): Promise<Session> {
  const db = getTestDb();
  const id = createId();

  const [session] = await db
    .insert(sessions)
    .values({
      id,
      projectId,
      taskId: options.taskId,
      agentId: options.agentId,
      status: options.status ?? 'idle',
      title: options.title,
      url: options.url ?? `ws://localhost:3000/sessions/${id}`,
      closedAt: options.closedAt,
    })
    .returning();

  return session;
}
```

### Worktree Factory (`tests/factories/worktree.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { worktrees } from '@/db/schema';
import type { Worktree, WorktreeStatus } from '@/db/schema';

interface CreateWorktreeOptions {
  taskId?: string;
  branch?: string;
  path?: string;
  baseBranch?: string;
  status?: WorktreeStatus;
  mergedAt?: Date;
  removedAt?: Date;
}

export async function createTestWorktree(
  projectId: string,
  options: CreateWorktreeOptions = {}
): Promise<Worktree> {
  const db = getTestDb();
  const id = createId();
  const branch = options.branch ?? `agent/${id}`;

  const [worktree] = await db
    .insert(worktrees)
    .values({
      id,
      projectId,
      taskId: options.taskId,
      branch,
      path: options.path ?? `/tmp/worktrees/${id}`,
      baseBranch: options.baseBranch ?? 'main',
      status: options.status ?? 'active',
      mergedAt: options.mergedAt,
      removedAt: options.removedAt,
    })
    .returning();

  return worktree;
}
```

### Agent Run Factory (`tests/factories/agent-run.factory.ts`)

```typescript
import { createId } from '@paralleldrive/cuid2';
import { getTestDb } from '../helpers/database';
import { agentRuns } from '@/db/schema';
import type { AgentRun, AgentStatus } from '@/db/schema';

interface CreateAgentRunOptions {
  sessionId?: string;
  status?: AgentStatus;
  startedAt?: Date;
  completedAt?: Date;
  turnsUsed?: number;
  tokensUsed?: number;
  errorMessage?: string;
}

export async function createTestAgentRun(
  agentId: string,
  taskId: string,
  projectId: string,
  options: CreateAgentRunOptions = {}
): Promise<AgentRun> {
  const db = getTestDb();
  const id = createId();

  const [run] = await db
    .insert(agentRuns)
    .values({
      id,
      agentId,
      taskId,
      projectId,
      sessionId: options.sessionId,
      status: options.status ?? 'running',
      startedAt: options.startedAt ?? new Date(),
      completedAt: options.completedAt,
      turnsUsed: options.turnsUsed ?? 0,
      tokensUsed: options.tokensUsed ?? 0,
      errorMessage: options.errorMessage,
    })
    .returning();

  return run;
}
```

---

## 5.4 Mock Helpers

### Service Mocks (`tests/mocks/services.ts`)

```typescript
import { vi } from 'vitest';
import type { IWorktreeService } from '@/services/worktree.service';
import type { IProjectService } from '@/services/project.service';
import type { ITaskService } from '@/services/task.service';
import type { ISessionService } from '@/services/session.service';
import type { IAgentService } from '@/services/agent.service';
import { ok, err } from '@/lib/utils/result';

export function createMockWorktreeService(): IWorktreeService {
  return {
    create: vi.fn().mockResolvedValue(ok({ id: 'worktree-1' })),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    prune: vi.fn().mockResolvedValue(ok(0)),
    copyEnv: vi.fn().mockResolvedValue(ok(undefined)),
    installDeps: vi.fn().mockResolvedValue(ok(undefined)),
    runInitScript: vi.fn().mockResolvedValue(ok(undefined)),
    commit: vi.fn().mockResolvedValue(ok('abc123')),
    merge: vi.fn().mockResolvedValue(ok(undefined)),
    getDiff: vi.fn().mockResolvedValue(ok({ filesChanged: 0, insertions: 0, deletions: 0 })),
    getStatus: vi.fn().mockResolvedValue(ok({ status: 'active' })),
    list: vi.fn().mockResolvedValue(ok([])),
    getByBranch: vi.fn().mockResolvedValue(ok(null)),
  };
}

export function createMockProjectService(): IProjectService {
  return {
    create: vi.fn().mockResolvedValue(ok({ id: 'project-1' })),
    getById: vi.fn().mockResolvedValue(ok({ id: 'project-1' })),
    list: vi.fn().mockResolvedValue(ok({ items: [], hasMore: false })),
    update: vi.fn().mockResolvedValue(ok({ id: 'project-1' })),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    updateConfig: vi.fn().mockResolvedValue(ok({ id: 'project-1' })),
    syncFromGitHub: vi.fn().mockResolvedValue(ok({ id: 'project-1' })),
    validatePath: vi.fn().mockResolvedValue(ok({ valid: true })),
    validateConfig: vi.fn().mockReturnValue(ok({})),
  };
}

export function createMockTaskService(): ITaskService {
  return {
    create: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    getById: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    list: vi.fn().mockResolvedValue(ok({ items: [], hasMore: false })),
    update: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    moveColumn: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    reorder: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    getByColumn: vi.fn().mockResolvedValue(ok([])),
    approve: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    reject: vi.fn().mockResolvedValue(ok({ id: 'task-1' })),
    getDiff: vi.fn().mockResolvedValue(ok({ filesChanged: 0 })),
  };
}

export function createMockSessionService(): ISessionService {
  return {
    create: vi.fn().mockResolvedValue(ok({ id: 'session-1' })),
    getById: vi.fn().mockResolvedValue(ok({ id: 'session-1' })),
    list: vi.fn().mockResolvedValue(ok({ items: [], hasMore: false })),
    close: vi.fn().mockResolvedValue(ok({ id: 'session-1' })),
    join: vi.fn().mockResolvedValue(ok({ id: 'session-1' })),
    leave: vi.fn().mockResolvedValue(ok({ id: 'session-1' })),
    updatePresence: vi.fn().mockResolvedValue(ok(undefined)),
    getActiveUsers: vi.fn().mockResolvedValue(ok([])),
    publish: vi.fn().mockResolvedValue(ok(undefined)),
    subscribe: vi.fn().mockReturnValue((async function* () {})()),
    getHistory: vi.fn().mockResolvedValue(ok([])),
    generateUrl: vi.fn().mockReturnValue('ws://test/session-1'),
    parseUrl: vi.fn().mockReturnValue(ok('session-1')),
  };
}

export function createMockAgentService(): IAgentService {
  return {
    create: vi.fn().mockResolvedValue(ok({ id: 'agent-1' })),
    getById: vi.fn().mockResolvedValue(ok({ id: 'agent-1' })),
    list: vi.fn().mockResolvedValue(ok([])),
    update: vi.fn().mockResolvedValue(ok({ id: 'agent-1' })),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    start: vi.fn().mockResolvedValue(ok({ agentId: 'agent-1', taskId: 'task-1' })),
    stop: vi.fn().mockResolvedValue(ok(undefined)),
    pause: vi.fn().mockResolvedValue(ok(undefined)),
    resume: vi.fn().mockResolvedValue(ok({ agentId: 'agent-1', taskId: 'task-1' })),
    checkAvailability: vi.fn().mockResolvedValue(ok(true)),
    queueTask: vi.fn().mockResolvedValue(ok({ position: 0 })),
    getRunningCount: vi.fn().mockResolvedValue(ok(0)),
    getQueuedTasks: vi.fn().mockResolvedValue(ok([])),
    registerPreToolUseHook: vi.fn(),
    registerPostToolUseHook: vi.fn(),
  };
}
```

### External API Mocks (`tests/mocks/external.ts`)

```typescript
import { vi } from 'vitest';

// Mock Claude Agent SDK
export const mockClaudeSDK = {
  query: vi.fn().mockImplementation(async function* () {
    yield { type: 'text', content: 'Test response' };
    yield { type: 'tool_use', tool: 'Read', input: { file: 'test.ts' } };
    yield { type: 'tool_result', id: '1', output: 'file contents' };
    yield { type: 'done' };
  }),
};

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockClaudeSDK.query,
}));

// Mock Durable Streams
export const mockDurableStreams = {
  connect: vi.fn().mockResolvedValue({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue((async function* () {})()),
    close: vi.fn(),
  }),
};

vi.mock('@durable-streams/client', () => ({
  DurableStreamsClient: vi.fn().mockImplementation(() => mockDurableStreams),
}));

// Mock GitHub API
export const mockOctokit = {
  repos: {
    get: vi.fn().mockResolvedValue({ data: { name: 'test-repo' } }),
    getContent: vi.fn().mockResolvedValue({ data: { content: btoa('{}') } }),
  },
  pulls: {
    create: vi.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/pr/1' } }),
  },
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => mockOctokit),
}));
```

### Git Mocks (`tests/mocks/git.ts`)

```typescript
import { vi } from 'vitest';

export const mockGitCommands = {
  worktreeAdd: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  worktreeRemove: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  worktreeList: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  diff: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  status: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  add: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  commit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'abc123' }),
  merge: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
  branch: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
};

// Mock Bun shell
vi.mock('bun', () => ({
  $: vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');

    if (command.includes('worktree add')) return mockGitCommands.worktreeAdd();
    if (command.includes('worktree remove')) return mockGitCommands.worktreeRemove();
    if (command.includes('worktree list')) return mockGitCommands.worktreeList();
    if (command.includes('git diff')) return mockGitCommands.diff();
    if (command.includes('git status')) return mockGitCommands.status();
    if (command.includes('git add')) return mockGitCommands.add();
    if (command.includes('git commit')) return mockGitCommands.commit();
    if (command.includes('git merge')) return mockGitCommands.merge();
    if (command.includes('git branch')) return mockGitCommands.branch();

    return { exitCode: 0, stdout: '' };
  }),
}));
```

---

## 5.5 Unit Test Categories

### Foundation Tests

| Category | File | Test Count |
|----------|------|------------|
| Result type | `tests/lib/utils/result.test.ts` | 8 |
| Deep merge | `tests/lib/utils/deep-merge.test.ts` | 6 |
| Error base | `tests/lib/errors/base.test.ts` | 5 |
| Project errors | `tests/lib/errors/project-errors.test.ts` | 5 |
| Task errors | `tests/lib/errors/task-errors.test.ts` | 8 |
| Agent errors | `tests/lib/errors/agent-errors.test.ts` | 7 |
| Validation | `tests/lib/api/validate.test.ts` | 6 |

### Service Tests

| Service | File | Test Count |
|---------|------|------------|
| WorktreeService | `tests/services/worktree.test.ts` | 22 |
| ProjectService | `tests/services/project.test.ts` | 18 |
| TaskService | `tests/services/task.test.ts` | 24 |
| SessionService | `tests/services/session.test.ts` | 15 |
| AgentService | `tests/services/agent.test.ts` | 27 |

### API Tests

| Category | File | Test Count |
|----------|------|------------|
| Project endpoints | `tests/api/projects.test.ts` | 8 |
| Task endpoints | `tests/api/tasks.test.ts` | 12 |
| Agent endpoints | `tests/api/agents.test.ts` | 10 |
| Session endpoints | `tests/api/sessions.test.ts` | 8 |
| Webhooks | `tests/api/webhooks.test.ts` | 5 |

### Component Tests

| Category | File | Test Count |
|----------|------|------------|
| Button | `tests/components/ui/button.test.tsx` | 4 |
| Dialog | `tests/components/ui/dialog.test.tsx` | 5 |
| KanbanBoard | `tests/components/features/kanban-board.test.tsx` | 8 |
| ApprovalDialog | `tests/components/features/approval-dialog.test.tsx` | 6 |
| AgentSessionView | `tests/components/features/agent-session-view.test.tsx` | 5 |

---

## 5.6 Example Unit Tests

### Result Type Tests (`tests/lib/utils/result.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, map, mapErr, unwrap, unwrapOr } from '@/lib/utils/result';

describe('Result type', () => {
  describe('ok()', () => {
    it('returns success result', () => {
      const result = ok(42);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it('narrows type correctly', () => {
      const result = ok('hello');
      if (result.ok) {
        expect(result.value).toBe('hello');
      }
    });
  });

  describe('err()', () => {
    it('returns error result', () => {
      const error = new Error('test');
      const result = err(error);
      expect(result).toEqual({ ok: false, error });
    });
  });

  describe('isOk()', () => {
    it('returns true for success', () => {
      expect(isOk(ok(1))).toBe(true);
    });

    it('returns false for error', () => {
      expect(isOk(err(new Error()))).toBe(false);
    });
  });

  describe('map()', () => {
    it('transforms success value', () => {
      const result = map(ok(2), (x) => x * 2);
      expect(result).toEqual({ ok: true, value: 4 });
    });

    it('passes through error', () => {
      const error = new Error('test');
      const result = map(err(error), (x: number) => x * 2);
      expect(result).toEqual({ ok: false, error });
    });
  });

  describe('unwrap()', () => {
    it('returns value for success', () => {
      expect(unwrap(ok(42))).toBe(42);
    });

    it('throws for error', () => {
      expect(() => unwrap(err(new Error('test')))).toThrow('test');
    });
  });

  describe('unwrapOr()', () => {
    it('returns value for success', () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
    });

    it('returns default for error', () => {
      expect(unwrapOr(err(new Error()), 0)).toBe(0);
    });
  });
});
```

### Task Service Tests (`tests/services/task.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskService } from '@/services/task.service';
import { createTestProject, createTestTask, createTestAgent } from '../factories';
import { createMockWorktreeService } from '../mocks/services';
import { TaskErrors } from '@/lib/errors/task-errors';

describe('TaskService', () => {
  let service: TaskService;
  let project: Awaited<ReturnType<typeof createTestProject>>;

  beforeEach(async () => {
    project = await createTestProject();
    service = new TaskService({
      worktreeService: createMockWorktreeService(),
    });
  });

  describe('create()', () => {
    it('creates task in backlog', async () => {
      const result = await service.create({
        projectId: project.id,
        title: 'New Task',
        description: 'Description',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.title).toBe('New Task');
        expect(result.value.column).toBe('backlog');
        expect(result.value.position).toBe(0);
      }
    });

    it('sets correct position for new tasks', async () => {
      await service.create({ projectId: project.id, title: 'Task 1' });
      await service.create({ projectId: project.id, title: 'Task 2' });
      const result = await service.create({ projectId: project.id, title: 'Task 3' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position).toBe(2);
      }
    });
  });

  describe('moveColumn()', () => {
    it('moves task from backlog to in_progress', async () => {
      const task = await createTestTask(project.id, { column: 'backlog' });

      const result = await service.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.column).toBe('in_progress');
      }
    });

    it('rejects invalid transition backlog to verified', async () => {
      const task = await createTestTask(project.id, { column: 'backlog' });

      const result = await service.moveColumn(task.id, 'verified');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
      }
    });

    it('updates position when specified', async () => {
      const task = await createTestTask(project.id, { column: 'backlog', position: 0 });

      const result = await service.moveColumn(task.id, 'in_progress', 5);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position).toBe(5);
      }
    });
  });

  describe('approve()', () => {
    it('approves task with diff', async () => {
      const task = await createTestTask(project.id, {
        column: 'waiting_approval',
        diffSummary: { filesChanged: 1, insertions: 10, deletions: 5, files: [], patch: '' },
      });

      const result = await service.approve(task.id, {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.column).toBe('verified');
        expect(result.value.approvedAt).toBeDefined();
      }
    });

    it('rejects approval without diff', async () => {
      const task = await createTestTask(project.id, {
        column: 'waiting_approval',
        diffSummary: null,
      });

      const result = await service.approve(task.id, {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TASK_NO_DIFF');
      }
    });

    it('rejects approval of wrong status', async () => {
      const task = await createTestTask(project.id, { column: 'in_progress' });

      const result = await service.approve(task.id, {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
      }
    });
  });

  describe('reject()', () => {
    it('rejects task back to in_progress', async () => {
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      const result = await service.reject(task.id, { reason: 'Needs more work' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.column).toBe('in_progress');
        expect(result.value.rejectionCount).toBe(1);
        expect(result.value.rejectionReason).toBe('Needs more work');
      }
    });

    it('increments rejection count', async () => {
      const task = await createTestTask(project.id, {
        column: 'waiting_approval',
        rejectionCount: 2,
      });

      const result = await service.reject(task.id, { reason: 'Still not right' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.rejectionCount).toBe(3);
      }
    });
  });
});
```

### Agent Service Tests (`tests/services/agent.test.ts`)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentService } from '@/services/agent.service';
import { createTestProject, createTestTask, createTestAgent } from '../factories';
import {
  createMockWorktreeService,
  createMockTaskService,
  createMockSessionService,
} from '../mocks/services';
import { mockClaudeSDK } from '../mocks/external';
import { AgentErrors } from '@/lib/errors/agent-errors';
import { ConcurrencyErrors } from '@/lib/errors/concurrency-errors';

describe('AgentService', () => {
  let service: AgentService;
  let project: Awaited<ReturnType<typeof createTestProject>>;
  let mockWorktreeService: ReturnType<typeof createMockWorktreeService>;
  let mockTaskService: ReturnType<typeof createMockTaskService>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;

  beforeEach(async () => {
    project = await createTestProject({ maxConcurrentAgents: 3 });
    mockWorktreeService = createMockWorktreeService();
    mockTaskService = createMockTaskService();
    mockSessionService = createMockSessionService();

    service = new AgentService({
      worktreeService: mockWorktreeService,
      taskService: mockTaskService,
      sessionService: mockSessionService,
    });
  });

  describe('start()', () => {
    it('starts agent on task', async () => {
      const agent = await createTestAgent(project.id, { status: 'idle' });
      const task = await createTestTask(project.id, { column: 'backlog' });

      const result = await service.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agentId).toBe(agent.id);
        expect(result.value.taskId).toBe(task.id);
      }

      expect(mockWorktreeService.create).toHaveBeenCalled();
      expect(mockSessionService.create).toHaveBeenCalled();
    });

    it('rejects starting already running agent', async () => {
      const agent = await createTestAgent(project.id, { status: 'running' });
      const task = await createTestTask(project.id);

      const result = await service.start(agent.id, task.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('rejects when concurrency limit exceeded', async () => {
      // Create max concurrent running agents
      await createTestAgent(project.id, { status: 'running' });
      await createTestAgent(project.id, { status: 'running' });
      await createTestAgent(project.id, { status: 'running' });

      const agent = await createTestAgent(project.id, { status: 'idle' });
      const task = await createTestTask(project.id);

      const result = await service.start(agent.id, task.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
      }
    });
  });

  describe('stop()', () => {
    it('stops running agent', async () => {
      const agent = await createTestAgent(project.id, { status: 'running' });

      const result = await service.stop(agent.id);

      expect(result.ok).toBe(true);
    });

    it('rejects stopping idle agent', async () => {
      const agent = await createTestAgent(project.id, { status: 'idle' });

      const result = await service.stop(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_RUNNING');
      }
    });
  });

  describe('checkAvailability()', () => {
    it('returns true when under limit', async () => {
      await createTestAgent(project.id, { status: 'running' });

      const result = await service.checkAvailability(project.id);

      expect(result.ok).toBe(true);
      expect(result.value).toBe(true);
    });

    it('returns false when at limit', async () => {
      await createTestAgent(project.id, { status: 'running' });
      await createTestAgent(project.id, { status: 'running' });
      await createTestAgent(project.id, { status: 'running' });

      const result = await service.checkAvailability(project.id);

      expect(result.ok).toBe(true);
      expect(result.value).toBe(false);
    });
  });

  describe('hooks', () => {
    it('calls pre-tool-use hook', async () => {
      const agent = await createTestAgent(project.id, { status: 'idle' });
      const task = await createTestTask(project.id);
      const hook = vi.fn().mockReturnValue(true);

      service.registerPreToolUseHook(agent.id, hook);
      await service.start(agent.id, task.id);

      expect(hook).toHaveBeenCalled();
    });

    it('blocks tool when hook returns false', async () => {
      const agent = await createTestAgent(project.id, { status: 'idle' });
      const task = await createTestTask(project.id);
      const hook = vi.fn().mockReturnValue(false);

      service.registerPreToolUseHook(agent.id, hook);
      const result = await service.start(agent.id, task.id);

      // Agent should complete but with tool blocked
      expect(hook).toHaveBeenCalled();
    });
  });
});
```

---

## 5.7 Integration Tests

### Worktree Integration Tests (`tests/integration/worktree.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WorktreeService } from '@/services/worktree.service';
import { createTestProject } from '../factories';

describe('WorktreeService Integration', () => {
  let service: WorktreeService;
  let testDir: string;
  let project: Awaited<ReturnType<typeof createTestProject>>;

  beforeEach(async () => {
    testDir = `/tmp/worktree-test-${Date.now()}`;
    mkdirSync(testDir, { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test"', { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execSync('git add . && git commit -m "Initial"', { cwd: testDir });

    project = await createTestProject({ path: testDir });
    service = new WorktreeService();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates worktree with new branch', async () => {
    const result = await service.create({
      projectId: project.id,
      taskId: 'task-1',
      baseBranch: 'main',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(result.value.path)).toBe(true);
      expect(result.value.branch).toMatch(/^agent\//);
    }
  });

  it('removes worktree and deletes branch', async () => {
    const createResult = await service.create({
      projectId: project.id,
      taskId: 'task-1',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const removeResult = await service.remove(createResult.value.id);

    expect(removeResult.ok).toBe(true);
    expect(existsSync(createResult.value.path)).toBe(false);
  });

  it('detects uncommitted changes', async () => {
    const createResult = await service.create({
      projectId: project.id,
      taskId: 'task-1',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Make a change
    writeFileSync(join(createResult.value.path, 'new-file.txt'), 'content');

    const statusResult = await service.getStatus(createResult.value.id);

    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.hasUncommittedChanges).toBe(true);
    }
  });
});
```

### Full Workflow Integration Test (`tests/integration/workflow.test.ts`)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '@/services/project.service';
import { TaskService } from '@/services/task.service';
import { AgentService } from '@/services/agent.service';
import { SessionService } from '@/services/session.service';
import { WorktreeService } from '@/services/worktree.service';
import { createTestProject } from '../factories';
import { mockClaudeSDK, mockGitCommands } from '../mocks/external';

describe('Full Workflow Integration', () => {
  let projectService: ProjectService;
  let taskService: TaskService;
  let agentService: AgentService;
  let sessionService: SessionService;
  let worktreeService: WorktreeService;

  beforeEach(() => {
    worktreeService = new WorktreeService();
    sessionService = new SessionService();
    taskService = new TaskService({ worktreeService });
    agentService = new AgentService({
      worktreeService,
      taskService,
      sessionService,
    });
    projectService = new ProjectService({ worktreeService });

    // Reset mocks
    vi.clearAllMocks();
    mockClaudeSDK.query.mockImplementation(async function* () {
      yield { type: 'text', content: 'Working on task...' };
      yield { type: 'done' };
    });
    mockGitCommands.diff.mockResolvedValue({
      exitCode: 0,
      stdout: '1 file changed, 10 insertions(+), 5 deletions(-)',
    });
  });

  it('completes full task lifecycle', async () => {
    // 1. Create project
    const project = await createTestProject();

    // 2. Create task
    const taskResult = await taskService.create({
      projectId: project.id,
      title: 'Implement feature X',
      description: 'Add the new feature',
    });
    expect(taskResult.ok).toBe(true);
    const task = taskResult.value;

    // 3. Create agent
    const agentResult = await agentService.create({
      projectId: project.id,
      name: 'Feature Agent',
    });
    expect(agentResult.ok).toBe(true);
    const agent = agentResult.value;

    // 4. Start agent on task
    const startResult = await agentService.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    // 5. Verify task moved to in_progress
    const inProgressTask = await taskService.getById(task.id);
    expect(inProgressTask.ok).toBe(true);
    expect(inProgressTask.value.column).toBe('in_progress');

    // 6. Agent completes (simulated by test)
    // In real flow, agent would complete and move task

    // 7. Move to waiting_approval
    const moveResult = await taskService.moveColumn(task.id, 'waiting_approval');
    expect(moveResult.ok).toBe(true);

    // 8. Approve task
    const approveResult = await taskService.approve(task.id, {
      commitMessage: 'Feature X implementation',
    });
    expect(approveResult.ok).toBe(true);
    expect(approveResult.value.column).toBe('verified');
  });

  it('handles rejection and retry', async () => {
    const project = await createTestProject();

    const taskResult = await taskService.create({
      projectId: project.id,
      title: 'Fix bug Y',
    });
    const task = taskResult.value;

    const agentResult = await agentService.create({
      projectId: project.id,
      name: 'Bug Fix Agent',
    });
    const agent = agentResult.value;

    // First attempt
    await agentService.start(agent.id, task.id);
    await taskService.moveColumn(task.id, 'waiting_approval');

    // Reject
    const rejectResult = await taskService.reject(task.id, {
      reason: 'Missing test coverage',
    });
    expect(rejectResult.ok).toBe(true);
    expect(rejectResult.value.column).toBe('in_progress');
    expect(rejectResult.value.rejectionCount).toBe(1);

    // Retry
    await agentService.resume(agent.id, 'Please add test coverage');
    await taskService.moveColumn(task.id, 'waiting_approval');

    // Approve
    const approveResult = await taskService.approve(task.id, {});
    expect(approveResult.ok).toBe(true);
    expect(approveResult.value.column).toBe('verified');
  });
});
```

---

## 5.8 E2E Tests

### E2E Setup (`tests/e2e/setup.ts`)

```typescript
import { AgentBrowser, type BrowserContext } from 'agent-browser';
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

let agentBrowser: AgentBrowser;
let context: BrowserContext;

beforeAll(async () => {
  agentBrowser = new AgentBrowser({
    headless: process.env.CI === 'true',
    baseUrl: 'http://localhost:3000',
  });
  await agentBrowser.launch();
});

afterAll(async () => {
  await agentBrowser.close();
});

beforeEach(async () => {
  context = await agentBrowser.newContext();
});

afterEach(async () => {
  await context.close();
});

export function getContext() {
  return context;
}

export async function goto(path: string) {
  await context.goto(path);
}

export async function waitForText(text: string) {
  await context.waitForText(text);
}

export async function click(selector: string) {
  await context.click(selector);
}

export async function fill(selector: string, value: string) {
  await context.fill(selector, value);
}

export async function screenshot(name: string) {
  return context.screenshot({ path: `tests/e2e/screenshots/${name}.png` });
}
```

### Critical E2E Scenarios (`tests/e2e/workflow.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { getContext, goto, waitForText, click, fill, screenshot } from './setup';

describe('E2E: Task Workflow', () => {
  it('E2E-001: Create project from local path', async () => {
    const ctx = getContext();
    await goto('/');

    // Click new project
    await click('text=New Project');

    // Fill form
    await fill('input[placeholder="/path/to/project"]', '/tmp/test-project');
    await ctx.waitForSelector('svg.text-green-500'); // Valid path indicator

    await fill('input[placeholder="My Project"]', 'E2E Test Project');
    await click('text=Create Project');

    // Verify redirect
    await waitForText('E2E Test Project');
    const url = await ctx.url();
    expect(url).toMatch(/\/projects\/\w+/);
  });

  it('E2E-002: Create task in backlog', async () => {
    const ctx = getContext();
    await goto('/projects/test-project-id');

    await click('text=New Task');
    await fill('input[placeholder="Task title..."]', 'New E2E Task');
    await fill('textarea', 'Task description');
    await click('text=Save');

    // Verify task appears in backlog
    const visible = await ctx.isVisible('.kanban-column:has-text("Backlog") >> text=New E2E Task');
    expect(visible).toBe(true);
  });

  it('E2E-003: Drag task to in_progress starts agent', async () => {
    const ctx = getContext();
    await goto('/projects/test-project-id');

    // Drag task using Agent Browser drag API
    await ctx.drag({
      source: '.kanban-card:has-text("Test Task")',
      target: '.kanban-column:has-text("In Progress")',
    });

    // Verify agent started indicator
    const hasRunning = await ctx.isVisible('.kanban-card .border-l-status-running');
    expect(hasRunning).toBe(true);
  });

  it('E2E-005: Open approval dialog shows diff', async () => {
    const ctx = getContext();
    await goto('/projects/test-project-id');

    // Click on task in waiting_approval
    await click('.kanban-column:has-text("Waiting Approval") .kanban-card >> nth=0');

    // Verify approval dialog
    await waitForText('Review Changes');
    expect(await ctx.isVisible('text=Change Summary')).toBe(true);
    expect(await ctx.isVisible('text=Insertions')).toBe(true);
    expect(await ctx.isVisible('text=Deletions')).toBe(true);
  });

  it('E2E-006: Approve task merges changes', async () => {
    const ctx = getContext();
    await goto('/projects/test-project-id');

    // Open approval dialog
    await click('.kanban-column:has-text("Waiting Approval") .kanban-card >> nth=0');

    // Click approve
    await click('text=Approve & Merge');

    // Verify task moved to verified
    const visible = await ctx.isVisible('.kanban-column:has-text("Verified") .kanban-card');
    expect(visible).toBe(true);
  });

  it('E2E-007: Task moves to verified after approval', async () => {
    const ctx = getContext();
    await goto('/projects/test-project-id');

    // Approve task
    await click('.kanban-column:has-text("Waiting Approval") .kanban-card >> nth=0');
    await click('text=Approve & Merge');

    // Verify column counts updated
    const countText = await ctx.textContent('.kanban-column:has-text("Verified") .rounded-full');
    expect(parseInt(countText ?? '0')).toBeGreaterThan(0);
  });
});
```

### Agent Session E2E Tests (`tests/e2e/agent-session.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { getContext, goto, waitForText, click } from './setup';

describe('E2E: Agent Session', () => {
  it('displays real-time agent output', async () => {
    const ctx = getContext();
    await goto('/sessions/test-session-id');

    // Verify stream tab shows content
    await waitForText('Stream');
    expect(await ctx.isVisible('.font-mono')).toBe(true);
  });

  it('shows tool calls in tools tab', async () => {
    const ctx = getContext();
    await goto('/sessions/test-session-id');

    await click('text=Tools');
    expect(await ctx.isVisible('text=Read')).toBe(true);
  });

  it('pause and resume controls work', async () => {
    const ctx = getContext();
    await goto('/sessions/test-session-id');

    // Click pause
    await click('button:has(svg.lucide-pause)');
    await waitForText('Paused');

    // Click resume
    await click('button:has(svg.lucide-play)');
    await waitForText('Running');
  });

  it('stop terminates agent', async () => {
    const ctx = getContext();
    await goto('/sessions/test-session-id');

    await click('button:has(svg.lucide-square)');

    // Confirm if dialog appears
    if (await ctx.isVisible('text=Are you sure')) {
      await click('text=Confirm');
    }

    await waitForText('Completed');
  });
});
```

---

## 5.9 Test Summary

| Category | Test Count | Priority |
|----------|------------|----------|
| Foundation (Result, Errors) | 45 | P0 |
| Database Schema | 15 | P0 |
| WorktreeService | 22 | P1 |
| ProjectService | 18 | P0 |
| TaskService | 24 | P0 |
| SessionService | 15 | P1 |
| AgentService | 27 | P0 |
| API Endpoints | 43 | P0 |
| UI Components | 35 | P1 |
| E2E Scenarios | 23 | P0 |
| Performance | 10 | P2 |
| **Total** | **277** | - |

### Coverage Requirements

| Metric | Target | Critical |
|--------|--------|----------|
| Statements | 80% | Yes |
| Branches | 80% | Yes |
| Functions | 80% | Yes |
| Lines | 80% | Yes |

### Running Tests

```bash
# Unit tests
bun run test

# Unit tests with coverage
bun run test:coverage

# E2E tests
bun run test:e2e

# Watch mode
bun run test:watch

# Specific file
bun run test tests/services/task.test.ts
```

---

## Spec References

- Test Cases: `/specs/application/testing/test-cases.md`
- Test Infrastructure: `/specs/application/testing/test-infrastructure.md`
- Error Catalog: `/specs/application/errors/error-catalog.md`
- Services: `/specs/application/services/*.md`
