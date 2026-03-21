import { createId } from '@paralleldrive/cuid2';
import { vi } from 'vitest';
import type { Agent, Task, TaskColumn, Worktree } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';

// Mock Project Service
export type MockProjectService = {
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listWithSummaries: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  syncFromGitHub: ReturnType<typeof vi.fn>;
  validatePath: ReturnType<typeof vi.fn>;
  validateConfig: ReturnType<typeof vi.fn>;
};

export function createMockProjectService(
  overrides: Partial<MockProjectService> = {}
): MockProjectService {
  const defaultProject: Project = {
    id: createId(),
    name: 'Mock Project',
    path: '/tmp/mock-project',
    description: null,
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Write'],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultProject)),
    getById: vi.fn().mockResolvedValue(ok(defaultProject)),
    list: vi.fn().mockResolvedValue(ok([defaultProject])),
    listWithSummaries: vi.fn().mockResolvedValue(
      ok([
        {
          project: defaultProject,
          taskCounts: {
            backlog: 0,
            queued: 0,
            inProgress: 0,
            waitingApproval: 0,
            verified: 0,
            total: 0,
          },
          runningAgents: [],
          status: 'idle' as const,
          lastActivityAt: null,
        },
      ])
    ),
    update: vi.fn().mockResolvedValue(ok(defaultProject)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    updateConfig: vi.fn().mockResolvedValue(ok(defaultProject)),
    syncFromGitHub: vi.fn().mockResolvedValue(ok(defaultProject)),
    validatePath: vi.fn().mockResolvedValue(
      ok({
        name: 'mock-project',
        path: '/tmp/mock-project',
        hasClaudeConfig: true,
        defaultBranch: 'main',
      })
    ),
    validateConfig: vi.fn().mockReturnValue(
      ok({
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read', 'Write'],
        maxTurns: 50,
      } as ProjectConfig)
    ),
    ...overrides,
  };
}

// Mock Task Service
export type MockTaskService = {
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  moveColumn: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
  getByColumn: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  getDiff: ReturnType<typeof vi.fn>;
};

export function createMockTaskService(overrides: Partial<MockTaskService> = {}): MockTaskService {
  const defaultTask: Task = {
    id: createId(),
    codespaceId: createId(),
    agentId: null,
    sessionId: null,
    worktreeId: null,
    title: 'Mock Task',
    description: null,
    column: 'backlog',
    position: 0,
    labels: [],
    branch: null,
    diffSummary: null,
    approvedAt: null,
    approvedBy: null,
    rejectionCount: 0,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultTask)),
    getById: vi.fn().mockResolvedValue(ok(defaultTask)),
    list: vi.fn().mockResolvedValue(ok([defaultTask])),
    update: vi.fn().mockResolvedValue(ok(defaultTask)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    moveColumn: vi
      .fn()
      .mockResolvedValue(ok({ ...defaultTask, column: 'in_progress' as TaskColumn })),
    reorder: vi.fn().mockResolvedValue(ok(defaultTask)),
    getByColumn: vi.fn().mockResolvedValue(ok([defaultTask])),
    approve: vi.fn().mockResolvedValue(ok({ ...defaultTask, column: 'verified' as TaskColumn })),
    reject: vi.fn().mockResolvedValue(ok({ ...defaultTask, column: 'in_progress' as TaskColumn })),
    getDiff: vi.fn().mockResolvedValue(
      ok({
        taskId: defaultTask.id,
        branch: 'agent/mock/task',
        baseBranch: 'main',
        files: [],
        summary: { filesChanged: 0, additions: 0, deletions: 0 },
      })
    ),
    ...overrides,
  };
}

// Mock Agent Service
export type MockAgentService = {
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listAll: ReturnType<typeof vi.fn>;
  getRunningCountAll: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  checkAvailability: ReturnType<typeof vi.fn>;
  queueTask: ReturnType<typeof vi.fn>;
  getRunningCount: ReturnType<typeof vi.fn>;
  getQueuedTasks: ReturnType<typeof vi.fn>;
};

export function createMockAgentService(
  overrides: Partial<MockAgentService> = {}
): MockAgentService {
  const defaultAgent: Agent = {
    id: createId(),
    codespaceId: createId(),
    name: 'Mock Agent',
    type: 'task',
    status: 'idle',
    config: {
      allowedTools: ['Read', 'Write'],
      maxTurns: 50,
    },
    currentTaskId: null,
    currentSessionId: null,
    currentTurn: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultAgent)),
    getById: vi.fn().mockResolvedValue(ok(defaultAgent)),
    list: vi.fn().mockResolvedValue(ok([defaultAgent])),
    listAll: vi.fn().mockResolvedValue(ok([defaultAgent])),
    getRunningCountAll: vi.fn().mockResolvedValue(ok(0)),
    update: vi.fn().mockResolvedValue(ok(defaultAgent)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    start: vi.fn().mockResolvedValue(
      ok({
        agent: { ...defaultAgent, status: 'running' },
        task: { id: createId(), title: 'Mock Task' },
        session: { id: createId() },
        worktree: { id: createId(), branch: 'agent/mock/task' },
      })
    ),
    stop: vi.fn().mockResolvedValue(ok(undefined)),
    pause: vi.fn().mockResolvedValue(ok(undefined)),
    resume: vi.fn().mockResolvedValue(
      ok({
        runId: createId(),
        status: 'paused' as const,
        turnCount: 10,
      })
    ),
    checkAvailability: vi.fn().mockResolvedValue(ok(true)),
    queueTask: vi
      .fn()
      .mockResolvedValue(ok({ taskId: createId(), position: 1, estimatedWaitMinutes: 5 })),
    getRunningCount: vi.fn().mockResolvedValue(ok(0)),
    getQueuedTasks: vi.fn().mockResolvedValue(ok([])),
    ...overrides,
  };
}

// Mock Session Service
export type MockSessionService = {
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  updatePresence: ReturnType<typeof vi.fn>;
  getActiveUsers: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  generateUrl: ReturnType<typeof vi.fn>;
  parseUrl: ReturnType<typeof vi.fn>;
};

export function createMockSessionService(
  overrides: Partial<MockSessionService> = {}
): MockSessionService {
  const sessionId = createId();
  const defaultSession = {
    id: sessionId,
    codespaceId: createId(),
    taskId: null,
    agentId: null,
    status: 'active',
    title: 'Mock Session',
    url: `http://localhost:3000/sessions/${sessionId}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    presence: [],
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultSession)),
    getById: vi.fn().mockResolvedValue(ok(defaultSession)),
    list: vi.fn().mockResolvedValue(ok([defaultSession])),
    close: vi
      .fn()
      .mockResolvedValue(ok({ ...defaultSession, status: 'closed', closedAt: new Date() })),
    join: vi.fn().mockResolvedValue(ok(defaultSession)),
    leave: vi.fn().mockResolvedValue(ok(defaultSession)),
    updatePresence: vi.fn().mockResolvedValue(ok(undefined)),
    getActiveUsers: vi.fn().mockResolvedValue(ok([])),
    publish: vi.fn().mockResolvedValue(ok({ offset: 1 })),
    subscribe: vi.fn().mockReturnValue(
      (async function* () {
        yield { id: createId(), type: 'chunk', timestamp: Date.now(), data: {} };
      })()
    ),
    getHistory: vi.fn().mockResolvedValue(ok([])),
    generateUrl: vi.fn().mockReturnValue(`http://localhost:3000/sessions/${sessionId}`),
    parseUrl: vi.fn().mockReturnValue(ok(sessionId)),
    ...overrides,
  };
}

// Mock Worktree Service
export type MockWorktreeService = {
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  prune: ReturnType<typeof vi.fn>;
  copyEnv: ReturnType<typeof vi.fn>;
  installDeps: ReturnType<typeof vi.fn>;
  runInitScript: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  getDiff: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getByBranch: ReturnType<typeof vi.fn>;
};

export function createMockWorktreeService(
  overrides: Partial<MockWorktreeService> = {}
): MockWorktreeService {
  const defaultWorktree: Worktree = {
    id: createId(),
    codespaceId: createId(),
    taskId: null,
    branch: 'agent/mock/task',
    path: '/tmp/worktree-mock',
    baseBranch: 'main',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    mergedAt: null,
    removedAt: null,
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultWorktree)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    prune: vi.fn().mockResolvedValue(ok({ pruned: 0, failed: [] })),
    copyEnv: vi.fn().mockResolvedValue(ok(undefined)),
    installDeps: vi.fn().mockResolvedValue(ok(undefined)),
    runInitScript: vi.fn().mockResolvedValue(ok(undefined)),
    commit: vi.fn().mockResolvedValue(ok('abc123def456')),
    merge: vi.fn().mockResolvedValue(ok(undefined)),
    getDiff: vi.fn().mockResolvedValue(
      ok({
        files: [],
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
      })
    ),
    getStatus: vi.fn().mockResolvedValue(
      ok({
        id: defaultWorktree.id,
        branch: defaultWorktree.branch,
        status: defaultWorktree.status,
        path: defaultWorktree.path,
        updatedAt: defaultWorktree.updatedAt,
      })
    ),
    list: vi.fn().mockResolvedValue(
      ok([
        {
          id: defaultWorktree.id,
          branch: defaultWorktree.branch,
          status: defaultWorktree.status,
          path: defaultWorktree.path,
          updatedAt: defaultWorktree.updatedAt,
        },
      ])
    ),
    getByBranch: vi.fn().mockResolvedValue(ok(null)),
    ...overrides,
  };
}
