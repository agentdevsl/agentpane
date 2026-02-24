/**
 * Settings routes
 */

import { eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';

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
          // Redact sensitive tokens before returning to client
          if (row.key === 'sandbox.nomad') {
            const parsed = JSON.parse(row.value);
            if (parsed.token) {
              parsed.hasToken = true;
              delete parsed.token;
            }
            settingsMap[row.key] = parsed;
            continue;
          }

          settingsMap[row.key] = JSON.parse(row.value);
        } catch (parseError) {
          // Log warning for potential data corruption - falling back to raw string
          console.warn(
            `[Settings] Failed to parse JSON for key "${row.key}":`,
            parseError instanceof Error ? parseError.message : 'parse error'
          );
          settingsMap[row.key] = row.value;
        }
      }

      return json({ ok: true, data: { settings: settingsMap } });
    } catch (error) {
      console.error('[API] Error getting settings:', error);
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

      // Upsert each setting
      for (const [key, value] of Object.entries(settingsToUpdate)) {
        // Encrypt sensitive tokens before storage
        if (key === 'sandbox.nomad' && typeof value === 'object' && value !== null) {
          const nomadVal = value as Record<string, unknown>;
          if (nomadVal.token && typeof nomadVal.token === 'string') {
            const { encryptToken } = await import('../../lib/crypto/server-encryption.js');
            nomadVal.token = encryptToken(nomadVal.token);
          }
        }

        const jsonValue = JSON.stringify(value);
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
      console.error('[API] Error updating settings:', error);
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' } },
        500
      );
    }
  });

  return app;
}
