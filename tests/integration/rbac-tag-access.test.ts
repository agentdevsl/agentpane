import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-028: RBAC Tag-Based Access Control', () => {
  let rbacService: RbacService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    rbacService = new RbacService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('checkTagAccess', () => {
    it('allows access when tokenScopeTags is null (no restriction)', () => {
      expect(rbacService.checkTagAccess(null, ['any'])).toBe(true);
    });

    it('allows access when tokenScopeTags is empty (no restriction)', () => {
      expect(rbacService.checkTagAccess([], ['any'])).toBe(true);
    });

    it('allows access when there is tag overlap', () => {
      expect(rbacService.checkTagAccess(['infra'], ['infra', 'prod'])).toBe(true);
    });

    it('denies access when there is no tag overlap', () => {
      expect(rbacService.checkTagAccess(['dev'], ['prod'])).toBe(false);
    });

    it('denies access when resource has no tags and token is restricted', () => {
      expect(rbacService.checkTagAccess(['infra'], [])).toBe(false);
    });

    it('allows access when multiple token tags overlap with resource tags', () => {
      expect(rbacService.checkTagAccess(['a', 'b'], ['b', 'c'])).toBe(true);
    });

    it('denies access when multiple token tags have no overlap with resource tags', () => {
      expect(rbacService.checkTagAccess(['x', 'y'], ['a', 'b'])).toBe(false);
    });

    it('allows access with single matching tag', () => {
      expect(rbacService.checkTagAccess(['prod'], ['prod'])).toBe(true);
    });

    it('allows access when null tokenScopeTags and empty resource tags', () => {
      expect(rbacService.checkTagAccess(null, [])).toBe(true);
    });
  });

  describe('checkCodespaceScope', () => {
    it('allows access when tokenCodespaceId is null (no restriction)', () => {
      expect(rbacService.checkCodespaceScope(null, 'any-id')).toBe(true);
    });

    it('allows access when codespace IDs match', () => {
      expect(rbacService.checkCodespaceScope('cs-1', 'cs-1')).toBe(true);
    });

    it('denies access when codespace IDs do not match', () => {
      expect(rbacService.checkCodespaceScope('cs-1', 'cs-2')).toBe(false);
    });

    it('denies access with empty string vs non-empty string', () => {
      expect(rbacService.checkCodespaceScope('cs-1', '')).toBe(false);
    });

    it('allows access with matching empty strings', () => {
      expect(rbacService.checkCodespaceScope('', '')).toBe(true);
    });
  });
});
