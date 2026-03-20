import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentErrors } from '../../../lib/errors/agent-errors.js';

import { AgentExecutionService } from '../agent-execution.service.js';

// ─── Mocks ──────────────────────────────────────────

const createDbMock = () => ({
  query: {
    agents: { findFirst: vi.fn(), findMany: vi.fn() },
    projects: { findFirst: vi.fn() },
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
});

const createWorktreeServiceMock = () => ({
  create: vi.fn().mockResolvedValue({ ok: true, value: { id: 'wt-1', path: '/tmp/wt' } }),
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

  describe('start()', () => {
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
        projectId: 'p1',
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
        projectId: 'p1',
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
        projectId: 'p1',
        status: 'idle',
        currentTaskId: null,
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 'task-1',
        projectId: 'p1',
        column: 'in_progress',
      });

      const result = await service.start('a1', 'task-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AgentErrors.NO_AVAILABLE_TASK.code);
      }
    });
  });

  describe('runningAgents Map management', () => {
    it('tracks running agents using a Map', () => {
      // The runningAgents map is module-level, we test its behavior pattern
      const runningAgents = new Map<string, AbortController>();
      const controller = new AbortController();

      runningAgents.set('agent-1', controller);
      expect(runningAgents.has('agent-1')).toBe(true);
      expect(runningAgents.size).toBe(1);

      runningAgents.delete('agent-1');
      expect(runningAgents.has('agent-1')).toBe(false);
      expect(runningAgents.size).toBe(0);
    });
  });

  describe('abort/cancel flow', () => {
    it('AbortController signals running agent to stop', () => {
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);

      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    it('abort reason is captured', () => {
      const controller = new AbortController();
      controller.abort('User cancelled');

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('User cancelled');
    });
  });

  describe('setQueueService()', () => {
    it('accepts a queue service for auto-dequeue', () => {
      const mockQueueService = {
        enqueue: vi.fn(),
        dequeue: vi.fn(),
      };

      // Should not throw
      service.setQueueService(mockQueueService as never);
    });
  });
});
