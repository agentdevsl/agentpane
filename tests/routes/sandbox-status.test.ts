/**
 * Tests for sandbox status routes - K8s auto-heal guard.
 *
 * Covers the k8sPodCountKnown guard that prevents auto-heal from triggering
 * when listSandboxes throws an error (pod count unknown).
 *
 * Previously, when listSandboxes threw, k8sPodCount stayed 0 and auto-heal
 * would incorrectly trigger. The fix adds a k8sPodCountKnown boolean that
 * stays false on error, preventing the auto-heal condition from firing.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandboxStatusRoutes } from '../../src/server/routes/sandbox-status';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockDb() {
  return {
    query: {
      settings: {
        findFirst: vi.fn().mockResolvedValue(null),
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

function createApp(deps: Parameters<typeof createSandboxStatusRoutes>[0]) {
  const routes = createSandboxStatusRoutes(deps);
  const app = new Hono();
  app.route('/sandbox/status', routes);
  return app;
}

// ─── K8s auto-heal guard tests ───────────────────────────────────────────────

describe('GET /sandbox/status/:projectId - K8s auto-heal guard', () => {
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
