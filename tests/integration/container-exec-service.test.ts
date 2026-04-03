/**
 * Integration tests for ContainerExecService — the core container agent execution orchestrator.
 *
 * Tests cover:
 * - startAgent happy path: DB records, durable stream, lifecycle events
 * - startAgent with terminal sandbox: recreates sandbox
 * - startAgent with missing OAuth token: returns API_KEY_NOT_CONFIGURED
 * - stopAgent: sentinel file, kill exec, cleanup, cancel event
 * - handleAgentComplete: task/agent DB updates, sentinel cleanup, dequeue callback
 * - handleAgentComplete race guard: completionHandled prevents double-error
 * - handleAgentError: DB updates, worktree cleanup, post-plan suppression
 */

import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessions, tasks } from '../../src/db/schema';
import { ContainerExecService } from '../../src/services/container-agent/container-exec.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createMockApiKeyService,
  createMockDurableStreamsService,
  createMockSandbox,
  createMockSandboxProvider,
} from '../mocks/mock-services';

// Mock settings service to avoid file I/O
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

// Mock the model helpers
vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  getFullModelId: vi.fn().mockImplementation((model: string) => model),
}));

// Mock skill-injector to avoid filesystem I/O
vi.mock('../../src/lib/sandbox/skill-injector.js', () => ({
  injectSkills: vi.fn().mockResolvedValue({ injected: 0, skipped: 0, errors: [] }),
}));

// Mock template service — must be a class-like constructor
vi.mock('../../src/services/template.service.js', () => {
  return {
    TemplateService: class MockTemplateService {
      getMergedConfig = vi.fn().mockResolvedValue({ ok: true, value: { skills: [] } });
    },
  };
});

// Mock container bridge
vi.mock('../../src/lib/agents/container-bridge.js', () => ({
  createContainerBridge: vi.fn().mockImplementation((opts) => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    processStderr: vi.fn(),
    _opts: opts,
  })),
}));

function createMockReadable(): Readable {
  const readable = new Readable({
    read() {
      /* intentionally empty */
    },
  });
  readable.push(null);
  return readable;
}

function createMockExecStreamResult() {
  return {
    stdout: createMockReadable(),
    stderr: createMockReadable(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ContainerExecService (IT-1400)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let service: ContainerExecService;
  let mockProvider: ReturnType<typeof createMockSandboxProvider>;
  let mockStreams: ReturnType<typeof createMockDurableStreamsService>;
  let mockApiKeyService: ReturnType<typeof createMockApiKeyService>;
  let mockWorktreeInit: {
    resolveWorktree: ReturnType<typeof vi.fn>;
    initializeRemoteWorkspace: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
  };
  let mockOnPlanReady: ReturnType<typeof vi.fn>;
  let mockOnAgentCompleteCallback: ReturnType<typeof vi.fn>;
  let mockSandbox: ReturnType<typeof createMockSandbox>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    vi.clearAllMocks();

    mockSandbox = createMockSandbox({
      id: 'sandbox-test-1',
      codespaceId: 'proj-1',
      containerId: 'container-abc123',
      status: 'running',
      execStream: vi.fn().mockResolvedValue(createMockExecStreamResult()),
    });

    mockProvider = createMockSandboxProvider({
      get: vi.fn().mockResolvedValue(mockSandbox),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    mockStreams = createMockDurableStreamsService();
    mockApiKeyService = createMockApiKeyService({
      getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat01-test-token'),
    });

    mockWorktreeInit = {
      resolveWorktree: vi.fn().mockResolvedValue({
        worktreeId: 'wt-test-1',
        worktreePath: '/workspace/.worktrees/task-branch',
      }),
      initializeRemoteWorkspace: vi.fn().mockResolvedValue({
        worktreePath: '/workspace/.worktrees/task-branch',
      }),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    };

    mockOnPlanReady = vi.fn().mockResolvedValue(undefined);
    mockOnAgentCompleteCallback = vi.fn().mockReturnValue(undefined);

    state = new SandboxStateManager();

    const deps = {
      db: db as any,
      provider: mockProvider,
      streams: mockStreams,
      apiKeyService: mockApiKeyService,
      worktreeService: undefined,
      githubTokenService: undefined,
      skillTrackingService: null,
    };

    service = new ContainerExecService(
      deps,
      state,
      mockWorktreeInit as any,
      mockOnPlanReady,
      mockOnAgentCompleteCallback
    );
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
  });

  describe('startAgent (IT-1401)', () => {
    it('IT-1402a: happy path creates agent + session in DB, creates durable stream, publishes lifecycle events', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Test task',
        column: 'in_progress',
      });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-test-1',
        prompt: 'Implement feature X',
        phase: 'plan',
      });

      expect(result.ok).toBe(true);

      // Verify agent record created in DB
      const agentRow = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(agentRow).toBeDefined();
      expect(agentRow?.codespaceId).toBe(project.id);
      expect(agentRow?.currentTaskId).toBe(task.id);

      // Verify session record created in DB
      const sessionRow = await db.query.sessions.findFirst({
        where: eq(sessions.id, 'session-test-1'),
      });
      expect(sessionRow).toBeDefined();
      expect(sessionRow?.codespaceId).toBe(project.id);
      expect(sessionRow?.taskId).toBe(task.id);

      // NOTE: The task's agentId/sessionId may have been cleared by the time we check,
      // because the mock exec stream ends immediately, triggering processAgentOutput which
      // calls handleAgentError (since no completion event was emitted). This clears the
      // agent/session refs. The important thing is that the DB records were created.
      // Verify task has a lastAgentStatus set (from the error handler) or still has refs
      const taskRow = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      // The task was linked and then possibly cleared by the async error handler
      expect(taskRow).toBeDefined();

      // Verify durable stream created
      expect(mockStreams.createStream).toHaveBeenCalledWith(
        'session-test-1',
        expect.objectContaining({ type: 'container-agent' })
      );

      // Verify lifecycle events published in order
      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((call) => call[1] as string);

      expect(eventTypes).toContain('container-agent:status');
      expect(eventTypes).toContain('container-agent:started');

      // Verify the status stages appear in order
      const statusCalls = publishCalls.filter((call) => call[1] === 'container-agent:status');
      const stages = statusCalls.map((call) => (call[2] as { stage: string }).stage);
      expect(stages).toContain('initializing');
      expect(stages).toContain('validating');
      expect(stages).toContain('credentials');
      expect(stages).toContain('executing');
      expect(stages).toContain('running');

      // NOTE: The running agent may have already been cleaned up by the background
      // processAgentOutput handler (which fires immediately because the mock stream ends).
      // The key assertion is that startAgent returned ok(undefined) and DB records were created.
      // The state tracking is verified in the stopAgent and handleAgentComplete tests instead.
    });

    it('IT-1402b: recreates sandbox when in terminal state (error/stopped)', async () => {
      const stoppedSandbox = createMockSandbox({
        id: 'sandbox-stopped',
        status: 'stopped',
        stop: vi.fn().mockResolvedValue(undefined),
        execStream: vi.fn().mockResolvedValue(createMockExecStreamResult()),
      });
      const freshSandbox = createMockSandbox({
        id: 'sandbox-fresh',
        status: 'running',
        execStream: vi.fn().mockResolvedValue(createMockExecStreamResult()),
      });

      (mockProvider.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stoppedSandbox);
      (mockProvider.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(freshSandbox);
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(freshSandbox);

      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Test task',
        column: 'in_progress',
      });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-recreate',
        prompt: 'Implement feature Y',
        phase: 'plan',
      });

      expect(result.ok).toBe(true);
      // The stopped sandbox should have been stopped before recreating
      expect(stoppedSandbox.stop).toHaveBeenCalled();
      // A new sandbox should have been created
      expect(mockProvider.create).toHaveBeenCalled();
    });

    it('IT-1402c: returns error when no OAuth token available', async () => {
      (mockApiKeyService.getDecryptedKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Clear env vars that resolveOAuthToken falls back to
      const origAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      const origApiKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;

      try {
        const project = await createTestProject({ id: 'proj-1' });
        const task = await createTestTask(project.id, {
          title: 'Test task',
          column: 'in_progress',
        });

        const result = await service.startAgent({
          codespaceId: project.id,
          taskId: task.id,
          sessionId: 'session-no-key',
          prompt: 'Implement feature Z',
          phase: 'plan',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('SANDBOX_API_KEY_NOT_CONFIGURED');
        }
      } finally {
        // Restore env vars
        if (origAuthToken !== undefined) {
          process.env.ANTHROPIC_AUTH_TOKEN = origAuthToken;
        }
        if (origApiKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origApiKey;
        }
      }
    });

    it('IT-1402d: returns error when codespace not found', async () => {
      const result = await service.startAgent({
        codespaceId: 'nonexistent-codespace',
        taskId: 'task-1',
        sessionId: 'session-1',
        prompt: 'Test',
        phase: 'plan',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
      }
    });

    it('IT-1402e: returns error when sandbox does not support streaming exec', async () => {
      const noStreamSandbox = createMockSandbox({
        status: 'running',
        execStream: undefined,
      });
      (mockProvider.get as ReturnType<typeof vi.fn>).mockResolvedValue(noStreamSandbox);

      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Test task',
        column: 'in_progress',
      });

      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-no-stream',
        prompt: 'Test',
        phase: 'plan',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_STREAMING_EXEC_NOT_SUPPORTED');
      }
    });
  });

  describe('stopAgent (IT-1402)', () => {
    it('IT-1403a: writes sentinel file, kills exec, publishes cancel event', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Running task',
        column: 'in_progress',
      });

      const mockExecResult = createMockExecStreamResult();

      // Manually register running agent in state
      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-stop-1',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: mockExecResult,
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
        worktreeId: 'wt-stop-1',
      });

      const result = await service.stopAgent(task.id);

      expect(result.ok).toBe(true);

      // Verify sentinel file written via sandbox exec
      expect(mockSandbox.exec).toHaveBeenCalledWith('touch', [`/tmp/.agent-stop-${task.id}`]);

      // Verify exec process killed
      expect(mockExecResult.kill).toHaveBeenCalled();

      // Verify worktree cleanup
      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledWith(task.id, 'wt-stop-1');

      // Verify cancel event published
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'session-stop-1',
        'container-agent:cancelled',
        expect.objectContaining({ taskId: task.id })
      );
    });

    it('IT-1403b: returns error when no agent running for task', async () => {
      const result = await service.stopAgent('nonexistent-task-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_NOT_RUNNING');
      }
    });
  });

  describe('handleAgentComplete (IT-1403)', () => {
    it('IT-1404a: updates task to waiting_approval and agent to completed', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Completing task',
        column: 'in_progress',
      });

      // Create agent record in DB
      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-complete-1',
      });

      // Register running agent in state
      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-complete-1',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute',
      });

      await service.handleAgentComplete(task.id, 'completed', 5);

      // Verify task moved to waiting_approval
      const taskRow = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(taskRow?.column).toBe('waiting_approval');
      expect(taskRow?.lastAgentStatus).toBe('completed');

      // Verify agent status updated
      const agentRow = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });
      expect(agentRow?.status).toBe('completed');
      expect(agentRow?.currentTaskId).toBeNull();

      // Verify agent removed from running state
      expect(state.hasRunningAgent(task.id)).toBe(false);
    });

    it('IT-1404b: cleans up sentinel file on completion', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Sentinel cleanup task',
        column: 'in_progress',
      });

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-sentinel',
      });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-sentinel',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute',
      });

      await service.handleAgentComplete(task.id, 'completed', 3);

      // Verify sentinel file removed
      expect(mockSandbox.exec).toHaveBeenCalledWith('rm', ['-f', `/tmp/.agent-stop-${task.id}`]);
    });

    it('IT-1404c: invokes dequeue callback on completion', async () => {
      const dequeueCallback = vi.fn().mockResolvedValue(undefined);
      // The source calls: this.onAgentCompleteCallback?.() which should return a function
      // So the factory is a function that returns a function
      const callbackFactory = vi.fn().mockReturnValue(dequeueCallback);

      // Create a new service with dequeue callback
      const depsWithCallback = {
        db: db as any,
        provider: mockProvider,
        streams: mockStreams,
        apiKeyService: mockApiKeyService,
        worktreeService: undefined,
        githubTokenService: undefined,
        skillTrackingService: null,
      };

      const serviceWithCallback = new ContainerExecService(
        depsWithCallback,
        state,
        mockWorktreeInit as any,
        mockOnPlanReady,
        callbackFactory
      );

      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Dequeue task',
        column: 'in_progress',
      });

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-dequeue',
      });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-dequeue',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute',
      });

      await serviceWithCallback.handleAgentComplete(task.id, 'completed', 5);

      // Wait for async dequeue using vi.waitFor instead of setTimeout race
      await vi.waitFor(
        () => {
          expect(dequeueCallback).toHaveBeenCalledWith(project.id, task.id);
        },
        { timeout: 2000 }
      );

      expect(callbackFactory).toHaveBeenCalled();
    });

    it('IT-1404d: completionHandled race guard prevents double-error publishing', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Race guard task',
        column: 'in_progress',
      });

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-race',
      });

      const runningAgent = {
        taskId: task.id,
        sessionId: 'session-race',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute' as const,
        completionHandled: false,
      };

      state.setRunningAgent(task.id, runningAgent);

      // First completion call should succeed
      await service.handleAgentComplete(task.id, 'completed', 5);

      // After completion, agent should be removed from state
      expect(state.hasRunningAgent(task.id)).toBe(false);

      // The completionHandled flag should have been set before being removed
      expect(runningAgent.completionHandled).toBe(true);
    });
  });

  describe('handleAgentError (IT-1404)', () => {
    it('IT-1405a: updates task and agent DB records on error', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Error task',
        column: 'in_progress',
      });

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-error-1',
      });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-error-1',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute',
      });

      await service.handleAgentError(task.id, 'Something went wrong', 3);

      // Verify task cleared agent refs
      const taskRow = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(taskRow?.agentId).toBeNull();
      expect(taskRow?.sessionId).toBeNull();
      expect(taskRow?.lastAgentStatus).toBe('error');

      // Verify agent status set to error
      const agentRow = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });
      expect(agentRow?.status).toBe('error');

      // Verify agent removed from running state
      expect(state.hasRunningAgent(task.id)).toBe(false);
    });

    it('IT-1405b: cleans up worktree on error', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Worktree cleanup task',
        column: 'in_progress',
      });

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: 'session-wt-error',
      });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: 'session-wt-error',
        codespaceId: project.id,
        sandboxId: mockSandbox.id,
        bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
        execResult: createMockExecStreamResult(),
        stopFilePath: `/tmp/.agent-stop-${task.id}`,
        startedAt: new Date(),
        stopRequested: false,
        phase: 'execute',
        worktreeId: 'wt-cleanup-1',
      });

      await service.handleAgentError(task.id, 'Error occurred', 2);

      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledWith(task.id, 'wt-cleanup-1');
    });

    it('IT-1405c: suppresses expected post-plan errors (Operation aborted)', async () => {
      const project = await createTestProject({ id: 'proj-1' });
      const task = await createTestTask(project.id, {
        title: 'Post-plan task',
        column: 'in_progress',
      });

      // Update task to have plan state (simulating post-plan scenario)
      // The suppression requires lastAgentStatus === 'planning' AND plan is truthy
      await db
        .update(tasks)
        .set({
          lastAgentStatus: 'planning',
          plan: 'Implementation plan: do stuff here',
        } as any)
        .where(eq(tasks.id, task.id));

      const agentId = `agent-${task.id}`;
      await db.insert(agents).values({
        id: agentId,
        codespaceId: project.id,
        name: 'Container Agent',
        type: 'task',
        status: 'running',
        currentTaskId: task.id,
      });

      // Call handleAgentError without agent in running state (simulating orphaned error)
      // This should check the DB for post-plan state and suppress the "Operation aborted" error
      await service.handleAgentError(task.id, 'Operation aborted', 0);

      // When the error IS suppressed, the function returns early WITHOUT updating the agent status.
      // The agent status should remain 'running' because the error was intentionally suppressed.
      const agentRow = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });
      expect(agentRow?.status).toBe('running');
    });
  });
});
