import { eq, inArray } from 'drizzle-orm';
import type { Setting } from '../db/schema';
import { settings } from '../db/schema';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../lib/constants/models.js';
import type { AppError } from '../lib/errors/base.js';
import { createError } from '../lib/errors/base.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

const log = createLogger('SettingsService');

/** Settings key for the global default agent model */
const DEFAULT_MODEL_KEY = 'default_model';

/** Settings key for the global agent max runtime in milliseconds */
export const AGENT_MAX_RUNTIME_KEY = 'agent.maxRuntimeMs';

/** Default agent max runtime: 4 hours (14,400,000 ms) */
export const DEFAULT_AGENT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

/**
 * Read the agent max runtime from env var, DB setting, or default.
 * Resolution order:
 *   1. process.env.AGENT_MAX_RUNTIME_MS (if set and > 0)
 *   2. DB setting 'agent.maxRuntimeMs' (if set)
 *   3. Default: 4 hours (14,400,000 ms)
 */
export async function getAgentMaxRuntimeMs(db: Database): Promise<number> {
  // 1. Env var override takes highest precedence
  const envVal = Number(process.env.AGENT_MAX_RUNTIME_MS);
  if (envVal > 0) {
    return envVal;
  }

  // 2. DB setting
  try {
    const row = await db.query.settings.findFirst({
      where: eq(settings.key, AGENT_MAX_RUNTIME_KEY),
    });
    if (row?.value) {
      const parsed = JSON.parse(row.value) as number;
      if (typeof parsed === 'number' && parsed > 0) {
        return parsed;
      }
    }
  } catch (e) {
    log.warn('Failed to read agent max runtime from settings, falling back to default.', {
      error: e,
    });
  }

  // 3. Hardcoded default
  return DEFAULT_AGENT_MAX_RUNTIME_MS;
}

/**
 * Read the global default model from the database settings table.
 * Returns the full API model ID (e.g. 'claude-opus-4-5-20251101'),
 * or undefined if the setting is not found or cannot be parsed,
 * allowing callers to fall through to a hardcoded default.
 */
export async function getGlobalDefaultModel(db: Database): Promise<string | undefined> {
  try {
    const row = await db.query.settings.findFirst({
      where: eq(settings.key, DEFAULT_MODEL_KEY),
    });
    if (row?.value) {
      const raw = JSON.parse(row.value) as string;
      return getFullModelId(raw);
    }
  } catch {
    // EH-021: Bare catch blocks are acceptable for optional operations like settings
    // lookups. The caller applies its own default when the setting is unavailable.
    // This pattern is used consistently across ~30 catch blocks in the codebase.
  }
  return undefined;
}

export type SettingsError = AppError;

export const SettingsErrors = {
  NOT_FOUND: createError('SETTING_NOT_FOUND', 'Setting not found', 404),
  INVALID_KEY: createError('INVALID_SETTING_KEY', 'Setting key is invalid', 400),
  INVALID_VALUE: createError('INVALID_SETTING_VALUE', 'Setting value is invalid', 400),
  DATABASE_ERROR: (message: string) => createError('SETTINGS_DATABASE_ERROR', message, 500),
};

export class SettingsService {
  constructor(private db: Database) {}

  /**
   * Read the global default model from the database settings table.
   * Returns the full API model ID (e.g. 'claude-opus-4-5-20251101'),
   * or undefined if the setting is not found or cannot be parsed,
   * allowing callers to fall through to a hardcoded default.
   *
   * SL-020: Instance method version of the standalone getGlobalDefaultModel function.
   */
  async getGlobalDefaultModel(): Promise<string | undefined> {
    return getGlobalDefaultModel(this.db);
  }

  /**
   * Get the agent max runtime in milliseconds.
   * Resolution: env var > DB setting > default (4 hours).
   *
   * Instance method version of the standalone getAgentMaxRuntimeMs function.
   */
  async getAgentMaxRuntimeMs(): Promise<number> {
    return getAgentMaxRuntimeMs(this.db);
  }

  /**
   * Get a single setting by key
   */
  async get(key: string): Promise<Result<Setting | null, SettingsError>> {
    try {
      const setting = await this.db.query.settings.findFirst({
        where: eq(settings.key, key),
      });
      return ok(setting ?? null);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  /**
   * Get multiple settings by keys
   * Returns a map of key -> value (parsed JSON, or raw string if parsing fails)
   */
  async getMany(keys: string[]): Promise<Result<Record<string, unknown>, SettingsError>> {
    try {
      if (keys.length === 0) {
        return ok({});
      }

      const results = await this.db.query.settings.findMany({
        where: inArray(settings.key, keys),
      });

      const settingsMap: Record<string, unknown> = {};
      for (const setting of results) {
        try {
          settingsMap[setting.key] = JSON.parse(setting.value);
        } catch (_parseError) {
          settingsMap[setting.key] = setting.value;
        }
      }

      return ok(settingsMap);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  /**
   * Get all settings
   * Returns a map of key -> value (parsed JSON, or raw string if parsing fails)
   */
  async getAll(): Promise<Result<Record<string, unknown>, SettingsError>> {
    try {
      const results = await this.db.query.settings.findMany();

      const settingsMap: Record<string, unknown> = {};
      for (const setting of results) {
        try {
          settingsMap[setting.key] = JSON.parse(setting.value);
        } catch (_parseError) {
          settingsMap[setting.key] = setting.value;
        }
      }

      return ok(settingsMap);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  /**
   * Set a single setting
   */
  async set(key: string, value: unknown): Promise<Result<Setting, SettingsError>> {
    try {
      if (!key || typeof key !== 'string' || key.length === 0) {
        return err(SettingsErrors.INVALID_KEY);
      }

      const serializedValue = JSON.stringify(value);
      const now = new Date().toISOString();

      // Use upsert (insert or replace on conflict)
      const [result] = await this.db
        .insert(settings)
        .values({
          key,
          value: serializedValue,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: serializedValue,
            updatedAt: now,
          },
        })
        .returning();

      if (!result) {
        return err(SettingsErrors.DATABASE_ERROR('Failed to save setting'));
      }

      return ok(result);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  /**
   * Set multiple settings at once
   */
  async setMany(settingsToSet: Record<string, unknown>): Promise<Result<void, SettingsError>> {
    try {
      const entries = Object.entries(settingsToSet);
      if (entries.length === 0) {
        return ok(undefined);
      }

      const now = new Date().toISOString();

      // Use a transaction to ensure atomicity
      await this.db.transaction(async (tx) => {
        for (const [key, value] of entries) {
          const serializedValue = JSON.stringify(value);
          await tx
            .insert(settings)
            .values({
              key,
              value: serializedValue,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: settings.key,
              set: {
                value: serializedValue,
                updatedAt: now,
              },
            });
        }
      });

      return ok(undefined);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  /**
   * Delete a setting by key
   */
  async delete(key: string): Promise<Result<void, SettingsError>> {
    try {
      await this.db.delete(settings).where(eq(settings.key, key));
      return ok(undefined);
    } catch (error) {
      return err(SettingsErrors.DATABASE_ERROR(String(error)));
    }
  }

  // ============================================
  // Typed getters/setters for known settings
  // ============================================

  private static readonly TASK_CREATION_MODEL_KEY = 'taskCreation.model';
  private static readonly TASK_CREATION_TOOLS_KEY = 'taskCreation.tools';
  private static readonly DEFAULT_MODEL = getFullModelId(DEFAULT_AGENT_MODEL);
  private static readonly DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'AskUserQuestion'];

  /**
   * Get a setting value by key, returning defaultValue if not found
   */
  async getValue<T>(key: string, defaultValue: T): Promise<T> {
    const result = await this.get(key);
    if (!result.ok || !result.value) {
      return defaultValue;
    }
    try {
      return JSON.parse(result.value.value) as T;
    } catch (_parseError) {
      return defaultValue;
    }
  }

  /**
   * Get the model used for AI task creation
   */
  async getTaskCreationModel(): Promise<string> {
    return this.getValue<string>(
      SettingsService.TASK_CREATION_MODEL_KEY,
      SettingsService.DEFAULT_MODEL
    );
  }

  /**
   * Set the model used for AI task creation
   */
  async setTaskCreationModel(model: string): Promise<Result<void, SettingsError>> {
    const result = await this.set(SettingsService.TASK_CREATION_MODEL_KEY, model);
    if (!result.ok) {
      return err(result.error);
    }
    return ok(undefined);
  }

  /**
   * Get the tools available for AI task creation
   */
  async getTaskCreationTools(): Promise<string[]> {
    return this.getValue<string[]>(
      SettingsService.TASK_CREATION_TOOLS_KEY,
      SettingsService.DEFAULT_TOOLS
    );
  }

  /**
   * Set the tools available for AI task creation
   */
  async setTaskCreationTools(tools: string[]): Promise<Result<void, SettingsError>> {
    const result = await this.set(SettingsService.TASK_CREATION_TOOLS_KEY, tools);
    if (!result.ok) {
      return err(result.error);
    }
    return ok(undefined);
  }
}
