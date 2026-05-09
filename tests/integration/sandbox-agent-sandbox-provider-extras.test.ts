/**
 * Coverage gap-filler for `agent-sandbox-provider.ts`.
 *
 * The port test (`sandbox-agent-sandbox-provider-port.test.ts`) leaves these
 * branches uncovered: assertNetworkApiAvailable (preflight), recover() paths,
 * getById refresh-throw eviction, warm pool 409 fallback chain, and the
 * parseMemoryMi Gi parse arm.
 *
 * Same SDK mock pattern as the port test, just exercising different paths.
 *
 * IT-IDs: IT-2000 to IT-2029
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockClient {
  createSandbox: ReturnType<typeof vi.fn>;
  getSandbox: ReturnType<typeof vi.fn>;
  listSandboxes: ReturnType<typeof vi.fn>;
  deleteSandbox: ReturnType<typeof vi.fn>;
  sandboxExists: ReturnType<typeof vi.fn>;
  waitForReady: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  execStream: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  createWarmPool: ReturnType<typeof vi.fn>;
  getWarmPool: ReturnType<typeof vi.fn>;
  deleteWarmPool: ReturnType<typeof vi.fn>;
  replaceWarmPool: ReturnType<typeof vi.fn>;
  kubeConfig: { makeApiClient: ReturnType<typeof vi.fn> };
  namespace: string;
}

let mockClient: MockClient;
let mockNetworkingApi: {
  createNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
  deleteNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
};
let mockApisApi: {
  getAPIVersions: ReturnType<typeof vi.fn>;
};

function makeClient(): MockClient {
  return {
    createSandbox: vi.fn().mockResolvedValue({}),
    getSandbox: vi.fn().mockResolvedValue({
      metadata: { creationTimestamp: new Date().toISOString() },
      status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
    }),
    listSandboxes: vi.fn().mockResolvedValue({ items: [] }),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    sandboxExists: vi.fn().mockResolvedValue(false),
    waitForReady: vi.fn().mockResolvedValue({}),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    createWarmPool: vi.fn().mockResolvedValue({}),
    getWarmPool: vi.fn().mockRejectedValue(new Error('not found')),
    deleteWarmPool: vi.fn().mockResolvedValue(undefined),
    replaceWarmPool: vi.fn().mockResolvedValue({}),
    kubeConfig: {
      makeApiClient: vi.fn((klass: { name?: string }) => {
        if (klass.name === 'ApisApi') return mockApisApi;
        return mockNetworkingApi;
      }),
    },
    namespace: 'agentpane-sandboxes',
  };
}

vi.mock('@agentpane/agent-sandbox-sdk', () => {
  class MockSandboxBuilder {
    private _name: string;
    constructor(name: string) {
      this._name = name;
    }
    namespace = vi.fn().mockReturnThis();
    labels = vi.fn().mockReturnThis();
    annotations = vi.fn().mockReturnThis();
    image = vi.fn().mockReturnThis();
    resources = vi.fn().mockReturnThis();
    runtimeClass = vi.fn().mockReturnThis();
    shutdownTime = vi.fn().mockReturnThis();
    shutdownPolicy = vi.fn().mockReturnThis();
    replicas = vi.fn().mockReturnThis();
    addVolumeClaimTemplate = vi.fn().mockReturnThis();
    agentPaneContext = vi.fn().mockReturnThis();
    build = vi.fn().mockImplementation(() => ({
      apiVersion: 'agents.x-k8s.io/v1alpha1',
      kind: 'Sandbox',
      metadata: { name: this._name, namespace: 'agentpane-sandboxes' },
      spec: {},
    }));
  }
  class MockAlreadyExistsError extends Error {
    constructor(message = 'already exists') {
      super(message);
      this.name = 'AlreadyExistsError';
    }
  }
  return {
    AgentSandboxClient: vi.fn(),
    SandboxBuilder: MockSandboxBuilder,
    AlreadyExistsError: MockAlreadyExistsError,
    CRD_LABELS: {
      managed: 'agentpane.io/managed',
      sandbox: 'agentpane.io/sandbox',
      codespaceId: 'agentpane.io/project-id',
      warmPool: 'agentpane.io/warm-pool',
      warmPoolState: 'agentpane.io/warm-pool-state',
    },
  };
});

vi.mock('@kubernetes/client-node', () => ({
  NetworkingV1Api: class NetworkingV1Api {
    static name = 'NetworkingV1Api';
  },
  ApisApi: class ApisApi {
    static name = 'ApisApi';
  },
}));

import { AlreadyExistsError } from '@agentpane/agent-sandbox-sdk';
import { AgentSandboxProvider } from '../../src/lib/sandbox/providers/agent-sandbox-provider';

const sampleConfig = {
  codespaceId: 'cs-extra-1',
  codespacePath: '/host',
  image: 'docker.io/test/image:1',
  memoryMb: 1024,
  cpuCores: 1,
  idleTimeoutMinutes: 15,
  volumeMounts: [],
};

describe('AgentSandboxProvider extras (gap-fillers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    mockNetworkingApi = {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    };
    mockApisApi = {
      getAPIVersions: vi.fn().mockResolvedValue({
        groups: [{ name: 'networking.k8s.io' }, { name: 'apps' }],
      }),
    };
    mockClient = makeClient();
  });

  afterEach(() => {
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  });

  function makeProvider(opts: Record<string, unknown> = {}) {
    return new AgentSandboxProvider({
      client: mockClient as never,
      ...opts,
    });
  }

  // ─── assertNetworkApiAvailable (preflight) ───────────────────────────

  describe('assertNetworkIsolationSupport (MAY-02 boot preflight)', () => {
    it('IT-2000: no-op when network isolation is not requested', async () => {
      // SANDBOX_DEFAULT_NETWORK_MODE unset → enforceNetworkIsolation=false → returns immediately
      const provider = makeProvider();
      await provider.assertNetworkIsolationSupport();
      expect(mockApisApi.getAPIVersions).not.toHaveBeenCalled();
    });

    it('IT-2001: succeeds when networking.k8s.io group is registered', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      const provider = makeProvider();
      await provider.assertNetworkIsolationSupport();
      expect(mockApisApi.getAPIVersions).toHaveBeenCalled();
    });

    it('IT-2002: fails closed when networking.k8s.io is missing from cluster API groups', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockApisApi.getAPIVersions.mockResolvedValue({
        groups: [{ name: 'apps' }, { name: 'core' }],
      });
      const provider = makeProvider();
      await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
        code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
      });
    });

    it('IT-2003: fails closed when getAPIVersions throws', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockApisApi.getAPIVersions.mockRejectedValue(new Error('apiserver offline'));
      const provider = makeProvider();
      await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
        code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
      });
    });
  });

  // ─── deleteDefaultDenyNetworkPolicy rollback ────────────────────────

  describe('NetworkPolicy rollback', () => {
    it('IT-2010: tolerates 404 when rolling back missing policy', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      // sandbox creation succeeds, then waitForReady fails to trigger rollback
      mockClient.waitForReady.mockRejectedValue(new Error('not ready'));
      const notFound = Object.assign(new Error('not found'), { code: 404 });
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValue(notFound);

      const provider = makeProvider();
      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'K8S_POD_CREATION_FAILED',
      });
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalled();
    });

    it('IT-2011: logs and swallows non-404 errors during rollback (still surfaces original failure)', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.waitForReady.mockRejectedValue(new Error('not ready'));
      const conflict = Object.assign(new Error('conflict'), { code: 500 });
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValue(conflict);

      const provider = makeProvider();
      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'K8S_POD_CREATION_FAILED',
      });
      // The rollback was attempted even though it failed
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalled();
    });

    it('IT-2012: 409 from createNamespacedNetworkPolicy is idempotent (already exists)', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      const conflict = Object.assign(new Error('already exists'), { code: 409 });
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValue(conflict);

      const provider = makeProvider();
      // Idempotent — sandbox creation should still proceed
      await provider.create(sampleConfig);
      expect(mockClient.createSandbox).toHaveBeenCalled();
    });
  });

  // ─── runtime class + custom config branches ─────────────────────────

  describe('configuration branches', () => {
    it('IT-2020: runtimeClassName=gvisor passes through builder', async () => {
      const provider = makeProvider({ runtimeClassName: 'gvisor' });
      await provider.create(sampleConfig);
      expect(mockClient.createSandbox).toHaveBeenCalled();
    });

    it('IT-2021: runtimeClassName=kata passes through builder', async () => {
      const provider = makeProvider({ runtimeClassName: 'kata' });
      await provider.create(sampleConfig);
      expect(mockClient.createSandbox).toHaveBeenCalled();
    });

    it('IT-2022: list with memory in Gi units parses correctly', async () => {
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'sb-gi',
              labels: { 'agentpane.io/sandbox-id': 'gi', 'agentpane.io/project-id': 'pgi' },
              creationTimestamp: '2026-01-01T00:00:00Z',
            },
            spec: {
              podTemplate: {
                spec: {
                  containers: [
                    {
                      name: 'sandbox',
                      image: 'docker.io/img:1',
                      resources: { limits: { memory: '4Gi', cpu: '2' } },
                    },
                  ],
                },
                metadata: {},
              },
            },
            status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      });
      const list = await makeProvider().list();
      expect(list[0]!.memoryMb).toBe(4096); // 4Gi → 4096Mi
    });
  });

  // ─── recover() paths ────────────────────────────────────────────────

  describe('recover()', () => {
    it('IT-2030: tears down terminal (error/stopped) sandboxes during recover', async () => {
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'sb-stopped',
              labels: {
                'agentpane.io/sandbox-id': 'sid-stopped',
                'agentpane.io/project-id': 'p-stopped',
              },
            },
            spec: {},
            status: {
              replicas: 1,
              conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }],
            },
          },
          {
            metadata: {
              name: 'sb-error',
              labels: {
                'agentpane.io/sandbox-id': 'sid-error',
                'agentpane.io/project-id': 'p-err',
              },
            },
            spec: {},
            status: { replicas: 1, conditions: [{ type: 'Ready', status: 'False' }] },
          },
        ],
      });
      const result = await makeProvider().recover();
      expect(result.removed).toBe(2);
      expect(result.recovered).toBe(0);
      expect(mockClient.deleteSandbox).toHaveBeenCalledTimes(2);
    });

    it('IT-2031: continues recovery when deleteSandbox fails for a terminal sandbox', async () => {
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'sb-stopped',
              labels: {
                'agentpane.io/sandbox-id': 'sid-stopped',
                'agentpane.io/project-id': 'p-stopped',
              },
            },
            spec: {},
            status: {
              replicas: 1,
              conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }],
            },
          },
        ],
      });
      mockClient.deleteSandbox.mockRejectedValue(new Error('delete forbidden'));

      const result = await makeProvider().recover();
      // Failed deletes don't count toward removed; no throw
      expect(result.removed).toBe(0);
    });

    it('IT-2032: skips CRDs missing required labels', async () => {
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          { metadata: { name: 'no-labels' }, spec: {}, status: {} },
          {
            metadata: {
              name: 'no-codespace',
              labels: { 'agentpane.io/sandbox-id': 'orphan' },
            },
            spec: {},
            status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      });
      const result = await makeProvider().recover();
      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('IT-2033: tolerates listSandboxes throwing in the outer try', async () => {
      mockClient.listSandboxes.mockRejectedValue(new Error('cluster offline'));
      const result = await makeProvider().recover();
      expect(result).toEqual({ recovered: 0, removed: 0 });
    });
  });

  // ─── getById refresh-eviction ────────────────────────────────────────

  describe('getById eviction', () => {
    it('IT-2040: evicts sandbox from cache when refresh throws', async () => {
      const provider = makeProvider();
      const created = await provider.create(sampleConfig);

      // Force refreshStatus to throw next time it is called via getById
      const inst = (
        provider as unknown as { sandboxes: Map<string, { refreshStatus: () => Promise<void> }> }
      ).sandboxes;
      const cached = inst.get(created.id);
      if (cached) {
        cached.refreshStatus = vi.fn().mockRejectedValue(new Error('refresh exploded'));
      }

      const result = await provider.getById(created.id);
      expect(result).toBeNull();
      // Cache evicted
      expect(inst.get(created.id)).toBeUndefined();
    });

    it('IT-2041: evicts sandbox from cache when refreshed status is "stopped"', async () => {
      const provider = makeProvider();
      const created = await provider.create(sampleConfig);

      const inst = (
        provider as unknown as {
          sandboxes: Map<string, { refreshStatus: () => Promise<void>; status: string }>;
        }
      ).sandboxes;
      const cached = inst.get(created.id);
      if (cached) {
        cached.refreshStatus = vi.fn().mockImplementation(async () => {
          cached.status = 'stopped';
        });
      }

      const result = await provider.getById(created.id);
      expect(result).toBeNull();
      expect(inst.get(created.id)).toBeUndefined();
    });
  });

  // ─── Warm pool init ─────────────────────────────────────────────────

  describe('initWarmPool', () => {
    it('IT-2050: no-op when warm pool is disabled', async () => {
      const provider = makeProvider({ enableWarmPool: false });
      await provider.initWarmPool();
      expect(mockClient.createWarmPool).not.toHaveBeenCalled();
    });

    it('IT-2051: creates warm pool on first try when none exists', async () => {
      const provider = makeProvider({ enableWarmPool: true, warmPoolSize: 3 });
      await provider.initWarmPool();
      expect(mockClient.createWarmPool).toHaveBeenCalledTimes(1);
    });

    it('IT-2052: replaces existing warm pool when create throws AlreadyExistsError', async () => {
      mockClient.createWarmPool.mockRejectedValueOnce(new AlreadyExistsError('exists'));
      const provider = makeProvider({ enableWarmPool: true });
      await provider.initWarmPool();
      expect(mockClient.replaceWarmPool).toHaveBeenCalledTimes(1);
      expect(mockClient.deleteWarmPool).not.toHaveBeenCalled();
    });

    it('IT-2053: falls back to delete+recreate when replace also throws', async () => {
      mockClient.createWarmPool
        .mockRejectedValueOnce(new AlreadyExistsError('exists'))
        .mockResolvedValueOnce({});
      mockClient.replaceWarmPool.mockRejectedValue(new Error('immutable field'));

      const provider = makeProvider({ enableWarmPool: true });
      await provider.initWarmPool();
      expect(mockClient.replaceWarmPool).toHaveBeenCalled();
      expect(mockClient.deleteWarmPool).toHaveBeenCalledTimes(1);
      expect(mockClient.createWarmPool).toHaveBeenCalledTimes(2);
    });

    it('IT-2054: rethrows non-AlreadyExists errors from createWarmPool', async () => {
      mockClient.createWarmPool.mockRejectedValue(new Error('quota exceeded'));
      const provider = makeProvider({ enableWarmPool: true });
      await expect(provider.initWarmPool()).rejects.toThrow(/quota exceeded/);
    });
  });
});
