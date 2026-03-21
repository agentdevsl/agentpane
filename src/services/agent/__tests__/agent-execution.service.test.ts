import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentErrors } from '../../../lib/errors/agent-errors.js';

import { AgentExecutionService } from '../agent-execution.service.js';

// ─── Module mocks ──────────────────────────────────
// Mock the stream-handler so start() doesn't actually invoke the Claude SDK
vi.mock('../../../lib/agents/stream-handler.js', () => ({
  runAgentPlanning: vi.fn().mockResolvedValue({
    status: 'planning',
    plan: 'The plan',
    planOptions: {},
    turnCount: 3,
  }),
  runAgentExecution: vi.fn().mockResolvedValue({
    status: 'completed',
    turnCount: 5,
  }),
}));

// Mock agent error recovery
vi.mock('../../../lib/agents/recovery.js', () => ({
  handleAgentError: vi.fn().mockReturnValue({ action: 'fail' }),
}));

// Mock settings service
vi.mock('../../settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue(undefined),
}));

// Mock model resolver
vi.mock('../../../lib/utils/resolve-model.js', () => ({
  resolveModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
}));

// ─── Mocks ──────────────────────────────────────────

const createDbMock = () => {
  const mockTransaction = vi.fn().mockImplementation(async (fn: any) => {
    // Create a simplified tx object that tracks updates
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
        }),
      }),
    };
    return fn(tx);
  });

  return {
    query: {
      agents: { findFirst: vi.fn(), findMany: vi.fn() },
      codespaces: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', config: {} }) },
      tasks: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
      worktrees: { findFirst: vi.fn() },
      agentRuns: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'new-1' }]) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      })),
    })),
    transaction: mockTransaction,
  };
};

const createWorktreeServiceMock = () => ({
  create: vi.fn().mockResolvedValue({
    ok: true,
    value: { id: 'wt-1', path: '/tmp/wt', branch: 'agent/task-1' },
  }),
  remove: vi.fn().mockResolvedValue({ ok: true }),
});

const createTaskServiceMock = () => ({
  moveColumn: vi.fn().mockResolvedValue({ ok: true }),
});

const createSessionServiceMock = () => ({
  create: vi.fn().mockResolvedValue({ ok: true, value: { id: 'sess-1' } }),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
  close: vi.fn().mockResolvedValue({ ok: true }),
});

// ─── Tests ──────────────────────────────────────────

describe('AgentExecutionService', () => {
  let db: ReturnType<typeof createDbMock>;
  let worktreeService: ReturnType<typeof createWorktreeServiceMock>;
  let taskService: ReturnType<typeof createTaskServiceMock>;
  let sessionService: ReturnType<typeof createSessionServiceMock>;
  let service: AgentExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createDbMock();
    worktreeService = createWorktreeServiceMock();
    taskService = createTaskServiceMock();
    sessionService = createSessionServiceMock();
    service = new AgentExecutionService(
      db as never,
      worktreeService as never,
      taskService as never,
      sessionService as never
    );
  });

  // =========================================================================
  // start() error paths
  // =========================================================================

  describe('start() error paths', () => {
    it('returns NOT_FOUND when agent does not exist', async () => {
      db.query.agents.findFirst.mockResolvedValue(null);

      const result = await service.start('agent-missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AgentErrors.NOT_FOUND.code);
      }
    });

    it('returns ALREADY_RUNNING when agent is not idle', async () => {
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        codespaceId: 'p1',
        status: 'running',
        currentTaskId: 'task-1',
      });

      const result = await service.start('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('returns NO_AVAILABLE_TASK when no tasks are available', async () => {
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        codespaceId: 'p1',
        status: 'idle',
        currentTaskId: null,
      });
      db.query.tasks.findFirst.mockResolvedValue(null);

      const result = await service.start('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AgentErrors.NO_AVAILABLE_TASK.code);
      }
    });

    it('returns NO_AVAILABLE_TASK when task is not in backlog or queued', async () => {
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        codespaceId: 'p1',
        status: 'idle',
        currentTaskId: null,
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 'task-1',
        codespaceId: 'p1',
        column: 'in_progress',
      });

      const result = await service.start('a1', 'task-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AgentErrors.NO_AVAILABLE_TASK.code);
      }
    });
  });

  // =========================================================================
  // start() happy paths (Bug 18)
  // =========================================================================

  describe('start() happy paths', () => {
    const idleAgent = {
      id: 'a1',
      codespaceId: 'p1',
      status: 'idle',
      currentTaskId: null,
      config: { model: 'claude-sonnet-4-6', maxTurns: 50, allowedTools: [] },
    };

    const queuedTask = {
      id: 'task-1',
      codespaceId: 'p1',
      column: 'queued',
      title: 'Build feature X',
      description: 'Implement the feature',
    };

    function setupHappyPathMocks() {
      // Agent lookup returns idle agent
      db.query.agents.findFirst.mockResolvedValue(idleAgent);

      // Task lookup returns queued task
      db.query.tasks.findFirst.mockResolvedValue(queuedTask);

      // Project lookup for concurrency check
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'p1',
        config: {},
        maxConcurrentAgents: 3,
      });

      // After start, the updated records are fetched
      // db.query.agents.findFirst is used both for initial lookup and post-start lookup
      // The second call returns the updated agent
      db.query.agents.findFirst
        .mockResolvedValueOnce(idleAgent) // initial lookup
        .mockResolvedValueOnce({
          ...idleAgent,
          status: 'planning',
          currentTaskId: 'task-1',
          currentSessionId: 'sess-1',
        }); // post-start lookup

      db.query.tasks.findFirst
        .mockResolvedValueOnce(queuedTask) // initial task lookup (with taskId)
        .mockResolvedValueOnce({
          // fallback lookup (without taskId) - not needed since first returned a result
          ...queuedTask,
          column: 'in_progress',
        })
        .mockResolvedValueOnce({
          ...queuedTask,
          column: 'in_progress',
          agentId: 'a1',
          sessionId: 'sess-1',
        }); // post-start lookup

      db.query.sessions.findFirst.mockResolvedValue({
        id: 'sess-1',
        codespaceId: 'p1',
        taskId: 'task-1',
      });

      db.query.worktrees.findFirst.mockResolvedValue({
        id: 'wt-1',
        path: '/tmp/wt',
        branch: 'agent/task-1',
      });
    }

    it('creates worktree and session for a queued task', async () => {
      setupHappyPathMocks();

      const result = await service.start('a1', 'task-1');

      expect(result.ok).toBe(true);

      // Worktree was created with correct params
      expect(worktreeService.create).toHaveBeenCalledWith({
        codespaceId: 'p1',
        agentId: 'a1',
        taskId: 'task-1',
        taskTitle: 'Build feature X',
      });

      // Session was created with correct params
      expect(sessionService.create).toHaveBeenCalledWith({
        codespaceId: 'p1',
        taskId: 'task-1',
        agentId: 'a1',
        title: 'Build feature X',
      });
    });

    it('returns agent, task, session, and worktree on success', async () => {
      setupHappyPathMocks();

      const result = await service.start('a1', 'task-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty('agent');
        expect(result.value).toHaveProperty('task');
        expect(result.value).toHaveProperty('session');
        expect(result.value).toHaveProperty('worktree');
        expect(result.value.session.id).toBe('sess-1');
        expect(result.value.worktree.id).toBe('wt-1');
      }
    });

    it('publishes state:update event after starting', async () => {
      setupHappyPathMocks();

      await service.start('a1', 'task-1');

      expect(sessionService.publish).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'state:update',
          data: expect.objectContaining({
            status: 'starting',
            agentId: 'a1',
            taskId: 'task-1',
          }),
        })
      );
    });

    it('uses a transaction to atomically update task and agent', async () => {
      setupHappyPathMocks();

      await service.start('a1', 'task-1');

      // The transaction mock should have been called
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // stop() — real service behavior (Bug 19)
  // =========================================================================

  describe('stop() — agent abort and cleanup', () => {
    it('returns NOT_RUNNING when agent is not in runningAgents', async () => {
      const result = await service.stop('agent-unknown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_RUNNING');
      }
    });

    it('aborts the correct controller and removes agent from runningAgents', async () => {
      // Access the private runningAgents map and inject a controller
      const runningAgents = (service as any).runningAgents as Map<string, AbortController>;
      const controller = new AbortController();
      runningAgents.set('agent-1', controller);

      expect(service.isRunning('agent-1')).toBe(true);
      expect(controller.signal.aborted).toBe(false);

      const result = await service.stop('agent-1');

      expect(result.ok).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(service.isRunning('agent-1')).toBe(false);
    });

    it('updates agent status to idle in database after stop', async () => {
      const runningAgents = (service as any).runningAgents as Map<string, AbortController>;
      runningAgents.set('agent-1', new AbortController());

      await service.stop('agent-1');

      // db.update should have been called to set status: 'idle'
      expect(db.update).toHaveBeenCalled();
    });

    it('does not affect other running agents when stopping one', async () => {
      const runningAgents = (service as any).runningAgents as Map<string, AbortController>;
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      runningAgents.set('agent-1', controller1);
      runningAgents.set('agent-2', controller2);

      await service.stop('agent-1');

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(false);
      expect(service.isRunning('agent-1')).toBe(false);
      expect(service.isRunning('agent-2')).toBe(true);
    });
  });

  // =========================================================================
  // isRunning() — real service behavior
  // =========================================================================

  describe('isRunning()', () => {
    it('returns false when no agents are running', () => {
      expect(service.isRunning('agent-1')).toBe(false);
    });

    it('returns true after an agent is added to runningAgents', () => {
      const runningAgents = (service as any).runningAgents as Map<string, AbortController>;
      runningAgents.set('agent-1', new AbortController());

      expect(service.isRunning('agent-1')).toBe(true);
    });
  });

  // =========================================================================
  // setQueueService()
  // =========================================================================

  describe('setQueueService()', () => {
    it('accepts a queue service for auto-dequeue', () => {
      const mockQueueService = {
        enqueue: vi.fn(),
        dequeue: vi.fn(),
        dequeueNext: vi.fn(),
      };

      // Should not throw
      service.setQueueService(mockQueueService as never);
      expect((service as any).queueService).toBe(mockQueueService);
    });
  });

  // =========================================================================
  // pause()
  // =========================================================================

  describe('pause()', () => {
    it('returns NOT_FOUND when agent does not exist', async () => {
      db.query.agents.findFirst.mockResolvedValue(null);

      const result = await service.pause('agent-missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('sets agent status to paused', async () => {
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'running',
      });

      const result = await service.pause('a1');

      expect(result.ok).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Hook registration
  // =========================================================================

  describe('hook registration', () => {
    it('registers pre-tool use hooks for an agent', () => {
      const hook = vi.fn();
      service.registerPreToolUseHook('agent-1', hook as never);

      const preToolHooks = (service as any).preToolHooks as Map<string, unknown[]>;
      expect(preToolHooks.get('agent-1')).toHaveLength(1);
    });

    it('registers post-tool use hooks for an agent', () => {
      const hook = vi.fn();
      service.registerPostToolUseHook('agent-1', hook as never);

      const postToolHooks = (service as any).postToolHooks as Map<string, unknown[]>;
      expect(postToolHooks.get('agent-1')).toHaveLength(1);
    });
  });
});
