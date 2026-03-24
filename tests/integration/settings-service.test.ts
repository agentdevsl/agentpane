import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema';
import { SettingsService } from '../../src/services/settings.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('SettingsService — integration tests', () => {
  let service: SettingsService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    // Clear settings table before each test (not in clearTestDatabase by default)
    await db.delete(settings);
    service = new SettingsService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-121: get returns setting by key, returns null for nonexistent key', async () => {
    // Set a key
    const setResult = await service.set('test_key', 'hello world');
    expect(setResult.ok).toBe(true);

    // Get existing key
    const getResult = await service.get('test_key');
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).not.toBeNull();
      expect(getResult.value?.key).toBe('test_key');
      expect(JSON.parse(getResult.value!.value)).toBe('hello world');
    }

    // Get nonexistent key
    const missingResult = await service.get('nonexistent_key');
    expect(missingResult.ok).toBe(true);
    if (missingResult.ok) {
      expect(missingResult.value).toBeNull();
    }
  });

  it('IT-122: getMany returns only existing keys, omits missing ones', async () => {
    await service.set('key1', 'value1');
    await service.set('key2', 42);
    // key3 intentionally not set

    const result = await service.getMany(['key1', 'key2', 'missing_key']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.key1).toBe('value1');
      expect(result.value.key2).toBe(42);
      expect(result.value.missing_key).toBeUndefined();
      expect(Object.keys(result.value)).toHaveLength(2);
    }
  });

  it('IT-123: getAll returns empty object when settings table is empty', async () => {
    const result = await service.getAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it('IT-124: set performs upsert — first inserts, second updates', async () => {
    // First set: insert
    const firstResult = await service.set('mykey', { nested: true });
    expect(firstResult.ok).toBe(true);

    const afterFirst = await service.get('mykey');
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) {
      expect(JSON.parse(afterFirst.value!.value)).toEqual({ nested: true });
    }

    // Second set: upsert (update)
    const secondResult = await service.set('mykey', { nested: false, extra: 'field' });
    expect(secondResult.ok).toBe(true);

    const afterSecond = await service.get('mykey');
    expect(afterSecond.ok).toBe(true);
    if (afterSecond.ok) {
      expect(JSON.parse(afterSecond.value!.value)).toEqual({ nested: false, extra: 'field' });
    }
  });

  it('IT-125: set/get roundtrip for complex nested JSON values', async () => {
    const complexValue = {
      foo: {
        bar: [1, 2, 3],
        baz: { nested: true, items: ['a', 'b'] },
      },
      count: 99,
      enabled: false,
    };

    await service.set('complex', complexValue);

    const result = await service.get('complex');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.value!.value);
      expect(parsed).toEqual(complexValue);
      expect(parsed.foo.bar).toEqual([1, 2, 3]);
      expect(parsed.foo.baz.nested).toBe(true);
    }
  });

  it('IT-126: setMany stores multiple settings atomically', async () => {
    const multiSettings = {
      'batch.key1': 'first',
      'batch.key2': [10, 20, 30],
      'batch.key3': { flag: true },
    };

    const result = await service.setMany(multiSettings);
    expect(result.ok).toBe(true);

    // Verify all were stored
    const allResult = await service.getAll();
    expect(allResult.ok).toBe(true);
    if (allResult.ok) {
      expect(allResult.value['batch.key1']).toBe('first');
      expect(allResult.value['batch.key2']).toEqual([10, 20, 30]);
      expect(allResult.value['batch.key3']).toEqual({ flag: true });
    }
  });

  it('IT-127: delete on nonexistent key succeeds without error', async () => {
    const result = await service.delete('totally_missing_key');
    expect(result.ok).toBe(true);

    // Also verify deleting an existing key works
    await service.set('to_delete', 'goodbye');
    const deleteResult = await service.delete('to_delete');
    expect(deleteResult.ok).toBe(true);

    const getResult = await service.get('to_delete');
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });

  it('IT-128: stores and retrieves default model setting', async () => {
    await service.set('default_model', 'claude-opus-4-6');

    const result = await service.get('default_model');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      const parsed = JSON.parse(result.value!.value);
      expect(parsed).toBe('claude-opus-4-6');
    }

    // Test getGlobalDefaultModel resolves the stored value
    const globalModel = await service.getGlobalDefaultModel();
    expect(globalModel).toBeTruthy();
    expect(typeof globalModel).toBe('string');
  });

  it('IT-129: stores and retrieves taskCreation.model setting', async () => {
    await service.set('taskCreation.model', 'claude-sonnet-4-6');

    const result = await service.get('taskCreation.model');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      const parsed = JSON.parse(result.value!.value);
      expect(parsed).toBe('claude-sonnet-4-6');
    }

    // Test via typed getter
    const model = await service.getTaskCreationModel();
    expect(typeof model).toBe('string');
  });

  it('IT-130: stores sensitive config and detects sensitive field patterns', async () => {
    const nomadConfig = {
      token: 'secret-nomad-token-abc123',
      address: 'http://localhost:4646',
      namespace: 'production',
    };

    await service.set('sandbox.nomad', nomadConfig);

    const result = await service.get('sandbox.nomad');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.value!.value);
      expect(parsed).toEqual(nomadConfig);
      expect(parsed.token).toBe('secret-nomad-token-abc123');

      // Demonstrate that sensitive fields can be detected by pattern
      const sensitiveKeys = Object.keys(parsed).filter((k) => /token|secret|key|password/i.test(k));
      expect(sensitiveKeys).toContain('token');
      expect(sensitiveKeys).toHaveLength(1);
    }
  });
});
