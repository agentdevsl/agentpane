import type { Container, Exec } from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderEvent,
} from '@/lib/sandbox/providers/sandbox-provider';
import type { SandboxConfig, TmuxSession } from '@/lib/sandbox/types';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock dockerode
const mockContainerExec = vi.fn();
const mockContainerStart = vi.fn();
const mockContainerStop = vi.fn();
const mockContainerStats = vi.fn();
const mockExecStart = vi.fn();
const mockExecInspect = vi.fn();

const mockContainer: Partial<Container> = {
  id: 'container-abc123',
  exec: mockContainerExec,
  start: mockContainerStart,
  stop: mockContainerStop,
  stats: mockContainerStats,
};

const mockDockerCreateContainer = vi.fn();
const mockDockerPull = vi.fn();
const mockDockerPing = vi.fn();
const mockDockerInfo = vi.fn();
const mockDockerGetImage = vi.fn();
const mockDockerModemFollowProgress = vi.fn();

vi.mock('dockerode', () => {
  const MockDocker = function (this: Record<string, unknown>) {
    this.createContainer = mockDockerCreateContainer;
    this.pull = mockDockerPull;
    this.ping = mockDockerPing;
    this.info = mockDockerInfo;
    this.getImage = mockDockerGetImage;
    this.modem = {
      followProgress: mockDockerModemFollowProgress,
    };
  } as unknown as new () => Record<string, unknown>;

  return {
    default: MockDocker,
  };
});

// Mock fs for credentials
const mockFsReadFile = vi.fn();
vi.mock('node:fs', () => ({
  promises: {
    readFile: mockFsReadFile,
  },
}));

// Mock os for home directory
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

// ============================================================================
// Helper Functions
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

const createMockExecStream = (
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
// DockerProvider Extended Tests
// ============================================================================

describe('DockerProvider - Extended Coverage', () => {
  let DockerProvider: typeof import('@/lib/sandbox/providers/docker-provider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockContainerStart.mockResolvedValue(undefined);
    mockContainerStop.mockResolvedValue(undefined);

    const module = await import('@/lib/sandbox/providers/docker-provider');
    DockerProvider = module.DockerProvider;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Container Exec - Edge Cases', () => {
    it('handles mixed stdout and stderr output', async () => {
      const mockExec = createMockExecStream([
        { type: 'stdout', data: 'output line 1\n' },
        { type: 'stderr', data: 'warning message\n' },
        { type: 'stdout', data: 'output line 2' },
      ]);

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const result = await sandbox.exec('some-command');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('output line 1');
      expect(result.stderr).toContain('warning message');
    });

    it('handles empty output', async () => {
      const mockStream = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          return mockStream;
        }),
      };

      const mockExec: Partial<Exec> = {
        start: mockExecStart.mockResolvedValue(mockStream),
        inspect: mockExecInspect.mockResolvedValue({ ExitCode: 0 }),
      };

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const result = await sandbox.exec('true');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('handles stream error', async () => {
      const streamError = new Error('Stream connection lost');
      const mockStream = {
        on: vi.fn((event: string, callback: (data?: Buffer | Error) => void) => {
          if (event === 'error') {
            setTimeout(() => callback(streamError), 0);
          }
          return mockStream;
        }),
      };

      const mockExec: Partial<Exec> = {
        start: mockExecStart.mockResolvedValue(mockStream),
        inspect: mockExecInspect,
      };

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.exec('failing-stream')).rejects.toThrow('Stream connection lost');
    });

    it('handles non-zero exit code', async () => {
      const mockExec = createMockExecStream([{ type: 'stderr', data: 'command not found' }], 127);

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const result = await sandbox.exec('nonexistent-command');

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('command not found');
    });

    it('handles null ExitCode from inspection', async () => {
      const mockStream = {
        on: vi.fn((event: string, callback: () => void) => {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          return mockStream;
        }),
      };

      const mockExec: Partial<Exec> = {
        start: mockExecStart.mockResolvedValue(mockStream),
        inspect: mockExecInspect.mockResolvedValue({ ExitCode: null }),
      };

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const result = await sandbox.exec('command');

      expect(result.exitCode).toBe(0);
    });

    it('handles large output with chunked data', async () => {
      // Simulate chunked data where frame boundary crosses chunk boundary
      const mockStream = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            // Send partial header first
            const header = Buffer.alloc(8);
            header[0] = 1; // stdout
            const payload = Buffer.from('Hello World');
            header.writeUInt32BE(payload.length, 4);

            // Send header and payload in chunks
            setTimeout(() => callback(header), 0);
            setTimeout(() => callback(payload), 5);
          }
          if (event === 'end') {
            setTimeout(() => callback(), 20);
          }
          return mockStream;
        }),
      };

      const mockExec: Partial<Exec> = {
        start: mockExecStart.mockResolvedValue(mockStream),
        inspect: mockExecInspect.mockResolvedValue({ ExitCode: 0 }),
      };

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const result = await sandbox.exec('echo', ['Hello World']);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('Tmux Session Operations - DockerSandbox', () => {
    it('creates tmux session successfully', async () => {
      const listExec = createMockExecStream([{ type: 'stdout', data: '' }]);
      const createExec = createMockExecStream([{ type: 'stdout', data: '' }]);

      mockContainerExec.mockResolvedValueOnce(listExec).mockResolvedValueOnce(createExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const session = await sandbox.createTmuxSession('test-session', 'task-123');

      expect(session.name).toBe('test-session');
      expect(session.sandboxId).toBe(sandbox.id);
      expect(session.taskId).toBe('task-123');
      expect(session.windowCount).toBe(1);
      expect(session.attached).toBe(false);
    });

    it('throws error when tmux session already exists', async () => {
      const listExec = createMockExecStream([
        { type: 'stdout', data: 'test-session\nother-session' },
      ]);

      mockContainerExec.mockResolvedValue(listExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.createTmuxSession('test-session')).rejects.toMatchObject({
        code: 'SANDBOX_TMUX_SESSION_EXISTS',
      });
    });

    it('throws error when tmux creation fails', async () => {
      const listExec = createMockExecStream([{ type: 'stdout', data: '' }]);
      const createExec = createMockExecStream(
        [{ type: 'stderr', data: 'tmux: error creating session' }],
        1
      );

      mockContainerExec.mockResolvedValueOnce(listExec).mockResolvedValueOnce(createExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.createTmuxSession('new-session')).rejects.toMatchObject({
        code: 'SANDBOX_TMUX_CREATION_FAILED',
      });
    });

    it('lists tmux sessions with parsed output', async () => {
      const listExec = createMockExecStream([
        { type: 'stdout', data: 'session1:2:0\nsession2:1:1\nsession3:3:0' },
      ]);

      mockContainerExec.mockResolvedValue(listExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const sessions = await sandbox.listTmuxSessions();

      expect(sessions).toHaveLength(3);
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

    it('returns empty array when no tmux server running', async () => {
      const listExec = createMockExecStream([{ type: 'stderr', data: 'no server running' }], 1);

      mockContainerExec.mockResolvedValue(listExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const sessions = await sandbox.listTmuxSessions();

      expect(sessions).toEqual([]);
    });

    it('returns empty array when no sessions exist', async () => {
      const listExec = createMockExecStream([{ type: 'stderr', data: 'no sessions' }], 1);

      mockContainerExec.mockResolvedValue(listExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const sessions = await sandbox.listTmuxSessions();

      expect(sessions).toEqual([]);
    });

    it('throws error for unexpected tmux list error', async () => {
      const listExec = createMockExecStream([{ type: 'stderr', data: 'unexpected error' }], 1);

      mockContainerExec.mockResolvedValue(listExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.listTmuxSessions()).rejects.toMatchObject({
        code: 'SANDBOX_EXEC_FAILED',
      });
    });

    it('kills tmux session successfully', async () => {
      const killExec = createMockExecStream([{ type: 'stdout', data: '' }]);

      mockContainerExec.mockResolvedValue(killExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.killTmuxSession('test-session')).resolves.toBeUndefined();
    });

    it('ignores session not found error when killing', async () => {
      const killExec = createMockExecStream(
        [{ type: 'stderr', data: 'session not found: test-session' }],
        1
      );

      mockContainerExec.mockResolvedValue(killExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      // Should not throw for session not found
      await expect(sandbox.killTmuxSession('test-session')).resolves.toBeUndefined();
    });

    it('throws for other tmux kill errors', async () => {
      const killExec = createMockExecStream([{ type: 'stderr', data: 'permission denied' }], 1);

      mockContainerExec.mockResolvedValue(killExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.killTmuxSession('test-session')).rejects.toMatchObject({
        code: 'SANDBOX_TMUX_SESSION_NOT_FOUND',
      });
    });

    it('sends keys to tmux session', async () => {
      const sendExec = createMockExecStream([{ type: 'stdout', data: '' }]);

      mockContainerExec.mockResolvedValue(sendExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.sendKeysToTmux('test-session', 'ls -la')).resolves.toBeUndefined();
      expect(mockContainerExec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['tmux', 'send-keys', '-t', 'test-session', 'ls -la', 'Enter'],
        })
      );
    });

    it('throws error when send keys fails', async () => {
      const sendExec = createMockExecStream([{ type: 'stderr', data: "can't find session" }], 1);

      mockContainerExec.mockResolvedValue(sendExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.sendKeysToTmux('nonexistent', 'command')).rejects.toMatchObject({
        code: 'SANDBOX_EXEC_FAILED',
      });
    });

    it('captures tmux pane output', async () => {
      const captureExec = createMockExecStream([
        { type: 'stdout', data: 'line 1\nline 2\nline 3' },
      ]);

      mockContainerExec.mockResolvedValue(captureExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const output = await sandbox.captureTmuxPane('test-session', 50);

      expect(output).toContain('line 1');
      expect(mockContainerExec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['tmux', 'capture-pane', '-t', 'test-session', '-p', '-S', '-50'],
        })
      );
    });

    it('throws error when capture pane fails', async () => {
      const captureExec = createMockExecStream([{ type: 'stderr', data: 'session not found' }], 1);

      mockContainerExec.mockResolvedValue(captureExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await expect(sandbox.captureTmuxPane('nonexistent')).rejects.toMatchObject({
        code: 'SANDBOX_EXEC_FAILED',
      });
    });
  });

  describe('Container Metrics', () => {
    it('calculates CPU and memory metrics', async () => {
      mockContainerStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 200000000 },
          system_cpu_usage: 2000000000,
          online_cpus: 4,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100000000 },
          system_cpu_usage: 1000000000,
        },
        memory_stats: {
          usage: 512 * 1024 * 1024,
          limit: 4096 * 1024 * 1024,
        },
        networks: {
          eth0: {
            rx_bytes: 1024,
            tx_bytes: 2048,
          },
        },
      });
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const metrics = await sandbox.getMetrics();

      expect(metrics.cpuUsagePercent).toBeGreaterThanOrEqual(0);
      expect(metrics.memoryUsageMb).toBe(512);
      expect(metrics.memoryLimitMb).toBe(4096);
      expect(metrics.networkRxBytes).toBe(1024);
      expect(metrics.networkTxBytes).toBe(2048);
    });

    it('handles missing cpu stats gracefully', async () => {
      mockContainerStats.mockResolvedValue({
        cpu_stats: {},
        precpu_stats: {},
        memory_stats: {},
      });
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const metrics = await sandbox.getMetrics();

      expect(metrics.cpuUsagePercent).toBe(0);
      expect(metrics.memoryUsageMb).toBe(0);
    });

    it('handles missing network stats gracefully', async () => {
      mockContainerStats.mockResolvedValue({
        cpu_stats: { online_cpus: 1 },
        precpu_stats: {},
        memory_stats: {},
        networks: {},
      });
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      const metrics = await sandbox.getMetrics();

      expect(metrics.networkRxBytes).toBe(0);
      expect(metrics.networkTxBytes).toBe(0);
    });
  });

  describe('Image Pull Operations', () => {
    it('pulls image successfully', async () => {
      const mockPullStream = { on: vi.fn() };
      mockDockerPull.mockImplementation(
        (_image: string, cb: (err: Error | null, stream: unknown) => void) => {
          cb(null, mockPullStream);
        }
      );
      mockDockerModemFollowProgress.mockImplementation(
        (_stream: unknown, cb: (err: Error | null) => void) => {
          cb(null);
        }
      );

      const provider = new DockerProvider();
      await expect(provider.pullImage('test:latest')).resolves.toBeUndefined();
    });

    it('handles pull stream error', async () => {
      mockDockerPull.mockImplementation(
        (_image: string, cb: (err: Error | null, stream: unknown) => void) => {
          cb(new Error('Network error'), null);
        }
      );

      const provider = new DockerProvider();
      await expect(provider.pullImage('test:latest')).rejects.toMatchObject({
        code: 'SANDBOX_IMAGE_PULL_FAILED',
      });
    });

    it('handles pull progress error', async () => {
      const mockPullStream = { on: vi.fn() };
      mockDockerPull.mockImplementation(
        (_image: string, cb: (err: Error | null, stream: unknown) => void) => {
          cb(null, mockPullStream);
        }
      );
      mockDockerModemFollowProgress.mockImplementation(
        (_stream: unknown, cb: (err: Error | null) => void) => {
          cb(new Error('Download interrupted'));
        }
      );

      const provider = new DockerProvider();
      await expect(provider.pullImage('test:latest')).rejects.toMatchObject({
        code: 'SANDBOX_IMAGE_PULL_FAILED',
      });
    });
  });

  describe('Image Availability Check', () => {
    it('returns true for available image', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:abc' }),
      });

      const provider = new DockerProvider();
      const available = await provider.isImageAvailable('test:latest');

      expect(available).toBe(true);
    });

    it('returns false for 404 not found', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      });

      const provider = new DockerProvider();
      const available = await provider.isImageAvailable('missing:latest');

      expect(available).toBe(false);
    });

    it('throws for other errors', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 500, message: 'Docker daemon error' }),
      });

      const provider = new DockerProvider();
      await expect(provider.isImageAvailable('test:latest')).rejects.toMatchObject({
        statusCode: 500,
      });
    });
  });

  describe('Container Cleanup - Extended', () => {
    it('cleans up multiple stopped containers', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();

      // Create and stop first container
      const sandbox1 = await provider.create(createSandboxConfig({ codespaceId: 'project-1' }));
      await sandbox1.stop();

      // Create and stop second container
      const sandbox2 = await provider.create(createSandboxConfig({ codespaceId: 'project-2' }));
      await sandbox2.stop();

      const cleaned = await provider.cleanup({ status: ['stopped'] });

      expect(cleaned).toBe(2);
    });

    it('stops running containers during cleanup', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // Cleanup with running status should stop and clean
      const cleaned = await provider.cleanup({ status: ['running'] });

      expect(cleaned).toBe(1);
      expect(mockContainerStop).toHaveBeenCalled();
    });

    it('handles cleanup errors gracefully', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerStop.mockRejectedValueOnce(new Error('Container not responding'));

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // Should not throw, but log error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cleaned = await provider.cleanup({ status: ['running'] });

      expect(cleaned).toBe(0);
      consoleSpy.mockRestore();
    });
  });

  describe('Event Listener Management', () => {
    it('removes listener with returned function', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];
      const unsubscribe = provider.on((event) => events.push(event));

      await provider.create(createSandboxConfig());
      const countBefore = events.length;

      unsubscribe();

      // Create another sandbox - events should not be captured
      await provider.create(createSandboxConfig({ codespaceId: 'project-2' }));

      expect(events.length).toBe(countBefore);
    });

    it('removes listener with off method', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];
      const listener = (event: SandboxProviderEvent) => events.push(event);

      provider.on(listener);
      await provider.create(createSandboxConfig());
      const countBefore = events.length;

      provider.off(listener);

      await provider.create(createSandboxConfig({ codespaceId: 'project-2' }));

      expect(events.length).toBe(countBefore);
    });

    it('handles listener errors gracefully', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      provider.on(() => {
        throw new Error('Listener error');
      });

      // Should not throw despite listener error
      await expect(provider.create(createSandboxConfig())).resolves.toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe('Touch and Activity Tracking', () => {
    it('updates last activity on touch', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      const before = sandbox.getLastActivity();
      await new Promise((resolve) => setTimeout(resolve, 10));
      sandbox.touch();
      const after = sandbox.getLastActivity();

      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe('Sandbox Get and List', () => {
    it('gets sandbox by project ID', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      const sandbox = await provider.get('project-123');

      expect(sandbox).not.toBeNull();
      expect(sandbox?.codespaceId).toBe('project-123');
    });

    it('returns null for unknown project ID', async () => {
      const provider = new DockerProvider();
      const sandbox = await provider.get('unknown');

      expect(sandbox).toBeNull();
    });

    it('gets sandbox by sandbox ID', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const created = await provider.create(createSandboxConfig());
      const sandbox = await provider.getById(created.id);

      expect(sandbox).toBe(created);
    });

    it('returns null for unknown sandbox ID', async () => {
      const provider = new DockerProvider();
      const sandbox = await provider.getById('unknown-id');

      expect(sandbox).toBeNull();
    });

    it('lists all sandboxes', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig({ codespaceId: 'project-1' }));
      await provider.create(createSandboxConfig({ codespaceId: 'project-2' }));

      const list = await provider.list();

      expect(list).toHaveLength(2);
      expect(list[0].codespaceId).toBe('project-1');
      expect(list[1].codespaceId).toBe('project-2');
    });
  });
});

// ============================================================================
// TmuxManager Extended Tests
// ============================================================================

describe('TmuxManager - Extended Coverage', () => {
  let TmuxManager: typeof import('@/lib/sandbox/tmux-manager').TmuxManager;
  let mockProvider: SandboxProvider;
  let mockSandbox: Sandbox;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockSandbox = {
      id: 'sandbox-123',
      codespaceId: 'project-123',
      containerId: 'container-abc',
      status: 'running',
      exec: vi.fn(),
      execAsRoot: vi.fn(),
      createTmuxSession: vi.fn(),
      listTmuxSessions: vi.fn(),
      killTmuxSession: vi.fn(),
      sendKeysToTmux: vi.fn(),
      captureTmuxPane: vi.fn(),
      stop: vi.fn(),
      getMetrics: vi.fn(),
      touch: vi.fn(),
      getLastActivity: vi.fn().mockReturnValue(new Date()),
    };

    mockProvider = {
      name: 'mock',
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(mockSandbox),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      list: vi.fn(),
      pullImage: vi.fn(),
      isImageAvailable: vi.fn(),
      healthCheck: vi.fn(),
      cleanup: vi.fn(),
    };

    const module = await import('@/lib/sandbox/tmux-manager');
    TmuxManager = module.TmuxManager;
  });

  describe('Session Creation - Edge Cases', () => {
    it('creates session using codespaceId lookup', async () => {
      const mockSession: TmuxSession = {
        name: 'agent-task-1',
        sandboxId: 'sandbox-123',
        taskId: 'task-1',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({
        codespaceId: 'project-123',
        taskId: 'task-1',
      });

      expect(result.ok).toBe(true);
      expect(mockProvider.get).toHaveBeenCalledWith('project-123');
    });

    it('creates session with working directory', async () => {
      const mockSession: TmuxSession = {
        name: 'agent-task-1',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({
        sandboxId: 'sandbox-123',
        workingDirectory: '/workspace/src',
      });

      expect(mockSandbox.sendKeysToTmux).toHaveBeenCalledWith(
        expect.any(String),
        'cd /workspace/src'
      );
    });

    it('handles error with code property during creation', async () => {
      const errorWithCode = { code: 'SANDBOX_TMUX_SESSION_EXISTS', message: 'Session exists' };
      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockRejectedValue(errorWithCode);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({
        sandboxId: 'sandbox-123',
        sessionName: 'existing-session',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_TMUX_SESSION_EXISTS');
      }
    });

    it('handles generic error during creation', async () => {
      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Generic error')
      );

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({
        sandboxId: 'sandbox-123',
        sessionName: 'new-session',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_TMUX_CREATION_FAILED');
      }
    });

    it('handles non-Error thrown value', async () => {
      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockRejectedValue('String error');

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({
        sandboxId: 'sandbox-123',
        sessionName: 'new-session',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('String error');
      }
    });
  });

  describe('Session Get - Edge Cases', () => {
    it('returns session from tracked sessions', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockResolvedValue([mockSession]);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.getSession('test-session');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.name).toBe('test-session');
      }
    });

    it('returns null for untracked session', async () => {
      const manager = new TmuxManager(mockProvider);
      const result = await manager.getSession('nonexistent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('cleans up and returns null when sandbox no longer exists', async () => {
      const mockSession: TmuxSession = {
        name: 'orphan-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'orphan-session' });

      // Sandbox no longer exists
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await manager.getSession('orphan-session');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns error when listing sessions fails', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('List failed')
      );

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.getSession('test-session');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });

    it('returns null when session no longer exists in sandbox', async () => {
      const mockSession: TmuxSession = {
        name: 'killed-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]); // Session was killed

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'killed-session' });

      const result = await manager.getSession('killed-session');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('List Sessions - Edge Cases', () => {
    it('returns error when listing fails', async () => {
      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection lost')
      );

      const manager = new TmuxManager(mockProvider);
      const result = await manager.listSessions('sandbox-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });
  });

  describe('Send Command - Edge Cases', () => {
    it('cleans up and returns error when sandbox deleted', async () => {
      const mockSession: TmuxSession = {
        name: 'orphan-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'orphan-session' });

      // Sandbox deleted
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await manager.sendCommand('orphan-session', 'command');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });

    it('handles error with code property', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      const errorWithCode = { code: 'SANDBOX_EXEC_FAILED', message: 'Exec error' };
      (mockSandbox.sendKeysToTmux as ReturnType<typeof vi.fn>).mockRejectedValue(errorWithCode);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.sendCommand('test-session', 'command');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });

    it('handles generic error', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.sendKeysToTmux as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      );

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.sendCommand('test-session', 'command');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });
  });

  describe('Capture Output - Edge Cases', () => {
    it('cleans up and returns error when sandbox deleted', async () => {
      const mockSession: TmuxSession = {
        name: 'orphan-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'orphan-session' });

      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await manager.captureOutput('orphan-session');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });

    it('handles error with code property', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      const errorWithCode = { code: 'SANDBOX_EXEC_FAILED', message: 'Capture error' };
      (mockSandbox.captureTmuxPane as ReturnType<typeof vi.fn>).mockRejectedValue(errorWithCode);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.captureOutput('test-session');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });
  });

  describe('Kill Session - Edge Cases', () => {
    it('returns ok for untracked session', async () => {
      const manager = new TmuxManager(mockProvider);
      const result = await manager.killSession('untracked');

      expect(result.ok).toBe(true);
    });

    it('cleans up when sandbox no longer exists', async () => {
      const mockSession: TmuxSession = {
        name: 'orphan-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'orphan-session' });

      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await manager.killSession('orphan-session');

      expect(result.ok).toBe(true);
    });

    it('ignores "can\'t find session" error', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.killTmuxSession as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("can't find session: test-session")
      );

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.killSession('test-session');

      expect(result.ok).toBe(true);
    });

    it('returns error for other kill failures', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.killTmuxSession as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Permission denied')
      );

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.killSession('test-session');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });
  });

  describe('Kill All Sessions - Edge Cases', () => {
    it('returns error when listing fails', async () => {
      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('List error')
      );

      const manager = new TmuxManager(mockProvider);
      const result = await manager.killAllSessions('sandbox-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });

    it('continues killing sessions despite individual errors', async () => {
      const sessions: TmuxSession[] = [
        {
          name: 'session-1',
          sandboxId: 'sandbox-123',
          createdAt: new Date().toISOString(),
          windowCount: 1,
          attached: false,
        },
        {
          name: 'session-2',
          sandboxId: 'sandbox-123',
          createdAt: new Date().toISOString(),
          windowCount: 1,
          attached: false,
        },
        {
          name: 'session-3',
          sandboxId: 'sandbox-123',
          createdAt: new Date().toISOString(),
          windowCount: 1,
          attached: false,
        },
      ];

      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions);
      (mockSandbox.killTmuxSession as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Kill failed'))
        .mockResolvedValueOnce(undefined);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manager = new TmuxManager(mockProvider);
      const result = await manager.killAllSessions('sandbox-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2); // 2 succeeded, 1 failed
      }

      consoleSpy.mockRestore();
    });
  });

  describe('Static Methods', () => {
    it('creates session name from task ID', () => {
      const name = TmuxManager.createSessionName('task-abc-123');
      expect(name).toBe('agent-task-abc-123');
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe('Factory Functions', () => {
  it('creates DockerProvider with options', async () => {
    const { createDockerProvider } = await import('@/lib/sandbox/providers/docker-provider');

    const provider = createDockerProvider({ socketPath: '/var/run/docker.sock' });

    expect(provider.name).toBe('docker');
  });

  it('creates TmuxManager with provider', async () => {
    const { createTmuxManager } = await import('@/lib/sandbox/tmux-manager');

    const mockProvider: SandboxProvider = {
      name: 'test',
      create: vi.fn(),
      get: vi.fn(),
      getById: vi.fn(),
      list: vi.fn(),
      pullImage: vi.fn(),
      isImageAvailable: vi.fn(),
      healthCheck: vi.fn(),
      cleanup: vi.fn(),
    };

    const manager = createTmuxManager(mockProvider);

    expect(manager).toBeInstanceOf((await import('@/lib/sandbox/tmux-manager')).TmuxManager);
  });
});
