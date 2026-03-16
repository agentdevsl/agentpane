import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { createRunningAgent, createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock external dependencies
vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: vi.fn().mockResolvedValue({
    status: 'planning',
    turnCount: 5,
    plan: 'Test plan',
    planOptions: {},
  }),
}));

vi.mock('../../src/lib/agents/hooks/index.js', () => ({
  createAgentHooks: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/lib/agents/recovery.js', () => ({
  handleAgentError: vi.fn().mockReturnValue({ action: 'stop', reason: 'test' }),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue(undefined),
}));

describe('AgentExecutionService', () => {
  let service: AgentExecutionService;

  const mockWorktreeService = {
    create: vi.fn(),
  };

  const mockTaskService = {
    moveColumn: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  };

  const mockSessionService = {
    create: vi.fn(),
    publish: vi.fn().mockResolvedValue({ ok: true }),
    getById: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    service = new AgentExecutionService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ===========================================================================
  // 1. start with valid agent and task
  // ===========================================================================

  it('start with valid agent and task returns ok with agent, task, session, worktree', async () => {
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'idle' });
    const task = await createTestTask(project.id, { column: 'backlog' });
    const worktree = await createTestWorktree(project.id, { taskId: task.id });
    const session = await createTestSession(project.id, {
      taskId: task.id,
      agentId: agent.id,
    });

    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({ ok: true, value: session });

    const result = await service.start(agent.id, task.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agent).toBeDefined();
      expect(result.value.task).toBeDefined();
      expect(result.value.session).toBeDefined();
      expect(result.value.worktree).toBeDefined();
      expect(result.value.agent.id).toBe(agent.id);
      expect(result.value.task.id).toBe(task.id);
      expect(result.value.agent.status).toBe('planning');
    }
  });

  // ===========================================================================
  // 2. start with non-existent agent
  // ===========================================================================

  it('start with non-existent agent returns AGENT_NOT_FOUND', async () => {
    const result = await service.start('non-existent-id');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_FOUND');
    }
  });

  // ===========================================================================
  // 3. start with already running agent
  // ===========================================================================

  it('start with already running agent returns AGENT_ALREADY_RUNNING', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'backlog' });
    const session = await createTestSession(project.id, { taskId: task.id });
    const agent = await createRunningAgent(project.id, task.id, session.id);

    const result = await service.start(agent.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
    }
  });

  // ===========================================================================
  // 4. start with no backlog tasks
  // ===========================================================================

  it('start with no backlog tasks returns AGENT_NO_AVAILABLE_TASK', async () => {
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'idle' });

    const result = await service.start(agent.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
    }
  });

  // ===========================================================================
  // 5. stop for non-running agent
  // ===========================================================================

  it('stop for non-running agent returns AGENT_NOT_RUNNING', async () => {
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'idle' });

    const result = await service.stop(agent.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_NOT_RUNNING');
    }
  });

  // ===========================================================================
  // 6. pause updates agent status
  // ===========================================================================

  it('pause updates agent status to paused', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);
    const session = await createTestSession(project.id, { taskId: task.id });
    const agent = await createRunningAgent(project.id, task.id, session.id);

    const result = await service.pause(agent.id);

    expect(result.ok).toBe(true);

    const db = getTestDb();
    const updatedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });
    expect(updatedAgent?.status).toBe('paused');
  });

  // ===========================================================================
  // 7. resume updates status to running
  // ===========================================================================

  it('resume updates agent status to running', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);
    const session = await createTestSession(project.id, { taskId: task.id });
    const agent = await createTestAgent(project.id, {
      status: 'paused',
      currentTaskId: task.id,
      currentSessionId: session.id,
      currentTurn: 10,
    });

    const result = await service.resume(agent.id, 'Continue working');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.turnCount).toBe(10);
    }

    const db = getTestDb();
    const updatedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });
    expect(updatedAgent?.status).toBe('running');
  });

  // ===========================================================================
  // 8. checkAvailability returns true when under limit
  // ===========================================================================

  it('checkAvailability returns true when under concurrency limit', async () => {
    const project = await createTestProject({ maxConcurrentAgents: 3 });

    const result = await service.checkAvailability(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  // ===========================================================================
  // 9. isRunning returns false for unknown agent
  // ===========================================================================

  it('isRunning returns false for unknown agent', () => {
    expect(service.isRunning('non-existent-id')).toBe(false);
  });

  // ===========================================================================
  // 10. registerPreToolUseHook and registerPostToolUseHook do not throw
  // ===========================================================================

  it('registerPreToolUseHook and registerPostToolUseHook do not throw', () => {
    const preHook = vi.fn().mockResolvedValue({ deny: false });
    const postHook = vi.fn().mockResolvedValue(undefined);

    expect(() => service.registerPreToolUseHook('agent-1', preHook)).not.toThrow();
    expect(() => service.registerPostToolUseHook('agent-1', postHook)).not.toThrow();
  });
});
