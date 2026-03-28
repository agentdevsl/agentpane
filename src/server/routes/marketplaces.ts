/**
 * Marketplace routes
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { MarketplaceService } from '../../services/marketplace.service.js';
import { errorResponse, json, parseLimit, validateIdParam } from '../shared.js';

const logger = createLogger('routes:marketplaces');

interface MarketplacesDeps {
  marketplaceService: MarketplaceService;
}

export function createMarketplacesRoutes({ marketplaceService }: MarketplacesDeps) {
  const app = new Hono();

  // GET /api/marketplaces
  app.get('/', async (c) => {
    const limit = parseLimit(c, 20);
    const includeDisabled = c.req.query('includeDisabled') === 'true';

    const result = await marketplaceService.list({ limit, includeDisabled });
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: {
        items: result.value.map((m) => ({
          id: m.id,
          name: m.name,
          githubOwner: m.githubOwner,
          githubRepo: m.githubRepo,
          branch: m.branch,
          pluginsPath: m.pluginsPath,
          isDefault: m.isDefault,
          isEnabled: m.isEnabled,
          status: m.status,
          lastSyncedAt: m.lastSyncedAt,
          syncError: m.syncError,
          pluginCount: (m.cachedPlugins ?? []).length,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
        totalCount: result.value.length,
      },
    });
  });

  // POST /api/marketplaces
  app.post('/', async (c) => {
    let body: {
      name: string;
      githubUrl?: string;
      githubOwner?: string;
      githubRepo?: string;
      branch?: string;
      pluginsPath?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    if (!body.name) {
      return json({ ok: false, error: { code: 'MISSING_NAME', message: 'Name is required' } }, 400);
    }

    if (!body.githubUrl && (!body.githubOwner || !body.githubRepo)) {
      return json(
        {
          ok: false,
          error: { code: 'MISSING_REPO', message: 'GitHub URL or owner/repo required' },
        },
        400
      );
    }

    const result = await marketplaceService.create(body);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // POST /api/marketplaces/seed
  app.post('/seed', async (_c) => {
    const result = await marketplaceService.seedDefaultMarketplace();
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { seeded: result.value !== null } });
  });

  // GET /api/marketplaces/plugins
  app.get('/plugins', async (c) => {
    const search = c.req.query('search') ?? undefined;
    const category = c.req.query('category') ?? undefined;
    const marketplaceId = c.req.query('marketplaceId') ?? undefined;

    const result = await marketplaceService.listAllPlugins({ search, category, marketplaceId });
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

  // GET /api/marketplaces/categories
  app.get('/categories', async (_c) => {
    const result = await marketplaceService.getCategories();
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: { categories: result.value },
    });
  });

  // POST /api/marketplaces/:id/sync
  app.post('/:id/sync', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await marketplaceService.sync(id);
    if (!result.ok) {
      logger.error(`Sync failed for `, { data: { detail: result.error } });
      return errorResponse(result);
    }
    return json({ ok: true, data: result.value });
  });

  // GET /api/marketplaces/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await marketplaceService.getById(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    const m = result.value;
    return json({
      ok: true,
      data: {
        id: m.id,
        name: m.name,
        githubOwner: m.githubOwner,
        githubRepo: m.githubRepo,
        branch: m.branch,
        pluginsPath: m.pluginsPath,
        isDefault: m.isDefault,
        isEnabled: m.isEnabled,
        status: m.status,
        lastSyncedAt: m.lastSyncedAt,
        syncError: m.syncError,
        plugins: m.cachedPlugins ?? [],
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      },
    });
  });

  // DELETE /api/marketplaces/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await marketplaceService.delete(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { deleted: true } });
  });

  return app;
}
