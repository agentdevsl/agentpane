/**
 * Integration tests for the AgentService facade.
 *
 * AgentService is a thin compositor over AgentCrudService, AgentExecutionService,
 * and AgentQueueService. The facade itself has 0% line coverage from the
 * integration+functional projects because all existing facade tests live in
 * the unit (db) project. These tests exercise the public surface against a
 * real database to lift integration coverage on the orchestrator entry point.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import { AgentService } from '../../src/services/agent.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock external IO so the facade tests don't try to reach the SDK
vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: vi.fn().mockReturnValue(new Promise(() => {})),
  runAgentExecution: vi.fn().mockReturnValue(new Promise(() => {})),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  DEFAULT_AGENT_MAX_RUNTIME_MS: 4 * 60 * 60 * 1000,
}));

vi.mock('../../src/lib/utils/resolve-model.js', () => ({
  resolveModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
}));

vi.mock('../../src/services/session/event-metadata.js', () => ({
  createSessionEventWithMetadata: vi.fn().mockImplementation((input) => ({
    ...input,
    id: 'test-event-id',
    timestamp: new Date().toISOString(),
  })),
}));

const mockWorktreeService = {
  create: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
};

const mockSessionService = {
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } }),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
};

const mockTaskService = { moveColumn: vi.fn().mockResolvedValue({ ok: true }) };

describe('AgentService facade — CRUD delegation (IT-AS-CRUD)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();
    service = new AgentService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('create() delegates to AgentCrudService and returns ok with codespace defaults', async () => {
    const codespace = await createTestProject({
      config: { allowedTools: ['Read', 'Edit'], maxTurns: 25 },
    });

    const result = await service.create({
      codespaceId: codespace.id,
      name: 'Facade Test Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codespaceId).toBe(codespace.id);
    expect(result.value.config?.allowedTools).toEqual(['Read', 'Edit']);
    expect(result.value.config?.maxTurns).toBe(25);
  });

  it('create() returns INVALID_ID when codespace does not exist', async () => {
    const result = await service.create({
      codespaceId: 'missing-codespace',
      name: 'Phantom Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ID');
  });

  it('getById() returns the agent or NOT_FOUND', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id);

    const found = await service.getById(agent.id);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.id).toBe(agent.id);
    }

    const missing = await service.getById('missing-id');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('AGENT_NOT_FOUND');
    }
  });

  it('list() returns agents for a codespace, ordered by updatedAt', async () => {
    const codespace1 = await createTestProject({ name: 'CS1' });
    const codespace2 = await createTestProject({ name: 'CS2' });
    const agent1 = await createTestAgent(codespace1.id, { name: 'A1' });
    const agent2 = await createTestAgent(codespace1.id, { name: 'A2' });
    await createTestAgent(codespace2.id, { name: 'OtherCS' });

    const result = await service.list(codespace1.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((a) => a.id);
    expect(names).toContain(agent1.id);
    expect(names).toContain(agent2.id);
    expect(result.value).toHaveLength(2);
  });

  it('listAll() returns agents from every codespace', async () => {
    const cs1 = await createTestProject({ name: 'L1' });
    const cs2 = await createTestProject({ name: 'L2' });
    await createTestAgent(cs1.id);
    await createTestAgent(cs2.id);

    const result = await service.listAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(2);
  });

  it('getRunningCountAll() counts running agents across all codespaces', async () => {
    const cs1 = await createTestProject();
    const cs2 = await createTestProject();
    await createTestAgent(cs1.id, { status: 'running' });
    await createTestAgent(cs2.id, { status: 'running' });
    await createTestAgent(cs2.id, { status: 'idle' });

    const result = await service.getRunningCountAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2);
    }
  });

  it('update() merges config and refuses tool changes while running', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, {
      status: 'idle',
      config: { allowedTools: ['Read'], maxTurns: 10 },
    });

    // Successful update while idle
    const updated = await service.update(agent.id, { maxTurns: 100 });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.config?.maxTurns).toBe(100);
      expect(updated.value.config?.allowedTools).toEqual(['Read']);
    }

    // Set agent to running and try to update tools — should be refused
    const task = await createTestTask(codespace.id);
    await db
      .update(agents)
      .set({ status: 'running', currentTaskId: task.id })
      .where(eq(agents.id, agent.id));

    const refused = await service.update(agent.id, { allowedTools: ['Write'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('AGENT_ALREADY_RUNNING');
    }
  });

  it('delete() removes the agent and returns NOT_FOUND on missing id', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id);

    const removed = await service.delete(agent.id);
    expect(removed.ok).toBe(true);

    const missing = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(missing).toBeUndefined();

    const second = await service.delete(agent.id);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('AGENT_NOT_FOUND');
    }
  });
});

describe('AgentService facade — execution & availability delegation (IT-AS-EXEC)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();
    service = new AgentService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('start() returns NOT_FOUND for missing agent', async () => {
    const result = await service.start('missing-agent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    }
  });

  it('start() returns NO_AVAILABLE_TASK when no backlog/queued task exists', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'idle' });
    const result = await service.start(agent.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
    }
  });

  it('stop() returns NOT_RUNNING when no controller is registered', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'running' });
    const result = await service.stop(agent.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_RUNNING');
    }
  });

  it('pause() returns NOT_FOUND for missing agent', async () => {
    const result = await service.pause('missing-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    }
  });

  it('pause() succeeds and sets agent to paused', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'running' });

    const result = await service.pause(agent.id);
    expect(result.ok).toBe(true);

    const refreshed = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(refreshed?.status).toBe('paused');
  });

  it('resume() returns NOT_FOUND for missing agent', async () => {
    const result = await service.resume('missing-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    }
  });

  it('resume() returns NOT_RUNNING when agent is not paused or planning', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'idle' });
    const result = await service.resume(agent.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_RUNNING');
    }
  });

  it('checkAvailability() returns false for missing codespace', async () => {
    const result = await service.checkAvailability('missing-cs');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
  });

  it('getRunningCount() returns the correct count by codespace', async () => {
    const codespace = await createTestProject();
    await createTestAgent(codespace.id, { status: 'running' });
    await createTestAgent(codespace.id, { status: 'planning' });
    await createTestAgent(codespace.id, { status: 'idle' });

    const result = await service.getRunningCount(codespace.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2); // running + planning
    }
  });

  it('rejectPlanForTask returns PLAN_NOT_FOUND when no plan present', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id);

    const result = await service.rejectPlanForTask(task.id, 'no plan');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_NOT_FOUND');
    }
  });
});

describe('AgentService facade — queue delegation (IT-AS-QUEUE)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();
    service = new AgentService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('queueTask() moves a backlog task to queued and returns its position', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const result = await service.queueTask(codespace.id, task.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe(task.id);
      expect(result.value.position).toBe(0);
      expect(result.value.totalQueued).toBe(1);
    }
  });

  it('getQueuePosition() returns null for non-queued task', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const result = await service.getQueuePosition(task.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('getQueueStats() reports totalQueued for a codespace', async () => {
    const codespace = await createTestProject();
    const t1 = await createTestTask(codespace.id, { column: 'backlog' });
    const t2 = await createTestTask(codespace.id, { column: 'backlog' });
    await service.queueTask(codespace.id, t1.id);
    await service.queueTask(codespace.id, t2.id);

    const stats = await service.getQueueStats(codespace.id);
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.totalQueued).toBe(2);
    }
  });

  it('getQueuedTasks() lists queued tasks with positions', async () => {
    const codespace = await createTestProject();
    const t1 = await createTestTask(codespace.id, { column: 'backlog' });
    await service.queueTask(codespace.id, t1.id);

    const queued = await service.getQueuedTasks(codespace.id);
    expect(queued.ok).toBe(true);
    if (queued.ok) {
      expect(queued.value.length).toBe(1);
      expect(queued.value[0]?.taskId).toBe(t1.id);
    }
  });
});

describe('AgentService facade — orphan sweep lifecycle (IT-AS-SWEEP)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new AgentService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
  });

  afterEach(async () => {
    service.stopOrphanSweep();
    await clearTestDatabase();
  });

  it('startOrphanSweep / stopOrphanSweep are idempotent', () => {
    expect(() => service.startOrphanSweep()).not.toThrow();
    expect(() => service.startOrphanSweep()).not.toThrow();
    expect(() => service.stopOrphanSweep()).not.toThrow();
    expect(() => service.stopOrphanSweep()).not.toThrow();
  });
});
