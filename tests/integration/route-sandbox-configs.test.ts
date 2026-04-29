import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandboxConfigRoutes } from '../../src/server/routes/sandbox-configs';
import { SandboxConfigService } from '../../src/services/sandbox-config.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for sandbox-configs API routes.
 *
 * Creates a real Hono app with the sandbox-config routes mounted,
 * backed by a real SQLite database via SandboxConfigService.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Sandbox Config Routes (IT-400)', () => {
  let app: ReturnType<typeof createSandboxConfigRoutes>;
  let service: SandboxConfigService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    service = new SandboxConfigService(db as any);
    app = createSandboxConfigRoutes({ sandboxConfigService: service });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/sandbox-configs ──────────────────────

  it('IT-401: POST / creates a sandbox config and returns 201', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', {
        name: 'My Docker Config',
        type: 'docker',
        memoryMb: 4096,
        cpuCores: 2,
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('My Docker Config');
    expect(body.data.type).toBe('docker');
    expect(body.data.memoryMb).toBe(4096);
    expect(body.data.id).toBeDefined();
  });

  it('IT-402: POST / returns 400 when name is missing', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', {
        type: 'docker',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-403: POST / returns 400 for invalid JSON', async () => {
    const response = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-404: POST / returns 400 for invalid nomadAddress (SSRF-blocked metadata endpoint)', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Bad Nomad',
        nomadAddress: 'http://169.254.169.254/latest/meta-data/',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ADDRESS');
  });

  it('IT-405: POST / redacts nomadToken in response', async () => {
    // Create config via service (bypassing nomadAddress DNS validation in the route)
    // to verify that the route's GET response redacts sensitive fields
    const createResult = await service.create({
      name: 'Nomad With Token',
      type: 'nomad',
      nomadAddress: 'https://10.0.1.50:4646',
      nomadToken: 'secret-token-abc',
      nomadNamespace: 'staging',
    });
    if (!createResult.ok) throw new Error('Setup failed');
    const configId = createResult.value.id;

    // GET the config via the route - should redact sensitive fields
    const response = await app.request(`http://localhost/${configId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // nomadToken is redacted in the response
    expect(body.data).not.toHaveProperty('nomadToken');
    // Non-sensitive Nomad fields should be present
    expect(body.data.nomadAddress).toBe('https://10.0.1.50:4646');
    expect(body.data.nomadNamespace).toBe('staging');
  });

  // ─── GET /api/sandbox-configs ───────────────────────

  it('IT-406: GET / lists sandbox configs with totalCount', async () => {
    // Create 3 configs
    for (let i = 1; i <= 3; i++) {
      await service.create({ name: `Config ${i}` });
    }

    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(3);
    expect(body.data.totalCount).toBe(3);
  });

  it('IT-407: GET / supports limit and offset pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      await service.create({ name: `Config ${i}` });
    }

    const response = await app.request('http://localhost/?limit=2&offset=2');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.totalCount).toBe(5);
  });

  it('IT-408: GET / returns empty list when no configs exist', async () => {
    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(0);
    expect(body.data.totalCount).toBe(0);
  });

  // ─── GET /api/sandbox-configs/:id ───────────────────

  it('IT-409: GET /:id returns a config by ID', async () => {
    const createResult = await service.create({ name: 'Lookup Config', type: 'kubernetes' });
    if (!createResult.ok) throw new Error('Setup failed');
    const configId = createResult.value.id;

    const response = await app.request(`http://localhost/${configId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(configId);
    expect(body.data.name).toBe('Lookup Config');
  });

  it('IT-410: GET /:id returns 404 for nonexistent config', async () => {
    const response = await app.request('http://localhost/nonexistent-id-abc');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-411: GET /:id returns 400 for invalid ID format', async () => {
    const response = await app.request('http://localhost/ab!cd');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── PATCH /api/sandbox-configs/:id ─────────────────

  it('IT-412: PATCH /:id updates config fields', async () => {
    const createResult = await service.create({ name: 'Original', description: 'Desc' });
    if (!createResult.ok) throw new Error('Setup failed');
    const configId = createResult.value.id;

    const response = await app.request(
      jsonRequest(
        `http://localhost/${configId}`,
        { description: 'Updated', memoryMb: 8192 },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.description).toBe('Updated');
    expect(body.data.memoryMb).toBe(8192);
    expect(body.data.name).toBe('Original');
  });

  it('IT-413: PATCH /:id returns 404 for nonexistent config', async () => {
    const response = await app.request(
      jsonRequest(
        'http://localhost/nonexistent-id-xyz',
        { description: 'nope' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-414: PATCH /:id returns 400 for invalid body', async () => {
    const createResult = await service.create({ name: 'Patch Target' });
    if (!createResult.ok) throw new Error('Setup failed');

    const response = await app.request(
      new Request(`http://localhost/${createResult.value.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-415: PATCH /:id rejects invalid nomadAddress', async () => {
    const createResult = await service.create({ name: 'Nomad Patch' });
    if (!createResult.ok) throw new Error('Setup failed');

    const response = await app.request(
      jsonRequest(
        `http://localhost/${createResult.value.id}`,
        { nomadAddress: 'http://169.254.169.254/latest' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_ADDRESS');
  });

  // ─── DELETE /api/sandbox-configs/:id ────────────────

  it('IT-416: DELETE /:id removes a config', async () => {
    const createResult = await service.create({ name: 'To Delete' });
    if (!createResult.ok) throw new Error('Setup failed');
    const configId = createResult.value.id;

    const response = await app.request(`http://localhost/${configId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // Verify it's gone
    const getResponse = await app.request(`http://localhost/${configId}`);
    expect(getResponse.status).toBe(404);
  });

  it('IT-417: DELETE /:id returns 404 for nonexistent config', async () => {
    const response = await app.request('http://localhost/nonexistent-id-del', { method: 'DELETE' });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-418: DELETE /:id blocked when config is referenced by a codespace', async () => {
    const createResult = await service.create({ name: 'In Use Config' });
    if (!createResult.ok) throw new Error('Setup failed');
    const configId = createResult.value.id;

    // Create a codespace referencing this config
    await createTestProject({ sandboxConfigId: configId });

    const response = await app.request(`http://localhost/${configId}`, { method: 'DELETE' });
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });
});
