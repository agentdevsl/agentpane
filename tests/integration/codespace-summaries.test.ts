import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTasksInColumns } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-025: Codespace Data Aggregation', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('aggregates task counts per codespace per column', async () => {
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });
    const codespaceC = await createTestProject({ name: 'Codespace C' });

    await createTasksInColumns(codespaceA.id, {
      backlog: 3,
      in_progress: 1,
      waiting_approval: 1,
    });

    await createTasksInColumns(codespaceB.id, {
      backlog: 2,
    });

    await createTasksInColumns(codespaceC.id, {
      verified: 1,
      in_progress: 1,
    });

    await createTestAgent(codespaceA.id, { status: 'running' });
    await createTestAgent(codespaceC.id, { status: 'idle' });

    const tasksA = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceA.id),
    });
    const tasksB = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceB.id),
    });
    const tasksC = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceC.id),
    });

    expect(tasksA).toHaveLength(5);
    expect(tasksA.filter((t) => t.column === 'backlog')).toHaveLength(3);
    expect(tasksA.filter((t) => t.column === 'in_progress')).toHaveLength(1);
    expect(tasksA.filter((t) => t.column === 'waiting_approval')).toHaveLength(1);

    expect(tasksB).toHaveLength(2);
    expect(tasksB.filter((t) => t.column === 'backlog')).toHaveLength(2);

    expect(tasksC).toHaveLength(2);
    expect(tasksC.filter((t) => t.column === 'verified')).toHaveLength(1);
    expect(tasksC.filter((t) => t.column === 'in_progress')).toHaveLength(1);
  });

  it('verifies total task counts across all codespaces', async () => {
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });
    const codespaceC = await createTestProject({ name: 'Codespace C' });

    await createTasksInColumns(codespaceA.id, {
      backlog: 3,
      in_progress: 1,
      waiting_approval: 1,
    });
    await createTasksInColumns(codespaceB.id, { backlog: 2 });
    await createTasksInColumns(codespaceC.id, { verified: 1, in_progress: 1 });

    const allTasks = await db.query.tasks.findMany();
    expect(allTasks).toHaveLength(9);
  });

  it('associates agents with correct codespaces', async () => {
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });
    const codespaceC = await createTestProject({ name: 'Codespace C' });

    await createTestAgent(codespaceA.id, { status: 'running' });
    await createTestAgent(codespaceC.id, { status: 'idle' });

    const agentsA = await db.query.agents.findMany({
      where: eq(agents.codespaceId, codespaceA.id),
    });
    const agentsB = await db.query.agents.findMany({
      where: eq(agents.codespaceId, codespaceB.id),
    });
    const agentsC = await db.query.agents.findMany({
      where: eq(agents.codespaceId, codespaceC.id),
    });

    expect(agentsA).toHaveLength(1);
    expect(agentsA[0].status).toBe('running');

    expect(agentsB).toHaveLength(0);

    expect(agentsC).toHaveLength(1);
    expect(agentsC[0].status).toBe('idle');
  });

  it('does not leak tasks between codespaces', async () => {
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });

    await createTasksInColumns(codespaceA.id, { backlog: 3, in_progress: 1 });
    await createTasksInColumns(codespaceB.id, { backlog: 2 });

    const tasksA = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceA.id),
    });
    const tasksB = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceB.id),
    });

    for (const task of tasksA) {
      expect(task.codespaceId).toBe(codespaceA.id);
    }
    for (const task of tasksB) {
      expect(task.codespaceId).toBe(codespaceB.id);
    }
  });
});
