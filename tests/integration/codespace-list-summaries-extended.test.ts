import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, codespaces, projectFolders, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTasksInColumns, createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-051–055: Codespace List & Summaries Extended', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-051: lists codespaces with different orderings', async () => {
    const csA = await createTestProject({ name: 'Alpha' });
    const csB = await createTestProject({ name: 'Bravo' });
    const csC = await createTestProject({ name: 'Charlie' });

    // Order by name ascending
    const byNameAsc = await db.query.codespaces.findMany({
      orderBy: [codespaces.name],
    });
    const names = byNameAsc.map((c) => c.name);
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie']);

    // Order by name descending
    const byNameDesc = await db.query.codespaces.findMany({
      orderBy: [desc(codespaces.name)],
    });
    const namesDesc = byNameDesc.map((c) => c.name);
    expect(namesDesc).toEqual(['Charlie', 'Bravo', 'Alpha']);

    // Verify all 3 exist
    expect(byNameAsc).toHaveLength(3);
    expect([csA.id, csB.id, csC.id].sort()).toEqual(byNameAsc.map((c) => c.id).sort());
  });

  it('IT-052: filters codespaces by projectFolderId', async () => {
    // Create a second project folder
    const folder2Id = createId();
    await db.insert(projectFolders).values({
      id: folder2Id,
      name: 'Team Folder',
      slug: `team-${folder2Id.slice(0, 6)}`,
      description: 'Separate folder for filtering',
    });

    const csDefault = await createTestProject({
      name: 'Default Folder CS',
      projectFolderId: 'default-folder',
    });
    const csTeam = await createTestProject({
      name: 'Team Folder CS',
      projectFolderId: folder2Id,
    });

    // Filter by default folder
    const defaultItems = await db.query.codespaces.findMany({
      where: eq(codespaces.projectFolderId, 'default-folder'),
    });
    expect(defaultItems).toHaveLength(1);
    expect(defaultItems[0].id).toBe(csDefault.id);

    // Filter by team folder
    const teamItems = await db.query.codespaces.findMany({
      where: eq(codespaces.projectFolderId, folder2Id),
    });
    expect(teamItems).toHaveLength(1);
    expect(teamItems[0].id).toBe(csTeam.id);
  });

  it('IT-053: detects running agents for a codespace', async () => {
    const codespace = await createTestProject({ name: 'Active CS' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Active Task',
    });

    // Create a running agent
    await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    // Create an idle agent (should not count as running)
    await createTestAgent(codespace.id, { status: 'idle' });

    // Query active agents (statuses: starting, planning, running)
    const activeStatuses = ['starting', 'planning', 'running'] as const;
    const activeAgents = await db.query.agents.findMany({
      where: eq(agents.codespaceId, codespace.id),
    });

    const running = activeAgents.filter((a) =>
      (activeStatuses as readonly string[]).includes(a.status)
    );
    expect(running).toHaveLength(1);
    expect(running[0].currentTaskId).toBe(task.id);

    const idle = activeAgents.filter((a) => a.status === 'idle');
    expect(idle).toHaveLength(1);
  });

  it('IT-054: empty codespace table returns empty list', async () => {
    const allCodespaces = await db.query.codespaces.findMany();
    expect(allCodespaces).toHaveLength(0);
  });

  it('IT-055: counts tasks per column for a codespace with tasks in all 5 columns', async () => {
    const codespace = await createTestProject({ name: 'Full Kanban' });

    const columnTasks = await createTasksInColumns(codespace.id, {
      backlog: 3,
      queued: 2,
      in_progress: 1,
      waiting_approval: 2,
      verified: 4,
    });

    // Verify per-column counts
    expect(columnTasks.backlog).toHaveLength(3);
    expect(columnTasks.queued).toHaveLength(2);
    expect(columnTasks.in_progress).toHaveLength(1);
    expect(columnTasks.waiting_approval).toHaveLength(2);
    expect(columnTasks.verified).toHaveLength(4);

    // Verify DB-level counts match
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    expect(allTasks).toHaveLength(12);

    const counts = { backlog: 0, queued: 0, in_progress: 0, waiting_approval: 0, verified: 0 };
    for (const t of allTasks) {
      counts[t.column as keyof typeof counts] += 1;
    }
    expect(counts.backlog).toBe(3);
    expect(counts.queued).toBe(2);
    expect(counts.in_progress).toBe(1);
    expect(counts.waiting_approval).toBe(2);
    expect(counts.verified).toBe(4);
  });
});
