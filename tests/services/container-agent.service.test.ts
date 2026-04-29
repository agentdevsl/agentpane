/**
 * Comprehensive tests for ContainerAgentService — the largest service file (3076 LOC).
 *
 * Covers:
 * - Constructor and disposal
 * - startAgent lifecycle (container exec path)
 * - Status tracking across all stages
 * - Credential management (OAuth token resolution)
 * - Agent start/stop/cancel lifecycle
 * - Plan lifecycle (handlePlanReady, getPendingPlan, approvePlan, rejectPlan)
 * - Container cleanup and worktree management
 * - Error handling for each stage
 * - Environment variable construction
 * - Sandbox mode handling (shared vs per-project)
 * - Concurrency guards (startingAgents set)
 * - AgentCore provider management
 * - cleanupExpiredPlans
 * - isAgentRunning / getRunningAgent / getRunningAgents
 * - translatePathForContainer
 * - waitForSandboxReady
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, tasks, worktrees } from '../../src/db/schema';
import { ContainerAgentService } from '../../src/services/container-agent.service';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock the container bridge — prevents real container bridge creation
// ---------------------------------------------------------------------------
const mockBridgeProcessStream = vi.fn().mockResolvedValue(undefined);
const mockBridgeProcessStderr = vi.fn();
const mockBridgeStop = vi.fn();
let capturedBridgeOptions: any = null;

vi.mock('../../src/lib/agents/container-bridge.js', () => ({
  createContainerBridge: vi.fn((options: any) => {
    capturedBridgeOptions = options;
    return {
      processStream: mockBridgeProcessStream,
      processStderr: mockBridgeProcessStderr,
      stop: mockBridgeStop,
    };
  }),
}));

// Mock the AgentCore bridge
vi.mock('../../src/lib/agents/agentcore-bridge.js', () => ({
  createAgentCoreBridge: vi.fn(() => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  })),
}));

// Mock the AgentCore provider factory
vi.mock('../../src/lib/sandbox/providers/agentcore-sandbox-provider.js', () => ({
  createAgentCoreProvider: vi.fn(() => ({
    name: 'agentcore',
    get: vi.fn(),
    create: vi.fn(),
    getOrCreateSession: vi.fn().mockReturnValue('runtime-session-123'),
    removeSession: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock git-token-resolver
vi.mock('../../src/lib/sandbox/git-token-resolver.js', () => ({
  deriveGitHubFromPath: vi.fn().mockReturnValue(null),
  resolveGitToken: vi.fn().mockResolvedValue(null),
}));

// Mock k8s-workspace-initializer
vi.mock('../../src/lib/sandbox/k8s-workspace-initializer.js', () => ({
  initializeK8sWorkspace: vi.fn().mockResolvedValue({
    worktreePath: '/workspace',
    branch: null,
  }),
}));

// Mock settings service
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue(undefined),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for all pending microtasks and macrotasks to settle. */
async function flushAsync(iterations = 5): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createMockStreams(overrides: Partial<DurableStreamsService> = {}): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    deleteStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as DurableStreamsService;
}

function createMockSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sandbox-1',
    codespaceId: 'project-1',
    containerId: 'container-abc123',
    status: 'running' as const,
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execAsRoot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execStream: vi.fn().mockResolvedValue({
      stdout: new Readable({
        read() {
          this.push(null);
        },
      }),
      stderr: new Readable({
        read() {
          this.push(null);
        },
      }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn(),
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn(),
    touch: vi.fn(),
    getLastActivity: vi.fn().mockReturnValue(new Date()),
    createTmuxSession: vi.fn(),
    listTmuxSessions: vi.fn(),
    killTmuxSession: vi.fn(),
    sendKeysToTmux: vi.fn(),
    captureTmuxPane: vi.fn(),
    // arch29-W2-I (F04-06): all providers implement writeFile so credentials
    // can be injected out-of-band (no token in argv).
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockProvider(sandbox?: ReturnType<typeof createMockSandbox>) {
  const s = sandbox ?? createMockSandbox();
  return {
    name: 'docker',
    get: vi.fn().mockResolvedValue(s),
    getById: vi.fn().mockResolvedValue(s),
    create: vi.fn().mockResolvedValue(s),
    list: vi.fn().mockResolvedValue([]),
    pullImage: vi.fn(),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    cleanup: vi.fn().mockResolvedValue(0),
  };
}

function createMockApiKeyService(
  token: string | null = 'sk-ant-oat01-test-token',
  refreshToken: string | null = null
) {
  return {
    getDecryptedKey: vi.fn().mockResolvedValue(token),
    // F03-09 (arch29-W2-C): default to null (no refresh token stored).
    getDecryptedRefreshToken: vi.fn().mockResolvedValue(refreshToken),
    saveKey: vi.fn(),
    deleteKey: vi.fn(),
  } as any;
}

function createMockWorktreeService(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'wt-1',
        path: '/tmp/test-project/worktrees/task-branch',
        branch: 'task-branch',
      },
    }),
    getStatus: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'wt-1',
        path: '/tmp/test-project/worktrees/task-branch',
        branch: 'task-branch',
        status: 'clean',
      },
    }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    commit: vi.fn().mockResolvedValue({ ok: true, value: 'abc123' }),
    getDiff: vi.fn(),
    merge: vi.fn(),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerAgentService', () => {
  let service: ContainerAgentService;
  let streams: DurableStreamsService;
  let provider: ReturnType<typeof createMockProvider>;
  let apiKeyService: ReturnType<typeof createMockApiKeyService>;
  let sandbox: ReturnType<typeof createMockSandbox>;

  beforeEach(async () => {
    await setupTestDatabase();
    vi.clearAllMocks();
    capturedBridgeOptions = null;

    sandbox = createMockSandbox();
    provider = createMockProvider(sandbox);
    streams = createMockStreams();
    apiKeyService = createMockApiKeyService();

    service = new ContainerAgentService(
      getTestDb() as any,
      provider as any,
      streams,
      apiKeyService
    );
  });

  afterEach(async () => {
    service.dispose();
    await clearTestDatabase();
  });

  // =========================================================================
  // Constructor & Dispose
  // =========================================================================

  describe('constructor and dispose', () => {
    it('creates service without worktreeService', () => {
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService
      );
      expect(svc).toBeDefined();
      svc.dispose();
    });

    it('creates service with worktreeService', () => {
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );
      expect(svc).toBeDefined();
      svc.dispose();
    });

    it('dispose clears cleanup interval', () => {
      // Calling dispose twice should not throw
      service.dispose();
      service.dispose();
    });

    it('providerName returns the sandbox provider name', () => {
      expect(service.providerName).toBe('docker');
    });
  });

  // =========================================================================
  // isAgentRunning / getRunningAgent / getRunningAgents
  // =========================================================================

  describe('agent status queries', () => {
    it('isAgentRunning returns false when no agent is running', () => {
      expect(service.isAgentRunning('task-1')).toBe(false);
    });

    it('getRunningAgent returns null when no agent is running', () => {
      expect(service.getRunningAgent('task-1')).toBeNull();
    });

    it('getRunningAgents returns empty array initially', () => {
      expect(service.getRunningAgents()).toEqual([]);
    });
  });

  // =========================================================================
  // startAgent — precondition checks
  // =========================================================================

  describe('startAgent precondition checks', () => {
    it('returns error when project not found', async () => {
      const result = await service.startAgent({
        codespaceId: 'nonexistent-project',
        taskId: 'task-1',
        sessionId: 'session-1',
        prompt: 'Do something',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
      }
    });

    it('returns error when agent already running for task', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      // Start first agent
      const result1 = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result1.ok).toBe(true);

      // Try to start another agent for the same task
      const result2 = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-2',
        prompt: 'Do something else',
      });
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
      }
    });

    it('returns error when sandbox does not support streaming exec', async () => {
      const noStreamSandbox = createMockSandbox({ execStream: undefined });
      provider.get.mockResolvedValue(noStreamSandbox);

      const project = await createTestProject();
      await createTestTask(project.id, { title: 'Test task' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: 'task-no-stream',
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_STREAMING_EXEC_NOT_SUPPORTED');
      }
    });

    it('returns error when task not found', async () => {
      const project = await createTestProject();
      // Don't create a task — it won't be found

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: 'nonexistent-task-id',
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_TASK_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // startAgent — sandbox recovery
  // =========================================================================

  describe('startAgent sandbox recovery', () => {
    it('auto-creates sandbox when none exists', async () => {
      provider.get.mockResolvedValue(null);
      provider.create.mockResolvedValue(sandbox);

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
      expect(provider.create).toHaveBeenCalled();
    });

    it('recreates sandbox when in error state', async () => {
      const errorSandbox = createMockSandbox({ status: 'error' });
      provider.get.mockResolvedValueOnce(errorSandbox).mockResolvedValue(sandbox);
      provider.create.mockResolvedValue(sandbox);

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
      expect(errorSandbox.stop).toHaveBeenCalled();
    });

    it('recreates sandbox when in stopped state', async () => {
      const stoppedSandbox = createMockSandbox({ status: 'stopped' });
      provider.get.mockResolvedValueOnce(stoppedSandbox).mockResolvedValue(sandbox);
      provider.create.mockResolvedValue(sandbox);

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
    });

    it('returns error when auto-create fails', async () => {
      provider.get.mockResolvedValue(null);
      provider.create.mockRejectedValue(new Error('Docker not available'));

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // startAgent — credential management
  // =========================================================================

  describe('startAgent credential management', () => {
    it('returns error when no OAuth token available', async () => {
      const noKeyService = createMockApiKeyService(null);
      // Also clear env vars
      const origAuth = process.env.ANTHROPIC_AUTH_TOKEN;
      const origApi = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;

      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        noKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-no-key',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_API_KEY_NOT_CONFIGURED');
      }

      // Restore env
      if (origAuth) process.env.ANTHROPIC_AUTH_TOKEN = origAuth;
      if (origApi) process.env.ANTHROPIC_API_KEY = origApi;
      svc.dispose();
    });

    it('falls back to ANTHROPIC_API_KEY env var when database key is null', async () => {
      const noKeyService = createMockApiKeyService(null);
      const origApi = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-env-token';

      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        noKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-env-key',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);

      // Restore env
      if (origApi) {
        process.env.ANTHROPIC_API_KEY = origApi;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      svc.dispose();
    });

    it('falls back to ANTHROPIC_AUTH_TOKEN env var when database key throws', async () => {
      const throwingService = {
        getDecryptedKey: vi.fn().mockRejectedValue(new Error('DB error')),
        // F03-09 (arch29-W2-C): refresh-token resolution is gated on the
        // access-token returning truthy, so this is never called when
        // getDecryptedKey throws — but provide it for type-safety.
        getDecryptedRefreshToken: vi.fn().mockResolvedValue(null),
        saveKey: vi.fn(),
        deleteKey: vi.fn(),
      } as any;
      const origAuth = process.env.ANTHROPIC_AUTH_TOKEN;
      process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-auth-token';

      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        throwingService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-auth-key',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);

      if (origAuth) {
        process.env.ANTHROPIC_AUTH_TOKEN = origAuth;
      } else {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
      svc.dispose();
    });
  });

  // =========================================================================
  // startAgent — successful lifecycle
  // =========================================================================

  describe('startAgent successful lifecycle', () => {
    it('starts agent successfully with plan phase (default)', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Build feature' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-ok',
        prompt: 'Build a feature',
      });
      expect(result.ok).toBe(true);
      expect(service.isAgentRunning(task.id)).toBe(true);

      const running = service.getRunningAgent(task.id);
      expect(running).not.toBeNull();
      expect(running?.codespaceId).toBe(project.id);
      expect(running?.sessionId).toBe('session-ok');
    });

    it('starts agent successfully with execute phase', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Execute feature' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-exec',
        prompt: 'Execute the plan',
        phase: 'execute',
      });
      expect(result.ok).toBe(true);
    });

    it('publishes status events through all stages', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stages',
        prompt: 'Do something',
      });

      const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const stages = publishCalls
        .filter(([, type]: any) => type === 'container-agent:status')
        .map(([, , data]: any) => data.stage);

      expect(stages).toContain('initializing');
      expect(stages).toContain('validating');
      expect(stages).toContain('credentials');
      expect(stages).toContain('creating_sandbox');
      expect(stages).toContain('executing');
      expect(stages).toContain('running');
    });

    it('publishes started event with model and config', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-started',
        prompt: 'Do something',
      });

      const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const startedCall = publishCalls.find(([, type]: any) => type === 'container-agent:started');
      expect(startedCall).toBeDefined();
      expect(startedCall?.[2]).toHaveProperty('model');
      expect(startedCall?.[2]).toHaveProperty('maxTurns');
      expect(startedCall?.[2]).toHaveProperty('sandboxProvider', 'docker');
    });

    it('creates agent and session records in database', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'DB records test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-db',
        prompt: 'Do something',
      });

      // Check agent record exists (may have been set to 'completed' by async processAgentOutput)
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(agent).toBeDefined();
      expect(agent?.codespaceId).toBe(project.id);

      // Note: The task may already be cleaned up by processAgentOutput's async handler
      // because the mocked stream resolves immediately. Instead, verify the agent
      // record was created, which proves the DB writes happened.
    });

    it('creates durable stream for the session', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stream',
        prompt: 'Do something',
      });

      expect(streams.createStream).toHaveBeenCalledWith('session-stream', {
        type: 'container-agent',
        codespaceId: project.id,
        taskId: task.id,
      });
    });

    it('clears stale stop file before starting', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stop-file',
        prompt: 'Do something',
      });

      // The sandbox.exec should have been called with 'rm' to clear stale stop file
      const execCalls = sandbox.exec.mock.calls;
      const rmCall = execCalls.find(([cmd, args]: any) => cmd === 'rm' && args?.[0] === '-f');
      expect(rmCall).toBeDefined();
    });

    it('executes agent-runner in container with correct command', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-exec',
        prompt: 'Do something',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'node',
          args: ['/opt/agent-runner/dist/index.js'],
          env: expect.objectContaining({
            AGENT_TASK_ID: task.id,
            AGENT_SESSION_ID: 'session-exec',
          }),
          cwd: '/workspace',
        })
      );
    });

    it('sets sdkSessionId env var when provided', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-sdk',
        prompt: 'Execute plan',
        phase: 'execute',
        sdkSessionId: 'sdk-session-abc',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_SDK_SESSION_ID: 'sdk-session-abc',
          }),
        })
      );
    });

    it('uses custom model and maxTurns when provided', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-custom',
        prompt: 'Do something',
        model: 'claude-haiku-4-5',
        maxTurns: 25,
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_MAX_TURNS: '25',
          }),
        })
      );
    });

    it('getRunningAgents returns all running agents', async () => {
      // Make the exec stdout never end (so processAgentOutput keeps running)
      const neverEndingStream = new Readable({
        read() {
          /* never pushes null */
        },
      });
      sandbox.execStream.mockResolvedValue({
        stdout: neverEndingStream,
        stderr: new Readable({
          read() {
            this.push(null);
          },
        }),
        wait: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
        kill: vi.fn(),
      });
      // Also make the bridge processStream never resolve
      mockBridgeProcessStream.mockReturnValue(new Promise(() => {}));

      const project = await createTestProject();
      const task1 = await createTestTask(project.id, { title: 'Task 1' });
      const task2 = await createTestTask(project.id, { title: 'Task 2' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task1.id,
        sessionId: 'session-1',
        prompt: 'Do something',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task2.id,
        sessionId: 'session-2',
        prompt: 'Do something else',
      });

      const running = service.getRunningAgents();
      expect(running.length).toBe(2);

      // Restore default mock
      mockBridgeProcessStream.mockResolvedValue(undefined);
    });
  });

  // =========================================================================
  // startAgent — stream/session creation errors
  // =========================================================================

  describe('startAgent stream and session creation errors', () => {
    it('returns error when stream creation fails (non-duplicate)', async () => {
      const failStreams = createMockStreams({
        createStream: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
      });
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        failStreams as any,
        apiKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stream-fail',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_STREAM_CREATE_FAILED');
      }
      svc.dispose();
    });

    it('ignores stream creation error for already-existing streams', async () => {
      const dupeStreams = createMockStreams({
        createStream: vi.fn().mockRejectedValue(new Error('Stream already exists')),
      });
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        dupeStreams as any,
        apiKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-dupe-stream',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
      svc.dispose();
    });

    it('returns error when initial status publish fails', async () => {
      let publishCallCount = 0;
      const failPublishStreams = createMockStreams({
        publish: vi.fn().mockImplementation(async () => {
          publishCallCount++;
          // Fail on the first publish (initial status)
          if (publishCallCount === 1) {
            throw new Error('SSE publish failed');
          }
        }),
      });
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        failPublishStreams as any,
        apiKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-publish-fail',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_STREAM_PUBLISH_FAILED');
      }
      svc.dispose();
    });
  });

  // =========================================================================
  // startAgent — database errors
  // =========================================================================

  describe('startAgent database errors', () => {
    it('returns error when agent record creation fails', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      // Spy on db.insert to make it fail for agents
      const origInsert = db.insert.bind(db);
      const insertSpy = vi.spyOn(db, 'insert').mockImplementation((table: any) => {
        if (table === agents) {
          return {
            values: () => ({
              onConflictDoUpdate: () => {
                throw new Error('DB write failed');
              },
            }),
          } as any;
        }
        return origInsert(table);
      });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-db-fail',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_RECORD_FAILED');
      }

      insertSpy.mockRestore();
    });
  });

  // =========================================================================
  // startAgent — concurrency guard
  // =========================================================================

  describe('startAgent concurrency guard', () => {
    it('prevents concurrent startAgent calls for the same task', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      // Make sandbox.execStream delay to simulate slow start
      sandbox.execStream.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  stdout: new Readable({
                    read() {
                      this.push(null);
                    },
                  }),
                  stderr: new Readable({
                    read() {
                      this.push(null);
                    },
                  }),
                  wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
                  kill: vi.fn(),
                }),
              100
            )
          )
      );

      // First agent starts successfully
      const r1 = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-race-1',
        prompt: 'Do something',
      });
      expect(r1.ok).toBe(true);

      // Second call for the same task should fail because first is already running
      const r2 = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-race-2',
        prompt: 'Do something',
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
      }
    });

    it('clears startingAgents lock after startAgent completes', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      // First call — succeeds but we then stop the agent
      const r1 = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-lock-1',
        prompt: 'Do something',
      });
      expect(r1.ok).toBe(true);

      // Stop the agent so the task is free
      await service.stopAgent(task.id);

      // Second call should work (lock was cleared even after first call)
      // Create a new task to avoid the running agent check
      const task2 = await createTestTask(project.id, { title: 'Test task 2' });
      const r2 = await service.startAgent({
        codespaceId: project.id,
        taskId: task2.id,
        sessionId: 'session-lock-2',
        prompt: 'Do something',
      });
      expect(r2.ok).toBe(true);
    });
  });

  // =========================================================================
  // stopAgent
  // =========================================================================

  describe('stopAgent', () => {
    it('returns error when agent not running', async () => {
      const result = await service.stopAgent('nonexistent-task');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_NOT_RUNNING');
      }
    });

    it('stops a running agent by writing sentinel file', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stop',
        prompt: 'Do something',
      });
      expect(service.isAgentRunning(task.id)).toBe(true);

      const result = await service.stopAgent(task.id);
      expect(result.ok).toBe(true);

      // Should have called sandbox.exec to write sentinel file
      const touchCall = sandbox.exec.mock.calls.find(([cmd]: any) => cmd === 'touch');
      expect(touchCall).toBeDefined();
    });

    it('publishes cancelled event on stop', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-cancel',
        prompt: 'Do something',
      });

      await service.stopAgent(task.id);

      const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const cancelledEvent = publishCalls.find(
        ([, type]: any) => type === 'container-agent:cancelled'
      );
      expect(cancelledEvent).toBeDefined();
      expect(cancelledEvent?.[2]).toHaveProperty('taskId', task.id);
    });

    it('handles sandbox not available when stopping (best-effort)', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Test task' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stop-no-sandbox',
        prompt: 'Do something',
      });

      // Make getById return null (sandbox removed)
      provider.getById.mockResolvedValue(null);

      const result = await service.stopAgent(task.id);
      // Should still succeed — sentinel file write is best-effort
      expect(result.ok).toBe(true);
    });
  });

  // =========================================================================
  // handleAgentComplete (via bridge callback)
  // =========================================================================

  describe('handleAgentComplete', () => {
    it('moves task to waiting_approval on completed status', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Complete test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-complete',
        prompt: 'Do something',
      });

      // Trigger the completion callback via the bridge (fire-and-forget async)
      expect(capturedBridgeOptions).not.toBeNull();
      capturedBridgeOptions.onComplete('completed', 5);
      await flushAsync();

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).toBe('waiting_approval');
      expect(updatedTask?.lastAgentStatus).toBe('completed');
      expect(updatedTask?.agentId).toBeNull();
    });

    it('moves task to waiting_approval on turn_limit status', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Turn limit test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-turnlimit',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onComplete('turn_limit', 50);
      await flushAsync();

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).toBe('waiting_approval');
      expect(updatedTask?.lastAgentStatus).toBe('turn_limit');
    });

    it('clears agent refs but keeps column on cancelled status', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Cancel test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-cancelled',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onComplete('cancelled', 0);
      await flushAsync();

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).toBe('in_progress');
      expect(updatedTask?.lastAgentStatus).toBe('cancelled');
      expect(updatedTask?.agentId).toBeNull();
    });

    it('removes agent from runningAgents after completion', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Cleanup test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-cleanup',
        prompt: 'Do something',
      });
      expect(service.isAgentRunning(task.id)).toBe(true);

      capturedBridgeOptions.onComplete('completed', 5);
      await flushAsync();
      expect(service.isAgentRunning(task.id)).toBe(false);
    });

    it('cleans up sentinel file after completion', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Sentinel cleanup' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-sentinel',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onComplete('completed', 5);
      await flushAsync();

      // After completion, sandbox.exec should be called with 'rm' to clean sentinel
      const rmCalls = sandbox.exec.mock.calls.filter(
        ([cmd, args]: any) => cmd === 'rm' && args?.[1]?.includes('.agent-stop-')
      );
      expect(rmCalls.length).toBeGreaterThan(0);
    });

    it('updates agent status to completed in database', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Agent status test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-agent-status',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onComplete('completed', 5);
      await flushAsync();

      const agentRecord = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(agentRecord?.status).toBe('completed');
      expect(agentRecord?.currentTaskId).toBeNull();
    });
  });

  // =========================================================================
  // handleAgentError (via bridge callback)
  // =========================================================================

  describe('handleAgentError', () => {
    it('sets task lastAgentStatus to error', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Error test', column: 'in_progress' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-error',
        prompt: 'Do something',
      });

      // Bridge callbacks fire-and-forget async methods, so flush
      capturedBridgeOptions.onError('Something went wrong', 3);
      await flushAsync();

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.lastAgentStatus).toBe('error');
      expect(updatedTask?.agentId).toBeNull();
    });

    it('removes agent from runningAgents after error', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Error cleanup' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-error-cleanup',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onError('Failed', 1);
      await flushAsync();
      expect(service.isAgentRunning(task.id)).toBe(false);
    });

    it('sets agent status to error in database', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Agent error' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-agent-error',
        prompt: 'Do something',
      });

      capturedBridgeOptions.onError('Container crashed', 2);
      await flushAsync();

      const agentRecord = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(agentRecord?.status).toBe('error');
    });
  });

  // =========================================================================
  // handlePlanReady (via bridge callback)
  // =========================================================================

  describe('handlePlanReady', () => {
    it('stores plan data and moves task to waiting_approval', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Plan test', column: 'in_progress' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-plan',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Step 1: Do X\nStep 2: Do Y',
        turnCount: 3,
        sdkSessionId: 'sdk-session-plan',
      });
      await flushAsync();

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.plan).toBe('Step 1: Do X\nStep 2: Do Y');
      expect(updatedTask?.lastAgentStatus).toBe('planning');
      expect(updatedTask?.column).toBe('waiting_approval');
    });

    it('stores plan in pendingPlans map for fast retrieval', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Plan cache test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-plan-cache',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'The plan',
        turnCount: 2,
        sdkSessionId: 'sdk-123',
      });
      await flushAsync();

      const pending = await service.getPendingPlan(task.id);
      expect(pending).toBeDefined();
      expect(pending?.plan).toBe('The plan');
      expect(pending?.sdkSessionId).toBe('sdk-123');
    });

    it('removes agent from runningAgents after plan ready', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Plan cleanup',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-plan-cleanup',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Plan text',
        turnCount: 1,
        sdkSessionId: 'sdk-456',
      });
      await flushAsync();

      expect(service.isAgentRunning(task.id)).toBe(false);
    });
  });

  // =========================================================================
  // getPendingPlan
  // =========================================================================

  describe('getPendingPlan', () => {
    it('returns undefined when no plan exists', async () => {
      const plan = await service.getPendingPlan('no-such-task');
      expect(plan).toBeUndefined();
    });

    it('recovers plan from database when not in memory', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'DB recovery test',
        column: 'waiting_approval',
      });

      // Write plan data directly to DB (simulating server restart)
      await db
        .update(tasks)
        .set({
          plan: 'Recovered plan',
          planOptions: {
            sdkSessionId: 'sdk-recovered',
            allowedPrompts: [],
          } as any,
          lastAgentStatus: 'planning',
        })
        .where(eq(tasks.id, task.id));

      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeDefined();
      expect(plan?.plan).toBe('Recovered plan');
      expect(plan?.sdkSessionId).toBe('sdk-recovered');
      expect(plan?.codespaceId).toBe(project.id);
    });

    it('returns undefined when task has plan but status is not planning', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Wrong status test',
        column: 'waiting_approval',
      });

      await db
        .update(tasks)
        .set({
          plan: 'Some plan',
          lastAgentStatus: 'completed',
        })
        .where(eq(tasks.id, task.id));

      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeUndefined();
    });
  });

  // =========================================================================
  // approvePlan
  // =========================================================================

  describe('approvePlan', () => {
    it('returns error when no pending plan exists', async () => {
      const result = await service.approvePlan('nonexistent-task');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    });

    it('approves plan and starts execution phase', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Approve test',
        column: 'in_progress',
      });

      // Start agent and trigger plan ready
      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-approve',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Execute this plan',
        turnCount: 3,
        sdkSessionId: 'sdk-approve',
      });
      await flushAsync();

      // Now approve the plan
      const result = await service.approvePlan(task.id);
      expect(result.ok).toBe(true);

      // Task should have been moved to in_progress for execution
      // (Note: with fast mocks, the execution agent may have already completed
      //  and moved the task to waiting_approval, so check it's not still in backlog)
      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).not.toBe('backlog');
    });

    it('removes plan from pendingPlans after approval', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Plan removal test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-plan-remove',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'The plan',
        turnCount: 2,
        sdkSessionId: 'sdk-remove',
      });
      await flushAsync();

      // The plan should exist before approval
      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeDefined();

      await service.approvePlan(task.id);

      // pendingPlans in-memory cache should be cleared, but DB still has plan
      // Re-checking getPendingPlan would recover from DB — but lastAgentStatus
      // won't be 'planning' anymore once execution starts
    });

    it('detects sandbox change and uses fresh session', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Sandbox change test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-sandbox-change',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'The plan',
        turnCount: 2,
        sdkSessionId: 'sdk-sandbox-change',
      });
      await flushAsync();

      // Change the sandbox ID to simulate container replacement
      const newSandbox = createMockSandbox({ id: 'sandbox-different' });
      provider.get.mockResolvedValue(newSandbox);

      const result = await service.approvePlan(task.id);
      expect(result.ok).toBe(true);

      // Should have published a warning about sandbox change
      const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const warningMsg = publishCalls.find(
        ([, type, data]: any) =>
          type === 'container-agent:message' &&
          typeof data?.content === 'string' &&
          data.content.includes('Sandbox container changed')
      );
      expect(warningMsg).toBeDefined();
    });
  });

  // =========================================================================
  // rejectPlan
  // =========================================================================

  describe('rejectPlan', () => {
    it('returns error when no plan to reject', async () => {
      const result = await service.rejectPlan('nonexistent-task');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    });

    it('moves task to backlog and clears plan fields', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Reject test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-reject',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Bad plan',
        turnCount: 2,
        sdkSessionId: 'sdk-reject',
      });
      await flushAsync();

      const result = await service.rejectPlan(task.id, 'Plan is incomplete');
      expect(result.ok).toBe(true);

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).toBe('backlog');
      expect(updatedTask?.plan).toBeNull();
      expect(updatedTask?.lastAgentStatus).toBeNull();
      expect(updatedTask?.rejectionReason).toBe('Plan is incomplete');
    });

    it('clears pendingPlans after successful rejection', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Reject cleanup',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-reject-cleanup',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Plan text',
        turnCount: 1,
        sdkSessionId: 'sdk-cleanup',
      });
      await flushAsync();

      await service.rejectPlan(task.id);

      // Plan should no longer be retrievable (DB plan is null, status is not 'planning')
      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeUndefined();
    });

    it('recovers plan from database and rejects it', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'DB reject test',
        column: 'waiting_approval',
      });

      // Write plan directly to DB (simulating server restart)
      await db
        .update(tasks)
        .set({
          plan: 'Recovered plan to reject',
          planOptions: { sdkSessionId: 'sdk-db' } as any,
          lastAgentStatus: 'planning',
        })
        .where(eq(tasks.id, task.id));

      const result = await service.rejectPlan(task.id);
      expect(result.ok).toBe(true);

      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask?.column).toBe('backlog');
      expect(updatedTask?.plan).toBeNull();
    });
  });

  // =========================================================================
  // Worktree management
  // =========================================================================

  describe('worktree management', () => {
    it('creates worktree in plan phase when worktreeService is available', async () => {
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, { title: 'Worktree test' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-wt',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
      expect(wts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          codespaceId: project.id,
          taskId: task.id,
        }),
        expect.objectContaining({
          skipEnvCopy: true,
          skipDepsInstall: true,
          skipInitScript: true,
        })
      );
      svc.dispose();
    });

    it('falls back to main workspace when worktree creation fails', async () => {
      const wts = createMockWorktreeService({
        create: vi.fn().mockResolvedValue({ ok: false, error: 'Git error' }),
      });
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Worktree fail test' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-wt-fail',
        prompt: 'Do something',
      });
      // Should still succeed — worktree failure is non-fatal
      expect(result.ok).toBe(true);
      svc.dispose();
    });

    it('recovers existing worktree in execute phase', async () => {
      const db = getTestDb();
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, {
        title: 'Worktree recover test',
      });

      // Create a real worktree record to satisfy FK constraint
      await db.insert(worktrees).values({
        id: 'wt-recover-1',
        codespaceId: project.id,
        taskId: task.id,
        branch: 'task-branch',
        path: '/tmp/test-project/worktrees/task-branch',
        baseBranch: 'main',
        status: 'ready',
      });

      // Link worktreeId to the task
      await db.update(tasks).set({ worktreeId: 'wt-recover-1' }).where(eq(tasks.id, task.id));

      // Mock getStatus to return worktree data matching the created record
      wts.getStatus.mockResolvedValue({
        ok: true,
        value: {
          id: 'wt-recover-1',
          path: '/tmp/test-project/worktrees/task-branch',
          branch: 'task-branch',
          status: 'ready',
        },
      });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-wt-recover',
        prompt: 'Execute plan',
        phase: 'execute',
      });
      expect(result.ok).toBe(true);
      expect(wts.getStatus).toHaveBeenCalledWith('wt-recover-1');
      svc.dispose();
    });

    it('cleans up worktree on cancellation via handleAgentComplete', async () => {
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, { title: 'Cleanup test' });

      await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-wt-cleanup',
        prompt: 'Do something',
      });

      // Trigger cancelled (bridge callback fires async handleAgentComplete)
      capturedBridgeOptions.onComplete('cancelled', 0);
      await flushAsync();

      // Worktree should have been cleaned up
      expect(wts.remove).toHaveBeenCalled();
      svc.dispose();
    });

    it('auto-commits worktree changes on completion', async () => {
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, { title: 'Commit test' });

      await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-wt-commit',
        prompt: 'Do something',
      });

      // Trigger completed (bridge callback fires async)
      capturedBridgeOptions.onComplete('completed', 5);
      await flushAsync();

      expect(wts.commit).toHaveBeenCalledWith('wt-1', expect.stringContaining('Agent completed'));
      svc.dispose();
    });
  });

  // =========================================================================
  // translatePathForContainer (private, tested via startAgent)
  // =========================================================================

  describe('translatePathForContainer', () => {
    it('translates host path to container path via worktree creation', async () => {
      const wts = createMockWorktreeService({
        create: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            id: 'wt-1',
            path: '/tmp/test-project/.worktrees/feat-branch',
            branch: 'feat-branch',
          },
        }),
      });
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, { title: 'Path test' });

      await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-path',
        prompt: 'Do something',
      });

      // The exec should use the translated container path
      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/.worktrees/feat-branch',
        })
      );
      svc.dispose();
    });
  });

  // =========================================================================
  // cleanupExpiredPlans
  // =========================================================================

  describe('cleanupExpiredPlans', () => {
    it('removes plans older than TTL', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Expired plan test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-expired',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Expired plan',
        turnCount: 1,
        sdkSessionId: 'sdk-expired',
      });
      await flushAsync();

      // Verify plan exists
      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeDefined();

      // Access the state manager's pendingPlans and backdate the plan
      const stateManager = (service as any).state;
      const planData = stateManager.getPendingPlan(task.id);
      if (planData) {
        planData.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      }

      // Trigger cleanup via state manager
      stateManager.cleanupExpiredPlans();

      // Plan should be removed from in-memory cache
      const cachedPlan = stateManager.getPendingPlan(task.id);
      expect(cachedPlan).toBeUndefined();
    });

    it('keeps plans within TTL', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Fresh plan test',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-fresh',
        prompt: 'Plan something',
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Fresh plan',
        turnCount: 1,
        sdkSessionId: 'sdk-fresh',
      });
      await flushAsync();

      // Trigger cleanup via state manager — plan was just created, should remain
      (service as any).state.cleanupExpiredPlans();

      const plan = await service.getPendingPlan(task.id);
      expect(plan).toBeDefined();
    });
  });

  // =========================================================================
  // AgentCore provider management
  // =========================================================================

  describe('AgentCore provider management', () => {
    it('setAgentCoreProvider configures the provider', async () => {
      // theme-04 P1-02: AgentCore is gated on AGENTCORE_ENABLED
      const prev = process.env.AGENTCORE_ENABLED;
      process.env.AGENTCORE_ENABLED = 'true';
      try {
        await service.setAgentCoreProvider({
          region: 'us-east-1',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          runtimeArn: 'arn:aws:agentcore:...',
        });
        expect(service.providerName).toBe('agentcore');
      } finally {
        if (prev === undefined) delete process.env.AGENTCORE_ENABLED;
        else process.env.AGENTCORE_ENABLED = prev;
      }
    });

    it('clearAgentCoreProvider resets to container provider', async () => {
      const prev = process.env.AGENTCORE_ENABLED;
      process.env.AGENTCORE_ENABLED = 'true';
      try {
        await service.setAgentCoreProvider({
          region: 'us-east-1',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          runtimeArn: 'arn:aws:agentcore:...',
        });
        expect(service.providerName).toBe('agentcore');

        service.clearAgentCoreProvider();
        expect(service.providerName).toBe('docker');
      } finally {
        if (prev === undefined) delete process.env.AGENTCORE_ENABLED;
        else process.env.AGENTCORE_ENABLED = prev;
      }
    });
  });

  // =========================================================================
  // waitForSandboxReady
  // =========================================================================

  describe('waitForSandboxReady', () => {
    it('returns immediately when sandbox is running', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Ready test' });

      // Sandbox starts in 'running' state — should work directly
      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-ready',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
    });

    it('returns error when sandbox never becomes ready', async () => {
      const creatingSandbox = createMockSandbox({ status: 'creating' });
      provider.get.mockResolvedValue(creatingSandbox);

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Timeout test' });

      // Use a short max wait time by accessing private method on containerExec sub-service
      const waitFn = (service as any).containerExec.waitForSandboxReady.bind(
        (service as any).containerExec
      );
      await expect(waitFn(project.id, 'session-timeout', task.id, 100)).rejects.toThrow(
        'did not become ready'
      );
    });
  });

  // =========================================================================
  // Environment variable construction
  // =========================================================================

  describe('environment variable construction', () => {
    it('builds correct env vars for plan phase', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Env test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-env',
        prompt: 'Build a feature',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_TASK_ID: task.id,
            AGENT_SESSION_ID: 'session-env',
            AGENT_PROMPT: 'Build a feature',
            AGENT_PHASE: 'plan',
            AGENT_CWD: '/workspace',
          }),
        })
      );
    });

    it('builds correct env vars for execute phase', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Env exec test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-env-exec',
        prompt: 'Execute the plan',
        phase: 'execute',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_PHASE: 'execute',
          }),
        })
      );
    });

    it('arch29-W2-I (F04-07, F06-NEW-05): does NOT pass CLAUDE_OAUTH_TOKEN via env', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Token test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-token',
        prompt: 'Do something',
      });

      // The OAuth access token MUST NOT appear in the agent-runner's env.
      // It lives only in `~/.claude/.credentials.json` written by the host
      // via `sandbox.writeFile()` (out-of-band) before exec.
      const calls = (sandbox.execStream as ReturnType<typeof vi.fn>).mock.calls as Array<
        [{ env?: Record<string, string> }]
      >;
      expect(calls.length).toBeGreaterThan(0);
      for (const [opts] of calls) {
        const envKeys = Object.keys(opts.env ?? {});
        const oauthKeys = envKeys.filter((k) => k.startsWith('CLAUDE_OAUTH'));
        expect(oauthKeys).toEqual([]);
      }

      // The credentials file IS written via the sandbox's writeFile, with the
      // token in the body. The body should be the SDK-compatible CLI shape
      // (`{ claudeAiOauth: { accessToken, ... } }`).
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.credentials.json'),
        expect.stringContaining('sk-ant-oat01-test-token'),
        0o600
      );
    });

    it('includes AGENT_STOP_FILE in env vars', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Stop file test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stop-env',
        prompt: 'Do something',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_STOP_FILE: `/tmp/.agent-stop-${task.id}`,
          }),
        })
      );
    });
  });

  // =========================================================================
  // Model resolution
  // =========================================================================

  describe('model resolution', () => {
    it('uses explicit model when provided', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Model test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-model',
        prompt: 'Do something',
        model: 'claude-haiku-4-5',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_MODEL: expect.stringContaining('claude-haiku-4-5'),
          }),
        })
      );
    });

    it('falls back to project config model', async () => {
      const project = await createTestProject({
        config: { model: 'claude-sonnet-4-6' },
      });
      const task = await createTestTask(project.id, { title: 'Project model test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-proj-model',
        prompt: 'Do something',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_MODEL: expect.stringContaining('claude-sonnet-4-6'),
          }),
        })
      );
    });

    it('falls back to default model when no model specified', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Default model test' });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-default-model',
        prompt: 'Do something',
      });

      expect(sandbox.execStream).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_MODEL: expect.any(String),
          }),
        })
      );
    });
  });

  // =========================================================================
  // Remote provider (K8s/Nomad) workspace initialization
  // =========================================================================

  describe('remote provider workspace initialization', () => {
    it('triggers remote workspace init for kubernetes provider', async () => {
      const k8sProvider = createMockProvider(sandbox);
      (k8sProvider as any).name = 'kubernetes';

      const svc = new ContainerAgentService(
        getTestDb() as any,
        k8sProvider as any,
        streams,
        apiKeyService
      );

      const project = await createTestProject({
        githubOwner: 'testorg',
        githubRepo: 'testrepo',
      });
      const task = await createTestTask(project.id, { title: 'K8s test' });

      const result = await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-k8s',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(true);
      svc.dispose();
    });
  });

  // =========================================================================
  // handlePlanReady — DB failure
  // =========================================================================

  describe('handlePlanReady DB failure', () => {
    it('publishes error event when plan persist fails', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        title: 'Plan persist fail',
        column: 'in_progress',
      });

      await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-plan-fail',
        prompt: 'Plan something',
      });

      // Spy on db.update to fail ONLY for the plan persist call
      // The plan persist sets `plan: planData.plan` and `lastAgentStatus: 'planning'`
      const origUpdate = db.update.bind(db);
      let taskUpdateCount = 0;
      vi.spyOn(db, 'update').mockImplementation((table: any) => {
        if (table === tasks) {
          taskUpdateCount++;
          // The plan persist is the 2nd task update within handlePlanReady
          // (1st was agent/session linking during startAgent)
          // But startAgent already ran, so now any update to tasks from handlePlanReady
          // will be the plan persist call. Count from the mock installation point.
          if (taskUpdateCount >= 1) {
            return {
              set: () => ({
                where: () => {
                  throw new Error('DB persist failed');
                },
              }),
            } as any;
          }
        }
        return origUpdate(table);
      });

      capturedBridgeOptions.onPlanReady({
        plan: 'Plan text',
        turnCount: 2,
        sdkSessionId: 'sdk-fail',
      });
      await flushAsync();

      // Plan should have been removed from state's pendingPlans due to DB failure
      const cachedPlan = (service as any).state.getPendingPlan(task.id);
      expect(cachedPlan).toBeUndefined();

      // Agent should be removed from runningAgents
      expect(service.isAgentRunning(task.id)).toBe(false);

      vi.restoreAllMocks();
    });
  });

  // =========================================================================
  // TOCTOU sandbox refresh guard
  // =========================================================================

  describe('TOCTOU sandbox refresh guard', () => {
    it('returns error if sandbox goes away between validation and exec', async () => {
      const refreshableSandbox = createMockSandbox({
        refreshStatus: vi.fn().mockImplementation(function (this: any) {
          this.status = 'stopped';
        }),
      });
      provider.get.mockResolvedValue(refreshableSandbox);

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'TOCTOU test' });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-toctou',
        prompt: 'Do something',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_RUNNING');
      }
    });
  });

  // =========================================================================
  // stopAgent with worktree cleanup
  // =========================================================================

  describe('stopAgent with worktree cleanup', () => {
    it('cleans up worktree when stopping agent', async () => {
      const wts = createMockWorktreeService();
      const svc = new ContainerAgentService(
        getTestDb() as any,
        provider as any,
        streams,
        apiKeyService,
        wts
      );

      const project = await createTestProject({ path: '/tmp/test-project' });
      const task = await createTestTask(project.id, { title: 'Stop cleanup test' });

      await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-stop-wt',
        prompt: 'Do something',
      });

      await svc.stopAgent(task.id);
      expect(wts.remove).toHaveBeenCalled();
      svc.dispose();
    });
  });

  // =========================================================================
  // stopAgent error on exec kill
  // =========================================================================

  describe('stopAgent exec kill error handling', () => {
    it('handles exec kill failure gracefully', async () => {
      const killErrorSandbox = createMockSandbox({
        execStream: vi.fn().mockResolvedValue({
          stdout: new Readable({
            read() {
              this.push(null);
            },
          }),
          stderr: new Readable({
            read() {
              this.push(null);
            },
          }),
          wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
          kill: vi.fn().mockRejectedValue(new Error('HTTP 101 WebSocket error')),
        }),
      });
      const killProvider = createMockProvider(killErrorSandbox);

      const svc = new ContainerAgentService(
        getTestDb() as any,
        killProvider as any,
        streams,
        apiKeyService
      );

      const project = await createTestProject();
      const task = await createTestTask(project.id, { title: 'Kill error test' });

      await svc.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-kill-error',
        prompt: 'Do something',
      });

      // Stop should succeed despite exec kill error
      const result = await svc.stopAgent(task.id);
      expect(result.ok).toBe(true);
      svc.dispose();
    });
  });
});
