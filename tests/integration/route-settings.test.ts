import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsRoutes } from '../../src/server/routes/settings';

/**
 * Integration tests for the Settings API routes.
 *
 * Covers GET (single key, multi-key, all keys, sensitive redaction, error)
 * and PUT (allowlist filtering, sensitive encryption, digest-pinned image
 * validation for sandbox.defaults, malformed body, and service error).
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string, status = 500) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockSettingsService() {
  return {
    getAll: vi.fn(),
    getMany: vi.fn(),
    setMany: vi.fn(),
  };
}

vi.mock('../../src/lib/crypto/server-encryption.js', () => ({
  encryptToken: (raw: string) => `enc:${raw}`,
}));

describe('Settings Routes (IT-1740)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockSettingsService>;

  beforeEach(() => {
    svc = createMockSettingsService();
    app = createSettingsRoutes({ settingsService: svc as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET / ───────────────────────────────────────────

  it('IT-1740-1: GET / returns all settings via getAll', async () => {
    svc.getAll.mockResolvedValue(ok({ theme: 'dark', 'general.agentModel': 'claude' }));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.settings).toEqual({ theme: 'dark', 'general.agentModel': 'claude' });
    expect(svc.getAll).toHaveBeenCalled();
  });

  it('IT-1740-2: GET / with comma-separated keys uses getMany', async () => {
    svc.getMany.mockResolvedValue(ok({ theme: 'dark' }));
    const res = await app.request('http://localhost/?keys=theme,sandbox.mode');
    expect(res.status).toBe(200);
    expect(svc.getMany).toHaveBeenCalledWith(['theme', 'sandbox.mode']);
  });

  it('IT-1740-3: GET / with empty keys param falls through to getAll (empty string is falsy)', async () => {
    svc.getAll.mockResolvedValue(ok({}));
    const res = await app.request('http://localhost/?keys=');
    expect(res.status).toBe(200);
    expect(svc.getAll).toHaveBeenCalled();
  });

  it('IT-1740-4: GET / with whitespace-only keys returns empty settings via early-return path', async () => {
    const res = await app.request('http://localhost/?keys=,, ,');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.settings).toEqual({});
    expect(svc.getAll).not.toHaveBeenCalled();
    expect(svc.getMany).not.toHaveBeenCalled();
  });

  it('IT-1740-5: GET / surfaces service error as 500', async () => {
    svc.getAll.mockResolvedValue(err('SETTINGS_LOAD', 'boom'));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('IT-1740-6: GET / redacts sensitive Nomad token field, sets hasToken flag', async () => {
    svc.getAll.mockResolvedValue(
      ok({
        'sandbox.nomad': { address: 'http://localhost', token: 'secret-token' },
        unrelated: 'value',
      })
    );
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.settings['sandbox.nomad'].token).toBeUndefined();
    expect(body.data.settings['sandbox.nomad'].hasToken).toBe(true);
    expect(body.data.settings['sandbox.nomad'].address).toBe('http://localhost');
  });

  it('IT-1740-7: GET / redacts AgentCore secretAccessKey', async () => {
    svc.getAll.mockResolvedValue(
      ok({
        'sandbox.agentcore': { region: 'us-east-1', secretAccessKey: 'AWS_SECRET' },
      })
    );
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.settings['sandbox.agentcore'].secretAccessKey).toBeUndefined();
    expect(body.data.settings['sandbox.agentcore'].hasSecretAccessKey).toBe(true);
  });

  it('IT-1740-8: GET / leaves sensitive value unmodified when secret field missing', async () => {
    svc.getAll.mockResolvedValue(
      ok({
        'sandbox.nomad': { address: 'http://localhost' },
      })
    );
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.settings['sandbox.nomad'].hasToken).toBeUndefined();
    expect(body.data.settings['sandbox.nomad'].address).toBe('http://localhost');
  });

  // ─── PUT / ───────────────────────────────────────────

  it('IT-1740-9: PUT / rejects malformed body via schema', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/', { foo: 'bar' }, { method: 'PUT' })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1740-10: PUT / silently drops keys not in allowlist', async () => {
    svc.setMany.mockResolvedValue(ok(undefined));
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            theme: 'light',
            'malicious.key': 'evil',
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(200);
    expect(svc.setMany).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('IT-1740-11: PUT / rejects sandbox.defaults.image with tag-only ref', async () => {
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            'sandbox.defaults': { image: 'evil/repo:latest' },
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('IMAGE_TAG_REQUIRED_DIGEST');
    expect(svc.setMany).not.toHaveBeenCalled();
  });

  it('IT-1740-12: PUT / accepts sandbox.defaults.image with valid digest', async () => {
    svc.setMany.mockResolvedValue(ok(undefined));
    const validDigest = 'safe/repo@sha256:' + 'a'.repeat(64);
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            'sandbox.defaults': { image: validDigest },
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(200);
    expect(svc.setMany).toHaveBeenCalledWith({
      'sandbox.defaults': { image: validDigest },
    });
  });

  it('IT-1740-13: PUT / allows sandbox.defaults without image field', async () => {
    svc.setMany.mockResolvedValue(ok(undefined));
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            'sandbox.defaults': { cpu: 2 },
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(200);
    expect(svc.setMany).toHaveBeenCalledWith({
      'sandbox.defaults': { cpu: 2 },
    });
  });

  it('IT-1740-14: PUT / encrypts sensitive Nomad token before persisting', async () => {
    svc.setMany.mockResolvedValue(ok(undefined));
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            'sandbox.nomad': { address: 'http://localhost', token: 'plain-token' },
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(200);
    const setManyArgs = svc.setMany.mock.calls[0]?.[0] as Record<string, { token: string }>;
    expect(setManyArgs['sandbox.nomad'].token).toBe('enc:plain-token');
  });

  it('IT-1740-15: PUT / leaves sensitive object unencrypted when secret field absent', async () => {
    svc.setMany.mockResolvedValue(ok(undefined));
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        {
          settings: {
            'sandbox.nomad': { address: 'http://localhost' },
          },
        },
        { method: 'PUT' }
      )
    );
    expect(res.status).toBe(200);
    expect(svc.setMany).toHaveBeenCalledWith({
      'sandbox.nomad': { address: 'http://localhost' },
    });
  });

  it('IT-1740-16: PUT / surfaces service error as 500', async () => {
    svc.setMany.mockResolvedValue(err('PERSIST_FAILED', 'fail'));
    const res = await app.request(
      jsonRequest('http://localhost/', { settings: { theme: 'dark' } }, { method: 'PUT' })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
