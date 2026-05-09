import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerraformRoutes } from '../../src/server/routes/terraform';

/**
 * Integration tests for Terraform API routes.
 *
 * Covers the registry CRUD + sync, module list/detail, and validate/compose
 * endpoints. Auth is enforced via `requireTerraformAdmin` which inspects
 * `c.get('auth')`. Tests inject auth via a custom middleware so all four
 * branches (no auth, viewer, admin, dev) are exercised.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string, status = 400) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockRegistryService() {
  return {
    listRegistries: vi.fn(),
    createRegistry: vi.fn(),
    getRegistryById: vi.fn(),
    deleteRegistry: vi.fn(),
    updateRegistry: vi.fn(),
    sync: vi.fn(),
    listModules: vi.fn(),
    getModuleById: vi.fn(),
  };
}

function createMockComposeService() {
  return {
    validateCode: vi.fn(),
    startCompose: vi.fn(),
  };
}

function buildApp(opts: { auth?: { authMethod?: string; roleLevel?: number } | null } = {}) {
  const registry = createMockRegistryService();
  const compose = createMockComposeService();
  const wrapper = new Hono();
  wrapper.use('*', async (c, next) => {
    if (opts.auth !== undefined) {
      c.set('auth', opts.auth as never);
    }
    await next();
  });
  const routes = createTerraformRoutes({
    terraformRegistryService: registry as never,
    terraformComposeService: compose as never,
  });
  wrapper.route('/', routes);
  return { app: wrapper, registry, compose };
}

describe('Terraform Routes (IT-1700)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /registries ─────────────────────────────────

  it('IT-1700-1: GET /registries returns mapped list', async () => {
    const { app, registry } = buildApp();
    registry.listRegistries.mockResolvedValue(
      ok([
        {
          id: 'reg-1',
          name: 'public',
          orgName: 'public',
          status: 'ready',
          lastSyncedAt: '2026-01-01',
          syncError: null,
          moduleCount: 12,
          syncIntervalMinutes: 60,
          nextSyncAt: '2026-01-02',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          tokenSettingKey: 'terraform.token.public',
        },
      ])
    );

    const res = await app.request('http://localhost/registries');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe('reg-1');
    expect(body.data.items[0].hasToken).toBe(true);
    expect(body.data.items[0]).not.toHaveProperty('tokenSettingKey');
    expect(body.data.totalCount).toBe(1);
  });

  it('IT-1700-2: GET /registries returns 500 when service errors', async () => {
    const { app, registry } = buildApp();
    registry.listRegistries.mockResolvedValue(err('REGISTRY_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/registries');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('REGISTRY_LIST_FAILED');
  });

  // ─── POST /registries ────────────────────────────────

  it('IT-1700-3: POST /registries denies non-admin role', async () => {
    const { app, registry } = buildApp({
      auth: { authMethod: 'session', roleLevel: 1 } as any,
    });
    const res = await app.request(
      jsonRequest('http://localhost/registries', {
        name: 'mine',
        orgName: 'mine',
        apiToken: 'tok',
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(registry.createRegistry).not.toHaveBeenCalled();
  });

  it('IT-1700-4: POST /registries succeeds for admin and strips tokenSettingKey', async () => {
    const { app, registry } = buildApp({
      auth: { authMethod: 'session', roleLevel: 100 } as any,
    });
    registry.createRegistry.mockResolvedValue(
      ok({
        id: 'reg-2',
        name: 'mine',
        orgName: 'mine',
        status: 'pending',
        tokenSettingKey: 'terraform.token.mine',
        moduleCount: 0,
      })
    );
    const res = await app.request(
      jsonRequest('http://localhost/registries', {
        name: 'mine',
        orgName: 'mine',
        apiToken: 'tok',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('reg-2');
    expect(body.data.hasToken).toBe(true);
    expect(body.data).not.toHaveProperty('tokenSettingKey');
  });

  it('IT-1700-5: POST /registries succeeds for dev auth method bypassing admin check', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.createRegistry.mockResolvedValue(
      ok({ id: 'reg-3', name: 'd', orgName: 'd', status: 'pending', tokenSettingKey: '' })
    );
    const res = await app.request(
      jsonRequest('http://localhost/registries', {
        name: 'd',
        orgName: 'd',
        apiToken: 'tok',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.hasToken).toBe(false);
  });

  it('IT-1700-6: POST /registries rejects malformed body via schema', async () => {
    const { app } = buildApp({ auth: { authMethod: 'dev' } as any });
    const res = await app.request(
      jsonRequest('http://localhost/registries', { name: '' /* missing */ })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1700-7: POST /registries returns service error on creation failure', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.createRegistry.mockResolvedValue(err('REGISTRY_EXISTS', 'duplicate', 409));
    const res = await app.request(
      jsonRequest('http://localhost/registries', {
        name: 'dup',
        orgName: 'dup',
        apiToken: 'tok',
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REGISTRY_EXISTS');
  });

  // ─── GET /registries/:id ─────────────────────────────

  it('IT-1700-8: GET /registries/:id returns 400 on invalid ID', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/registries/bad..id');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-1700-9: GET /registries/:id returns registry without tokenSettingKey', async () => {
    const { app, registry } = buildApp();
    registry.getRegistryById.mockResolvedValue(
      ok({ id: 'reg-1', name: 'r', orgName: 'r', status: 'ready', tokenSettingKey: 'k' })
    );
    const res = await app.request('http://localhost/registries/reg-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('reg-1');
    expect(body.data).not.toHaveProperty('tokenSettingKey');
    expect(body.data.hasToken).toBe(true);
  });

  it('IT-1700-10: GET /registries/:id propagates 404 from service', async () => {
    const { app, registry } = buildApp();
    registry.getRegistryById.mockResolvedValue(err('REGISTRY_NOT_FOUND', 'nope', 404));
    const res = await app.request('http://localhost/registries/reg-x');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('REGISTRY_NOT_FOUND');
  });

  // ─── DELETE /registries/:id ──────────────────────────

  it('IT-1700-11: DELETE /registries/:id rejects non-admin', async () => {
    const { app, registry } = buildApp({
      auth: { authMethod: 'session', roleLevel: 0 } as any,
    });
    const res = await app.request('http://localhost/registries/reg-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(registry.deleteRegistry).not.toHaveBeenCalled();
  });

  it('IT-1700-12: DELETE /registries/:id returns 400 on invalid ID', async () => {
    const { app } = buildApp({ auth: { authMethod: 'dev' } as any });
    const res = await app.request('http://localhost/registries/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1700-13: DELETE /registries/:id succeeds for admin', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.deleteRegistry.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/registries/reg-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('IT-1700-14: DELETE /registries/:id surfaces service error', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.deleteRegistry.mockResolvedValue(err('REGISTRY_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/registries/reg-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // ─── PATCH /registries/:id ───────────────────────────

  it('IT-1700-15: PATCH /registries/:id rejects bad ID', async () => {
    const { app } = buildApp({ auth: { authMethod: 'dev' } as any });
    const res = await app.request(
      jsonRequest('http://localhost/registries/bad..id', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1700-16: PATCH /registries/:id rejects non-admin', async () => {
    const { app } = buildApp({ auth: { authMethod: 'session', roleLevel: 0 } as any });
    const res = await app.request(
      jsonRequest('http://localhost/registries/reg-1', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(403);
  });

  it('IT-1700-17: PATCH /registries/:id rejects malformed body', async () => {
    const { app } = buildApp({ auth: { authMethod: 'dev' } as any });
    const res = await app.request(
      new Request('http://localhost/registries/reg-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1700-18: PATCH /registries/:id succeeds and strips tokenSettingKey', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.updateRegistry.mockResolvedValue(
      ok({ id: 'reg-1', name: 'updated', orgName: 'r', status: 'ready', tokenSettingKey: 'k' })
    );
    const res = await app.request(
      jsonRequest('http://localhost/registries/reg-1', { name: 'updated' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('updated');
    expect(body.data).not.toHaveProperty('tokenSettingKey');
  });

  it('IT-1700-19: PATCH /registries/:id surfaces service error', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.updateRegistry.mockResolvedValue(err('REGISTRY_NOT_FOUND', 'gone', 404));
    const res = await app.request(
      jsonRequest('http://localhost/registries/reg-1', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(404);
  });

  // ─── POST /registries/:id/sync ───────────────────────

  it('IT-1700-20: POST /registries/:id/sync rejects bad ID', async () => {
    const { app } = buildApp({ auth: { authMethod: 'dev' } as any });
    const res = await app.request('http://localhost/registries/bad..id/sync', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1700-21: POST /registries/:id/sync rejects non-admin', async () => {
    const { app } = buildApp({ auth: { authMethod: 'session', roleLevel: 0 } as any });
    const res = await app.request('http://localhost/registries/reg-1/sync', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('IT-1700-22: POST /registries/:id/sync returns synced module count', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.sync.mockResolvedValue(ok({ moduleCount: 42 }));
    const res = await app.request('http://localhost/registries/reg-1/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.moduleCount).toBe(42);
  });

  it('IT-1700-23: POST /registries/:id/sync surfaces service error', async () => {
    const { app, registry } = buildApp({ auth: { authMethod: 'dev' } as any });
    registry.sync.mockResolvedValue(err('SYNC_FAILED', 'boom', 502));
    const res = await app.request('http://localhost/registries/reg-1/sync', { method: 'POST' });
    expect(res.status).toBe(502);
  });

  // ─── GET /modules ────────────────────────────────────

  it('IT-1700-24: GET /modules with default limit', async () => {
    const { app, registry } = buildApp();
    registry.listModules.mockResolvedValue(ok([{ id: 'mod-1', name: 'vpc' }]));
    const res = await app.request('http://localhost/modules');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.totalCount).toBe(1);
    expect(registry.listModules).toHaveBeenCalledWith({
      search: undefined,
      provider: undefined,
      registryId: undefined,
      limit: 50,
    });
  });

  it('IT-1700-25: GET /modules clamps limit to 200 max', async () => {
    const { app, registry } = buildApp();
    registry.listModules.mockResolvedValue(ok([]));
    await app.request(
      'http://localhost/modules?limit=999&search=foo&provider=aws&registryId=reg-1'
    );
    expect(registry.listModules).toHaveBeenCalledWith({
      search: 'foo',
      provider: 'aws',
      registryId: 'reg-1',
      limit: 200,
    });
  });

  it('IT-1700-26: GET /modules clamps limit to 1 minimum and handles non-numeric', async () => {
    const { app, registry } = buildApp();
    registry.listModules.mockResolvedValue(ok([]));
    await app.request('http://localhost/modules?limit=0');
    expect(registry.listModules).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
    // Non-numeric falls back to 50
    await app.request('http://localhost/modules?limit=abc');
    expect(registry.listModules).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('IT-1700-27: GET /modules surfaces service error', async () => {
    const { app, registry } = buildApp();
    registry.listModules.mockResolvedValue(err('MODULE_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/modules');
    expect(res.status).toBe(500);
  });

  // ─── GET /modules/:id ────────────────────────────────

  it('IT-1700-28: GET /modules/:id rejects bad ID', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/modules/bad..id');
    expect(res.status).toBe(400);
  });

  it('IT-1700-29: GET /modules/:id returns module', async () => {
    const { app, registry } = buildApp();
    registry.getModuleById.mockResolvedValue(ok({ id: 'mod-1', name: 'vpc' }));
    const res = await app.request('http://localhost/modules/mod-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('vpc');
  });

  it('IT-1700-30: GET /modules/:id propagates not-found', async () => {
    const { app, registry } = buildApp();
    registry.getModuleById.mockResolvedValue(err('MODULE_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/modules/mod-1');
    expect(res.status).toBe(404);
  });

  // ─── POST /validate ──────────────────────────────────

  it('IT-1700-31: POST /validate rejects empty code', async () => {
    const { app } = buildApp();
    const res = await app.request(jsonRequest('http://localhost/validate', { code: '' }));
    expect(res.status).toBe(400);
  });

  it('IT-1700-32: POST /validate returns validation result on success', async () => {
    const { app, compose } = buildApp();
    compose.validateCode.mockResolvedValue({ valid: true, errors: [] });
    const res = await app.request(
      jsonRequest('http://localhost/validate', { code: 'resource "x" {}' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.valid).toBe(true);
    expect(compose.validateCode).toHaveBeenCalledWith('resource "x" {}', undefined);
  });

  it('IT-1700-33: POST /validate maps thrown error to 500 VALIDATE_ERROR', async () => {
    const { app, compose } = buildApp();
    compose.validateCode.mockRejectedValue(new Error('crashed'));
    const res = await app.request(
      jsonRequest('http://localhost/validate', { code: 'resource "x" {}', tfvars: 'a = 1' })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATE_ERROR');
  });

  // ─── POST /compose ───────────────────────────────────

  it('IT-1700-34: POST /compose returns 202 + compose handle', async () => {
    const { app, compose } = buildApp();
    compose.startCompose.mockResolvedValue(ok({ sessionId: 's-1', status: 'started' }));
    const res = await app.request(
      jsonRequest('http://localhost/compose', {
        sessionId: 's-1',
        messages: [{ role: 'user', content: 'create a vpc' }],
        registryId: 'reg-1',
        composeMode: 'terraform',
      })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.sessionId).toBe('s-1');
  });

  it('IT-1700-35: POST /compose surfaces service error', async () => {
    const { app, compose } = buildApp();
    compose.startCompose.mockResolvedValue(err('COMPOSE_RATE_LIMITED', 'wait', 429));
    const res = await app.request(
      jsonRequest('http://localhost/compose', {
        sessionId: 's-2',
        messages: [{ role: 'user', content: 'x' }],
        registryId: 'reg-1',
        composeMode: 'terraform',
      })
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('COMPOSE_RATE_LIMITED');
  });

  it('IT-1700-36: POST /compose rejects malformed body', async () => {
    const { app } = buildApp();
    const res = await app.request(
      jsonRequest('http://localhost/compose', { /* missing sessionId */ messages: [] })
    );
    expect(res.status).toBe(400);
  });
});
