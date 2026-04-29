import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxRoutes, validateNomadAddress } from '../sandbox.js';

// ── Mock Sandbox Config Service ──

function createMockSandboxConfigService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const sandboxConfigService = createMockSandboxConfigService();
  const routes = createSandboxRoutes({
    sandboxConfigService: sandboxConfigService as never,
  });
  const app = new Hono();
  app.route('/api/sandbox-configs', routes);
  app.onError((err, c) => {
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });
  return { app, sandboxConfigService };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Sandbox Config API Routes', () => {
  // ── GET /api/sandbox-configs ──

  describe('GET /api/sandbox-configs', () => {
    it('returns sandbox configs list', async () => {
      const { app, sandboxConfigService } = createTestApp();
      const mockConfigs = [
        { id: 'cfg-1', name: 'Docker Config', type: 'docker' },
        { id: 'cfg-2', name: 'K8s Config', type: 'kubernetes' },
      ];
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: mockConfigs, totalCount: 2 },
      });

      const res = await request(app, 'GET', '/api/sandbox-configs');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
      expect(json.data.totalCount).toBe(2);
    });

    it('passes limit and offset query params', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?limit=10&offset=5');

      expect(sandboxConfigService.list).toHaveBeenCalledWith({ limit: 10, offset: 5 });
    });

    it('clamps limit to max 100', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?limit=500');

      expect(sandboxConfigService.list).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    });

    it('clamps limit to 1 when 0 is passed', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?limit=0');

      // parseLimit clamps to Math.max(1, ...) so 0 becomes 1
      expect(sandboxConfigService.list).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    });

    it('clamps limit to min 1', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?limit=-10');

      // parseInt('-10') || 50 evaluates to -10 (truthy), then Math.max(1, ...) clamps to 1
      // Actually: parseInt('-10') is -10, || 50 skips since -10 is truthy, Math.min(Math.max(-10, 1), 100) = 1
      expect(sandboxConfigService.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    });

    it('returns error when service fails', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/sandbox-configs');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'GET', '/api/sandbox-configs');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('redacts sensitive fields from returned configs', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: {
          items: [
            {
              id: 'cfg-1',
              name: 'Nomad',
              nomadToken: 'secret-token',
              awsSecretAccessKey: 'aws-secret',
            },
          ],
          totalCount: 1,
        },
      });

      const res = await request(app, 'GET', '/api/sandbox-configs');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.items[0].nomadToken).toBeUndefined();
      expect(json.data.items[0].awsSecretAccessKey).toBeUndefined();
      expect(json.data.items[0].name).toBe('Nomad');
    });

    it('defaults offset to 0 when negative value is passed', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?offset=-5');

      expect(sandboxConfigService.list).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 })
      );
    });

    it('defaults offset to 0 when NaN is passed', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.list.mockResolvedValue({
        ok: true,
        value: { items: [], totalCount: 0 },
      });

      await request(app, 'GET', '/api/sandbox-configs?offset=notanumber');

      expect(sandboxConfigService.list).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 })
      );
    });
  });

  // ── POST /api/sandbox-configs ──

  describe('POST /api/sandbox-configs', () => {
    it('creates a sandbox config and returns 201', async () => {
      const { app, sandboxConfigService } = createTestApp();
      const created = { id: 'cfg-new', name: 'New Config', type: 'docker' };
      sandboxConfigService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'New Config',
        type: 'docker',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('cfg-new');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/sandbox-configs', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when name is missing (create requires name)', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        type: 'docker',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid type value', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        type: 'invalid_type',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid memoryMb (too low)', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        memoryMb: 10,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid cpuCores (too low)', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        cpuCores: 0.1,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns error when service create fails', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockResolvedValue({
        ok: false,
        error: { code: 'DUPLICATE', message: 'Config already exists', status: 409 },
      });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DUPLICATE');
    });

    it('returns 500 when service throws', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('redacts sensitive fields in create response', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockResolvedValue({
        ok: true,
        value: {
          id: 'cfg-1',
          name: 'Config',
          nomadToken: 'encrypted-secret',
          awsSecretAccessKey: 'encrypted-aws',
        },
      });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.nomadToken).toBeUndefined();
      expect(json.data.awsSecretAccessKey).toBeUndefined();
    });

    it('returns 400 for memoryMb too high', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        memoryMb: 999999,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for cpuCores too high', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        cpuCores: 999,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for maxProcesses too low', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        maxProcesses: 0,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for timeoutMinutes too high', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Config',
        timeoutMinutes: 99999,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for name too long', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'x'.repeat(201),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid kubernetes type', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-k8s', name: 'K8s Config', type: 'kubernetes' },
      });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'K8s Config',
        type: 'kubernetes',
        kubeNamespace: 'default',
      });

      expect(res.status).toBe(201);
    });

    it('accepts valid nomad type with address', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-nomad', name: 'Nomad Config', type: 'nomad' },
      });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'Nomad Config',
        type: 'nomad',
        nomadAddress: 'http://192.168.1.100:4646',
      });

      expect(res.status).toBe(201);
    });

    it('accepts valid agentcore type', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.create.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-ac', name: 'AgentCore Config', type: 'agentcore' },
      });

      const res = await request(app, 'POST', '/api/sandbox-configs', {
        name: 'AgentCore Config',
        type: 'agentcore',
      });

      expect(res.status).toBe(201);
    });
  });

  // ── GET /api/sandbox-configs/:id ──

  describe('GET /api/sandbox-configs/:id', () => {
    it('returns a sandbox config by id', async () => {
      const { app, sandboxConfigService } = createTestApp();
      const config = { id: 'cfg-1', name: 'Docker Config', type: 'docker' };
      sandboxConfigService.getById.mockResolvedValue({ ok: true, value: config });

      const res = await request(app, 'GET', '/api/sandbox-configs/cfg-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('cfg-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sandbox-configs/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when config not found', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/sandbox-configs/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'GET', '/api/sandbox-configs/cfg-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('redacts sensitive fields in get response', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.getById.mockResolvedValue({
        ok: true,
        value: {
          id: 'cfg-1',
          name: 'Config',
          nomadToken: 'secret',
          awsSecretAccessKey: 'aws-secret',
        },
      });

      const res = await request(app, 'GET', '/api/sandbox-configs/cfg-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.nomadToken).toBeUndefined();
      expect(json.data.awsSecretAccessKey).toBeUndefined();
    });
  });

  // ── PATCH /api/sandbox-configs/:id ──

  describe('PATCH /api/sandbox-configs/:id', () => {
    it('updates a sandbox config', async () => {
      const { app, sandboxConfigService } = createTestApp();
      const updated = { id: 'cfg-1', name: 'Updated Config', type: 'docker' };
      sandboxConfigService.update.mockResolvedValue({ ok: true, value: updated });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        name: 'Updated Config',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('Updated Config');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/sandbox-configs/bad!id', {
        name: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/sandbox-configs/cfg-1', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid type value in update', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        type: 'not_a_type',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid memoryMb (too high)', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        memoryMb: 999999,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns error when service update fails (not found)', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('redacts sensitive fields in update response', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockResolvedValue({
        ok: true,
        value: {
          id: 'cfg-1',
          name: 'Config',
          nomadToken: 'secret',
          awsSecretAccessKey: 'aws-secret',
        },
      });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        name: 'Config',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.nomadToken).toBeUndefined();
      expect(json.data.awsSecretAccessKey).toBeUndefined();
    });

    it('allows updating isDefault', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-1', name: 'Config', isDefault: true },
      });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        isDefault: true,
      });

      expect(res.status).toBe(200);
      expect(sandboxConfigService.update).toHaveBeenCalledWith(
        'cfg-1',
        expect.objectContaining({ isDefault: true })
      );
    });

    it('allows updating networkPolicyEnabled', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-1', name: 'Config', networkPolicyEnabled: true },
      });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        networkPolicyEnabled: true,
      });

      expect(res.status).toBe(200);
    });

    it('allows updating allowedEgressHosts', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.update.mockResolvedValue({
        ok: true,
        value: { id: 'cfg-1', name: 'Config', allowedEgressHosts: ['example.com'] },
      });

      const res = await request(app, 'PATCH', '/api/sandbox-configs/cfg-1', {
        allowedEgressHosts: ['example.com'],
      });

      expect(res.status).toBe(200);
    });
  });

  // ── DELETE /api/sandbox-configs/:id ──

  describe('DELETE /api/sandbox-configs/:id', () => {
    it('deletes a sandbox config', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/sandbox-configs/cfg-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/sandbox-configs/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when config not found', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/sandbox-configs/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, sandboxConfigService } = createTestApp();
      sandboxConfigService.delete.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'DELETE', '/api/sandbox-configs/cfg-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });
});

// ── Nomad Address Validation (exported utility) ──

describe('validateNomadAddress', () => {
  it('accepts valid loopback address on Nomad default port', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:4646');
    expect(result).toEqual({ valid: true });
  });

  it('accepts valid 192.168.x.x address on Nomad default port', async () => {
    const result = await validateNomadAddress('http://192.168.1.100:4646');
    expect(result).toEqual({ valid: true });
  });

  it('rejects invalid URL format', async () => {
    const result = await validateNomadAddress('not-a-url');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid');
    }
  });

  it('rejects non-http protocols', async () => {
    const result = await validateNomadAddress('ftp://nomad.example.com');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('http or https');
    }
  });

  it('rejects cloud metadata endpoints (169.254.x.x)', async () => {
    const result = await validateNomadAddress('http://169.254.169.254/latest/meta-data');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('metadata');
    }
  });

  it('rejects metadata.google.internal', async () => {
    const result = await validateNomadAddress('http://metadata.google.internal');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('metadata');
    }
  });

  it('rejects 0.0.0.0', async () => {
    const result = await validateNomadAddress('http://0.0.0.0:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('0.0.0.0');
    }
  });

  it('rejects localhost', async () => {
    const result = await validateNomadAddress('http://localhost:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('localhost');
    }
  });

  it('allows 127.0.0.1 on Nomad default port 4646', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:4646');
    expect(result).toEqual({ valid: true });
  });

  it('rejects 127.0.0.1 on non-Nomad port', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:8080');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('4646');
    }
  });

  it('rejects IPv6 loopback', async () => {
    const result = await validateNomadAddress('http://[::1]:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('loopback');
    }
  });

  it('rejects 10.x.x.x private addresses', async () => {
    const result = await validateNomadAddress('http://10.0.0.5:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('internal network');
    }
  });

  it('rejects 172.16.x.x private addresses', async () => {
    const result = await validateNomadAddress('http://172.16.0.1:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('internal network');
    }
  });

  it('allows 192.168.x.x on Nomad default port', async () => {
    const result = await validateNomadAddress('http://192.168.1.1:4646');
    expect(result).toEqual({ valid: true });
  });

  it('rejects 192.168.x.x on non-Nomad port', async () => {
    const result = await validateNomadAddress('http://192.168.1.1:8080');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('4646');
    }
  });

  it('rejects IPv6 link-local addresses', async () => {
    const result = await validateNomadAddress('http://[fe80::1]:4646');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('link-local');
    }
  });

  it('accepts HTTPS protocol with IP address', async () => {
    const result = await validateNomadAddress('https://192.168.1.100:4646');
    expect(result.valid).toBe(true);
  });

  it('rejects empty string', async () => {
    const result = await validateNomadAddress('');
    expect(result.valid).toBe(false);
  });
});
