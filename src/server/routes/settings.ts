/**
 * Settings routes
 *
 * Thin route handlers that delegate to SettingsService.
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger';
import { isDigestPinnedImage } from '../../lib/sandbox/types.js';
import type { SettingsService } from '../../services/settings.service.js';
import { json } from '../shared.js';
import { parseJsonBody, updateSettingsSchema } from '../validation.js';

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
  'approval.mode',
  'approval.reviewModel',
]);

const SENSITIVE_FIELDS: Record<string, { secretKey: string; flagKey: string }> = {
  'sandbox.nomad': { secretKey: 'token', flagKey: 'hasToken' },
  'sandbox.agentcore': { secretKey: 'secretAccessKey', flagKey: 'hasSecretAccessKey' },
};

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
    const parsed = await parseJsonBody(c, updateSettingsSchema);
    if (!parsed.ok) return parsed.response;

    const settingsToUpdate = parsed.data.settings;

    // Filter to allowed keys and handle sensitive field encryption
    const filteredSettings: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(settingsToUpdate)) {
      if (!ALLOWED_SETTINGS_KEYS.has(key)) {
        continue; // Silently skip unknown keys
      }

      // arch29-W1-C / F04-02 — validate `sandbox.defaults.image` is digest-pinned.
      // The previous schema accepted `z.unknown()` which let an admin override
      // `sandbox.defaults.image` to a tag-only ref like `evil/repo:latest` via
      // the UI, bypassing `validateImage()` on the codespace CRUD path. Reject
      // tag-only refs at the boundary so the value can never reach
      // `loadSandboxDefaultsFromDb()` → `provider.create()`.
      if (key === 'sandbox.defaults' && typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        if (typeof obj.image === 'string' && obj.image.length > 0) {
          if (!isDigestPinnedImage(obj.image)) {
            return json(
              {
                ok: false,
                error: {
                  code: 'IMAGE_TAG_REQUIRED_DIGEST',
                  message:
                    "sandbox.defaults.image must be digest-pinned ('<image>@sha256:<64 hex>'). Tag-only references (e.g. ':latest') are rejected for supply-chain safety.",
                  details: { image: obj.image },
                },
              },
              400
            );
          }
        }
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
