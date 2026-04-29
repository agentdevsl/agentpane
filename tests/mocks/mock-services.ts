/**
 * Type-safe mock builders for all service dependencies.
 *
 * Services use constructor-injected duck-typed interfaces. These mock builders
 * return properly typed objects that match the interfaces services expect,
 * eliminating the need for `as never` casts in tests.
 *
 * All methods are vi.fn() with sensible defaults (Result types return ok()).
 * Use the `overrides` parameter to customize specific methods for test scenarios.
 */

import type { Readable } from 'node:stream';
import { vi } from 'vitest';
import type {
  ExecStreamResult,
  Sandbox,
  SandboxProvider,
} from '../../src/lib/sandbox/providers/sandbox-provider.js';
import type { SandboxInfo } from '../../src/lib/sandbox/types.js';
import type { Result } from '../../src/lib/utils/result.js';
import { ok } from '../../src/lib/utils/result.js';
import type { SessionEvent, SessionWithPresence } from '../../src/services/session/types.js';
import type { GitDiff } from '../../src/services/worktree.service.js';

// ============================================
// CommandRunner Mock
// ============================================

/**
 * CommandRunner interface for executing shell commands.
 */
export interface CommandRunner {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Create a mock CommandRunner with sensible defaults.
 *
 * @example
 * const runner = createMockCommandRunner({
 *   exec: vi.fn().mockResolvedValue({ stdout: 'main', stderr: '' })
 * });
 */
export function createMockCommandRunner(overrides?: Partial<CommandRunner>): CommandRunner {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  };
}

// ============================================
// WorktreeService Mocks (Partial Interfaces)
// ============================================

/**
 * WorktreeService subset for TaskService.
 * TaskService only needs getDiff, merge, and remove.
 */
export interface WorktreeServiceForTask {
  getDiff: (worktreeId: string) => Promise<Result<GitDiff, unknown>>;
  merge: (worktreeId: string, targetBranch?: string) => Promise<Result<void, unknown>>;
  remove: (worktreeId: string) => Promise<Result<void, unknown>>;
}

/**
 * Create a mock WorktreeService for TaskService.
 *
 * @example
 * const worktreeService = createMockWorktreeServiceForTask({
 *   getDiff: vi.fn().mockResolvedValue(ok({ files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } }))
 * });
 */
export function createMockWorktreeServiceForTask(
  overrides?: Partial<WorktreeServiceForTask>
): WorktreeServiceForTask {
  const defaultGitDiff: GitDiff = {
    files: [],
    stats: { filesChanged: 0, additions: 0, deletions: 0 },
  };

  return {
    getDiff: vi.fn().mockResolvedValue(ok(defaultGitDiff)),
    merge: vi.fn().mockResolvedValue(ok(undefined)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

/**
 * WorktreeService subset for ProjectService.
 * ProjectService only needs prune.
 */
export interface WorktreeServiceForProject {
  prune: (
    codespaceId: string
  ) => Promise<
    Result<
      { pruned: number; failed: Array<{ worktreeId: string; branch: string; error: string }> },
      unknown
    >
  >;
}

/**
 * Create a mock WorktreeService for ProjectService.
 *
 * @example
 * const worktreeService = createMockWorktreeServiceForProject({
 *   prune: vi.fn().mockResolvedValue(ok({ pruned: 2, failed: [] }))
 * });
 */
export function createMockWorktreeServiceForProject(
  overrides?: Partial<WorktreeServiceForProject>
): WorktreeServiceForProject {
  return {
    prune: vi.fn().mockResolvedValue(ok({ pruned: 0, failed: [] })),
    ...overrides,
  };
}

/**
 * Full WorktreeService interface.
 * Includes all methods for comprehensive testing.
 */
export interface WorktreeServiceFull extends WorktreeServiceForTask {
  create: (input: unknown, options?: unknown) => Promise<Result<unknown, unknown>>;
  getStatus: (
    worktreeId: string
  ) => Promise<
    Result<
      { id: string; branch: string; status: string; path: string; updatedAt: string | null },
      unknown
    >
  >;
  list: (
    codespaceId: string
  ) => Promise<
    Result<
      Array<{ id: string; branch: string; status: string; path: string; updatedAt: string | null }>,
      never
    >
  >;
  commit: (worktreeId: string, message: string) => Promise<Result<string, unknown>>;
  prune: (
    codespaceId: string
  ) => Promise<
    Result<
      { pruned: number; failed: Array<{ worktreeId: string; branch: string; error: string }> },
      unknown
    >
  >;
}

/**
 * Create a full mock WorktreeService with all methods.
 *
 * @example
 * const worktreeService = createMockWorktreeService({
 *   create: vi.fn().mockResolvedValue(ok({ id: 'wt1', branch: 'task-123', path: '/project/.worktrees/task-123' }))
 * });
 */
export function createMockWorktreeService(
  overrides?: Partial<WorktreeServiceFull>
): WorktreeServiceFull {
  const defaultGitDiff: GitDiff = {
    files: [],
    stats: { filesChanged: 0, additions: 0, deletions: 0 },
  };

  return {
    create: vi.fn().mockResolvedValue(
      ok({
        id: 'wt1',
        branch: 'task-123',
        path: '/project/.worktrees/task-123',
        status: 'active',
      })
    ),
    getDiff: vi.fn().mockResolvedValue(ok(defaultGitDiff)),
    merge: vi.fn().mockResolvedValue(ok(undefined)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    getStatus: vi.fn().mockResolvedValue(
      ok({
        id: 'wt1',
        branch: 'task-123',
        status: 'active',
        path: '/project/.worktrees/task-123',
        updatedAt: new Date().toISOString(),
      })
    ),
    list: vi.fn().mockResolvedValue(ok([])),
    commit: vi.fn().mockResolvedValue(ok('abc123')),
    prune: vi.fn().mockResolvedValue(ok({ pruned: 0, failed: [] })),
    ...overrides,
  };
}

// ============================================
// DurableStreamsServer Mock
// ============================================

/**
 * DurableStreamsServer interface for event streaming.
 */
export interface DurableStreamsServer {
  createStream: (id: string, schema: unknown) => Promise<void>;
  publish: (id: string, type: string, data: unknown) => Promise<number>;
  subscribe: (id: string) => AsyncIterable<{ type: string; data: unknown }>;
  deleteStream?: (id: string) => Promise<boolean>;
}

/**
 * Create a mock DurableStreamsServer with in-memory event storage.
 * This is a functional mock that stores events in a Map for verification.
 *
 * @example
 * const streamsServer = createMockDurableStreamsServer();
 * await streamsServer.publish('session-123', 'agent:started', { taskId: 'task-1' });
 * // Events are stored in memory and can be subscribed to
 */
export function createMockDurableStreamsServer(
  overrides?: Partial<DurableStreamsServer>
): DurableStreamsServer {
  const streams = new Map<string, Array<{ type: string; data: unknown; offset: number }>>();

  return {
    createStream: vi.fn().mockImplementation(async (id: string) => {
      if (!streams.has(id)) {
        streams.set(id, []);
      }
    }),
    publish: vi.fn().mockImplementation(async (id: string, type: string, data: unknown) => {
      const events = streams.get(id) || [];
      const offset = events.length;
      events.push({ type, data, offset });
      streams.set(id, events);
      return offset;
    }),
    subscribe: vi.fn().mockImplementation(async function* (id: string) {
      const events = streams.get(id) || [];
      for (const event of events) {
        yield event;
      }
    }),
    deleteStream: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ============================================
// DurableStreamsService Mock
// ============================================

/**
 * DurableStreamsService interface for type-safe event streaming.
 */
export interface DurableStreamsService {
  createStream: (id: string, schema: unknown) => Promise<void>;
  publish: (streamId: string, type: string, data: unknown) => Promise<number>;
  subscribe: (
    streamId: string
  ) => AsyncIterable<{ id: string; type: string; timestamp: number; data: unknown }>;
}

/**
 * Create a mock DurableStreamsService.
 *
 * @example
 * const streams = createMockDurableStreamsService({
 *   publish: vi.fn().mockResolvedValue(1)
 * });
 */
export function createMockDurableStreamsService(
  overrides?: Partial<DurableStreamsService>
): DurableStreamsService {
  const server = createMockDurableStreamsServer();

  return {
    createStream: vi.fn().mockImplementation(server.createStream),
    publish: vi.fn().mockImplementation(server.publish),
    subscribe: vi.fn().mockImplementation(async function* (streamId: string) {
      for await (const event of server.subscribe(streamId)) {
        yield {
          id: 'evt-1',
          type: event.type,
          timestamp: Date.now(),
          data: event.data,
        };
      }
    }),
    ...overrides,
  };
}

// ============================================
// ApiKeyService Mock
// ============================================

/**
 * ApiKeyService interface for secure API key storage.
 */
export interface ApiKeyService {
  getDecryptedKey: (service: string) => Promise<string | null>;
  /** F03-09 (arch29-W2-C): OAuth refresh token retrieval. */
  getDecryptedRefreshToken: (service: string) => Promise<string | null>;
  saveKey?: (
    service: string,
    key: string,
    refreshToken?: string | null
  ) => Promise<Result<unknown, unknown>>;
  getKeyInfo?: (service: string) => Promise<Result<unknown, unknown>>;
  deleteKey?: (service: string) => Promise<Result<void, unknown>>;
  markInvalid?: (service: string) => Promise<void>;
}

/**
 * Create a mock ApiKeyService.
 *
 * @example
 * const apiKeyService = createMockApiKeyService({
 *   getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-api-key-123')
 * });
 */
export function createMockApiKeyService(overrides?: Partial<ApiKeyService>): ApiKeyService {
  return {
    getDecryptedKey: vi.fn().mockResolvedValue(null),
    // F03-09 (arch29-W2-C): default to null (no refresh token stored).
    getDecryptedRefreshToken: vi.fn().mockResolvedValue(null),
    saveKey: vi.fn().mockResolvedValue(
      ok({
        id: 'key-1',
        service: 'anthropic',
        maskedKey: 'sk-ant-***',
        isValid: true,
        lastValidatedAt: null,
        createdAt: new Date().toISOString(),
      })
    ),
    getKeyInfo: vi.fn().mockResolvedValue(ok(null)),
    deleteKey: vi.fn().mockResolvedValue(ok(undefined)),
    markInvalid: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================
// SessionService Mock
// ============================================

/**
 * SessionServiceInterface for session management.
 */
export interface SessionServiceInterface {
  create: (input: unknown) => Promise<Result<SessionWithPresence, unknown>>;
  publish: (sessionId: string, event: SessionEvent) => Promise<Result<{ offset: number }, unknown>>;
  getById: (id: string) => Promise<Result<SessionWithPresence, unknown>>;
  close: (id: string) => Promise<Result<SessionWithPresence, unknown>>;
}

/**
 * Create a mock SessionService.
 *
 * @example
 * const sessionService = createMockSessionService({
 *   create: vi.fn().mockResolvedValue(ok({ id: 'session-1', status: 'active', activeUsers: [] }))
 * });
 */
export function createMockSessionService(
  overrides?: Partial<SessionServiceInterface>
): SessionServiceInterface {
  const defaultSession: SessionWithPresence = {
    id: 'session-1',
    codespaceId: 'proj-1',
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: '/sessions/session-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    closedAt: null,
    activeUsers: [],
  };

  return {
    create: vi.fn().mockResolvedValue(ok(defaultSession)),
    publish: vi.fn().mockResolvedValue(ok({ offset: 0 })),
    getById: vi.fn().mockResolvedValue(ok(defaultSession)),
    close: vi
      .fn()
      .mockResolvedValue(
        ok({ ...defaultSession, status: 'closed', closedAt: new Date().toISOString() })
      ),
    ...overrides,
  };
}

// ============================================
// TaskService Mock (subset for AgentService)
// ============================================

/**
 * TaskService subset for AgentService.
 * AgentService only needs moveColumn.
 */
export interface TaskServiceInterface {
  moveColumn: (
    id: string,
    column: string,
    position?: number
  ) => Promise<Result<{ task: unknown; agentError?: string }, unknown>>;
}

/**
 * Create a mock TaskService for AgentService.
 *
 * @example
 * const taskService = createMockTaskService({
 *   moveColumn: vi.fn().mockResolvedValue(ok({ task: { id: 'task-1', column: 'in_progress' } }))
 * });
 */
export function createMockTaskService(
  overrides?: Partial<TaskServiceInterface>
): TaskServiceInterface {
  return {
    moveColumn: vi.fn().mockResolvedValue(ok({ task: { id: 'task-1', column: 'in_progress' } })),
    ...overrides,
  };
}

// ============================================
// SandboxProvider Mock
// ============================================

/**
 * Create a mock Sandbox instance.
 */
export function createMockSandbox(overrides?: Partial<Sandbox>): Sandbox {
  const mockReadable = (() => {
    const readable = new (require('node:stream').Readable)();
    readable.push(null); // End stream immediately
    return readable;
  }) as () => Readable;

  const defaultExecStreamResult: ExecStreamResult = {
    stdout: mockReadable(),
    stderr: mockReadable(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn(),
  };

  return {
    id: 'sandbox-1',
    codespaceId: 'proj-1',
    containerId: 'container-abc123',
    status: 'running',
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execAsRoot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    createTmuxSession: vi.fn().mockResolvedValue({ name: 'session-1', taskId: null }),
    listTmuxSessions: vi.fn().mockResolvedValue([]),
    killTmuxSession: vi.fn().mockResolvedValue(undefined),
    sendKeysToTmux: vi.fn().mockResolvedValue(undefined),
    captureTmuxPane: vi.fn().mockResolvedValue(''),
    stop: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn().mockResolvedValue({ cpu: 0, memory: 0 }),
    touch: vi.fn(),
    getLastActivity: vi.fn().mockReturnValue(new Date()),
    execStream: vi.fn().mockResolvedValue(defaultExecStreamResult),
    // arch29-W2-I (F04-06): every provider implements writeFile so credentials
    // can be injected out-of-band (no token in argv).
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Create a mock SandboxProvider.
 *
 * @example
 * const provider = createMockSandboxProvider({
 *   get: vi.fn().mockResolvedValue(createMockSandbox({ status: 'running' }))
 * });
 */
export function createMockSandboxProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  const defaultSandbox = createMockSandbox();

  const defaultSandboxInfo: SandboxInfo = {
    id: 'sandbox-1',
    codespaceId: 'proj-1',
    projectPath: '/workspace',
    status: 'running',
    containerId: 'container-abc123',
    image: 'agent-sandbox:latest',
    createdAt: new Date().toISOString(),
    lastActivity: new Date(),
  };

  return {
    name: 'mock-provider',
    create: vi.fn().mockResolvedValue(defaultSandbox),
    get: vi.fn().mockResolvedValue(defaultSandbox),
    getById: vi.fn().mockResolvedValue(defaultSandbox),
    list: vi.fn().mockResolvedValue([defaultSandboxInfo]),
    pullImage: vi.fn().mockResolvedValue(undefined),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, message: 'OK' }),
    cleanup: vi.fn().mockResolvedValue(0),
    // Optional: recover method for some providers
    recover: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}
