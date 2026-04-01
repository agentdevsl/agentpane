import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import { createSandboxStatusRoutes } from '../../src/server/routes/sandbox-status';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for Sandbox Status routes.
 *
 * Uses a real SQLite database for settings lookups.
 * Mocks Docker/K8s/Nomad providers since we can't connect to real infrastructure.
 */

describe('Sandbox Status Routes (IT-610)', () => {
  let app: ReturnType<typeof createSandboxStatusRoutes>;
  let mockDockerProvider: ReturnType<typeof createMockDockerProvider> | null;

  function createMockDockerProvider() {
    return {
      name: 'docker',
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
      isImageAvailable: vi.fn().mockResolvedValue(true),
      validateContainers: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    await setupTestDatabase();
    mockDockerProvider = null;
    const db = getTestDb();

    app = createSandboxStatusRoutes({
      db: db as any,
      getDockerProvider: () => mockDockerProvider as any,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── GET /:codespaceId ────────────────────────

  describe('GET /:codespaceId', () => {
    it('IT-611: returns default status when no providers available', async () => {
      const response = await app.request('http://localhost/test-codespace-1');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.mode).toBe('shared');
      expect(body.data.containerStatus).toBe('unavailable');
      expect(body.data.providerAvailable).toBe(false);
    });

    it('IT-612: returns container status from Docker provider', async () => {
      mockDockerProvider = createMockDockerProvider();
      mockDockerProvider.get.mockResolvedValue({
        status: 'running',
        containerId: 'container-abc',
      });

      // Need to recreate app with the provider
      const db = getTestDb();
      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => mockDockerProvider as any,
      });

      const response = await app.request('http://localhost/test-codespace-2');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.containerStatus).toBe('running');
      expect(body.data.containerId).toBe('container-abc');
      expect(body.data.providerAvailable).toBe(true);
    });

    it('IT-613: returns stopped when Docker available but no container', async () => {
      mockDockerProvider = createMockDockerProvider();
      mockDockerProvider.get.mockResolvedValue(null);
      // Disable auto-heal by making image unavailable
      mockDockerProvider.isImageAvailable.mockResolvedValue(false);

      const db = getTestDb();
      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => mockDockerProvider as any,
      });

      const response = await app.request('http://localhost/test-codespace-3');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.containerStatus).toBe('stopped');
    });

    it('IT-614: returns error status when Docker lookup fails', async () => {
      mockDockerProvider = createMockDockerProvider();
      mockDockerProvider.get.mockRejectedValue(new Error('Docker socket unavailable'));

      const db = getTestDb();
      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => mockDockerProvider as any,
      });

      const response = await app.request('http://localhost/test-codespace-4');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.containerStatus).toBe('error');
    });

    it('IT-615: reads sandbox mode from settings', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.mode',
        value: JSON.stringify('per-project'),
      });

      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => null,
      });

      const response = await app.request('http://localhost/test-codespace-5');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.mode).toBe('per-project');
    });

    it('IT-616: returns 400 for invalid codespace ID format', async () => {
      const response = await app.request('http://localhost/invalid!!id');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_ID');
    });
  });

  // ─── POST /:codespaceId/restart ───────────────

  describe('POST /:codespaceId/restart', () => {
    it('IT-617: returns 503 when Docker is unavailable', async () => {
      const response = await app.request('http://localhost/test-codespace-1/restart', {
        method: 'POST',
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe('DOCKER_UNAVAILABLE');
    });

    it('IT-618: returns 501 when restart not supported', async () => {
      mockDockerProvider = createMockDockerProvider();
      // No restart method
      const db = getTestDb();
      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => mockDockerProvider as any,
      });

      const response = await app.request('http://localhost/test-codespace-1/restart', {
        method: 'POST',
      });

      expect(response.status).toBe(501);
      const body = await response.json();
      expect(body.error.code).toBe('NOT_SUPPORTED');
    });

    it('IT-619: restarts container successfully', async () => {
      mockDockerProvider = createMockDockerProvider();
      (mockDockerProvider as any).restart = vi.fn().mockResolvedValue(undefined);

      const db = getTestDb();
      app = createSandboxStatusRoutes({
        db: db as any,
        getDockerProvider: () => mockDockerProvider as any,
      });

      const response = await app.request('http://localhost/test-codespace-1/restart', {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('IT-620: returns 400 for invalid codespace ID on restart', async () => {
      const response = await app.request('http://localhost/invalid!!id/restart', {
        method: 'POST',
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_ID');
    });
  });
});
