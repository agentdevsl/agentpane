/**
 * Coverage gap-filler for `src/server/routes/sandbox-nomad.ts`.
 *
 * The existing route test (`route-sandbox-nomad.test.ts`) covers
 * validateNomadAddress + a few baseline route behaviors. This file adds:
 * - GET /status with persisted address (DB lookup happy path)
 * - GET /status when client.healthCheck/listJobs throw
 * - GET /status with token decryption failure (tokenDecryptionFailed flag)
 * - GET /namespaces and /datacenters happy paths
 * - POST /validate when health throws (NOMAD_VALIDATION_ERROR)
 * - loadNomadSettings: malformed JSON, address override SSRF, DB throw
 *
 * IT-IDs: IT-2300 to IT-2329
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agentpane/nomad-sandbox-sdk', () => ({
  NomadSandboxClient: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  resolve: vi.fn().mockResolvedValue(['203.0.113.1']),
}));

import { NomadSandboxClient } from '@agentpane/nomad-sandbox-sdk';
import { settings } from '../../src/db/schema';
import { encryptToken } from '../../src/lib/crypto/server-encryption';
import { createNomadRoutes } from '../../src/server/routes/sandbox-nomad';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const MockNomadClient = vi.mocked(NomadSandboxClient);

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Sandbox Nomad Routes — extras (gap-fillers)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── GET /status with DB-persisted address ──────────────────────────

  describe('GET /status with persisted settings', () => {
    it('IT-2300: returns healthy when address persisted and client healthy', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({
          address: 'http://203.0.113.1:4646',
          namespace: 'default',
        }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (
          this as { healthCheck: () => Promise<unknown>; listJobs: () => Promise<unknown[]> }
        ).healthCheck = vi.fn().mockResolvedValue({
          healthy: true,
          leader: '10.0.0.1:4648',
          version: '1.7.0',
          datacenter: 'dc1',
          namespaceExists: true,
        });
        (this as { listJobs: () => Promise<unknown[]> }).listJobs = vi
          .fn()
          .mockResolvedValue([{ ID: 'a' }, { ID: 'b' }]);
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/status');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.healthy).toBe(true);
      expect(body.data.version).toBe('1.7.0');
      expect(body.data.jobCount).toBe(2);
    });

    it('IT-2301: returns jobCount=null when listJobs throws (client healthy)', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({ address: 'http://203.0.113.1:4646' }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { healthCheck: () => Promise<unknown> }).healthCheck = vi.fn().mockResolvedValue({
          healthy: true,
          leader: '10.0.0.1:4648',
        });
        (this as { listJobs: () => Promise<unknown[]> }).listJobs = vi
          .fn()
          .mockRejectedValue(new Error('jobs API down'));
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/status');
      const body = await response.json();
      expect(body.data.healthy).toBe(true);
      expect(body.data.jobCount).toBeNull();
    });

    it('IT-2302: returns 500 NOMAD_CONNECTION_ERROR when healthCheck throws', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({ address: 'http://203.0.113.1:4646' }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { healthCheck: () => Promise<unknown> }).healthCheck = vi
          .fn()
          .mockRejectedValue(new Error('connection refused'));
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/status');
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
    });

    it('IT-2303: surfaces tokenDecryptionFailed flag when stored token is corrupt', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({
          address: 'http://203.0.113.1:4646',
          // Not a valid encrypted blob — decryption will throw.
          token: 'not-a-real-encrypted-token-just-some-base64-padding==',
        }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { healthCheck: () => Promise<unknown> }).healthCheck = vi.fn().mockResolvedValue({
          healthy: true,
          leader: 'leader-1',
        });
        (this as { listJobs: () => Promise<unknown[]> }).listJobs = vi.fn().mockResolvedValue([]);
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/status');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.tokenDecryptionFailed).toBe(true);
    });

    it('IT-2304: passes decrypted token to the client when stored token is valid', async () => {
      const db = getTestDb();
      const encrypted = encryptToken('plaintext-token-123');
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({
          address: 'http://203.0.113.1:4646',
          token: encrypted,
          namespace: 'production',
        }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { healthCheck: () => Promise<unknown> }).healthCheck = vi.fn().mockResolvedValue({
          healthy: true,
        });
        (this as { listJobs: () => Promise<unknown[]> }).listJobs = vi.fn().mockResolvedValue([]);
      } as never);

      const app = createNomadRoutes({ db: db as never });
      await app.request('http://localhost/status');
      // Token was successfully decrypted and passed to client constructor
      expect(MockNomadClient).toHaveBeenCalledWith(
        expect.objectContaining({
          address: 'http://203.0.113.1:4646',
          token: 'plaintext-token-123',
          namespace: 'production',
        })
      );
    });
  });

  // ─── /namespaces and /datacenters happy paths ──────────────────────

  describe('GET /namespaces and /datacenters', () => {
    it('IT-2310: returns namespaces from client', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({ address: 'http://203.0.113.1:4646' }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { listNamespaces: () => Promise<string[]> }).listNamespaces = vi
          .fn()
          .mockResolvedValue(['default', 'production']);
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/namespaces');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.namespaces).toEqual(['default', 'production']);
    });

    it('IT-2311: returns datacenters from client', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({ address: 'http://203.0.113.1:4646' }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { listDatacenters: () => Promise<string[]> }).listDatacenters = vi
          .fn()
          .mockResolvedValue(['dc1', 'dc2']);
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/datacenters');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.datacenters).toEqual(['dc1', 'dc2']);
    });

    it('IT-2312: returns 500 NOMAD_API_ERROR when listNamespaces throws', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.nomad',
        value: JSON.stringify({ address: 'http://203.0.113.1:4646' }),
      });

      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { listNamespaces: () => Promise<string[]> }).listNamespaces = vi
          .fn()
          .mockRejectedValue(new Error('forbidden'));
      } as never);

      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/namespaces');
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_API_ERROR');
    });
  });

  // ─── POST /validate failure path ───────────────────────────────────

  describe('POST /validate failure path', () => {
    it('IT-2320: returns 500 NOMAD_VALIDATION_ERROR when healthCheck throws', async () => {
      MockNomadClient.mockImplementation(function (this: unknown) {
        (this as { healthCheck: () => Promise<unknown> }).healthCheck = vi
          .fn()
          .mockRejectedValue(new Error('refused'));
      } as never);

      const app = createNomadRoutes();
      const response = await app.request(
        jsonRequest('http://localhost/validate', { address: 'http://203.0.113.2:4646' })
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_VALIDATION_ERROR');
    });
  });

  // ─── loadNomadSettings catch arms ──────────────────────────────────

  describe('loadNomadSettings malformed/missing settings', () => {
    it('IT-2325: tolerates missing setting row (no address configured)', async () => {
      const app = createNomadRoutes({ db: getTestDb() as never });
      const response = await app.request('http://localhost/status');
      const body = await response.json();
      expect(body.data.healthy).toBe(false);
    });

    it('IT-2326: returns 500 when stored sandbox.nomad value is malformed JSON', async () => {
      const db = getTestDb();
      await db.insert(settings).values({ key: 'sandbox.nomad', value: '{not valid' });
      const app = createNomadRoutes({ db: db as never });
      const response = await app.request('http://localhost/status');
      // The catch in loadNomadSettings rethrows, status route catches and returns 500
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
    });

    it('IT-2327: SSRF address override returns 500 NOMAD_CONNECTION_ERROR', async () => {
      // Override via query string: an SSRF-blocked address triggers throw in
      // loadNomadSettings → status route catches → 500 NOMAD_CONNECTION_ERROR
      const app = createNomadRoutes({ db: getTestDb() as never });
      const response = await app.request(
        'http://localhost/status?address=http://169.254.169.254/latest/meta-data'
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
    });
  });
});
