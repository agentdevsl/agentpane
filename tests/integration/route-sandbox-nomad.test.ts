import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for Nomad sandbox routes.
 *
 * Tests SSRF validation, address validation, and route behavior.
 * Mocks the Nomad SDK client since we don't have a real Nomad cluster.
 */

// Mock the Nomad SDK
vi.mock('@agentpane/nomad-sandbox-sdk', () => ({
  NomadSandboxClient: vi.fn(),
}));

// Mock DNS resolution for SSRF validation
vi.mock('node:dns/promises', () => ({
  resolve: vi.fn(),
}));

import { resolve as dnsResolve } from 'node:dns/promises';
import { NomadSandboxClient } from '@agentpane/nomad-sandbox-sdk';
import { createNomadRoutes, validateNomadAddress } from '../../src/server/routes/sandbox-nomad';

const mockDnsResolve = vi.mocked(dnsResolve);
const MockNomadClient = vi.mocked(NomadSandboxClient);

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Nomad Sandbox Routes (IT-580)', () => {
  let app: ReturnType<typeof createNomadRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createNomadRoutes();
    // Default: DNS resolves to a public IP
    mockDnsResolve.mockResolvedValue(['203.0.113.1']);
  });

  // ─── validateNomadAddress (SSRF prevention) ───

  describe('validateNomadAddress', () => {
    it('IT-581: accepts valid public HTTP address', async () => {
      const result = await validateNomadAddress('http://nomad.example.com:4646');
      expect(result.valid).toBe(true);
    });

    it('IT-582: accepts valid public HTTPS address', async () => {
      const result = await validateNomadAddress('https://nomad.prod.example.com:4646');
      expect(result.valid).toBe(true);
    });

    it('IT-583: rejects invalid URL format', async () => {
      const result = await validateNomadAddress('not-a-url');
      expect(result.valid).toBe(false);
    });

    it('IT-584: rejects non-HTTP protocols', async () => {
      const result = await validateNomadAddress('ftp://nomad.example.com');
      expect(result.valid).toBe(false);
    });

    it('IT-585: blocks cloud metadata endpoint 169.254.169.254', async () => {
      const result = await validateNomadAddress('http://169.254.169.254/latest/meta-data');
      expect(result.valid).toBe(false);
    });

    it('IT-586: blocks metadata.google.internal', async () => {
      const result = await validateNomadAddress('http://metadata.google.internal');
      expect(result.valid).toBe(false);
    });

    it('IT-587: blocks 0.0.0.0', async () => {
      const result = await validateNomadAddress('http://0.0.0.0:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-588: blocks localhost', async () => {
      const result = await validateNomadAddress('http://localhost:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-589: allows 127.0.0.1 only on port 4646', async () => {
      const validResult = await validateNomadAddress('http://127.0.0.1:4646');
      expect(validResult.valid).toBe(true);

      const invalidResult = await validateNomadAddress('http://127.0.0.1:6379');
      expect(invalidResult.valid).toBe(false);
    });

    it('IT-590: blocks 10.x.x.x addresses (RFC 1918)', async () => {
      const result = await validateNomadAddress('http://10.0.0.1:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-591: blocks 172.16-31.x.x addresses (RFC 1918)', async () => {
      const result = await validateNomadAddress('http://172.16.0.1:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-592: allows 192.168.x.x only on port 4646', async () => {
      const validResult = await validateNomadAddress('http://192.168.1.1:4646');
      expect(validResult.valid).toBe(true);

      const invalidResult = await validateNomadAddress('http://192.168.1.1:8080');
      expect(invalidResult.valid).toBe(false);
    });

    it('IT-593: blocks IPv6 loopback', async () => {
      const result = await validateNomadAddress('http://[::1]:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-594: blocks DNS rebinding to private IP', async () => {
      mockDnsResolve.mockResolvedValue(['127.0.0.1']);
      const result = await validateNomadAddress('http://evil.example.com:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-595: blocks DNS rebinding to cloud metadata IP', async () => {
      mockDnsResolve.mockResolvedValue(['169.254.169.254']);
      const result = await validateNomadAddress('http://evil.example.com:4646');
      expect(result.valid).toBe(false);
    });

    it('IT-596: fails closed on DNS resolution failure', async () => {
      mockDnsResolve.mockRejectedValue(new Error('DNS lookup failed'));
      const result = await validateNomadAddress('http://unreachable.example.com:4646');
      expect(result.valid).toBe(false);
    });
  });

  // ─── GET /status ──────────────────────────────

  describe('GET /status', () => {
    it('IT-597: returns unhealthy when no address configured', async () => {
      const response = await app.request('http://localhost/status');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('No Nomad address configured');
    });
  });

  // ─── POST /validate ───────────────────────────

  describe('POST /validate', () => {
    it('IT-598: returns 400 for invalid JSON', async () => {
      const response = await app.request(
        new Request('http://localhost/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-599: returns 400 when address is missing', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/validate', { token: 'abc' })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      // arch29-W2-H / F07-15: standardised to VALIDATION_ERROR.
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-600: returns 400 for SSRF-blocked address', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/validate', {
          address: 'http://169.254.169.254/latest/meta-data',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_ADDRESS');
    });

    it('IT-601: validates connection with valid address', async () => {
      MockNomadClient.mockImplementation(function (this: any) {
        this.healthCheck = vi.fn().mockResolvedValue({
          healthy: true,
          leader: '10.0.0.1:4648',
          version: '1.7.0',
          datacenter: 'dc1',
          namespaceExists: true,
        });
      } as any);

      const response = await app.request(
        jsonRequest('http://localhost/validate', {
          address: 'http://203.0.113.1:4646',
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.version).toBe('1.7.0');
    });
  });

  // ─── GET /namespaces ──────────────────────────

  describe('GET /namespaces', () => {
    it('IT-602: returns 400 when no address configured', async () => {
      const response = await app.request('http://localhost/namespaces');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_NOT_CONFIGURED');
    });
  });

  // ─── GET /datacenters ─────────────────────────

  describe('GET /datacenters', () => {
    it('IT-603: returns 400 when no address configured', async () => {
      const response = await app.request('http://localhost/datacenters');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('NOMAD_NOT_CONFIGURED');
    });
  });
});
