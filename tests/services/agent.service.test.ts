import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import { AgentErrors } from '../../src/lib/errors/agent-errors';
import { AgentService } from '../../src/services/agent.service';
import { createRunningAgent, createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock external dependencies
vi.mock('../../src/lib/agents/stream-handler', () => ({
  runAgentPlanning: vi.fn(),
}));

vi.mock('../../src/lib/agents/hooks/index', () => ({
  createAgentHooks: vi.fn().mockReturnValue({
    PreToolUse: [],
    PostToolUse: [],
  }),
}));

import { runAgentPlanning } from '../../src/lib/agents/stream-handler';

const mockRunAgentPlanning = vi.mocked(runAgentPlanning);

describe('AgentService', () => {
  let agentService: AgentService;

  const mockWorktreeService = {
    create: vi.fn(),
  };

  const mockTaskService = {
    moveColumn: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  };

  const mockSessionService = {
    create: vi.fn(),
    publish: vi.fn().mockResolvedValue({ ok: true }),
  };

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    agentService = new AgentService(
      db as never,
      mockWorktreeService,
      mockTaskService,
      mockSessionService
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =============================================================================
  // Agent CRUD Operations (5 tests)
  // =============================================================================

  describe('Agent CRUD Operations', () => {
    it('creates an agent with default config', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: [],
          maxTurns: 50,
        },
      });

      const result = await agentService.create({
        projectId: project.id,
        name: 'Test Agent',
        type: 'task',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Test Agent');
        expect(result.value.type).toBe('task');
        expect(result.value.status).toBe('idle');
        expect(result.value.config?.maxTurns).toBe(50);
        expect(result.value.config?.allowedTools).toEqual([]);
      }
    });

    it('creates an agent with custom config', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write'],
          maxTurns: 100,
        },
      });

      const result = await agentService.create({
        projectId: project.id,
        name: 'Custom Agent',
        type: 'task',
        config: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          maxTurns: 75,
          model: 'claude-sonnet-4-6',
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
        expect(result.value.config?.maxTurns).toBe(75);
        expect(result.value.config?.model).toBe('claude-sonnet-4-6');
      }
    });

    it('returns error when creating agent for non-existent project', async () => {
      const result = await agentService.create({
        projectId: 'non-existent-id',
        name: 'Test Agent',
        type: 'task',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_ID');
      }
    });

    it('retrieves an agent by ID', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { name: 'Find Me' });

      const result = await agentService.getById(agent.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(agent.id);
        expect(result.value.name).toBe('Find Me');
      }
    });

    it('returns error for non-existent agent', async () => {
      const result = await agentService.getById('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Agent List Operations (3 tests)
  // =============================================================================

  describe('Agent List Operations', () => {
    it('lists agents for a project', async () => {
      const project = await createTestProject();
      await createTestAgent(project.id, { name: 'Agent 1' });
      await createTestAgent(project.id, { name: 'Agent 2' });

      const result = await agentService.list(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('lists all agents across projects', async () => {
      const project1 = await createTestProject();
      const project2 = await createTestProject();
      await createTestAgent(project1.id);
      await createTestAgent(project2.id);

      const result = await agentService.listAll();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('gets running count for all agents', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      await createRunningAgent(project.id, task.id, session.id);
      await createTestAgent(project.id, { status: 'idle' });

      const result = await agentService.getRunningCountAll();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });
  });

  // =============================================================================
  // Agent Update Operations (4 tests)
  // =============================================================================

  describe('Agent Update Operations', () => {
    it('updates agent config', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, {
        config: { allowedTools: ['Read'], maxTurns: 50 },
      });

      const result = await agentService.update(agent.id, {
        maxTurns: 100,
        systemPrompt: 'New prompt',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.maxTurns).toBe(100);
        expect(result.value.config?.systemPrompt).toBe('New prompt');
      }
    });

    it('prevents updating critical config of running agent', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.update(agent.id, {
        allowedTools: ['Read', 'Write'],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('returns error when updating non-existent agent', async () => {
      const result = await agentService.update('non-existent-id', {
        maxTurns: 100,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('deletes an agent', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      const result = await agentService.delete(agent.id);

      expect(result.ok).toBe(true);

      const getResult = await agentService.getById(agent.id);
      expect(getResult.ok).toBe(false);
    });
  });

  // =============================================================================
  // Agent Start Operations (6 tests)
  // =============================================================================

  describe('Agent Start Operations', () => {
    it('starts an agent with a specific task', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        turnCount: 5,
      });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Agent enters planning phase first (planning-first flow)
        expect(result.value.agent.status).toBe('planning');
        expect(result.value.task.id).toBe(task.id);
        expect(mockWorktreeService.create).toHaveBeenCalled();
        expect(mockSessionService.create).toHaveBeenCalled();
      }
    });

    it('starts an agent and picks next available task', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog', title: 'Available Task' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        turnCount: 5,
      });

      const result = await agentService.start(agent.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.title).toBe('Available Task');
      }
    });

    it('returns error when agent is already running', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'backlog' });
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.start(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('returns error when no tasks available', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      const result = await agentService.start(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
      }
    });

    it('returns error when task is not in backlog', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      await createTestTask(project.id, { column: 'in_progress' });

      const result = await agentService.start(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NO_AVAILABLE_TASK');
      }
    });

    it('returns error when concurrency limit exceeded', async () => {
      const project = await createTestProject({ maxConcurrentAgents: 1 });
      const task1 = await createTestTask(project.id, { column: 'in_progress' });
      const session1 = await createTestSession(project.id, { taskId: task1.id });
      await createRunningAgent(project.id, task1.id, session1.id);

      const agent2 = await createTestAgent(project.id);
      await createTestTask(project.id, { column: 'backlog' });

      const result = await agentService.start(agent2.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
      }
    });
  });

  // =============================================================================
  // Agent Stop Operations (2 tests)
  // =============================================================================

  describe('Agent Stop Operations', () => {
    it('returns error when stopping non-running agent', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { status: 'idle' });

      const result = await agentService.stop(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_RUNNING');
      }
    });

    it('returns not running error for unknown agent', async () => {
      // Agent is not in the running agents map
      const result = await agentService.stop('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_RUNNING');
      }
    });
  });

  // =============================================================================
  // Agent Pause/Resume Operations (4 tests)
  // =============================================================================

  describe('Agent Pause/Resume Operations', () => {
    it('pauses a running agent', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.pause(agent.id);

      expect(result.ok).toBe(true);

      const db = getTestDb();
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('paused');
    });

    it('returns error when pausing non-existent agent', async () => {
      const result = await agentService.pause('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('resumes a paused agent', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createTestAgent(project.id, {
        status: 'paused',
        currentTaskId: task.id,
        currentSessionId: session.id,
        currentTurn: 10,
      });

      const result = await agentService.resume(agent.id, 'Continue please');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turnCount).toBe(10);
      }

      const db = getTestDb();
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('running');
      expect(mockSessionService.publish).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          type: 'agent:resumed',
          data: { feedback: 'Continue please' },
        })
      );
    });

    it('returns error when resuming non-existent agent', async () => {
      const result = await agentService.resume('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Availability and Queue Operations (5 tests)
  // =============================================================================

  describe('Availability and Queue Operations', () => {
    it('checks availability when under limit', async () => {
      const project = await createTestProject({ maxConcurrentAgents: 3 });
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.checkAvailability(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('checks availability when at limit', async () => {
      const project = await createTestProject({ maxConcurrentAgents: 1 });
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.checkAvailability(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it('returns false availability for non-existent project', async () => {
      const result = await agentService.checkAvailability('non-existent-id');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it('gets running count for a project', async () => {
      const project = await createTestProject();
      const task1 = await createTestTask(project.id);
      const task2 = await createTestTask(project.id);
      const session1 = await createTestSession(project.id, { taskId: task1.id });
      const session2 = await createTestSession(project.id, { taskId: task2.id });
      await createRunningAgent(project.id, task1.id, session1.id);
      await createRunningAgent(project.id, task2.id, session2.id);
      await createTestAgent(project.id, { status: 'idle' });

      const result = await agentService.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });

    it('queues a task successfully', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);

      const result = await agentService.queueTask(project.id, task.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe(task.id);
      }
    });
  });

  // =============================================================================
  // Queue Stats Operations (3 tests)
  // =============================================================================

  describe('Queue Stats Operations', () => {
    it('returns null for queue position when not queued', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      const result = await agentService.getQueuePosition(agent.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns empty queue stats', async () => {
      const project = await createTestProject();

      const result = await agentService.getQueueStats(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalQueued).toBe(0);
        expect(result.value.averageCompletionMs).toBe(0);
        expect(result.value.recentCompletions).toBe(0);
      }
    });

    it('returns empty queued tasks list', async () => {
      const project = await createTestProject();

      const result = await agentService.getQueuedTasks(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  // =============================================================================
  // Hook Registration - REMOVED (AE-007: dead hook infrastructure removed)
  // SDK's canUseTool callback is the actual interception mechanism
  // =============================================================================

  // =============================================================================
  // Session Creation Failure (1 test)
  // =============================================================================

  describe('Session Creation Failure', () => {
    it('returns error when session creation fails', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: false, error: { code: 'SESSION_ERROR' } });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_EXECUTION_ERROR');
      }
    });
  });

  // =============================================================================
  // Worktree Creation Failure (1 test)
  // =============================================================================

  describe('Worktree Creation Failure', () => {
    it('returns error when worktree creation fails', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      await createTestTask(project.id, { column: 'backlog' });

      mockWorktreeService.create.mockResolvedValue({
        ok: false,
        error: AgentErrors.EXECUTION_ERROR('Worktree creation failed'),
      });

      const result = await agentService.start(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_EXECUTION_ERROR');
      }
    });
  });

  // =============================================================================
  // Delete Non-Existent Agent (1 test)
  // =============================================================================

  describe('Delete Non-Existent Agent', () => {
    it('returns error when deleting non-existent agent', async () => {
      const result = await agentService.delete('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Agent Execution Result Scenarios (5 tests)
  // =============================================================================

  describe('Agent Execution Result Scenarios', () => {
    it('handles completed status from agent execution', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        turnCount: 15,
        result: 'Task completed successfully',
      });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      // Wait for async execution to complete
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        // Agent should return to idle after completion
        expect(updatedAgent?.currentTurn).toBe(15);
      });
    });

    it('handles turn_limit status from agent execution', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'turn_limit',
        turnCount: 50,
        result: 'Turn limit reached',
      });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      // Wait for async execution to complete
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.currentTurn).toBe(50);
      });
    });

    it('handles paused status from agent execution', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'paused',
        turnCount: 25,
      });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      // Wait for async execution to complete
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.currentTurn).toBe(25);
      });
    });

    it('handles error status from agent execution', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'error',
        turnCount: 5,
        error: 'Something went wrong',
      });

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      // Wait for async execution to complete
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });
    });

    it('handles exception thrown during agent execution', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockRejectedValue(new Error('Execution failed'));

      const result = await agentService.start(agent.id, task.id);

      expect(result.ok).toBe(true);
      // Wait for async execution error handling to complete
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });
    });
  });

  // =============================================================================
  // Agent Execution Error Recovery (3 tests)
  // =============================================================================

  describe('Agent Execution Error Recovery', () => {
    it('pauses agent on rate limit error', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockRejectedValue(new Error('Rate limit exceeded'));

      await agentService.start(agent.id, task.id);

      // Wait for async execution error handling
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('paused');
      });
    });

    it('sets error status on unknown error', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockRejectedValue(new Error('Unknown error'));

      await agentService.start(agent.id, task.id);

      // Wait for async execution error handling
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });
    });

    it('publishes error event on execution failure', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockRejectedValue(new Error('Test error'));

      await agentService.start(agent.id, task.id);

      // Wait for async execution error handling
      await vi.waitFor(() => {
        expect(mockSessionService.publish).toHaveBeenCalledWith(
          session.id,
          expect.objectContaining({
            type: 'agent:error',
            data: expect.objectContaining({
              agentId: agent.id,
              error: 'Test error',
            }),
          })
        );
      });
    });
  });

  // =============================================================================
  // Update Edge Cases (1 test)
  // =============================================================================

  describe('Update Edge Cases', () => {
    it('returns not found error when agent deleted between read and update', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      const db = getTestDb();

      // First call getById to verify agent exists
      const getResult = await agentService.getById(agent.id);
      expect(getResult.ok).toBe(true);

      // Delete the agent
      await db.delete(agents).where(eq(agents.id, agent.id));

      // Now try to update - getById will fail since agent is deleted
      const result = await agentService.update(agent.id, { maxTurns: 100 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Running Agent Model Update Prevention (1 test)
  // =============================================================================

  describe('Running Agent Update Prevention', () => {
    it('prevents updating model of running agent', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.update(agent.id, {
        model: 'claude-opus-4-20250514',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });
  });

  // =============================================================================
  // Resume Without Session (1 test)
  // =============================================================================

  describe('Resume Without Session', () => {
    it('resumes agent without current session', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const agent = await createTestAgent(project.id, {
        status: 'paused',
        currentTaskId: task.id,
        currentSessionId: null,
        currentTurn: 10,
      });

      const result = await agentService.resume(agent.id, 'Continue');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turnCount).toBe(10);
      }

      // Session publish should not be called when no session
      expect(mockSessionService.publish).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'approval:rejected' })
      );
    });
  });

  // =============================================================================
  // Auto-Dequeue (tryDequeueAndStart) Tests (3 tests)
  // =============================================================================

  describe('Auto-Dequeue (tryDequeueAndStart)', () => {
    it('auto-starts queued task after agent completes', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      // First task: agent will work on this and complete
      const firstTask = await createTestTask(project.id, {
        column: 'backlog',
        title: 'First Task',
      });
      const worktree = await createTestWorktree(project.id, { taskId: firstTask.id });
      const session = await createTestSession(project.id, {
        taskId: firstTask.id,
        agentId: agent.id,
      });

      // Second task: queued, should be auto-dequeued after first completes
      const queuedTask = await createTestTask(project.id, {
        column: 'queued',
        title: 'Queued Task',
      });
      const worktree2 = await createTestWorktree(project.id, { taskId: queuedTask.id });
      const session2 = await createTestSession(project.id, {
        taskId: queuedTask.id,
        agentId: agent.id,
      });

      // First call: completes the first task, agent goes idle, triggers auto-dequeue
      // Second call: auto-dequeue starts the agent on the queued task
      let callCount = 0;
      mockRunAgentPlanning.mockImplementation(async () => {
        callCount++;
        return {
          runId: `run-${callCount}`,
          status: 'completed',
          turnCount: 5,
        };
      });

      mockWorktreeService.create
        .mockResolvedValueOnce({ ok: true, value: worktree })
        .mockResolvedValueOnce({ ok: true, value: worktree2 });
      mockSessionService.create
        .mockResolvedValueOnce({ ok: true, value: session })
        .mockResolvedValueOnce({ ok: true, value: session2 });

      const result = await agentService.start(agent.id, firstTask.id);
      expect(result.ok).toBe(true);

      // Wait for async completion + auto-dequeue to trigger
      await vi.waitFor(
        async () => {
          expect(mockRunAgentPlanning).toHaveBeenCalledTimes(2);
        },
        { timeout: 5000 }
      );
    });

    it('does nothing when no tasks are queued', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog', title: 'Only Task' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        turnCount: 5,
      });

      await agentService.start(agent.id, task.id);

      // Wait for async completion
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('idle');
      });

      // runAgentPlanning should only be called once (no auto-dequeue)
      expect(mockRunAgentPlanning).toHaveBeenCalledTimes(1);
    });

    it('does not auto-dequeue when agent is not idle (e.g. error status)', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);
      const task = await createTestTask(project.id, { column: 'backlog' });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, { taskId: task.id, agentId: agent.id });

      // Create a queued task that should NOT be picked up
      await createTestTask(project.id, { column: 'queued', title: 'Should Not Start' });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session });
      // Agent execution returns error status - agent will be set to 'error', not 'idle'
      mockRunAgentPlanning.mockResolvedValue({
        runId: 'run-1',
        status: 'error',
        turnCount: 3,
        error: 'Something failed',
      });

      await agentService.start(agent.id, task.id);

      // Wait for async error handling
      await vi.waitFor(async () => {
        const db = getTestDb();
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });

      // runAgentPlanning should only be called once (no auto-dequeue because status is error, not completed)
      expect(mockRunAgentPlanning).toHaveBeenCalledTimes(1);
    });
  });

  // =============================================================================
  // Concurrency Count Fix Tests (4 tests)
  // =============================================================================

  describe('Concurrency Count Fix (starting/planning included)', () => {
    it('counts agents with status starting', async () => {
      const project = await createTestProject();
      await createTestAgent(project.id, { status: 'starting' });
      await createTestAgent(project.id, { status: 'idle' });

      const result = await agentService.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it('counts agents with status planning', async () => {
      const project = await createTestProject();
      await createTestAgent(project.id, { status: 'planning' });
      await createTestAgent(project.id, { status: 'idle' });

      const result = await agentService.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it('counts all three active statuses together', async () => {
      const project = await createTestProject();
      const task1 = await createTestTask(project.id);
      const session1 = await createTestSession(project.id, { taskId: task1.id });

      await createTestAgent(project.id, { status: 'starting' });
      await createTestAgent(project.id, { status: 'planning' });
      await createRunningAgent(project.id, task1.id, session1.id);

      const result = await agentService.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3);
      }
    });

    it('does NOT count idle, paused, or error agents', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });

      await createTestAgent(project.id, { status: 'idle' });
      await createTestAgent(project.id, { status: 'paused' });
      await createTestAgent(project.id, { status: 'error' });
      // One running agent to verify counting is selective
      await createRunningAgent(project.id, task.id, session.id);

      const result = await agentService.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });
  });
});
