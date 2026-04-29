/**
 * Terraform routes
 */

import { Hono } from 'hono';
import { RBAC_ROLE_LEVEL } from '../../db/schema/shared/enums.js';
import { createLogger } from '../../lib/logging/logger.js';

const log = createLogger('terraform-routes');

import type { AuthContext } from '../../lib/api/auth-middleware.js';
import {
  composeRequestSchema,
  createRegistrySchema,
  updateRegistrySchema,
} from '../../lib/terraform/schema.js';
import type { TerraformComposeService } from '../../services/terraform-compose.service.js';
import type { TerraformRegistryService } from '../../services/terraform-registry.service.js';
import { errorResponse, json, validateIdParam } from '../shared.js';
import { parseJsonBody, terraformValidateSchema } from '../validation.js';

interface TerraformDeps {
  terraformRegistryService: TerraformRegistryService;
  terraformComposeService: TerraformComposeService;
}

/**
 * Strip the internal tokenSettingKey before returning registry data to the client.
 * `hasToken` indicates whether a token settings key is configured for this registry.
 */
function omitTokenKey<T extends { tokenSettingKey: string }>(
  registry: T
): Omit<T, 'tokenSettingKey'> & { hasToken: boolean } {
  const { tokenSettingKey, ...rest } = registry;
  return { ...rest, hasToken: !!tokenSettingKey };
}

function requireTerraformAdmin(c: {
  get: (key: 'auth') => AuthContext | undefined;
}): Response | null {
  const auth = c.get('auth');
  const roleLevel = auth?.roleLevel ?? 0;

  if (auth?.authMethod === 'dev') {
    return null;
  }

  if (roleLevel < RBAC_ROLE_LEVEL.admin) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } }, 403);
  }

  return null;
}

export function createTerraformRoutes({
  terraformRegistryService,
  terraformComposeService,
}: TerraformDeps) {
  const app = new Hono();

  // GET /registries — list all registries
  app.get('/registries', async (_c) => {
    const result = await terraformRegistryService.listRegistries();
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: {
        items: result.value.map((r) => ({
          id: r.id,
          name: r.name,
          orgName: r.orgName,
          hasToken: true,
          status: r.status,
          lastSyncedAt: r.lastSyncedAt,
          syncError: r.syncError,
          moduleCount: r.moduleCount,
          syncIntervalMinutes: r.syncIntervalMinutes,
          nextSyncAt: r.nextSyncAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        totalCount: result.value.length,
      },
    });
  });

  // POST /registries — create registry
  app.post('/registries', async (c) => {
    const denied = requireTerraformAdmin(c);
    if (denied) {
      return denied;
    }

    const parsed = await parseJsonBody(c, createRegistrySchema);
    if (!parsed.ok) return parsed.response;

    const result = await terraformRegistryService.createRegistry(parsed.data);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: omitTokenKey(result.value) }, 201);
  });

  // GET /registries/:id — get registry detail
  app.get('/registries/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await terraformRegistryService.getRegistryById(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: omitTokenKey(result.value) });
  });

  // DELETE /registries/:id — delete registry
  app.delete('/registries/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const denied = requireTerraformAdmin(c);
    if (denied) {
      return denied;
    }

    const result = await terraformRegistryService.deleteRegistry(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { deleted: true } });
  });

  // PATCH /registries/:id — update registry settings
  app.patch('/registries/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const denied = requireTerraformAdmin(c);
    if (denied) {
      return denied;
    }

    const parsed = await parseJsonBody(c, updateRegistrySchema);
    if (!parsed.ok) return parsed.response;

    const result = await terraformRegistryService.updateRegistry(id, parsed.data);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: omitTokenKey(result.value) });
  });

  // POST /registries/:id/sync — trigger manual sync
  app.post('/registries/:id/sync', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const denied = requireTerraformAdmin(c);
    if (denied) {
      return denied;
    }

    log.info(`Syncing registry ${id}`);
    const result = await terraformRegistryService.sync(id);
    if (!result.ok) {
      log.error(`Sync failed for ${id}`, { error: result.error });
      return errorResponse(result);
    }

    log.info(`Synced ${result.value.moduleCount} modules for ${id}`);
    return json({ ok: true, data: result.value });
  });

  // GET /modules — list all modules
  app.get('/modules', async (c) => {
    const search = c.req.query('search') ?? undefined;
    const provider = c.req.query('provider') ?? undefined;
    const registryId = c.req.query('registryId') ?? undefined;
    const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;

    const result = await terraformRegistryService.listModules({
      search,
      provider,
      registryId,
      limit,
    });
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: {
        items: result.value,
        totalCount: result.value.length,
      },
    });
  });

  // GET /modules/:id — module detail
  app.get('/modules/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await terraformRegistryService.getModuleById(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // POST /validate — validate generated HCL code using @cdktf/hcl2json
  app.post('/validate', async (c) => {
    const parsed = await parseJsonBody(c, terraformValidateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    try {
      const result = await terraformComposeService.validateCode(body.code, body.tfvars);
      return json({ ok: true, data: result });
    } catch (error) {
      log.error('Validate error', { error });
      return json(
        {
          ok: false,
          error: { code: 'VALIDATE_ERROR', message: 'Failed to validate Terraform code' },
        },
        500
      );
    }
  });

  // POST /compose — start a compose job (returns immediately with sessionId)
  app.post('/compose', async (c) => {
    const parsed = await parseJsonBody(c, composeRequestSchema);
    if (!parsed.ok) return parsed.response;

    const result = await terraformComposeService.startCompose(
      parsed.data.sessionId,
      parsed.data.messages,
      parsed.data.registryId,
      parsed.data.composeMode
    );

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 202);
  });

  // NOTE: SSE endpoint removed — clients subscribe to Caddy durable streams
  // at /v1/stream/terraform/{sessionId} directly.

  return app;
}
