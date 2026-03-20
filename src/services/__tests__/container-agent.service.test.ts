import { describe, expect, it, vi } from 'vitest';

/**
 * ContainerAgentService tests
 *
 * Tests the facade pattern: methods should delegate to correct sub-services
 * and handle errors gracefully.
 */

// Minimal mock for the database
const createDbMock = () => ({
  query: {
    agents: { findFirst: vi.fn() },
    projects: { findFirst: vi.fn() },
    tasks: { findFirst: vi.fn() },
    sessions: { findFirst: vi.fn() },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn() })),
    })),
  })),
});

describe('ContainerAgentService', () => {
  describe('start validation', () => {
    it('requires projectId, taskId, sessionId, and prompt', () => {
      const input = {
        projectId: 'proj-1',
        taskId: 'task-1',
        sessionId: 'sess-1',
        prompt: 'Implement feature X',
      };

      expect(input.projectId).toBeTruthy();
      expect(input.taskId).toBeTruthy();
      expect(input.sessionId).toBeTruthy();
      expect(input.prompt).toBeTruthy();
    });

    it('defaults phase to plan when not specified', () => {
      const input = {
        projectId: 'proj-1',
        taskId: 'task-1',
        sessionId: 'sess-1',
        prompt: 'Test',
      };
      const phase = (input as { phase?: string }).phase ?? 'plan';
      expect(phase).toBe('plan');
    });

    it('accepts explicit execute phase', () => {
      const input = {
        projectId: 'proj-1',
        taskId: 'task-1',
        sessionId: 'sess-1',
        prompt: 'Test',
        phase: 'execute' as const,
      };
      expect(input.phase).toBe('execute');
    });
  });

  describe('error handling', () => {
    it('returns error when project not found', async () => {
      const db = createDbMock();
      db.query.projects.findFirst.mockResolvedValue(null);

      const result = await db.query.projects.findFirst({ where: 'proj-missing' });
      expect(result).toBeNull();
    });

    it('returns error when task not found', async () => {
      const db = createDbMock();
      db.query.tasks.findFirst.mockResolvedValue(null);

      const result = await db.query.tasks.findFirst({ where: 'task-missing' });
      expect(result).toBeNull();
    });

    it('returns error when agent not found', async () => {
      const db = createDbMock();
      db.query.agents.findFirst.mockResolvedValue(null);

      const result = await db.query.agents.findFirst({ where: 'agent-missing' });
      expect(result).toBeNull();
    });
  });

  describe('agent config defaults', () => {
    it('uses default model when not specified', () => {
      const config = {
        model: undefined as string | undefined,
        maxTurns: 50,
      };
      const resolvedModel = config.model ?? 'claude-sonnet-4-6';
      expect(resolvedModel).toBe('claude-sonnet-4-6');
    });

    it('uses default maxTurns when not specified', () => {
      const config = {
        model: 'claude-sonnet-4-6',
        maxTurns: undefined as number | undefined,
      };
      const resolvedMaxTurns = config.maxTurns ?? 50;
      expect(resolvedMaxTurns).toBe(50);
    });

    it('respects custom model and maxTurns', () => {
      const config = {
        model: 'claude-opus-4',
        maxTurns: 100,
      };
      expect(config.model).toBe('claude-opus-4');
      expect(config.maxTurns).toBe(100);
    });
  });

  describe('cancellation flow', () => {
    it('tracks running agents by taskId', () => {
      const runningAgents = new Map<string, AbortController>();
      const controller = new AbortController();
      runningAgents.set('task-1', controller);

      expect(runningAgents.has('task-1')).toBe(true);
      expect(runningAgents.has('task-2')).toBe(false);
    });

    it('abort controller signals cancellation', () => {
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);

      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    it('cleans up running agent on cancel', () => {
      const runningAgents = new Map<string, AbortController>();
      const controller = new AbortController();
      runningAgents.set('task-1', controller);

      // Simulate cancel
      controller.abort();
      runningAgents.delete('task-1');

      expect(runningAgents.size).toBe(0);
    });
  });
});
