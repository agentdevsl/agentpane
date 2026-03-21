import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../../src/services/rbac.service';

// =============================================================================
// Mock database factory
// =============================================================================

function createMockDb() {
  return {
    query: {
      codespaceMembers: {
        findFirst: vi.fn(),
      },
      codespaces: {
        findFirst: vi.fn(),
      },
      folderMembers: {
        findFirst: vi.fn(),
      },
      teamMembers: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
  };
}

// Helper that builds a chainable query builder for select().from().innerJoin().where()
function buildSelectChain(resolvedValue: unknown) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
  };
  // Make each step return the chain so calls are fluent, resolving at .where()
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockResolvedValue(resolvedValue);
  return chain;
}

// Helper that builds a chainable select chain for select().from().where() (no join)
function buildSelectWhereChain(resolvedValue: unknown) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockResolvedValue(resolvedValue);
  return chain;
}

// =============================================================================
// RbacService Tests
// =============================================================================

describe('RbacService', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let service: RbacService;

  beforeEach(() => {
    mockDb = createMockDb();
    service = new RbacService(mockDb as never);
  });

  // ===========================================================================
  // resolveUserRole
  // ===========================================================================

  describe('resolveUserRole', () => {
    it('returns the direct codespace member role when a direct override exists', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue({ role: 'admin' });

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBe('admin');
      expect(mockDb.query.codespaceMembers.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns owner role when direct codespace member is owner', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue({ role: 'owner' });

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBe('owner');
    });

    it('returns viewer role when direct codespace member is viewer', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue({ role: 'viewer' });

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBe('viewer');
    });

    it('falls through to team membership when no direct codespace member exists', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue(undefined);
      mockDb.query.codespaces.findFirst.mockResolvedValue({ projectFolderId: 'folder-1' });
      mockDb.query.folderMembers.findFirst.mockResolvedValue(undefined);

      // Set up the select chain for the team join query
      const chain = buildSelectChain([{ role: 'agent_operator' }]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBe('agent_operator');
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('returns the highest role when user belongs to multiple teams linked to the codespace', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue(undefined);
      mockDb.query.codespaces.findFirst.mockResolvedValue({ projectFolderId: 'folder-1' });
      mockDb.query.folderMembers.findFirst.mockResolvedValue(undefined);

      const chain = buildSelectChain([
        { role: 'viewer' },
        { role: 'admin' },
        { role: 'agent_operator' },
      ]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBe('admin');
    });

    it('returns null when user has no direct membership and no team memberships', async () => {
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue(undefined);
      mockDb.query.codespaces.findFirst.mockResolvedValue({ projectFolderId: 'folder-1' });
      mockDb.query.folderMembers.findFirst.mockResolvedValue(undefined);

      const chain = buildSelectChain([]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      expect(role).toBeNull();
    });

    it('prefers direct codespace member role over higher team role', async () => {
      // Direct member is viewer but team would give admin - direct member wins
      mockDb.query.codespaceMembers.findFirst.mockResolvedValue({ role: 'viewer' });

      const role = await service.resolveUserRole('user-1', 'codespace-1');

      // select() should never be called since direct member found
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(role).toBe('viewer');
    });
  });

  // ===========================================================================
  // resolveTeamRole
  // ===========================================================================

  describe('resolveTeamRole', () => {
    it('returns the team role when the user is a member of the team', async () => {
      mockDb.query.teamMembers.findFirst.mockResolvedValue({ role: 'admin' });

      const role = await service.resolveTeamRole('user-1', 'team-1');

      expect(role).toBe('admin');
      expect(mockDb.query.teamMembers.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns null when the user is not a member of the team', async () => {
      mockDb.query.teamMembers.findFirst.mockResolvedValue(undefined);

      const role = await service.resolveTeamRole('user-1', 'team-1');

      expect(role).toBeNull();
    });

    it('returns owner role correctly from team membership', async () => {
      mockDb.query.teamMembers.findFirst.mockResolvedValue({ role: 'owner' });

      const role = await service.resolveTeamRole('user-owner', 'team-1');

      expect(role).toBe('owner');
    });
  });

  // ===========================================================================
  // resolveGlobalRole
  // ===========================================================================

  describe('resolveGlobalRole', () => {
    it('returns the highest role across all teams', async () => {
      const chain = buildSelectWhereChain([
        { role: 'viewer' },
        { role: 'admin' },
        { role: 'agent_operator' },
      ]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveGlobalRole('user-1');

      expect(role).toBe('admin');
    });

    it('returns owner when the user is an owner in at least one team', async () => {
      const chain = buildSelectWhereChain([
        { role: 'admin' },
        { role: 'owner' },
        { role: 'viewer' },
      ]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveGlobalRole('user-1');

      expect(role).toBe('owner');
    });

    it('returns the single role when the user belongs to one team', async () => {
      const chain = buildSelectWhereChain([{ role: 'agent_operator' }]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveGlobalRole('user-1');

      expect(role).toBe('agent_operator');
    });

    it('returns null when the user belongs to no teams', async () => {
      const chain = buildSelectWhereChain([]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const role = await service.resolveGlobalRole('user-1');

      expect(role).toBeNull();
    });
  });

  // ===========================================================================
  // hasMinimumRole
  // ===========================================================================

  describe('hasMinimumRole', () => {
    it('owner meets the minimum of owner', () => {
      expect(service.hasMinimumRole('owner', 'owner')).toBe(true);
    });

    it('owner meets the minimum of admin', () => {
      expect(service.hasMinimumRole('owner', 'admin')).toBe(true);
    });

    it('owner meets the minimum of agent_operator', () => {
      expect(service.hasMinimumRole('owner', 'agent_operator')).toBe(true);
    });

    it('owner meets the minimum of viewer', () => {
      expect(service.hasMinimumRole('owner', 'viewer')).toBe(true);
    });

    it('admin does not meet the minimum of owner', () => {
      expect(service.hasMinimumRole('admin', 'owner')).toBe(false);
    });

    it('admin meets the minimum of admin', () => {
      expect(service.hasMinimumRole('admin', 'admin')).toBe(true);
    });

    it('admin meets the minimum of agent_operator', () => {
      expect(service.hasMinimumRole('admin', 'agent_operator')).toBe(true);
    });

    it('admin meets the minimum of viewer', () => {
      expect(service.hasMinimumRole('admin', 'viewer')).toBe(true);
    });

    it('agent_operator does not meet the minimum of owner', () => {
      expect(service.hasMinimumRole('agent_operator', 'owner')).toBe(false);
    });

    it('agent_operator does not meet the minimum of admin', () => {
      expect(service.hasMinimumRole('agent_operator', 'admin')).toBe(false);
    });

    it('agent_operator meets the minimum of agent_operator', () => {
      expect(service.hasMinimumRole('agent_operator', 'agent_operator')).toBe(true);
    });

    it('agent_operator meets the minimum of viewer', () => {
      expect(service.hasMinimumRole('agent_operator', 'viewer')).toBe(true);
    });

    it('viewer does not meet the minimum of owner', () => {
      expect(service.hasMinimumRole('viewer', 'owner')).toBe(false);
    });

    it('viewer does not meet the minimum of admin', () => {
      expect(service.hasMinimumRole('viewer', 'admin')).toBe(false);
    });

    it('viewer does not meet the minimum of agent_operator', () => {
      expect(service.hasMinimumRole('viewer', 'agent_operator')).toBe(false);
    });

    it('viewer meets the minimum of viewer', () => {
      expect(service.hasMinimumRole('viewer', 'viewer')).toBe(true);
    });
  });

  // ===========================================================================
  // applyTokenCeiling
  // ===========================================================================

  describe('applyTokenCeiling', () => {
    it('returns membership role when membership is lower than token role', () => {
      // viewer(1) < admin(3) -> effective = viewer
      const effective = service.applyTokenCeiling('viewer', 'admin');
      expect(effective).toBe('viewer');
    });

    it('returns token role when token is lower than membership role', () => {
      // admin(3) > viewer(1) -> effective = viewer
      const effective = service.applyTokenCeiling('admin', 'viewer');
      expect(effective).toBe('viewer');
    });

    it('returns either role when membership and token roles are equal', () => {
      // admin(3) == admin(3) -> effective = admin (membership returned)
      const effective = service.applyTokenCeiling('admin', 'admin');
      expect(effective).toBe('admin');
    });

    it('caps owner membership to agent_operator token', () => {
      const effective = service.applyTokenCeiling('owner', 'agent_operator');
      expect(effective).toBe('agent_operator');
    });

    it('preserves owner membership when token is also owner', () => {
      const effective = service.applyTokenCeiling('owner', 'owner');
      expect(effective).toBe('owner');
    });

    it('caps admin membership to viewer token', () => {
      const effective = service.applyTokenCeiling('admin', 'viewer');
      expect(effective).toBe('viewer');
    });
  });

  // ===========================================================================
  // canPerformAction
  // ===========================================================================

  describe('canPerformAction', () => {
    it('allows viewer to perform codespace:read', () => {
      expect(service.canPerformAction('viewer', 'codespace:read')).toBe(true);
    });

    it('allows viewer to perform task:read', () => {
      expect(service.canPerformAction('viewer', 'task:read')).toBe(true);
    });

    it('denies viewer from performing task:create (requires agent_operator)', () => {
      expect(service.canPerformAction('viewer', 'task:create')).toBe(false);
    });

    it('denies viewer from performing codespace:update (requires admin)', () => {
      expect(service.canPerformAction('viewer', 'codespace:update')).toBe(false);
    });

    it('denies viewer from performing team:delete (requires owner)', () => {
      expect(service.canPerformAction('viewer', 'team:delete')).toBe(false);
    });

    it('allows agent_operator to perform task:create', () => {
      expect(service.canPerformAction('agent_operator', 'task:create')).toBe(true);
    });

    it('allows agent_operator to perform agent:start', () => {
      expect(service.canPerformAction('agent_operator', 'agent:start')).toBe(true);
    });

    it('denies agent_operator from performing codespace:update (requires admin)', () => {
      expect(service.canPerformAction('agent_operator', 'codespace:update')).toBe(false);
    });

    it('allows admin to perform codespace:update', () => {
      expect(service.canPerformAction('admin', 'codespace:update')).toBe(true);
    });

    it('allows admin to perform settings:update', () => {
      expect(service.canPerformAction('admin', 'settings:update')).toBe(true);
    });

    it('denies admin from performing team:delete (requires owner)', () => {
      expect(service.canPerformAction('admin', 'team:delete')).toBe(false);
    });

    it('allows owner to perform team:delete', () => {
      expect(service.canPerformAction('owner', 'team:delete')).toBe(true);
    });

    it('allows owner to perform team:transfer_owner', () => {
      expect(service.canPerformAction('owner', 'team:transfer_owner')).toBe(true);
    });

    it('denies any role from performing an unknown action', () => {
      expect(service.canPerformAction('owner', 'unknown:action')).toBe(false);
    });

    it('denies viewer from performing an unknown action', () => {
      expect(service.canPerformAction('viewer', 'nonexistent:permission')).toBe(false);
    });
  });

  // ===========================================================================
  // checkTagAccess
  // ===========================================================================

  describe('checkTagAccess', () => {
    it('allows access when tokenScopeTags is null (no restriction)', () => {
      expect(service.checkTagAccess(null, ['tag-a', 'tag-b'])).toBe(true);
    });

    it('allows access when tokenScopeTags is empty array (no restriction)', () => {
      expect(service.checkTagAccess([], ['tag-a'])).toBe(true);
    });

    it('denies access when token has tags but resource has no tags', () => {
      expect(service.checkTagAccess(['tag-a'], [])).toBe(false);
    });

    it('allows access when token scope and resource tags overlap', () => {
      expect(service.checkTagAccess(['tag-a', 'tag-b'], ['tag-b', 'tag-c'])).toBe(true);
    });

    it('denies access when token scope and resource tags have no overlap', () => {
      expect(service.checkTagAccess(['tag-x', 'tag-y'], ['tag-a', 'tag-b'])).toBe(false);
    });

    it('allows access when token has a single tag that matches the resource', () => {
      expect(service.checkTagAccess(['production'], ['staging', 'production'])).toBe(true);
    });

    it('denies access when token has a single tag that does not match any resource tag', () => {
      expect(service.checkTagAccess(['production'], ['staging', 'development'])).toBe(false);
    });

    it('allows access when token scope is null and resource has no tags', () => {
      expect(service.checkTagAccess(null, [])).toBe(true);
    });
  });

  // ===========================================================================
  // checkProjectScope
  // ===========================================================================

  describe('checkCodespaceScope', () => {
    it('allows access when tokenCodespaceId is null (no restriction)', () => {
      expect(service.checkCodespaceScope(null, 'codespace-1')).toBe(true);
    });

    it('allows access when tokenCodespaceId matches requestedCodespaceId', () => {
      expect(service.checkCodespaceScope('codespace-1', 'codespace-1')).toBe(true);
    });

    it('denies access when tokenCodespaceId does not match requestedCodespaceId', () => {
      expect(service.checkCodespaceScope('codespace-1', 'codespace-2')).toBe(false);
    });

    it('denies access when tokenCodespaceId is a different codespace entirely', () => {
      expect(service.checkCodespaceScope('cs-abc', 'cs-xyz')).toBe(false);
    });

    it('allows access when null token scopes any codespace ID', () => {
      expect(service.checkCodespaceScope(null, 'any-codespace-id')).toBe(true);
    });
  });
});
