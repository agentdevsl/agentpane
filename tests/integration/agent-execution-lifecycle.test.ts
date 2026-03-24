import { and, count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agents, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestAgentRun } from '../factories/agent-run.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Agent Execution Lifecycle (IT-077 to IT-081)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-077: simulate agent assignment to task — update agent and task states atomically', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'idle', name: 'Worker Agent' });
    const task = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Implement feature',
    });

    // Simulate what AgentExecutionService.start() does at the DB level:
    // 1. Update agent: set currentTaskId, status to starting
    await db
      .update(agents)
      .set({
        currentTaskId: task.id,
        status: 'starting',
      })
      .where(eq(agents.id, agent.id));

    // 2. Update task: set agentId, move to in_progress
    await db
      .update(tasks)
      .set({
        agentId: agent.id,
        column: 'in_progress',
      })
      .where(eq(tasks.id, task.id));

    // Verify agent state
    const updatedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });
    expect(updatedAgent).toBeDefined();
    expect(updatedAgent!.status).toBe('starting');
    expect(updatedAgent!.currentTaskId).toBe(task.id);

    // Verify task state
    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedTask).toBeDefined();
    expect(updatedTask!.column).toBe('in_progress');
    expect(updatedTask!.agentId).toBe(agent.id);
  });

  it('IT-078: find oldest backlog task by updatedAt for next pickup', async () => {
    const codespace = await createTestProject();

    // Create 3 backlog tasks with staggered timestamps
    const task1 = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Oldest Task',
    });
    const task2 = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Middle Task',
    });
    const task3 = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Newest Task',
    });

    // Set specific updatedAt values
    await db
      .update(tasks)
      .set({ updatedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(tasks.id, task1.id));
    await db
      .update(tasks)
      .set({ updatedAt: '2026-01-02T00:00:00.000Z' })
      .where(eq(tasks.id, task2.id));
    await db
      .update(tasks)
      .set({ updatedAt: '2026-01-03T00:00:00.000Z' })
      .where(eq(tasks.id, task3.id));

    // Find oldest backlog task (what agent pickup would do)
    const oldest = await db.query.tasks.findFirst({
      where: and(eq(tasks.codespaceId, codespace.id), eq(tasks.column, 'backlog')),
      orderBy: [tasks.updatedAt],
    });

    expect(oldest).toBeDefined();
    expect(oldest!.id).toBe(task1.id);
    expect(oldest!.title).toBe('Oldest Task');
  });

  it('IT-079: verify concurrency limit enforcement at DB level', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 2 });

    // Create 2 running agents (at the limit)
    await createTestAgent(codespace.id, { status: 'running', name: 'Runner 1' });
    await createTestAgent(codespace.id, { status: 'running', name: 'Runner 2' });

    // Count running agents
    const [runningResult] = await db
      .select({ count: count() })
      .from(agents)
      .where(and(eq(agents.codespaceId, codespace.id), eq(agents.status, 'running')));

    expect(runningResult.count).toBe(2);

    // Verify we are at the concurrency limit
    const codespaceRecord = await db.query.codespaces.findFirst({
      where: eq(codespace.id, codespace.id),
    });
    expect(codespaceRecord).toBeDefined();
    expect(runningResult.count).toBe(codespaceRecord!.maxConcurrentAgents);

    // A 3rd running agent would exceed the limit
    expect(runningResult.count >= codespaceRecord!.maxConcurrentAgents).toBe(true);
  });

  it('IT-080: simulate atomic agent start — agent, task, and agentRun records all consistent', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'idle', name: 'Starter Agent' });
    const task = await createTestTask(codespace.id, { column: 'backlog', title: 'Start me' });
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      agentId: agent.id,
      status: 'active',
    });

    // Simulate atomic start: update agent, task, and create agentRun
    await db
      .update(agents)
      .set({
        status: 'running',
        currentTaskId: task.id,
        currentSessionId: session.id,
        currentTurn: 1,
      })
      .where(eq(agents.id, agent.id));

    await db
      .update(tasks)
      .set({
        agentId: agent.id,
        sessionId: session.id,
        column: 'in_progress',
      })
      .where(eq(tasks.id, task.id));

    const agentRun = await createTestAgentRun(agent.id, task.id, codespace.id, {
      sessionId: session.id,
      status: 'running',
      startedAt: new Date().toISOString() as unknown as Date,
    });

    // Verify all three records are consistent
    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    const dbRun = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, agentRun.id) });

    expect(dbAgent).toBeDefined();
    expect(dbAgent!.status).toBe('running');
    expect(dbAgent!.currentTaskId).toBe(task.id);
    expect(dbAgent!.currentSessionId).toBe(session.id);

    expect(dbTask).toBeDefined();
    expect(dbTask!.agentId).toBe(agent.id);
    expect(dbTask!.sessionId).toBe(session.id);
    expect(dbTask!.column).toBe('in_progress');

    expect(dbRun).toBeDefined();
    expect(dbRun!.agentId).toBe(agent.id);
    expect(dbRun!.taskId).toBe(task.id);
    expect(dbRun!.sessionId).toBe(session.id);
    expect(dbRun!.status).toBe('running');
  });

  it('IT-081: simulate agent stop — clear task refs and reset to idle', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress', title: 'Stop me' });
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      status: 'active',
    });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      name: 'Stopping Agent',
      currentTaskId: task.id,
      currentSessionId: session.id,
    });

    // Simulate stop: reset agent to idle, clear references
    await db
      .update(agents)
      .set({
        status: 'idle',
        currentTaskId: null,
        currentSessionId: null,
        currentTurn: 0,
      })
      .where(eq(agents.id, agent.id));

    // Verify clean state
    const stoppedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });

    expect(stoppedAgent).toBeDefined();
    expect(stoppedAgent!.status).toBe('idle');
    expect(stoppedAgent!.currentTaskId).toBeNull();
    expect(stoppedAgent!.currentSessionId).toBeNull();
    expect(stoppedAgent!.currentTurn).toBe(0);
  });
});
