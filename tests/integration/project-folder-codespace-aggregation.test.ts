import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamProjectFolders, teams } from '../../src/db/schema';
import { ProjectFolderService } from '../../src/services/project-folder.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Project Folder Codespace Aggregation', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: ProjectFolderService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new ProjectFolderService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-320: getSummary returns correct totalCodespaces count for folder with assigned codespaces', async () => {
    // Create a folder
    const folderResult = await service.create({
      name: 'Dev Folder',
      slug: 'dev-folder',
      description: 'Folder for dev codespaces',
    });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;
    const folder = folderResult.value;

    // Create codespaces assigned to this folder
    const _cs1 = await createTestProject({ projectFolderId: folder.id, name: 'CS 1' });
    const _cs2 = await createTestProject({ projectFolderId: folder.id, name: 'CS 2' });
    const _cs3 = await createTestProject({ projectFolderId: folder.id, name: 'CS 3' });

    // Create a codespace in a different folder (should not be counted)
    await createTestProject({ name: 'CS Other' });

    // Get summary
    const summaryResult = await service.getSummary(folder.id);
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    expect(summaryResult.value.totalCodespaces).toBe(3);
    expect(summaryResult.value.runningAgents).toBe(0);
    expect(summaryResult.value.totalTasks).toBe(0);
    expect(summaryResult.value.folder.id).toBe(folder.id);
  });

  it('IT-321: getSummary includes runningAgents count for folder with active agents', async () => {
    // Create a folder
    const folderResult = await service.create({
      name: 'Agent Folder',
      slug: 'agent-folder',
    });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;
    const folder = folderResult.value;

    // Create codespaces in the folder
    const cs1 = await createTestProject({ projectFolderId: folder.id, name: 'CS Agent 1' });
    const cs2 = await createTestProject({ projectFolderId: folder.id, name: 'CS Agent 2' });

    // Create running agents in cs1
    await createTestAgent(cs1.id, { status: 'running' });
    await createTestAgent(cs1.id, { status: 'planning' });

    // Create a starting agent in cs2
    await createTestAgent(cs2.id, { status: 'starting' });

    // Create idle and completed agents (should NOT count)
    await createTestAgent(cs1.id, { status: 'idle' });
    await createTestAgent(cs2.id, { status: 'completed' });

    // Get summary
    const summaryResult = await service.getSummary(folder.id);
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    // running + planning + starting = 3 active agents
    expect(summaryResult.value.runningAgents).toBe(3);
    expect(summaryResult.value.totalCodespaces).toBe(2);
  });

  it('IT-322: delete folder fails when codespaces exist, codespaces survive independently', async () => {
    // Create a folder
    const folderResult = await service.create({
      name: 'Delete Test Folder',
      slug: 'delete-test-folder',
    });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;
    const folder = folderResult.value;

    // Create codespaces assigned to this folder
    const _cs1 = await createTestProject({ projectFolderId: folder.id, name: 'CS Delete 1' });
    const _cs2 = await createTestProject({ projectFolderId: folder.id, name: 'CS Delete 2' });

    // Attempt to delete folder — should fail because it has codespaces
    const deleteResult = await service.delete(folder.id);
    expect(deleteResult.ok).toBe(false);
    if (deleteResult.ok) return;
    expect(deleteResult.error.code).toBe('PROJECT_FOLDER_HAS_CODESPACES');

    // Folder still exists
    const getResult = await service.getById(folder.id);
    expect(getResult.ok).toBe(true);

    // Codespaces still exist
    const existingCodespaces = await (db as any).query.codespaces.findMany({
      where: (cs: any, { eq }: any) => eq(cs.projectFolderId, folder.id),
    });
    expect(existingCodespaces).toHaveLength(2);
  });

  it('IT-323: slug uniqueness enforced — second folder with same slug returns SLUG_EXISTS', async () => {
    // Create the first folder
    const firstResult = await service.create({
      name: 'Unique Folder',
      slug: 'unique-slug',
    });
    expect(firstResult.ok).toBe(true);

    // Attempt to create a second folder with the same slug
    const secondResult = await service.create({
      name: 'Duplicate Folder',
      slug: 'unique-slug',
    });
    expect(secondResult.ok).toBe(false);
    if (secondResult.ok) return;
    expect(secondResult.error.code).toBe('PROJECT_FOLDER_SLUG_EXISTS');
  });

  it('IT-324: team-folder association — list by teamId returns only that team folders', async () => {
    // Create two folders
    const folder1Result = await service.create({
      name: 'Team A Folder',
      slug: 'team-a-folder',
    });
    expect(folder1Result.ok).toBe(true);
    if (!folder1Result.ok) return;

    const folder2Result = await service.create({
      name: 'Team B Folder',
      slug: 'team-b-folder',
    });
    expect(folder2Result.ok).toBe(true);
    if (!folder2Result.ok) return;

    const folder3Result = await service.create({
      name: 'Unlinked Folder',
      slug: 'unlinked-folder',
    });
    expect(folder3Result.ok).toBe(true);
    if (!folder3Result.ok) return;

    // Create teams directly in DB
    const teamAId = createId();
    const teamBId = createId();
    await (db as any).insert(teams).values({
      id: teamAId,
      name: 'Team A',
      slug: `team-a-${teamAId.slice(0, 6)}`,
    });
    await (db as any).insert(teams).values({
      id: teamBId,
      name: 'Team B',
      slug: `team-b-${teamBId.slice(0, 6)}`,
    });

    // Link folder1 to team A, folder2 to team B
    await (db as any).insert(teamProjectFolders).values({
      teamId: teamAId,
      projectFolderId: folder1Result.value.id,
    });
    await (db as any).insert(teamProjectFolders).values({
      teamId: teamBId,
      projectFolderId: folder2Result.value.id,
    });

    // List by team A — should return only folder1
    const teamAList = await service.list({ teamId: teamAId });
    expect(teamAList.ok).toBe(true);
    if (!teamAList.ok) return;
    expect(teamAList.value.items).toHaveLength(1);
    expect(teamAList.value.items[0].id).toBe(folder1Result.value.id);

    // List by team B — should return only folder2
    const teamBList = await service.list({ teamId: teamBId });
    expect(teamBList.ok).toBe(true);
    if (!teamBList.ok) return;
    expect(teamBList.value.items).toHaveLength(1);
    expect(teamBList.value.items[0].id).toBe(folder2Result.value.id);

    // List without team filter — should return all folders (plus the default-folder from setup)
    const allList = await service.list();
    expect(allList.ok).toBe(true);
    if (!allList.ok) return;
    // At least our 3 folders + the default-folder from clearTestDatabase re-seed
    expect(allList.value.items.length).toBeGreaterThanOrEqual(3);
  });

  it('IT-325: folder summary with tasks across multiple codespaces — totalTasks is sum of all', async () => {
    // Create a folder
    const folderResult = await service.create({
      name: 'Tasks Folder',
      slug: 'tasks-folder',
    });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;
    const folder = folderResult.value;

    // Create codespaces in the folder
    const cs1 = await createTestProject({ projectFolderId: folder.id, name: 'CS Tasks 1' });
    const cs2 = await createTestProject({ projectFolderId: folder.id, name: 'CS Tasks 2' });
    const cs3 = await createTestProject({ projectFolderId: folder.id, name: 'CS Tasks 3' });

    // Create tasks in each codespace
    await createTestTask(cs1.id, { title: 'Task 1A', column: 'backlog' });
    await createTestTask(cs1.id, { title: 'Task 1B', column: 'in_progress' });
    await createTestTask(cs1.id, { title: 'Task 1C', column: 'verified' });

    await createTestTask(cs2.id, { title: 'Task 2A', column: 'backlog' });
    await createTestTask(cs2.id, { title: 'Task 2B', column: 'waiting_approval' });

    await createTestTask(cs3.id, { title: 'Task 3A', column: 'in_progress' });

    // Create a codespace outside the folder with tasks (should not be counted)
    const csOutside = await createTestProject({ name: 'CS Outside' });
    await createTestTask(csOutside.id, { title: 'Outside Task' });

    // Get summary
    const summaryResult = await service.getSummary(folder.id);
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    // 3 + 2 + 1 = 6 tasks total across the 3 codespaces in the folder
    expect(summaryResult.value.totalTasks).toBe(6);
    expect(summaryResult.value.totalCodespaces).toBe(3);
    expect(summaryResult.value.folder.id).toBe(folder.id);
  });

  it('IT-325b: getSummary on non-existent folder returns error', async () => {
    const result = await service.getSummary('nonexistent-folder-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROJECT_FOLDER_NOT_FOUND');
  });

  it('IT-325c: empty folder summary returns zero counts', async () => {
    const folderResult = await service.create({
      name: 'Empty Folder',
      slug: 'empty-folder',
    });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;

    const summaryResult = await service.getSummary(folderResult.value.id);
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    expect(summaryResult.value.totalCodespaces).toBe(0);
    expect(summaryResult.value.runningAgents).toBe(0);
    expect(summaryResult.value.totalTasks).toBe(0);
  });
});
