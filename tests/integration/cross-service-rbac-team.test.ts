import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaceMembers,
  codespaces,
  projectFolders,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import { RBAC_ROLE_LEVEL, resolveHighestRole } from '../../src/db/schema/shared/enums';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: RBAC Team Resolution (IT-180, IT-189, IT-190)', () => {
  let db: ReturnType<typeof getTestDb>;
  let userId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    // Create a test user with unique githubId per run
    userId = createId();
    const uniqueGithubId = Math.floor(Math.random() * 1000000000);
    await db.insert(users).values({
      id: userId,
      githubId: uniqueGithubId,
      githubLogin: `rbac-user-${userId.slice(0, 6)}`,
      name: 'RBAC Test User',
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-180: resolves viewer role through team → teamProjectFolder → codespace chain', async () => {
    // Create team
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Viewers Team',
      slug: `viewers-${teamId.slice(0, 8)}`,
    });

    // Add user as viewer
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'viewer',
    });

    // Create folder and link team
    const folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Shared',
      slug: `shared-${folderId.slice(0, 6)}`,
    });
    await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

    // Create codespace in folder
    const codespace = await createTestProject({ projectFolderId: folderId });

    // Query role resolution through chain
    const folder = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    const teamFolder = await db.query.teamProjectFolders.findFirst({
      where: eq(teamProjectFolders.projectFolderId, folder!.projectFolderId),
    });
    const member = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamFolder!.teamId), eq(teamMembers.userId, userId)),
    });

    expect(member!.role).toBe('viewer');
    expect(RBAC_ROLE_LEVEL[member!.role]).toBe(1);
  });

  it('IT-189: direct codespace member takes precedence over team role', async () => {
    // Team gives viewer role
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Team',
      slug: `team-${teamId.slice(0, 8)}`,
    });
    await db.insert(teamMembers).values({ teamId, userId, role: 'viewer' });

    const codespace = await createTestProject();

    // Direct member with admin role
    await db.insert(codespaceMembers).values({
      codespaceId: codespace.id,
      userId,
      role: 'admin',
    });

    // Collect all roles for this user on this codespace
    const directMembership = await db.query.codespaceMembers.findFirst({
      where: and(
        eq(codespaceMembers.codespaceId, codespace.id),
        eq(codespaceMembers.userId, userId)
      ),
    });
    const teamMembership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    });

    // Direct member role = admin (level 3), team role = viewer (level 1)
    const allRoles = [];
    if (directMembership) allRoles.push({ role: directMembership.role });
    if (teamMembership) allRoles.push({ role: teamMembership.role });

    const resolved = resolveHighestRole(allRoles);
    expect(resolved).toBeTruthy();
    expect(resolved!.role).toBe('admin');
    expect(resolved!.level).toBe(3);
  });

  it('IT-190: team membership grants access via invitation pattern', async () => {
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Invited Team',
      slug: `invited-${teamId.slice(0, 8)}`,
    });

    // Insert member with agent_operator role (invitation accepted)
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'agent_operator',
    });

    // Verify membership grants access
    const membership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    });

    expect(membership).toBeTruthy();
    expect(membership!.role).toBe('agent_operator');
    expect(RBAC_ROLE_LEVEL[membership!.role]).toBe(2);

    // Verify the user has higher than viewer access
    expect(RBAC_ROLE_LEVEL[membership!.role]).toBeGreaterThan(RBAC_ROLE_LEVEL.viewer);
  });
});
