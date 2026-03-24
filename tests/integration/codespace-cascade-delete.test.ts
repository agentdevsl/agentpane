import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, codespaces, sessions, tasks, worktrees } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Codespace Cascade Delete (IT-009)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await clearTestDatabase();
    // clearTestDatabase enables foreign_keys = ON
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('deleting codespace cascades to tasks, agents, sessions, and worktrees', async () => {
    const db = getTestDb();
    const project = await createTestProject({ name: 'Cascade Test' });

    const task1 = await createTestTask(project.id, { title: 'Task A' });
    const _task2 = await createTestTask(project.id, { title: 'Task B' });
    const agent = await createTestAgent(project.id, { name: 'Agent A' });
    const _session = await createTestSession(project.id, { taskId: task1.id, agentId: agent.id });
    const _worktree = await createTestWorktree(project.id, { taskId: task1.id });

    // Verify children exist
    const tasksBefore = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, project.id),
    });
    expect(tasksBefore.length).toBe(2);

    const agentsBefore = await db.query.agents.findMany({
      where: eq(agents.codespaceId, project.id),
    });
    expect(agentsBefore.length).toBe(1);

    // Delete the codespace
    await db.delete(codespaces).where(eq(codespaces.id, project.id));

    // Verify children are deleted (cascade)
    const tasksAfter = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, project.id),
    });
    expect(tasksAfter.length).toBe(0);

    const agentsAfter = await db.query.agents.findMany({
      where: eq(agents.codespaceId, project.id),
    });
    expect(agentsAfter.length).toBe(0);

    const sessionsAfter = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, project.id),
    });
    expect(sessionsAfter.length).toBe(0);

    const worktreesAfter = await db.query.worktrees.findMany({
      where: eq(worktrees.codespaceId, project.id),
    });
    expect(worktreesAfter.length).toBe(0);
  });

  it('deleting one codespace does not affect another', async () => {
    const db = getTestDb();
    const projectA = await createTestProject({ name: 'Project A' });
    const projectB = await createTestProject({ name: 'Project B' });

    await createTestTask(projectA.id, { title: 'Task A' });
    await createTestTask(projectB.id, { title: 'Task B' });
    await createTestAgent(projectA.id, { name: 'Agent A' });
    await createTestAgent(projectB.id, { name: 'Agent B' });

    // Delete project A
    await db.delete(codespaces).where(eq(codespaces.id, projectA.id));

    // Project B data is untouched
    const tasksB = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, projectB.id),
    });
    expect(tasksB.length).toBe(1);
    expect(tasksB[0].title).toBe('Task B');

    const agentsB = await db.query.agents.findMany({
      where: eq(agents.codespaceId, projectB.id),
    });
    expect(agentsB.length).toBe(1);
    expect(agentsB[0].name).toBe('Agent B');
  });

  it('codespace with no children deletes cleanly', async () => {
    const db = getTestDb();
    const project = await createTestProject({ name: 'Empty Project' });

    await db.delete(codespaces).where(eq(codespaces.id, project.id));

    const found = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, project.id),
    });
    expect(found).toBeUndefined();
  });
});
