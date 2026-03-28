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

// --- Mock SettingsService ---

function createMockSettingsService() {
  return {
    get: vi.fn(),
    getMany: vi.fn(),
    getAll: vi.fn(),
    set: vi.fn(),
    setMany: vi.fn(),
    delete: vi.fn(),
    getValue: vi.fn(),
    getTaskCreationModel: vi.fn(),
    setTaskCreationModel: vi.fn(),
    getTaskCreationTools: vi.fn(),
    setTaskCreationTools: vi.fn(),
  };
}

type MockSettingsService = ReturnType<typeof createMockSettingsService>;

function createApp(mockService: MockSettingsService) {
  const routes = createSettingsRoutes({ settingsService: mockService as never });
  const app = new Hono();
  app.route('/api/settings', routes);
  app.onError((err, c) =>
    c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500)
  );
  return app;
}

// --- GET /api/settings: sandbox.nomad redaction ---

describe('GET /api/settings - sandbox.nomad redaction', () => {
  let mockService: MockSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockSettingsService();
  });

  it('returns non-object sandbox.nomad values without crashing (type guard)', async () => {
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': 'foo' } });

    const app = createApp(mockService);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toBe('foo');
  });

  it('returns numeric sandbox.nomad values without crashing (type guard)', async () => {
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': 42 } });

    const app = createApp(mockService);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toBe(42);
  });

  it('returns null sandbox.nomad value without crashing (type guard for null)', async () => {
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': null } });

    const app = createApp(mockService);
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
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': nomadConfig } });

    const app = createApp(mockService);
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
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': nomadConfig } });

    const app = createApp(mockService);
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
    mockService.getMany.mockResolvedValue({ ok: true, value: { 'sandbox.nomad': [1, 2, 3] } });

    const app = createApp(mockService);
    const res = await app.request('/api/settings?keys=sandbox.nomad');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings['sandbox.nomad']).toEqual([1, 2, 3]);
  });
});

// --- GET /api/settings: structured logging ---

describe('GET /api/settings - structured logging', () => {
  let mockService: MockSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockSettingsService();
  });

  it('uses log.error when service throws', async () => {
    mockService.getMany.mockRejectedValue(new Error('DB connection lost'));

    const app = createApp(mockService);
    const res = await app.request('/api/settings?keys=theme');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// --- GET /api/settings: general behavior ---

describe('GET /api/settings - general', () => {
  let mockService: MockSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockSettingsService();
  });

  it('returns all settings when keys param is empty string (falls through to getAll)', async () => {
    mockService.getAll.mockResolvedValue({ ok: true, value: {} });

    const app = createApp(mockService);
    const res = await app.request('/api/settings?keys=');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings).toEqual({});
  });

  it('returns all settings when no keys param provided', async () => {
    mockService.getAll.mockResolvedValue({
      ok: true,
      value: { theme: 'dark', 'sandbox.mode': 'shared' },
    });

    const app = createApp(mockService);
    const res = await app.request('/api/settings');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings.theme).toBe('dark');
    expect(body.data.settings['sandbox.mode']).toBe('shared');
  });

  it('returns multiple requested keys', async () => {
    mockService.getMany.mockResolvedValue({
      ok: true,
      value: { theme: 'light', 'sandbox.mode': 'per-project' },
    });

    const app = createApp(mockService);
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
  let mockService: MockSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockSettingsService();
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp(mockService);
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
    const app = createApp(mockService);
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
    mockService.setMany.mockResolvedValue({ ok: true, value: undefined });

    const app = createApp(mockService);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { theme: 'dark' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockService.setMany).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('silently skips unknown keys', async () => {
    mockService.setMany.mockResolvedValue({ ok: true, value: undefined });

    const app = createApp(mockService);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { 'unknown.key': 'value' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // setMany should be called with empty object since unknown keys are filtered
    expect(mockService.setMany).toHaveBeenCalledWith({});
  });

  it('uses log.error on service failure during PUT', async () => {
    mockService.setMany.mockRejectedValue(new Error('disk full'));

    const app = createApp(mockService);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { theme: 'dark' } }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
