import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-014: Container agent orphaned task reconciliation', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('identifies and moves orphaned tasks to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const agent1 = await createTestAgent(project.id, { status: 'running' });
    const agent2 = await createTestAgent(project.id, { status: 'running' });
    const agent3 = await createTestAgent(project.id, { status: 'error' });

    const session1 = await createTestSession(project.id, { agentId: agent1.id });
    const session2 = await createTestSession(project.id, { agentId: agent2.id });
    const session3 = await createTestSession(project.id, { agentId: agent3.id });

    const task1 = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent1.id,
      sessionId: session1.id,
    });
    const task2 = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent2.id,
      sessionId: session2.id,
    });
    const task3 = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent3.id,
      sessionId: session3.id,
    });

    const inProgressTasks = await db.query.tasks.findMany({
      where: eq(tasks.column, 'in_progress'),
    });
    expect(inProgressTasks).toHaveLength(3);

    const taskAgentIds = inProgressTasks.map((t) => t.agentId).filter(Boolean) as string[];
    const taskAgents = await db.query.agents.findMany({
      where: inArray(agents.id, taskAgentIds),
    });

    const healthyAgentIds = new Set(
      taskAgents.filter((a) => a.status === 'running' || a.status === 'planning').map((a) => a.id)
    );

    const orphanedTasks = inProgressTasks.filter(
      (t) => !t.agentId || !healthyAgentIds.has(t.agentId)
    );

    expect(orphanedTasks).toHaveLength(1);
    expect(orphanedTasks[0]!.id).toBe(task3.id);

    for (const orphan of orphanedTasks) {
      await db
        .update(tasks)
        .set({ column: 'backlog', agentId: null, sessionId: null })
        .where(eq(tasks.id, orphan.id));
    }

    const finalInProgress = await db.query.tasks.findMany({
      where: eq(tasks.column, 'in_progress'),
    });
    expect(finalInProgress).toHaveLength(2);
    expect(finalInProgress.map((t) => t.id).sort()).toEqual([task1.id, task2.id].sort());

    const backlogTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'backlog'), eq(tasks.id, task3.id)),
    });
    expect(backlogTasks).toHaveLength(1);
    expect(backlogTasks[0]!.agentId).toBeNull();
    expect(backlogTasks[0]!.sessionId).toBeNull();
  });

  it('keeps all tasks when all agents are healthy', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const agent1 = await createTestAgent(project.id, { status: 'running' });
    const agent2 = await createTestAgent(project.id, { status: 'planning' });

    const session1 = await createTestSession(project.id, { agentId: agent1.id });
    const session2 = await createTestSession(project.id, { agentId: agent2.id });

    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent1.id,
      sessionId: session1.id,
    });
    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent2.id,
      sessionId: session2.id,
    });

    const inProgressTasks = await db.query.tasks.findMany({
      where: eq(tasks.column, 'in_progress'),
    });

    const taskAgentIds = inProgressTasks.map((t) => t.agentId).filter(Boolean) as string[];
    const taskAgents = await db.query.agents.findMany({
      where: inArray(agents.id, taskAgentIds),
    });

    const healthyAgentIds = new Set(
      taskAgents.filter((a) => a.status === 'running' || a.status === 'planning').map((a) => a.id)
    );

    const orphanedTasks = inProgressTasks.filter(
      (t) => !t.agentId || !healthyAgentIds.has(t.agentId)
    );

    expect(orphanedTasks).toHaveLength(0);
  });

  it('treats tasks with no agentId as orphaned', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const agent1 = await createTestAgent(project.id, { status: 'running' });
    const session1 = await createTestSession(project.id, { agentId: agent1.id });

    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent1.id,
      sessionId: session1.id,
    });
    const taskNoAgent = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: null,
      sessionId: null,
    });

    const inProgressTasks = await db.query.tasks.findMany({
      where: eq(tasks.column, 'in_progress'),
    });

    const taskAgentIds = inProgressTasks.map((t) => t.agentId).filter(Boolean) as string[];
    const taskAgents =
      taskAgentIds.length > 0
        ? await db.query.agents.findMany({ where: inArray(agents.id, taskAgentIds) })
        : [];

    const healthyAgentIds = new Set(
      taskAgents.filter((a) => a.status === 'running' || a.status === 'planning').map((a) => a.id)
    );

    const orphanedTasks = inProgressTasks.filter(
      (t) => !t.agentId || !healthyAgentIds.has(t.agentId)
    );

    expect(orphanedTasks).toHaveLength(1);
    expect(orphanedTasks[0]!.id).toBe(taskNoAgent.id);
  });
});
