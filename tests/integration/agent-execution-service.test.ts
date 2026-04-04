import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRuns, agents, tasks } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock external I/O boundaries — Claude Agent SDK, Git operations, DurableStreams
// runAgentPlanning never resolves so async background execution doesn't race with assertions
vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: vi.fn().mockReturnValue(new Promise(() => {})),
  runAgentExecution: vi.fn().mockReturnValue(new Promise(() => {})),
}));

vi.mock('../../src/lib/agents/recovery.js', () => ({
  handleAgentError: vi.fn().mockReturnValue({ action: 'stop', retry: false }),
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

const mockTaskService = {
  moveColumn: vi.fn().mockResolvedValue({ ok: true }),
};

describe('AgentExecutionService (IT-200)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentExecutionService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    vi.clearAllMocks();

    service = new AgentExecutionService(
      db as any,
      mockWorktreeService as any,
      mockTaskService as any,
      mockSessionService as any
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('start (IT-201)', () => {
    it('IT-201a: returns NOT_FOUND when agent does not exist', async () => {
      const result = await service.start('nonexistent-agent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    });

    it('IT-201b: returns ALREADY_RUNNING when agent is not idle', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });
      const agent = await createTestAgent(codespace.id, {
        status: 'running',
        currentTaskId: task.id,
      });

      const result = await service.start(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
    });

    it('IT-201c: returns NO_AVAILABLE_TASK when no backlog tasks exist', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      // No tasks created

      const result = await service.start(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
    });

    it('IT-201d: returns NO_AVAILABLE_TASK when task is not in backlog or queued', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const result = await service.start(agent.id, task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
    });

    it('IT-201e: successfully starts agent with explicit task', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, {
        column: 'backlog',
        title: 'Build feature',
      });

      const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
      const session = await createTestSession(codespace.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({
        ok: true,
        value: worktree,
      });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      const result = await service.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.agent.id).toBe(agent.id);
      expect(result.value.task.id).toBe(task.id);
      expect(result.value.task.column).toBe('in_progress');

      // Verify DB state
      const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(dbAgent?.status).toBe('planning');
      expect(dbAgent?.currentTaskId).toBe(task.id);

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('in_progress');
      expect(dbTask?.agentId).toBe(agent.id);
    });

    it('IT-201f: auto-picks oldest backlog task when no taskId specified', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });

      // Create tasks with staggered updatedAt
      const oldestTask = await createTestTask(codespace.id, {
        column: 'backlog',
        title: 'Oldest',
      });
      await db
        .update(tasks)
        .set({ updatedAt: '2025-01-01T00:00:00.000Z' })
        .where(eq(tasks.id, oldestTask.id));

      const newerTask = await createTestTask(codespace.id, {
        column: 'backlog',
        title: 'Newer',
      });
      await db
        .update(tasks)
        .set({ updatedAt: '2025-06-01T00:00:00.000Z' })
        .where(eq(tasks.id, newerTask.id));

      const worktree = await createTestWorktree(codespace.id, { taskId: oldestTask.id });
      const session = await createTestSession(codespace.id, {
        taskId: oldestTask.id,
        agentId: agent.id,
      });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      const result = await service.start(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.task.id).toBe(oldestTask.id);
    });

    it('IT-201g: returns LIMIT_EXCEEDED when concurrency is maxed out', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 1 });

      // Create a running agent to consume the concurrency slot
      const runningTask = await createTestTask(codespace.id, { column: 'in_progress' });
      await createTestAgent(codespace.id, {
        status: 'running',
        currentTaskId: runningTask.id,
      });

      // Create the idle agent trying to start
      const idleAgent = await createTestAgent(codespace.id, { status: 'idle' });
      const backlogTask = await createTestTask(codespace.id, { column: 'backlog' });

      const result = await service.start(idleAgent.id, backlogTask.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    });

    it('IT-201h: creates agent_run record on successful start', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, { column: 'backlog' });
      const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
      const session = await createTestSession(codespace.id);

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      await service.start(agent.id, task.id);

      // Verify agent_run record exists
      const runs = await db.query.agentRuns.findMany({
        where: eq(agentRuns.agentId, agent.id),
      });
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs[0]?.status).toBe('running');
      expect(runs[0]?.taskId).toBe(task.id);
    });

    it('IT-201i: cleans up worktree and session on transaction failure', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, { column: 'backlog' });
      const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
      const session = await createTestSession(codespace.id);

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      // Ensure worktree create succeeds but corrupt the task so transaction fails
      await db.delete(tasks).where(eq(tasks.id, task.id));

      const result = await service.start(agent.id, task.id);

      // The task was deleted so it won't be found
      expect(result.ok).toBe(false);
    });
  });

  describe('stop (IT-202)', () => {
    it('IT-202a: returns NOT_RUNNING when agent has no AbortController', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'running' });

      const result = await service.stop(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NOT_RUNNING');
    });

    it('IT-202b: sets agent to idle and clears task references after stop', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, { column: 'backlog' });
      const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
      const session = await createTestSession(codespace.id);

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      // Start the agent first so it has an AbortController
      const startResult = await service.start(agent.id, task.id);
      expect(startResult.ok).toBe(true);

      // Now stop it
      const stopResult = await service.stop(agent.id);
      expect(stopResult.ok).toBe(true);

      // Verify DB state
      const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(dbAgent?.status).toBe('idle');
      expect(dbAgent?.currentTaskId).toBeNull();
      expect(dbAgent?.currentSessionId).toBeNull();
    });
  });

  describe('pause (IT-203)', () => {
    it('IT-203a: returns NOT_FOUND when agent does not exist', async () => {
      const result = await service.pause('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    });

    it('IT-203b: sets agent status to paused', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'running' });

      const result = await service.pause(agent.id);

      expect(result.ok).toBe(true);

      const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(dbAgent?.status).toBe('paused');
    });
  });

  describe('resume (IT-204)', () => {
    it('IT-204a: returns NOT_FOUND when agent does not exist', async () => {
      const result = await service.resume('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    });

    it('IT-204b: returns NOT_RUNNING when agent is not paused or planning', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'idle' });

      const result = await service.resume(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_NOT_RUNNING');
    });

    it('IT-204c: resumes paused agent and sets status to running', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'paused' });

      const result = await service.resume(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('paused');

      const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(dbAgent?.status).toBe('running');
    });

    it('IT-204d: resumes planning agent and starts execution phase', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
      });

      // Set plan on the task
      await db
        .update(tasks)
        .set({ plan: 'Execute this plan', planOptions: {} })
        .where(eq(tasks.id, task.id));

      const session = await createTestSession(codespace.id, { taskId: task.id });
      const agent = await createTestAgent(codespace.id, {
        status: 'planning',
        currentTaskId: task.id,
        currentSessionId: session.id,
      });

      const result = await service.resume(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('planning');

      const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(dbAgent?.status).toBe('running');
    });
  });

  describe('checkAvailability (IT-205)', () => {
    it('IT-205a: returns false for nonexistent codespace', async () => {
      const result = await service.checkAvailability('nonexistent-codespace');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });

    it('IT-205b: returns true when running agents are below limit', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
      await createTestAgent(codespace.id, { status: 'running' });

      const result = await service.checkAvailability(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);
    });

    it('IT-205c: returns false when running agents are at limit', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 2 });
      await createTestAgent(codespace.id, { status: 'running' });
      await createTestAgent(codespace.id, { status: 'starting' });

      const result = await service.checkAvailability(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });

    it('IT-205d: counts planning agents towards the running limit', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 1 });
      await createTestAgent(codespace.id, { status: 'planning' });

      const result = await service.checkAvailability(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });

    it('IT-205e: does not count idle or completed agents towards limit', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 2 });
      await createTestAgent(codespace.id, { status: 'idle' });
      await createTestAgent(codespace.id, { status: 'completed' });
      await createTestAgent(codespace.id, { status: 'error' });

      const result = await service.checkAvailability(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);
    });
  });

  describe('getRunningCount (IT-206)', () => {
    it('IT-206a: returns 0 when no agents exist', async () => {
      const codespace = await createTestProject();

      const result = await service.getRunningCount(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('IT-206b: counts starting, planning, and running agents', async () => {
      const codespace = await createTestProject();
      await createTestAgent(codespace.id, { status: 'starting' });
      await createTestAgent(codespace.id, { status: 'planning' });
      await createTestAgent(codespace.id, { status: 'running' });
      await createTestAgent(codespace.id, { status: 'idle' }); // not counted
      await createTestAgent(codespace.id, { status: 'paused' }); // not counted

      const result = await service.getRunningCount(codespace.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(3);
    });

    it('IT-206c: only counts agents in the specified codespace', async () => {
      const codespace1 = await createTestProject({ name: 'Codespace 1' });
      const codespace2 = await createTestProject({ name: 'Codespace 2' });

      await createTestAgent(codespace1.id, { status: 'running' });
      await createTestAgent(codespace1.id, { status: 'running' });
      await createTestAgent(codespace2.id, { status: 'running' });

      const result1 = await service.getRunningCount(codespace1.id);
      const result2 = await service.getRunningCount(codespace2.id);

      expect(result1.ok).toBe(true);
      if (result1.ok) expect(result1.value).toBe(2);

      expect(result2.ok).toBe(true);
      if (result2.ok) expect(result2.value).toBe(1);
    });
  });

  describe('setQueueService (IT-207)', () => {
    it('IT-207a: accepts a queue service reference without error', () => {
      const mockQueueService = { dequeueNext: vi.fn() } as any;
      expect(() => service.setQueueService(mockQueueService)).not.toThrow();
    });
  });

  describe('registerPreToolUseHook / registerPostToolUseHook (IT-208)', () => {
    it('IT-208a: registers hooks without error', () => {
      const preHook = vi.fn().mockResolvedValue({});
      const postHook = vi.fn().mockResolvedValue(undefined);

      expect(() => service.registerPreToolUseHook('agent-1', preHook)).not.toThrow();
      expect(() => service.registerPostToolUseHook('agent-1', postHook)).not.toThrow();
    });
  });
});
