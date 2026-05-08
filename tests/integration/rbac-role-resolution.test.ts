import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaceMembers,
  folderMembers,
  teamMembers,
  teamProjectFolders,
  teams,
} from '../../src/db/schema';
import { users } from '../../src/db/schema/sqlite/users';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import {
  clearTestDatabase,
  closeTestDatabase,
  execRawSql,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

const USER_A = 'user-rbac-a';
const USER_B = 'user-rbac-b';
const USER_C = 'user-rbac-c';
const USER_D = 'user-rbac-d';
const USER_NONE = 'user-rbac-none';
const TEAM_1 = 'team-rbac-1';
const TEAM_2 = 'team-rbac-2';
const FOLDER_ID = 'folder-rbac-test';

async function seedRbacUsers(db: ReturnType<typeof getTestDb>): Promise<void> {
  for (const [userId, githubId, login] of [
    [USER_A, 10001, 'user-a'],
    [USER_B, 10002, 'user-b'],
    [USER_C, 10003, 'user-c'],
    [USER_D, 10004, 'user-d'],
    [USER_NONE, 10005, 'user-none'],
  ] as const) {
    await db.insert(users).values({
      id: userId,
      githubId,
      githubLogin: login,
      name: login,
    });
  }
}

describe('IT-004: RBAC Role Resolution Cascade', () => {
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;

  beforeAll(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  beforeEach(async () => {
    await clearTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db as any);
    await seedRbacUsers(db);

    // Create project folder
    execRawSql(
      `INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
       VALUES ('${FOLDER_ID}', 'RBAC Test Folder', 'rbac-test', 'Test folder', 'Folder', '#6B7280')`
    );

    // Create teams
    await db.insert(teams).values([
      { id: TEAM_1, name: 'Team Alpha', slug: 'team-alpha' },
      { id: TEAM_2, name: 'Team Beta', slug: 'team-beta' },
    ]);

    // Link both teams to the folder
    await db.insert(teamProjectFolders).values([
      { teamId: TEAM_1, projectFolderId: FOLDER_ID },
      { teamId: TEAM_2, projectFolderId: FOLDER_ID },
    ]);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('direct codespace_members role overrides team role', async () => {
    const codespace = await createTestProject({ projectFolderId: FOLDER_ID });

    // User A has viewer via team
    await db.insert(teamMembers).values({ teamId: TEAM_1, userId: USER_A, role: 'viewer' });

    // User A has admin via direct codespace membership
    await db
      .insert(codespaceMembers)
      .values({ codespaceId: codespace.id, userId: USER_A, role: 'admin' });

    const role = await rbacService.resolveUserRole(USER_A, codespace.id);
    expect(role).toBe('admin');
  });

  it('folder_members role resolves when no direct codespace override', async () => {
    const codespace = await createTestProject({ projectFolderId: FOLDER_ID });

    // User B has agent_operator via folder membership
    await db
      .insert(folderMembers)
      .values({ projectFolderId: FOLDER_ID, userId: USER_B, role: 'agent_operator' });

    const role = await rbacService.resolveUserRole(USER_B, codespace.id);
    expect(role).toBe('agent_operator');
  });

  it('resolves highest role when user is in two teams for same folder', async () => {
    const codespace = await createTestProject({ projectFolderId: FOLDER_ID });

    // User C is viewer in Team 1 and admin in Team 2
    await db.insert(teamMembers).values([
      { teamId: TEAM_1, userId: USER_C, role: 'viewer' },
      { teamId: TEAM_2, userId: USER_C, role: 'admin' },
    ]);

    const role = await rbacService.resolveUserRole(USER_C, codespace.id);
    expect(role).toBe('admin');
  });

  it('returns null for user with no membership at any level', async () => {
    const codespace = await createTestProject({ projectFolderId: FOLDER_ID });

    const role = await rbacService.resolveUserRole(USER_NONE, codespace.id);
    expect(role).toBeNull();
  });

  it('resolves to team role when user has ONLY team membership', async () => {
    const codespace = await createTestProject({ projectFolderId: FOLDER_ID });

    // User D is agent_operator only via team
    await db.insert(teamMembers).values({ teamId: TEAM_1, userId: USER_D, role: 'agent_operator' });

    const role = await rbacService.resolveUserRole(USER_D, codespace.id);
    expect(role).toBe('agent_operator');
  });
});
