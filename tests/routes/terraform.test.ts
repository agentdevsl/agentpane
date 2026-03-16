import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../src/db/schema/shared/enums';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { ok } from '../../src/lib/utils/result';
import { createTerraformRoutes } from '../../src/server/routes/terraform';

type Role = Extract<RbacRole, 'viewer' | 'admin'>;

function createAuth(role: Role) {
  return async (
    c: { set: (key: 'auth', value: AuthContext) => void },
    next: () => Promise<void>
  ) => {
    c.set('auth', {
      userId: 'user-1',
      authMethod: 'session',
      resolvedRole: role,
      roleLevel: RBAC_ROLE_LEVEL[role],
    });
    await next();
  };
}

function createApp(role: Role) {
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
  app.use('*', createAuth(role));
  app.route(
    '/api/terraform',
    createTerraformRoutes({
      terraformRegistryService: terraformRegistryService as never,
      terraformComposeService: terraformComposeService as never,
    })
  );

  return { app, terraformRegistryService };
}

describe('terraform routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns hasToken metadata while omitting tokenSettingKey on registry reads', async () => {
    const { app, terraformRegistryService } = createApp('viewer');
    terraformRegistryService.listRegistries.mockResolvedValue(
      ok([
        {
          id: 'reg-1',
          name: 'Acme Registry',
          orgName: 'acme-org',
          tokenSettingKey: 'terraform.registry.reg-1.apiToken',
          status: 'active',
          lastSyncedAt: null,
          syncError: null,
          moduleCount: 4,
          syncIntervalMinutes: 15,
          nextSyncAt: null,
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
      ])
    );

    const res = await app.request('/api/terraform/registries');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.items[0].hasToken).toBe(true);
    expect(body.data.items[0].tokenSettingKey).toBeUndefined();
  });

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
    terraformRegistryService.createRegistry.mockResolvedValue(
      ok({
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
      })
    );

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
});
