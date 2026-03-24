import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaces, teamProjectFolders, teams } from '../../src/db/schema';
import { ProjectFolderService } from '../../src/services/project-folder.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('ProjectFolderService Integration (IT-141 to IT-148)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: ProjectFolderService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new ProjectFolderService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-141: enforces unique slug constraint on project folders', async () => {
    const result1 = await service.create({
      name: 'Folder A',
      slug: 'folder-a',
    });
    expect(result1.ok).toBe(true);

    const result2 = await service.create({
      name: 'Folder A Duplicate',
      slug: 'folder-a',
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.code).toBe('PROJECT_FOLDER_SLUG_EXISTS');
    }
  });

  it('IT-142: applies default icon and color when not provided', async () => {
    const result = await service.create({
      name: 'No Icon Folder',
      slug: 'no-icon-folder',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.icon).toBe('Folder');
      expect(result.value.color).toBe('#6B7280');
    }
  });

  it('IT-143: lists all folders vs team-scoped folders', async () => {
    // Create two folders
    const folderA = await service.create({ name: 'Folder A', slug: 'folder-a' });
    const folderB = await service.create({ name: 'Folder B', slug: 'folder-b' });
    expect(folderA.ok).toBe(true);
    expect(folderB.ok).toBe(true);

    // Create a team
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: 'test-team',
    });

    // Link only folderA to the team
    if (folderA.ok) {
      await db.insert(teamProjectFolders).values({
        teamId,
        projectFolderId: folderA.value.id,
      });
    }

    // List all folders (should include default-folder + folderA + folderB)
    const allResult = await service.list();
    expect(allResult.ok).toBe(true);
    if (allResult.ok) {
      expect(allResult.value.total).toBeGreaterThanOrEqual(3);
    }

    // List folders for team (should only include folderA)
    const teamResult = await service.list({ teamId });
    expect(teamResult.ok).toBe(true);
    if (teamResult.ok) {
      expect(teamResult.value.total).toBe(1);
      expect(teamResult.value.items[0].slug).toBe('folder-a');
    }
  });

  it('IT-144: queries folders linked to a specific team via teamProjectFolders', async () => {
    const folderA = await service.create({ name: 'Team Folder A', slug: 'team-folder-a' });
    const folderB = await service.create({ name: 'Team Folder B', slug: 'team-folder-b' });
    expect(folderA.ok && folderB.ok).toBe(true);

    const teamId = createId();
    await db.insert(teams).values({ id: teamId, name: 'Team X', slug: 'team-x' });

    if (folderA.ok && folderB.ok) {
      await db.insert(teamProjectFolders).values([
        { teamId, projectFolderId: folderA.value.id },
        { teamId, projectFolderId: folderB.value.id },
      ]);
    }

    const result = await service.listByTeam(teamId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      const slugs = result.value.map((f) => f.slug);
      expect(slugs).toContain('team-folder-a');
      expect(slugs).toContain('team-folder-b');
    }
  });

  it('IT-145: update folder slug succeeds unless slug conflicts', async () => {
    const folderA = await service.create({ name: 'Folder A', slug: 'slug-a' });
    const _folderB = await service.create({ name: 'Folder B', slug: 'slug-b' });
    expect(folderA.ok).toBe(true);

    if (folderA.ok) {
      // Rename to a new unique slug
      const updateOk = await service.update(folderA.value.id, { slug: 'slug-a-renamed' });
      expect(updateOk.ok).toBe(true);
      if (updateOk.ok) {
        expect(updateOk.value.slug).toBe('slug-a-renamed');
      }

      // Try renaming to an existing slug
      const updateConflict = await service.update(folderA.value.id, { slug: 'slug-b' });
      expect(updateConflict.ok).toBe(false);
      if (!updateConflict.ok) {
        expect(updateConflict.error.code).toBe('PROJECT_FOLDER_SLUG_EXISTS');
      }
    }
  });

  it('IT-146: delete folder blocked when codespaces exist, succeeds after removal', async () => {
    const folderResult = await service.create({ name: 'Delete Me', slug: 'delete-me' });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;

    const folderId = folderResult.value.id;

    // Create a codespace in the folder
    const codespace = await createTestProject({ projectFolderId: folderId });

    // Attempt delete -> should fail because folder has codespaces
    const deleteBlocked = await service.delete(folderId);
    expect(deleteBlocked.ok).toBe(false);
    if (!deleteBlocked.ok) {
      expect(deleteBlocked.error.code).toBe('PROJECT_FOLDER_HAS_CODESPACES');
    }

    // Remove the codespace
    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Now delete should succeed
    const deleteOk = await service.delete(folderId);
    expect(deleteOk.ok).toBe(true);
  });

  it('IT-147: lists codespaces in folder ordered by updatedAt descending', async () => {
    const folderResult = await service.create({ name: 'With Codespaces', slug: 'with-codespaces' });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;

    const folderId = folderResult.value.id;

    // Create 3 codespaces with staggered updatedAt timestamps
    const c1 = await createTestProject({
      name: 'Codespace Oldest',
      projectFolderId: folderId,
    });
    const c2 = await createTestProject({
      name: 'Codespace Middle',
      projectFolderId: folderId,
    });
    const c3 = await createTestProject({
      name: 'Codespace Newest',
      projectFolderId: folderId,
    });

    // Manually set updatedAt to control ordering
    await db
      .update(codespaces)
      .set({ updatedAt: '2025-01-01T00:00:00Z' })
      .where(eq(codespaces.id, c1.id));
    await db
      .update(codespaces)
      .set({ updatedAt: '2025-06-01T00:00:00Z' })
      .where(eq(codespaces.id, c2.id));
    await db
      .update(codespaces)
      .set({ updatedAt: '2025-12-01T00:00:00Z' })
      .where(eq(codespaces.id, c3.id));

    const result = await service.listCodespaces(folderId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      // Ordered descending by updatedAt: newest first
      expect(result.value[0].name).toBe('Codespace Newest');
      expect(result.value[1].name).toBe('Codespace Middle');
      expect(result.value[2].name).toBe('Codespace Oldest');
    }
  });

  it('IT-148: getSummary counts codespaces, tasks, and running agents in folder', async () => {
    const folderResult = await service.create({ name: 'Summary Folder', slug: 'summary-folder' });
    expect(folderResult.ok).toBe(true);
    if (!folderResult.ok) return;

    const folderId = folderResult.value.id;

    // Create 2 codespaces in the folder
    const cs1 = await createTestProject({ name: 'CS1', projectFolderId: folderId });
    const cs2 = await createTestProject({ name: 'CS2', projectFolderId: folderId });

    // Create tasks across codespaces
    await createTestTask(cs1.id, { title: 'Task A' });
    await createTestTask(cs1.id, { title: 'Task B' });
    await createTestTask(cs2.id, { title: 'Task C' });

    // Create agents: 1 running, 1 planning, 1 idle (idle should not count as running)
    await createTestAgent(cs1.id, { status: 'running' });
    await createTestAgent(cs1.id, { status: 'planning' });
    await createTestAgent(cs2.id, { status: 'idle' });

    const summaryResult = await service.getSummary(folderId);
    expect(summaryResult.ok).toBe(true);
    if (summaryResult.ok) {
      expect(summaryResult.value.totalCodespaces).toBe(2);
      expect(summaryResult.value.totalTasks).toBe(3);
      // running + planning = 2 active agents
      expect(summaryResult.value.runningAgents).toBe(2);
    }
  });
});
