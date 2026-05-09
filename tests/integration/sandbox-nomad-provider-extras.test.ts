/**
 * Coverage gap-filler for `nomad-sandbox-provider.ts`.
 *
 * Targets the branches the port test (`sandbox-nomad-provider.test.ts`)
 * leaves untouched:
 * - assertNetworkIsolationSupport (no-op + version checks + healthy=false)
 * - recover() (terminal teardown, alloc-fetch failure, missing labels,
 *   listJobs throw, refresh failure)
 * - validateSandboxes (refresh-throw eviction, status-stopped/error eviction)
 * - get() cluster fallback path
 * - create() error classification (TimeoutError, ConnectionError, NomadApiError 403)
 * - Network mode "none" injection
 *
 * IT-IDs: IT-2100 to IT-2149
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '../../src/lib/sandbox/types';

interface MockClient {
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

let mockClient: MockClient;

function makeClient(): MockClient {
  return {
    registerJob: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue({
      ID: 'agentpane-cs-extra-test',
      Status: 'running',
      Meta: {
        'agentpane-sandbox-id': 'test-cuid-12345678',
        'agentpane-project-id': 'cs-extra-1',
      },
    }),
    listJobs: vi.fn().mockResolvedValue([]),
    stopJob: vi.fn().mockResolvedValue(undefined),
    getJobAllocations: vi
      .fn()
      .mockResolvedValue([{ ID: 'alloc-extra-1', ClientStatus: 'running' }]),
    getAllocation: vi.fn().mockResolvedValue({ ID: 'alloc-extra-1', ClientStatus: 'running' }),
    getAllocationStats: vi.fn().mockResolvedValue({
      ResourceUsage: { CpuStats: { Percent: 25 }, MemoryStats: { RSS: 256 * 1024 * 1024 } },
    }),
    waitForRunning: vi.fn().mockResolvedValue({ ID: 'alloc-extra-1', ClientStatus: 'running' }),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, version: '1.7.0' }),
    watchJob: vi.fn().mockReturnValue({ stop: vi.fn() }),
  };
}

const { createdBuilderInstances } = vi.hoisted(() => ({
  createdBuilderInstances: [] as Array<{
    [key: string]: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@agentpane/nomad-sandbox-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentpane/nomad-sandbox-sdk')>();
  class MockNomadJobBuilder {
    private _spec: {
      ID: string;
      Name: string;
      Type: string;
      Namespace: string;
      Meta: Record<string, string>;
      TaskGroups: Array<{ Networks?: Array<{ Mode: string }> }>;
    };
    constructor(name: string) {
      this._spec = {
        ID: name,
        Name: name,
        Type: 'service',
        Namespace: 'default',
        Meta: {},
        TaskGroups: [{}],
      };
      createdBuilderInstances.push(this as never);
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
    build = vi.fn().mockImplementation(() => this._spec);
  }
  return {
    ...actual,
    NomadSandboxClient: vi.fn(),
    NomadJobBuilder: MockNomadJobBuilder,
  };
});

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-12345678'),
}));

import { ConnectionError, NomadApiError, TimeoutError } from '@agentpane/nomad-sandbox-sdk';
import { NomadSandboxProvider } from '../../src/lib/sandbox/providers/nomad-sandbox-provider';

const sampleConfig: SandboxConfig = {
  codespaceId: 'cs-extra-1',
  codespacePath: '/host',
  image: 'docker.io/test/image:1',
  memoryMb: 1024,
  cpuCores: 1,
  idleTimeoutMinutes: 15,
  volumeMounts: [],
};

describe('NomadSandboxProvider extras (gap-fillers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    createdBuilderInstances.length = 0;
    mockClient = makeClient();
  });

  afterEach(() => {
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  });

  function makeProvider(opts: Record<string, unknown> = {}) {
    return new NomadSandboxProvider({
      client: mockClient as never,
      ...opts,
    });
  }

  // ─── assertNetworkIsolationSupport ────────────────────────────────────

  describe('assertNetworkIsolationSupport', () => {
    it('IT-2100: no-op when network isolation not requested', async () => {
      await makeProvider().assertNetworkIsolationSupport();
      expect(mockClient.healthCheck).not.toHaveBeenCalled();
    });

    it('IT-2101: succeeds when cluster healthy and version >= 0.10', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      await makeProvider().assertNetworkIsolationSupport();
      expect(mockClient.healthCheck).toHaveBeenCalled();
    });

    it('IT-2102: rejects when cluster reports unhealthy', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.healthCheck.mockResolvedValue({ healthy: false, version: '1.7.0' });
      await expect(makeProvider().assertNetworkIsolationSupport()).rejects.toMatchObject({
        code: 'NOMAD-800',
      });
    });

    it('IT-2103: rejects when version < 0.10', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.healthCheck.mockResolvedValue({ healthy: true, version: '0.9.7' });
      await expect(makeProvider().assertNetworkIsolationSupport()).rejects.toMatchObject({
        code: 'NOMAD-800',
      });
    });

    it('IT-2104: accepts version 0.10+ and proceeds', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.healthCheck.mockResolvedValue({ healthy: true, version: '0.10.0' });
      await makeProvider().assertNetworkIsolationSupport();
    });

    it('IT-2105: accepts unparseable version (best-effort permissive)', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.healthCheck.mockResolvedValue({ healthy: true, version: 'unknown' });
      await makeProvider().assertNetworkIsolationSupport();
    });

    it('IT-2106: rejects when healthCheck throws', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      mockClient.healthCheck.mockRejectedValue(new Error('cluster offline'));
      await expect(makeProvider().assertNetworkIsolationSupport()).rejects.toMatchObject({
        code: 'NOMAD-800',
      });
    });
  });

  // ─── Network mode "none" injection ────────────────────────────────────

  describe('Network mode "none" injection', () => {
    it('IT-2110: injects Networks: [{Mode:"none"}] on first task group when isolation enabled', async () => {
      process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
      await makeProvider().create(sampleConfig);
      const spec = mockClient.registerJob.mock.calls[0]![0] as {
        TaskGroups: Array<{ Networks?: Array<{ Mode: string }> }>;
      };
      expect(spec.TaskGroups[0]!.Networks).toEqual([{ Mode: 'none' }]);
    });

    it('IT-2111: does not inject Networks when isolation is not enforced', async () => {
      await makeProvider().create(sampleConfig);
      const spec = mockClient.registerJob.mock.calls[0]![0] as {
        TaskGroups: Array<{ Networks?: Array<{ Mode: string }> }>;
      };
      expect(spec.TaskGroups[0]!.Networks).toBeUndefined();
    });
  });

  // ─── create() error classification ────────────────────────────────────

  describe('create() error classification', () => {
    it('IT-2120: TimeoutError → JOB_STARTUP_TIMEOUT', async () => {
      mockClient.waitForRunning.mockRejectedValue(new TimeoutError('start', 30000));
      await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-202',
      });
    });

    it('IT-2121: ConnectionError → CLUSTER_UNREACHABLE', async () => {
      mockClient.registerJob.mockRejectedValue(
        new ConnectionError('http://127.0.0.1:4646', new Error('refused'))
      );
      await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-001',
      });
    });

    it('IT-2122: NomadApiError 403 → AUTH_FAILED', async () => {
      mockClient.registerJob.mockRejectedValue(new NomadApiError(403, 'access denied'));
      await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-003',
      });
    });

    it('IT-2123: generic error → JOB_CREATION_FAILED', async () => {
      mockClient.registerJob.mockRejectedValue(new Error('cluster busy'));
      await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-201',
      });
    });

    it('IT-2124: cleanup stopJob is best-effort (failure does not mask original error)', async () => {
      mockClient.waitForRunning.mockRejectedValue(new Error('not ready'));
      mockClient.stopJob.mockRejectedValue(new Error('cleanup failed'));
      // Original error should still surface
      await expect(makeProvider().create(sampleConfig)).rejects.toMatchObject({
        code: 'NOMAD-201',
      });
    });
  });

  // ─── recover() ───────────────────────────────────────────────────────

  describe('recover()', () => {
    it('IT-2130: returns 0/0 when no jobs', async () => {
      const result = await makeProvider().recover();
      expect(result).toEqual({ recovered: 0, removed: 0 });
    });

    it('IT-2131: tolerates listJobs throwing in outer try', async () => {
      mockClient.listJobs.mockRejectedValue(new Error('cluster offline'));
      const result = await makeProvider().recover();
      expect(result).toEqual({ recovered: 0, removed: 0 });
    });

    it('IT-2132: tears down terminal jobs (status=dead)', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-dead',
          Status: 'dead',
          Meta: { 'agentpane-sandbox-id': 'sid-dead', 'agentpane-project-id': 'p-dead' },
        },
      ]);
      const result = await makeProvider().recover();
      expect(result.removed).toBe(1);
      expect(mockClient.stopJob).toHaveBeenCalledWith('agentpane-dead', true);
    });

    it('IT-2133: continues recovery when stopJob fails for terminal', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-dead',
          Status: 'dead',
          Meta: { 'agentpane-sandbox-id': 'sid-dead', 'agentpane-project-id': 'p-dead' },
        },
      ]);
      mockClient.stopJob.mockRejectedValue(new Error('forbidden'));
      const result = await makeProvider().recover();
      expect(result.removed).toBe(0);
    });

    it('IT-2134: skips jobs missing required Meta fields', async () => {
      mockClient.listJobs.mockResolvedValue([
        { ID: 'agentpane-x', Status: 'running', Meta: {} },
        {
          ID: 'agentpane-y',
          Status: 'running',
          Meta: { 'agentpane-sandbox-id': 'only-sid' },
        },
      ]);
      const result = await makeProvider().recover();
      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('IT-2135: skips when getJobAllocations throws', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-running',
          Status: 'running',
          Meta: { 'agentpane-sandbox-id': 'sid-r', 'agentpane-project-id': 'p-r' },
        },
      ]);
      mockClient.getJobAllocations.mockRejectedValue(new Error('alloc API down'));
      const result = await makeProvider().recover();
      expect(result.recovered).toBe(0);
    });

    it('IT-2136: skips when no running allocation found (still pending)', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-pending',
          Status: 'running',
          Meta: { 'agentpane-sandbox-id': 'sid-p', 'agentpane-project-id': 'p-p' },
        },
      ]);
      mockClient.getJobAllocations.mockResolvedValue([{ ID: 'alloc', ClientStatus: 'pending' }]);
      const result = await makeProvider().recover();
      expect(result.recovered).toBe(0);
    });

    it('IT-2137: re-registers a healthy running job into the cache', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-rec',
          Status: 'running',
          Meta: { 'agentpane-sandbox-id': 'sid-rec', 'agentpane-project-id': 'p-rec' },
        },
      ]);
      mockClient.getJob.mockResolvedValue({
        ID: 'agentpane-rec',
        Status: 'running',
        Meta: { 'agentpane-sandbox-id': 'sid-rec', 'agentpane-project-id': 'p-rec' },
      });
      const provider = makeProvider();
      const result = await provider.recover();
      expect(result.recovered).toBe(1);
      expect(await provider.get('p-rec')).not.toBeNull();
    });
  });

  // ─── get() and getById() cache fallback / eviction ───────────────────

  describe('get/getById eviction', () => {
    it('IT-2140: get returns null when nothing tracked and no cluster match', async () => {
      expect(await makeProvider().get('unknown')).toBeNull();
    });

    it('IT-2141: get falls through to cluster query when not cached', async () => {
      mockClient.listJobs.mockResolvedValue([
        {
          ID: 'agentpane-cluster',
          Status: 'running',
          Meta: { 'agentpane-sandbox-id': 'sid-c', 'agentpane-project-id': 'p-c' },
        },
      ]);
      mockClient.getJob.mockResolvedValue({
        ID: 'agentpane-cluster',
        Status: 'running',
        Meta: { 'agentpane-sandbox-id': 'sid-c', 'agentpane-project-id': 'p-c' },
      });
      const result = await makeProvider().get('p-c');
      expect(result).not.toBeNull();
    });

    it('IT-2142: getById returns null for unknown sandbox', async () => {
      expect(await makeProvider().getById('nope')).toBeNull();
    });
  });

  // ─── validateSandboxes ───────────────────────────────────────────────

  describe('validateSandboxes', () => {
    it('IT-2150: evicts cached sandbox when refreshStatus throws', async () => {
      const provider = makeProvider();
      const created = await provider.create(sampleConfig);

      const sandboxes = (
        provider as unknown as {
          sandboxes: Map<
            string,
            { refreshStatus: () => Promise<void>; status: string; codespaceId: string }
          >;
        }
      ).sandboxes;
      const cached = sandboxes.get(created.id);
      if (cached) {
        cached.refreshStatus = vi.fn().mockRejectedValue(new Error('refresh exploded'));
      }

      await provider.validateSandboxes();
      expect(sandboxes.has(created.id)).toBe(false);
    });

    it('IT-2151: evicts cached sandbox when status becomes "stopped"', async () => {
      const provider = makeProvider();
      const created = await provider.create(sampleConfig);

      const sandboxes = (
        provider as unknown as {
          sandboxes: Map<
            string,
            { refreshStatus: () => Promise<void>; status: string; codespaceId: string }
          >;
        }
      ).sandboxes;
      const cached = sandboxes.get(created.id);
      if (cached) {
        cached.refreshStatus = vi.fn().mockImplementation(async () => {
          cached.status = 'stopped';
        });
      }

      await provider.validateSandboxes();
      expect(sandboxes.has(created.id)).toBe(false);
    });

    it('IT-2152: keeps healthy running sandboxes', async () => {
      const provider = makeProvider();
      const created = await provider.create(sampleConfig);

      const sandboxes = (
        provider as unknown as {
          sandboxes: Map<string, { refreshStatus: () => Promise<void>; status: string }>;
        }
      ).sandboxes;
      const cached = sandboxes.get(created.id);
      if (cached) {
        cached.refreshStatus = vi.fn().mockResolvedValue(undefined);
      }

      await provider.validateSandboxes();
      expect(sandboxes.has(created.id)).toBe(true);
    });
  });
});
