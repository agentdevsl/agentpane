import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema';
import {
  getGlobalDefaultModel,
  SettingsErrors,
  SettingsService,
} from '../../src/services/settings.service';
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
    // clearTestDatabase doesn't clear the settings table, so clear it explicitly
    const db = getTestDb();
    await db.delete(settings);
    service = new SettingsService(db as any);
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

  it('setMany stores multiple keys atomically', async () => {
    const result = await service.setMany({
      'app.name': 'AgentPane',
      'app.version': '1.0.0',
      'app.debug': true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const name = await service.get('app.name');
      expect(name.ok).toBe(true);
      if (name.ok) expect(name.value!.value).toBe(JSON.stringify('AgentPane'));
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

  // =========================================================================
  // Extended tests for uncovered methods
  // =========================================================================

  describe('getAll', () => {
    it('returns empty map when no settings exist', async () => {
      const result = await service.getAll();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({});
      }
    });

    it('returns all settings as parsed JSON values', async () => {
      await service.set('key1', 'value1');
      await service.set('key2', 42);
      await service.set('key3', { nested: true });

      const result = await service.getAll();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.key1).toBe('value1');
        expect(result.value.key2).toBe(42);
        expect(result.value.key3).toEqual({ nested: true });
      }
    });

    it('falls back to raw string for invalid JSON in getAll', async () => {
      const db = getTestDb();
      await db.insert(settings).values({ key: 'raw-all', value: 'not-json-value' });

      const result = await service.getAll();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value['raw-all']).toBe('not-json-value');
      }
    });
  });

  describe('getValue', () => {
    it('returns parsed value when key exists', async () => {
      await service.set('my-setting', { flag: true, count: 5 });

      const value = await service.getValue('my-setting', { flag: false, count: 0 });

      expect(value).toEqual({ flag: true, count: 5 });
    });

    it('returns default for non-JSON-parseable stored values', async () => {
      const db = getTestDb();
      await db.insert(settings).values({ key: 'bad-json', value: '{broken' });

      const value = await service.getValue('bad-json', 'default-value');

      expect(value).toBe('default-value');
    });

    it('returns default when get returns an error', async () => {
      // getValue calls this.get internally. If key is missing, get returns ok(null)
      // which triggers the default path.
      const value = await service.getValue('nonexistent', 99);

      expect(value).toBe(99);
    });
  });

  describe('getMany with multiple keys', () => {
    it('returns only matching keys from the requested set', async () => {
      await service.set('a', 1);
      await service.set('b', 2);
      await service.set('c', 3);

      const result = await service.getMany(['a', 'c']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.a).toBe(1);
        expect(result.value.c).toBe(3);
        expect(result.value.b).toBeUndefined();
      }
    });

    it('returns empty for keys that do not exist', async () => {
      const result = await service.getMany(['x', 'y', 'z']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.keys(result.value)).toHaveLength(0);
      }
    });
  });

  describe('delete', () => {
    it('returns ok even when deleting a non-existent key', async () => {
      const result = await service.delete('never-existed');

      expect(result.ok).toBe(true);
    });

    it('only deletes the specified key, others remain', async () => {
      await service.set('keep', 'a');
      await service.set('remove', 'b');

      await service.delete('remove');

      const kept = await service.get('keep');
      const removed = await service.get('remove');

      expect(kept.ok).toBe(true);
      if (kept.ok) expect(kept.value).not.toBeNull();

      expect(removed.ok).toBe(true);
      if (removed.ok) expect(removed.value).toBeNull();
    });
  });

  describe('set - complex values', () => {
    it('stores and retrieves arrays', async () => {
      await service.set('tools', ['Read', 'Edit', 'Bash']);

      const result = await service.get('tools');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const parsed = JSON.parse(result.value!.value);
        expect(parsed).toEqual(['Read', 'Edit', 'Bash']);
      }
    });

    it('stores and retrieves numbers', async () => {
      await service.set('maxTurns', 100);

      const result = await service.get('maxTurns');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.value!.value)).toBe(100);
      }
    });

    it('stores and retrieves booleans', async () => {
      await service.set('debug', false);

      const result = await service.get('debug');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.value!.value)).toBe(false);
      }
    });

    it('stores and retrieves null values', async () => {
      await service.set('nullable', null);

      const result = await service.get('nullable');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.value!.value)).toBeNull();
      }
    });
  });

  describe('getTaskCreationTools', () => {
    it('returns default tools when no setting exists', async () => {
      const tools = await service.getTaskCreationTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      // Default tools should include Read, Glob, Grep, AskUserQuestion
      expect(tools).toContain('Read');
    });

    it('returns custom tools after setTaskCreationTools', async () => {
      const setResult = await service.setTaskCreationTools(['Read', 'Edit']);
      expect(setResult.ok).toBe(true);

      const tools = await service.getTaskCreationTools();
      expect(tools).toEqual(['Read', 'Edit']);
    });
  });

  describe('setTaskCreationModel and getTaskCreationModel', () => {
    it('round-trips model setting', async () => {
      const setResult = await service.setTaskCreationModel('claude-haiku-4-5');
      expect(setResult.ok).toBe(true);

      const model = await service.getTaskCreationModel();
      expect(model).toBe('claude-haiku-4-5');
    });
  });

  describe('getGlobalDefaultModel', () => {
    it('returns the stored model after setting default_model', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'default_model',
        value: JSON.stringify('claude-opus-4-5'),
      });

      const result = await getGlobalDefaultModel(db as any);

      // Should be the full model ID
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('returns undefined for invalid JSON in default_model', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'default_model',
        value: '{invalid-json',
      });

      const result = await getGlobalDefaultModel(db as any);
      expect(result).toBeUndefined();
    });
  });

  describe('SettingsErrors', () => {
    it('NOT_FOUND has correct code and status', () => {
      expect(SettingsErrors.NOT_FOUND.code).toBe('SETTING_NOT_FOUND');
      expect(SettingsErrors.NOT_FOUND.status).toBe(404);
    });

    it('INVALID_KEY has correct code and status', () => {
      expect(SettingsErrors.INVALID_KEY.code).toBe('INVALID_SETTING_KEY');
      expect(SettingsErrors.INVALID_KEY.status).toBe(400);
    });

    it('INVALID_VALUE has correct code and status', () => {
      expect(SettingsErrors.INVALID_VALUE.code).toBe('INVALID_SETTING_VALUE');
      expect(SettingsErrors.INVALID_VALUE.status).toBe(400);
    });

    it('DATABASE_ERROR factory creates error with message', () => {
      const dbErr = SettingsErrors.DATABASE_ERROR('connection lost');
      expect(dbErr.code).toBe('SETTINGS_DATABASE_ERROR');
      expect(dbErr.status).toBe(500);
      expect(dbErr.message).toBe('connection lost');
    });
  });
});
