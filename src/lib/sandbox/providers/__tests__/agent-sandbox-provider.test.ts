import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '../../types.js';

// --- Mock SDK client ---

interface MockAgentSandboxClient {
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
  namespace: string;
}

let mockClient: MockAgentSandboxClient;

const createMockClient = (): MockAgentSandboxClient => ({
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
  namespace: 'agentpane-sandboxes',
});

// Mock @agentpane/agent-sandbox-sdk
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

// Mock cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-12345678'),
}));

import { AgentSandboxInstance } from '../agent-sandbox-instance.js';
// Import after mocks
import { AgentSandboxProvider, createAgentSandboxProvider } from '../agent-sandbox-provider.js';

describe('AgentSandboxProvider', () => {
  const sampleConfig: SandboxConfig = {
    codespaceId: 'proj-123',
    codespacePath: '/home/user/project',
    image: 'srlynch1/agent-sandbox:latest',
    memoryMb: 4096,
    cpuCores: 2,
    idleTimeoutMinutes: 30,
    volumeMounts: [],
    env: { NODE_ENV: 'development' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createProvider = (options = {}) => {
    return new AgentSandboxProvider({
      client: mockClient as unknown as InstanceType<
        typeof import('@agentpane/agent-sandbox-sdk').AgentSandboxClient
      >,
      ...options,
    });
  };

  describe('constructor', () => {
    it('creates provider with default options', () => {
      const provider = createProvider();
      expect(provider.name).toBe('kubernetes');
    });

    it('creates provider via factory function', () => {
      const provider = createAgentSandboxProvider({
        client: mockClient as unknown as InstanceType<
          typeof import('@agentpane/agent-sandbox-sdk').AgentSandboxClient
        >,
      });
      expect(provider.name).toBe('kubernetes');
    });
  });

  describe('create', () => {
    it('creates sandbox and returns AgentSandboxInstance', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);

      expect(sandbox).toBeInstanceOf(AgentSandboxInstance);
      expect(sandbox.id).toBeDefined();
      expect(sandbox.codespaceId).toBe('proj-123');
      expect(sandbox.status).toBe('running');
    });

    it('calls SDK client.createSandbox with built manifest', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      expect(mockClient.createSandbox).toHaveBeenCalledTimes(1);
      expect(mockClient.waitForReady).toHaveBeenCalledTimes(1);
    });

    it('waits for sandbox to be ready', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      expect(mockClient.waitForReady).toHaveBeenCalledWith(
        expect.stringContaining('agentpane-'),
        expect.objectContaining({ timeoutMs: 120000 })
      );
    });

    it('throws error when sandbox already exists for project', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'K8S_POD_ALREADY_EXISTS',
      });
    });

    it('throws POD_CREATION_FAILED on SDK error', async () => {
      const provider = createProvider();
      mockClient.createSandbox.mockRejectedValue(new Error('API error'));

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'K8S_POD_CREATION_FAILED',
      });
    });

    it('emits sandbox:creating, sandbox:created, and sandbox:started events', async () => {
      const provider = createProvider();
      const events: { type: string }[] = [];

      provider.on((event) => {
        events.push(event);
      });

      await provider.create(sampleConfig);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('sandbox:creating');
      expect(eventTypes).toContain('sandbox:created');
      expect(eventTypes).toContain('sandbox:started');
    });

    it('emits sandbox:error on failure', async () => {
      const provider = createProvider();
      const events: { type: string }[] = [];

      provider.on((event) => {
        events.push(event);
      });

      mockClient.createSandbox.mockRejectedValue(new Error('API error'));

      await expect(provider.create(sampleConfig)).rejects.toThrow();

      expect(events.map((e) => e.type)).toContain('sandbox:error');
    });

    it('uses custom readyTimeoutSeconds', async () => {
      const provider = createProvider({ readyTimeoutSeconds: 60 });

      await provider.create(sampleConfig);

      expect(mockClient.waitForReady).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 60000 })
      );
    });
  });

  describe('get', () => {
    it('returns null for nonexistent project', async () => {
      const provider = createProvider();
      const result = await provider.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns cached sandbox for existing project', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);
      const retrieved = await provider.get(sampleConfig.codespaceId);

      expect(retrieved).toBe(created);
    });

    it('falls back to cluster query when not cached', async () => {
      const provider = createProvider();

      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'agentpane-proj-456-abcdef',
              labels: {
                'agentpane.io/sandbox-id': 'sdk-id-456',
                'agentpane.io/project-id': 'proj-456',
              },
            },
            spec: {},
            status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      });

      const result = await provider.get('proj-456');

      expect(result).toBeInstanceOf(AgentSandboxInstance);
      expect(mockClient.listSandboxes).toHaveBeenCalledWith({
        labelSelector: 'agentpane.io/project-id=proj-456',
      });
    });

    it('returns null on SDK error', async () => {
      const provider = createProvider();
      mockClient.listSandboxes.mockRejectedValue(new Error('network error'));

      const result = await provider.get('proj-456');
      expect(result).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns null for nonexistent sandbox', async () => {
      const provider = createProvider();
      const result = await provider.getById('nonexistent');
      expect(result).toBeNull();
    });

    it('returns sandbox by id', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);
      const retrieved = await provider.getById(created.id);

      expect(retrieved).toBe(created);
    });
  });

  describe('list', () => {
    it('returns empty list when no sandboxes', async () => {
      const provider = createProvider();
      const list = await provider.list();
      expect(list).toEqual([]);
    });

    it('returns list of sandbox infos from cluster', async () => {
      const provider = createProvider();

      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'agentpane-proj-123-abc',
              labels: {
                'agentpane.io/sandbox-id': 'id-1',
                'agentpane.io/project-id': 'proj-123',
              },
              creationTimestamp: '2026-01-01T00:00:00Z',
            },
            spec: {
              podTemplate: {
                spec: {
                  containers: [
                    {
                      name: 'sandbox',
                      image: 'srlynch1/agent-sandbox:latest',
                      resources: {
                        limits: { memory: '4096Mi', cpu: '2' },
                      },
                    },
                  ],
                },
                metadata: {},
              },
            },
            status: {
              replicas: 1,
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      });

      const list = await provider.list();

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'id-1',
        codespaceId: 'proj-123',
        containerId: 'agentpane-proj-123-abc',
        status: 'running',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
      });
    });

    it('returns empty list on SDK error', async () => {
      const provider = createProvider();
      mockClient.listSandboxes.mockRejectedValue(new Error('API error'));

      const list = await provider.list();
      expect(list).toEqual([]);
    });

    it('maps CRD conditions to SandboxStatus correctly', async () => {
      const provider = createProvider();

      // v0.2.1: condition-based status detection
      const items = [
        // Ready=True → running
        {
          metadata: {
            name: 'sandbox-0',
            labels: { 'agentpane.io/sandbox-id': 'id-0', 'agentpane.io/project-id': 'proj-0' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
        },
        // No conditions → creating
        {
          metadata: {
            name: 'sandbox-1',
            labels: { 'agentpane.io/sandbox-id': 'id-1', 'agentpane.io/project-id': 'proj-1' },
          },
          spec: {},
          status: { replicas: 1 },
        },
        // replicas=0 → idle (paused)
        {
          metadata: {
            name: 'sandbox-2',
            labels: { 'agentpane.io/sandbox-id': 'id-2', 'agentpane.io/project-id': 'proj-2' },
          },
          spec: { replicas: 0 },
          status: { replicas: 0, conditions: [{ type: 'Ready', status: 'False' }] },
        },
        // Ready=False (generic) → error
        {
          metadata: {
            name: 'sandbox-3',
            labels: { 'agentpane.io/sandbox-id': 'id-3', 'agentpane.io/project-id': 'proj-3' },
          },
          spec: {},
          status: { replicas: 1, conditions: [{ type: 'Ready', status: 'False' }] },
        },
        // Ready=False + SandboxExpired → stopped
        {
          metadata: {
            name: 'sandbox-4',
            labels: { 'agentpane.io/sandbox-id': 'id-4', 'agentpane.io/project-id': 'proj-4' },
          },
          spec: {},
          status: {
            replicas: 1,
            conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }],
          },
        },
        // No status at all → creating
        {
          metadata: {
            name: 'sandbox-5',
            labels: { 'agentpane.io/sandbox-id': 'id-5', 'agentpane.io/project-id': 'proj-5' },
          },
          spec: {},
        },
      ];

      const expected = ['running', 'creating', 'idle', 'error', 'stopped', 'creating'];

      mockClient.listSandboxes.mockResolvedValue({ items });

      const list = await provider.list();
      expect(list.map((s) => s.status)).toEqual(expected);
    });
  });

  describe('pullImage', () => {
    it('is a no-op for valid image names', async () => {
      const provider = createProvider();
      await expect(provider.pullImage('nginx:latest')).resolves.toBeUndefined();
    });

    it('throws for empty image name', async () => {
      const provider = createProvider();
      await expect(provider.pullImage('')).rejects.toMatchObject({
        code: 'K8S_IMAGE_NOT_FOUND',
      });
    });
  });

  describe('isImageAvailable', () => {
    it('returns true for non-empty image', async () => {
      const provider = createProvider();
      expect(await provider.isImageAvailable('nginx:latest')).toBe(true);
    });

    it('returns false for empty image', async () => {
      const provider = createProvider();
      expect(await provider.isImageAvailable('')).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when cluster and CRD are accessible', async () => {
      const provider = createProvider();

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.provider).toBe('kubernetes');
      expect(health.details?.crdRegistered).toBe(true);
    });

    it('returns unhealthy when cluster is unreachable', async () => {
      const provider = createProvider();
      mockClient.healthCheck.mockResolvedValue({
        healthy: false,
        controllerInstalled: false,
        crdRegistered: false,
        namespace: 'agentpane-sandboxes',
        namespaceExists: false,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('not reachable');
    });

    it('returns unhealthy on SDK exception', async () => {
      const provider = createProvider();
      mockClient.healthCheck.mockRejectedValue(new Error('connection refused'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('connection refused');
    });

    it('indicates when controller is not installed', async () => {
      const provider = createProvider();
      mockClient.healthCheck.mockResolvedValue({
        healthy: true,
        controllerInstalled: false,
        crdRegistered: true,
        namespace: 'agentpane-sandboxes',
        namespaceExists: true,
      });

      const health = await provider.healthCheck();
      expect(health.message).toContain('not installed');
    });
  });

  describe('cleanup', () => {
    it('cleans up stopped sandboxes', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);
      mockClient.deleteSandbox.mockResolvedValue(undefined);

      await sandbox.stop();

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(1);
    });

    it('respects olderThan filter', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);
      mockClient.deleteSandbox.mockResolvedValue(undefined);

      // Stop the sandbox
      const sandbox = await provider.get(sampleConfig.codespaceId);
      await sandbox!.stop();

      // Future date should match
      const futureDate = new Date(Date.now() + 10000);
      const cleaned = await provider.cleanup({ olderThan: futureDate });
      expect(cleaned).toBe(1);
    });

    it('returns 0 when nothing to clean', async () => {
      const provider = createProvider();
      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(0);
    });
  });

  describe('events', () => {
    it('on() adds listener and returns unsubscribe function', () => {
      const provider = createProvider();
      const listener = vi.fn();

      const unsubscribe = provider.on(listener);
      expect(typeof unsubscribe).toBe('function');

      unsubscribe();
    });

    it('off() removes listener', async () => {
      const provider = createProvider();
      const listener = vi.fn();

      provider.on(listener);
      provider.off(listener);

      await provider.create(sampleConfig);

      expect(listener).not.toHaveBeenCalled();
    });

    it('handles listener errors gracefully', async () => {
      const provider = createProvider();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      provider.on(() => {
        throw new Error('listener error');
      });

      // Should not throw despite listener error
      await provider.create(sampleConfig);

      errorSpy.mockRestore();
    });
  });

  describe('initWarmPool', () => {
    it('creates warm pool when enabled', async () => {
      const provider = createProvider({ enableWarmPool: true, warmPoolSize: 3 });

      await provider.initWarmPool();

      expect(mockClient.createWarmPool).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'SandboxWarmPool',
          spec: expect.objectContaining({
            replicas: 3,
            sandboxTemplateRef: { name: 'agentpane-default' },
          }),
        })
      );
    });

    it('does nothing when warm pool is disabled', async () => {
      const provider = createProvider({ enableWarmPool: false });

      await provider.initWarmPool();

      expect(mockClient.createWarmPool).not.toHaveBeenCalled();
    });

    it('replaces existing warm pool when create fails (409)', async () => {
      // Import the mocked AlreadyExistsError so instanceof checks work in source code
      const { AlreadyExistsError: MockedAlreadyExistsError } = await import(
        '@agentpane/agent-sandbox-sdk'
      );
      mockClient.createWarmPool.mockRejectedValueOnce(
        new MockedAlreadyExistsError('WarmPool', 'agentpane-warm-pool')
      );
      mockClient.replaceWarmPool.mockResolvedValueOnce({});

      const provider = createProvider({ enableWarmPool: true });

      await provider.initWarmPool();

      expect(mockClient.replaceWarmPool).toHaveBeenCalledWith(
        'agentpane-warm-pool',
        expect.objectContaining({ kind: 'SandboxWarmPool' })
      );
      expect(mockClient.deleteWarmPool).not.toHaveBeenCalled();
      expect(mockClient.createWarmPool).toHaveBeenCalledTimes(1);
    });

    it('falls back to delete+recreate when replace also fails (409)', async () => {
      const { AlreadyExistsError: MockedAlreadyExistsError } = await import(
        '@agentpane/agent-sandbox-sdk'
      );
      mockClient.createWarmPool
        .mockRejectedValueOnce(new MockedAlreadyExistsError('WarmPool', 'agentpane-warm-pool'))
        .mockResolvedValueOnce({});
      mockClient.replaceWarmPool.mockRejectedValueOnce(new Error('replace failed'));

      const provider = createProvider({ enableWarmPool: true });

      await provider.initWarmPool();

      expect(mockClient.replaceWarmPool).toHaveBeenCalled();
      expect(mockClient.deleteWarmPool).toHaveBeenCalledWith('agentpane-warm-pool');
      expect(mockClient.createWarmPool).toHaveBeenCalledTimes(2);
    });
  });
});

describe('AgentSandboxInstance', () => {
  let instance: AgentSandboxInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    instance = new AgentSandboxInstance(
      'sandbox-id-1',
      'agentpane-proj-123-abc',
      'proj-123',
      'agentpane-sandboxes',
      mockClient as unknown as InstanceType<
        typeof import('@agentpane/agent-sandbox-sdk').AgentSandboxClient
      >
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('properties', () => {
    it('has correct id', () => {
      expect(instance.id).toBe('sandbox-id-1');
    });

    it('has correct codespaceId', () => {
      expect(instance.codespaceId).toBe('proj-123');
    });

    it('containerId maps to sandbox name', () => {
      expect(instance.containerId).toBe('agentpane-proj-123-abc');
    });

    it('initial status is creating', () => {
      expect(instance.status).toBe('creating');
    });
  });

  describe('exec', () => {
    it('delegates to SDK client.exec', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: 'hello world\n',
        stderr: '',
      });

      const result = await instance.exec('echo', ['hello', 'world']);

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'hello world',
        stderr: '',
      });

      expect(mockClient.exec).toHaveBeenCalledWith({
        sandboxName: 'agentpane-proj-123-abc',
        command: ['echo', 'hello', 'world'],
        container: 'sandbox',
      });
    });

    it('throws K8sErrors.EXEC_FAILED on SDK error', async () => {
      mockClient.exec.mockRejectedValue(new Error('connection reset'));

      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'K8S_EXEC_FAILED',
      });
    });

    it('trims stdout and stderr', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: '  trimme  \n',
        stderr: '  warn  \n',
      });

      const result = await instance.exec('test');
      expect(result.stdout).toBe('trimme');
      expect(result.stderr).toBe('warn');
    });
  });

  describe('execAsRoot', () => {
    it('falls back to regular exec with warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockClient.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      await instance.execAsRoot('apt', ['install', '-y', 'curl']);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('execAsRoot'));
      expect(mockClient.exec).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('deletes the sandbox CRD resource', async () => {
      await instance.stop();

      expect(mockClient.deleteSandbox).toHaveBeenCalledWith('agentpane-proj-123-abc');
      expect(instance.status).toBe('stopped');
    });

    it('sets status to error on failure', async () => {
      mockClient.deleteSandbox.mockRejectedValue(new Error('delete failed'));

      await expect(instance.stop()).rejects.toMatchObject({
        code: 'K8S_POD_DELETION_FAILED',
      });
      expect(instance.status).toBe('error');
    });
  });

  describe('execStream', () => {
    it('returns ExecStreamResult with PassThrough streams', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      const result = await instance.execStream({
        cmd: 'node',
        args: ['index.js'],
        cwd: '/workspace',
      });

      expect(result.stdout).toBeDefined();
      expect(result.stderr).toBeDefined();
      expect(typeof result.wait).toBe('function');
      expect(typeof result.kill).toBe('function');
    });

    it('pipes SDK stdout to PassThrough stream', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      const result = await instance.execStream({ cmd: 'echo', args: ['hello'] });

      const chunks: Buffer[] = [];
      result.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

      sdkStdout.write(Buffer.from('hello'));
      sdkStdout.end();

      await new Promise((resolve) => result.stdout.on('end', resolve));

      expect(Buffer.concat(chunks).toString()).toBe('hello');
    });

    it('builds sh -c command when cwd is provided', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      await instance.execStream({
        cmd: 'node',
        args: ['index.js'],
        cwd: '/workspace/proj',
      });

      const callArgs = mockClient.execStream.mock.calls[0]![0] as { command: string[] };
      expect(callArgs.command[0]).toBe('sh');
      expect(callArgs.command[1]).toBe('-c');
      expect(callArgs.command[2]).toContain('/workspace/proj');
    });

    it('injects env vars into shell command', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      await instance.execStream({
        cmd: 'node',
        args: ['index.js'],
        cwd: '/workspace',
        env: { FOO: 'bar' },
      });

      const callArgs = mockClient.execStream.mock.calls[0]![0] as { command: string[] };
      expect(callArgs.command[2]).toContain('FOO=');
    });

    it('uses env command when no cwd', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      await instance.execStream({
        cmd: 'node',
        args: ['index.js'],
        env: { FOO: 'bar' },
      });

      const callArgs = mockClient.execStream.mock.calls[0]![0] as { command: string[] };
      expect(callArgs.command[0]).toBe('env');
      expect(callArgs.command).toContain('FOO=bar');
    });

    it('kill() ends streams and delegates to SDK', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();
      const sdkKill = vi.fn();

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: sdkKill,
      });

      const result = await instance.execStream({ cmd: 'sleep', args: ['100'] });

      await result.kill();

      expect(sdkKill).toHaveBeenCalled();
    });

    it('wait() delegates to SDK wait', async () => {
      const sdkStdout = new PassThrough();
      const sdkStderr = new PassThrough();
      const sdkWait = vi.fn().mockResolvedValue({ exitCode: 42 });

      mockClient.execStream.mockResolvedValue({
        stdout: sdkStdout,
        stderr: sdkStderr,
        wait: sdkWait,
        kill: vi.fn(),
      });

      const result = await instance.execStream({ cmd: 'test' });
      const waitResult = await result.wait();

      expect(waitResult).toEqual({ exitCode: 42 });
    });
  });

  describe('tmux methods', () => {
    it('createTmuxSession calls exec with correct args', async () => {
      // Mock list-sessions to return empty (no existing session)
      mockClient.exec
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no server running' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      const session = await instance.createTmuxSession('test-session', 'task-1');

      expect(session.name).toBe('test-session');
      expect(session.sandboxId).toBe('sandbox-id-1');
      expect(session.taskId).toBe('task-1');
      expect(session.windowCount).toBe(1);
    });

    it('createTmuxSession throws when session exists', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: 'test-session',
        stderr: '',
      });

      await expect(instance.createTmuxSession('test-session')).rejects.toMatchObject({
        code: 'K8S_TMUX_SESSION_EXISTS',
      });
    });

    it('listTmuxSessions parses output correctly', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: 'session1:2:0\nsession2:1:1',
        stderr: '',
      });

      const sessions = await instance.listTmuxSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        name: 'session1',
        windowCount: 2,
        attached: false,
      });
      expect(sessions[1]).toMatchObject({
        name: 'session2',
        windowCount: 1,
        attached: true,
      });
    });

    it('listTmuxSessions returns empty on no server', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'no server running',
      });

      const sessions = await instance.listTmuxSessions();
      expect(sessions).toEqual([]);
    });

    it('killTmuxSession succeeds silently when session not found', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'session not found',
      });

      await expect(instance.killTmuxSession('nonexistent')).resolves.toBeUndefined();
    });

    it('sendKeysToTmux delegates to exec', async () => {
      mockClient.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      await instance.sendKeysToTmux('session1', 'ls -la');

      expect(mockClient.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ['tmux', 'send-keys', '-t', 'session1', 'ls -la', 'Enter'],
        })
      );
    });

    it('captureTmuxPane returns captured output', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: 'line1\nline2\nline3',
        stderr: '',
      });

      const output = await instance.captureTmuxPane('session1', 50);
      expect(output).toBe('line1\nline2\nline3');

      expect(mockClient.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ['tmux', 'capture-pane', '-t', 'session1', '-p', '-S', '-50'],
        })
      );
    });
  });

  describe('getMetrics', () => {
    it('returns metrics from SDK sandbox status', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockClient.getSandbox.mockResolvedValue({
        metadata: { creationTimestamp: pastDate },
        status: { replicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
      });

      const metrics = await instance.getMetrics();

      expect(metrics).toHaveProperty('cpuUsagePercent');
      expect(metrics).toHaveProperty('memoryUsageMb');
      expect(metrics.uptime).toBeGreaterThan(0);
    });

    it('returns placeholder metrics on error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockClient.getSandbox.mockRejectedValue(new Error('not found'));

      const metrics = await instance.getMetrics();

      expect(metrics.cpuUsagePercent).toBe(0);
      expect(metrics.memoryUsageMb).toBe(0);

      warnSpy.mockRestore();
    });
  });

  describe('activity tracking', () => {
    it('touch updates last activity time', async () => {
      const before = instance.getLastActivity();
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.touch();
      const after = instance.getLastActivity();

      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('getLastActivity returns Date', () => {
      expect(instance.getLastActivity()).toBeInstanceOf(Date);
    });
  });
});
