/**
 * Integration tests for the Nomad routes inside src/server/routes/sandbox-nomad.ts.
 *
 * The existing route-sandbox.test.ts only exercises validateNomadAddress SSRF
 * branches and the validate endpoint with bad addresses. These tests cover the
 * happy-path Nomad cluster status/namespaces/datacenters/validate endpoints
 * by mocking the @agentpane/nomad-sandbox-sdk client.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nomadClientMock = vi.hoisted(() => {
  const instance = {
    healthCheck: vi.fn(),
    listJobs: vi.fn(),
    listNamespaces: vi.fn(),
    listDatacenters: vi.fn(),
  };
  return {
    NomadSandboxClient: vi.fn(function (this: unknown, _opts: unknown) {
      Object.assign(this as object, instance);
    }),
    instance,
  };
});

vi.mock('@agentpane/nomad-sandbox-sdk', () => ({
  NomadSandboxClient: nomadClientMock.NomadSandboxClient,
}));

import { createNomadRoutes } from '../../src/server/routes/sandbox-nomad';

function mountNomadRoutes() {
  const app = new Hono();
  // Pass undefined for db so loadNomadSettings only uses overrides
  app.route('/api/sandbox/nomad', createNomadRoutes());
  return app;
}

describe('Nomad routes — happy-path coverage (IT-NOMAD-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nomadClientMock.instance.healthCheck.mockResolvedValue({
      healthy: true,
      leader: '10.0.0.1:4647',
      version: '1.7.2',
      datacenter: 'dc1',
      namespaceExists: true,
    });
    nomadClientMock.instance.listJobs.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
    nomadClientMock.instance.listNamespaces.mockResolvedValue([
      { name: 'default' },
      { name: 'production' },
    ]);
    nomadClientMock.instance.listDatacenters.mockResolvedValue(['dc1', 'dc2']);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET /status returns healthy:false when no address configured', async () => {
    const app = mountNomadRoutes();
    const res = await app.request('http://localhost/api/sandbox/nomad/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { healthy: boolean; message?: string } };
    expect(body.data.healthy).toBe(false);
    expect(body.data.message).toContain('No Nomad address configured');
  });

  it('GET /status returns healthy + jobCount when address provided', async () => {
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/status?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        healthy: boolean;
        version: string;
        leader: string;
        datacenter: string;
        jobCount: number;
        namespaceExists: boolean;
      };
    };
    expect(body.data.healthy).toBe(true);
    expect(body.data.version).toBe('1.7.2');
    expect(body.data.leader).toBe('10.0.0.1:4647');
    expect(body.data.jobCount).toBe(2);
    expect(body.data.namespaceExists).toBe(true);
  });

  it('GET /status surfaces job-fetch failures as jobCount=null', async () => {
    nomadClientMock.instance.listJobs.mockRejectedValueOnce(new Error('jobs api down'));
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/status?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { jobCount: number | null } };
    expect(body.data.jobCount).toBeNull();
  });

  it('GET /status returns 500 NOMAD_CONNECTION_ERROR on healthCheck failure', async () => {
    nomadClientMock.instance.healthCheck.mockRejectedValueOnce(new Error('connection refused'));
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/status?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
  });

  it('GET /namespaces returns 400 when no address configured', async () => {
    const app = mountNomadRoutes();
    const res = await app.request('http://localhost/api/sandbox/nomad/namespaces');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('NOMAD_NOT_CONFIGURED');
  });

  it('GET /namespaces returns 200 with namespace list', async () => {
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/namespaces?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { namespaces: Array<{ name: string }> } };
    expect(body.data.namespaces).toHaveLength(2);
  });

  it('GET /namespaces returns 500 NOMAD_API_ERROR on client failure', async () => {
    nomadClientMock.instance.listNamespaces.mockRejectedValueOnce(
      new Error('namespace ACL denied')
    );
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/namespaces?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('NOMAD_API_ERROR');
  });

  it('GET /datacenters returns 200 with datacenter list', async () => {
    const app = mountNomadRoutes();
    const res = await app.request(
      'http://localhost/api/sandbox/nomad/datacenters?address=https://203.0.113.10:4646'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { datacenters: string[] } };
    expect(body.data.datacenters).toEqual(['dc1', 'dc2']);
  });

  it('POST /validate returns 200 when healthCheck succeeds', async () => {
    const app = mountNomadRoutes();
    const res = await app.request('http://localhost/api/sandbox/nomad/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: 'https://203.0.113.10:4646',
        namespace: 'default',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { healthy: boolean; version: string; leader: string };
    };
    expect(body.data.healthy).toBe(true);
    expect(body.data.version).toBe('1.7.2');
  });

  it('POST /validate returns 500 NOMAD_VALIDATION_ERROR on healthCheck failure', async () => {
    nomadClientMock.instance.healthCheck.mockRejectedValueOnce(new Error('cluster unreachable'));
    const app = mountNomadRoutes();
    const res = await app.request('http://localhost/api/sandbox/nomad/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'https://203.0.113.10:4646' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('NOMAD_VALIDATION_ERROR');
  });
});
