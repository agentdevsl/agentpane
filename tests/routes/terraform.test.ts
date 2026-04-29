import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../src/db/schema/shared/enums';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { err, ok } from '../../src/lib/utils/result';
import { createTerraformRoutes } from '../../src/server/routes/terraform';

type Role = Extract<RbacRole, 'viewer' | 'admin'>;

function createAuth(role: Role, authMethod: 'session' | 'dev' = 'session') {
  return async (
    c: { set: (key: 'auth', value: AuthContext) => void },
    next: () => Promise<void>
  ) => {
    c.set('auth', {
      userId: 'user-1',
      authMethod,
      resolvedRole: role,
      roleLevel: RBAC_ROLE_LEVEL[role],
    });
    await next();
  };
}

function createApp(role: Role, authMethod: 'session' | 'dev' = 'session') {
  const terraformRegistryService = {
    listRegistries: vi.fn(),
    createRegistry: vi.fn(),
    getRegistryById: vi.fn(),
    deleteRegistry: vi.fn(),
    updateRegistry: vi.fn(),
    sync: vi.fn(),
    listModules: vi.fn(),
    getModuleById: vi.fn(),
  };

  const terraformComposeService = {
    validateCode: vi.fn(),
    startCompose: vi.fn(),
  };

  const app = new Hono();
  app.use('*', createAuth(role, authMethod));
  app.route(
    '/api/terraform',
    createTerraformRoutes({
      terraformRegistryService: terraformRegistryService as never,
      terraformComposeService: terraformComposeService as never,
    })
  );
  app.onError((err, c) =>
    c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500)
  );

  return { app, terraformRegistryService, terraformComposeService };
}

// Helper for consistent registry mock data
function mockRegistry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reg-1',
    name: 'Acme Registry',
    orgName: 'acme-org',
    tokenSettingKey: 'terraform.registry.reg-1.apiToken',
    status: 'active',
    lastSyncedAt: null,
    syncError: null,
    moduleCount: 0,
    syncIntervalMinutes: 15,
    nextSyncAt: null,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('terraform routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /registries ───────────────────────────────────────

  describe('GET /registries', () => {
    it('returns hasToken metadata while omitting tokenSettingKey on registry reads', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listRegistries.mockResolvedValue(
        ok([mockRegistry({ moduleCount: 4 })])
      );

      const res = await app.request('/api/terraform/registries');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.items[0].hasToken).toBe(true);
      expect(body.data.items[0].tokenSettingKey).toBeUndefined();
    });

    it('returns totalCount matching the number of items', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listRegistries.mockResolvedValue(
        ok([mockRegistry({ id: 'reg-1' }), mockRegistry({ id: 'reg-2' })])
      );

      const res = await app.request('/api/terraform/registries');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.totalCount).toBe(2);
      expect(body.data.items).toHaveLength(2);
    });

    it('returns empty list when no registries exist', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listRegistries.mockResolvedValue(ok([]));

      const res = await app.request('/api/terraform/registries');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.items).toHaveLength(0);
      expect(body.data.totalCount).toBe(0);
    });

    it('returns error when service returns error result', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listRegistries.mockResolvedValue(
        err({ code: 'DB_ERROR', message: 'Connection lost', status: 500 })
      );

      const res = await app.request('/api/terraform/registries');
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
    });

    it('returns 500 when service throws an exception', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listRegistries.mockRejectedValue(new Error('Unexpected'));

      const res = await app.request('/api/terraform/registries');
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /registries ──────────────────────────────────────

  describe('POST /registries', () => {
    it('rejects registry creation for non-admin users', async () => {
      const { app, terraformRegistryService } = createApp('viewer');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme Registry',
          orgName: 'acme-org',
          apiToken: 'sk-tfe-secret-token',
        }),
      });

      expect(res.status).toBe(403);
      expect(terraformRegistryService.createRegistry).not.toHaveBeenCalled();
    });

    it('accepts apiToken on admin create and omits internal secret keys in the response', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.createRegistry.mockResolvedValue(ok(mockRegistry()));

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme Registry',
          orgName: 'acme-org',
          apiToken: 'sk-tfe-secret-token',
          syncIntervalMinutes: 15,
        }),
      });

      const body = await res.json();

      expect(res.status).toBe(201);
      expect(terraformRegistryService.createRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          apiToken: 'sk-tfe-secret-token',
          orgName: 'acme-org',
        })
      );
      expect(body.data.hasToken).toBe(true);
      expect(body.data.tokenSettingKey).toBeUndefined();
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgName: 'acme-org', apiToken: 'token' }),
      });

      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when orgName is missing', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Registry', apiToken: 'token' }),
      });

      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when apiToken is missing', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Registry', orgName: 'acme-org' }),
      });

      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when syncIntervalMinutes is too low', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Registry',
          orgName: 'org',
          apiToken: 'token',
          syncIntervalMinutes: 1,
        }),
      });

      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('allows dev auth to bypass admin check', async () => {
      const { app, terraformRegistryService } = createApp('viewer', 'dev');
      terraformRegistryService.createRegistry.mockResolvedValue(ok(mockRegistry()));

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dev Registry',
          orgName: 'dev-org',
          apiToken: 'dev-token',
        }),
      });

      expect(res.status).toBe(201);
      expect(terraformRegistryService.createRegistry).toHaveBeenCalled();
    });

    it('returns service error status when create fails', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.createRegistry.mockResolvedValue(
        err({ code: 'DUPLICATE', message: 'Registry already exists', status: 409 })
      );

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Registry',
          orgName: 'org',
          apiToken: 'token',
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('DUPLICATE');
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.createRegistry.mockRejectedValue(new Error('DB down'));

      const res = await app.request('/api/terraform/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Registry',
          orgName: 'org',
          apiToken: 'token',
        }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /registries/:id ───────────────────────────────────

  describe('GET /registries/:id', () => {
    it('returns registry detail with hasToken and without tokenSettingKey', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.getRegistryById.mockResolvedValue(ok(mockRegistry()));

      const res = await app.request('/api/terraform/registries/reg-1');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.hasToken).toBe(true);
      expect(body.data.tokenSettingKey).toBeUndefined();
      expect(body.data.id).toBe('reg-1');
    });

    it('returns 400 for invalid ID format', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/registries/bad!id');
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when registry not found', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.getRegistryById.mockResolvedValue(
        err({ code: 'NOT_FOUND', message: 'Registry not found', status: 404 })
      );

      const res = await app.request('/api/terraform/registries/nonexistent-id');
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.getRegistryById.mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/terraform/registries/reg-1');
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── DELETE /registries/:id ────────────────────────────────

  describe('DELETE /registries/:id', () => {
    it('deletes a registry as admin', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.deleteRegistry.mockResolvedValue(ok({ deleted: true }));

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'DELETE',
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);
    });

    it('rejects delete for non-admin', async () => {
      const { app, terraformRegistryService } = createApp('viewer');

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
      expect(terraformRegistryService.deleteRegistry).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid ID', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries/bad!id', {
        method: 'DELETE',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns error when service returns error', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.deleteRegistry.mockResolvedValue(
        err({ code: 'NOT_FOUND', message: 'Not found', status: 404 })
      );

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.deleteRegistry.mockRejectedValue(new Error('crash'));

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'DELETE',
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('allows dev auth to bypass admin check for delete', async () => {
      const { app, terraformRegistryService } = createApp('viewer', 'dev');
      terraformRegistryService.deleteRegistry.mockResolvedValue(ok({ deleted: true }));

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(terraformRegistryService.deleteRegistry).toHaveBeenCalledWith('reg-1');
    });
  });

  // ── PATCH /registries/:id ─────────────────────────────────

  describe('PATCH /registries/:id', () => {
    it('updates a registry as admin', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.updateRegistry.mockResolvedValue(
        ok(mockRegistry({ name: 'Updated Registry' }))
      );

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Registry' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.hasToken).toBe(true);
      expect(body.data.tokenSettingKey).toBeUndefined();
    });

    it('rejects update for non-admin', async () => {
      const { app, terraformRegistryService } = createApp('viewer');

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(403);
      expect(terraformRegistryService.updateRegistry).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid ID', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries/bad!id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid syncIntervalMinutes (too low)', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncIntervalMinutes: 2 }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('allows setting syncIntervalMinutes to null', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.updateRegistry.mockResolvedValue(
        ok(mockRegistry({ syncIntervalMinutes: null }))
      );

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncIntervalMinutes: null }),
      });

      expect(res.status).toBe(200);
      expect(terraformRegistryService.updateRegistry).toHaveBeenCalledWith(
        'reg-1',
        expect.objectContaining({ syncIntervalMinutes: null })
      );
    });

    it('returns service error when update fails', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.updateRegistry.mockResolvedValue(
        err({ code: 'NOT_FOUND', message: 'Not found', status: 404 })
      );

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.updateRegistry.mockRejectedValue(new Error('crash'));

      const res = await app.request('/api/terraform/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /registries/:id/sync ─────────────────────────────

  describe('POST /registries/:id/sync', () => {
    it('triggers manual sync as admin', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.sync.mockResolvedValue(
        ok({ moduleCount: 10, lastSyncedAt: '2026-03-16T01:00:00.000Z' })
      );

      const res = await app.request('/api/terraform/registries/reg-1/sync', {
        method: 'POST',
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.moduleCount).toBe(10);
      expect(terraformRegistryService.sync).toHaveBeenCalledWith('reg-1');
    });

    it('rejects sync for non-admin', async () => {
      const { app, terraformRegistryService } = createApp('viewer');

      const res = await app.request('/api/terraform/registries/reg-1/sync', {
        method: 'POST',
      });

      expect(res.status).toBe(403);
      expect(terraformRegistryService.sync).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid ID', async () => {
      const { app } = createApp('admin');

      const res = await app.request('/api/terraform/registries/bad!id/sync', {
        method: 'POST',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns error when sync fails', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.sync.mockResolvedValue(
        err({ code: 'SYNC_ERROR', message: 'Token expired', status: 401 })
      );

      const res = await app.request('/api/terraform/registries/reg-1/sync', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });

    it('returns 500 when sync throws', async () => {
      const { app, terraformRegistryService } = createApp('admin');
      terraformRegistryService.sync.mockRejectedValue(new Error('Network error'));

      const res = await app.request('/api/terraform/registries/reg-1/sync', {
        method: 'POST',
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /modules ──────────────────────────────────────────

  describe('GET /modules', () => {
    it('returns modules list', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(
        ok([
          { id: 'mod-1', name: 'vpc', provider: 'aws' },
          { id: 'mod-2', name: 'eks', provider: 'aws' },
        ])
      );

      const res = await app.request('/api/terraform/modules');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.totalCount).toBe(2);
    });

    it('passes search, provider, registryId query params', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(ok([]));

      await app.request('/api/terraform/modules?search=vpc&provider=aws&registryId=reg-1&limit=10');

      expect(terraformRegistryService.listModules).toHaveBeenCalledWith({
        search: 'vpc',
        provider: 'aws',
        registryId: 'reg-1',
        limit: 10,
      });
    });

    it('clamps limit to max 200', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(ok([]));

      await app.request('/api/terraform/modules?limit=999');

      expect(terraformRegistryService.listModules).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 200 })
      );
    });

    it('clamps limit to min 1', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(ok([]));

      await app.request('/api/terraform/modules?limit=-5');

      expect(terraformRegistryService.listModules).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 })
      );
    });

    it('defaults limit to 50 when not provided', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(ok([]));

      await app.request('/api/terraform/modules');

      expect(terraformRegistryService.listModules).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 })
      );
    });

    it('defaults limit to 50 for NaN input', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(ok([]));

      await app.request('/api/terraform/modules?limit=notanumber');

      expect(terraformRegistryService.listModules).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 })
      );
    });

    it('returns error when service returns error', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockResolvedValue(
        err({ code: 'DB_ERROR', message: 'Query failed', status: 500 })
      );

      const res = await app.request('/api/terraform/modules');

      expect(res.status).toBe(500);
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.listModules.mockRejectedValue(new Error('crash'));

      const res = await app.request('/api/terraform/modules');
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /modules/:id ──────────────────────────────────────

  describe('GET /modules/:id', () => {
    it('returns module detail', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      const module = { id: 'mod-1', name: 'vpc', provider: 'aws', version: '3.0.0' };
      terraformRegistryService.getModuleById.mockResolvedValue(ok(module));

      const res = await app.request('/api/terraform/modules/mod-1');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe('mod-1');
    });

    it('returns 400 for invalid ID', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/modules/bad!id');
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when module not found', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.getModuleById.mockResolvedValue(
        err({ code: 'NOT_FOUND', message: 'Module not found', status: 404 })
      );

      const res = await app.request('/api/terraform/modules/nonexistent-id');

      expect(res.status).toBe(404);
    });

    it('returns 500 when service throws', async () => {
      const { app, terraformRegistryService } = createApp('viewer');
      terraformRegistryService.getModuleById.mockRejectedValue(new Error('crash'));

      const res = await app.request('/api/terraform/modules/mod-1');
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /validate ────────────────────────────────────────

  describe('POST /validate', () => {
    it('validates HCL code successfully', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.validateCode.mockResolvedValue({ valid: true, diagnostics: [] });

      const res = await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'resource "aws_instance" "example" {}' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.valid).toBe(true);
    });

    it('passes tfvars to validateCode', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.validateCode.mockResolvedValue({ valid: true, diagnostics: [] });

      await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'var "region" {}', tfvars: 'region = "us-east-1"' }),
      });

      expect(terraformComposeService.validateCode).toHaveBeenCalledWith(
        'var "region" {}',
        'region = "us-east-1"'
      );
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when code field is missing', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tfvars: 'x = 1' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when code is not a string', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 123 }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 500 when validateCode throws', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.validateCode.mockRejectedValue(new Error('Parser error'));

      const res = await app.request('/api/terraform/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'invalid hcl' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('VALIDATE_ERROR');
    });
  });

  // ── POST /compose ─────────────────────────────────────────

  describe('POST /compose', () => {
    it('starts compose job and returns 202', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.startCompose.mockResolvedValue(
        ok({ sessionId: 'sess-123', status: 'started' })
      );

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Create a VPC' }],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.data.sessionId).toBe('sess-123');
    });

    it('passes sessionId and registryId to startCompose', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.startCompose.mockResolvedValue(
        ok({ sessionId: 'sess-existing', status: 'started' })
      );

      await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Add an EKS cluster' }],
          sessionId: 'sess-existing',
          registryId: 'reg-1',
        }),
      });

      expect(terraformComposeService.startCompose).toHaveBeenCalledWith(
        'sess-existing',
        [{ role: 'user', content: 'Add an EKS cluster' }],
        'reg-1',
        'terraform'
      );
    });

    it('passes composeMode to startCompose', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.startCompose.mockResolvedValue(
        ok({ sessionId: 'sess-stacks', status: 'started' })
      );

      await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Use stacks' }],
          composeMode: 'stacks',
        }),
      });

      expect(terraformComposeService.startCompose).toHaveBeenCalledWith(
        undefined,
        expect.any(Array),
        undefined,
        'stacks'
      );
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when messages is empty', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when messages is missing', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when message role is invalid', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'system', content: 'Hello' }],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when message content is empty', async () => {
      const { app } = createApp('viewer');

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '' }],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns service error when compose fails', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.startCompose.mockResolvedValue(
        err({ code: 'RATE_LIMITED', message: 'Too many requests', status: 429 })
      );

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Create infra' }],
        }),
      });

      expect(res.status).toBe(429);
    });

    it('returns 500 when compose throws', async () => {
      const { app, terraformComposeService } = createApp('viewer');
      terraformComposeService.startCompose.mockRejectedValue(new Error('SDK crash'));

      const res = await app.request('/api/terraform/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Create infra' }],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
