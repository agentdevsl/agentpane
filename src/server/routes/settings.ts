/**
 * Settings routes
 *
 * Thin route handlers that delegate to SettingsService.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger';
import type { SettingsService } from '../../services/settings.service.js';
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
  'github.app.credentials',
  'theme',
  'general.agentModel',
  'memory.enabled',
  'memory.contextMaxTokens',
  'memory.captureEnabled',
  'memory.captureMinTurnLength',
  'memory.dreaming.enabled',
  'memory.dreaming.intervalHours',
  'memory.dreaming.maxTokensPerCycle',
  'memory.dreaming.minRunsForAnalysis',
  'memory.dreaming.model',
  'retention.sessionEventsDays',
  'retention.eventLogDays',
  'agent.maxRuntimeMs',
  'sandbox.env',
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
  settingsService: SettingsService;
}

export function createSettingsRoutes({ settingsService }: SettingsDeps) {
  const app = new Hono();

  // GET /api/settings
  app.get('/', async (c) => {
    const keysParam = c.req.query('keys');

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

    // Use service to get settings
    const result =
      keys.length > 0 ? await settingsService.getMany(keys) : await settingsService.getAll();

    if (!result.ok) {
      log.error('Failed to get settings', {
        error: new Error(result.error.message),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' } },
        500
      );
    }

    const settingsMap = result.value;

    // Redact sensitive fields
    for (const [key, value] of Object.entries(settingsMap)) {
      const sensitive = SENSITIVE_FIELDS[key];
      if (sensitive && typeof value === 'object' && value !== null) {
        const copy = value as Record<string, unknown>;
        if (copy[sensitive.secretKey]) {
          copy[sensitive.flagKey] = true;
          delete copy[sensitive.secretKey];
        }
      }
    }

    return json({ ok: true, data: { settings: settingsMap } });
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

    const settingsToUpdate = parsed.data.settings;

    // Filter to allowed keys and handle sensitive field encryption
    const filteredSettings: Record<string, unknown> = {};

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

      filteredSettings[key] = dbValue;
    }

    // Use service to set all filtered settings
    const result = await settingsService.setMany(filteredSettings);

    if (!result.ok) {
      log.error('Failed to update settings', {
        error: new Error(result.error.message),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' } },
        500
      );
    }

    return json({ ok: true });
  });

  return app;
}
