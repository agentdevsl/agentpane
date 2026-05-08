/**
 * Integration tests for rbac.service.ts (slice H).
 *
 * Targets uncovered lines: invalid-role short-circuits in folder/codespace
 * members, resolveUserFolderRole, resolveTeamRole, resolveGlobalRole, and
 * the various permission/scope helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaceMembers, folderMembers, teamMembers } from '../../src/db/schema';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTeam, createTestTeamMember } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('RbacService paths (IT-1910)', () => {
  let db: ReturnType<typeof getTestDb>;
  let rbac: RbacService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbac = new RbacService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── resolveUserRole — invalid role in codespace_members ────

  it('IT-1910-1: resolveUserRole returns null when codespace_members has invalid role', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    await db
      .insert(codespaceMembers)
      .values({ codespaceId: cs.id, userId: user.id, role: 'BAD_ROLE' as never });

    const role = await rbac.resolveUserRole(user.id, cs.id);
    expect(role).toBeNull();
  });

  // ─── resolveUserRole — folder-level fallback ────

  it('IT-1910-2: resolveUserRole returns folder-level role when no direct codespace member', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    await db.insert(folderMembers).values({
      projectFolderId: cs.projectFolderId!,
      userId: user.id,
      role: 'admin',
    });

    const role = await rbac.resolveUserRole(user.id, cs.id);
    expect(role).toBe('admin');
  });

  it('IT-1910-3: resolveUserRole returns null when folder_members role is invalid', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    await db.insert(folderMembers).values({
      projectFolderId: cs.projectFolderId!,
      userId: user.id,
      role: 'INVALID' as never,
    });

    const role = await rbac.resolveUserRole(user.id, cs.id);
    expect(role).toBeNull();
  });

  // ─── resolveUserRole — codespace not found ────

  it('IT-1910-4: resolveUserRole returns null when codespace does not exist', async () => {
    const user = await createTestUser();
    const role = await rbac.resolveUserRole(user.id, 'no-such-codespace');
    expect(role).toBeNull();
  });

  // ─── resolveUserFolderRole ─────────────────────

  it('IT-1910-5: resolveUserFolderRole returns direct folder member role', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    await db.insert(folderMembers).values({
      projectFolderId: cs.projectFolderId!,
      userId: user.id,
      role: 'agent_operator',
    });

    const role = await rbac.resolveUserFolderRole(user.id, cs.projectFolderId!);
    expect(role).toBe('agent_operator');
  });

  it('IT-1910-6: resolveUserFolderRole returns null on invalid direct role', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    await db.insert(folderMembers).values({
      projectFolderId: cs.projectFolderId!,
      userId: user.id,
      role: 'GARBAGE' as never,
    });

    const role = await rbac.resolveUserFolderRole(user.id, cs.projectFolderId!);
    expect(role).toBeNull();
  });

  it('IT-1910-7: resolveUserFolderRole returns null when neither member nor team', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const role = await rbac.resolveUserFolderRole(user.id, cs.projectFolderId!);
    expect(role).toBeNull();
  });

  // ─── resolveTeamRole — invalid role ────────────

  it('IT-1910-8: resolveTeamRole returns null when membership role is invalid', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: user.id, role: 'NOT_REAL' as never });

    const role = await rbac.resolveTeamRole(user.id, team.id);
    expect(role).toBeNull();
  });

  it('IT-1910-9: resolveTeamRole returns null when no membership exists', async () => {
    const role = await rbac.resolveTeamRole('ghost-user', 'no-team');
    expect(role).toBeNull();
  });

  it('IT-1910-10: resolveTeamRole returns valid role', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'admin' });
    const role = await rbac.resolveTeamRole(user.id, team.id);
    expect(role).toBe('admin');
  });

  // ─── resolveGlobalRole ─────────────────────────

  it('IT-1910-11: resolveGlobalRole returns highest role across teams', async () => {
    const user = await createTestUser();
    const team1 = await createTestTeam();
    const team2 = await createTestTeam();
    await createTestTeamMember(team1.id, user.id, { role: 'viewer' });
    await createTestTeamMember(team2.id, user.id, { role: 'admin' });

    const role = await rbac.resolveGlobalRole(user.id);
    expect(role).toBe('admin');
  });

  it('IT-1910-12: resolveGlobalRole returns null when user has no teams', async () => {
    const user = await createTestUser();
    const role = await rbac.resolveGlobalRole(user.id);
    expect(role).toBeNull();
  });

  // ─── canPerformAction ──────────────────────────

  it('IT-1910-13: canPerformAction returns true for known action when role sufficient', () => {
    expect(rbac.canPerformAction('admin', 'codespace:create')).toBe(true);
    expect(rbac.canPerformAction('owner', 'team:delete')).toBe(true);
    expect(rbac.canPerformAction('viewer', 'codespace:read')).toBe(true);
  });

  it('IT-1910-14: canPerformAction returns false when role insufficient', () => {
    expect(rbac.canPerformAction('viewer', 'codespace:create')).toBe(false);
    expect(rbac.canPerformAction('admin', 'team:delete')).toBe(false);
  });

  it('IT-1910-15: canPerformAction returns false for unknown action', () => {
    expect(rbac.canPerformAction('owner', 'made-up-action')).toBe(false);
  });

  // ─── checkTagAccess ────────────────────────────

  it('IT-1910-16: checkTagAccess allows when token has no tag restriction', () => {
    expect(rbac.checkTagAccess(null, ['x'])).toBe(true);
    expect(rbac.checkTagAccess([], ['x'])).toBe(true);
  });

  it('IT-1910-17: checkTagAccess denies when resource has no tags', () => {
    expect(rbac.checkTagAccess(['t'], [])).toBe(false);
  });

  it('IT-1910-18: checkTagAccess returns true on overlap', () => {
    expect(rbac.checkTagAccess(['a', 'b'], ['b', 'c'])).toBe(true);
  });

  it('IT-1910-19: checkTagAccess returns false when no overlap', () => {
    expect(rbac.checkTagAccess(['x'], ['y'])).toBe(false);
  });

  // ─── checkCodespaceScope ───────────────────────

  it('IT-1910-20: checkCodespaceScope allows when token has no scope', () => {
    expect(rbac.checkCodespaceScope(null, 'cs-1')).toBe(true);
  });

  it('IT-1910-21: checkCodespaceScope denies on mismatch', () => {
    expect(rbac.checkCodespaceScope('cs-a', 'cs-b')).toBe(false);
  });

  it('IT-1910-22: checkCodespaceScope allows on match', () => {
    expect(rbac.checkCodespaceScope('cs-a', 'cs-a')).toBe(true);
  });

  // ─── applyTokenCeiling ─────────────────────────

  it('IT-1910-23: applyTokenCeiling returns lower of membership/token role', () => {
    expect(rbac.applyTokenCeiling('owner', 'viewer')).toBe('viewer');
    expect(rbac.applyTokenCeiling('viewer', 'owner')).toBe('viewer');
    expect(rbac.applyTokenCeiling('admin', 'admin')).toBe('admin');
  });

  // ─── hasMinimumRole ────────────────────────────

  it('IT-1910-24: hasMinimumRole works for all level comparisons', () => {
    expect(rbac.hasMinimumRole('owner', 'viewer')).toBe(true);
    expect(rbac.hasMinimumRole('viewer', 'owner')).toBe(false);
    expect(rbac.hasMinimumRole('admin', 'agent_operator')).toBe(true);
    expect(rbac.hasMinimumRole('viewer', 'viewer')).toBe(true);
  });
});
