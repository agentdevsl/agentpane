/**
 * Integration test: detect schema drift between Drizzle's `api_keys` table
 * and the actual SQLite runtime schema.
 *
 * F03-09 (arch29-W2-C): the agent-runner's OAuth refresh token plumbing was
 * dead-end on the host because no `encrypted_refresh_token` column existed
 * to store the value. This test asserts every Drizzle column in `api_keys`
 * exists in the runtime schema, and specifically calls out
 * `encrypted_refresh_token` so a future migration regression fails loudly.
 *
 * The dedicated schema-drift suite (`schema-drift-all-tables.test.ts`)
 * iterates every table generically. This file keeps the assertions
 * explicit for the OAuth-critical `api_keys` table because Drizzle column
 * names can drift silently from DB column names (`encryptedRefreshToken`
 * vs `encrypted_refresh_token`).
 */

import { getTableColumns, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiKeys } from '../../src/db/schema';
import { ApiKeyService } from '../../src/services/api-key.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('api_keys schema drift detection (F03-09 / arch29-W2-C)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('DB api_keys table has every column defined in Drizzle schema', () => {
    const drizzleColumns = getTableColumns(apiKeys);
    const expectedColumns = Object.values(drizzleColumns).map((col) => col.name);

    const tableInfo = db.all<{ name: string }>(sql`PRAGMA table_info(api_keys)`);
    const actualColumns = new Set(tableInfo.map((col) => col.name));

    for (const expected of expectedColumns) {
      expect(
        actualColumns.has(expected),
        `DB api_keys table missing column '${expected}' that Drizzle schema defines`
      ).toBe(true);
    }
  });

  it('api_keys table has the encrypted_refresh_token column (F03-09)', () => {
    // Explicit assertion so the failure message points at F03-09 directly.
    const tableInfo = db.all<{ name: string; type: string; notnull: number }>(
      sql`PRAGMA table_info(api_keys)`
    );
    const refreshCol = tableInfo.find((c) => c.name === 'encrypted_refresh_token');
    expect(
      refreshCol,
      'api_keys.encrypted_refresh_token must exist for OAuth refresh token plumbing (F03-09)'
    ).toBeDefined();
    // Must be nullable: legacy rows + non-OAuth keys do not carry a refresh token.
    expect(refreshCol?.notnull, 'encrypted_refresh_token must be nullable').toBe(0);
    // Must be TEXT (encrypted base64).
    expect(refreshCol?.type.toLowerCase()).toBe('text');
  });

  it('saveKey + getDecryptedRefreshToken roundtrip persists an encrypted refresh token', async () => {
    const service = new ApiKeyService(db as any);

    // Save with refresh token.
    const saveResult = await service.saveKey(
      'anthropic',
      'sk-ant-oat01-roundtrip-token',
      'rt-secret-roundtrip'
    );
    expect(saveResult.ok, JSON.stringify(saveResult)).toBe(true);

    // Roundtrip: the DB must return the same plaintext refresh token.
    const decrypted = await service.getDecryptedRefreshToken('anthropic');
    expect(decrypted).toBe('rt-secret-roundtrip');

    // The stored value must NOT equal the plaintext (i.e., it really was
    // encrypted). Look at the raw row.
    const rows = await db.select().from(apiKeys);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.encryptedRefreshToken, 'encryptedRefreshToken column populated').toBeTruthy();
    expect(row.encryptedRefreshToken).not.toBe('rt-secret-roundtrip');
  });

  it('saveKey without refresh token leaves encrypted_refresh_token null', async () => {
    const service = new ApiKeyService(db as any);

    const saveResult = await service.saveKey('anthropic', 'sk-ant-oat01-no-refresh');
    expect(saveResult.ok).toBe(true);

    const decrypted = await service.getDecryptedRefreshToken('anthropic');
    expect(decrypted).toBeNull();

    const rows = await db.select().from(apiKeys);
    expect(rows[0].encryptedRefreshToken).toBeNull();
  });

  it('saveKey treats empty-string refresh token as null (SDK rejects empty string)', async () => {
    const service = new ApiKeyService(db as any);

    const saveResult = await service.saveKey('anthropic', 'sk-ant-oat01-empty-rt', '');
    expect(saveResult.ok).toBe(true);

    const decrypted = await service.getDecryptedRefreshToken('anthropic');
    expect(decrypted).toBeNull();
  });

  it('getDecryptedRefreshToken returns null when service has no row', async () => {
    const service = new ApiKeyService(db as any);

    const result = await service.getDecryptedRefreshToken('nonexistent');
    expect(result).toBeNull();
  });
});
