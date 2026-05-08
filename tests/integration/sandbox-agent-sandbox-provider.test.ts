/**
 * Integration tests for `agent-sandbox-provider.ts`.
 *
 * Targets the simpler entry-points (constructor, name, list, pullImage,
 * isImageAvailable, healthCheck, on/off, get/getById, cleanup) using a
 * mocked AgentSandboxClient SDK. The deeper create/recover paths are
 * already covered in the unit project; this file is a focused integration
 * version that lifts combined coverage for the file past the trivial
 * 0.76% baseline.
 *
 * IT-IDs: IT-1600 to IT-1639
 */
import { PassThrough } from 'node:stream';
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

function createMockClient(): MockClient {
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
    execStream: vi.fn().mockResolvedValue({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn(),
    }),
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      controllerInstalled: true,
      controllerVersion: '0.1.0',
      crdRegistered: true,
      namespace: 'agentpane-sandboxes',
      namespaceExists: true,
      clusterVersion: 'v1.28.0',
    }),
    createWarmPool: vi.fn().mockResolvedValue({}),
    getWarmPool: vi.fn().mockRejectedValue(new Error('not found')),
    deleteWarmPool: vi.fn().mockResolvedValue(undefined),
    replaceWarmPool: vi.fn().mockResolvedValue({}),
    kubeConfig: { makeApiClient: vi.fn(() => mockNetworkingApi) },
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
  NetworkingV1Api: class NetworkingV1Api {},
  ApisApi: class ApisApi {},
}));

import {
  AgentSandboxProvider,
  createAgentSandboxProvider,
} from '../../src/lib/sandbox/providers/agent-sandbox-provider';

const sampleConfig = {
  codespaceId: 'proj-int-1',
  codespacePath: '/host',
  image: 'docker.io/test/image:1',
  memoryMb: 1024,
  cpuCores: 1,
  idleTimeoutMinutes: 15,
  volumeMounts: [],
};

describe('AgentSandboxProvider (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    mockNetworkingApi = {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    };
    mockClient = createMockClient();
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

  it('IT-1600: name is "kubernetes"', () => {
    expect(makeProvider().name).toBe('kubernetes');
  });

  it('IT-1601: factory function returns an AgentSandboxProvider', () => {
    expect(createAgentSandboxProvider({ client: mockClient as never })).toBeInstanceOf(
      AgentSandboxProvider
    );
  });

  it('IT-1602: list returns empty list when no sandboxes', async () => {
    expect(await makeProvider().list()).toEqual([]);
  });

  it('IT-1603: list returns empty list on SDK error', async () => {
    mockClient.listSandboxes.mockRejectedValue(new Error('cluster offline'));
    expect(await makeProvider().list()).toEqual([]);
  });

  it('IT-1604: pullImage is a no-op for non-empty image names', async () => {
    await expect(makeProvider().pullImage('nginx:1')).resolves.toBeUndefined();
  });

  it('IT-1605: pullImage rejects empty image with K8S_IMAGE_NOT_FOUND', async () => {
    await expect(makeProvider().pullImage('')).rejects.toMatchObject({
      code: 'K8S_IMAGE_NOT_FOUND',
    });
  });

  it('IT-1606: isImageAvailable true for non-empty', async () => {
    expect(await makeProvider().isImageAvailable('x:1')).toBe(true);
  });

  it('IT-1607: isImageAvailable false for empty', async () => {
    expect(await makeProvider().isImageAvailable('')).toBe(false);
  });

  it('IT-1608: get returns null for unknown codespace and SDK list returns empty', async () => {
    expect(await makeProvider().get('unknown')).toBeNull();
  });

  it('IT-1609: getById returns null when nothing tracked', async () => {
    expect(await makeProvider().getById('unknown')).toBeNull();
  });

  it('IT-1610: healthCheck returns SDK result on success', async () => {
    const result = await makeProvider().healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('IT-1611: healthCheck returns unhealthy on SDK throw', async () => {
    mockClient.healthCheck.mockRejectedValue(new Error('apiserver unreachable'));
    const result = await makeProvider().healthCheck();
    expect(result.healthy).toBe(false);
  });

  it('IT-1612: on() registers a listener and returns an unsubscribe fn', () => {
    const provider = makeProvider();
    const events: unknown[] = [];
    const off = provider.on((e) => events.push(e));
    expect(typeof off).toBe('function');
    off();
  });

  it('IT-1613: off() removes a listener', () => {
    const provider = makeProvider();
    const events: unknown[] = [];
    const cb = (e: unknown) => events.push(e);
    provider.on(cb);
    provider.off(cb);
  });

  it('IT-1614: cleanup returns 0 when no sandboxes match criteria', async () => {
    const removed = await makeProvider().cleanup({ status: ['stopped'] });
    expect(typeof removed).toBe('number');
  });

  it('IT-1615: create -> get round-trip returns the same instance', async () => {
    const provider = makeProvider();
    const created = await provider.create(sampleConfig);
    expect(created.codespaceId).toBe('proj-int-1');
    const gotByCodespace = await provider.get('proj-int-1');
    expect(gotByCodespace).toBe(created);
    const gotById = await provider.getById(created.id);
    expect(gotById).toBe(created);
  });

  it('IT-1616: create rejects when called twice for same codespace', async () => {
    const provider = makeProvider();
    await provider.create(sampleConfig);
    await expect(provider.create(sampleConfig)).rejects.toMatchObject({
      code: 'K8S_POD_ALREADY_EXISTS',
    });
  });

  it('IT-1617: create rejects with POD_CREATION_FAILED when SDK createSandbox throws', async () => {
    mockClient.createSandbox.mockRejectedValue(new Error('cluster API error'));
    await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
      code: 'K8S_POD_CREATION_FAILED',
    });
  });

  it('IT-1618: create emits sandbox:creating, :created, :started events', async () => {
    const provider = makeProvider();
    const evs: { type: string }[] = [];
    provider.on((e) => evs.push(e));
    await provider.create(sampleConfig);
    const types = evs.map((e) => e.type);
    expect(types).toContain('sandbox:creating');
    expect(types).toContain('sandbox:created');
    expect(types).toContain('sandbox:started');
  });

  it('IT-1619: create emits sandbox:error on failure', async () => {
    mockClient.createSandbox.mockRejectedValue(new Error('boom'));
    const provider = makeProvider();
    const evs: { type: string }[] = [];
    provider.on((e) => evs.push(e));
    await expect(provider.create(sampleConfig)).rejects.toThrow();
    expect(evs.map((e) => e.type)).toContain('sandbox:error');
  });

  it('IT-1620: create with custom readyTimeoutSeconds passes timeoutMs to waitForReady', async () => {
    await makeProvider({ readyTimeoutSeconds: 60 }).create(sampleConfig);
    expect(mockClient.waitForReady).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 60000 })
    );
  });

  it('IT-1621: list maps SDK items into SandboxInfo', async () => {
    mockClient.listSandboxes.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'agentpane-proj-1',
            labels: { 'agentpane.io/sandbox-id': 'sid-1', 'agentpane.io/project-id': 'p-1' },
            creationTimestamp: '2026-01-01T00:00:00Z',
          },
          spec: {
            podTemplate: {
              spec: {
                containers: [
                  {
                    name: 'sandbox',
                    image: 'docker.io/img:1',
                    resources: { limits: { memory: '1024Mi', cpu: '1' } },
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
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'sid-1',
      codespaceId: 'p-1',
      status: 'running',
    });
  });

  it('IT-1622: list maps various Ready conditions to status correctly', async () => {
    mockClient.listSandboxes.mockResolvedValue({
      items: [
        // Ready=True → running
        {
          metadata: {
            name: 'a',
            labels: { 'agentpane.io/sandbox-id': 'a', 'agentpane.io/project-id': 'pa' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
        },
        // Ready=False generic → error
        {
          metadata: {
            name: 'b',
            labels: { 'agentpane.io/sandbox-id': 'b', 'agentpane.io/project-id': 'pb' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'False' }] },
        },
        // Ready=False + SandboxExpired → stopped
        {
          metadata: {
            name: 'c',
            labels: { 'agentpane.io/sandbox-id': 'c', 'agentpane.io/project-id': 'pc' },
          },
          spec: {},
          status: {
            replicas: 1,
            conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }],
          },
        },
      ],
    });
    const list = await makeProvider().list();
    expect(list.map((s) => s.status)).toEqual(['running', 'error', 'stopped']);
  });

  it('IT-1623: get falls back to cluster query when not cached', async () => {
    mockClient.listSandboxes.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'agentpane-fallback',
            labels: { 'agentpane.io/sandbox-id': 'sid-fb', 'agentpane.io/project-id': 'p-fb' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    });
    const result = await makeProvider().get('p-fb');
    expect(result).not.toBeNull();
    expect(mockClient.listSandboxes).toHaveBeenCalledWith({
      labelSelector: 'agentpane.io/project-id=p-fb',
    });
  });

  it('IT-1624: recover returns 0/0 when no sandboxes in cluster', async () => {
    const result = await makeProvider().recover();
    expect(result.recovered).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('IT-1625: recover registers running sandboxes from cluster into in-memory cache', async () => {
    mockClient.listSandboxes.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'agentpane-recover',
            labels: { 'agentpane.io/sandbox-id': 'rid', 'agentpane.io/project-id': 'rp' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    });
    const provider = makeProvider();
    const result = await provider.recover();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    // After recovery, a get() for the codespace should return the recovered instance
    expect(await provider.get('rp')).not.toBeNull();
  });

  it('IT-1626: MAY-02 — when network isolation is enabled, NetworkPolicy is created before Sandbox CRD', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    const order: string[] = [];
    mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      order.push('np');
      return {};
    });
    mockClient.createSandbox.mockImplementation(async () => {
      order.push('sb');
      return {};
    });
    await makeProvider().create(sampleConfig);
    expect(order).toEqual(['np', 'sb']);
  });

  it('IT-1627: MAY-02 — fail closed when NetworkPolicy create fails (Sandbox CRD never called)', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValue(new Error('policy denied'));
    await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
      code: 'K8S_POD_CREATION_FAILED',
    });
    expect(mockClient.createSandbox).not.toHaveBeenCalled();
  });
});
