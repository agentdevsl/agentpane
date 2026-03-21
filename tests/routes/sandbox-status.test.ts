/**
 * Tests for sandbox status routes - K8s auto-heal guard, Docker status,
 * Nomad provider, restart endpoint, and edge cases.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandboxStatusRoutes } from '../../src/server/routes/sandbox-status';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockDb(modeValue: string | null = null) {
  return {
    query: {
      settings: {
        findFirst: vi
          .fn()
          .mockResolvedValue(modeValue ? { value: JSON.stringify(modeValue) } : null),
      },
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

function createMockK8sProvider(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      details: {
        crdRegistered: true,
        namespaceExists: true,
        clusterVersion: '1.28.0',
      },
    }),
    listSandboxes: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function createMockDockerProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'docker',
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    validateContainers: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockNomadProvider(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      details: {
        version: '1.7.0',
        leader: 'leader-addr',
        jobCount: 5,
      },
    }),
    ...overrides,
  };
}

function createApp(deps: Parameters<typeof createSandboxStatusRoutes>[0]) {
  const routes = createSandboxStatusRoutes(deps);
  const app = new Hono();
  app.route('/sandbox/status', routes);
  return app;
}

// ─── K8s auto-heal guard tests ───────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - K8s auto-heal guard', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('does NOT trigger auto-heal when listSandboxes throws an error', async () => {
    const k8sProvider = createMockK8sProvider({
      listSandboxes: vi.fn().mockRejectedValue(new Error('K8s API unavailable')),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    // Pod count should be 0 (default) but auto-heal should NOT have been called
    expect(body.data.k8sPodCount).toBe(0);
    expect(body.data.k8sCrdReady).toBe(true);
    expect(k8sProvider.create).not.toHaveBeenCalled();
  });

  it('triggers auto-heal when listSandboxes returns empty array (no pods)', async () => {
    const k8sProvider = createMockK8sProvider({
      listSandboxes: vi.fn().mockResolvedValue([]),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.k8sCrdReady).toBe(true);
    // Auto-heal should have been called because listSandboxes succeeded with 0 pods
    expect(k8sProvider.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger auto-heal when listSandboxes returns running pods', async () => {
    const k8sProvider = createMockK8sProvider({
      listSandboxes: vi.fn().mockResolvedValue([
        { name: 'sandbox-1', phase: 'Running' },
        { name: 'sandbox-2', phase: 'Running' },
      ]),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.k8sPodCount).toBe(2);
    expect(body.data.k8sPodsRunning).toBe(2);
    expect(body.data.k8sCrdReady).toBe(true);
    // Auto-heal should NOT be called because pods exist
    expect(k8sProvider.create).not.toHaveBeenCalled();
  });

  it('does NOT trigger auto-heal when CRD is not ready even with 0 pods', async () => {
    const k8sProvider = createMockK8sProvider({
      healthCheck: vi.fn().mockResolvedValue({
        healthy: true,
        details: {
          crdRegistered: false,
          namespaceExists: true,
        },
      }),
      listSandboxes: vi.fn().mockResolvedValue([]),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.k8sCrdReady).toBe(false);
    expect(body.data.k8sPodCount).toBe(0);
    // CRD not ready, so auto-heal should not trigger
    expect(k8sProvider.create).not.toHaveBeenCalled();
  });

  it('does NOT trigger auto-heal when k8s provider has no create method', async () => {
    const k8sProvider = createMockK8sProvider();
    // Remove the create method
    delete (k8sProvider as Record<string, unknown>).create;

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    // listSandboxes succeeded with 0 pods and CRD ready, but no create method
    expect(body.data.k8sPodCount).toBe(0);
    expect(body.data.k8sCrdReady).toBe(true);
  });

  it('re-counts pods after successful auto-heal', async () => {
    let listCallCount = 0;
    const k8sProvider = createMockK8sProvider({
      listSandboxes: vi.fn().mockImplementation(() => {
        listCallCount++;
        // First call: no pods (triggers auto-heal)
        // Second call: pod created by auto-heal
        if (listCallCount === 1) return Promise.resolve([]);
        return Promise.resolve([{ name: 'sandbox-default', phase: 'Running' }]);
      }),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(k8sProvider.create).toHaveBeenCalledTimes(1);
    // After auto-heal, pods should be re-counted
    expect(body.data.k8sPodCount).toBe(1);
    expect(body.data.k8sPodsRunning).toBe(1);
  });
});

// ─── Invalid project ID tests ────────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - Invalid ID', () => {
  it('returns 400 for invalid project ID', async () => {
    const mockDb = createMockDb();
    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
    });

    const res = await app.request('/sandbox/status/bad!id');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ─── Docker provider tests ───────────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - Docker provider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('returns stopped when Docker provider has no sandbox', async () => {
    const dockerProvider = createMockDockerProvider({
      get: vi.fn().mockResolvedValue(null),
      isImageAvailable: vi.fn().mockResolvedValue(false),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.provider).toBe('docker');
    expect(body.data.providerAvailable).toBe(true);
  });

  it('returns running when Docker has a running container', async () => {
    const dockerProvider = createMockDockerProvider({
      get: vi.fn().mockResolvedValue({
        status: 'running',
        containerId: 'abc123',
      }),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.containerStatus).toBe('running');
    expect(body.data.containerId).toBe('abc123');
  });

  it('returns error status when Docker lookup throws', async () => {
    const dockerProvider = createMockDockerProvider({
      get: vi.fn().mockRejectedValue(new Error('Docker not responding')),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.containerStatus).toBe('error');
  });

  it('returns unavailable when no Docker provider', async () => {
    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.containerStatus).toBe('unavailable');
    expect(body.data.provider).toBe('none');
    expect(body.data.providerAvailable).toBe(false);
  });

  it('uses "default" lookupId in shared mode', async () => {
    const dockerProvider = createMockDockerProvider();
    // Default mode is "shared", lookupId should be "default"

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    await app.request('/sandbox/status/proj-1');

    expect(dockerProvider.get).toHaveBeenCalledWith('default');
  });

  it('uses codespaceId as lookupId in per-project mode', async () => {
    const perProjectDb = createMockDb('per-project');
    const dockerProvider = createMockDockerProvider();

    const app = createApp({
      db: perProjectDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    await app.request('/sandbox/status/proj-1');

    expect(dockerProvider.get).toHaveBeenCalledWith('proj-1');
  });

  it('handles malformed sandbox.mode setting gracefully', async () => {
    const badDb = {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({ value: 'not-valid-json{{{' }),
        },
      },
    };

    const dockerProvider = createMockDockerProvider();

    const app = createApp({
      db: badDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    // Should fall back to "shared" mode
    const body = await res.json();
    expect(body.data.mode).toBe('shared');
  });
});

// ─── Nomad provider tests ────────────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - Nomad provider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('includes Nomad health info when provider is available', async () => {
    const nomadProvider = createMockNomadProvider();

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getNomadProvider: () => nomadProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.nomadHealthy).toBe(true);
    expect(body.data.nomadVersion).toBe('1.7.0');
    expect(body.data.nomadLeader).toBe('leader-addr');
    expect(body.data.nomadJobCount).toBe(5);
    expect(body.data.providerAvailable).toBe(true);
  });

  it('handles Nomad health check failure gracefully', async () => {
    const nomadProvider = createMockNomadProvider({
      healthCheck: vi.fn().mockRejectedValue(new Error('Nomad unreachable')),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getNomadProvider: () => nomadProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    // Defaults when health check fails
    expect(body.data.nomadHealthy).toBe(false);
    expect(body.data.nomadVersion).toBeNull();
    expect(body.data.nomadLeader).toBeNull();
    expect(body.data.nomadJobCount).toBe(0);
  });

  it('handles Nomad provider with missing details', async () => {
    const nomadProvider = createMockNomadProvider({
      healthCheck: vi.fn().mockResolvedValue({
        healthy: false,
        details: {},
      }),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getNomadProvider: () => nomadProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.nomadHealthy).toBe(false);
    expect(body.data.nomadVersion).toBeNull();
    expect(body.data.nomadLeader).toBeNull();
    expect(body.data.nomadJobCount).toBe(0);
  });

  it('handles no Nomad provider', async () => {
    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      // getNomadProvider not provided
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.nomadHealthy).toBe(false);
    expect(body.data.nomadVersion).toBeNull();
  });
});

// ─── Multiple providers ──────────────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - Multiple providers', () => {
  it('providerAvailable is true when any provider is present', async () => {
    const mockDb = createMockDb();
    const nomadProvider = createMockNomadProvider();

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getNomadProvider: () => nomadProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    const body = await res.json();

    expect(body.data.providerAvailable).toBe(true);
  });
});

// ─── K8s provider with namespace not ready ───────────────────────────────────

describe('GET /sandbox/status/:codespaceId - K8s health details', () => {
  it('sets k8sCrdReady to false when namespace does not exist', async () => {
    const mockDb = createMockDb();
    const k8sProvider = createMockK8sProvider({
      healthCheck: vi.fn().mockResolvedValue({
        healthy: true,
        details: {
          crdRegistered: true,
          namespaceExists: false,
          clusterVersion: '1.29.0',
        },
      }),
      listSandboxes: vi.fn().mockResolvedValue([]),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    const body = await res.json();

    expect(body.data.k8sCrdReady).toBe(false);
    expect(body.data.k8sClusterVersion).toBe('1.29.0');
  });

  it('extracts cluster version from health details', async () => {
    const mockDb = createMockDb();
    const k8sProvider = createMockK8sProvider({
      healthCheck: vi.fn().mockResolvedValue({
        healthy: true,
        details: {
          crdRegistered: true,
          namespaceExists: true,
          clusterVersion: '1.30.0',
        },
      }),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    const body = await res.json();

    expect(body.data.k8sClusterVersion).toBe('1.30.0');
  });

  it('handles K8s health check throwing', async () => {
    const mockDb = createMockDb();
    const k8sProvider = createMockK8sProvider({
      healthCheck: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    // Defaults when K8s throws
    expect(body.data.k8sCrdReady).toBe(false);
    expect(body.data.k8sClusterVersion).toBeNull();
    expect(body.data.k8sPodCount).toBe(0);
  });

  it('handles K8s provider with no listSandboxes method', async () => {
    const mockDb = createMockDb();
    const k8sProvider = createMockK8sProvider();
    delete (k8sProvider as Record<string, unknown>).listSandboxes;

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.k8sPodCount).toBe(0);
  });

  it('counts running vs non-running pods correctly', async () => {
    const mockDb = createMockDb();
    const k8sProvider = createMockK8sProvider({
      listSandboxes: vi.fn().mockResolvedValue([
        { name: 'sandbox-1', phase: 'Running' },
        { name: 'sandbox-2', phase: 'Pending' },
        { name: 'sandbox-3', phase: 'Running' },
      ]),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
      getK8sProvider: () => k8sProvider,
    });

    const res = await app.request('/sandbox/status/proj-1');
    const body = await res.json();

    expect(body.data.k8sPodCount).toBe(3);
    expect(body.data.k8sPodsRunning).toBe(2);
  });
});

// ─── POST /sandbox/status/:codespaceId/restart ─────────────────────────────────

describe('POST /sandbox/status/:codespaceId/restart', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  it('returns 400 for invalid project ID', async () => {
    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
    });

    const res = await app.request('/sandbox/status/bad!id/restart', { method: 'POST' });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 503 when Docker is not available', async () => {
    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => null,
    });

    const res = await app.request('/sandbox/status/proj-1/restart', { method: 'POST' });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('DOCKER_UNAVAILABLE');
  });

  it('returns 501 when restart is not supported', async () => {
    const dockerProvider = createMockDockerProvider();
    // No restart method on provider
    delete (dockerProvider as Record<string, unknown>).restart;

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1/restart', { method: 'POST' });
    expect(res.status).toBe(501);

    const body = await res.json();
    expect(body.error.code).toBe('NOT_SUPPORTED');
  });

  it('restarts container successfully', async () => {
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const dockerProvider = createMockDockerProvider({
      restart: restartFn,
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1/restart', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.message).toContain('restarted');
    expect(restartFn).toHaveBeenCalledWith('default');
  });

  it('restarts with codespaceId in per-project mode', async () => {
    const perProjectDb = createMockDb('per-project');
    const restartFn = vi.fn().mockResolvedValue(undefined);
    const dockerProvider = createMockDockerProvider({
      restart: restartFn,
    });

    const app = createApp({
      db: perProjectDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(restartFn).toHaveBeenCalledWith('proj-1');
  });

  it('returns 500 when restart throws', async () => {
    const dockerProvider = createMockDockerProvider({
      restart: vi.fn().mockRejectedValue(new Error('Container not found')),
    });

    const app = createApp({
      db: mockDb as never,
      getDockerProvider: () => dockerProvider as never,
    });

    const res = await app.request('/sandbox/status/proj-1/restart', { method: 'POST' });
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('RESTART_FAILED');
    expect(body.error.message).toContain('Container not found');
  });
});

// ─── Server error catch-all ──────────────────────────────────────────────────

describe('GET /sandbox/status/:codespaceId - Server error', () => {
  it('returns 500 when db query throws', async () => {
    const badDb = {
      query: {
        settings: {
          findFirst: vi.fn().mockRejectedValue(new Error('DB crashed')),
        },
      },
    };

    const app = createApp({
      db: badDb as never,
      getDockerProvider: () => null,
    });

    const res = await app.request('/sandbox/status/proj-1');
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SERVER_ERROR');
  });
});
