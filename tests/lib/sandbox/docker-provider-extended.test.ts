import type { Container, ContainerInfo, Exec } from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxProviderEvent } from '@/lib/sandbox/providers/sandbox-provider';
import type { SandboxConfig } from '@/lib/sandbox/types';

// ============================================================================
// Mock Setup
// ============================================================================

const mockContainerExec = vi.fn();
const mockContainerStart = vi.fn();
const mockContainerStop = vi.fn();
const mockContainerStats = vi.fn();
const mockContainerRemove = vi.fn();
const mockContainerInspect = vi.fn();
const mockExecStart = vi.fn();
const mockExecInspect = vi.fn();

const mockContainer: Partial<Container> = {
  id: 'container-abc123',
  exec: mockContainerExec,
  start: mockContainerStart,
  stop: mockContainerStop,
  stats: mockContainerStats,
  remove: mockContainerRemove,
  inspect: mockContainerInspect,
};

const mockDockerCreateContainer = vi.fn();
const mockDockerPull = vi.fn();
const mockDockerPing = vi.fn();
const mockDockerInfo = vi.fn();
const mockDockerGetImage = vi.fn();
const mockDockerGetContainer = vi.fn();
const mockDockerListContainers = vi.fn();
const mockDockerModemFollowProgress = vi.fn();

vi.mock('dockerode', () => {
  const MockDocker = function (this: Record<string, unknown>) {
    this.createContainer = mockDockerCreateContainer;
    this.pull = mockDockerPull;
    this.ping = mockDockerPing;
    this.info = mockDockerInfo;
    this.getImage = mockDockerGetImage;
    this.getContainer = mockDockerGetContainer;
    this.listContainers = mockDockerListContainers;
    this.modem = {
      followProgress: mockDockerModemFollowProgress,
    };
  } as unknown as new () => Record<string, unknown>;

  return {
    default: MockDocker,
  };
});

// ============================================================================
// Helpers
// ============================================================================

const createSandboxConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
  codespaceId: 'project-123',
  projectPath: '/path/to/project',
  image: 'docker/sandbox-templates:claude-code',
  memoryMb: 4096,
  cpuCores: 2,
  idleTimeoutMinutes: 30,
  volumeMounts: [],
  env: { NODE_ENV: 'test' },
  ...overrides,
});

const _createMockExecStream = (
  outputs: Array<{ type: 'stdout' | 'stderr'; data: string }>,
  exitCode = 0
) => {
  const mockStream = {
    on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
      if (event === 'data') {
        for (const output of outputs) {
          const header = Buffer.alloc(8);
          header[0] = output.type === 'stdout' ? 1 : 2;
          const payload = Buffer.from(output.data);
          header.writeUInt32BE(payload.length, 4);
          setTimeout(() => callback(Buffer.concat([header, payload])), 0);
        }
      }
      if (event === 'end') {
        setTimeout(() => callback(), outputs.length * 5 + 10);
      }
      return mockStream;
    }),
  };

  const mockExec: Partial<Exec> = {
    start: mockExecStart.mockResolvedValue(mockStream),
    inspect: mockExecInspect.mockResolvedValue({ ExitCode: exitCode }),
  };

  return mockExec;
};

// ============================================================================
// Docker Provider Extended Tests — Recovery, Restart, Validation, Edge Cases
// ============================================================================

describe('DockerProvider — Extended Coverage', () => {
  let DockerProvider: typeof import('@/lib/sandbox/providers/docker-provider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockContainerStart.mockResolvedValue(undefined);
    mockContainerStop.mockResolvedValue(undefined);
    mockContainerRemove.mockResolvedValue(undefined);

    const module = await import('@/lib/sandbox/providers/docker-provider');
    DockerProvider = module.DockerProvider;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Container Recovery (recover)
  // --------------------------------------------------------------------------

  describe('recover()', () => {
    it('recovers running containers with matching image', async () => {
      const expectedImageId = 'sha256:expectedid1234567890';
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: expectedImageId }),
      });

      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-111',
          Names: ['/agentpane-proj1-abcd1234'],
          State: 'running',
          ImageID: expectedImageId,
        },
      ] as Partial<ContainerInfo>[]);

      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(1);
      expect(result.removed).toBe(0);

      // Should be able to get the recovered sandbox
      const sandbox = await provider.get('proj1');
      expect(sandbox).not.toBeNull();
      expect(sandbox?.status).toBe('running');
    });

    it('removes stopped containers during recovery', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:expectedid' }),
      });

      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-222',
          Names: ['/agentpane-proj2-efgh5678'],
          State: 'stopped',
          ImageID: 'sha256:expectedid',
        },
      ] as Partial<ContainerInfo>[]);

      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(1);
      expect(mockContainerRemove).toHaveBeenCalledWith({ force: true });
    });

    it('removes running containers with stale images', async () => {
      const expectedImageId = 'sha256:newimage1234567890a';
      const staleImageId = 'sha256:oldimage1234567890a';

      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: expectedImageId }),
      });

      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-333',
          Names: ['/agentpane-proj3-ijkl9012'],
          State: 'running',
          ImageID: staleImageId,
        },
      ] as Partial<ContainerInfo>[]);

      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(1);
      expect(mockContainerStop).toHaveBeenCalled();
      expect(mockContainerRemove).toHaveBeenCalledWith({ force: true });
    });

    it('skips containers that dont match agentpane naming pattern', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:abc' }),
      });

      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-444',
          Names: ['/some-other-container'],
          State: 'running',
          ImageID: 'sha256:abc',
        },
      ] as Partial<ContainerInfo>[]);

      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('skips already registered project during recovery', async () => {
      const imageId = 'sha256:abcdef1234567890ab';
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: imageId }),
      });

      // Two containers for the same project
      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-aaa',
          Names: ['/agentpane-projX-aaaa1111'],
          State: 'running',
          ImageID: imageId,
        },
        {
          Id: 'container-bbb',
          Names: ['/agentpane-projX-bbbb2222'],
          State: 'running',
          ImageID: imageId,
        },
      ] as Partial<ContainerInfo>[]);

      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const result = await provider.recover();

      // Only the first should be recovered; the second is skipped
      expect(result.recovered).toBe(1);
    });

    it('handles image resolution failure gracefully', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('Image not found')),
      });

      const imageId = 'sha256:someimage12345678a';
      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-555',
          Names: ['/agentpane-proj5-mnop3456'],
          State: 'running',
          ImageID: imageId,
        },
      ] as Partial<ContainerInfo>[]);

      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const result = await provider.recover();

      // Should still recover (skips stale check when image resolution fails)
      expect(result.recovered).toBe(1);
    });

    it('handles listContainers failure gracefully', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:abc' }),
      });
      mockDockerListContainers.mockRejectedValue(new Error('Docker daemon not running'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(0);
      consoleSpy.mockRestore();
    });

    it('handles failure to remove stopped container gracefully', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:expectedid' }),
      });

      mockDockerListContainers.mockResolvedValue([
        {
          Id: 'container-666',
          Names: ['/agentpane-proj6-qrst7890'],
          State: 'stopped',
          ImageID: 'sha256:expectedid',
        },
      ] as Partial<ContainerInfo>[]);

      const failingContainer = {
        ...mockContainer,
        remove: vi.fn().mockRejectedValue(new Error('Permission denied')),
      };
      mockDockerGetContainer.mockReturnValue(failingContainer);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      // Removal was attempted but failed; removed stays 0
      expect(result.removed).toBe(0);
      consoleSpy.mockRestore();
    });

    it('recovers zero containers when none exist', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:abc' }),
      });
      mockDockerListContainers.mockResolvedValue([]);

      const provider = new DockerProvider();
      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Container Restart
  // --------------------------------------------------------------------------

  describe('restart()', () => {
    it('restarts a running container', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerInspect.mockResolvedValue({ State: { Running: true } });
      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const restarted = await provider.restart('project-123');

      expect(restarted).not.toBeNull();
      expect(restarted?.status).toBe('running');
      expect(mockContainerStop).toHaveBeenCalledWith({ t: 5 });
      expect(mockContainerStart).toHaveBeenCalled();
    });

    it('starts a stopped container without stopping first', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerInspect.mockResolvedValue({ State: { Running: false } });
      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      // manually set stopped status
      (sandbox as { status: string }).status = 'stopped';

      // Reset start call count from create
      mockContainerStart.mockClear();
      mockContainerStop.mockClear();

      const restarted = await provider.restart('project-123');

      expect(restarted).not.toBeNull();
      // Stop should NOT have been called since not running
      expect(mockContainerStop).not.toHaveBeenCalled();
      expect(mockContainerStart).toHaveBeenCalled();
    });

    it('returns null for unknown project', async () => {
      const provider = new DockerProvider();
      const result = await provider.restart('nonexistent');

      expect(result).toBeNull();
    });

    it('emits started event on successful restart', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerInspect.mockResolvedValue({ State: { Running: true } });
      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const events: SandboxProviderEvent[] = [];
      provider.on((e) => events.push(e));

      await provider.restart('project-123');

      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:started' }));
    });

    it('emits error event and throws on restart failure', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerInspect.mockRejectedValue(new Error('Container gone'));
      mockDockerGetContainer.mockReturnValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const events: SandboxProviderEvent[] = [];
      provider.on((e) => events.push(e));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(provider.restart('project-123')).rejects.toThrow('Container gone');
      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:error' }));
      consoleSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // Container Validation (validateContainers)
  // --------------------------------------------------------------------------

  describe('validateContainers() via list()', () => {
    it('prunes stale entries where container no longer exists in Docker', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockDockerGetContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      });

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // Calling list triggers validateContainers
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const infos = await provider.list();

      // The stale entry should have been pruned
      expect(infos).toHaveLength(0);
      consoleSpy.mockRestore();
    });

    it('keeps valid entries where container exists in Docker', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockDockerGetContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      });

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const infos = await provider.list();
      expect(infos).toHaveLength(1);
      expect(infos[0].codespaceId).toBe('project-123');
    });

    it('ignores non-404 errors during validation', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockDockerGetContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 500 }),
      });

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // Non-404 error should not prune the entry
      const infos = await provider.list();
      expect(infos).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Container Get — default fallback
  // --------------------------------------------------------------------------

  describe('get() with default fallback', () => {
    it('falls back to default sandbox when project-specific not found', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig({ codespaceId: 'default' }));

      // Request project that doesn't have its own sandbox
      const sandbox = await provider.get('some-unknown-project');

      // Should fall back to 'default' sandbox
      expect(sandbox).not.toBeNull();
      expect(sandbox?.codespaceId).toBe('default');
    });

    it('returns null when no project sandbox and no default sandbox', async () => {
      const provider = new DockerProvider();
      const sandbox = await provider.get('nonexistent');

      expect(sandbox).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Container Creation — allows re-creation after stopped
  // --------------------------------------------------------------------------

  describe('create() — re-creation', () => {
    it('allows creating sandbox for project after previous one was stopped', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox1 = await provider.create(createSandboxConfig());
      await sandbox1.stop();

      // Should succeed since previous sandbox is stopped
      const sandbox2 = await provider.create(createSandboxConfig());
      expect(sandbox2).toBeDefined();
      expect(sandbox2.status).toBe('running');
    });

    it('emits creating, created, and started events', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];
      provider.on((e) => events.push(e));

      await provider.create(createSandboxConfig());

      const types = events.map((e) => e.type);
      expect(types).toContain('sandbox:creating');
      expect(types).toContain('sandbox:created');
      expect(types).toContain('sandbox:started');
    });

    it('emits error event with Error object when creation fails with non-Error', async () => {
      mockDockerCreateContainer.mockRejectedValue('string error');

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];
      provider.on((e) => events.push(e));

      await expect(provider.create(createSandboxConfig())).rejects.toMatchObject({
        code: 'SANDBOX_CONTAINER_CREATION_FAILED',
      });

      const errorEvent = events.find((e) => e.type === 'sandbox:error');
      expect(errorEvent).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Container Creation — config variations
  // --------------------------------------------------------------------------

  describe('create() — config variations', () => {
    it('creates container with no env variables', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig({ env: undefined });
      await provider.create(config);

      expect(mockDockerCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: [],
        })
      );
    });

    it('creates container with multiple volume mounts', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig({
        volumeMounts: [
          { hostPath: '/host/a', containerPath: '/container/a', readonly: true },
          { hostPath: '/host/b', containerPath: '/container/b', readonly: false },
          { hostPath: '/host/c', containerPath: '/container/c' },
        ],
      });
      await provider.create(config);

      const call = mockDockerCreateContainer.mock.calls[0][0];
      expect(call.HostConfig.Binds).toContain('/host/a:/container/a:ro');
      expect(call.HostConfig.Binds).toContain('/host/b:/container/b:rw');
      expect(call.HostConfig.Binds).toContain('/host/c:/container/c:rw');
      // workspace always present
      expect(call.HostConfig.Binds).toContain('/path/to/project:/workspace:rw');
    });

    it('sets correct memory and cpu limits', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig({ memoryMb: 8192, cpuCores: 4 });
      await provider.create(config);

      const call = mockDockerCreateContainer.mock.calls[0][0];
      expect(call.HostConfig.Memory).toBe(8192 * 1024 * 1024);
      expect(call.HostConfig.NanoCpus).toBe(4 * 1e9);
    });

    it('sets container name with sandboxId prefix', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig({ codespaceId: 'my-project' }));

      const call = mockDockerCreateContainer.mock.calls[0][0];
      expect(call.name).toMatch(/^agentpane-my-project-[a-z0-9]+$/);
    });
  });

  // --------------------------------------------------------------------------
  // Health Check — edge cases
  // --------------------------------------------------------------------------

  describe('healthCheck() — edge cases', () => {
    it('includes container counts in healthy response', async () => {
      mockDockerPing.mockResolvedValue('OK');
      mockDockerInfo.mockResolvedValue({
        ServerVersion: '25.0.0',
        Containers: 10,
        ContainersRunning: 3,
        Images: 25,
      });

      const provider = new DockerProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.images).toBe(25);
    });

    it('returns message with error info when unhealthy', async () => {
      mockDockerPing.mockRejectedValue(new Error('ECONNREFUSED'));

      const provider = new DockerProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('ECONNREFUSED');
    });

    it('handles non-Error throws from ping', async () => {
      mockDockerPing.mockRejectedValue('string error');

      const provider = new DockerProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('string error');
    });
  });

  // --------------------------------------------------------------------------
  // Cleanup — edge cases
  // --------------------------------------------------------------------------

  describe('cleanup() — edge cases', () => {
    it('defaults to cleaning stopped containers when no status filter', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      await sandbox.stop();

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(1);
    });

    it('does not clean running containers when no status filter', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(0);
    });

    it('respects both olderThan and status filters', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // In the future — sandbox was just created, so it's newer
      const futureDate = new Date(Date.now() + 3600_000);
      const cleaned = await provider.cleanup({ olderThan: futureDate, status: ['running'] });

      expect(cleaned).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Event Listener Management — edge cases
  // --------------------------------------------------------------------------

  describe('event listener management', () => {
    it('supports multiple concurrent listeners', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events1: SandboxProviderEvent[] = [];
      const events2: SandboxProviderEvent[] = [];

      provider.on((e) => events1.push(e));
      provider.on((e) => events2.push(e));

      await provider.create(createSandboxConfig());

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
      expect(events1.length).toBe(events2.length);
    });

    it('one failing listener does not affect others', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      provider.on(() => {
        throw new Error('Listener 1 fails');
      });
      provider.on((e) => events.push(e));

      await provider.create(createSandboxConfig());

      // Second listener should still receive events
      expect(events.length).toBeGreaterThan(0);
      consoleSpy.mockRestore();
    });
  });
});
