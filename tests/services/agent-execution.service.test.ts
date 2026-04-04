import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { createRunningAgent, createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Get references to mocked functions so we can change behavior per-test
const mockRunAgentPlanning = vi.fn().mockResolvedValue({
  status: 'planning',
  turnCount: 5,
  plan: 'Test plan',
  planOptions: {},
});

const mockRunAgentExecution = vi.fn().mockResolvedValue({
  status: 'completed',
  turnCount: 10,
});

const mockHandleAgentError = vi.fn().mockReturnValue({ action: 'fail', reason: 'test' });

// Mock external dependencies
vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: (...args: unknown[]) => mockRunAgentPlanning(...args),
  runAgentExecution: (...args: unknown[]) => mockRunAgentExecution(...args),
}));

vi.mock('../../src/lib/agents/recovery.js', () => ({
  handleAgentError: (...args: unknown[]) => mockHandleAgentError(...args),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue(undefined),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  DEFAULT_AGENT_MAX_RUNTIME_MS: 4 * 60 * 60 * 1000,
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

  /** Helper: set up standard start prerequisites and return all entities */
  async function setupStartPrerequisites(
    projectOverrides: Record<string, unknown> = {},
    taskOverrides: Record<string, unknown> = {}
  ) {
    const project = await createTestProject(projectOverrides);
    const agent = await createTestAgent(project.id, { status: 'idle' });
    const task = await createTestTask(project.id, { column: 'backlog', ...taskOverrides });
    const worktree = await createTestWorktree(project.id, { taskId: task.id });
    const session = await createTestSession(project.id, {
      taskId: task.id,
      agentId: agent.id,
    });

    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({ ok: true, value: session });

    return { project, agent, task, worktree, session };
  }

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
    // Reset mock implementations to defaults
    mockRunAgentPlanning.mockResolvedValue({
      status: 'planning',
      turnCount: 5,
      plan: 'Test plan',
      planOptions: {},
    });
    mockRunAgentExecution.mockResolvedValue({
      status: 'completed',
      turnCount: 10,
    });
    mockHandleAgentError.mockReturnValue({ action: 'fail', reason: 'test' });
  });

  afterEach(async () => {
    service.stopAll();
    // Allow pending async operations to settle after abort
    await new Promise((resolve) => setTimeout(resolve, 50));
    await clearTestDatabase();
  });

  // ===========================================================================
  // 1. start with valid agent and task
  // ===========================================================================

  it('start with valid agent and task returns ok with agent, task, session, worktree', async () => {
    const { agent, task } = await setupStartPrerequisites();

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
  // 10. Hook registration removed (AE-007 - dead hook infrastructure removed)
  // ===========================================================================

  // ===========================================================================
  // Group A: Full lifecycle flow
  // ===========================================================================

  describe('Full lifecycle flow', () => {
    it('start → planning completes → plan stored on task', async () => {
      mockRunAgentPlanning.mockResolvedValue({
        status: 'planning',
        turnCount: 5,
        plan: 'Step 1: Refactor module\nStep 2: Add tests',
        planOptions: { launchSwarm: false },
      });

      const { agent, task } = await setupStartPrerequisites();

      const result = await service.start(agent.id, task.id);
      expect(result.ok).toBe(true);

      // Wait for async executeAgentAsync to complete and store plan on task
      const db = getTestDb();
      await vi.waitFor(async () => {
        const updatedTask = await db.query.tasks.findFirst({
          where: eq(tasks.id, task.id),
        });
        expect(updatedTask?.plan).toBe('Step 1: Refactor module\nStep 2: Add tests');
      });

      // Verify agent is in planning status
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('planning');
    });

    it('resume from planning triggers execution phase', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        column: 'in_progress',
        description: 'Implement feature X',
      });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, {
        taskId: task.id,
      });

      // Store plan on task (simulating planning phase completion)
      const db = getTestDb();
      await db
        .update(tasks)
        .set({ plan: 'Execute the refactor', worktreeId: worktree.id })
        .where(eq(tasks.id, task.id));

      const agent = await createTestAgent(project.id, {
        status: 'planning',
        currentTaskId: task.id,
        currentSessionId: session.id,
        currentTurn: 5,
      });

      mockRunAgentExecution.mockResolvedValue({
        status: 'completed',
        turnCount: 15,
      });

      const result = await service.resume(agent.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('planning');
        expect(result.value.turnCount).toBe(5);
      }

      // Verify agent status was set to running for execution
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('running');
    });

    it('full lifecycle: start → plan → approve → complete', async () => {
      // Phase 1: Start -> Planning
      mockRunAgentPlanning.mockResolvedValue({
        status: 'planning',
        turnCount: 5,
        plan: 'Implementation plan',
        planOptions: {},
      });

      const { agent, task, worktree } = await setupStartPrerequisites();

      const startResult = await service.start(agent.id, task.id);
      expect(startResult.ok).toBe(true);

      const db = getTestDb();

      // Wait for planning to complete
      await vi.waitFor(async () => {
        const a = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(a?.status).toBe('planning');
      });

      // Store worktreeId on task for execution phase
      await db.update(tasks).set({ worktreeId: worktree.id }).where(eq(tasks.id, task.id));

      // Phase 2: Approve -> Execution -> Complete
      mockRunAgentExecution.mockResolvedValue({
        status: 'completed',
        turnCount: 20,
      });

      const resumeResult = await service.resume(agent.id);
      expect(resumeResult.ok).toBe(true);

      // Wait for execution to complete
      await vi.waitFor(async () => {
        const a = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(a?.status).toBe('idle');
      });

      // Task should be in waiting_approval
      const finalTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      expect(finalTask?.column).toBe('waiting_approval');
    });
  });

  // ===========================================================================
  // Group B: Stop/pause/resume with abort
  // ===========================================================================

  describe('Stop/pause/resume with abort', () => {
    it('stop aborts the controller and cleans runningAgents', async () => {
      // Make planning hang so the agent stays in runningAgents
      let resolvePlanning!: (value: unknown) => void;
      mockRunAgentPlanning.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePlanning = resolve;
          })
      );

      const { agent, task } = await setupStartPrerequisites();

      // Start the agent to populate runningAgents map
      const startResult = await service.start(agent.id, task.id);
      expect(startResult.ok).toBe(true);

      // Agent should now be running (in the runningAgents map)
      expect(service.isRunning(agent.id)).toBe(true);

      // Stop should succeed and clean up
      const stopResult = await service.stop(agent.id);
      expect(stopResult.ok).toBe(true);

      // Agent should no longer be in runningAgents
      expect(service.isRunning(agent.id)).toBe(false);

      // DB should show idle
      const db = getTestDb();
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('idle');
      expect(updatedAgent?.currentTaskId).toBeNull();
      expect(updatedAgent?.currentSessionId).toBeNull();

      // Resolve the hanging promise to avoid unhandled rejection
      resolvePlanning({ status: 'completed', turnCount: 0 });
    });

    it('pause does NOT abort — agent can be resumed', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createRunningAgent(project.id, task.id, session.id);

      // Pause the agent
      const pauseResult = await service.pause(agent.id);
      expect(pauseResult.ok).toBe(true);

      // Verify agent is paused in DB
      const db = getTestDb();
      let updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('paused');

      // Agent should still have its task and session assignments
      expect(updatedAgent?.currentTaskId).toBe(task.id);
      expect(updatedAgent?.currentSessionId).toBe(session.id);

      // Resume should succeed
      const resumeResult = await service.resume(agent.id, 'Keep going');
      expect(resumeResult.ok).toBe(true);

      // Agent should be running again
      updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('running');
    });

    it('resume for non-paused agent returns NOT_RUNNING', async () => {
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { status: 'idle' });

      const result = await service.resume(agent.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_RUNNING');
      }
    });

    it('resume with feedback publishes agent:resumed', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const session = await createTestSession(project.id, { taskId: task.id });
      const agent = await createTestAgent(project.id, {
        status: 'paused',
        currentTaskId: task.id,
        currentSessionId: session.id,
        currentTurn: 5,
      });

      await service.resume(agent.id, 'Please try a different approach');

      // Verify agent:resumed event was published with feedback (AE-012)
      expect(mockSessionService.publish).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          type: 'agent:resumed',
          data: expect.objectContaining({ feedback: 'Please try a different approach' }),
        })
      );
    });
  });

  // ===========================================================================
  // Group C: Concurrency limits
  // ===========================================================================

  describe('Concurrency limits', () => {
    it('start rejects when limit reached (LIMIT_EXCEEDED)', async () => {
      const project = await createTestProject({ maxConcurrentAgents: 1 });

      // Create a running agent that fills the limit
      const task1 = await createTestTask(project.id, { column: 'in_progress' });
      const session1 = await createTestSession(project.id, { taskId: task1.id });
      await createRunningAgent(project.id, task1.id, session1.id);

      // Try to start a second agent — should hit limit
      const agent2 = await createTestAgent(project.id, { status: 'idle' });
      const task2 = await createTestTask(project.id, { column: 'backlog' });

      const result = await service.start(agent2.id, task2.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
      }
    });

    it('getRunningCount counts starting + planning + running', async () => {
      const project = await createTestProject();
      const task1 = await createTestTask(project.id, { column: 'in_progress' });
      const task2 = await createTestTask(project.id, { column: 'in_progress' });
      const task3 = await createTestTask(project.id, { column: 'in_progress' });
      const session1 = await createTestSession(project.id, { taskId: task1.id });
      const session2 = await createTestSession(project.id, { taskId: task2.id });
      const session3 = await createTestSession(project.id, { taskId: task3.id });

      // Create agents in different active states
      await createTestAgent(project.id, {
        status: 'starting',
        currentTaskId: task1.id,
        currentSessionId: session1.id,
      });
      await createTestAgent(project.id, {
        status: 'planning',
        currentTaskId: task2.id,
        currentSessionId: session2.id,
      });
      await createTestAgent(project.id, {
        status: 'running',
        currentTaskId: task3.id,
        currentSessionId: session3.id,
      });

      // Also create idle and paused agents that should NOT be counted
      await createTestAgent(project.id, { status: 'idle' });
      await createTestAgent(project.id, { status: 'paused' });

      const result = await service.getRunningCount(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3);
      }
    });

    it('checkAvailability returns false at limit', async () => {
      const project = await createTestProject({ maxConcurrentAgents: 1 });

      // Create one running agent — fills the limit
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });
      await createRunningAgent(project.id, task.id, session.id);

      const result = await service.checkAvailability(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  // ===========================================================================
  // Group D: Error recovery
  // ===========================================================================

  describe('Error recovery', () => {
    it('execution error sets agent to error status', async () => {
      mockRunAgentPlanning.mockRejectedValue(new Error('SDK connection failed'));
      mockHandleAgentError.mockReturnValue({ action: 'fail', reason: 'unrecoverable' });

      const { agent, task } = await setupStartPrerequisites();

      const result = await service.start(agent.id, task.id);
      expect(result.ok).toBe(true);

      const db = getTestDb();

      // Wait for async error handling to complete
      await vi.waitFor(async () => {
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });

      // Should no longer be in runningAgents
      expect(service.isRunning(agent.id)).toBe(false);
    });

    it('rate limit triggers pause recovery', async () => {
      mockRunAgentPlanning.mockRejectedValue(new Error('Rate limited'));
      mockHandleAgentError.mockReturnValue({ action: 'pause', reason: 'rate_limit' });

      const { agent, task } = await setupStartPrerequisites();

      await service.start(agent.id, task.id);

      const db = getTestDb();

      // Wait for async error handling — recovery.action === 'pause' → status 'paused'
      await vi.waitFor(async () => {
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('paused');
      });
    });

    it('agent not found during execution → error + cleanup', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, {
        column: 'in_progress',
        description: 'Test task',
      });
      const worktree = await createTestWorktree(project.id, { taskId: task.id });
      const session = await createTestSession(project.id, {
        taskId: task.id,
      });

      // Create a planning agent, but we'll delete it before execution can find it
      const agent = await createTestAgent(project.id, {
        status: 'planning',
        currentTaskId: task.id,
        currentSessionId: session.id,
        currentTurn: 5,
      });

      // Store worktreeId on task
      const db = getTestDb();
      await db.update(tasks).set({ worktreeId: worktree.id }).where(eq(tasks.id, task.id));

      // Delete the agent before resume triggers execution
      await db.delete(agents).where(eq(agents.id, agent.id));

      // Resume should still return ok (it fires async execution)
      // but executeAgentExecution will find no agent
      const result = await service.resume(agent.id);

      // Agent not found → AGENT_NOT_FOUND (since agent was deleted)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('unhandled error publishes agent:error event', async () => {
      mockRunAgentPlanning.mockRejectedValue(new Error('Unexpected crash'));
      mockHandleAgentError.mockReturnValue({ action: 'fail', reason: 'unknown' });

      const { agent, task } = await setupStartPrerequisites();

      await service.start(agent.id, task.id);

      // Wait for the error event to be published
      await vi.waitFor(() => {
        expect(mockSessionService.publish).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            type: 'agent:error',
            data: expect.objectContaining({
              agentId: agent.id,
              error: 'Unexpected crash',
            }),
          })
        );
      });
    });
  });

  // ===========================================================================
  // Group E: Queue integration
  // ===========================================================================

  describe('Queue integration', () => {
    it('completed agent triggers auto-dequeue', async () => {
      // Set up planning mock to return completed (simulate full lifecycle)
      mockRunAgentPlanning.mockResolvedValue({
        status: 'completed',
        turnCount: 10,
      });

      const { agent, task, project } = await setupStartPrerequisites();

      // Create a queued task that should be auto-dequeued
      const queuedTask = await createTestTask(project.id, { column: 'queued' });

      // Set up a mock queue service
      const mockQueueService = {
        dequeueNext: vi.fn().mockResolvedValue({ ok: true, value: queuedTask }),
      };
      service.setQueueService(mockQueueService as never);

      // Need the agent to be idle after completion for tryDequeueAndStart
      // But start() will trigger the whole flow; mock worktree/session for dequeue restart
      const worktree2 = await createTestWorktree(project.id, { taskId: queuedTask.id });
      const session2 = await createTestSession(project.id, {
        taskId: queuedTask.id,
        agentId: agent.id,
      });

      // After first task completes, the agent becomes idle and tries to dequeue
      // The dequeued task's column needs to be backlog for start() to accept it
      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree2 });
      mockSessionService.create.mockResolvedValue({ ok: true, value: session2 });

      await service.start(agent.id, task.id);

      // Wait for completion and dequeue attempt
      await vi.waitFor(() => {
        expect(mockQueueService.dequeueNext).toHaveBeenCalledWith(project.id);
      });
    });

    it('failed agent does NOT dequeue', async () => {
      mockRunAgentPlanning.mockRejectedValue(new Error('Agent crashed'));
      mockHandleAgentError.mockReturnValue({ action: 'fail', reason: 'crash' });

      const { agent, task } = await setupStartPrerequisites();

      const mockQueueService = {
        dequeueNext: vi.fn(),
      };
      service.setQueueService(mockQueueService as never);

      await service.start(agent.id, task.id);

      // Wait for error handling to complete
      const db = getTestDb();
      await vi.waitFor(async () => {
        const updatedAgent = await db.query.agents.findFirst({
          where: eq(agents.id, agent.id),
        });
        expect(updatedAgent?.status).toBe('error');
      });

      // Dequeue should never have been called
      expect(mockQueueService.dequeueNext).not.toHaveBeenCalled();
    });

    it('dequeue failure is logged but not propagated', async () => {
      mockRunAgentPlanning.mockResolvedValue({
        status: 'completed',
        turnCount: 10,
      });

      const { agent, task } = await setupStartPrerequisites();

      // Mock queue service that throws during dequeue
      const mockQueueService = {
        dequeueNext: vi.fn().mockRejectedValue(new Error('Queue DB error')),
      };
      service.setQueueService(mockQueueService as never);

      // Start should succeed even if dequeue fails later
      const result = await service.start(agent.id, task.id);
      expect(result.ok).toBe(true);

      // Wait for completion + dequeue attempt
      await vi.waitFor(() => {
        expect(mockQueueService.dequeueNext).toHaveBeenCalled();
      });

      // Agent should still have completed successfully (dequeue error doesn't affect it)
      const db = getTestDb();
      const updatedAgent = await db.query.agents.findFirst({
        where: eq(agents.id, agent.id),
      });
      expect(updatedAgent?.status).toBe('idle');
    });

    it('queued task auto-starts when agent frees up', async () => {
      mockRunAgentPlanning.mockResolvedValue({
        status: 'completed',
        turnCount: 10,
      });

      const { agent, task, project } = await setupStartPrerequisites();

      // Create a backlog task that should be picked up after dequeue
      const nextTask = await createTestTask(project.id, { column: 'backlog' });

      const mockQueueService = {
        // dequeueNext returns the next task with column set to backlog
        // (dequeueNext moves queued→backlog before returning)
        dequeueNext: vi.fn().mockResolvedValue({ ok: true, value: nextTask }),
      };
      service.setQueueService(mockQueueService as never);

      // Pre-setup mocks for the second start() call
      const worktree2 = await createTestWorktree(project.id, { taskId: nextTask.id });
      const session2 = await createTestSession(project.id, {
        taskId: nextTask.id,
        agentId: agent.id,
      });

      // Use mockImplementation to return fresh values for each call
      let startCallCount = 0;
      mockWorktreeService.create.mockImplementation(async () => {
        startCallCount++;
        return {
          ok: true,
          value:
            startCallCount === 1
              ? await createTestWorktree(project.id, { taskId: task.id })
              : worktree2,
        };
      });
      mockSessionService.create.mockImplementation(async () => {
        return {
          ok: true,
          value:
            startCallCount === 1
              ? await createTestSession(project.id, { taskId: task.id, agentId: agent.id })
              : session2,
        };
      });

      await service.start(agent.id, task.id);

      // Wait for dequeue to be called (proving the auto-start chain works)
      await vi.waitFor(() => {
        expect(mockQueueService.dequeueNext).toHaveBeenCalledWith(project.id);
      });
    });
  });
});
