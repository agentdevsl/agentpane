// @vitest-environment node
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNomadRoutes, validateNomadAddress } from '../sandbox.js';

// Use vi.hoisted so the mock fn reference is available inside the vi.mock factory
// (which is hoisted to the top of the file by Vitest before any imports run).
const { mockDnsResolve } = vi.hoisted(() => ({
  mockDnsResolve: vi.fn().mockResolvedValue([]),
}));

// Mock node:dns/promises so tests never make real DNS calls.
// By default return an empty array (no resolved IPs → passes the DNS check).
vi.mock('node:dns/promises', () => {
  return {
    default: {},
    resolve: mockDnsResolve,
    lookup: vi.fn(),
    resolve4: vi.fn(),
    resolve6: vi.fn(),
    resolveMx: vi.fn(),
    resolveNs: vi.fn(),
    resolveTxt: vi.fn(),
    resolveSrv: vi.fn(),
    resolveCname: vi.fn(),
    resolveNaptr: vi.fn(),
    resolvePtr: vi.fn(),
    resolveSoa: vi.fn(),
    reverse: vi.fn(),
    getServers: vi.fn(),
    setServers: vi.fn(),
    Resolver: class {},
  };
});

describe('validateNomadAddress', () => {
  // ── Allowed addresses ──────────────────────────────────────────────

  it('allows http://127.0.0.1:4646 (localhost for dev)', async () => {
    await expect(validateNomadAddress('http://127.0.0.1:4646')).resolves.toEqual({ valid: true });
  });

  it('allows http://nomad.example.com:4646 (public hostname)', async () => {
    await expect(validateNomadAddress('http://nomad.example.com:4646')).resolves.toEqual({
      valid: true,
    });
  });

  it('allows http://192.168.1.100:4646 (local network allowed)', async () => {
    await expect(validateNomadAddress('http://192.168.1.100:4646')).resolves.toEqual({
      valid: true,
    });
  });

  it('allows https://nomad.prod.company.io (https with public hostname)', async () => {
    await expect(validateNomadAddress('https://nomad.prod.company.io')).resolves.toEqual({
      valid: true,
    });
  });

  it('blocks localhost hostname', async () => {
    const result = await validateNomadAddress('http://localhost:4646');
    expect(result.valid).toBe(false);
  });

  // ── Blocked: cloud metadata (169.254.x.x link-local) ──────────────

  it('blocks http://169.254.169.254 (AWS/GCP cloud metadata)', async () => {
    const result = await validateNomadAddress('http://169.254.169.254');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/cloud metadata/);
  });

  it('blocks http://169.254.1.1 (link-local range)', async () => {
    const result = await validateNomadAddress('http://169.254.1.1');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/cloud metadata/);
  });

  it('blocks http://169.254.169.254/latest/meta-data/ (metadata path)', async () => {
    const result = await validateNomadAddress('http://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/cloud metadata/);
  });

  it('blocks http://metadata.google.internal (GCP metadata hostname)', async () => {
    const result = await validateNomadAddress('http://metadata.google.internal');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/cloud metadata/);
  });

  // ── Blocked: 0.0.0.0 ──────────────────────────────────────────────

  it('blocks http://0.0.0.0:4646', async () => {
    const result = await validateNomadAddress('http://0.0.0.0:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/0\.0\.0\.0/);
  });

  // ── Blocked: IPv6 loopback ─────────────────────────────────────────

  it('blocks http://[::1]:4646 (IPv6 loopback)', async () => {
    const result = await validateNomadAddress('http://[::1]:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/IPv6 loopback/);
  });

  // ── Blocked: IPv6 link-local ───────────────────────────────────────

  it('blocks URLs with fe80: (IPv6 link-local)', async () => {
    const result = await validateNomadAddress('http://[fe80::1]:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/IPv6 link-local/);
  });

  // ── Blocked: RFC 1918 - 10.x.x.x ──────────────────────────────────

  it('blocks http://10.0.0.1:4646 (RFC 1918 - 10.x)', async () => {
    const result = await validateNomadAddress('http://10.0.0.1:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/internal network/);
  });

  it('blocks http://10.255.255.1:4646 (RFC 1918 - 10.x upper range)', async () => {
    const result = await validateNomadAddress('http://10.255.255.1:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/internal network/);
  });

  // ── Blocked: RFC 1918 - 172.16-31.x ───────────────────────────────

  it('blocks http://172.16.0.1:4646 (RFC 1918 - 172.16.x)', async () => {
    const result = await validateNomadAddress('http://172.16.0.1:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/internal network/);
  });

  it('blocks http://172.31.255.1:4646 (RFC 1918 - 172.31.x)', async () => {
    const result = await validateNomadAddress('http://172.31.255.1:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/internal network/);
  });

  it('does not block http://172.15.0.1:4646 (outside 172.16-31 range)', async () => {
    await expect(validateNomadAddress('http://172.15.0.1:4646')).resolves.toEqual({ valid: true });
  });

  it('does not block http://172.32.0.1:4646 (outside 172.16-31 range)', async () => {
    await expect(validateNomadAddress('http://172.32.0.1:4646')).resolves.toEqual({ valid: true });
  });

  // ── Blocked: IPv6-mapped metadata ─────────────────────────────────

  it('blocks http://[::ffff:169.254.169.254] (IPv6-mapped metadata)', async () => {
    const result = await validateNomadAddress('http://[::ffff:169.254.169.254]:4646');
    expect(result.valid).toBe(false);
  });

  // ── Blocked: invalid URLs ──────────────────────────────────────────

  it('rejects invalid URL format', async () => {
    const result = await validateNomadAddress('not-a-url');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/Invalid Nomad address URL format/);
  });

  it('rejects empty string', async () => {
    const result = await validateNomadAddress('');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/Invalid Nomad address URL format/);
  });

  it('rejects non-http/https protocols (ftp)', async () => {
    const result = await validateNomadAddress('ftp://nomad.example.com:4646');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/http or https protocol/);
  });

  it('rejects non-http/https protocols (file)', async () => {
    const result = await validateNomadAddress('file:///etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/http or https protocol/);
  });

  // ── Loopback port restriction (SSRF fix) ──────────────────────────

  it('allows 127.0.0.1:4646 (Nomad default port)', async () => {
    await expect(validateNomadAddress('http://127.0.0.1:4646')).resolves.toEqual({ valid: true });
  });

  it('blocks 127.0.0.1:6379 (Redis port)', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:6379');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/port 4646/);
  });

  it('blocks 127.0.0.1:3001 (app server port)', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:3001');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/port 4646/);
  });

  it('blocks 127.0.0.1:80 (default HTTP port)', async () => {
    const result = await validateNomadAddress('http://127.0.0.1:80');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/port 4646/);
  });

  it('blocks 127.0.0.1 without a port (defaults to port 80, not 4646)', async () => {
    const result = await validateNomadAddress('http://127.0.0.1');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/port 4646/);
  });

  it('allows http://127.0.0.1:4646 with explicit http scheme', async () => {
    await expect(validateNomadAddress('http://127.0.0.1:4646')).resolves.toEqual({ valid: true });
  });

  it('allows https://127.100.0.1:4646 (any 127.x on port 4646)', async () => {
    await expect(validateNomadAddress('https://127.100.0.1:4646')).resolves.toEqual({
      valid: true,
    });
  });

  // ── DNS rebinding prevention ───────────────────────────────────────

  it('blocks a hostname that DNS-resolves to a private IP (rebinding attack)', async () => {
    // Temporarily replace the mock to return a private IP for this call.
    mockDnsResolve.mockReset();
    mockDnsResolve.mockResolvedValue(['169.254.169.254']);

    const result = await validateNomadAddress('http://evil.example.com:4646');

    // Restore the default (return empty array) for subsequent tests.
    mockDnsResolve.mockReset();
    mockDnsResolve.mockResolvedValue([]);

    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/private\/reserved IP/);
  });

  it('allows address through when DNS resolution fails (internal hostname)', async () => {
    // Temporarily replace the mock to simulate a DNS failure.
    mockDnsResolve.mockReset();
    mockDnsResolve.mockRejectedValue(new Error('ENOTFOUND internal.corp'));

    const result = await validateNomadAddress('http://internal.corp:4646');

    // Restore the default for subsequent tests.
    mockDnsResolve.mockReset();
    mockDnsResolve.mockResolvedValue([]);

    expect(result).toEqual({ valid: true });
  });
});

// ── loadNomadSettings (tested indirectly via /status route) ─────────

// Mock the dynamic imports that loadNomadSettings uses internally
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('../../../db/schema/index.js', () => ({
  settings: { key: 'key_column' },
}));

vi.mock('../../../lib/crypto/server-encryption.js', () => ({
  decryptToken: vi.fn(),
}));

const mockHealthCheck = vi.fn();
const mockListJobs = vi.fn();

vi.mock('@agentpane/nomad-sandbox-sdk', () => {
  return {
    NomadSandboxClient: class MockNomadSandboxClient {
      opts: Record<string, unknown>;
      constructor(opts: Record<string, unknown>) {
        this.opts = opts;
        mockNomadClientConstructorCalls.push(opts);
      }
      healthCheck = mockHealthCheck;
      listJobs = mockListJobs;
    },
  };
});

/** Tracks constructor calls so we can assert what address/token/namespace were passed. */
const mockNomadClientConstructorCalls: Array<Record<string, unknown>> = [];

// ── Mock DB Factory ──

function createMockDb(settingsValue?: { address?: string; token?: string; namespace?: string }) {
  return {
    query: {
      settings: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            settingsValue
              ? { key: 'sandbox.nomad', value: JSON.stringify(settingsValue) }
              : undefined
          ),
      },
    },
  };
}

// ── Hono Test App Factory ──

function createNomadTestApp(db?: ReturnType<typeof createMockDb>) {
  const routes = createNomadRoutes(db ? { db: db as never } : undefined);
  const app = new Hono();
  app.route('/api/sandbox/nomad', routes);
  return app;
}

// ── Request Helper ──

async function request(app: Hono, path: string) {
  return app.request(path, { method: 'GET' });
}

describe('loadNomadSettings (via /status route)', () => {
  let decryptTokenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Get handle to the mocked decryptToken function
    const cryptoMod = await import('../../../lib/crypto/server-encryption.js');
    decryptTokenMock = cryptoMod.decryptToken as ReturnType<typeof vi.fn>;
    decryptTokenMock.mockReset();
    decryptTokenMock.mockReturnValue('decrypted-token');

    // Reset NomadSandboxClient tracking
    mockNomadClientConstructorCalls.length = 0;
    mockHealthCheck.mockReset();
    mockHealthCheck.mockResolvedValue({
      healthy: true,
      leader: '127.0.0.1:4647',
      version: '1.7.0',
      datacenter: 'dc1',
      namespaceExists: true,
    });
    mockListJobs.mockReset();
    mockListJobs.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Token returned when address matches ──

  it('returns token when address matches stored address', async () => {
    const db = createMockDb({ address: 'http://nomad.example.com:4646', token: 'encrypted-tok' });
    const app = createNomadTestApp(db);

    const res = await request(app, '/api/sandbox/nomad/status');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.healthy).toBe(true);
    // The token was decrypted and passed to the NomadSandboxClient
    expect(decryptTokenMock).toHaveBeenCalledWith('encrypted-tok');
    expect(mockNomadClientConstructorCalls).toHaveLength(1);
    expect(mockNomadClientConstructorCalls[0]).toEqual(
      expect.objectContaining({ token: 'decrypted-token' })
    );
  });

  // ── Token NOT returned when address differs (SSRF protection) ──

  it('does NOT return token when a different address is provided', async () => {
    const db = createMockDb({ address: 'http://nomad.example.com:4646', token: 'encrypted-tok' });
    const app = createNomadTestApp(db);

    // Override address via query param to a different (valid) host
    const res = await request(
      app,
      '/api/sandbox/nomad/status?address=http://other-nomad.example.com:4646'
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Token should NOT have been decrypted because addresses differ
    expect(decryptTokenMock).not.toHaveBeenCalled();
    // Client should have been created WITHOUT a token
    expect(mockNomadClientConstructorCalls).toHaveLength(1);
    expect(mockNomadClientConstructorCalls[0]).toEqual(
      expect.objectContaining({ token: undefined })
    );
  });

  // ── Token decryption failure sets tokenDecryptionFailed ──

  it('sets tokenDecryptionFailed when decryption throws', async () => {
    decryptTokenMock.mockImplementation(() => {
      throw new Error('Decryption failed: key rotated');
    });

    const db = createMockDb({ address: 'http://nomad.example.com:4646', token: 'bad-encrypted' });
    const app = createNomadTestApp(db);

    const res = await request(app, '/api/sandbox/nomad/status');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.tokenDecryptionFailed).toBe(true);
    // Client should have been created without a token
    expect(mockNomadClientConstructorCalls).toHaveLength(1);
    expect(mockNomadClientConstructorCalls[0]).toEqual(
      expect.objectContaining({ token: undefined })
    );
  });

  // ── Address validation runs on overrides (SSRF blocked) ──

  it('rejects SSRF addresses passed as query param overrides', async () => {
    const db = createMockDb({ address: 'http://nomad.example.com:4646', token: 'encrypted-tok' });
    const app = createNomadTestApp(db);

    // Try to override with a cloud metadata address
    const res = await request(
      app,
      '/api/sandbox/nomad/status?address=http://169.254.169.254/latest/meta-data/'
    );
    const body = await res.json();

    // loadNomadSettings throws, caught by the route's try/catch
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
    expect(body.error.message).toContain('cloud metadata');
  });

  it('rejects loopback addresses on non-Nomad ports via query param', async () => {
    const db = createMockDb({ address: 'http://nomad.example.com:4646', token: 'encrypted-tok' });
    const app = createNomadTestApp(db);

    const res = await request(app, '/api/sandbox/nomad/status?address=http://127.0.0.1:6379');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('port 4646');
  });

  // ── DB error propagates (not swallowed) ──

  it('propagates DB errors to the caller', async () => {
    const db = createMockDb();
    // Override findFirst to throw a database error
    db.query.settings.findFirst.mockRejectedValue(
      new Error('SQLITE_CORRUPT: database is malformed')
    );
    const app = createNomadTestApp(db);

    const res = await request(app, '/api/sandbox/nomad/status');
    const body = await res.json();

    // The DB error should propagate through to the route's catch handler
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOMAD_CONNECTION_ERROR');
    expect(body.error.message).toContain('SQLITE_CORRUPT');
  });

  // ── Returns defaults when no DB ──

  it('returns defaults when no DB is provided', async () => {
    // Create routes without a DB dependency
    const app = createNomadTestApp(undefined);

    const res = await request(app, '/api/sandbox/nomad/status');
    const body = await res.json();

    // Without DB and no address override, no address is configured
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.healthy).toBe(false);
    expect(body.data.message).toBe('No Nomad address configured');
  });

  // ── Token attached when override matches stored address ──

  it('attaches token when override address matches stored address', async () => {
    const storedAddress = 'http://nomad.example.com:4646';
    const db = createMockDb({ address: storedAddress, token: 'encrypted-tok' });
    const app = createNomadTestApp(db);

    // Explicitly pass the same address as an override
    const res = await request(
      app,
      `/api/sandbox/nomad/status?address=${encodeURIComponent(storedAddress)}`
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Token should be decrypted because addresses match
    expect(decryptTokenMock).toHaveBeenCalledWith('encrypted-tok');
    expect(mockNomadClientConstructorCalls).toHaveLength(1);
    expect(mockNomadClientConstructorCalls[0]).toEqual(
      expect.objectContaining({ token: 'decrypted-token' })
    );
  });

  // ── Namespace override ──

  it('uses namespace override when provided', async () => {
    const db = createMockDb({
      address: 'http://nomad.example.com:4646',
      namespace: 'production',
    });
    const app = createNomadTestApp(db);

    const res = await request(app, '/api/sandbox/nomad/status?namespace=staging');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.namespace).toBe('staging');
    // Client should be created with the overridden namespace
    expect(mockNomadClientConstructorCalls).toHaveLength(1);
    expect(mockNomadClientConstructorCalls[0]).toEqual(
      expect.objectContaining({ namespace: 'staging' })
    );
  });
});
