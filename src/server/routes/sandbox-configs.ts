/**
 * Sandbox configuration CRUD routes
 *
 * Split from sandbox.ts as part of AR-023 (March 2026 architecture review).
 * Handles CRUD operations for sandbox configuration profiles.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { SANDBOX_TYPES } from '../../db/schema/shared/enums.js';
import type { SandboxConfigService } from '../../services/sandbox-config.service.js';
import { errorResponse, json, parseLimit, parseOffset, validateIdParam } from '../shared.js';
import { parseJsonBody } from '../validation.js';
import { validateNomadAddress } from './sandbox-nomad.js';

const sandboxConfigBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  type: z.enum(SANDBOX_TYPES).optional(),
  isDefault: z.boolean().optional(),
  baseImage: z.string().max(500).optional(),
  memoryMb: z.number().int().min(128).max(65536).optional(),
  cpuCores: z.number().min(0.25).max(128).optional(),
  maxProcesses: z.number().int().min(1).max(10000).optional(),
  timeoutMinutes: z.number().int().min(1).max(1440).optional(),
  volumeMountPath: z.string().max(500).optional(),
  kubeConfigPath: z.string().max(500).optional(),
  kubeContext: z.string().max(200).optional(),
  kubeNamespace: z.string().max(200).optional(),
  networkPolicyEnabled: z.boolean().optional(),
  allowedEgressHosts: z.array(z.string().max(500)).optional(),
  nomadAddress: z.string().max(500).optional(),
  nomadToken: z.string().max(500).optional(),
  nomadNamespace: z.string().max(200).optional(),
  nomadDatacenter: z.string().max(200).optional(),
  nomadRegion: z.string().max(200).optional(),
  awsAccessKeyId: z.string().max(128).optional(),
  awsSecretAccessKey: z.string().max(256).optional(),
  awsRegion: z.string().max(64).optional(),
  agentcoreRuntimeArn: z.string().max(2048).optional(),
  ecrRepositoryUri: z.string().max(2048).optional(),
});

const sandboxConfigCreateSchema = sandboxConfigBodySchema.extend({
  name: z.string().min(1).max(200),
});

/** Strip sensitive credential fields from a config before returning it to the client. */
function redactConfig<T extends Record<string, unknown>>(
  config: T
): Omit<T, 'nomadToken' | 'awsSecretAccessKey'> {
  const { nomadToken: _token, awsSecretAccessKey: _awsSecret, ...safe } = config;
  return safe;
}

/** Sensitive fields in sandbox configs that must be encrypted before storage. */
const SANDBOX_CONFIG_SENSITIVE_FIELDS = ['nomadToken', 'awsSecretAccessKey'] as const;

/** Encrypt sensitive credential fields in a sandbox config body before database storage. */
async function encryptSensitiveFields<T extends Record<string, unknown>>(body: T): Promise<T> {
  const copy = { ...body };
  let encryptFn: ((token: string) => string) | null = null;

  for (const field of SANDBOX_CONFIG_SENSITIVE_FIELDS) {
    if (typeof copy[field] === 'string' && copy[field]) {
      if (!encryptFn) {
        const { encryptToken } = await import('../../lib/crypto/server-encryption.js');
        encryptFn = encryptToken;
      }
      (copy as Record<string, unknown>)[field] = encryptFn(copy[field] as string);
    }
  }

  return copy;
}

interface SandboxConfigsDeps {
  sandboxConfigService: SandboxConfigService;
}

export function createSandboxConfigRoutes({ sandboxConfigService }: SandboxConfigsDeps) {
  const app = new Hono();

  // GET /api/sandbox-configs
  app.get('/', async (c) => {
    const limit = parseLimit(c);
    const offset = parseOffset(c);

    const result = await sandboxConfigService.list({ limit, offset });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: {
        items: result.value.items.map((item) => redactConfig(item)),
        totalCount: result.value.totalCount,
      },
    });
  });

  // POST /api/sandbox-configs
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, sandboxConfigCreateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (body.nomadAddress) {
      const addrValidation = await validateNomadAddress(body.nomadAddress);
      if (!addrValidation.valid) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVALID_ADDRESS',
              message: addrValidation.error,
            },
          },
          400
        );
      }
    }

    const encryptedBody = await encryptSensitiveFields(body);
    const result = await sandboxConfigService.create(encryptedBody);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: redactConfig(result.value) }, 201);
  });

  // GET /api/sandbox-configs/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await sandboxConfigService.getById(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: redactConfig(result.value) });
  });

  // PATCH /api/sandbox-configs/:id
  app.patch('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, sandboxConfigBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (body.nomadAddress) {
      const addrValidation = await validateNomadAddress(body.nomadAddress);
      if (!addrValidation.valid) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVALID_ADDRESS',
              message: addrValidation.error,
            },
          },
          400
        );
      }
    }

    const encryptedBody = await encryptSensitiveFields(body);
    const result = await sandboxConfigService.update(id, encryptedBody);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: redactConfig(result.value) });
  });

  // DELETE /api/sandbox-configs/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await sandboxConfigService.delete(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: null });
  });

  return app;
}
