import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-020: RBAC Token Ceiling Computation', () => {
  let rbacService: RbacService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    rbacService = new RbacService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns admin when both membership and token are admin', () => {
    expect(rbacService.applyTokenCeiling('admin', 'admin')).toBe('admin');
  });

  it('returns viewer when admin membership is capped by viewer token', () => {
    expect(rbacService.applyTokenCeiling('admin', 'viewer')).toBe('viewer');
  });

  it('returns viewer when viewer membership is paired with admin token', () => {
    expect(rbacService.applyTokenCeiling('viewer', 'admin')).toBe('viewer');
  });

  it('returns agent_operator when owner membership is capped by agent_operator token', () => {
    expect(rbacService.applyTokenCeiling('owner', 'agent_operator')).toBe('agent_operator');
  });

  it('returns agent_operator when agent_operator membership is paired with admin token', () => {
    expect(rbacService.applyTokenCeiling('agent_operator', 'admin')).toBe('agent_operator');
  });

  it('returns owner when both membership and token are owner', () => {
    expect(rbacService.applyTokenCeiling('owner', 'owner')).toBe('owner');
  });

  it('returns viewer when both membership and token are viewer', () => {
    expect(rbacService.applyTokenCeiling('viewer', 'viewer')).toBe('viewer');
  });
});
