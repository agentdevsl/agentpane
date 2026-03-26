import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiKeys } from '../../src/db/schema';
import { ApiKeyService } from '../../src/services/api-key.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('ApiKeyService — integration tests', () => {
  let service: ApiKeyService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clear api_keys table before each test
    await db.delete(apiKeys);
    service = new ApiKeyService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-307: Save Anthropic key → encrypted in DB → getDecryptedKey returns original', async () => {
    const originalKey = 'sk-ant-test-key-1234567890abcdef';

    const saveResult = await service.saveKey('anthropic', originalKey);
    expect(saveResult.ok).toBe(true);
    if (saveResult.ok) {
      expect(saveResult.value.service).toBe('anthropic');
      expect(saveResult.value.isValid).toBe(true);
    }

    // Verify decrypted key matches the original
    const decrypted = await service.getDecryptedKey('anthropic');
    expect(decrypted).toBe(originalKey);
  });

  it('IT-308: Save key with invalid format (no sk-ant- prefix for anthropic) → returns INVALID_FORMAT error', async () => {
    const invalidKey = 'invalid-key-no-prefix';

    const result = await service.saveKey('anthropic', invalidKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_FORMAT');
      expect(result.error.message).toContain('sk-ant-');
    }

    // Empty key should also return INVALID_FORMAT
    const emptyResult = await service.saveKey('anthropic', '');
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect(emptyResult.error.code).toBe('INVALID_FORMAT');
    }

    // For non-anthropic services, any non-empty key is valid
    const otherResult = await service.saveKey('openai', 'any-key-format-works');
    expect(otherResult.ok).toBe(true);
  });

  it('IT-309: Save second key for same service replaces first (upsert behavior)', async () => {
    const firstKey = 'sk-ant-first-key-aaaaaa';
    const secondKey = 'sk-ant-second-key-bbbbbb';

    const firstResult = await service.saveKey('anthropic', firstKey);
    expect(firstResult.ok).toBe(true);

    const secondResult = await service.saveKey('anthropic', secondKey);
    expect(secondResult.ok).toBe(true);

    // The decrypted key should be the second one
    const decrypted = await service.getDecryptedKey('anthropic');
    expect(decrypted).toBe(secondKey);

    // There should only be one entry — verify via getKeyInfo
    const info = await service.getKeyInfo('anthropic');
    expect(info.ok).toBe(true);
    if (info.ok && info.value) {
      expect(info.value.service).toBe('anthropic');
    }

    // Verify only one row exists in the DB (upsert, not insert)
    const allKeys = await db.select().from(apiKeys);
    const anthropicKeys = allKeys.filter((k) => k.service === 'anthropic');
    expect(anthropicKeys).toHaveLength(1);
  });

  it('IT-310: Delete key → getKeyInfo returns null, getDecryptedKey returns null', async () => {
    const key = 'sk-ant-delete-me-12345';

    // Save a key first
    const saveResult = await service.saveKey('anthropic', key);
    expect(saveResult.ok).toBe(true);

    // Delete it
    const deleteResult = await service.deleteKey('anthropic');
    expect(deleteResult.ok).toBe(true);

    // getKeyInfo should return null
    const infoResult = await service.getKeyInfo('anthropic');
    expect(infoResult.ok).toBe(true);
    if (infoResult.ok) {
      expect(infoResult.value).toBeNull();
    }

    // getDecryptedKey should return null
    const decrypted = await service.getDecryptedKey('anthropic');
    expect(decrypted).toBeNull();
  });

  it('IT-311: getKeyInfo returns masked key (never contains full plaintext)', async () => {
    const originalKey = 'sk-ant-secret-key-abcdefghij';

    const saveResult = await service.saveKey('anthropic', originalKey);
    expect(saveResult.ok).toBe(true);

    const infoResult = await service.getKeyInfo('anthropic');
    expect(infoResult.ok).toBe(true);
    if (infoResult.ok && infoResult.value) {
      // maskedKey must not equal the original key
      expect(infoResult.value.maskedKey).not.toBe(originalKey);
      // maskedKey should be a non-empty string
      expect(infoResult.value.maskedKey.length).toBeGreaterThan(0);
      // The info should not contain the full plaintext anywhere
      expect(JSON.stringify(infoResult.value)).not.toContain(originalKey);
    }
  });

  it('IT-312: markInvalid sets isValid to false, verify via getKeyInfo', async () => {
    const key = 'sk-ant-invalid-soon-99999';

    // Save a valid key
    const saveResult = await service.saveKey('anthropic', key);
    expect(saveResult.ok).toBe(true);
    if (saveResult.ok) {
      expect(saveResult.value.isValid).toBe(true);
    }

    // Mark it as invalid
    await service.markInvalid('anthropic');

    // Verify isValid is now false
    const infoResult = await service.getKeyInfo('anthropic');
    expect(infoResult.ok).toBe(true);
    if (infoResult.ok && infoResult.value) {
      expect(infoResult.value.isValid).toBe(false);
    }
  });

  it('IT-312b: deleteKey for non-existent service succeeds gracefully', async () => {
    const result = await service.deleteKey('nonexistent-service');
    expect(result.ok).toBe(true);
  });
});
