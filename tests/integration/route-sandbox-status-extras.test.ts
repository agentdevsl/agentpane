/**
 * Coverage gap-filler for `src/server/routes/sandbox-status.ts`.
 *
 * The existing route test (`route-sandbox-status.test.ts`) covers the happy-
 * path mode/status read. This file adds:
 * - autoHealSandbox happy path + image-unavailable skip + create failure
 * - autoHealK8sSandbox path
 * - K8s health + countPods (success + failure + auto-heal)
 * - Nomad health
 * - restart success + restart throw
 * - loadSandboxDefaults catch arm
 * - validateContainers branch
 *
 * IT-IDs: IT-2200 to IT-2229
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import { createSandboxStatusRoutes } from '../../src/server/routes/sandbox-status';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function dockerStub(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    name: 'docker',
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    validateContainers: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function k8sStub(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    name: 'kubernetes',
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      details: {
        crdRegistered: true,
        namespaceExists: true,
        clusterVersion: 'v1.28.0',
      },
    }),
    listSandboxes: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function nomadStub(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    name: 'nomad',
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      details: { version: '1.7.0', leader: '10.0.0.1:4647', jobCount: 5 },
    }),
    ...overrides,
  };
}

describe('Sandbox Status Routes — extras (gap-fillers)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── Auto-heal Docker ──────────────────────────────────────────────

  describe('autoHealSandbox (Docker)', () => {
    it('IT-2200: auto-heals when no container exists and image is available', async () => {
      const docker = dockerStub({
        get: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ status: 'running', containerId: 'auto-cid' }),
        isImageAvailable: vi.fn().mockResolvedValue(true),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/auto-heal-1');
      expect(response.status).toBe(200);
      expect(docker.create).toHaveBeenCalled();
      const body = await response.json();
      expect(body.data.containerStatus).toBe('running');
      expect(body.data.containerId).toBe('auto-cid');
    });

    it('IT-2201: skips auto-heal when image is not available (returns stopped)', async () => {
      const docker = dockerStub({
        get: vi.fn().mockResolvedValue(null),
        isImageAvailable: vi.fn().mockResolvedValue(false),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/no-img-1');
      expect(docker.create).not.toHaveBeenCalled();
      const body = await response.json();
      expect(body.data.containerStatus).toBe('stopped');
    });

    it('IT-2202: tolerates auto-heal create failure (returns stopped)', async () => {
      const docker = dockerStub({
        get: vi.fn().mockResolvedValue(null),
        isImageAvailable: vi.fn().mockResolvedValue(true),
        create: vi.fn().mockRejectedValue(new Error('image pull failed')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/heal-fail-1');
      expect(docker.create).toHaveBeenCalled();
      const body = await response.json();
      // get returns null, healed=false → stopped
      expect(body.data.containerStatus).toBe('stopped');
    });

    it('IT-2203: uses sandbox.defaults from settings when present', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.defaults',
        value: JSON.stringify({
          image: 'docker.io/custom-img:1',
          memoryMb: 2048,
          cpuCores: 2,
          idleTimeoutMinutes: 60,
        }),
      });

      const docker = dockerStub({
        get: vi.fn().mockResolvedValue(null),
        isImageAvailable: vi.fn().mockResolvedValue(true),
      });
      const app = createSandboxStatusRoutes({
        db: db as never,
        getDockerProvider: () => docker as never,
      });

      await app.request('http://localhost/custom-defaults');
      expect(docker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'docker.io/custom-img:1',
          memoryMb: 2048,
          cpuCores: 2,
          idleTimeoutMinutes: 60,
        })
      );
    });

    it('IT-2204: tolerates malformed sandbox.defaults JSON (falls back to built-in)', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.defaults',
        value: '{not valid json',
      });

      const docker = dockerStub({
        get: vi.fn().mockResolvedValue(null),
        isImageAvailable: vi.fn().mockResolvedValue(true),
      });
      const app = createSandboxStatusRoutes({
        db: db as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/bad-defaults');
      // Should not crash
      expect(response.status).toBe(200);
    });

    it('IT-2205: validateContainers is called when provider exposes it', async () => {
      const docker = dockerStub();
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => docker as never,
      });

      await app.request('http://localhost/validate-1');
      expect(docker.validateContainers).toHaveBeenCalled();
    });
  });

  // ─── K8s health + countPods + auto-heal ────────────────────────────

  describe('K8s health and pod count', () => {
    it('IT-2210: includes K8s health fields when provider available', async () => {
      const k8s = k8sStub({
        listSandboxes: vi
          .fn()
          .mockResolvedValue([
            { status: 'running' },
            { status: 'running' },
            { status: 'creating' },
          ]),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getK8sProvider: () => k8s as never,
      });

      const response = await app.request('http://localhost/k8s-cs');
      const body = await response.json();
      expect(body.data.k8sCrdReady).toBe(true);
      expect(body.data.k8sClusterVersion).toBe('v1.28.0');
      expect(body.data.k8sPodCount).toBe(3);
      expect(body.data.k8sPodsRunning).toBe(2);
    });

    it('IT-2211: tolerates K8s healthCheck throwing', async () => {
      const k8s = k8sStub({
        healthCheck: vi.fn().mockRejectedValue(new Error('apiserver offline')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getK8sProvider: () => k8s as never,
      });

      const response = await app.request('http://localhost/k8s-fail');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.k8sCrdReady).toBe(false);
    });

    it('IT-2212: tolerates listSandboxes throwing', async () => {
      const k8s = k8sStub({
        listSandboxes: vi.fn().mockRejectedValue(new Error('api error')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getK8sProvider: () => k8s as never,
      });

      const response = await app.request('http://localhost/k8s-list-fail');
      const body = await response.json();
      expect(body.data.k8sPodCount).toBe(0);
    });

    it('IT-2213: triggers K8s auto-heal when CRD ready and pod count is zero', async () => {
      const k8s = k8sStub({
        listSandboxes: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ status: 'running' }]),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getK8sProvider: () => k8s as never,
      });

      const response = await app.request('http://localhost/k8s-heal');
      expect(k8s.create).toHaveBeenCalled();
      const body = await response.json();
      expect(body.data.k8sPodsRunning).toBe(1);
    });

    it('IT-2214: tolerates K8s auto-heal create failure', async () => {
      const k8s = k8sStub({
        listSandboxes: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockRejectedValue(new Error('namespace not found')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getK8sProvider: () => k8s as never,
      });

      const response = await app.request('http://localhost/k8s-heal-fail');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.k8sCrdReady).toBe(true);
    });
  });

  // ─── Nomad health ─────────────────────────────────────────────────

  describe('Nomad health', () => {
    it('IT-2220: includes Nomad health fields when provider available', async () => {
      const nomad = nomadStub();
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getNomadProvider: () => nomad as never,
      });

      const response = await app.request('http://localhost/nomad-cs');
      const body = await response.json();
      expect(body.data.nomadHealthy).toBe(true);
      expect(body.data.nomadVersion).toBe('1.7.0');
      expect(body.data.nomadLeader).toBe('10.0.0.1:4647');
      expect(body.data.nomadJobCount).toBe(5);
    });

    it('IT-2221: tolerates Nomad healthCheck throwing', async () => {
      const nomad = nomadStub({
        healthCheck: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => null,
        getNomadProvider: () => nomad as never,
      });

      const response = await app.request('http://localhost/nomad-fail');
      const body = await response.json();
      expect(body.data.nomadHealthy).toBe(false);
    });
  });

  // ─── restart success + failure ────────────────────────────────────

  describe('POST /:codespaceId/restart — extras', () => {
    it('IT-2225: restart with shared mode uses "default" lookupId', async () => {
      const docker = dockerStub();
      const db = getTestDb();
      // shared mode is the default; no settings needed
      const app = createSandboxStatusRoutes({
        db: db as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/some-codespace/restart', {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(docker.restart).toHaveBeenCalledWith('default');
    });

    it('IT-2226: restart with per-project mode uses codespaceId', async () => {
      const db = getTestDb();
      await db.insert(settings).values({
        key: 'sandbox.mode',
        value: JSON.stringify('per-project'),
      });
      const docker = dockerStub();
      const app = createSandboxStatusRoutes({
        db: db as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/per-project-cs/restart', {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(docker.restart).toHaveBeenCalledWith('per-project-cs');
    });

    it('IT-2227: restart returns 500 with RESTART_FAILED when docker.restart throws', async () => {
      const docker = dockerStub({
        restart: vi.fn().mockRejectedValue(new Error('container not found')),
      });
      const app = createSandboxStatusRoutes({
        db: getTestDb() as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/restart-fail/restart', {
        method: 'POST',
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('RESTART_FAILED');
      expect(body.error.message).toContain('container not found');
    });

    it('IT-2228: restart tolerates malformed sandbox.mode JSON', async () => {
      const db = getTestDb();
      await db.insert(settings).values({ key: 'sandbox.mode', value: '{invalid' });
      const docker = dockerStub();
      const app = createSandboxStatusRoutes({
        db: db as never,
        getDockerProvider: () => docker as never,
      });

      const response = await app.request('http://localhost/bad-mode-cs/restart', {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      // Falls back to "default" (shared mode)
      expect(docker.restart).toHaveBeenCalledWith('default');
    });
  });
});
