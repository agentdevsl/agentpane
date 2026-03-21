/**
 * Pre-configured complete test scenarios that wire together all mocks.
 *
 * Tests currently build mocks piecemeal in each file, creating duplication
 * and inconsistency. This module provides ready-made, fully-wired configurations
 * for common testing scenarios.
 *
 * Each scenario builder returns all the mock instances needed for a service,
 * with sensible defaults that can be overridden for specific test cases.
 *
 * @module tests/mocks/mock-scenarios
 */

import { vi } from 'vitest';
import type { Result } from '../../src/lib/utils/result.js';
import { err, ok } from '../../src/lib/utils/result.js';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service.js';
import { CodespaceService } from '../../src/services/codespace.service.js';
import { ContainerAgentService } from '../../src/services/container-agent.service.js';
import type { SessionWithPresence } from '../../src/services/session/types.js';
import { SessionService } from '../../src/services/session.service.js';
import type { ContainerAgentTrigger } from '../../src/services/task.service.js';
import { TaskService } from '../../src/services/task.service.js';
import type { Database } from '../../src/types/database.js';
import {
  createInsertChain,
  createMockDatabase,
  createTableQuery,
  createUpdateChain,
  type MockDatabase,
} from './mock-builders.js';
import {
  createMockSandbox,
  createMockSandboxProvider,
  type SandboxProvider,
} from './mock-sandbox.js';
import {
  type ApiKeyService,
  type CommandRunner,
  createMockApiKeyService,
  createMockCommandRunner,
  createMockDurableStreamsServer,
  createMockDurableStreamsService,
  createMockSessionService,
  createMockTaskService,
  createMockWorktreeService,
  createMockWorktreeServiceForProject,
  createMockWorktreeServiceForTask,
  type DurableStreamsServer,
  type DurableStreamsService,
  type SessionServiceInterface,
  type TaskServiceInterface,
  type WorktreeServiceForProject,
  type WorktreeServiceForTask,
  type WorktreeServiceFull,
} from './mock-services.js';

// =============================================================================
// TaskService Scenario
// =============================================================================

/**
 * Pre-configured scenario for TaskService testing.
 *
 * Provides a fully wired TaskService with:
 * - Mock database with a default project
 * - Mock worktree service with success Results
 * - All methods have sensible defaults
 *
 * @param overrides - Optional overrides for db, worktreeService, or containerAgentService
 * @returns Configured scenario with db, worktreeService, containerAgentService, and service
 *
 * @example
 * ```typescript
 * const scenario = createTaskServiceScenario();
 * const result = await scenario.service.create({
 *   codespaceId: 'proj-1',
 *   title: 'Build feature',
 * });
 * expect(result.ok).toBe(true);
 * ```
 *
 * @example
 * ```typescript
 * // Override worktree behavior
 * const scenario = createTaskServiceScenario({
 *   worktreeService: createMockWorktreeServiceForTask({
 *     getDiff: vi.fn().mockResolvedValue(ok({
 *       files: [{ path: 'src/app.ts', status: 'modified' }],
 *       stats: { filesChanged: 1, additions: 10, deletions: 5 },
 *     }))
 *   })
 * });
 * ```
 */
export function createTaskServiceScenario(overrides?: {
  db?: MockDatabase;
  worktreeService?: WorktreeServiceForTask;
  containerAgentService?: ContainerAgentTrigger;
}): {
  db: MockDatabase;
  worktreeService: WorktreeServiceForTask;
  containerAgentService: ContainerAgentTrigger;
  service: TaskService;
} {
  // Create default project in db
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultTask = {
    id: 'task-1',
    codespaceId: 'proj-1',
    title: 'Test Task',
    description: '',
    column: 'backlog',
    position: 0,
    labels: [],
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db =
    overrides?.db ||
    createMockDatabase({
      query: {
        projects: createTableQuery([defaultProject]),
        tasks: createTableQuery([defaultTask]),
      },
      insert: vi.fn().mockImplementation((_table) => {
        return createInsertChain([defaultTask]);
      }),
      update: vi.fn().mockImplementation((_table) => {
        return createUpdateChain([defaultTask]);
      }),
    });

  const worktreeService = overrides?.worktreeService || createMockWorktreeServiceForTask();

  const containerAgentService = overrides?.containerAgentService || {
    startAgent: vi.fn().mockResolvedValue(ok(undefined)),
    stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
    rejectPlan: vi.fn().mockReturnValue(ok(undefined)),
  };

  const service = new TaskService(db as unknown as Database, worktreeService);
  service.setContainerAgentService(containerAgentService);

  return {
    db,
    worktreeService,
    containerAgentService,
    service,
  };
}

// =============================================================================
// AgentService Scenario
// =============================================================================

/**
 * Pre-configured scenario for AgentExecutionService testing.
 *
 * Provides a fully wired AgentExecutionService with:
 * - Mock database with project, agent, task, session, and worktree
 * - Mock worktree service with success Results
 * - Mock task service with success Results
 * - Mock session service with success Results
 *
 * @param overrides - Optional overrides for db, worktreeService, taskService, or sessionService
 * @returns Configured scenario with db, worktreeService, taskService, sessionService, and service
 *
 * @example
 * ```typescript
 * const scenario = createAgentServiceScenario();
 * const result = await scenario.service.start('agent-1', 'task-1');
 * expect(result.ok).toBe(true);
 * ```
 */
export function createAgentServiceScenario(overrides?: {
  db?: MockDatabase;
  worktreeService?: WorktreeServiceFull;
  taskService?: TaskServiceInterface;
  sessionService?: SessionServiceInterface;
}): {
  db: MockDatabase;
  worktreeService: WorktreeServiceFull;
  taskService: TaskServiceInterface;
  sessionService: SessionServiceInterface;
  service: AgentExecutionService;
} {
  // Create default entities
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultAgent = {
    id: 'agent-1',
    codespaceId: 'proj-1',
    name: 'Test Agent',
    type: 'task',
    status: 'idle',
    currentTaskId: null,
    config: {
      model: 'claude-sonnet-4-6',
      maxTurns: 50,
      allowedTools: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultTask = {
    id: 'task-1',
    codespaceId: 'proj-1',
    title: 'Test Task',
    description: 'Test description',
    column: 'backlog',
    position: 0,
    labels: [],
    priority: 'medium',
    agentId: null,
    sessionId: null,
    worktreeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultSession = {
    id: 'session-1',
    codespaceId: 'proj-1',
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: '/sessions/session-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    closedAt: null,
  };

  const defaultWorktree = {
    id: 'wt-1',
    codespaceId: 'proj-1',
    branch: 'task-1',
    path: '/projects/test/.worktrees/task-1',
    status: 'active',
    sessionId: null,
    agentId: null,
    taskId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db =
    overrides?.db ||
    createMockDatabase({
      query: {
        projects: createTableQuery([defaultProject]),
        agents: createTableQuery([defaultAgent]),
        tasks: createTableQuery([defaultTask]),
        sessions: createTableQuery([defaultSession]),
        worktrees: createTableQuery([defaultWorktree]),
      },
      insert: vi.fn().mockImplementation((_table) => {
        return createInsertChain([defaultWorktree]);
      }),
      update: vi.fn().mockImplementation((_table) => {
        return createUpdateChain([defaultAgent]);
      }),
    });

  const worktreeService = overrides?.worktreeService || createMockWorktreeService();
  const taskService = overrides?.taskService || createMockTaskService();
  const sessionService = overrides?.sessionService || createMockSessionService();

  const service = new AgentExecutionService(
    db as unknown as Database,
    worktreeService,
    taskService,
    sessionService
  );

  return {
    db,
    worktreeService,
    taskService,
    sessionService,
    service,
  };
}

// =============================================================================
// CodespaceService Scenario
// =============================================================================

/**
 * Pre-configured scenario for CodespaceService testing.
 *
 * Provides a fully wired CodespaceService with:
 * - Mock database with default project
 * - Mock worktree service with prune support
 * - Mock command runner with git support
 *
 * @param overrides - Optional overrides for db, worktreeService, or runner
 * @returns Configured scenario with db, worktreeService, runner, and service
 *
 * @example
 * ```typescript
 * const scenario = createCodespaceServiceScenario();
 * const result = await scenario.service.getById('proj-1');
 * expect(result.ok).toBe(true);
 * ```
 */
export function createCodespaceServiceScenario(overrides?: {
  db?: MockDatabase;
  worktreeService?: WorktreeServiceForProject;
  runner?: CommandRunner;
}): {
  db: MockDatabase;
  worktreeService: WorktreeServiceForProject;
  runner: CommandRunner;
  service: CodespaceService;
} {
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db =
    overrides?.db ||
    createMockDatabase({
      query: {
        projects: createTableQuery([defaultProject]),
      },
      insert: vi.fn().mockImplementation((_table) => {
        return createInsertChain([defaultProject]);
      }),
      update: vi.fn().mockImplementation((_table) => {
        return createUpdateChain([defaultProject]);
      }),
    });

  const worktreeService = overrides?.worktreeService || createMockWorktreeServiceForProject();

  const runner =
    overrides?.runner ||
    createMockCommandRunner({
      exec: vi.fn().mockResolvedValue({ stdout: 'main', stderr: '' }),
    });

  const service = new CodespaceService(db as unknown as Database, worktreeService, runner);

  return {
    db,
    worktreeService,
    runner,
    service,
  };
}

// =============================================================================
// SessionService Scenario
// =============================================================================

/**
 * Pre-configured scenario for SessionService testing.
 *
 * Provides a fully wired SessionService with:
 * - Mock database with default project
 * - Mock streams server with in-memory event storage
 * - Base URL configuration
 *
 * @param overrides - Optional overrides for db, streams, or baseUrl
 * @returns Configured scenario with db, streams, and service
 *
 * @example
 * ```typescript
 * const scenario = createSessionServiceScenario();
 * const result = await scenario.service.create({ codespaceId: 'proj-1' });
 * expect(result.ok).toBe(true);
 * ```
 */
export function createSessionServiceScenario(overrides?: {
  db?: MockDatabase;
  streams?: DurableStreamsServer;
  baseUrl?: string;
}): {
  db: MockDatabase;
  streams: DurableStreamsServer;
  service: SessionService;
} {
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultSession = {
    id: 'session-1',
    codespaceId: 'proj-1',
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: '/sessions/session-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    closedAt: null,
  };

  const db =
    overrides?.db ||
    createMockDatabase({
      query: {
        projects: createTableQuery([defaultProject]),
        sessions: createTableQuery([defaultSession]),
      },
      insert: vi.fn().mockImplementation((_table) => {
        return createInsertChain([defaultSession]);
      }),
      update: vi.fn().mockImplementation((_table) => {
        return createUpdateChain([defaultSession]);
      }),
    });

  const streams = overrides?.streams || createMockDurableStreamsServer();

  const service = new SessionService(db as unknown as Database, streams, {
    baseUrl: overrides?.baseUrl || 'http://localhost:3000',
  });

  return {
    db,
    streams,
    service,
  };
}

// =============================================================================
// ContainerAgentService Scenario
// =============================================================================

/**
 * Pre-configured scenario for ContainerAgentService testing.
 *
 * This is the most complex scenario — includes:
 * - Mock database with project, task, session, agent, worktree
 * - Mock sandbox provider with running sandbox
 * - Mock streams service for event publishing
 * - Mock API key service returning test token
 * - Mock worktree service with create/remove support
 *
 * @param overrides - Optional overrides for db, provider, streams, apiKeyService, or worktreeService
 * @returns Configured scenario with all mocks and service
 *
 * @example
 * ```typescript
 * const scenario = createContainerAgentScenario();
 * const result = await scenario.service.startAgent({
 *   codespaceId: 'proj-1',
 *   taskId: 'task-1',
 *   sessionId: 'session-1',
 *   prompt: 'Build a feature',
 * });
 * expect(result.ok).toBe(true);
 * ```
 */
export function createContainerAgentScenario(overrides?: {
  db?: MockDatabase;
  provider?: SandboxProvider;
  streams?: DurableStreamsService;
  apiKeyService?: ApiKeyService;
  worktreeService?: WorktreeServiceFull;
}): {
  db: MockDatabase;
  provider: SandboxProvider;
  streams: DurableStreamsService;
  apiKeyService: ApiKeyService;
  worktreeService: WorktreeServiceFull;
  service: ContainerAgentService;
} {
  // Create default entities
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultAgent = {
    id: 'agent-1',
    codespaceId: 'proj-1',
    name: 'Test Agent',
    type: 'task',
    status: 'idle',
    currentTaskId: null,
    config: {
      model: 'claude-sonnet-4-6',
      maxTurns: 50,
      allowedTools: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultTask = {
    id: 'task-1',
    codespaceId: 'proj-1',
    title: 'Test Task',
    description: 'Test description',
    column: 'backlog',
    position: 0,
    labels: [],
    priority: 'medium',
    agentId: null,
    sessionId: null,
    worktreeId: null,
    plan: null,
    planOptions: null,
    lastAgentStatus: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultSession = {
    id: 'session-1',
    codespaceId: 'proj-1',
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: '/sessions/session-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    closedAt: null,
  };

  const defaultWorktree = {
    id: 'wt-1',
    codespaceId: 'proj-1',
    branch: 'task-1',
    path: '/projects/test/.worktrees/task-1',
    status: 'active',
    sessionId: null,
    agentId: null,
    taskId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db =
    overrides?.db ||
    createMockDatabase({
      query: {
        projects: createTableQuery([defaultProject]),
        agents: createTableQuery([defaultAgent]),
        tasks: createTableQuery([defaultTask]),
        sessions: createTableQuery([defaultSession]),
        worktrees: createTableQuery([defaultWorktree]),
      },
      insert: vi.fn().mockImplementation((_table) => {
        return createInsertChain([defaultTask]);
      }),
      update: vi.fn().mockImplementation((_table) => {
        return createUpdateChain([defaultTask]);
      }),
    });

  // Create sandbox with running status
  const sandbox = createMockSandbox({
    id: 'sandbox-1',
    codespaceId: 'proj-1',
    status: 'running',
  });

  const provider =
    overrides?.provider ||
    createMockSandboxProvider({
      name: 'mock-provider',
      get: vi.fn().mockResolvedValue(sandbox),
      create: vi.fn().mockResolvedValue(sandbox),
    });

  const streams = overrides?.streams || createMockDurableStreamsService();

  const apiKeyService =
    overrides?.apiKeyService ||
    createMockApiKeyService({
      getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-test-token-123'),
    });

  const worktreeService = overrides?.worktreeService || createMockWorktreeService();

  const service = new ContainerAgentService(
    db as unknown as Database,
    provider,
    streams,
    apiKeyService,
    worktreeService
  );

  return {
    db,
    provider,
    streams,
    apiKeyService,
    worktreeService,
    service,
  };
}

// =============================================================================
// Full Stack Scenario
// =============================================================================

/**
 * Pre-configured scenario with ALL services wired together.
 *
 * Returns all services sharing:
 * - Single mock database with shared project/task/agent/session data
 * - All services properly wired and cross-referencing the same entities
 *
 * This is useful for integration-style tests that exercise multiple services.
 *
 * @returns Complete ecosystem of services
 *
 * @example
 * ```typescript
 * const stack = createFullStackScenario();
 *
 * // Create task via TaskService
 * const taskResult = await stack.taskService.create({
 *   codespaceId: stack.project.id,
 *   title: 'Build feature',
 * });
 *
 * // Start agent via AgentService
 * const agentResult = await stack.agentService.start(stack.agent.id, task.id);
 *
 * // Verify session created
 * const sessionResult = await stack.sessionService.getById(agent.sessionId);
 * ```
 */
export function createFullStackScenario(): {
  // Shared data
  project: typeof defaultProject;
  task: typeof defaultTask;
  agent: typeof defaultAgent;
  session: typeof defaultSession;
  worktree: typeof defaultWorktree;

  // Shared mocks
  db: MockDatabase;
  streams: DurableStreamsServer;
  provider: SandboxProvider;
  apiKeyService: ApiKeyService;
  runner: CommandRunner;

  // Services
  worktreeService: WorktreeServiceFull;
  sessionService: SessionService;
  taskService: TaskService;
  agentService: AgentExecutionService;
  projectService: CodespaceService;
  containerAgentService: ContainerAgentService;
} {
  // Create shared entities
  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultAgent = {
    id: 'agent-1',
    codespaceId: 'proj-1',
    name: 'Test Agent',
    type: 'task' as const,
    status: 'idle' as const,
    currentTaskId: null,
    config: {
      model: 'claude-sonnet-4-6',
      maxTurns: 50,
      allowedTools: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultTask = {
    id: 'task-1',
    codespaceId: 'proj-1',
    title: 'Test Task',
    description: 'Test description',
    column: 'backlog' as const,
    position: 0,
    labels: [],
    priority: 'medium' as const,
    agentId: null,
    sessionId: null,
    worktreeId: null,
    plan: null,
    planOptions: null,
    lastAgentStatus: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultSession = {
    id: 'session-1',
    codespaceId: 'proj-1',
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: '/sessions/session-1',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    closedAt: null,
  };

  const defaultWorktree = {
    id: 'wt-1',
    codespaceId: 'proj-1',
    branch: 'task-1',
    path: '/projects/test/.worktrees/task-1',
    status: 'active' as const,
    sessionId: null,
    agentId: null,
    taskId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Create shared mock database
  const db = createMockDatabase({
    query: {
      projects: createTableQuery([defaultProject]),
      agents: createTableQuery([defaultAgent]),
      tasks: createTableQuery([defaultTask]),
      sessions: createTableQuery([defaultSession]),
      worktrees: createTableQuery([defaultWorktree]),
    },
    insert: vi.fn().mockImplementation((_table) => {
      return createInsertChain([defaultTask]);
    }),
    update: vi.fn().mockImplementation((_table) => {
      return createUpdateChain([defaultTask]);
    }),
  });

  // Create shared mocks
  const streams = createMockDurableStreamsServer();
  const sandbox = createMockSandbox({
    id: 'sandbox-1',
    codespaceId: 'proj-1',
    status: 'running',
  });
  const provider = createMockSandboxProvider({
    name: 'mock-provider',
    get: vi.fn().mockResolvedValue(sandbox),
    create: vi.fn().mockResolvedValue(sandbox),
  });
  const apiKeyService = createMockApiKeyService({
    getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-test-token-123'),
  });
  const runner = createMockCommandRunner({
    exec: vi.fn().mockResolvedValue({ stdout: 'main', stderr: '' }),
  });

  // Create shared worktree service
  const worktreeService = createMockWorktreeService();

  // Create services
  const sessionService = new SessionService(db as unknown as Database, streams, {
    baseUrl: 'http://localhost:3000',
  });

  const streamsService = createMockDurableStreamsService();

  const taskServiceInstance = new TaskService(db as unknown as Database, worktreeService);

  const taskServiceInterface: TaskServiceInterface = {
    moveColumn: vi.fn().mockResolvedValue(ok({ task: defaultTask })),
  };

  const sessionServiceInterface: SessionServiceInterface = {
    create: vi.fn().mockResolvedValue(
      ok({
        ...defaultSession,
        activeUsers: [],
      } as SessionWithPresence)
    ),
    publish: vi.fn().mockResolvedValue(ok({ offset: 0 })),
    getById: vi.fn().mockResolvedValue(
      ok({
        ...defaultSession,
        activeUsers: [],
      } as SessionWithPresence)
    ),
    close: vi.fn().mockResolvedValue(
      ok({
        ...defaultSession,
        status: 'closed',
        closedAt: new Date().toISOString(),
        activeUsers: [],
      } as SessionWithPresence)
    ),
  };

  const agentService = new AgentExecutionService(
    db as unknown as Database,
    worktreeService,
    taskServiceInterface,
    sessionServiceInterface
  );

  const projectService = new CodespaceService(db as unknown as Database, worktreeService, runner);

  const containerAgentService = new ContainerAgentService(
    db as unknown as Database,
    provider,
    streamsService,
    apiKeyService,
    worktreeService
  );

  taskServiceInstance.setContainerAgentService(containerAgentService);

  return {
    // Shared data
    project: defaultProject,
    task: defaultTask,
    agent: defaultAgent,
    session: defaultSession,
    worktree: defaultWorktree,

    // Shared mocks
    db,
    streams,
    provider,
    apiKeyService,
    runner,

    // Services
    worktreeService,
    sessionService,
    taskService: taskServiceInstance,
    agentService,
    projectService,
    containerAgentService,
  };
}

// =============================================================================
// Error Scenarios
// =============================================================================

/**
 * Error type for creating error scenarios.
 */
export type ErrorType =
  | 'db_insert_fail'
  | 'db_update_fail'
  | 'worktree_create_fail'
  | 'sandbox_not_running'
  | 'api_key_missing'
  | 'exec_stream_fail';

/**
 * Creates a scenario where a specific operation fails.
 *
 * Configures a service scenario with a specific error injected:
 * - `db_insert_fail` — DB insert throws
 * - `db_update_fail` — DB update throws
 * - `worktree_create_fail` — Worktree creation returns error Result
 * - `sandbox_not_running` — Sandbox status is 'stopped'
 * - `api_key_missing` — API key returns null
 * - `exec_stream_fail` — execStream rejects
 *
 * @param service - Service type to create scenario for
 * @param errorType - Type of error to inject
 * @returns Scenario configured with the error
 *
 * @example
 * ```typescript
 * const scenario = createErrorScenario('containerAgent', 'api_key_missing');
 * const result = await scenario.service.startAgent({
 *   codespaceId: 'proj-1',
 *   taskId: 'task-1',
 *   sessionId: 'session-1',
 *   prompt: 'Build feature',
 * });
 * expect(result.ok).toBe(false);
 * if (!result.ok) {
 *   expect(result.error.code).toBe('API_KEY_NOT_CONFIGURED');
 * }
 * ```
 */
export function createErrorScenario(
  service: 'task' | 'agent' | 'project' | 'session' | 'containerAgent',
  errorType: ErrorType
): ReturnType<
  | typeof createTaskServiceScenario
  | typeof createAgentServiceScenario
  | typeof createCodespaceServiceScenario
  | typeof createSessionServiceScenario
  | typeof createContainerAgentScenario
> {
  switch (errorType) {
    case 'db_insert_fail': {
      const db = createMockDatabase({
        insert: vi.fn().mockImplementation(() => {
          throw new Error('Database insert failed');
        }),
      });
      return service === 'task'
        ? createTaskServiceScenario({ db })
        : service === 'agent'
          ? createAgentServiceScenario({ db })
          : service === 'project'
            ? createCodespaceServiceScenario({ db })
            : service === 'session'
              ? createSessionServiceScenario({ db })
              : createContainerAgentScenario({ db });
    }

    case 'db_update_fail': {
      const db = createMockDatabase({
        update: vi.fn().mockImplementation(() => {
          throw new Error('Database update failed');
        }),
      });
      return service === 'task'
        ? createTaskServiceScenario({ db })
        : service === 'agent'
          ? createAgentServiceScenario({ db })
          : service === 'project'
            ? createCodespaceServiceScenario({ db })
            : service === 'session'
              ? createSessionServiceScenario({ db })
              : createContainerAgentScenario({ db });
    }

    case 'worktree_create_fail': {
      const worktreeService = createMockWorktreeService({
        create: vi.fn().mockResolvedValue(err({ code: 'WORKTREE_CREATE_FAILED' })),
      });
      return service === 'task'
        ? createTaskServiceScenario({ worktreeService })
        : service === 'agent'
          ? createAgentServiceScenario({ worktreeService })
          : service === 'project'
            ? createCodespaceServiceScenario({ worktreeService })
            : createContainerAgentScenario({ worktreeService });
    }

    case 'sandbox_not_running': {
      const sandbox = createMockSandbox({
        status: 'stopped',
      });
      const provider = createMockSandboxProvider(sandbox);
      return createContainerAgentScenario({ provider });
    }

    case 'api_key_missing': {
      const apiKeyService = createMockApiKeyService({
        getDecryptedKey: vi.fn().mockResolvedValue(null),
      });
      return createContainerAgentScenario({ apiKeyService });
    }

    case 'exec_stream_fail': {
      const sandbox = createMockSandbox({
        execStream: vi.fn().mockRejectedValue(new Error('execStream failed')),
      });
      const provider = createMockSandboxProvider(sandbox);
      return createContainerAgentScenario({ provider });
    }

    default:
      throw new Error(`Unknown error type: ${errorType}`);
  }
}

// =============================================================================
// Concurrency Scenario
// =============================================================================

/**
 * Creates a scenario for testing race conditions.
 *
 * Provides multiple tasks and a helper to fire concurrent `startAgent` calls.
 * Useful for testing concurrency limits, locking, and race condition handling.
 *
 * @param taskCount - Number of tasks to create (default: 3)
 * @returns Scenario with tasks and startAll helper
 *
 * @example
 * ```typescript
 * const scenario = createConcurrencyScenario(5);
 *
 * // Fire 5 concurrent startAgent calls
 * const results = await scenario.startAll();
 *
 * // Verify concurrency limits respected
 * const successCount = results.filter(r => r.ok).length;
 * expect(successCount).toBeLessThanOrEqual(3); // maxConcurrentAgents = 3
 * ```
 */
export function createConcurrencyScenario(taskCount = 3): {
  db: MockDatabase;
  service: AgentExecutionService;
  tasks: Array<{ id: string; title: string }>;
  agent: { id: string; name: string };
  startAll: () => Promise<Array<Result<unknown, unknown>>>;
} {
  // Create multiple tasks
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${i + 1}`,
    codespaceId: 'proj-1',
    title: `Task ${i + 1}`,
    description: '',
    column: 'backlog' as const,
    position: i,
    labels: [],
    priority: 'medium' as const,
    agentId: null,
    sessionId: null,
    worktreeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const defaultProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/projects/test',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: [],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultAgent = {
    id: 'agent-1',
    codespaceId: 'proj-1',
    name: 'Test Agent',
    type: 'task' as const,
    status: 'idle' as const,
    currentTaskId: null,
    config: {
      model: 'claude-sonnet-4-6',
      maxTurns: 50,
      allowedTools: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db = createMockDatabase({
    query: {
      projects: createTableQuery([defaultProject]),
      agents: createTableQuery([defaultAgent]),
      tasks: createTableQuery(tasks),
    },
    update: vi.fn().mockImplementation((_table) => {
      return createUpdateChain([tasks[0]]);
    }),
  });

  const worktreeService = createMockWorktreeService();
  const taskService = createMockTaskService();
  const sessionService = createMockSessionService();

  const service = new AgentExecutionService(
    db as unknown as Database,
    worktreeService,
    taskService,
    sessionService
  );

  const startAll = async () => {
    return Promise.all(tasks.map((task) => service.start('agent-1', task.id)));
  };

  return {
    db,
    service,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
    agent: { id: defaultAgent.id, name: defaultAgent.name },
    startAll,
  };
}
