/**
 * Integration tests for AgentCoreBridgeService — the AgentCore-specific execution pathway.
 *
 * Tests verify agent start via AgentCore invoke + SSE, stop, completion handling,
 * error handling, and fallback to ContainerExecService.
 * Uses real SQLite DB for state verification.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessions, tasks } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the agentcore-bridge module
vi.mock('../../src/lib/agents/agentcore-bridge.js', () => ({
  createAgentCoreBridge: vi.fn(() => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  })),
}));

// Mock settings service
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

// Mock shared helpers
vi.mock('../../src/services/container-agent/shared-helpers.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/container-agent/shared-helpers.js')>();
  return {
    ...original,
    resolveOAuthToken: vi.fn().mockResolvedValue('mock-oauth-token'),
    updateAgentStatus: vi.fn().mockResolvedValue(undefined),
    updateTaskOnAgentComplete: vi.fn().mockResolvedValue(true),
    updateTaskOnAgentError: vi.fn().mockResolvedValue(undefined),
  };
});

// Suppress logger output
vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock constants
vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  getFullModelId: (id: string) => id,
}));

// Import after mocks
import { AgentCoreBridgeService } from '../../src/services/container-agent/agentcore-bridge.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import {
  resolveOAuthToken,
  updateAgentStatus,
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from '../../src/services/container-agent/shared-helpers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    deleteStream: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProvider() {
  const mockInstance = {
    invoke: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'status', data: { stage: 'running' } };
      })()
    ),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  return {
    provider: {
      get: vi.fn().mockReturnValue(mockInstance),
      create: vi.fn().mockReturnValue(mockInstance),
      getOrCreateSession: vi.fn().mockReturnValue('runtime-session-1'),
      removeSession: vi.fn(),
    },
    instance: mockInstance,
  };
}

function createMockContainerExec() {
  return {
    handleAgentComplete: vi.fn().mockResolvedValue(undefined),
    handleAgentError: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockApiKeyService() {
  return {
    getApiKey: vi.fn().mockResolvedValue('test-api-key'),
    getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat01-test-token'),
    // F03-09 (arch29-W2-C): default to null (no refresh token stored).
    getDecryptedRefreshToken: vi.fn().mockResolvedValue(null),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentCoreBridgeService (IT-1650 to IT-1651)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let mockProviderSetup: ReturnType<typeof createMockProvider>;
  let mockContainerExec: ReturnType<typeof createMockContainerExec>;
  let service: AgentCoreBridgeService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    state = new SandboxStateManager();
    mockStreams = createMockStreams();
    mockProviderSetup = createMockProvider();
    mockContainerExec = createMockContainerExec();

    const deps = {
      db,
      provider: {} as never, // Not used by AgentCoreBridgeService directly
      streams: mockStreams as never,
      apiKeyService: createMockApiKeyService() as never,
    };

    service = new AgentCoreBridgeService(
      deps,
      state,
      mockContainerExec as never,
      () => mockProviderSetup.provider as never,
      vi.fn().mockResolvedValue(undefined),
      () => undefined
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.clearAllMocks();
    // Cleanup state manager interval
    state.dispose();
  });

  describe('startAgentCoreAgent', () => {
    it('IT-1650: happy path — creates agent, session, publishes status events, returns ok', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Test task',
      });

      const result = await service.startAgentCoreAgent(
        {
          codespaceId: codespace.id,
          taskId: task.id,
          sessionId: 'session-ac-1',
          prompt: 'Implement feature',
          phase: 'plan',
        },
        {
          id: codespace.id,
          name: codespace.name,
          path: codespace.path,
          config: null,
        }
      );

      expect(result.ok).toBe(true);

      // Verify agent record created in DB
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(agent).toBeDefined();
      expect(agent!.codespaceId).toBe(codespace.id);

      // Verify session record created in DB
      const session = await db.query.sessions.findFirst({
        where: eq(sessions.id, 'session-ac-1'),
      });
      expect(session).toBeDefined();
      expect(session!.sandboxProvider).toBe('agentcore');

      // Verify task linked to agent and session
      const updatedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(updatedTask!.agentId).toBe(`agent-${task.id}`);
      expect(updatedTask!.sessionId).toBe('session-ac-1');

      // Verify status events published
      const statusCalls = mockStreams.publish.mock.calls.filter(
        (call: unknown[]) => (call[1] as string) === 'container-agent:status'
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(3); // initializing, validating, executing

      // Verify started event published (proves agent was set in state and execution began)
      const startedCalls = mockStreams.publish.mock.calls.filter(
        (call: unknown[]) => (call[1] as string) === 'container-agent:started'
      );
      expect(startedCalls.length).toBe(1);

      // Note: hasRunningAgentCoreAgent may be false by now because
      // processAgentCoreOutput runs asynchronously and the bridge mock
      // resolves immediately, triggering cleanup. The "started" event
      // above confirms the agent was properly tracked.
    });

    it('IT-1652: returns error when provider is undefined', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      // Create service with null provider
      const deps = {
        db,
        provider: {} as never,
        streams: mockStreams as never,
        apiKeyService: createMockApiKeyService() as never,
      };
      const serviceNoProvider = new AgentCoreBridgeService(
        deps,
        state,
        mockContainerExec as never,
        () => undefined, // No provider
        vi.fn().mockResolvedValue(undefined),
        () => undefined
      );

      const result = await serviceNoProvider.startAgentCoreAgent(
        {
          codespaceId: codespace.id,
          taskId: task.id,
          sessionId: 'session-no-provider',
          prompt: 'Test',
        },
        { id: codespace.id, name: codespace.name, path: codespace.path }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('removed');
      }
    });

    it('IT-1653: returns error when task not found', async () => {
      const codespace = await createTestProject();

      const result = await service.startAgentCoreAgent(
        {
          codespaceId: codespace.id,
          taskId: 'nonexistent-task',
          sessionId: 'session-no-task',
          prompt: 'Test',
        },
        { id: codespace.id, name: codespace.name, path: codespace.path }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('not found');
      }
    });

    it('IT-1654: returns error when no OAuth token available', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      // Override resolveOAuthToken to return null
      vi.mocked(resolveOAuthToken).mockResolvedValueOnce(null);

      const result = await service.startAgentCoreAgent(
        {
          codespaceId: codespace.id,
          taskId: task.id,
          sessionId: 'session-no-oauth',
          prompt: 'Test',
        },
        { id: codespace.id, name: codespace.name, path: codespace.path }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toContain('API_KEY');
      }
    });
  });

  describe('stopAgentCoreAgent', () => {
    it('IT-1655: stops bridge, instance, removes session, publishes cancelled', async () => {
      const mockBridge = { processStream: vi.fn(), stop: vi.fn() };
      const mockInstance = { invoke: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };

      const agent = {
        taskId: 'task-stop-1',
        sessionId: 'session-stop-1',
        codespaceId: 'cs-1',
        sandboxId: 'sb-1',
        bridge: mockBridge,
        instance: mockInstance,
        runtimeSessionId: 'runtime-1',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan' as const,
      };

      state.setRunningAgentCoreAgent('task-stop-1', agent as never);

      const result = await service.stopAgentCoreAgent(agent as never);

      expect(result.ok).toBe(true);
      expect(agent.stopRequested).toBe(true);
      expect(mockBridge.stop).toHaveBeenCalled();
      expect(mockInstance.stop).toHaveBeenCalled();
      expect(mockProviderSetup.provider.removeSession).toHaveBeenCalledWith('task-stop-1');

      // Verify cancelled event published
      const cancelledCalls = mockStreams.publish.mock.calls.filter(
        (call: unknown[]) => (call[1] as string) === 'container-agent:cancelled'
      );
      expect(cancelledCalls.length).toBe(1);

      // Verify state cleaned up
      expect(state.hasRunningAgentCoreAgent('task-stop-1')).toBe(false);
    });
  });

  describe('handleAgentCoreComplete', () => {
    it('IT-1656: updates task via shared helper, cleans up state, triggers auto-dequeue', async () => {
      const mockBridge = { processStream: vi.fn(), stop: vi.fn() };
      const mockInstance = { invoke: vi.fn(), stop: vi.fn() };

      const onCompleteCallback = vi.fn().mockResolvedValue(undefined);
      const deps = {
        db,
        provider: {} as never,
        streams: mockStreams as never,
        apiKeyService: createMockApiKeyService() as never,
      };
      const serviceWithCallback = new AgentCoreBridgeService(
        deps,
        state,
        mockContainerExec as never,
        () => mockProviderSetup.provider as never,
        vi.fn().mockResolvedValue(undefined),
        () => onCompleteCallback
      );

      const agent = {
        taskId: 'task-complete-1',
        sessionId: 'session-complete-1',
        codespaceId: 'cs-complete-1',
        sandboxId: 'sb-complete-1',
        bridge: mockBridge,
        instance: mockInstance,
        runtimeSessionId: 'runtime-complete-1',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute' as const,
      };
      state.setRunningAgentCoreAgent('task-complete-1', agent as never);

      await serviceWithCallback.handleAgentCoreComplete('task-complete-1', 'completed', 5);

      // Verify shared helper called
      expect(updateTaskOnAgentComplete).toHaveBeenCalledWith(
        db,
        'task-complete-1',
        'completed',
        expect.anything(),
        'session-complete-1',
        undefined
      );

      // Verify agent status updated
      expect(updateAgentStatus).toHaveBeenCalledWith(db, 'task-complete-1', 'completed');

      // Verify state cleaned up
      expect(state.hasRunningAgentCoreAgent('task-complete-1')).toBe(false);

      // Verify auto-dequeue callback invoked
      expect(onCompleteCallback).toHaveBeenCalledWith('cs-complete-1', 'task-complete-1');
    });

    it('IT-1657: falls back to containerExec when agent not in AgentCore map', async () => {
      // Don't add any running agent to state
      await service.handleAgentCoreComplete('task-fallback-1', 'completed', 3);

      expect(mockContainerExec.handleAgentComplete).toHaveBeenCalledWith(
        'task-fallback-1',
        'completed',
        3
      );
    });

    it('IT-1658: cancelled status does NOT trigger auto-dequeue', async () => {
      const onCompleteCallback = vi.fn().mockResolvedValue(undefined);
      const deps = {
        db,
        provider: {} as never,
        streams: mockStreams as never,
        apiKeyService: createMockApiKeyService() as never,
      };
      const serviceWithCallback = new AgentCoreBridgeService(
        deps,
        state,
        mockContainerExec as never,
        () => mockProviderSetup.provider as never,
        vi.fn().mockResolvedValue(undefined),
        () => onCompleteCallback
      );

      const agent = {
        taskId: 'task-cancel-1',
        sessionId: 'session-cancel-1',
        codespaceId: 'cs-cancel-1',
        sandboxId: 'sb-cancel-1',
        bridge: { processStream: vi.fn(), stop: vi.fn() },
        instance: { invoke: vi.fn(), stop: vi.fn() },
        runtimeSessionId: 'rt-cancel-1',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute' as const,
      };
      state.setRunningAgentCoreAgent('task-cancel-1', agent as never);

      await serviceWithCallback.handleAgentCoreComplete('task-cancel-1', 'cancelled', 0);

      // Auto-dequeue should NOT be called for cancelled
      expect(onCompleteCallback).not.toHaveBeenCalled();
    });
  });

  describe('handleAgentCoreError', () => {
    it('IT-1659: cleans up state and updates task on error', async () => {
      const mockBridge = { processStream: vi.fn(), stop: vi.fn() };
      const mockInstance = { invoke: vi.fn(), stop: vi.fn() };

      const agent = {
        taskId: 'task-error-1',
        sessionId: 'session-error-1',
        codespaceId: 'cs-error-1',
        sandboxId: 'sb-error-1',
        bridge: mockBridge,
        instance: mockInstance,
        runtimeSessionId: 'rt-error-1',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan' as const,
      };
      state.setRunningAgentCoreAgent('task-error-1', agent as never);

      await service.handleAgentCoreError('task-error-1', 'Stream failed', 2);

      // Verify shared helper called
      expect(updateTaskOnAgentError).toHaveBeenCalledWith(
        db,
        'task-error-1',
        expect.anything(),
        'session-error-1'
      );

      // Verify agent status updated
      expect(updateAgentStatus).toHaveBeenCalledWith(db, 'task-error-1', 'error');

      // Verify state cleaned up
      expect(state.hasRunningAgentCoreAgent('task-error-1')).toBe(false);
    });

    it('IT-1651: falls back to containerExec when agent not in AgentCore map', async () => {
      await service.handleAgentCoreError('task-fallback-err', 'Unknown error', 0);

      expect(mockContainerExec.handleAgentError).toHaveBeenCalledWith(
        'task-fallback-err',
        'Unknown error',
        0
      );
    });
  });
});
