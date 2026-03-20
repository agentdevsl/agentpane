/**
 * API Key routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';
import type { ApiKeyService } from '../../services/api-key.service.js';
import { json } from '../shared.js';

const log = createLogger('ApiKeysRoutes');

// AR-029: Validate the service parameter against a known set of supported services.
// This prevents storing keys for unknown/unsupported services.
const KNOWN_API_KEY_SERVICES = ['anthropic', 'github'] as const;
type KnownService = (typeof KNOWN_API_KEY_SERVICES)[number];

function isKnownService(service: string): service is KnownService {
  return (KNOWN_API_KEY_SERVICES as readonly string[]).includes(service);
}

// Validation schemas
const saveKeySchema = z.object({
  key: z.string().min(1, 'API key is required'),
});

interface ApiKeysDeps {
  apiKeyService: ApiKeyService;
}

export function createApiKeysRoutes({ apiKeyService }: ApiKeysDeps) {
  const app = new Hono();

  // GET /api/keys/:service
  app.get('/:service', async (c) => {
    const service = c.req.param('service');

    // AR-029: Validate service against known set
    if (!isKnownService(service)) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Unknown service "${service}". Must be one of: ${KNOWN_API_KEY_SERVICES.join(', ')}`,
          },
        },
        400
      );
    }

    const result = await apiKeyService.getKeyInfo(service);

    if (!result.ok) {
      log.error('Get key info error', {
        error: result.error instanceof Error ? result.error : new Error(String(result.error)),
        data: { service },
      });
      return json({ ok: false, error: result.error }, 500);
    }

    return json({ ok: true, data: { keyInfo: result.value } });
  });

  // POST /api/keys/:service
  app.post('/:service', async (c) => {
    const service = c.req.param('service');

    // AR-029: Validate service against known set
    if (!isKnownService(service)) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Unknown service "${service}". Must be one of: ${KNOWN_API_KEY_SERVICES.join(', ')}`,
          },
        },
        400
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = saveKeySchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400
      );
    }

    const result = await apiKeyService.saveKey(service, parsed.data.key);

    if (!result.ok) {
      log.error('Save key error', {
        error: result.error instanceof Error ? result.error : new Error(String(result.error)),
        data: { service },
      });
      return json({ ok: false, error: result.error }, 400);
    }

    return json({ ok: true, data: { keyInfo: result.value } });
  });

  // DELETE /api/keys/:service
  app.delete('/:service', async (c) => {
    const service = c.req.param('service');

    // AR-029: Validate service against known set
    if (!isKnownService(service)) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Unknown service "${service}". Must be one of: ${KNOWN_API_KEY_SERVICES.join(', ')}`,
          },
        },
        400
      );
    }

    const result = await apiKeyService.deleteKey(service);

    if (!result.ok) {
      log.error('Delete key error', {
        error: result.error instanceof Error ? result.error : new Error(String(result.error)),
        data: { service },
      });
      return json({ ok: false, error: result.error }, 500);
    }

    return json({ ok: true, data: null });
  });

  return app;
}
