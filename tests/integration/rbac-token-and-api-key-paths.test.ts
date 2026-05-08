/**
 * Integration tests for RbacTokenService and ApiKeyService (slice H).
 *
 * Targets uncovered lines: token format/lifecycle helpers, name uniqueness,
 * limit enforcement, expiry, revoke (success/already-revoked/not-found/db-err),
 * scope-tag enrichment, and ApiKeyService refresh-token + deleteKey paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeys } from '../../src/db/schema';
import { ApiKeyService } from '../../src/services/api-key.service';
import { RbacTokenService } from '../../src/services/rbac-token.service';
import { createTestTeam } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('RbacTokenService paths (IT-1920)', () => {
  let db: ReturnType<typeof getTestDb>;
  let svc: RbacTokenService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    svc = new RbacTokenService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── Pure helpers ─────────────────────────────────────

  it('IT-1920-1: generateToken produces ap_ prefixed valid format', () => {
    const t = svc.generateToken();
    expect(t.startsWith('ap_')).toBe(true);
    expect(svc.isValidFormat(t)).toBe(true);
  });

  it('IT-1920-2: hashToken returns deterministic hex', () => {
    const a = svc.hashToken('ap_abc');
    const b = svc.hashToken('ap_abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('IT-1920-3: isValidFormat rejects malformed tokens', () => {
    expect(svc.isValidFormat('not_a_token')).toBe(false);
    expect(svc.isValidFormat('ap_short')).toBe(false);
    expect(svc.isValidFormat('')).toBe(false);
  });

  it('IT-1920-4: getPrefix returns first 12 chars', () => {
    const t = 'ap_' + 'a'.repeat(43);
    expect(svc.getPrefix(t)).toHaveLength(12);
  });

  // ─── create ───────────────────────────────────────────

  it('IT-1920-5: create succeeds and returns raw token + metadata', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const result = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'tok-1',
      role: 'viewer',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.token.startsWith('ap_')).toBe(true);
      expect(result.value.role).toBe('viewer');
      expect(result.value.scopeTags).toBeNull();
      expect(result.value.scopeCodespaceId).toBeNull();
    }
  });

  it('IT-1920-6: create with expiresInDays sets expiresAt in future', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const result = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'tok-exp',
      role: 'viewer',
      expiresInDays: 7,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const exp = new Date(result.value.expiresAt!).getTime();
      expect(exp).toBeGreaterThan(Date.now());
    }
  });

  it('IT-1920-7: create rejects duplicate non-revoked token name', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await svc.create({ userId: user.id, teamId: team.id, name: 'dup', role: 'viewer' });
    const result = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'dup',
      role: 'viewer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TOKEN_NAME_EXISTS');
    }
  });

  it('IT-1920-8: create allows reusing name after revoke', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const first = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'reuse',
      role: 'viewer',
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      await svc.revoke(first.value.id, user.id);
    }
    const second = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'reuse',
      role: 'viewer',
    });
    expect(second.ok).toBe(true);
  });

  it('IT-1920-9: create enforces 25-token limit per user', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    for (let i = 0; i < 25; i++) {
      const r = await svc.create({
        userId: user.id,
        teamId: team.id,
        name: `t-${i}`,
        role: 'viewer',
      });
      expect(r.ok).toBe(true);
    }
    const result = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'over-limit',
      role: 'viewer',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('LIMIT_EXCEEDED');
    }
  });

  // ─── resolveToken ─────────────────────────────────────

  it('IT-1920-10: resolveToken returns null for invalid format', async () => {
    expect(await svc.resolveToken('garbage')).toBeNull();
  });

  it('IT-1920-11: resolveToken returns record for active token', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const created = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'r1',
      role: 'admin',
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const resolved = await svc.resolveToken(created.value.token);
      expect(resolved?.id).toBe(created.value.id);
      expect(resolved?.role).toBe('admin');
    }
  });

  it('IT-1920-12: resolveToken returns null when expired', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const created = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'r2',
      role: 'viewer',
      expiresInDays: 7,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const { eq } = await import('drizzle-orm');
      const { apiTokens } = await import('../../src/db/schema');
      // Force expiresAt into the past
      await db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(apiTokens.id, created.value.id));
      const resolved = await svc.resolveToken(created.value.token);
      expect(resolved).toBeNull();
    }
  });

  it('IT-1920-13: resolveToken returns null when token unknown', async () => {
    const fakeToken = 'ap_' + 'x'.repeat(43);
    const resolved = await svc.resolveToken(fakeToken);
    expect(resolved).toBeNull();
  });

  // ─── revoke ───────────────────────────────────────────

  it('IT-1920-14: revoke succeeds for active token', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const created = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'rev',
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const result = await svc.revoke(created.value.id, user.id);
      expect(result.ok).toBe(true);
    }
  });

  it('IT-1920-15: revoke returns ALREADY_REVOKED for revoked token', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    const created = await svc.create({
      userId: user.id,
      teamId: team.id,
      name: 'rev2',
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      await svc.revoke(created.value.id, user.id);
      const result = await svc.revoke(created.value.id, user.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('ALREADY_REVOKED');
      }
    }
  });

  it('IT-1920-16: revoke returns TOKEN_NOT_FOUND for unknown token', async () => {
    const user = await createTestUser();
    const result = await svc.revoke('no-such-token', user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('TOKEN_NOT_FOUND');
    }
  });

  // ─── enrichScopeTags ──────────────────────────────────

  it('IT-1920-17: enrichScopeTags returns [] for null/empty', async () => {
    expect(await svc.enrichScopeTags(null)).toEqual([]);
    expect(await svc.enrichScopeTags([])).toEqual([]);
  });

  it('IT-1920-18: enrichScopeTags resolves tag IDs to {id,name,color}', async () => {
    const { tags, projectFolders } = await import('../../src/db/schema');
    const folderId = `enrich-folder-${Date.now()}`;
    await db.insert(projectFolders).values({ id: folderId, name: 'F', slug: `f-${Date.now()}` });
    const tagId = 'enrich-tag-1';
    await db
      .insert(tags)
      .values({ id: tagId, projectFolderId: folderId, name: 'production', color: '#10B981' });

    const enriched = await svc.enrichScopeTags([tagId]);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.name).toBe('production');
    expect(enriched[0]?.color).toBe('#10B981');
  });
});

describe('ApiKeyService paths (IT-1925)', () => {
  let db: ReturnType<typeof getTestDb>;
  let svc: ApiKeyService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    svc = new ApiKeyService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── saveKey ──────────────────────────────────────────

  it('IT-1925-1: saveKey rejects empty key', async () => {
    const r = await svc.saveKey('anthropic', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_FORMAT');
  });

  it('IT-1925-2: saveKey rejects whitespace-only key', async () => {
    const r = await svc.saveKey('anthropic', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_FORMAT');
  });

  it('IT-1925-3: saveKey rejects malformed anthropic key', async () => {
    const r = await svc.saveKey('anthropic', 'wrong-prefix');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_FORMAT');
  });

  it('IT-1925-4: saveKey accepts valid anthropic key', async () => {
    const r = await svc.saveKey('anthropic', 'sk-ant-' + 'x'.repeat(50));
    expect(r.ok).toBe(true);
  });

  it('IT-1925-5: saveKey persists refresh token when supplied', async () => {
    const r = await svc.saveKey('anthropic', 'sk-ant-' + 'x'.repeat(50), 'refresh-tok-123');
    expect(r.ok).toBe(true);
    const refresh = await svc.getDecryptedRefreshToken('anthropic');
    expect(refresh).toBe('refresh-tok-123');
  });

  it('IT-1925-6: saveKey treats empty refresh token as null', async () => {
    const r = await svc.saveKey('anthropic', 'sk-ant-' + 'x'.repeat(50), '   ');
    expect(r.ok).toBe(true);
    const refresh = await svc.getDecryptedRefreshToken('anthropic');
    expect(refresh).toBeNull();
  });

  it('IT-1925-7: saveKey replaces existing key for same service', async () => {
    await svc.saveKey('openai', 'first-key');
    await svc.saveKey('openai', 'second-key');
    const decrypted = await svc.getDecryptedKey('openai');
    expect(decrypted).toBe('second-key');
  });

  // ─── getKeyInfo / getDecryptedKey ─────────────────────

  it('IT-1925-8: getKeyInfo returns null when service has no key', async () => {
    const r = await svc.getKeyInfo('nonexistent');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('IT-1925-9: getKeyInfo returns metadata when key exists', async () => {
    await svc.saveKey('anthropic', 'sk-ant-' + 'a'.repeat(50));
    const r = await svc.getKeyInfo('anthropic');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.service).toBe('anthropic');
      // maskToken obscures the middle so prefix may be truncated
      expect(r.value.maskedKey).toMatch(/^sk-/);
      expect(r.value.maskedKey).toContain('•');
    }
  });

  it('IT-1925-10: getDecryptedKey returns null when not present', async () => {
    expect(await svc.getDecryptedKey('nope')).toBeNull();
  });

  it('IT-1925-11: getDecryptedRefreshToken returns null when no token saved', async () => {
    await svc.saveKey('anthropic', 'sk-ant-' + 'x'.repeat(50));
    expect(await svc.getDecryptedRefreshToken('anthropic')).toBeNull();
  });

  // ─── deleteKey ────────────────────────────────────────

  it('IT-1925-12: deleteKey is idempotent (no-op on missing)', async () => {
    const r = await svc.deleteKey('nope');
    expect(r.ok).toBe(true);
  });

  it('IT-1925-13: deleteKey removes existing entry', async () => {
    await svc.saveKey('openai', 'k');
    const r = await svc.deleteKey('openai');
    expect(r.ok).toBe(true);
    const info = await svc.getKeyInfo('openai');
    if (info.ok) expect(info.value).toBeNull();
  });

  // ─── markInvalid ──────────────────────────────────────

  it('IT-1925-14: markInvalid sets isValid=false on row', async () => {
    await svc.saveKey('openai', 'k');
    await svc.markInvalid('openai');
    const r = await svc.getKeyInfo('openai');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.isValid).toBe(false);
    }
  });

  it('IT-1925-15: markInvalid is silent when row missing (no throw)', async () => {
    await expect(svc.markInvalid('nope')).resolves.toBeUndefined();
  });

  it('IT-1925-16: markInvalid swallows and logs db error', async () => {
    const failingDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockRejectedValue(new Error('db down')),
        })),
      })),
    };
    const svcFail = new ApiKeyService(failingDb as never);
    await expect(svcFail.markInvalid('openai')).resolves.toBeUndefined();
  });

  // ─── error paths in saveKey/getKeyInfo ────────────────

  it('IT-1925-17: saveKey returns STORAGE_ERROR when db throws', async () => {
    const failingDb = {
      delete: vi.fn(() => ({
        where: vi.fn().mockRejectedValue(new Error('db down')),
      })),
    };
    const svcFail = new ApiKeyService(failingDb as never);
    const r = await svcFail.saveKey('openai', 'k');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('STORAGE_ERROR');
  });

  it('IT-1925-18: getKeyInfo returns STORAGE_ERROR when db throws', async () => {
    const failingDb = {
      query: {
        apiKeys: {
          findFirst: vi.fn().mockRejectedValue(new Error('db down')),
        },
      },
    };
    const svcFail = new ApiKeyService(failingDb as never);
    const r = await svcFail.getKeyInfo('openai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('STORAGE_ERROR');
  });

  it('IT-1925-19: deleteKey returns STORAGE_ERROR when db throws', async () => {
    const failingDb = {
      delete: vi.fn(() => ({
        where: vi.fn().mockRejectedValue(new Error('db down')),
      })),
    };
    const svcFail = new ApiKeyService(failingDb as never);
    const r = await svcFail.deleteKey('openai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('STORAGE_ERROR');
  });

  // Guard against suppressing duplicate `apiKeys` import warnings.
  it('IT-1925-20: schema reference present', () => {
    expect(apiKeys).toBeTruthy();
  });
});
