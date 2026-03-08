/**
 * Tests for settings routes.
 *
 * Covers:
 * - GET /api/settings: sandbox.nomad redaction type guard
 * - GET /api/settings: token redaction with hasToken flag
 * - GET /api/settings: non-object sandbox.nomad values pass through safely
 * - GET /api/settings: structured logging on parse errors
 * - PUT /api/settings: upsert allowed keys
 * - PUT /api/settings: reject invalid JSON body
 * - PUT /api/settings: silently skip unknown keys
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsRoutes } from '../../src/server/routes/settings';

// Must use vi.hoisted so the mock fns are available when vi.mock is hoisted
const { mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('../../src/lib/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

// Mock crypto for sandbox.nomad token encryption in PUT tests
vi.mock('../../src/lib/crypto/server-encryption.js', () => ({
  encryptToken: (token: string) => `encrypted:${token}`,
}));

// --- Mock helpers ---

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

type MockDb = ReturnType<typeof createMockDb>;

function createApp(mockDb: MockDb) {
  const routes = createSettingsRoutes({ db: mockDb as never });
  const app = new Hono();
  app.route('/api/settings', routes);
  return app;
}

// --- GET /api/settings: sandbox.nomad redaction ---

describe('GET /api/settings - sandbox.nomad redaction', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('returns non-object sandbox.nomad values without crashing (type guard)', async () => {
    // When sandbox.nomad is stored as a JSON string (e.g., "foo"), the type guard
    // should prevent accessing .token on a non-object and return the parsed value as-is.
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: JSON.stringify('foo') },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toBe('foo');
  });

  it('returns numeric sandbox.nomad values without crashing (type guard)', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: JSON.stringify(42) },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toBe(42);
  });

  it('returns null sandbox.nomad value without crashing (type guard for null)', async () => {
    // JSON.parse("null") === null, and typeof null === "object",
    // so the guard must also check parsed !== null.
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: 'null' },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toBe(null);
  });

  it('redacts token and sets hasToken=true when sandbox.nomad has a token', async () => {
    const nomadConfig = {
      address: 'https://nomad.example.com',
      token: 'secret-nomad-token-123',
      namespace: 'default',
    };
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: JSON.stringify(nomadConfig) },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const nomad = body.data.settings['sandbox.nomad'];
    expect(nomad.hasToken).toBe(true);
    expect(nomad.token).toBeUndefined();
    expect(nomad.address).toBe('https://nomad.example.com');
    expect(nomad.namespace).toBe('default');
  });

  it('returns sandbox.nomad object as-is when it has no token field', async () => {
    const nomadConfig = {
      address: 'https://nomad.example.com',
      namespace: 'production',
    };
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: JSON.stringify(nomadConfig) },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const nomad = body.data.settings['sandbox.nomad'];
    expect(nomad.hasToken).toBeUndefined();
    expect(nomad.address).toBe('https://nomad.example.com');
    expect(nomad.namespace).toBe('production');
  });

  it('returns sandbox.nomad array without crashing (array is typeof object but no .token)', async () => {
    // Arrays are typeof "object" and not null, but won't have a meaningful .token
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'sandbox.nomad', value: JSON.stringify([1, 2, 3]) },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toEqual([1, 2, 3]);
  });
});

// --- GET /api/settings: structured logging ---

describe('GET /api/settings - structured logging', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('uses log.warn for JSON parse failures', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'theme', value: 'not-valid-json{{{' },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=theme');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Falls back to raw string
    expect(body.data.settings.theme).toBe('not-valid-json{{{');
    // Verify structured logging was used
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Failed to parse JSON for settings key',
      expect.objectContaining({
        error: expect.any(Error),
        data: { key: 'theme' },
      })
    );
  });

  it('uses log.error when db query throws', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=theme');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    // Verify structured logging was used
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to get settings',
      expect.objectContaining({
        error: expect.any(Error),
      })
    );
  });
});

// --- GET /api/settings: general behavior ---

describe('GET /api/settings - general', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('returns all settings when keys param is empty string (falsy)', async () => {
    // Empty string is falsy, so keysParam check falls through to "select all"
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { key: 'theme', value: JSON.stringify('dark') },
      ]),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings.theme).toBe('dark');
  });

  it('returns all settings when no keys param provided', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { key: 'theme', value: JSON.stringify('dark') },
        { key: 'sandbox.mode', value: JSON.stringify('shared') },
      ]),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings.theme).toBe('dark');
    expect(body.data.settings['sandbox.mode']).toBe('shared');
  });

  it('returns multiple requested keys', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { key: 'theme', value: JSON.stringify('light') },
          { key: 'sandbox.mode', value: JSON.stringify('per-project') },
        ]),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings?keys=theme,sandbox.mode');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings.theme).toBe('light');
    expect(body.data.settings['sandbox.mode']).toBe('per-project');
  });
});

// --- PUT /api/settings ---

describe('PUT /api/settings', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp(mockDb);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('returns 400 when settings object is missing', async () => {
    const app = createApp(mockDb);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notSettings: true }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('upserts allowed keys successfully', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate,
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { theme: 'dark' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('silently skips unknown keys', async () => {
    const app = createApp(mockDb);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { 'unknown.key': 'value' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // insert should never have been called since the key is not allowed
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('uses log.error on DB failure during PUT', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    });

    const app = createApp(mockDb);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { theme: 'dark' } }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to update settings',
      expect.objectContaining({
        error: expect.any(Error),
      })
    );
  });
});
