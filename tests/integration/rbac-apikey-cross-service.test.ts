import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamMembers, teamProjectFolders, teams } from '../../src/db/schema';
import { RbacService } from '../../src/services/rbac.service';
import { RbacTokenService } from '../../src/services/rbac-token.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

const USER_ID = `user-token-${createId().slice(0, 8)}`;
const TEAM_ID = `team-token-${createId().slice(0, 8)}`;
const FOLDER_ID = `folder-token-${createId().slice(0, 8)}`;
const GITHUB_ID = 99001;

describe('RBAC API Key Cross-Service Tests', () => {
  let db: ReturnType<typeof getTestDb>;
  let tokenService: RbacTokenService;
  let rbacService: RbacService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await clearTestDatabase();

    tokenService = new RbacTokenService(db as any);
    rbacService = new RbacService(db as any);

    // Insert test user (use raw SQL with OR IGNORE for idempotency)
    execRawSql(
      `INSERT OR IGNORE INTO users (id, github_id, github_login, name, created_at, updated_at)
       VALUES ('${USER_ID}', ${GITHUB_ID}, 'test-user', 'Test', datetime('now'), datetime('now'))`
    );

    // Create project folder
    execRawSql(
      `INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
       VALUES ('${FOLDER_ID}', 'Token Test Folder', 'token-test', 'Test folder', 'Folder', '#6B7280')`
    );

    // Create team
    await db.insert(teams).values({
      id: TEAM_ID,
      name: 'Token Test Team',
      slug: `token-test-team-${createId().slice(0, 6)}`,
    });

    // Add user as admin team member
    await db.insert(teamMembers).values({
      userId: USER_ID,
      teamId: TEAM_ID,
      role: 'admin',
    });

    // Link team to folder
    await db.insert(teamProjectFolders).values({
      teamId: TEAM_ID,
      projectFolderId: FOLDER_ID,
    });

    // Create codespace in the folder
    const project = await createTestProject({
      projectFolderId: FOLDER_ID,
    });
    codespaceId = project.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
    // Clean up user since clearTestDatabase does not delete users
    try {
      execRawSql(`DELETE FROM users WHERE id = '${USER_ID}'`);
    } catch {
      // safe to ignore
    }
  });

  it('IT-366: Create API token with admin role → resolveToken returns token with admin role', async () => {
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'admin-token',
      role: 'admin',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rawToken = result.value.token;
    expect(rawToken).toMatch(/^ap_/);

    const resolved = await tokenService.resolveToken(rawToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.role).toBe('admin');
    expect(resolved!.userId).toBe(USER_ID);
    expect(resolved!.teamId).toBe(TEAM_ID);
    expect(resolved!.status).toBe('active');
  });

  it('IT-367: Token with scopeCodespaceId → resolveToken includes scopeCodespaceId', async () => {
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'scoped-codespace-token',
      role: 'admin',
      scopeCodespaceId: codespaceId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = await tokenService.resolveToken(result.value.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.scopeCodespaceId).toBe(codespaceId);
  });

  it('IT-368: Token with scopeTags → resolveToken includes scopeTags array', async () => {
    const scopeTags = ['tag-a', 'tag-b', 'tag-c'];

    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'scoped-tags-token',
      role: 'viewer',
      scopeTags,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = await tokenService.resolveToken(result.value.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.scopeTags).toEqual(scopeTags);
  });

  it('IT-369: Expired token → resolveToken returns null', async () => {
    // Create a token with expiresInDays: -1 (already expired)
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'expired-token',
      role: 'admin',
      expiresInDays: -1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = await tokenService.resolveToken(result.value.token);
    expect(resolved).toBeNull();
  });

  it('IT-370: Revoked token → revoke succeeds, then resolveToken returns null', async () => {
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'revokable-token',
      role: 'admin',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rawToken = result.value.token;
    const tokenId = result.value.id;

    // Verify token resolves before revocation
    const beforeRevoke = await tokenService.resolveToken(rawToken);
    expect(beforeRevoke).not.toBeNull();

    // Revoke the token
    const revokeResult = await tokenService.revoke(tokenId, USER_ID);
    expect(revokeResult.ok).toBe(true);

    // Verify token no longer resolves
    const afterRevoke = await tokenService.resolveToken(rawToken);
    expect(afterRevoke).toBeNull();
  });

  it('IT-371: Token role ceiling — viewer cannot task:create but can task:read', async () => {
    // Set up a separate user with viewer role on the team
    const viewerUserId = `user-viewer-${createId().slice(0, 8)}`;
    execRawSql(
      `INSERT OR IGNORE INTO users (id, github_id, github_login, name, created_at, updated_at)
       VALUES ('${viewerUserId}', 99002, 'viewer-user', 'Viewer', datetime('now'), datetime('now'))`
    );

    // Add user as viewer team member
    await db.insert(teamMembers).values({
      userId: viewerUserId,
      teamId: TEAM_ID,
      role: 'viewer',
    });

    // Resolve the user's role on the codespace (via team membership -> folder -> codespace)
    const role = await rbacService.resolveUserRole(viewerUserId, codespaceId);
    expect(role).toBe('viewer');

    // Viewer should NOT be able to task:create (requires agent_operator)
    const canCreate = rbacService.canPerformAction(role!, 'task:create');
    expect(canCreate).toBe(false);

    // Viewer should be able to task:read (requires viewer)
    const canRead = rbacService.canPerformAction(role!, 'task:read');
    expect(canRead).toBe(true);

    // Clean up viewer user
    try {
      execRawSql(`DELETE FROM users WHERE id = '${viewerUserId}'`);
    } catch {
      // safe to ignore
    }
  });

  it('IT-372: Max tokens per user limit (25) — 26th creation returns LIMIT_EXCEEDED', async () => {
    // Insert 25 active tokens directly via raw SQL to avoid transaction monkey-patch issues
    for (let i = 0; i < 25; i++) {
      const tokenId = createId();
      const fakeHash = `hash_limit_${i}_${createId().slice(0, 16)}`;
      execRawSql(
        `INSERT INTO api_tokens (id, user_id, team_id, name, token_hash, token_prefix, role, status, created_at)
         VALUES ('${tokenId}', '${USER_ID}', '${TEAM_ID}', 'limit-token-${i}', '${fakeHash}', 'ap_fake_${i}', 'viewer', 'active', datetime('now'))`
      );
    }

    // 26th token should fail with LIMIT_EXCEEDED
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'token-overflow',
      role: 'viewer',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('IT-373: Token resolves correctly after creation — verify resolve returns valid record', async () => {
    const result = await tokenService.create({
      userId: USER_ID,
      teamId: TEAM_ID,
      name: 'usage-token',
      role: 'agent_operator',
      scopeCodespaceId: codespaceId,
      scopeTags: ['deploy'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Resolve the token
    const resolved = await tokenService.resolveToken(result.value.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(result.value.id);
    expect(resolved!.userId).toBe(USER_ID);
    expect(resolved!.teamId).toBe(TEAM_ID);
    expect(resolved!.role).toBe('agent_operator');
    expect(resolved!.scopeCodespaceId).toBe(codespaceId);
    expect(resolved!.scopeTags).toEqual(['deploy']);
    expect(resolved!.status).toBe('active');

    // Resolve again to verify it still works (no side-effect invalidation)
    const resolvedAgain = await tokenService.resolveToken(result.value.token);
    expect(resolvedAgain).not.toBeNull();
    expect(resolvedAgain!.id).toBe(result.value.id);
  });
});
