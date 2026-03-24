import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, sessions, tasks, worktrees } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('ContainerAgentService — DB-level integration tests', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-101: tracks task in_progress and agent running state via DB', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const task = await createTestTask(project.id, { column: 'in_progress' });
    const agent = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    // Update task with agent reference
    await db.update(tasks).set({ agentId: agent.id }).where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });

    expect(dbTask?.column).toBe('in_progress');
    expect(dbTask?.agentId).toBe(agent.id);
    expect(dbAgent?.status).toBe('running');
    expect(dbAgent?.currentTaskId).toBe(task.id);
  });

  it('IT-102: simulates worktree creation and updates task.worktreeId', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });
    const worktree = await createTestWorktree(project.id, { taskId: task.id });

    // Simulate worktree assignment on task
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.worktreeId).toBe(worktree.id);
    expect(dbTask?.branch).toBe(worktree.branch);

    const dbWorktree = await db.query.worktrees.findFirst({ where: eq(worktrees.id, worktree.id) });
    expect(dbWorktree?.taskId).toBe(task.id);
    expect(dbWorktree?.status).toBe('active');
  });

  it('IT-103: differentiates sandbox providers via session sandboxProvider field', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const task1 = await createTestTask(project.id, { column: 'in_progress' });
    const task2 = await createTestTask(project.id, { column: 'in_progress' });

    const session1 = await createTestSession(project.id, { taskId: task1.id });
    const session2 = await createTestSession(project.id, { taskId: task2.id });

    // Simulate setting sandbox provider on sessions
    await db
      .update(sessions)
      .set({ sandboxProvider: 'docker' })
      .where(eq(sessions.id, session1.id));
    await db
      .update(sessions)
      .set({ sandboxProvider: 'agentcore' })
      .where(eq(sessions.id, session2.id));

    const dbSession1 = await db.query.sessions.findFirst({ where: eq(sessions.id, session1.id) });
    const dbSession2 = await db.query.sessions.findFirst({ where: eq(sessions.id, session2.id) });

    expect(dbSession1?.sandboxProvider).toBe('docker');
    expect(dbSession2?.sandboxProvider).toBe('agentcore');
  });

  it('IT-104: simulates agent stop — clears currentTaskId and sets status to idle', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });
    const agent = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    // Simulate agent stop
    await db
      .update(agents)
      .set({ currentTaskId: null, currentSessionId: null, status: 'idle', currentTurn: 0 })
      .where(eq(agents.id, agent.id));

    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(dbAgent?.status).toBe('idle');
    expect(dbAgent?.currentTaskId).toBeNull();
    expect(dbAgent?.currentSessionId).toBeNull();
    expect(dbAgent?.currentTurn).toBe(0);
  });

  it('IT-105: identifies running agents via status check (starting, planning, running)', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    await createTestAgent(project.id, { status: 'starting' });
    await createTestAgent(project.id, { status: 'planning' });
    await createTestAgent(project.id, { status: 'running' });
    await createTestAgent(project.id, { status: 'idle' });
    await createTestAgent(project.id, { status: 'error' });
    await createTestAgent(project.id, { status: 'completed' });

    const allAgents = await db.query.agents.findMany({
      where: eq(agents.codespaceId, project.id),
    });

    const runningStatuses = new Set(['starting', 'planning', 'running']);
    const isRunning = allAgents.filter((a) => runningStatuses.has(a.status));

    expect(isRunning).toHaveLength(3);
    expect(isRunning.map((a) => a.status).sort()).toEqual(['planning', 'running', 'starting']);
  });

  it('IT-106: simulates plan approval — task moves from waiting_approval to in_progress', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
    });

    // Set plan data on the task
    await db
      .update(tasks)
      .set({
        plan: 'Step 1: Implement feature\nStep 2: Write tests',
        planOptions: { allowedPrompts: [], launchSwarm: false },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Simulate approval: move to in_progress
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('in_progress');
    expect(dbTask?.plan).toBeTruthy();
    expect(dbTask?.planOptions).toBeTruthy();
  });

  it('IT-107: simulates plan rejection — clears plan data and moves to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
    });

    await db
      .update(tasks)
      .set({
        plan: 'Some plan content',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Simulate rejection
    await db
      .update(tasks)
      .set({
        column: 'backlog',
        plan: null,
        planOptions: null,
        lastAgentStatus: null,
        rejectionReason: 'Plan was insufficient',
        rejectionCount: 1,
      })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('backlog');
    expect(dbTask?.plan).toBeNull();
    expect(dbTask?.planOptions).toBeNull();
    expect(dbTask?.lastAgentStatus).toBeNull();
    expect(dbTask?.rejectionReason).toBe('Plan was insufficient');
    expect(dbTask?.rejectionCount).toBe(1);
  });

  it('IT-108: reconciles orphaned in_progress tasks — moves those without healthy agents to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const agentHealthy = await createTestAgent(project.id, { status: 'running' });
    const agentDead = await createTestAgent(project.id, { status: 'error' });

    const session1 = await createTestSession(project.id, { agentId: agentHealthy.id });
    const session2 = await createTestSession(project.id, { agentId: agentDead.id });

    const task1 = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agentHealthy.id,
      sessionId: session1.id,
    });
    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agentDead.id,
      sessionId: session2.id,
    });
    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: null,
    });

    // Reconcile: find orphaned tasks
    const inProgressTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'in_progress'), eq(tasks.codespaceId, project.id)),
    });
    expect(inProgressTasks).toHaveLength(3);

    const taskAgentIds = inProgressTasks.map((t) => t.agentId).filter(Boolean) as string[];
    const taskAgents =
      taskAgentIds.length > 0
        ? await db.query.agents.findMany({ where: inArray(agents.id, taskAgentIds) })
        : [];

    const healthyIds = new Set(
      taskAgents.filter((a) => a.status === 'running' || a.status === 'planning').map((a) => a.id)
    );

    const orphaned = inProgressTasks.filter((t) => !t.agentId || !healthyIds.has(t.agentId));
    expect(orphaned).toHaveLength(2); // task2 (dead agent) + task3 (no agent)

    for (const o of orphaned) {
      await db
        .update(tasks)
        .set({ column: 'backlog', agentId: null, sessionId: null })
        .where(eq(tasks.id, o.id));
    }

    const remaining = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'in_progress'), eq(tasks.codespaceId, project.id)),
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(task1.id);
  });

  it('IT-109: deleting agents sets null on dangling task references', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'running' });
    const task = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent.id,
    });

    // Delete the agent
    await db.delete(agents).where(eq(agents.id, agent.id));

    // Task's agentId should be set null via FK onDelete: 'set null'
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask).toBeTruthy();
    expect(dbTask?.agentId).toBeNull();
  });

  it('IT-110: detects existing agent assignment when starting a second time', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const agent1 = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });
    await db.update(tasks).set({ agentId: agent1.id }).where(eq(tasks.id, task.id));

    // Second start attempt: check if task already has an agent
    const existingTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(existingTask?.agentId).toBe(agent1.id);

    // Verify the existing agent is still running
    const existingAgent = existingTask?.agentId
      ? await db.query.agents.findFirst({ where: eq(agents.id, existingTask.agentId) })
      : null;
    expect(existingAgent?.status).toBe('running');
    expect(existingAgent?.currentTaskId).toBe(task.id);
  });

  it('IT-111: tracks error state via lastAgentStatus on the task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const errorStatuses = ['error', 'turn_limit', 'cancelled'] as const;
    for (const status of errorStatuses) {
      await db.update(tasks).set({ lastAgentStatus: status }).where(eq(tasks.id, task.id));

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.lastAgentStatus).toBe(status);
    }
  });

  it('IT-112: stores sandbox provider name on the session record', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'running' });
    const task = await createTestTask(project.id, { column: 'in_progress', agentId: agent.id });

    const session = await createTestSession(project.id, {
      taskId: task.id,
      agentId: agent.id,
    });

    // Store provider and container ID on session
    await db
      .update(sessions)
      .set({
        sandboxProvider: 'docker',
        sandboxContainerId: 'container-abc123',
      })
      .where(eq(sessions.id, session.id));

    const dbSession = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(dbSession?.sandboxProvider).toBe('docker');
    expect(dbSession?.sandboxContainerId).toBe('container-abc123');
    expect(dbSession?.taskId).toBe(task.id);
    expect(dbSession?.agentId).toBe(agent.id);
  });
});
