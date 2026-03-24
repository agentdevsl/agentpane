import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaces,
  projectFolders,
  settings,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Settings & RBAC (IT-178 to IT-179)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clean settings table between tests
    await db.delete(settings);
  });

  afterEach(async () => {
    await db.delete(settings);
    await clearTestDatabase();
  });

  it('IT-178: insert, query, update settings by key', async () => {
    // Insert sandbox settings
    await db.insert(settings).values({
      key: 'sandbox.mode',
      value: JSON.stringify('shared'),
    });
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, provider: 'docker' }),
    });

    // Query by key
    const modeSetting = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.mode'),
    });
    expect(modeSetting).toBeTruthy();
    expect(JSON.parse(modeSetting!.value)).toBe('shared');

    // Update
    await db
      .update(settings)
      .set({ value: JSON.stringify('per-project') })
      .where(eq(settings.key, 'sandbox.mode'));

    const updated = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.mode'),
    });
    expect(JSON.parse(updated!.value)).toBe('per-project');
  });

  it('IT-179: resolves role through full team → folder → codespace chain', async () => {
    // Create user with unique githubId
    const userId = createId();
    const uniqueGithubId = Math.floor(Math.random() * 1000000000);
    await db.insert(users).values({
      id: userId,
      githubId: uniqueGithubId,
      githubLogin: `testuser-${userId.slice(0, 6)}`,
      name: 'Test User',
    });

    // Create team
    const teamId = createId();
    const teamSlug = `team-${teamId.slice(0, 8)}`;
    await db.insert(teams).values({
      id: teamId,
      name: 'Engineering Team',
      slug: teamSlug,
    });

    // Add user to team as admin
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'admin',
    });

    // Create project folder
    const folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Eng Folder',
      slug: `eng-${folderId.slice(0, 6)}`,
    });

    // Assign team to folder
    await db.insert(teamProjectFolders).values({
      teamId,
      projectFolderId: folderId,
    });

    // Create codespace in folder
    const codespace = await createTestProject({
      projectFolderId: folderId,
      name: 'Service',
    });

    // Resolve role through chain: codespace → folder → team_project_folders → team_members
    const teamFolderLink = await db.query.teamProjectFolders.findFirst({
      where: eq(teamProjectFolders.projectFolderId, folderId),
    });
    expect(teamFolderLink).toBeTruthy();
    expect(teamFolderLink!.teamId).toBe(teamId);

    const membership = await db.query.teamMembers.findFirst({
      where: eq(teamMembers.teamId, teamId),
    });
    expect(membership).toBeTruthy();
    expect(membership!.role).toBe('admin');
    expect(membership!.userId).toBe(userId);

    // Verify codespace is in the correct folder
    const retrievedCodespace = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(retrievedCodespace!.projectFolderId).toBe(folderId);
  });
});
