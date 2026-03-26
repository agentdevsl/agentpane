import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema';
import { getGlobalDefaultModel, SettingsService } from '../../src/services/settings.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('SettingsService — model resolution integration tests', () => {
  let service: SettingsService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clear settings table before each test
    await db.delete(settings);
    service = new SettingsService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-326: Set default_model → getGlobalDefaultModel returns a string (the full model ID)', async () => {
    // Set default_model to a known model ID
    const setResult = await service.set('default_model', 'claude-sonnet-4-6');
    expect(setResult.ok).toBe(true);

    // Instance method
    const modelFromInstance = await service.getGlobalDefaultModel();
    expect(typeof modelFromInstance).toBe('string');
    expect(modelFromInstance).toBeTruthy();

    // Standalone function
    const modelFromStandalone = await getGlobalDefaultModel(db as any);
    expect(typeof modelFromStandalone).toBe('string');
    expect(modelFromStandalone).toBeTruthy();

    // Both should return the same value
    expect(modelFromInstance).toBe(modelFromStandalone);
  });

  it('IT-327: No default_model set → getGlobalDefaultModel returns undefined', async () => {
    // No default_model has been set — settings table is empty

    const modelFromInstance = await service.getGlobalDefaultModel();
    expect(modelFromInstance).toBeUndefined();

    const modelFromStandalone = await getGlobalDefaultModel(db as any);
    expect(modelFromStandalone).toBeUndefined();
  });

  it('IT-328: Set then delete default_model → getGlobalDefaultModel returns undefined', async () => {
    // Set default_model
    const setResult = await service.set('default_model', 'claude-opus-4-5');
    expect(setResult.ok).toBe(true);

    // Confirm it returns a value
    const modelBefore = await service.getGlobalDefaultModel();
    expect(modelBefore).toBeTruthy();

    // Delete the setting
    const deleteResult = await service.delete('default_model');
    expect(deleteResult.ok).toBe(true);

    // Now it should return undefined
    const modelAfter = await service.getGlobalDefaultModel();
    expect(modelAfter).toBeUndefined();
  });

  it('IT-329: Invalid JSON in settings value (corrupt DB) → getGlobalDefaultModel returns undefined (no crash)', async () => {
    // Insert a row with invalid JSON directly via raw SQL to simulate corruption
    execRawSql(
      `INSERT INTO settings (key, value, updated_at) VALUES ('default_model', '{not-valid-json', '${new Date().toISOString()}')`
    );

    // Should not throw — returns undefined gracefully
    const modelFromInstance = await service.getGlobalDefaultModel();
    expect(modelFromInstance).toBeUndefined();

    const modelFromStandalone = await getGlobalDefaultModel(db as any);
    expect(modelFromStandalone).toBeUndefined();
  });

  it('IT-330: Model alias resolution: set opus alias → getGlobalDefaultModel returns full ID containing opus', async () => {
    // Set the alias 'claude-opus-4-5' which should resolve to its full model ID
    const setResult = await service.set('default_model', 'claude-opus-4-5');
    expect(setResult.ok).toBe(true);

    const model = await service.getGlobalDefaultModel();
    expect(model).toBeDefined();
    // The full model ID for claude-opus-4-5 should contain 'opus'
    expect(model).toContain('opus');
    // It should be the full dated ID, not the short alias
    // The resolved model should be a full dated ID containing 'opus'
    expect(model!.length).toBeGreaterThan('claude-opus-4-5'.length);
  });

  it('IT-331: Settings set/getMany round-trip with complex objects (nested JSON preserved)', async () => {
    const complexValue = {
      nested: {
        array: [1, 2, 3],
        deep: { key: 'value', flag: true },
      },
      topLevel: 'string',
      count: 42,
      nullable: null,
    };

    // Set multiple complex settings
    const setResult1 = await service.set('complex_setting', complexValue);
    expect(setResult1.ok).toBe(true);

    const setResult2 = await service.set('simple_setting', 'just a string');
    expect(setResult2.ok).toBe(true);

    const setResult3 = await service.set('array_setting', [1, 'two', { three: 3 }]);
    expect(setResult3.ok).toBe(true);

    // Retrieve via getMany
    const getManyResult = await service.getMany([
      'complex_setting',
      'simple_setting',
      'array_setting',
    ]);
    expect(getManyResult.ok).toBe(true);
    if (getManyResult.ok) {
      // Complex nested object preserved
      expect(getManyResult.value.complex_setting).toEqual(complexValue);

      // Simple string preserved
      expect(getManyResult.value.simple_setting).toBe('just a string');

      // Mixed array preserved
      expect(getManyResult.value.array_setting).toEqual([1, 'two', { three: 3 }]);
    }
  });
});
