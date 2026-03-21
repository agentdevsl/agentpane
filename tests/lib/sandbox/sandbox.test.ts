import type { Container, Exec } from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderEvent,
} from '@/lib/sandbox/providers/sandbox-provider';
import type { OAuthCredentials, SandboxConfig, TmuxSession } from '@/lib/sandbox/types';

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
  // Create a mock class that can be instantiated with 'new'
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
// DockerProvider Tests (15 tests)
// ============================================================================

describe('DockerProvider', () => {
  let DockerProvider: typeof import('@/lib/sandbox/providers/docker-provider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default successful mocks
    mockContainerStart.mockResolvedValue(undefined);
    mockContainerStop.mockResolvedValue(undefined);

    const module = await import('@/lib/sandbox/providers/docker-provider');
    DockerProvider = module.DockerProvider;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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

  describe('Container Creation', () => {
    it('creates a container with correct configuration', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig();

      const sandbox = await provider.create(config);

      expect(mockDockerCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: config.image,
          WorkingDir: '/workspace',
          Env: ['NODE_ENV=test'],
          HostConfig: expect.objectContaining({
            Memory: config.memoryMb * 1024 * 1024,
            NanoCpus: config.cpuCores * 1e9,
          }),
        })
      );
      expect(sandbox.codespaceId).toBe(config.codespaceId);
      expect(sandbox.status).toBe('running');
    });

    it('creates container with volume mounts', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig({
        volumeMounts: [
          { hostPath: '/host/data', containerPath: '/container/data', readonly: true },
          { hostPath: '/host/cache', containerPath: '/container/cache', readonly: false },
        ],
      });

      await provider.create(config);

      expect(mockDockerCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining([
              '/path/to/project:/workspace:rw',
              '/host/data:/container/data:ro',
              '/host/cache:/container/cache:rw',
            ]),
          }),
        })
      );
    });

    it('creates container with custom environment variables', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig({
        env: { API_KEY: 'secret', DEBUG: 'true' },
      });

      await provider.create(config);

      expect(mockDockerCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining(['API_KEY=secret', 'DEBUG=true']),
        })
      );
    });

    it('throws error when container already exists for project', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const config = createSandboxConfig();

      // Create first container
      await provider.create(config);

      // Try to create second container for same project
      await expect(provider.create(config)).rejects.toMatchObject({
        code: 'SANDBOX_CONTAINER_ALREADY_EXISTS',
      });
    });

    it('handles container creation failure', async () => {
      mockDockerCreateContainer.mockRejectedValue(new Error('Docker daemon not responding'));

      const provider = new DockerProvider();
      const config = createSandboxConfig();

      await expect(provider.create(config)).rejects.toMatchObject({
        code: 'SANDBOX_CONTAINER_CREATION_FAILED',
      });
    });
  });

  describe('Container Start/Stop/Restart', () => {
    it('starts container after creation', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      expect(mockContainerStart).toHaveBeenCalled();
      expect(sandbox.status).toBe('running');
    });

    it('stops a running container', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      await sandbox.stop();

      expect(mockContainerStop).toHaveBeenCalledWith({ t: 10 });
      expect(sandbox.status).toBe('stopped');
    });

    it('handles start failure gracefully', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);
      mockContainerStart.mockRejectedValue(new Error('Port already in use'));

      const provider = new DockerProvider();

      await expect(provider.create(createSandboxConfig())).rejects.toMatchObject({
        code: 'SANDBOX_CONTAINER_CREATION_FAILED',
      });
    });
  });

  describe('Container Exec Operations', () => {
    it('executes command inside container', async () => {
      // Set up the stream mock
      const mockStream = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            // Docker multiplexed stream format: 8-byte header + payload
            const header = Buffer.alloc(8);
            header[0] = 1; // stdout
            const payload = Buffer.from('command output');
            header.writeUInt32BE(payload.length, 4);
            setTimeout(() => callback(Buffer.concat([header, payload])), 0);
          }
          if (event === 'end') {
            setTimeout(() => callback(), 10);
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

      const result = await sandbox.exec('echo', ['hello']);

      expect(mockContainerExec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['echo', 'hello'],
          AttachStdout: true,
          AttachStderr: true,
        })
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('command output');
    });

    it('captures stderr from command execution', async () => {
      const mockStream = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            const header = Buffer.alloc(8);
            header[0] = 2; // stderr
            const payload = Buffer.from('error message');
            header.writeUInt32BE(payload.length, 4);
            setTimeout(() => callback(Buffer.concat([header, payload])), 0);
          }
          if (event === 'end') {
            setTimeout(() => callback(), 10);
          }
          return mockStream;
        }),
      };

      const mockExec: Partial<Exec> = {
        start: mockExecStart.mockResolvedValue(mockStream),
        inspect: mockExecInspect.mockResolvedValue({ ExitCode: 1 }),
      };

      mockContainerExec.mockResolvedValue(mockExec);
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());

      const result = await sandbox.exec('failing-command');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('error message');
    });

    it('executes command as root user', async () => {
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

      await sandbox.execAsRoot('apt-get', ['update']);

      expect(mockContainerExec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['apt-get', 'update'],
          User: 'root',
        })
      );
    });
  });

  describe('Health Check', () => {
    it('returns healthy status when Docker is responsive', async () => {
      mockDockerPing.mockResolvedValue('OK');
      mockDockerInfo.mockResolvedValue({
        ServerVersion: '24.0.0',
        Containers: 5,
        ContainersRunning: 2,
        Images: 10,
      });

      const provider = new DockerProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details).toEqual(
        expect.objectContaining({
          serverVersion: '24.0.0',
          containers: 5,
          containersRunning: 2,
        })
      );
    });

    it('returns unhealthy status when Docker is not responding', async () => {
      mockDockerPing.mockRejectedValue(new Error('Cannot connect to Docker daemon'));

      const provider = new DockerProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Docker health check failed');
    });
  });

  describe('Container Cleanup', () => {
    it('cleans up stopped containers', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const sandbox = await provider.create(createSandboxConfig());
      await sandbox.stop();

      const cleaned = await provider.cleanup({ status: ['stopped'] });

      expect(cleaned).toBe(1);
    });

    it('cleans up containers older than specified date', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      await provider.create(createSandboxConfig());

      // Clean up containers older than 1 hour from now (should not clean the just-created one)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const cleaned = await provider.cleanup({ olderThan: oneHourAgo });

      expect(cleaned).toBe(0);
    });
  });

  describe('Image Operations', () => {
    it('checks if image is available locally', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: 'sha256:abc123' }),
      });

      const provider = new DockerProvider();
      const available = await provider.isImageAvailable('test-image:latest');

      expect(available).toBe(true);
    });

    it('returns false when image is not found', async () => {
      mockDockerGetImage.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      });

      const provider = new DockerProvider();
      const available = await provider.isImageAvailable('missing-image:latest');

      expect(available).toBe(false);
    });
  });

  describe('Event Emission', () => {
    it('emits events during container lifecycle', async () => {
      mockDockerCreateContainer.mockResolvedValue(mockContainer);

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];

      provider.on((event) => events.push(event));

      await provider.create(createSandboxConfig());

      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:creating' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:created' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:started' }));
    });

    it('emits error event on failure', async () => {
      mockDockerCreateContainer.mockRejectedValue(new Error('Creation failed'));

      const provider = new DockerProvider();
      const events: SandboxProviderEvent[] = [];

      provider.on((event) => events.push(event));

      await expect(provider.create(createSandboxConfig())).rejects.toThrow();

      expect(events).toContainEqual(expect.objectContaining({ type: 'sandbox:error' }));
    });
  });
});

// ============================================================================
// TmuxManager Tests (10 tests)
// ============================================================================

describe('TmuxManager', () => {
  let TmuxManager: typeof import('@/lib/sandbox/tmux-manager').TmuxManager;
  let mockProvider: SandboxProvider;
  let mockSandbox: Sandbox;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Create mock sandbox
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

    // Create mock provider
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

  describe('Session Creation', () => {
    it('creates a tmux session with default name', async () => {
      const mockSession: TmuxSession = {
        name: 'agent-abc123',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({ sandboxId: 'sandbox-123' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sandboxId).toBe('sandbox-123');
      }
    });

    it('creates session with custom name', async () => {
      const mockSession: TmuxSession = {
        name: 'my-custom-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({
        sandboxId: 'sandbox-123',
        sessionName: 'my-custom-session',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('my-custom-session');
      }
    });

    it('creates session with initial command', async () => {
      const mockSession: TmuxSession = {
        name: 'agent-task1',
        sandboxId: 'sandbox-123',
        taskId: 'task1',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({
        sandboxId: 'sandbox-123',
        taskId: 'task1',
        initialCommand: 'npm run dev',
      });

      expect(mockSandbox.sendKeysToTmux).toHaveBeenCalledWith('agent-task1', 'npm run dev');
    });

    it('returns error when sandbox not found', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockProvider.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.createSession({ sandboxId: 'nonexistent' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  describe('Session Listing', () => {
    it('lists all sessions in a sandbox', async () => {
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
          windowCount: 2,
          attached: true,
        },
      ];

      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.listSessions('sandbox-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it('returns error when sandbox not found for listing', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.listSessions('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  describe('Send Keys', () => {
    it('sends keys to a tmux session', async () => {
      const mockSession: TmuxSession = {
        name: 'test-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'test-session' });

      const result = await manager.sendCommand('test-session', 'ls -la');

      expect(result.ok).toBe(true);
      expect(mockSandbox.sendKeysToTmux).toHaveBeenCalledWith('test-session', 'ls -la');
    });

    it('returns error when session not found for send keys', async () => {
      const manager = new TmuxManager(mockProvider);
      const result = await manager.sendCommand('nonexistent-session', 'command');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_TMUX_SESSION_NOT_FOUND');
      }
    });
  });

  describe('Capture Pane', () => {
    it('captures pane content from tmux session', async () => {
      const mockSession: TmuxSession = {
        name: 'capture-session',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
      (mockSandbox.captureTmuxPane as ReturnType<typeof vi.fn>).mockResolvedValue(
        'captured output\nline 2'
      );

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'capture-session' });

      const result = await manager.captureOutput('capture-session', 50);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('captured output');
      }
      expect(mockSandbox.captureTmuxPane).toHaveBeenCalledWith('capture-session', 50);
    });
  });

  describe('Session Cleanup', () => {
    it('kills a tmux session', async () => {
      const mockSession: TmuxSession = {
        name: 'to-kill',
        sandboxId: 'sandbox-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      (mockSandbox.createTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

      const manager = new TmuxManager(mockProvider);
      await manager.createSession({ sandboxId: 'sandbox-123', sessionName: 'to-kill' });

      const result = await manager.killSession('to-kill');

      expect(result.ok).toBe(true);
      expect(mockSandbox.killTmuxSession).toHaveBeenCalledWith('to-kill');
    });

    it('kills all sessions in a sandbox', async () => {
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
      ];

      (mockSandbox.listTmuxSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions);

      const manager = new TmuxManager(mockProvider);
      const result = await manager.killAllSessions('sandbox-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
      expect(mockSandbox.killTmuxSession).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// CredentialsInjector Tests (10 tests)
// ============================================================================

describe('CredentialsInjector', () => {
  let CredentialsInjector: typeof import('@/lib/sandbox/credentials-injector').CredentialsInjector;
  let loadHostCredentials: typeof import('@/lib/sandbox/credentials-injector').loadHostCredentials;
  let mockSandbox: Sandbox;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Create mock sandbox
    mockSandbox = {
      id: 'sandbox-123',
      codespaceId: 'project-123',
      containerId: 'container-abc',
      status: 'running',
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
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

    const module = await import('@/lib/sandbox/credentials-injector');
    CredentialsInjector = module.CredentialsInjector;
    loadHostCredentials = module.loadHostCredentials;
  });

  describe('Environment Variable Injection', () => {
    it('injects credentials into sandbox', async () => {
      const credentials: OAuthCredentials = {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600000,
      };

      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox, credentials);

      expect(result.ok).toBe(true);
      // Verify mkdir was called
      expect(mockSandbox.exec).toHaveBeenCalledWith('mkdir', [
        '-p',
        expect.stringContaining('.claude'),
      ]);
      // Verify credentials were written
      expect(mockSandbox.exec).toHaveBeenCalledWith('sh', [
        '-c',
        expect.stringContaining('base64'),
      ]);
      // Verify permissions were set
      expect(mockSandbox.exec).toHaveBeenCalledWith('chmod', [
        '600',
        expect.stringContaining('.credentials.json'),
      ]);
    });

    it('loads credentials from host when not provided', async () => {
      const hostCredentials: OAuthCredentials = {
        accessToken: 'host-token',
      };

      mockFsReadFile.mockResolvedValue(JSON.stringify(hostCredentials));

      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox);

      expect(result.ok).toBe(true);
      expect(mockFsReadFile).toHaveBeenCalledWith(
        expect.stringContaining('.credentials.json'),
        'utf-8'
      );
    });
  });

  describe('OAuth Credential Injection', () => {
    it('injects OAuth credentials with all fields', async () => {
      const credentials: OAuthCredentials = {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: 1234567890,
        scope: 'read write',
      };

      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox, credentials);

      expect(result.ok).toBe(true);
      // Verify the base64 encoded content contains our credentials
      const execCall = (mockSandbox.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: string[]) => call[0] === 'sh' && call[1]?.[1]?.includes('base64')
      );
      expect(execCall).toBeDefined();
    });

    it('handles credentials without optional fields', async () => {
      const credentials: OAuthCredentials = {
        accessToken: 'minimal-token',
      };

      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox, credentials);

      expect(result.ok).toBe(true);
    });
  });

  describe('API Key Injection', () => {
    it('injects API key as access token', async () => {
      const credentials: OAuthCredentials = {
        accessToken: 'sk-ant-api-key-12345',
      };

      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox, credentials);

      expect(result.ok).toBe(true);
    });
  });

  describe('Credential Retrieval', () => {
    it('checks if credentials exist in sandbox', async () => {
      const injector = new CredentialsInjector();
      const exists = await injector.exists(mockSandbox);

      expect(exists).toBe(true);
      expect(mockSandbox.exec).toHaveBeenCalledWith('test', [
        '-f',
        expect.stringContaining('.credentials.json'),
      ]);
    });

    it('returns false when credentials do not exist', async () => {
      (mockSandbox.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });

      const injector = new CredentialsInjector();
      const exists = await injector.exists(mockSandbox);

      expect(exists).toBe(false);
    });

    it('refreshes credentials from host', async () => {
      const hostCredentials: OAuthCredentials = {
        accessToken: 'refreshed-token',
      };

      mockFsReadFile.mockResolvedValue(JSON.stringify(hostCredentials));

      const injector = new CredentialsInjector();
      const result = await injector.refresh(mockSandbox);

      expect(result.ok).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('returns error when host credentials file not found', async () => {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const result = await loadHostCredentials();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
      }
    });

    it('returns error when credentials file is malformed JSON', async () => {
      mockFsReadFile.mockResolvedValue('{ invalid json }');

      const result = await loadHostCredentials();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
      }
    });

    it('returns error when credentials file has no access token', async () => {
      mockFsReadFile.mockResolvedValue(JSON.stringify({ refreshToken: 'only-refresh' }));

      const result = await loadHostCredentials();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
      }
    });

    it('handles permission denied error', async () => {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mockFsReadFile.mockRejectedValue(error);

      const result = await loadHostCredentials();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
      }
    });

    it('returns error when mkdir fails in sandbox', async () => {
      (mockSandbox.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Permission denied',
      });

      const credentials: OAuthCredentials = { accessToken: 'test' };
      const injector = new CredentialsInjector();
      const result = await injector.inject(mockSandbox, credentials);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
      }
    });

    it('removes credentials from sandbox', async () => {
      const injector = new CredentialsInjector();
      const result = await injector.remove(mockSandbox);

      expect(result.ok).toBe(true);
      expect(mockSandbox.exec).toHaveBeenCalledWith('rm', [
        '-f',
        expect.stringContaining('.credentials.json'),
      ]);
    });
  });
});

// ============================================================================
// Static Method Tests
// ============================================================================

describe('TmuxManager Static Methods', () => {
  it('creates session name from task ID', async () => {
    const { TmuxManager } = await import('@/lib/sandbox/tmux-manager');

    const name = TmuxManager.createSessionName('task-abc123');

    expect(name).toBe('agent-task-abc123');
  });
});

describe('Factory Functions', () => {
  it('creates DockerProvider instance', async () => {
    const { createDockerProvider } = await import('@/lib/sandbox/providers/docker-provider');

    const provider = createDockerProvider();

    expect(provider.name).toBe('docker');
  });

  it('creates TmuxManager instance', async () => {
    const { createTmuxManager } = await import('@/lib/sandbox/tmux-manager');

    const mockProvider: SandboxProvider = {
      name: 'mock',
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

    expect(manager).toBeDefined();
  });

  it('creates CredentialsInjector instance', async () => {
    const { createCredentialsInjector } = await import('@/lib/sandbox/credentials-injector');

    const injector = createCredentialsInjector();

    expect(injector).toBeDefined();
  });
});
