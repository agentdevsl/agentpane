import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '../../types.js';

// --- Mock SDK client ---

interface MockNomadSandboxClient {
  registerJob: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  listJobs: ReturnType<typeof vi.fn>;
  stopJob: ReturnType<typeof vi.fn>;
  getJobAllocations: ReturnType<typeof vi.fn>;
  getAllocation: ReturnType<typeof vi.fn>;
  getAllocationStats: ReturnType<typeof vi.fn>;
  waitForRunning: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  execStream: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  watchJob: ReturnType<typeof vi.fn>;
}

let mockClient: MockNomadSandboxClient;

const createMockClient = (): MockNomadSandboxClient => ({
  registerJob: vi.fn().mockResolvedValue({}),
  getJob: vi.fn().mockResolvedValue({
    ID: 'agentpane-proj-123-test1234',
    Status: 'running',
    Meta: {
      'agentpane-sandbox-id': 'test-cuid-12345678',
      'agentpane-project-id': 'proj-123',
    },
  }),
  listJobs: vi.fn().mockResolvedValue([]),
  stopJob: vi.fn().mockResolvedValue(undefined),
  getJobAllocations: vi.fn().mockResolvedValue([{ ID: 'alloc-abc-123', ClientStatus: 'running' }]),
  getAllocation: vi.fn().mockResolvedValue({
    ID: 'alloc-abc-123',
    ClientStatus: 'running',
  }),
  getAllocationStats: vi.fn().mockResolvedValue({
    ResourceUsage: {
      CpuStats: { Percent: 25 },
      MemoryStats: { RSS: 512 * 1024 * 1024 },
    },
  }),
  waitForRunning: vi.fn().mockResolvedValue({
    ID: 'alloc-abc-123',
    ClientStatus: 'running',
  }),
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  execStream: vi.fn().mockReturnValue({
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stdin: new WritableStream(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn(),
  }),
  healthCheck: vi.fn().mockResolvedValue({
    healthy: true,
    leader: '10.0.0.1:4647',
    version: '1.7.0',
    namespaceExists: true,
    datacenter: 'dc1',
  }),
  watchJob: vi.fn().mockReturnValue({ stop: vi.fn() }),
});

// Mock @agentpane/nomad-sandbox-sdk
vi.mock('@agentpane/nomad-sandbox-sdk', () => {
  class MockNomadJobBuilder {
    private _name: string;
    constructor(name: string) {
      this._name = name;
    }
    type = vi.fn().mockReturnThis();
    namespace = vi.fn().mockReturnThis();
    datacenter = vi.fn().mockReturnThis();
    image = vi.fn().mockReturnThis();
    command = vi.fn().mockReturnThis();
    resources = vi.fn().mockReturnThis();
    meta = vi.fn().mockReturnThis();
    env = vi.fn().mockReturnThis();
    volumes = vi.fn().mockReturnThis();
    agentPaneContext = vi.fn().mockReturnThis();
    build = vi.fn().mockImplementation(() => ({
      ID: this._name,
      Name: this._name,
      Type: 'service',
      Namespace: 'default',
      Meta: {},
      TaskGroups: [],
    }));
  }

  return {
    NomadSandboxClient: vi.fn(),
    NomadJobBuilder: MockNomadJobBuilder,
    NOMAD_JOB_PREFIX: 'agentpane-',
    NOMAD_META: {
      SANDBOX_ID: 'agentpane-sandbox-id',
      PROJECT_ID: 'agentpane-project-id',
      TASK_ID: 'agentpane-task-id',
    },
    NOMAD_DEFAULTS: {
      address: 'http://127.0.0.1:4646',
      namespace: 'default',
      region: 'global',
      datacenter: 'dc1',
      waitTimeout: '30s',
      readyTimeoutMs: 120_000,
    },
  };
});

// Mock cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-12345678'),
}));

import { NomadSandboxInstance } from '../nomad-sandbox-instance.js';
// Import after mocks
import {
  createNomadSandboxProvider,
  mapNomadJobStatus,
  NomadSandboxProvider,
} from '../nomad-sandbox-provider.js';

describe('NomadSandboxProvider', () => {
  const sampleConfig: SandboxConfig = {
    projectId: 'proj-123',
    projectPath: '/home/user/project',
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
    return new NomadSandboxProvider({
      client: mockClient as unknown as InstanceType<
        typeof import('@agentpane/nomad-sandbox-sdk').NomadSandboxClient
      >,
      ...options,
    });
  };

  describe('constructor', () => {
    it('creates provider with default options', () => {
      const provider = createProvider();
      expect(provider.name).toBe('nomad');
    });

    it('creates provider via factory function', () => {
      const provider = createNomadSandboxProvider({
        client: mockClient as unknown as InstanceType<
          typeof import('@agentpane/nomad-sandbox-sdk').NomadSandboxClient
        >,
      });
      expect(provider.name).toBe('nomad');
    });
  });

  describe('mapNomadJobStatus', () => {
    it('maps "running" to "running"', () => {
      expect(mapNomadJobStatus('running')).toBe('running');
    });

    it('maps "pending" to "creating"', () => {
      expect(mapNomadJobStatus('pending')).toBe('creating');
    });

    it('maps "dead" to "stopped"', () => {
      expect(mapNomadJobStatus('dead')).toBe('stopped');
    });

    it('maps undefined to "error"', () => {
      expect(mapNomadJobStatus(undefined)).toBe('error');
    });

    it('maps unknown status to "error"', () => {
      expect(mapNomadJobStatus('unknown-status')).toBe('error');
    });
  });

  describe('create', () => {
    it('creates sandbox, registers job, waits for running, returns NomadSandboxInstance', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);

      expect(sandbox).toBeInstanceOf(NomadSandboxInstance);
      expect(sandbox.id).toBeDefined();
      expect(sandbox.projectId).toBe('proj-123');
      expect(sandbox.status).toBe('creating');
    });

    it('calls SDK client.registerJob and waitForRunning', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      expect(mockClient.registerJob).toHaveBeenCalledTimes(1);
      expect(mockClient.waitForRunning).toHaveBeenCalledTimes(1);
    });

    it('waits for job with correct timeout', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      expect(mockClient.waitForRunning).toHaveBeenCalledWith(
        expect.stringContaining('agentpane-'),
        120000
      );
    });

    it('uses custom readyTimeoutSeconds', async () => {
      const provider = createProvider({ readyTimeoutSeconds: 60 });

      await provider.create(sampleConfig);

      expect(mockClient.waitForRunning).toHaveBeenCalledWith(expect.any(String), 60000);
    });

    it('handles registration failure gracefully', async () => {
      const provider = createProvider();
      mockClient.registerJob.mockRejectedValue(new Error('Nomad API error'));

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-201',
      });
    });

    it('handles waitForRunning timeout', async () => {
      const provider = createProvider();
      mockClient.waitForRunning.mockRejectedValue(new Error('Timeout waiting for job'));

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-201',
      });
    });

    it('throws when no running allocation found after wait', async () => {
      const provider = createProvider();
      mockClient.getJobAllocations.mockResolvedValue([{ ID: 'alloc-1', ClientStatus: 'pending' }]);

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-201',
      });
    });

    it('throws JOB_ALREADY_EXISTS when sandbox already exists for project', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-205',
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

      mockClient.registerJob.mockRejectedValue(new Error('API error'));

      await expect(provider.create(sampleConfig)).rejects.toThrow();

      expect(events.map((e) => e.type)).toContain('sandbox:error');
    });

    it('fetches allocations after waitForRunning to find alloc ID', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      expect(mockClient.getJobAllocations).toHaveBeenCalledWith(
        expect.stringContaining('agentpane-')
      );
    });
  });

  describe('destroy / stop', () => {
    it('stops job via the sandbox instance and removes from internal maps', async () => {
      const provider = createProvider();
      const sandbox = await provider.create(sampleConfig);

      await sandbox.stop();

      expect(mockClient.stopJob).toHaveBeenCalledWith(expect.stringContaining('agentpane-'), true);
      expect(sandbox.status).toBe('stopped');
    });

    it('handles non-existent sandbox gracefully in cleanup', async () => {
      const provider = createProvider();
      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(0);
    });
  });

  describe('get', () => {
    it('returns null for nonexistent project when no jobs match', async () => {
      const provider = createProvider();
      mockClient.listJobs.mockResolvedValue([]);

      const result = await provider.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns cached sandbox for existing project', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);
      const retrieved = await provider.get(sampleConfig.projectId);

      expect(retrieved).toBe(created);
    });

    it('falls back to cluster query when not cached', async () => {
      const provider = createProvider();

      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-proj-456-abcdef',
          Status: 'running',
          Meta: {
            'agentpane-sandbox-id': 'sdk-id-456',
            'agentpane-project-id': 'proj-456',
          },
        },
      ]);

      const result = await provider.get('proj-456');

      expect(result).toBeInstanceOf(NomadSandboxInstance);
      expect(mockClient.listJobs).toHaveBeenCalledWith('agentpane-');
    });

    it('returns null on cluster error', async () => {
      const provider = createProvider();
      mockClient.listJobs.mockRejectedValue(new Error('network error'));

      const result = await provider.get('proj-456');
      expect(result).toBeNull();
    });

    it('returns null when job not found', async () => {
      const provider = createProvider();
      mockClient.listJobs.mockResolvedValue([]);

      const result = await provider.get('default');
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

    it('returns mapped sandbox statuses from Nomad jobs', async () => {
      const provider = createProvider();

      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-proj-1-abc',
          Status: 'running',
          Meta: {
            'agentpane-sandbox-id': 'id-1',
            'agentpane-project-id': 'proj-1',
          },
        },
        {
          ID: 'agentpane-proj-2-def',
          Status: 'pending',
          Meta: {
            'agentpane-sandbox-id': 'id-2',
            'agentpane-project-id': 'proj-2',
          },
        },
        {
          ID: 'agentpane-proj-3-ghi',
          Status: 'dead',
          Meta: {
            'agentpane-sandbox-id': 'id-3',
            'agentpane-project-id': 'proj-3',
          },
        },
      ]);

      const list = await provider.list();

      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({
        id: 'id-1',
        projectId: 'proj-1',
        containerId: 'agentpane-proj-1-abc',
        status: 'running',
      });
      expect(list[1]).toMatchObject({
        id: 'id-2',
        projectId: 'proj-2',
        containerId: 'agentpane-proj-2-def',
        status: 'creating',
      });
      expect(list[2]).toMatchObject({
        id: 'id-3',
        projectId: 'proj-3',
        containerId: 'agentpane-proj-3-ghi',
        status: 'stopped',
      });
    });

    it('returns empty array on cluster error', async () => {
      const provider = createProvider();
      mockClient.listJobs.mockRejectedValue(new Error('API error'));

      const list = await provider.list();
      expect(list).toEqual([]);
    });

    it('filters out jobs without sandbox ID meta', async () => {
      const provider = createProvider();

      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-proj-1-abc',
          Status: 'running',
          Meta: {
            'agentpane-sandbox-id': 'id-1',
            'agentpane-project-id': 'proj-1',
          },
        },
        {
          ID: 'unrelated-job',
          Status: 'running',
          Meta: {},
        },
      ]);

      const list = await provider.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe('id-1');
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
        code: 'NOMAD-402',
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
    it('returns healthy when cluster is accessible', async () => {
      const provider = createProvider();

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.provider).toBe('nomad');
      expect(health.details?.namespaceExists).toBe(true);
    });

    it('returns unhealthy when cluster is unreachable', async () => {
      const provider = createProvider();
      mockClient.healthCheck.mockResolvedValue({
        healthy: false,
        leader: null,
        version: null,
        namespaceExists: false,
        datacenter: null,
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

    it('indicates when no leader is elected', async () => {
      const provider = createProvider();
      mockClient.healthCheck.mockResolvedValue({
        healthy: false,
        leader: null,
        version: '1.7.0',
        namespaceExists: true,
        datacenter: 'dc1',
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('no leader');
    });
  });

  describe('cleanup', () => {
    it('cleans up stopped sandboxes', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);
      await sandbox.stop();

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(1);
    });

    it('respects olderThan filter', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);
      const sandbox = await provider.get(sampleConfig.projectId);
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
});

describe('NomadSandboxInstance', () => {
  let instance: NomadSandboxInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    instance = new NomadSandboxInstance(
      'sandbox-id-1',
      'agentpane-proj-123-abc',
      'alloc-abc-123',
      'proj-123',
      'default',
      mockClient as unknown as InstanceType<
        typeof import('@agentpane/nomad-sandbox-sdk').NomadSandboxClient
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

    it('has correct projectId', () => {
      expect(instance.projectId).toBe('proj-123');
    });

    it('containerId returns jobName', () => {
      expect(instance.containerId).toBe('agentpane-proj-123-abc');
    });

    it('initial status is creating', () => {
      expect(instance.status).toBe('creating');
    });
  });

  describe('exec', () => {
    it('delegates to client.exec with correct allocId and task name', async () => {
      // Set status to running so assertRunning passes
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'running' },
      ]);
      await instance.refreshStatus();

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
        allocId: 'alloc-abc-123',
        task: 'sandbox',
        command: ['echo', 'hello', 'world'],
      });
    });

    it('throws when sandbox not in running/creating state (assertRunning)', async () => {
      // Set status to stopped
      mockClient.getJob.mockResolvedValue({ Status: 'dead' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'complete' },
      ]);
      await instance.refreshStatus();

      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'NOMAD-204',
      });
    });

    it('wraps errors in NomadErrors.EXEC_FAILED', async () => {
      // Status is creating by default, which passes assertRunning
      mockClient.exec.mockRejectedValue(new Error('connection reset'));

      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'NOMAD-300',
      });
    });

    it('trims stdout and stderr', async () => {
      mockClient.exec.mockResolvedValue({
        exitCode: 0,
        stdout: '  trimmed  \n',
        stderr: '  warn  \n',
      });

      const result = await instance.exec('test');
      expect(result.stdout).toBe('trimmed');
      expect(result.stderr).toBe('warn');
    });
  });

  describe('execAsRoot', () => {
    it('delegates to exec (same implementation) with warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockClient.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      await instance.execAsRoot('apt', ['install', '-y', 'curl']);

      expect(mockClient.exec).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('execStream', () => {
    it('builds correct command with cwd and env', async () => {
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
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

    it('handles environment variables correctly', async () => {
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
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

    it('rejects invalid env variable keys', async () => {
      await expect(
        instance.execStream({
          cmd: 'node',
          args: [],
          env: { 'INVALID KEY!': 'value' },
        })
      ).rejects.toMatchObject({
        code: 'NOMAD-300',
      });
    });

    it('uses env command when no cwd', async () => {
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
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

    it('returns ExecStreamResult with stdout and stderr', async () => {
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
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

    it('kill() delegates to SDK kill', async () => {
      const sdkKill = vi.fn();
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: sdkKill,
      });

      const result = await instance.execStream({ cmd: 'sleep', args: ['100'] });

      await result.kill();

      expect(sdkKill).toHaveBeenCalled();
    });

    it('wait() delegates to SDK wait', async () => {
      const sdkWait = vi.fn().mockResolvedValue({ exitCode: 42 });
      const mockStdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const mockStderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockClient.execStream.mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: new WritableStream(),
        wait: sdkWait,
        kill: vi.fn(),
      });

      const result = await instance.execStream({ cmd: 'test' });
      const waitResult = await result.wait();

      expect(waitResult).toEqual({ exitCode: 42 });
    });
  });

  describe('getStatus / refreshStatus', () => {
    it('returns mapped status from job state', async () => {
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'running' },
      ]);

      await instance.refreshStatus();

      expect(instance.status).toBe('running');
    });

    it('updates internal status from Nomad job state', async () => {
      // First refresh: running
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'running' },
      ]);
      await instance.refreshStatus();
      expect(instance.status).toBe('running');

      // Second refresh: dead
      mockClient.getJob.mockResolvedValue({ Status: 'dead' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'complete' },
      ]);
      await instance.refreshStatus();
      expect(instance.status).toBe('stopped');
    });

    it('sets status to error on API error', async () => {
      mockClient.getJob.mockRejectedValue(new Error('API timeout'));

      await instance.refreshStatus();

      expect(instance.status).toBe('error');
    });

    it('sets status to stopped when job not found (NotFoundError)', async () => {
      const notFound = new Error('not found');
      notFound.name = 'NotFoundError';
      mockClient.getJob.mockRejectedValue(notFound);

      await instance.refreshStatus();

      expect(instance.status).toBe('stopped');
    });

    it('maps dead job with failed allocation to error', async () => {
      mockClient.getJob.mockResolvedValue({ Status: 'dead' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'failed' },
      ]);

      await instance.refreshStatus();

      expect(instance.status).toBe('error');
    });

    it('maps dead job with lost allocation to error', async () => {
      mockClient.getJob.mockResolvedValue({ Status: 'dead' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'lost' },
      ]);

      await instance.refreshStatus();

      expect(instance.status).toBe('error');
    });

    it('updates allocId when allocation is rescheduled', async () => {
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'new-alloc-456', ClientStatus: 'running' },
      ]);

      await instance.refreshStatus();

      // Now exec should use the new alloc ID
      mockClient.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
      await instance.exec('ls');

      expect(mockClient.exec).toHaveBeenCalledWith(
        expect.objectContaining({ allocId: 'new-alloc-456' })
      );
    });
  });

  describe('getMetrics', () => {
    it('returns metrics with uptime', async () => {
      mockClient.getJob.mockResolvedValue({ Status: 'running' });

      const metrics = await instance.getMetrics();

      expect(metrics).toHaveProperty('cpuUsagePercent');
      expect(metrics).toHaveProperty('memoryUsageMb');
      expect(metrics).toHaveProperty('uptime');
      expect(metrics.cpuUsagePercent).toBe(0);
      expect(metrics.memoryUsageMb).toBe(0);
    });

    it('propagates errors (does not return fake zeros)', async () => {
      mockClient.getJob.mockRejectedValue(new Error('not found'));

      await expect(instance.getMetrics()).rejects.toMatchObject({
        code: 'NOMAD-300',
      });
    });
  });

  describe('stop', () => {
    it('stops the Nomad job', async () => {
      await instance.stop();

      expect(mockClient.stopJob).toHaveBeenCalledWith('agentpane-proj-123-abc', true);
      expect(instance.status).toBe('stopped');
    });

    it('sets status to error on failure', async () => {
      mockClient.stopJob.mockRejectedValue(new Error('stop failed'));

      await expect(instance.stop()).rejects.toMatchObject({
        code: 'NOMAD-203',
      });
      expect(instance.status).toBe('error');
    });
  });

  describe('tmux methods', () => {
    it('createTmuxSession calls exec with tmux commands', async () => {
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
        code: 'NOMAD-501',
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
      // Need running status for assertRunning
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'running' },
      ]);
      await instance.refreshStatus();

      mockClient.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

      await instance.sendKeysToTmux('session1', 'ls -la');

      expect(mockClient.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ['tmux', 'send-keys', '-t', 'session1', 'ls -la', 'Enter'],
        })
      );
    });

    it('captureTmuxPane returns captured output', async () => {
      // Need running status for assertRunning
      mockClient.getJob.mockResolvedValue({ Status: 'running' });
      mockClient.getJobAllocations.mockResolvedValue([
        { ID: 'alloc-abc-123', ClientStatus: 'running' },
      ]);
      await instance.refreshStatus();

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
