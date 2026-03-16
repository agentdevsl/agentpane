import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokens } from '../../src/db/schema/sqlite/api-tokens';
import { teams } from '../../src/db/schema/sqlite/teams';
import { users } from '../../src/db/schema/sqlite/users';
import { RbacTokenService } from '../../src/services/rbac-token.service';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

// =============================================================================
// Test constants
// =============================================================================

const USER_ID = 'user-1';
const TEAM_ID = 'team-1';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Patch db.transaction so it runs the callback with `db` itself instead of a
 * real SQLite transaction. better-sqlite3's synchronous transaction wrapper
 * rejects async callbacks, but the service uses `async (tx) => { ... }`.
 * Since tests are sequential this is safe.
 */
function patchTransaction(db: any): void {
  const originalTransaction = db.transaction.bind(db);
  db.transaction = async (fn: (tx: any) => Promise<any>) => {
    return fn(db);
  };
  // Store original so we can restore if needed
  db._originalTransaction = originalTransaction;
}

/**
 * Insert a token row directly (bypasses the service's create transaction).
 * Returns the raw token so tests can call resolveToken with it.
 */
async function insertTokenDirectly(
  service: RbacTokenService,
  overrides: {
    id?: string;
    name?: string;
    role?: string;
    status?: string;
    expiresAt?: string | null;
  } = {}
): Promise<{ rawToken: string; id: string }> {
  const db = getTestDb();
  const rawToken = service.generateToken();
  const tokenHash = service.hashToken(rawToken);
  const tokenPrefix = service.getPrefix(rawToken);

  const [created] = await db
    .insert(apiTokens)
    .values({
      id: overrides.id ?? undefined,
      userId: USER_ID,
      teamId: TEAM_ID,
      name: overrides.name ?? 'Direct Token',
      tokenHash,
      tokenPrefix,
      role: (overrides.role ?? 'admin') as any,
      status: (overrides.status ?? 'active') as any,
      expiresAt: overrides.expiresAt ?? null,
    })
    .returning();

  return { rawToken, id: created!.id };
}

// =============================================================================
// RbacTokenService Tests (integration, real SQLite)
// =============================================================================

describe('RbacTokenService', () => {
  let service: RbacTokenService;

  beforeAll(async () => {
    await setupTestDatabase();

    // Insert user once -- the clearTestDatabase helper does not clear the users table
    const db = getTestDb();
    await db.insert(users).values({
      id: USER_ID,
      githubId: 12345,
      githubLogin: 'testuser',
      name: 'Test User',
    });
  });

  beforeEach(async () => {
    await clearTestDatabase();

    const db = getTestDb();

    // Patch transaction to support async callbacks in better-sqlite3
    patchTransaction(db);

    service = new RbacTokenService(db as any);

    // Re-insert team each run (cleared by clearTestDatabase)
    await db.insert(teams).values({
      id: TEAM_ID,
      name: 'Test Team',
      slug: 'test-team',
    });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  // ===========================================================================
  // generateToken
  // ===========================================================================

  describe('generateToken', () => {
    it('produces an ap_ prefixed token matching the expected format', () => {
      const token = service.generateToken();

      expect(token).toMatch(/^ap_[A-Za-z0-9_-]{42,44}$/);
    });
  });

  // ===========================================================================
  // hashToken
  // ===========================================================================

  describe('hashToken', () => {
    it('is deterministic: same input produces same output', () => {
      const raw = service.generateToken();
      const hash1 = service.hashToken(raw);
      const hash2 = service.hashToken(raw);

      expect(hash1).toBe(hash2);
      // SHA-256 hex digest is 64 characters
      expect(hash1).toHaveLength(64);
    });
  });

  // ===========================================================================
  // isValidFormat
  // ===========================================================================

  describe('isValidFormat', () => {
    it('accepts a valid token format', () => {
      const token = service.generateToken();
      expect(service.isValidFormat(token)).toBe(true);
    });

    it('rejects tokens without the ap_ prefix', () => {
      expect(service.isValidFormat('xx_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')).toBe(false);
    });

    it('rejects tokens that are too short', () => {
      expect(service.isValidFormat('ap_short')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(service.isValidFormat('')).toBe(false);
    });
  });

  // ===========================================================================
  // getPrefix
  // ===========================================================================

  describe('getPrefix', () => {
    it('returns the first 12 characters of the token', () => {
      const token = service.generateToken();
      const prefix = service.getPrefix(token);

      expect(prefix).toHaveLength(12);
      expect(prefix).toBe(token.substring(0, 12));
      expect(prefix.startsWith('ap_')).toBe(true);
    });
  });

  // ===========================================================================
  // create
  // ===========================================================================

  describe('create', () => {
    it('successfully creates a token and returns raw token starting with ap_', async () => {
      const result = await service.create({
        userId: USER_ID,
        teamId: TEAM_ID,
        name: 'My Token',
        role: 'admin',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.token).toMatch(/^ap_/);
      expect(result.data.name).toBe('My Token');
      expect(result.data.role).toBe('admin');
      expect(result.data.teamId).toBe(TEAM_ID);
      expect(result.data.id).toBeDefined();
      expect(result.data.tokenPrefix).toBe(result.data.token.substring(0, 12));
    });

    it('rejects duplicate token name with TOKEN_NAME_EXISTS error', async () => {
      // Create the first token
      const first = await service.create({
        userId: USER_ID,
        teamId: TEAM_ID,
        name: 'Duplicate Name',
        role: 'viewer',
      });
      expect(first.ok).toBe(true);

      // Attempt to create a second token with the same name
      const second = await service.create({
        userId: USER_ID,
        teamId: TEAM_ID,
        name: 'Duplicate Name',
        role: 'viewer',
      });

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error).toBe('TOKEN_NAME_EXISTS');
    });

    it('enforces 25-token limit with LIMIT_EXCEEDED error', async () => {
      // Create 25 tokens to hit the limit
      for (let i = 0; i < 25; i++) {
        const res = await service.create({
          userId: USER_ID,
          teamId: TEAM_ID,
          name: `Token ${i}`,
          role: 'viewer',
        });
        expect(res.ok).toBe(true);
      }

      // The 26th should fail
      const overLimit = await service.create({
        userId: USER_ID,
        teamId: TEAM_ID,
        name: 'Token 26',
        role: 'viewer',
      });

      expect(overLimit.ok).toBe(false);
      if (overLimit.ok) return;
      expect(overLimit.error).toBe('LIMIT_EXCEEDED');
    });
  });

  // ===========================================================================
  // resolveToken
  // ===========================================================================

  describe('resolveToken', () => {
    it('finds an active token by its raw value', async () => {
      const { rawToken, id } = await insertTokenDirectly(service, {
        name: 'Resolvable Token',
        role: 'admin',
      });

      const resolved = await service.resolveToken(rawToken);

      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(id);
      expect(resolved!.userId).toBe(USER_ID);
      expect(resolved!.teamId).toBe(TEAM_ID);
      expect(resolved!.role).toBe('admin');
      expect(resolved!.status).toBe('active');
    });

    it('returns null for an expired token', async () => {
      // Insert a token with an expiry date in the past
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { rawToken } = await insertTokenDirectly(service, {
        name: 'Expired Token',
        role: 'viewer',
        expiresAt: pastDate,
      });

      const resolved = await service.resolveToken(rawToken);

      expect(resolved).toBeNull();
    });

    it('returns null for an invalid format token', async () => {
      const resolved = await service.resolveToken('invalid_token');
      expect(resolved).toBeNull();
    });
  });

  // ===========================================================================
  // revoke
  // ===========================================================================

  describe('revoke', () => {
    it('revokes a token successfully and returns ALREADY_REVOKED on second attempt', async () => {
      const { id } = await insertTokenDirectly(service, {
        name: 'Revocable Token',
        role: 'admin',
      });

      // First revoke should succeed
      const revokeResult = await service.revoke(id, USER_ID);
      expect(revokeResult.ok).toBe(true);

      // Second revoke should return ALREADY_REVOKED
      const secondRevoke = await service.revoke(id, USER_ID);
      expect(secondRevoke.ok).toBe(false);
      if (secondRevoke.ok) return;
      expect(secondRevoke.error).toBe('ALREADY_REVOKED');
      expect(secondRevoke.status).toBe(409);
    });

    it('returns TOKEN_NOT_FOUND for a nonexistent token id', async () => {
      const result = await service.revoke('nonexistent-id', USER_ID);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('TOKEN_NOT_FOUND');
      expect(result.status).toBe(404);
    });
  });
});
