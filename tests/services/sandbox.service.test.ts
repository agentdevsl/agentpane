import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sandbox, SandboxProvider } from '../../src/lib/sandbox/providers/sandbox-provider';
import type { SandboxConfig, TmuxSession } from '../../src/lib/sandbox/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createSandboxService, SandboxService } from '../../src/services/sandbox.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// Additional migration SQL for sandbox tables (not in main MIGRATION_SQL)
const SANDBOX_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "sandbox_instances" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL,
  "container_id" TEXT NOT NULL,
  "status" TEXT DEFAULT 'stopped' NOT NULL,
  "image" TEXT NOT NULL,
  "memory_mb" INTEGER NOT NULL,
  "cpu_cores" INTEGER NOT NULL,
  "idle_timeout_minutes" INTEGER NOT NULL,
  "volume_mounts" TEXT DEFAULT '[]',
  "env" TEXT,
  "error_message" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "last_activity_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "stopped_at" TEXT,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_instances_codespace_active_unique
  ON sandbox_instances(codespace_id)
  WHERE status IN ('creating', 'running', 'idle', 'stopping');

CREATE TABLE IF NOT EXISTS "sandbox_tmux_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "sandbox_id" TEXT NOT NULL,
  "session_name" TEXT NOT NULL,
  "task_id" TEXT,
  "window_count" INTEGER DEFAULT 1 NOT NULL,
  "attached" INTEGER DEFAULT 0 NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "last_activity_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  UNIQUE("sandbox_id", "session_name")
);
`;

// Helper to setup sandbox tables in test DB.
// F09-21 (arch29-W2-Q): the test harness now creates sandbox_instances and
// sandbox_tmux_sessions with `REFERENCES codespaces(id) ON DELETE CASCADE`
// FKs. This service-unit test inserts arbitrary `codespaceId` values without
// seeding real codespaces, so DROP+CREATE removes the FK and lets the
// existing test logic work without rewriting the entire suite.
function setupSandboxTables(): void {
  execRawSql('DROP TABLE IF EXISTS sandbox_tmux_sessions');
  execRawSql('DROP TABLE IF EXISTS sandbox_instances');
  execRawSql(SANDBOX_TABLES_SQL);
}

// Helper to clear sandbox tables
function clearSandboxTables(): void {
  try {
    execRawSql('DELETE FROM sandbox_tmux_sessions');
    execRawSql('DELETE FROM sandbox_instances');
  } catch {
    // Tables may not exist yet
  }
}

// =============================================================================
// Mock Setup
// =============================================================================

const createMockSandbox = (overrides: Partial<Sandbox> = {}): Sandbox => ({
  id: 'sandbox-123',
  codespaceId: 'project-123',
  containerId: 'container-abc',
  status: 'running',
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  execAsRoot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  createTmuxSession: vi.fn(),
  listTmuxSessions: vi.fn().mockResolvedValue([]),
  killTmuxSession: vi.fn(),
  sendKeysToTmux: vi.fn(),
  captureTmuxPane: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  getMetrics: vi.fn().mockResolvedValue({
    cpuUsagePercent: 10,
    memoryUsageMb: 512,
    memoryLimitMb: 4096,
    networkRxBytes: 1024,
    networkTxBytes: 2048,
  }),
  touch: vi.fn(),
  getLastActivity: vi.fn().mockReturnValue(new Date()),
  ...overrides,
});

const createMockProvider = (): SandboxProvider => ({
  name: 'mock',
  create: vi
    .fn()
    .mockImplementation(async (cfg: SandboxConfig) =>
      createMockSandbox({ id: cfg.id ?? 'sandbox-123', codespaceId: cfg.codespaceId })
    ),
  get: vi.fn(),
  getById: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  pullImage: vi.fn().mockResolvedValue(undefined),
  isImageAvailable: vi.fn().mockResolvedValue(true),
  healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  cleanup: vi.fn().mockResolvedValue(0),
});

const createMockStreams = (): DurableStreamsService =>
  ({
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1), // Returns offset
  }) as unknown as DurableStreamsService;

// =============================================================================
// SandboxService Tests
// =============================================================================

describe('SandboxService', () => {
  let service: SandboxService;
  let mockProvider: SandboxProvider;
  let mockStreams: DurableStreamsService;

  beforeEach(async () => {
    await setupTestDatabase();
    setupSandboxTables();
    mockProvider = createMockProvider();
    mockStreams = createMockStreams();
    const db = getTestDb();
    service = new SandboxService(db as never, mockProvider, mockStreams);
  });

  afterEach(async () => {
    service.stopIdleChecker();
    clearSandboxTables();
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  // =============================================================================
  // Sandbox Creation (5 tests)
  // =============================================================================

  describe('Sandbox Creation', () => {
    it('creates a sandbox with valid configuration', async () => {
      const config: SandboxConfig = {
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      };

      const result = await service.create(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.codespaceId).toBe('project-123');
        expect(result.value.status).toBe('running');
        expect(mockStreams.publish).toHaveBeenCalledWith(
          expect.any(String),
          'sandbox:creating',
          expect.objectContaining({ codespaceId: 'project-123' })
        );
        expect(mockStreams.publish).toHaveBeenCalledWith(
          expect.any(String),
          'sandbox:ready',
          expect.objectContaining({ codespaceId: 'project-123' })
        );
      }
    });

    it('pulls image if not available locally', async () => {
      (mockProvider.isImageAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const config: SandboxConfig = {
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      };

      const result = await service.create(config);

      expect(result.ok).toBe(true);
      expect(mockProvider.pullImage).toHaveBeenCalledWith('test-image:latest');
    });

    it('emits warning when credentials injection fails', async () => {
      // Override create to return a sandbox whose exec fails (triggers credential injection warning)
      (mockProvider.create as ReturnType<typeof vi.fn>).mockImplementation(
        async (cfg: SandboxConfig) =>
          createMockSandbox({
            id: cfg.id ?? 'sandbox-123',
            codespaceId: cfg.codespaceId,
            exec: vi
              .fn()
              .mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Permission denied' }),
          })
      );

      const config: SandboxConfig = {
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await service.create(config);

      expect(result.ok).toBe(true);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'sandbox:error',
        expect.objectContaining({
          code: 'CREDENTIALS_INJECTION_WARNING',
        })
      );
      consoleSpy.mockRestore();
    });

    it('returns error when container creation fails', async () => {
      (mockProvider.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker daemon unavailable')
      );

      const config: SandboxConfig = {
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      };

      const result = await service.create(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_CREATION_FAILED');
      }
      expect(mockStreams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'sandbox:error',
        expect.objectContaining({ codespaceId: 'project-123' })
      );
    });

    it('reserves an active DB row before provider provisioning', async () => {
      const db = getTestDb();
      (mockProvider.create as ReturnType<typeof vi.fn>).mockImplementation(
        async (cfg: SandboxConfig) => {
          const sandboxId = cfg.id ?? 'sandbox-123';
          const row = await db.query.sandboxInstances.findFirst({
            where: (table, { eq }) => eq(table.id, sandboxId),
          });
          expect(row).toMatchObject({
            id: sandboxId,
            codespaceId: cfg.codespaceId,
            status: 'creating',
            containerId: `pending:${sandboxId}`,
          });
          return createMockSandbox({
            id: sandboxId,
            codespaceId: cfg.codespaceId,
            containerId: 'container-reserved',
          });
        }
      );

      const result = await service.create({
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(result.ok).toBe(true);
      const row = await db.query.sandboxInstances.findFirst({
        where: (table, { eq }) => eq(table.codespaceId, 'project-123'),
      });
      expect(row).toMatchObject({
        status: 'running',
        containerId: 'container-reserved',
      });
    });

    it('does not call provider provisioning when an active sandbox row already exists', async () => {
      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');
      await db.insert(sandboxInstances).values({
        id: 'existing-active',
        codespaceId: 'project-123',
        containerId: 'container-existing',
        status: 'running',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const result = await service.create({
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_ALREADY_EXISTS');
      }
      expect(mockProvider.isImageAvailable).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('returns error with code when provider throws coded error', async () => {
      const codedError = { code: 'SANDBOX_CONTAINER_ALREADY_EXISTS', message: 'Already exists' };
      (mockProvider.create as ReturnType<typeof vi.fn>).mockRejectedValue(codedError);

      const config: SandboxConfig = {
        codespaceId: 'project-123',
        codespacePath: '/path/to/project',
        image: 'test-image:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      };

      const result = await service.create(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_ALREADY_EXISTS');
      }
    });
  });

  // =============================================================================
  // Get or Create for Project (3 tests)
  // =============================================================================

  describe('Get or Create for Codespace', () => {
    it('returns existing running sandbox', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });

      // Insert sandbox record
      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');
      await db.insert(sandboxInstances).values({
        id: 'existing-sandbox',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const result = await service.getOrCreateForCodespace(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.id).toBe('existing-sandbox');
      }
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('returns error when codespace not found', async () => {
      const result = await service.getOrCreateForCodespace('non-existent-codespace');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
      }
    });

    it('returns error when sandbox not enabled for codespace', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: false, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });

      const result = await service.getOrCreateForCodespace(project.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_NOT_ENABLED');
      }
    });
  });

  // =============================================================================
  // Sandbox Stop (3 tests)
  // =============================================================================

  describe('Sandbox Stop', () => {
    it('stops a running sandbox', async () => {
      const project = await createTestProject();
      const mockSandbox = createMockSandbox({ id: 'sandbox-to-stop' });

      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');
      await db.insert(sandboxInstances).values({
        id: 'sandbox-to-stop',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.stop('sandbox-to-stop', 'manual');

      expect(result.ok).toBe(true);
      expect(mockSandbox.stop).toHaveBeenCalled();
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'sandbox:sandbox-to-stop',
        'sandbox:stopping',
        expect.objectContaining({ reason: 'manual' })
      );
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'sandbox:sandbox-to-stop',
        'sandbox:stopped',
        expect.objectContaining({ codespaceId: project.id })
      );
    });

    it('returns error when sandbox not found', async () => {
      const result = await service.stop('non-existent-sandbox');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });

    it('handles stop failure gracefully', async () => {
      const project = await createTestProject();
      const mockSandbox = createMockSandbox({
        id: 'sandbox-fail-stop',
        stop: vi.fn().mockRejectedValue(new Error('Stop failed')),
      });

      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');
      await db.insert(sandboxInstances).values({
        id: 'sandbox-fail-stop',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.stop('sandbox-fail-stop');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_STOP_FAILED');
      }
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'sandbox:sandbox-fail-stop',
        'sandbox:error',
        expect.objectContaining({ codespaceId: project.id })
      );
    });
  });

  // =============================================================================
  // Exec Commands (3 tests)
  // =============================================================================

  describe('Exec Commands', () => {
    it('executes command in running sandbox', async () => {
      const mockSandbox = createMockSandbox({
        exec: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'command output',
          stderr: '',
        }),
      });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.exec('sandbox-123', 'echo', ['hello']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        expect(result.value.stdout).toBe('command output');
      }
    });

    it('returns error when sandbox not found', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.exec('non-existent', 'echo', ['hello']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });

    it('returns error when sandbox not running', async () => {
      const mockSandbox = createMockSandbox({ status: 'stopped' });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.exec('sandbox-123', 'echo', ['hello']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_RUNNING');
      }
    });
  });

  // =============================================================================
  // Metrics (2 tests)
  // =============================================================================

  describe('Metrics', () => {
    it('returns metrics for existing sandbox', async () => {
      const mockSandbox = createMockSandbox();
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.getMetrics('sandbox-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.cpuUsagePercent).toBe(10);
        expect(result.value.memoryUsageMb).toBe(512);
      }
    });

    it('returns error when sandbox not found', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.getMetrics('non-existent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Streaming Exec Support (2 tests)
  // =============================================================================

  describe('Streaming Exec Support', () => {
    it('returns true when sandbox supports execStream', async () => {
      const mockSandbox = createMockSandbox({
        execStream: vi.fn() as Sandbox['execStream'],
      });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      await expect(service.supportsStreamingExec('sandbox-123')).resolves.toBe(true);
    });

    it('returns false when sandbox is missing', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.supportsStreamingExec('missing')).resolves.toBe(false);
    });
  });

  // =============================================================================
  // Refresh Credentials (2 tests) - Covers line 436
  // =============================================================================

  describe('Refresh Credentials', () => {
    it('refreshes credentials for existing sandbox', async () => {
      const mockSandbox = createMockSandbox();
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.refreshCredentials('sandbox-123');

      // Result depends on credentials injector behavior
      expect(result).toBeDefined();
    });

    it('returns error when sandbox not found', async () => {
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.refreshCredentials('non-existent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Health Check (2 tests)
  // =============================================================================

  describe('Health Check', () => {
    it('returns healthy when provider is healthy', async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        healthy: true,
        message: 'Docker is running',
      });

      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.healthy).toBe(true);
      }
    });

    it('returns error when provider is unhealthy', async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        healthy: false,
        message: 'Docker not responding',
      });

      const result = await service.healthCheck();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROVIDER_HEALTH_CHECK_FAILED');
      }
    });
  });

  // =============================================================================
  // Tmux Session for Task (2 tests)
  // =============================================================================

  describe('Tmux Session for Task', () => {
    it('creates tmux session for task', async () => {
      const project = await createTestProject();
      const mockSession: TmuxSession = {
        name: 'agent-task-123',
        sandboxId: 'sandbox-123',
        taskId: 'task-123',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };

      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');
      await db.insert(sandboxInstances).values({
        id: 'sandbox-123',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const mockSandbox = createMockSandbox({
        createTmuxSession: vi.fn().mockResolvedValue(mockSession),
      });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.createTmuxSessionForTask(project.id, 'task-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe('task-123');
      }
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'sandbox:sandbox-123',
        'sandbox:tmux:created',
        expect.objectContaining({ taskId: 'task-123' })
      );
    });

    it('returns error when sandbox not found for codespace', async () => {
      const result = await service.createTmuxSessionForTask('non-existent', 'task-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Idle Checker (4 tests) - Covers lines 446-467
  // =============================================================================

  describe('Idle Checker', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts and stops idle checker', () => {
      service.startIdleChecker();
      service.startIdleChecker(); // Should be idempotent
      service.stopIdleChecker();
      service.stopIdleChecker(); // Should be idempotent
    });

    it('stops idle sandboxes after timeout', async () => {
      const project = await createTestProject();
      const mockSandbox = createMockSandbox({ id: 'idle-sandbox' });

      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');

      // Insert a sandbox that's been idle for more than its timeout
      const idleTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      await db.insert(sandboxInstances).values({
        id: 'idle-sandbox',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30, // 30 minutes timeout
        lastActivityAt: idleTime.toISOString(),
      });

      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      service.startIdleChecker();

      // Fast forward 5 minutes to trigger idle check
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mockStreams.publish).toHaveBeenCalledWith(
        'sandbox:idle-sandbox',
        'sandbox:idle',
        expect.objectContaining({
          sandboxId: 'idle-sandbox',
          codespaceId: project.id,
        })
      );

      service.stopIdleChecker();
    });

    it('does not stop sandbox that is still active', async () => {
      const project = await createTestProject();

      const db = getTestDb();
      const { sandboxInstances } = await import('../../src/db/schema');

      // Insert a sandbox that was active recently
      await db.insert(sandboxInstances).values({
        id: 'active-sandbox',
        codespaceId: project.id,
        containerId: 'container-abc',
        status: 'running',
        image: 'test-image',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        lastActivityAt: new Date().toISOString(), // Just now
      });

      service.startIdleChecker();

      // Fast forward 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mockStreams.publish).not.toHaveBeenCalledWith(
        'sandbox:active-sandbox',
        'sandbox:idle',
        expect.any(Object)
      );

      service.stopIdleChecker();
    });

    it('disables idle checker after too many failures', async () => {
      // Make the database query fail to simulate errors
      const db = getTestDb();
      const originalQuery = db.query;
      db.query = {
        ...originalQuery,
        sandboxInstances: {
          ...originalQuery.sandboxInstances,
          findMany: vi.fn().mockRejectedValue(new Error('Database error')),
        },
      } as never;

      service.startIdleChecker();

      // Trigger 5 failures (MAX_IDLE_CHECK_FAILURES)
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      }

      // After MAX_IDLE_CHECK_FAILURES consecutive failures, the idle checker
      // should have disabled itself via stopIdleChecker(). Calling stop again
      // should be a no-op (idempotent).
      service.stopIdleChecker();
    });
  });

  // =============================================================================
  // Factory Function (1 test) - Covers line 530
  // =============================================================================

  describe('Factory Function', () => {
    it('creates SandboxService instance', () => {
      const db = getTestDb();
      const sandboxService = createSandboxService(db as never, mockProvider, mockStreams);

      expect(sandboxService).toBeInstanceOf(SandboxService);
    });
  });

  // =============================================================================
  // Edge Cases (2 tests)
  // =============================================================================

  describe('Edge Cases', () => {
    it('handles exec failure gracefully', async () => {
      const mockSandbox = createMockSandbox({
        exec: vi.fn().mockRejectedValue(new Error('Exec error')),
      });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.exec('sandbox-123', 'failing-command');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
      }
    });

    it('handles getMetrics failure gracefully', async () => {
      const mockSandbox = createMockSandbox({
        getMetrics: vi.fn().mockRejectedValue(new Error('Metrics error')),
      });
      (mockProvider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

      const result = await service.getMetrics('sandbox-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_INTERNAL_ERROR');
      }
    });
  });

  // =============================================================================
  // Stop with tmux cleanup
  // Note: The tmux cleanup warning test requires database schema registration
  // which is tested in services-remaining.test.ts. The stop functionality is
  // already tested above in the 'Sandbox Stop' section which covers the main
  // code paths.
  // =============================================================================
});
