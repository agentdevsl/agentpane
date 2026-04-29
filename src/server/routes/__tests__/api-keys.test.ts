import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApiKeysRoutes } from '../api-keys.js';

// ── Mock API Key Service ──

function createMockApiKeyService() {
  return {
    getKeyInfo: vi.fn(),
    saveKey: vi.fn(),
    deleteKey: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const apiKeyService = createMockApiKeyService();
  const routes = createApiKeysRoutes({ apiKeyService: apiKeyService as never });
  const app = new Hono();
  app.route('/api/keys', routes);
  return { app, apiKeyService };
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

describe('API Keys Routes', () => {
  // ── GET /api/keys/:service ──

  describe('GET /api/keys/:service', () => {
    it('returns key info for a service', async () => {
      const { app, apiKeyService } = createTestApp();
      const keyInfo = { service: 'anthropic', configured: true, lastFour: 'ab12' };
      apiKeyService.getKeyInfo.mockResolvedValue({ ok: true, value: keyInfo });

      const res = await request(app, 'GET', '/api/keys/anthropic');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.keyInfo.service).toBe('anthropic');
      expect(json.data.keyInfo.configured).toBe(true);
      expect(apiKeyService.getKeyInfo).toHaveBeenCalledWith('anthropic');
    });

    it('returns 500 when service returns error', async () => {
      const { app, apiKeyService } = createTestApp();
      apiKeyService.getKeyInfo.mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Storage unavailable' },
      });

      const res = await request(app, 'GET', '/api/keys/anthropic');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/keys/:service ──

  describe('POST /api/keys/:service', () => {
    it('saves a key and returns key info', async () => {
      const { app, apiKeyService } = createTestApp();
      const keyInfo = { service: 'anthropic', configured: true, lastFour: 'yz99' };
      apiKeyService.saveKey.mockResolvedValue({ ok: true, value: keyInfo });

      const res = await request(app, 'POST', '/api/keys/anthropic', {
        key: 'sk-ant-api03-test-key',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.keyInfo.configured).toBe(true);
      expect(apiKeyService.saveKey).toHaveBeenCalledWith(
        'anthropic',
        'sk-ant-api03-test-key',
        undefined
      );
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/keys/anthropic', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 400 when key is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/keys/anthropic', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when key is empty string', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/keys/anthropic', { key: '' });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, apiKeyService } = createTestApp();
      apiKeyService.saveKey.mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_KEY', message: 'Key format not recognized' },
      });

      const res = await request(app, 'POST', '/api/keys/anthropic', {
        key: 'bad-key',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_KEY');
    });
  });

  // ── DELETE /api/keys/:service ──

  describe('DELETE /api/keys/:service', () => {
    it('deletes a key successfully', async () => {
      const { app, apiKeyService } = createTestApp();
      apiKeyService.deleteKey.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/keys/anthropic');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
      expect(apiKeyService.deleteKey).toHaveBeenCalledWith('anthropic');
    });

    it('returns 500 when service returns error', async () => {
      const { app, apiKeyService } = createTestApp();
      apiKeyService.deleteKey.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Key not found' },
      });

      const res = await request(app, 'DELETE', '/api/keys/anthropic');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });
});
