/**
 * Integration tests for DockerProvider — Docker-based sandbox provider.
 *
 * Tests cover:
 * - create: container config security constraints (CapDrop ALL, CapAdd minimal, no-new-privileges)
 * - create: volume mounts, memory/CPU limits, event emission
 * - recover: scan containers with agentpane- prefix, remove stopped, detect stale images
 * - validateContainers: prune entries where Docker container returns 404
 * - exec/execStream: Docker multiplexed stream parsing (8-byte header frames)
 * - cleanup: stop + remove matching criteria
 * - healthCheck: Docker ping + info
 * - list: validates containers still exist before returning
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerProvider } from '../../src/lib/sandbox/providers/docker-provider';
import type { SandboxProviderEvent } from '../../src/lib/sandbox/providers/sandbox-provider';

// Create a mock Docker class with all needed methods
function createMockDocker() {
  const mockContainer = {
    id: 'container-mock-id-abc123',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Running: true },
      Config: { Image: 'test-image' },
    }),
    exec: vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue({ on: vi.fn(), destroy: vi.fn() }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    }),
    stats: vi.fn().mockResolvedValue({
      cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 500 },
      memory_stats: { usage: 1024 * 1024 * 100, limit: 1024 * 1024 * 4096 },
      networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 } },
    }),
  };

  const docker = {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    pull: vi.fn(),
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({
      ServerVersion: '24.0.0',
      Containers: 5,
      ContainersRunning: 3,
      Images: 10,
    }),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: 'sha256:expected-image-id' }),
    }),
    modem: {
      followProgress: vi.fn(),
    },
  };

  return { docker, mockContainer };
}

describe('DockerProvider (IT-1450)', () => {
  let provider: DockerProvider;
  let mockDocker: ReturnType<typeof createMockDocker>['docker'];
  let mockContainer: ReturnType<typeof createMockDocker>['mockContainer'];

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockDocker();
    mockDocker = mocks.docker;
    mockContainer = mocks.mockContainer;

    // Create provider and inject mock docker
    provider = new DockerProvider();
    // Replace the internal docker client
    (provider as any).docker = mockDocker;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create (IT-1451)', () => {
    it('IT-1452a: container config has CapDrop ALL, CapAdd minimal set, no-new-privileges', async () => {
      const sandbox = await provider.create({
        codespaceId: 'proj-test-1',
        codespacePath: '/home/user/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(sandbox).toBeDefined();
      expect(sandbox.status).toBe('running');

      // Verify createContainer was called with security constraints
      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.HostConfig.CapDrop).toEqual(['ALL']);
      expect(createCall.HostConfig.CapAdd).toEqual([
        'CHOWN',
        'SETUID',
        'SETGID',
        'DAC_OVERRIDE',
        'FOWNER',
      ]);
      expect(createCall.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    });

    it('IT-1452b: volume mounts are correctly configured', async () => {
      await provider.create({
        codespaceId: 'proj-vol-1',
        codespacePath: '/home/user/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 15,
        volumeMounts: [
          { hostPath: '/host/data', containerPath: '/container/data', readonly: true },
          { hostPath: '/host/config', containerPath: '/container/config' },
        ],
      });

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      const binds = createCall.HostConfig.Binds;

      expect(binds).toContain('/home/user/project:/workspace:rw');
      expect(binds).toContain('/host/data:/container/data:ro');
      expect(binds).toContain('/host/config:/container/config:rw');
    });

    it('IT-1452c: memory and CPU limits are set correctly', async () => {
      await provider.create({
        codespaceId: 'proj-limits-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 2048,
        cpuCores: 4,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(createCall.HostConfig.NanoCpus).toBe(4 * 1e9);
    });

    it('IT-1452d: emits creating and created/started events', async () => {
      const events: SandboxProviderEvent[] = [];
      provider.on((event) => events.push(event));

      await provider.create({
        codespaceId: 'proj-events-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0].type).toBe('sandbox:creating');
      expect(events[1].type).toBe('sandbox:created');
      expect(events[2].type).toBe('sandbox:started');

      // Verify event order
      const eventTypes = events.map((e) => e.type);
      const creatingIdx = eventTypes.indexOf('sandbox:creating');
      const createdIdx = eventTypes.indexOf('sandbox:created');
      const startedIdx = eventTypes.indexOf('sandbox:started');
      expect(creatingIdx).toBeLessThan(createdIdx);
      expect(createdIdx).toBeLessThan(startedIdx);
    });

    it('IT-1452e: emits error event and throws on container creation failure', async () => {
      mockDocker.createContainer.mockRejectedValueOnce(new Error('Docker daemon not running'));

      const events: SandboxProviderEvent[] = [];
      provider.on((event) => events.push(event));

      await expect(
        provider.create({
          codespaceId: 'proj-fail-1',
          codespacePath: '/project',
          image: 'test-image',
          memoryMb: 4096,
          cpuCores: 2,
          idleTimeoutMinutes: 30,
          volumeMounts: [],
        })
      ).rejects.toThrow();

      const errorEvent = events.find((e) => e.type === 'sandbox:error');
      expect(errorEvent).toBeDefined();
    });

    it('IT-1452f: uses pre-assigned sandbox ID from config.id', async () => {
      const sandbox = await provider.create({
        id: 'my-custom-sandbox-id',
        codespaceId: 'proj-custom-id',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(sandbox.id).toBe('my-custom-sandbox-id');
    });

    it('IT-1452g: network mode defaults to bridge', async () => {
      await provider.create({
        codespaceId: 'proj-network-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.HostConfig.NetworkMode).toBe('bridge');
    });

    it('IT-1452h: throws when sandbox already exists for codespace', async () => {
      // First create succeeds
      await provider.create({
        codespaceId: 'proj-dup-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Second create for same codespace should throw
      await expect(
        provider.create({
          codespaceId: 'proj-dup-1',
          codespacePath: '/project',
          image: 'srlynch1/agent-sandbox:latest',
          memoryMb: 4096,
          cpuCores: 2,
          idleTimeoutMinutes: 30,
          volumeMounts: [],
        })
      ).rejects.toThrow();
    });
  });

  describe('recover (IT-1452)', () => {
    it('IT-1453a: re-registers running containers with agentpane- prefix', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'container-running-1',
          Names: ['/agentpane-proj1-abc12345'],
          State: 'running',
          ImageID: 'sha256:expected-image-id',
        },
      ]);

      const result = await provider.recover();

      expect(result.recovered).toBe(1);
      expect(result.removed).toBe(0);

      // Verify sandbox is accessible via codespace
      const sandbox = await provider.get('proj1');
      expect(sandbox).toBeDefined();
      expect(sandbox?.status).toBe('running');
    });

    it('IT-1453b: removes stopped containers during recovery', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'container-stopped-1',
          Names: ['/agentpane-proj2-def67890'],
          State: 'exited',
          ImageID: 'sha256:expected-image-id',
        },
      ]);

      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(1);
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('IT-1453c: removes containers with stale images', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'container-stale-1',
          Names: ['/agentpane-proj3-ghi12345'],
          State: 'running',
          ImageID: 'sha256:old-stale-image-id',
        },
      ]);

      const result = await provider.recover();

      expect(result.recovered).toBe(0);
      expect(result.removed).toBe(1);
      expect(mockContainer.stop).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('IT-1453d: skips containers already registered in codespace map', async () => {
      // First create a sandbox to register the codespace
      await provider.create({
        codespaceId: 'proj4',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'container-existing-1',
          Names: ['/agentpane-proj4-jkl12345'],
          State: 'running',
          ImageID: 'sha256:expected-image-id',
        },
      ]);

      const result = await provider.recover();

      expect(result.recovered).toBe(0);
    });
  });

  describe('validateContainers (IT-1453)', () => {
    it('IT-1454a: prunes stale entries where Docker container returns 404', async () => {
      // Create a sandbox first
      await provider.create({
        codespaceId: 'proj-validate-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Verify it's tracked
      let list = await provider.list();
      expect(list.length).toBe(1);

      // Make container.inspect return 404 to simulate deleted container
      mockContainer.inspect.mockRejectedValue({ statusCode: 404 });

      // Trigger validation
      await provider.validateContainers();

      // Should have pruned the stale entry
      list = await provider.list();
      expect(list.length).toBe(0);
    });
  });

  describe('Docker multiplexed stream parsing (IT-1454)', () => {
    // NOTE: The Docker multiplexed stream parsing logic is inline within DockerSandbox.exec()
    // and not independently exportable. These tests verify the parsing algorithm itself using
    // the same buffer format that Docker produces. If the inline parsing is ever extracted to
    // a utility, these tests should be updated to import and call it directly.

    it('IT-1455a: correctly parses stdout and stderr from 8-byte header frames', () => {
      // Test the multiplexed stream format parsing logic directly
      // Docker format: Byte 0=stream type (1=stdout, 2=stderr), Bytes 4-7=payload size (BE uint32)

      // Create a stdout frame: type=1, payload="Hello"
      const stdoutPayload = Buffer.from('Hello');
      const stdoutHeader = Buffer.alloc(8);
      stdoutHeader[0] = 1; // stdout
      stdoutHeader.writeUInt32BE(stdoutPayload.length, 4);
      const stdoutFrame = Buffer.concat([stdoutHeader, stdoutPayload]);

      // Create a stderr frame: type=2, payload="Error"
      const stderrPayload = Buffer.from('Error');
      const stderrHeader = Buffer.alloc(8);
      stderrHeader[0] = 2; // stderr
      stderrHeader.writeUInt32BE(stderrPayload.length, 4);
      const stderrFrame = Buffer.concat([stderrHeader, stderrPayload]);

      // Verify frame structure
      expect(stdoutFrame[0]).toBe(1);
      expect(stdoutFrame.readUInt32BE(4)).toBe(5);
      expect(stdoutFrame.subarray(8).toString()).toBe('Hello');

      expect(stderrFrame[0]).toBe(2);
      expect(stderrFrame.readUInt32BE(4)).toBe(5);
      expect(stderrFrame.subarray(8).toString()).toBe('Error');
    });

    it('IT-1455b: handles partial frames correctly (buffering)', () => {
      // Simulate receiving data in chunks - the parsing logic should buffer partial frames

      const payload = Buffer.from('Complete message');
      const header = Buffer.alloc(8);
      header[0] = 1; // stdout
      header.writeUInt32BE(payload.length, 4);
      const fullFrame = Buffer.concat([header, payload]);

      // Parse in a simulation of the Docker stream parsing algorithm
      let buffer = Buffer.alloc(0);
      let stdout = '';

      // First chunk: just the header (partial frame)
      const chunk1 = fullFrame.subarray(0, 8);
      buffer = Buffer.concat([buffer, chunk1]);

      // Try parsing - should not have enough data yet
      while (buffer.length >= 8) {
        const payloadSize = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadSize) {
          break; // Wait for more data
        }
        const data = buffer.subarray(8, 8 + payloadSize).toString();
        buffer = buffer.subarray(8 + payloadSize);
        stdout += data;
      }
      expect(stdout).toBe(''); // Not enough data yet

      // Second chunk: the payload
      const chunk2 = fullFrame.subarray(8);
      buffer = Buffer.concat([buffer, chunk2]);

      // Now parsing should succeed
      while (buffer.length >= 8) {
        const payloadSize = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadSize) {
          break;
        }
        const streamType = buffer[0];
        const data = buffer.subarray(8, 8 + payloadSize).toString();
        buffer = buffer.subarray(8 + payloadSize);
        if (streamType === 1) {
          stdout += data;
        }
      }
      expect(stdout).toBe('Complete message');
    });

    it('IT-1455c: handles multiple frames in a single chunk', () => {
      // Two stdout frames concatenated
      const msg1 = Buffer.from('First');
      const msg2 = Buffer.from('Second');

      const header1 = Buffer.alloc(8);
      header1[0] = 1;
      header1.writeUInt32BE(msg1.length, 4);

      const header2 = Buffer.alloc(8);
      header2[0] = 1;
      header2.writeUInt32BE(msg2.length, 4);

      const combined = Buffer.concat([header1, msg1, header2, msg2]);

      let buffer = Buffer.from(combined);
      let stdout = '';

      while (buffer.length >= 8) {
        const payloadSize = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadSize) {
          break;
        }
        const streamType = buffer[0];
        const data = buffer.subarray(8, 8 + payloadSize).toString();
        buffer = buffer.subarray(8 + payloadSize);
        if (streamType === 1) {
          stdout += data;
        }
      }

      expect(stdout).toBe('FirstSecond');
      expect(buffer.length).toBe(0); // All data consumed
    });
  });

  describe('cleanup (IT-1455)', () => {
    it('IT-1456a: stops and removes sandboxes matching status criteria', async () => {
      // Create a sandbox
      const sandbox = await provider.create({
        codespaceId: 'proj-cleanup-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Force sandbox status to running (it should already be)
      expect(sandbox.status).toBe('running');

      const cleaned = await provider.cleanup({ status: ['running'] });

      expect(cleaned).toBe(1);
    });

    it('IT-1456b: respects olderThan filter', async () => {
      // Create sandbox - it will have a recent lastActivity
      await provider.create({
        codespaceId: 'proj-cleanup-2',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Filter with future date should match, past date should not
      const cleaned = await provider.cleanup({
        status: ['running'],
        olderThan: new Date(Date.now() + 1000), // future date = all sandboxes are older
      });
      expect(cleaned).toBe(1);
    });
  });

  describe('healthCheck (IT-1456)', () => {
    it('IT-1457a: returns healthy with Docker server details', async () => {
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.serverVersion).toBe('24.0.0');
      expect(health.details?.containers).toBe(5);
      expect(health.details?.containersRunning).toBe(3);
    });

    it('IT-1457b: returns unhealthy when Docker ping fails', async () => {
      mockDocker.ping.mockRejectedValueOnce(new Error('Cannot connect to Docker daemon'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Docker health check failed');
    });
  });

  describe('list (IT-1457)', () => {
    it('IT-1458a: returns info for all tracked sandboxes', async () => {
      // Create two sandboxes for different codespaces
      await provider.create({
        codespaceId: 'proj-list-1',
        codespacePath: '/project1',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      await provider.create({
        codespaceId: 'proj-list-2',
        codespacePath: '/project2',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Reset the inspect mock to succeed (for validation)
      mockContainer.inspect.mockResolvedValue({
        State: { Running: true },
      });

      const infos = await provider.list();

      expect(infos.length).toBe(2);
      const codespaceIds = infos.map((i) => i.codespaceId);
      expect(codespaceIds).toContain('proj-list-1');
      expect(codespaceIds).toContain('proj-list-2');
    });
  });

  describe('get/getById (IT-1458)', () => {
    it('IT-1459a: get returns sandbox by codespace ID', async () => {
      await provider.create({
        codespaceId: 'proj-get-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const sandbox = await provider.get('proj-get-1');
      expect(sandbox).toBeDefined();
      expect(sandbox?.codespaceId).toBe('proj-get-1');
    });

    it('IT-1459b: get returns null for unknown codespace', async () => {
      const sandbox = await provider.get('nonexistent');
      expect(sandbox).toBeNull();
    });

    it('IT-1459c: getById returns sandbox by sandbox ID', async () => {
      const created = await provider.create({
        id: 'custom-sb-id',
        codespaceId: 'proj-getbyid-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const sandbox = await provider.getById(created.id);
      expect(sandbox).toBeDefined();
      expect(sandbox?.id).toBe('custom-sb-id');
    });
  });

  describe('event listener management (IT-1459)', () => {
    it('IT-1460a: on() adds listener and returns unsubscribe function', async () => {
      const events: SandboxProviderEvent[] = [];
      const unsub = provider.on((event) => events.push(event));

      await provider.create({
        codespaceId: 'proj-listener-1',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(events.length).toBeGreaterThan(0);

      // Unsubscribe
      unsub();

      // Reset events
      const countBefore = events.length;

      // Create another sandbox - should not add events
      await provider.create({
        codespaceId: 'proj-listener-2',
        codespacePath: '/project',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(events.length).toBe(countBefore);
    });
  });
});
