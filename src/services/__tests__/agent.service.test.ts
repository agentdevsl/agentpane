import { describe, expect, it, vi } from 'vitest';
import { AgentErrors } from '../../lib/errors/agent-errors.js';
import { ConcurrencyErrors } from '../../lib/errors/concurrency-errors.js';
import { ValidationErrors } from '../../lib/errors/validation-errors.js';
import { AgentService } from '../agent.service.js';

const createDbMock = () => ({
  query: {
    projects: { findFirst: vi.fn() },
    agents: { findFirst: vi.fn(), findMany: vi.fn() },
    tasks: { findFirst: vi.fn() },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    })),
  })),
});

const createWorktreeServiceMock = () => ({
  create: vi.fn(),
});

const createTaskServiceMock = () => ({
  moveColumn: vi.fn(),
});

const createSessionServiceMock = () => ({
  create: vi.fn(),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
});

describe('AgentService', () => {
  it('creates agent with defaults', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      config: { allowedTools: ['Read'], maxTurns: 10 },
    });

    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: 'a1', projectId: 'p1', config: { allowedTools: ['Read'], maxTurns: 10 } },
      ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.create({
      projectId: 'p1',
      name: 'Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(true);
  });

  it('returns validation error when project missing', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.create({
      projectId: 'missing',
      name: 'Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = ValidationErrors.INVALID_ID('projectId');
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('returns error when agent missing', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.getById('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('fails start when concurrency exceeded', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({ id: 'a1', status: 'idle', projectId: 'p1' });
    db.query.tasks.findFirst.mockResolvedValue({ id: 't1', column: 'backlog' });
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1', maxConcurrentAgents: 1 });
    // checkAvailability and getRunningCount now use db.select({ count }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.start('a1', 't1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = ConcurrencyErrors.LIMIT_EXCEEDED(1, 1);
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('returns not running on stop when missing controller', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({ id: 'a1', status: 'idle' });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.stop('a1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_RUNNING);
    }
  });

  it('getById returns agent when found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      projectId: 'p1',
      name: 'Test Agent',
      status: 'idle',
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.getById('a1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('a1');
      expect(result.value.name).toBe('Test Agent');
    }
  });

  it('list returns agents for project', async () => {
    const db = createDbMock();
    db.query.agents.findMany.mockResolvedValue([
      { id: 'a1', projectId: 'p1', name: 'Agent 1' },
      { id: 'a2', projectId: 'p1', name: 'Agent 2' },
    ]);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.list('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('update returns error when agent not found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.update('missing', { maxTurns: 100 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('update prevents modifying running agent config', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'running',
      currentTaskId: 't1',
      config: { allowedTools: ['Read'], maxTurns: 50 },
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.update('a1', { allowedTools: ['Write'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = AgentErrors.ALREADY_RUNNING('t1');
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('update successfully updates agent config', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      config: { allowedTools: ['Read'], maxTurns: 50 },
    });

    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: 'a1',
        status: 'idle',
        config: { allowedTools: ['Read'], maxTurns: 100 },
      },
    ]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.update('a1', { maxTurns: 100 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config?.maxTurns).toBe(100);
    }
  });

  it('update returns error when db update fails', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      config: { allowedTools: ['Read'], maxTurns: 50 },
    });

    const updateReturning = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.update('a1', { maxTurns: 100 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('delete removes agent successfully', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({ id: 'a1', status: 'idle' });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.delete('a1');

    expect(result.ok).toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });

  it('delete returns error when agent not found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.delete('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('start returns error when agent not found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.start('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('start returns error when agent is already running', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'running',
      currentTaskId: 't1',
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.start('a1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = AgentErrors.ALREADY_RUNNING('t1');
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('start returns error when no task available', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      projectId: 'p1',
    });
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.start('a1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NO_AVAILABLE_TASK);
    }
  });

  it('start returns error when task not in backlog', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      projectId: 'p1',
    });
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'in_progress',
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.start('a1', 't1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NO_AVAILABLE_TASK);
    }
  });

  it('pause updates agent status to paused', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'running',
    });

    const updateWhere = vi.fn();
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.pause('a1');

    expect(result.ok).toBe(true);
  });

  it('pause returns error when agent not found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.pause('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('resume updates agent status to running', async () => {
    const db = createDbMock();
    const sessionService = createSessionServiceMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'paused',
      currentTurn: 5,
      currentSessionId: 's1',
    });

    const updateWhere = vi.fn();
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    sessionService.publish.mockResolvedValue({ ok: true });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      sessionService as never
    );
    const result = await service.resume('a1', 'feedback text');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('paused');
      expect(result.value.turnCount).toBe(5);
    }
    expect(sessionService.publish).toHaveBeenCalled();
  });

  it('resume returns error when agent not found', async () => {
    const db = createDbMock();
    db.query.agents.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.resume('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
    }
  });

  it('resume does not publish when no session', async () => {
    const db = createDbMock();
    const sessionService = createSessionServiceMock();
    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'paused',
      currentTurn: 5,
      currentSessionId: null,
    });

    const updateWhere = vi.fn();
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      sessionService as never
    );
    const result = await service.resume('a1');

    expect(result.ok).toBe(true);
    expect(sessionService.publish).not.toHaveBeenCalled();
  });

  it('checkAvailability returns false when project not found', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue(null);

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.checkAvailability('missing');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  it('checkAvailability returns true when under limit', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      maxConcurrentAgents: 3,
    });
    // checkAvailability now uses db.select({ count }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.checkAvailability('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  it('checkAvailability returns false when at limit', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      maxConcurrentAgents: 2,
    });
    // checkAvailability now uses db.select({ count }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 2 }]),
      })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.checkAvailability('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  it('getRunningCount returns count of running agents', async () => {
    const db = createDbMock();
    // getRunningCount now uses db.select({ count: count() }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 2 }]),
      })),
    });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.getRunningCount('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2);
    }
  });

  it('queueTask queues task and returns position', async () => {
    const db = createDbMock();
    // Add missing mock methods needed by AgentQueueService
    (db.query.tasks as Record<string, unknown>).findMany = vi.fn().mockResolvedValue([
      {
        id: 't1',
        projectId: 'p1',
        column: 'queued',
        updatedAt: new Date().toISOString(),
      },
    ]);
    (db.query as Record<string, unknown>).agentRuns = {
      findMany: vi.fn().mockResolvedValue([]),
    };
    const updateWhere = vi.fn();
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });
    // First call: validation check (task in backlog, valid transition to queued)
    // Second call: re-fetch after update (now in queued column)
    db.query.tasks.findFirst
      .mockResolvedValueOnce({
        id: 't1',
        projectId: 'p1',
        column: 'backlog',
        updatedAt: new Date().toISOString(),
      })
      .mockResolvedValue({
        id: 't1',
        projectId: 'p1',
        column: 'queued',
        updatedAt: new Date().toISOString(),
      });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.queueTask('p1', 't1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe('t1');
      expect(result.value.position).toBe(0);
      expect(result.value.totalQueued).toBe(1);
    }
  });

  it('getQueuedTasks returns empty when no tasks queued', async () => {
    const db = createDbMock();
    // Add missing mock methods needed by AgentQueueService
    (db.query.tasks as Record<string, unknown>).findMany = vi.fn().mockResolvedValue([]);
    (db.query as Record<string, unknown>).agentRuns = {
      findMany: vi.fn().mockResolvedValue([]),
    };

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.getQueuedTasks();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  // registerPreToolUseHook and registerPostToolUseHook tests removed (AE-007)
  // Hook infrastructure was dead code - SDK's canUseTool is the actual mechanism

  it('start returns error when worktree creation fails', async () => {
    const db = createDbMock();
    const worktreeService = createWorktreeServiceMock();
    const taskService = createTaskServiceMock();
    const sessionService = createSessionServiceMock();

    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      projectId: 'p1',
    });
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'backlog',
      projectId: 'p1',
    });
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      maxConcurrentAgents: 3,
    });
    // checkAvailability uses db.select({ count }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      })),
    });

    taskService.moveColumn.mockResolvedValue({ ok: true });
    worktreeService.create.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_CREATION_FAILED', message: 'Failed' },
    });

    const service = new AgentService(
      db as never,
      worktreeService as never,
      taskService as never,
      sessionService as never
    );
    const result = await service.start('a1', 't1');

    expect(result.ok).toBe(false);
  });

  it('start returns error when session creation fails', async () => {
    const db = createDbMock();
    const worktreeService = createWorktreeServiceMock();
    const taskService = createTaskServiceMock();
    const sessionService = createSessionServiceMock();

    db.query.agents.findFirst.mockResolvedValue({
      id: 'a1',
      status: 'idle',
      projectId: 'p1',
    });
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'backlog',
      projectId: 'p1',
    });
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      maxConcurrentAgents: 3,
    });
    // checkAvailability uses db.select({ count }).from().where()
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      })),
    });

    taskService.moveColumn.mockResolvedValue({ ok: true });
    worktreeService.create.mockResolvedValue({
      ok: true,
      value: { id: 'w1', path: '/tmp/worktree' },
    });
    sessionService.create.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'Failed' },
    });

    const service = new AgentService(
      db as never,
      worktreeService as never,
      taskService as never,
      sessionService as never
    );
    const result = await service.start('a1', 't1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_EXECUTION_ERROR');
    }
  });

  describe('resume', () => {
    it('returns ok when resuming a planning agent with currentTaskId and currentSessionId', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'planning',
        projectId: 'p1',
        currentTaskId: 't1',
        currentSessionId: 's1',
        currentTurn: 3,
        config: { allowedTools: ['Read'], maxTurns: 50 },
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 't1',
        title: 'Test Task',
        description: 'Test description',
        plan: 'Step 1: do X\nStep 2: do Y',
        planOptions: null,
        worktreeId: 'w1',
        projectId: 'p1',
      });

      const updateWhere = vi.fn();
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('planning');
        expect(result.value.turnCount).toBe(3);
      }
    });

    it('sets agent status to running in DB when resuming a planning agent', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'planning',
        projectId: 'p1',
        currentTaskId: 't1',
        currentSessionId: 's1',
        currentTurn: 3,
        config: { allowedTools: ['Read'], maxTurns: 50 },
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 't1',
        title: 'Test Task',
        description: 'Test description',
        plan: 'Execute the plan',
        planOptions: null,
        worktreeId: 'w1',
        projectId: 'p1',
      });

      const setMock = vi.fn();
      const whereMock = vi.fn();
      setMock.mockReturnValue({ where: whereMock });
      db.update.mockReturnValue({ set: setMock });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      await service.resume('a1');

      // The first db.update call should set status to 'running'
      expect(db.update).toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
    });

    it('returns error when task not found for plan execution', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'planning',
        projectId: 'p1',
        currentTaskId: 't1',
        currentSessionId: 's1',
        currentTurn: 3,
        config: { allowedTools: ['Read'], maxTurns: 50 },
      });
      // Task not found
      db.query.tasks.findFirst.mockResolvedValue(null);

      const updateWhere = vi.fn();
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_EXECUTION_ERROR');
      }
    });

    it('resumes a paused agent with feedback and publishes event', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'paused',
        currentTurn: 10,
        currentSessionId: 's1',
      });

      const updateWhere = vi.fn();
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      sessionService.publish.mockResolvedValue({ ok: true });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1', 'please continue with step 2');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('paused');
        expect(result.value.turnCount).toBe(10);
      }
      // Should publish feedback event for paused agent resume
      expect(sessionService.publish).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          type: 'agent:resumed',
          data: expect.objectContaining({ feedback: 'please continue with step 2' }),
        })
      );
    });

    it('returns NOT_RUNNING error when agent is idle', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'idle',
        currentTurn: 0,
        currentSessionId: null,
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(AgentErrors.NOT_RUNNING);
      }
      expect(sessionService.publish).not.toHaveBeenCalled();
    });

    it('returns NOT_RUNNING error when agent is in error state', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'error',
        currentTurn: 3,
        currentSessionId: 's1',
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(AgentErrors.NOT_RUNNING);
      }
    });

    it('returns NOT_RUNNING error when agent is in starting state', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'starting',
        currentTurn: 0,
        currentSessionId: 's1',
        currentTaskId: 't1',
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(AgentErrors.NOT_RUNNING);
      }
    });

    it('returns NOT_FOUND when agent does not exist', async () => {
      const db = createDbMock();
      db.query.agents.findFirst.mockResolvedValue(null);

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        createSessionServiceMock() as never
      );
      const result = await service.resume('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(AgentErrors.NOT_FOUND);
      }
    });

    it('builds execution prompt from task plan when plan exists', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'planning',
        projectId: 'p1',
        currentTaskId: 't1',
        currentSessionId: 's1',
        currentTurn: 5,
        config: { allowedTools: ['Read', 'Write'], maxTurns: 50 },
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 't1',
        title: 'Implement feature X',
        description: 'Add the new feature',
        plan: '1. Create file A\n2. Update file B',
        planOptions: { allowedPrompts: [] },
        worktreeId: 'w1',
        projectId: 'p1',
      });

      const updateWhere = vi.fn();
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      const result = await service.resume('a1');

      // Should return ok with planning status and turn count
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('planning');
        expect(result.value.turnCount).toBe(5);
        // runId should be a string (generated cuid)
        expect(typeof result.value.runId).toBe('string');
      }
    });

    it('does not publish session event for planning agent resume', async () => {
      const db = createDbMock();
      const sessionService = createSessionServiceMock();
      db.query.agents.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'planning',
        projectId: 'p1',
        currentTaskId: 't1',
        currentSessionId: 's1',
        currentTurn: 3,
        config: { allowedTools: ['Read'], maxTurns: 50 },
      });
      db.query.tasks.findFirst.mockResolvedValue({
        id: 't1',
        title: 'Test Task',
        description: 'Test description',
        plan: 'The plan',
        planOptions: null,
        worktreeId: 'w1',
        projectId: 'p1',
      });

      const updateWhere = vi.fn();
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      const service = new AgentService(
        db as never,
        createWorktreeServiceMock() as never,
        createTaskServiceMock() as never,
        sessionService as never
      );
      await service.resume('a1');

      // Planning resume fires executeAgentExecution async, but does NOT
      // publish an agent:resumed event like the paused case
      expect(sessionService.publish).not.toHaveBeenCalled();
    });
  });

  it('create uses project config defaults when agent config not provided', async () => {
    const db = createDbMock();
    db.query.projects.findFirst.mockResolvedValue({
      id: 'p1',
      config: {
        allowedTools: ['Read', 'Write'],
        maxTurns: 100,
        model: 'claude-3-opus',
        systemPrompt: 'You are a helpful assistant',
        temperature: 0.7,
      },
    });

    const returning = vi.fn().mockResolvedValue([
      {
        id: 'a1',
        projectId: 'p1',
        config: {
          allowedTools: ['Read', 'Write'],
          maxTurns: 100,
          model: 'claude-3-opus',
          systemPrompt: 'You are a helpful assistant',
          temperature: 0.7,
        },
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new AgentService(
      db as never,
      createWorktreeServiceMock() as never,
      createTaskServiceMock() as never,
      createSessionServiceMock() as never
    );
    const result = await service.create({
      projectId: 'p1',
      name: 'Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(true);
  });
});
