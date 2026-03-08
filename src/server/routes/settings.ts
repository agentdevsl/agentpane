/**
 * Settings routes
 */

import { eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import * as schema from '../../db/schema/index.js';
import { createLogger } from '../../lib/logging/logger';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';

const log = createLogger('SettingsRoutes');

// Allowlist of settings keys that can be written via the PUT endpoint.
// Any key not in this list is silently rejected to prevent overwriting
// unexpected settings or internal state.
const ALLOWED_SETTINGS_KEYS = new Set([
  'sandbox.defaults',
  'sandbox.mode',
  'sandbox.provider',
  'sandbox.kubernetes',
  'sandbox.nomad',
  'sandbox.agentcore',
  'anthropic.apiKey',
  'anthropic.model',
  'github.token',
  'github.appId',
  'theme',
  'general.agentModel',
]);

const SENSITIVE_FIELDS: Record<string, { secretKey: string; flagKey: string }> = {
  'sandbox.nomad': { secretKey: 'token', flagKey: 'hasToken' },
  'sandbox.agentcore': { secretKey: 'secretAccessKey', flagKey: 'hasSecretAccessKey' },
};

// Validation schemas
const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

interface SettingsDeps {
  db: Database;
}

export function createSettingsRoutes({ db }: SettingsDeps) {
  const app = new Hono();

  // GET /api/settings
  app.get('/', async (c) => {
    const keysParam = c.req.query('keys');

    try {
      // Build query based on whether specific keys are requested
      const keys = keysParam
        ? keysParam
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : [];

      if (keysParam && keys.length === 0) {
        return json({ ok: true, data: { settings: {} } });
      }

      const results =
        keys.length > 0
          ? await db
              .select()
              .from(schema.settings)
              .where(or(...keys.map((k) => eq(schema.settings.key, k))))
          : await db.select().from(schema.settings);

      // Parse JSON values, falling back to raw string if invalid
      const settingsMap: Record<string, unknown> = {};
      for (const row of results) {
        try {
          const parsed = JSON.parse(row.value);
          const sensitive = SENSITIVE_FIELDS[row.key];
          if (
            sensitive &&
            typeof parsed === 'object' &&
            parsed !== null &&
            parsed[sensitive.secretKey]
          ) {
            parsed[sensitive.flagKey] = true;
            delete parsed[sensitive.secretKey];
          }
          settingsMap[row.key] = parsed;
        } catch (parseError) {
          log.warn('Failed to parse JSON for settings key', {
            error: parseError instanceof Error ? parseError : new Error('parse error'),
            data: { key: row.key },
          });
          settingsMap[row.key] = row.value;
        }
      }

      return json({ ok: true, data: { settings: settingsMap } });
    } catch (error) {
      log.error('Failed to get settings', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' } },
        500
      );
    }
  });

  // PUT /api/settings
  app.put('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = updateSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'settings object is required',
          },
        },
        400
      );
    }

    try {
      const settingsToUpdate = parsed.data.settings;

      // Upsert each setting (only allowed keys)
      for (const [key, value] of Object.entries(settingsToUpdate)) {
        if (!ALLOWED_SETTINGS_KEYS.has(key)) {
          continue; // Silently skip unknown keys
        }

        let dbValue = value;
        const sensitive = SENSITIVE_FIELDS[key];
        if (sensitive && typeof value === 'object' && value !== null) {
          const copy = { ...(value as Record<string, unknown>) };
          if (copy[sensitive.secretKey] && typeof copy[sensitive.secretKey] === 'string') {
            const { encryptToken } = await import('../../lib/crypto/server-encryption.js');
            copy[sensitive.secretKey] = encryptToken(copy[sensitive.secretKey] as string);
          }
          dbValue = copy;
        }

        const jsonValue = JSON.stringify(dbValue);
        await db
          .insert(schema.settings)
          .values({ key, value: jsonValue })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: jsonValue, updatedAt: new Date().toISOString() },
          });
      }

      return json({ ok: true });
    } catch (error) {
      log.error('Failed to update settings', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' } },
        500
      );
    }
  });

  return app;
}
