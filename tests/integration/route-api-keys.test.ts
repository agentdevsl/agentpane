import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiKeys } from '../../src/db/schema';
import { createApiKeysRoutes } from '../../src/server/routes/api-keys';
import { ApiKeyService } from '../../src/services/api-key.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for api-keys API routes.
 *
 * Creates a real Hono app with the api-keys routes mounted,
 * backed by a real SQLite database via ApiKeyService.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('API Keys Routes (IT-420)', () => {
  let app: ReturnType<typeof createApiKeysRoutes>;
  let service: ApiKeyService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    await db.delete(apiKeys);
    service = new ApiKeyService(db as any);
    app = createApiKeysRoutes({ apiKeyService: service });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/keys/:service ────────────────────────

  it('IT-421: POST /:service saves an Anthropic key and returns keyInfo', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/anthropic', {
        key: 'sk-ant-test-key-abcdef1234567890',
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.keyInfo).toBeDefined();
    expect(body.data.keyInfo.service).toBe('anthropic');
    expect(body.data.keyInfo.isValid).toBe(true);
    // maskedKey must not contain the full key
    expect(body.data.keyInfo.maskedKey).not.toBe('sk-ant-test-key-abcdef1234567890');
  });

  it('IT-422: POST /:service saves a GitHub key', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/github', {
        key: 'ghp_test1234567890abcdef',
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.keyInfo.service).toBe('github');
  });

  it('IT-423: POST /:service returns 400 for invalid Anthropic key format', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/anthropic', {
        key: 'invalid-key-no-prefix',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-424: POST /:service returns 400 for empty key', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/anthropic', {
        key: '',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-425: POST /:service returns 400 for unknown service', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/openai', {
        key: 'sk-test-12345',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Unknown service');
  });

  it('IT-426: POST /:service returns 400 for invalid JSON body', async () => {
    const response = await app.request(
      new Request('http://localhost/anthropic', {
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

  it('IT-427: POST /:service returns 400 for missing key field', async () => {
    const response = await app.request(jsonRequest('http://localhost/anthropic', {}));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── GET /api/keys/:service ─────────────────────────

  it('IT-428: GET /:service returns keyInfo when key exists', async () => {
    await service.saveKey('anthropic', 'sk-ant-get-test-key-999');

    const response = await app.request('http://localhost/anthropic');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.keyInfo).toBeDefined();
    expect(body.data.keyInfo.service).toBe('anthropic');
    expect(body.data.keyInfo.maskedKey).toBeDefined();
    // Full key must not appear in keyInfo
    expect(JSON.stringify(body.data.keyInfo)).not.toContain('sk-ant-get-test-key-999');
  });

  it('IT-429: GET /:service returns null keyInfo when no key exists', async () => {
    const response = await app.request('http://localhost/anthropic');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.keyInfo).toBeNull();
  });

  it('IT-430: GET /:service returns 400 for unknown service', async () => {
    const response = await app.request('http://localhost/unknown-service');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── DELETE /api/keys/:service ──────────────────────

  it('IT-431: DELETE /:service removes the key', async () => {
    await service.saveKey('anthropic', 'sk-ant-delete-me-12345');

    const response = await app.request('http://localhost/anthropic', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // Verify it's gone
    const getResponse = await app.request('http://localhost/anthropic');
    const getBody = await getResponse.json();
    expect(getBody.data.keyInfo).toBeNull();
  });

  it('IT-432: DELETE /:service succeeds gracefully when no key exists', async () => {
    const response = await app.request('http://localhost/anthropic', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('IT-433: DELETE /:service returns 400 for unknown service', async () => {
    const response = await app.request('http://localhost/foobar', { method: 'DELETE' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── Round-trip test ────────────────────────────────

  it('IT-434: Full round-trip: save, get, delete, verify gone', async () => {
    // Save
    const saveRes = await app.request(
      jsonRequest('http://localhost/github', { key: 'ghp_roundtrip1234' })
    );
    expect(saveRes.status).toBe(200);

    // Get
    const getRes = await app.request('http://localhost/github');
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.data.keyInfo).not.toBeNull();
    expect(getBody.data.keyInfo.service).toBe('github');

    // Delete
    const delRes = await app.request('http://localhost/github', { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    // Verify gone
    const verifyRes = await app.request('http://localhost/github');
    const verifyBody = await verifyRes.json();
    expect(verifyBody.data.keyInfo).toBeNull();
  });
});
