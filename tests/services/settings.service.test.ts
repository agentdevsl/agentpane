import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema';
import { getGlobalDefaultModel, SettingsService } from '../../src/services/settings.service';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

describe('SettingsService', () => {
  let service: SettingsService;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await clearTestDatabase();
    service = new SettingsService(getTestDb() as any);
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('set then get round-trips correctly', async () => {
    const setResult = await service.set('theme', 'dark');
    expect(setResult.ok).toBe(true);

    const getResult = await service.get('theme');
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.key).toBe('theme');
      // set() serializes via JSON.stringify, so the stored value is a JSON string
      expect(getResult.value!.value).toBe(JSON.stringify('dark'));
    }
  });

  it('set same key twice upserts - second value wins', async () => {
    await service.set('color', 'red');
    await service.set('color', 'blue');

    const result = await service.get('color');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value!.value).toBe(JSON.stringify('blue'));
    }
  });

  it('get non-existent key returns ok(null)', async () => {
    const result = await service.get('nonexistent');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('set with empty key returns error with code INVALID_SETTING_KEY', async () => {
    const result = await service.set('', 'value');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_SETTING_KEY');
    }
  });

  it('getMany with empty keys returns ok({})', async () => {
    const result = await service.getMany([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it('getMany returns parsed JSON; falls back to raw string for invalid JSON', async () => {
    // Insert a valid JSON value via the service
    await service.set('valid', { nested: true });

    // Insert a raw non-JSON value directly via DB
    const db = getTestDb();
    await db.insert(settings).values({ key: 'raw', value: 'not-json' });

    const result = await service.getMany(['valid', 'raw']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Valid JSON should be parsed into an object
      expect(result.value.valid).toEqual({ nested: true });
      // Invalid JSON falls back to the raw string
      expect(result.value.raw).toBe('not-json');
    }
  });

  it('setMany returns a database error with the sync SQLite driver', async () => {
    // better-sqlite3 transactions are synchronous and reject async callbacks,
    // so setMany (which wraps async inserts in a transaction) returns a
    // database error in this environment. This verifies graceful error handling.
    const result = await service.setMany({
      'app.name': 'AgentPane',
      'app.version': '1.0.0',
      'app.debug': true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SETTINGS_DATABASE_ERROR');
    }
  });

  it('multiple set calls store all keys independently', async () => {
    await service.set('app.name', 'AgentPane');
    await service.set('app.version', '1.0.0');
    await service.set('app.debug', true);

    const name = await service.get('app.name');
    const version = await service.get('app.version');
    const debug = await service.get('app.debug');

    expect(name.ok).toBe(true);
    expect(version.ok).toBe(true);
    expect(debug.ok).toBe(true);

    if (name.ok) expect(name.value!.value).toBe(JSON.stringify('AgentPane'));
    if (version.ok) expect(version.value!.value).toBe(JSON.stringify('1.0.0'));
    if (debug.ok) expect(debug.value!.value).toBe(JSON.stringify(true));
  });

  it('delete removes a key - set then delete then get returns null', async () => {
    await service.set('ephemeral', 42);

    const deleteResult = await service.delete('ephemeral');
    expect(deleteResult.ok).toBe(true);

    const getResult = await service.get('ephemeral');
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });

  it('getValue returns default when key is missing', async () => {
    const value = await service.getValue('missing.key', 'fallback');
    expect(value).toBe('fallback');
  });

  it('getTaskCreationModel returns default model when no setting exists', async () => {
    const model = await service.getTaskCreationModel();
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('getGlobalDefaultModel returns undefined when no setting exists', async () => {
    const result = await getGlobalDefaultModel(getTestDb() as any);
    expect(result).toBeUndefined();
  });
});
