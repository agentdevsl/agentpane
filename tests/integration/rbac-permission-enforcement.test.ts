import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaceMembers,
  folderMembers,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import type { RbacRole } from '../../src/db/schema/shared/enums';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('RBAC Permission Enforcement (IT-012)', () => {
  let rbacService: RbacService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    rbacService = new RbacService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
    execRawSql('DELETE FROM users');
  });

  describe('canPerformAction', () => {
    it('viewer can read codespaces', () => {
      expect(rbacService.canPerformAction('viewer', 'codespace:read')).toBe(true);
    });

    it('viewer cannot create tasks', () => {
      expect(rbacService.canPerformAction('viewer', 'task:create')).toBe(false);
    });

    it('agent_operator can create tasks', () => {
      expect(rbacService.canPerformAction('agent_operator', 'task:create')).toBe(true);
    });

    it('agent_operator cannot delete codespaces', () => {
      expect(rbacService.canPerformAction('agent_operator', 'codespace:delete')).toBe(false);
    });

    it('admin can delete codespaces', () => {
      expect(rbacService.canPerformAction('admin', 'codespace:delete')).toBe(true);
    });

    it('admin cannot delete teams', () => {
      expect(rbacService.canPerformAction('admin', 'team:delete')).toBe(false);
    });

    it('owner can delete teams', () => {
      expect(rbacService.canPerformAction('owner', 'team:delete')).toBe(true);
    });

    it('owner can perform all actions', () => {
      const allActions = [
        'codespace:read',
        'task:create',
        'codespace:delete',
        'team:delete',
        'agent:start',
        'settings:update',
        'team:transfer_owner',
      ];
      for (const action of allActions) {
        expect(rbacService.canPerformAction('owner', action)).toBe(true);
      }
    });

    it('unknown action returns false', () => {
      expect(rbacService.canPerformAction('owner', 'nonexistent:action')).toBe(false);
    });
  });

  describe('hasMinimumRole', () => {
    it('admin meets agent_operator minimum', () => {
      expect(rbacService.hasMinimumRole('admin', 'agent_operator')).toBe(true);
    });

    it('viewer does not meet admin minimum', () => {
      expect(rbacService.hasMinimumRole('viewer', 'admin')).toBe(false);
    });

    it('owner meets owner minimum', () => {
      expect(rbacService.hasMinimumRole('owner', 'owner')).toBe(true);
    });

    it('agent_operator does not meet admin minimum', () => {
      expect(rbacService.hasMinimumRole('agent_operator', 'admin')).toBe(false);
    });

    it('every role meets viewer minimum', () => {
      const roles: RbacRole[] = ['viewer', 'agent_operator', 'admin', 'owner'];
      for (const role of roles) {
        expect(rbacService.hasMinimumRole(role, 'viewer')).toBe(true);
      }
    });
  });

  describe('applyTokenCeiling', () => {
    it('token ceiling caps admin to agent_operator', () => {
      expect(rbacService.applyTokenCeiling('admin', 'agent_operator')).toBe('agent_operator');
    });

    it('token ceiling does not elevate viewer', () => {
      expect(rbacService.applyTokenCeiling('viewer', 'owner')).toBe('viewer');
    });

    it('equal roles return the same role', () => {
      expect(rbacService.applyTokenCeiling('admin', 'admin')).toBe('admin');
    });

    it('owner membership capped by admin token', () => {
      expect(rbacService.applyTokenCeiling('owner', 'admin')).toBe('admin');
    });
  });

  describe('checkTagAccess', () => {
    it('null token tags allow all access', () => {
      expect(rbacService.checkTagAccess(null, ['frontend', 'api'])).toBe(true);
    });

    it('empty token tags allow all access', () => {
      expect(rbacService.checkTagAccess([], ['frontend'])).toBe(true);
    });

    it('matching tags grant access', () => {
      expect(rbacService.checkTagAccess(['frontend', 'api'], ['frontend'])).toBe(true);
    });

    it('non-overlapping tags deny access', () => {
      expect(rbacService.checkTagAccess(['frontend'], ['backend'])).toBe(false);
    });

    it('tag-restricted token denied when resource has no tags', () => {
      expect(rbacService.checkTagAccess(['frontend'], [])).toBe(false);
    });
  });

  describe('checkCodespaceScope', () => {
    it('null token codespace allows all', () => {
      expect(rbacService.checkCodespaceScope(null, 'any-codespace')).toBe(true);
    });

    it('matching codespace allows access', () => {
      expect(rbacService.checkCodespaceScope('cs-1', 'cs-1')).toBe(true);
    });

    it('different codespace denies access', () => {
      expect(rbacService.checkCodespaceScope('cs-1', 'cs-2')).toBe(false);
    });
  });

  describe('resolveUserRole', () => {
    let githubIdCounter = 100;

    async function createUser(db: ReturnType<typeof getTestDb>, id: string) {
      githubIdCounter += 1;
      await db.insert(users).values({
        id,
        githubId: githubIdCounter,
        githubLogin: `user-${id}`,
      });
    }

    it('direct codespace member returns their role', async () => {
      const db = getTestDb();
      const project = await createTestProject();
      await createUser(db, 'user-1');

      await db.insert(codespaceMembers).values({
        codespaceId: project.id,
        userId: 'user-1',
        role: 'admin',
      });

      const role = await rbacService.resolveUserRole('user-1', project.id);
      expect(role).toBe('admin');
    });

    it('user with no membership returns null', async () => {
      const project = await createTestProject();

      const role = await rbacService.resolveUserRole('stranger', project.id);
      expect(role).toBeNull();
    });

    it('folder member inherits role for codespaces in that folder', async () => {
      const db = getTestDb();
      const project = await createTestProject({ projectFolderId: 'default-folder' });
      await createUser(db, 'folder-user');

      await db.insert(folderMembers).values({
        projectFolderId: 'default-folder',
        userId: 'folder-user',
        role: 'agent_operator',
      });

      const role = await rbacService.resolveUserRole('folder-user', project.id);
      expect(role).toBe('agent_operator');
    });

    it('team member inherits role via team-folder link', async () => {
      const db = getTestDb();
      const project = await createTestProject({ projectFolderId: 'default-folder' });
      await createUser(db, 'team-user');

      await db.insert(teams).values({
        id: 'team-1',
        name: 'Test Team',
        slug: 'test-team',
      });

      await db.insert(teamMembers).values({
        teamId: 'team-1',
        userId: 'team-user',
        role: 'admin',
      });

      await db.insert(teamProjectFolders).values({
        teamId: 'team-1',
        projectFolderId: 'default-folder',
      });

      const role = await rbacService.resolveUserRole('team-user', project.id);
      expect(role).toBe('admin');
    });

    it('direct membership takes precedence over folder membership', async () => {
      const db = getTestDb();
      const project = await createTestProject({ projectFolderId: 'default-folder' });
      await createUser(db, 'dual-user');

      await db.insert(codespaceMembers).values({
        codespaceId: project.id,
        userId: 'dual-user',
        role: 'viewer',
      });

      await db.insert(folderMembers).values({
        projectFolderId: 'default-folder',
        userId: 'dual-user',
        role: 'admin',
      });

      const role = await rbacService.resolveUserRole('dual-user', project.id);
      expect(role).toBe('viewer');
    });
  });
});
