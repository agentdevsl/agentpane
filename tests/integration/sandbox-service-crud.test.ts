/**
 * Integration tests for SandboxService — provider + DB wrapper for sandbox CRUD.
 *
 * Tests cover:
 * - create: stream ID prefixed sandbox:${id}, image check/pull, credential injection (non-fatal),
 *   DB persistence, event publishing sequence (creating -> ready)
 * - getOrCreateForCodespace: returns existing if running, creates new if none, checks sandbox enabled
 * - stop: publish stopping -> kill tmux -> stop container -> DB update -> publish stopped;
 *   error path -> error status in DB + error event
 * - createTmuxSessionForTask: DB insert + event
 * - idle checker: per-sandbox error boundary, auto-disable after 5 failures
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sandboxInstances, sandboxTmuxSessions } from '../../src/db/schema';
import { SandboxService } from '../../src/services/sandbox.service';
import { createTestProject } from '../factories/project.factory';
import { TEST_AGENT_SANDBOX_IMAGE } from '../fixtures/sandbox-image';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createMockDurableStreamsService,
  createMockSandbox,
  createMockSandboxProvider,
} from '../mocks/mock-services';

// Mock the credentials injector to avoid filesystem I/O
vi.mock('../../src/lib/sandbox/credentials-injector.js', () => ({
  createCredentialsInjector: vi.fn().mockReturnValue({
    inject: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    refresh: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  }),
}));

// Mock the tmux manager
vi.mock('../../src/lib/sandbox/tmux-manager.js', () => ({
  createTmuxManager: vi.fn().mockReturnValue({
    createSession: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        name: 'task-session',
        sandboxId: 'sandbox-1',
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      },
    }),
    killAllSessions: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  }),
  TmuxManager: {
    createSessionName: vi.fn().mockImplementation((taskId: string) => `task-${taskId}`),
  },
}));

describe('SandboxService (IT-1550)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: SandboxService;
  let mockProvider: ReturnType<typeof createMockSandboxProvider>;
  let mockStreams: ReturnType<typeof createMockDurableStreamsService>;
  let mockSandbox: ReturnType<typeof createMockSandbox>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();

    // H4: Raw SQL CREATE TABLE required because sandbox_instances and sandbox_tmux_sessions
    // are created by a migration that runs after the base schema. The test setup helper
    // setupTestDatabase() only applies the base schema. If these tables are ever added to
    // the base setup, this raw SQL can be removed.
    try {
      execRawSql(`
        CREATE TABLE IF NOT EXISTS "sandbox_instances" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "codespace_id" TEXT NOT NULL UNIQUE,
          "container_id" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'stopped',
          "image" TEXT NOT NULL,
          "memory_mb" INTEGER NOT NULL,
          "cpu_cores" INTEGER NOT NULL,
          "idle_timeout_minutes" INTEGER NOT NULL DEFAULT 30,
          "volume_mounts" TEXT DEFAULT '[]',
          "env" TEXT,
          "error_message" TEXT,
          "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
          "last_activity_at" TEXT NOT NULL DEFAULT (datetime('now')),
          "stopped_at" TEXT,
          "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      execRawSql(`
        CREATE TABLE IF NOT EXISTS "sandbox_tmux_sessions" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "sandbox_id" TEXT NOT NULL,
          "session_name" TEXT NOT NULL,
          "task_id" TEXT,
          "window_count" INTEGER NOT NULL DEFAULT 1,
          "attached" INTEGER NOT NULL DEFAULT 0,
          "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
          "last_activity_at" TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE("sandbox_id", "session_name")
        );
      `);
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes('already exists')) throw e;
    }

    mockSandbox = createMockSandbox({
      id: 'sandbox-crud-1',
      codespaceId: 'proj-1',
      containerId: 'container-crud-123',
      status: 'running',
    });

    mockProvider = createMockSandboxProvider({
      create: vi.fn().mockResolvedValue(mockSandbox),
      get: vi.fn().mockResolvedValue(null),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      isImageAvailable: vi.fn().mockResolvedValue(true),
      pullImage: vi.fn().mockResolvedValue(undefined),
    });

    mockStreams = createMockDurableStreamsService();

    service = new SandboxService(db as any, mockProvider, mockStreams as any);
  });

  afterEach(async () => {
    service.stopIdleChecker();
    // Clean up sandbox tables before the general clearTestDatabase
    try {
      execRawSql('DELETE FROM sandbox_tmux_sessions');
      execRawSql('DELETE FROM sandbox_instances');
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes('no such table')) throw e;
    }
    await clearTestDatabase();
  });

  describe('create (IT-1551)', () => {
    it('IT-1552a: stream ID is prefixed with sandbox:<id>', async () => {
      const result = await service.create({
        codespaceId: 'proj-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(result.ok).toBe(true);

      // Verify createStream was called with sandbox: prefix
      const createStreamCalls = (mockStreams.createStream as ReturnType<typeof vi.fn>).mock.calls;
      expect(createStreamCalls.length).toBeGreaterThanOrEqual(1);
      const streamId = createStreamCalls[0][0] as string;
      expect(streamId).toMatch(/^sandbox:/);
    });

    it('IT-1552b: pulls image if not available locally', async () => {
      (mockProvider.isImageAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await service.create({
        codespaceId: 'proj-pull-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(mockProvider.pullImage).toHaveBeenCalledWith(TEST_AGENT_SANDBOX_IMAGE);
    });

    it('IT-1552c: skips image pull if already available', async () => {
      (mockProvider.isImageAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await service.create({
        codespaceId: 'proj-nopull-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(mockProvider.pullImage).not.toHaveBeenCalled();
    });

    it('IT-1552d: persists sandbox to database', async () => {
      const result = await service.create({
        codespaceId: 'proj-db-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(result.ok).toBe(true);

      // Verify DB record
      const dbSandbox = await db.query.sandboxInstances.findFirst({
        where: eq(sandboxInstances.id, mockSandbox.id),
      });
      expect(dbSandbox).toBeDefined();
      expect(dbSandbox?.codespaceId).toBe('proj-db-1');
      expect(dbSandbox?.status).toBe('running');
      expect(dbSandbox?.image).toBe(TEST_AGENT_SANDBOX_IMAGE);
      expect(dbSandbox?.memoryMb).toBe(4096);
      expect(dbSandbox?.cpuCores).toBe(2);
    });

    it('IT-1552e: publishes creating -> ready event sequence', async () => {
      await service.create({
        codespaceId: 'proj-events-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((call) => call[1] as string);

      expect(eventTypes).toContain('sandbox:creating');
      expect(eventTypes).toContain('sandbox:ready');

      // Verify order: creating before ready
      const creatingIdx = eventTypes.indexOf('sandbox:creating');
      const readyIdx = eventTypes.indexOf('sandbox:ready');
      expect(creatingIdx).toBeLessThan(readyIdx);
    });

    it('IT-1552f: credential injection failure is non-fatal (emits warning event)', async () => {
      // Make credential injection fail
      const { createCredentialsInjector } = await import(
        '../../src/lib/sandbox/credentials-injector.js'
      );
      (createCredentialsInjector as ReturnType<typeof vi.fn>).mockReturnValue({
        inject: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'No credentials file found' },
        }),
        refresh: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      });

      // Re-create service with the new mock
      service = new SandboxService(db as any, mockProvider, mockStreams as any);

      const result = await service.create({
        codespaceId: 'proj-cred-fail-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      // Should still succeed (credentials are non-fatal)
      expect(result.ok).toBe(true);

      // Should emit a warning event
      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const errorEvent = publishCalls.find(
        (call) =>
          call[1] === 'sandbox:error' && (call[2] as any)?.code === 'CREDENTIALS_INJECTION_WARNING'
      );
      expect(errorEvent).toBeDefined();
    });

    it('IT-1552g: passes sandboxId to provider via config.id', async () => {
      await service.create({
        codespaceId: 'proj-id-pass-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const createCall = (mockProvider.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.id).toBeDefined();
      expect(typeof createCall.id).toBe('string');
    });

    it('IT-1552h: publishes error event on creation failure', async () => {
      (mockProvider.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker not running')
      );

      const result = await service.create({
        codespaceId: 'proj-create-fail-1',
        codespacePath: '/project',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(result.ok).toBe(false);

      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const errorEvent = publishCalls.find((call) => call[1] === 'sandbox:error');
      expect(errorEvent).toBeDefined();
    });
  });

  describe('getOrCreateForCodespace (IT-1552)', () => {
    it('IT-1553a: returns existing running sandbox', async () => {
      // Create a codespace with sandbox enabled
      const project = await createTestProject({
        id: 'proj-existing-1',
        config: {
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        } as any,
      });

      // Insert a running sandbox in DB
      await db.insert(sandboxInstances).values({
        id: 'sandbox-existing-1',
        codespaceId: project.id,
        containerId: 'container-existing-1',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const result = await service.getOrCreateForCodespace(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.id).toBe('sandbox-existing-1');
        expect(result.value?.status).toBe('running');
      }

      // Should NOT create a new sandbox
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('IT-1553b: creates new sandbox when none exists', async () => {
      const project = await createTestProject({
        id: 'proj-new-sandbox-1',
        config: {
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        } as any,
      });

      const result = await service.getOrCreateForCodespace(project.id);

      expect(result.ok).toBe(true);
      expect(mockProvider.create).toHaveBeenCalled();
    });

    it('IT-1553c: returns error when sandbox not enabled', async () => {
      const project = await createTestProject({
        id: 'proj-disabled-1',
        config: {
          sandbox: { enabled: false, provider: 'docker', idleTimeoutMinutes: 30 },
        } as any,
      });

      const result = await service.getOrCreateForCodespace(project.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_NOT_ENABLED');
      }
    });

    it('IT-1553d: returns error when codespace not found', async () => {
      const result = await service.getOrCreateForCodespace('nonexistent-codespace');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
      }
    });
  });

  describe('stop (IT-1553)', () => {
    it('IT-1554a: publishes stopping -> stopped, updates DB to stopped', async () => {
      // Insert a running sandbox in DB
      await db.insert(sandboxInstances).values({
        id: 'sandbox-stop-1',
        codespaceId: 'proj-stop-1',
        containerId: 'container-stop-1',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const result = await service.stop('sandbox-stop-1', 'manual');

      expect(result.ok).toBe(true);

      // Verify DB updated
      const dbSandbox = await db.query.sandboxInstances.findFirst({
        where: eq(sandboxInstances.id, 'sandbox-stop-1'),
      });
      expect(dbSandbox?.status).toBe('stopped');
      expect(dbSandbox?.stoppedAt).toBeDefined();

      // Verify event sequence
      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = publishCalls.map((call) => call[1] as string);
      expect(eventTypes).toContain('sandbox:stopping');
      expect(eventTypes).toContain('sandbox:stopped');

      // Verify order
      const stoppingIdx = eventTypes.indexOf('sandbox:stopping');
      const stoppedIdx = eventTypes.indexOf('sandbox:stopped');
      expect(stoppingIdx).toBeLessThan(stoppedIdx);
    });

    it('IT-1554b: calls sandbox stop on provider', async () => {
      await db.insert(sandboxInstances).values({
        id: 'sandbox-provider-stop-1',
        codespaceId: 'proj-stop-2',
        containerId: 'container-stop-2',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      await service.stop('sandbox-provider-stop-1');

      expect(mockSandbox.stop).toHaveBeenCalled();
    });

    it('IT-1554c: sets error status in DB on stop failure', async () => {
      (mockSandbox.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Stop failed'));

      await db.insert(sandboxInstances).values({
        id: 'sandbox-stop-fail-1',
        codespaceId: 'proj-stop-fail',
        containerId: 'container-stop-fail',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const result = await service.stop('sandbox-stop-fail-1');

      expect(result.ok).toBe(false);

      // Verify DB has error status
      const dbSandbox = await db.query.sandboxInstances.findFirst({
        where: eq(sandboxInstances.id, 'sandbox-stop-fail-1'),
      });
      expect(dbSandbox?.status).toBe('error');
      expect(dbSandbox?.errorMessage).toContain('Stop failed');

      // Verify error event published
      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const errorEvent = publishCalls.find((call) => call[1] === 'sandbox:error');
      expect(errorEvent).toBeDefined();
    });

    it('IT-1554d: returns error for nonexistent sandbox', async () => {
      const result = await service.stop('nonexistent-sandbox');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
      }
    });
  });

  describe('createTmuxSessionForTask (IT-1554)', () => {
    it('IT-1555a: creates tmux session and persists to DB', async () => {
      // Create a sandbox in DB that getByCodespaceId will find
      await db.insert(sandboxInstances).values({
        id: 'sandbox-tmux-1',
        codespaceId: 'proj-tmux-1',
        containerId: 'container-tmux-1',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });

      const result = await service.createTmuxSessionForTask('proj-tmux-1', 'task-tmux-1');

      expect(result.ok).toBe(true);

      // Verify DB record for tmux session
      const dbSession = await db.query.sandboxTmuxSessions.findFirst({
        where: eq(sandboxTmuxSessions.taskId, 'task-tmux-1'),
      });
      expect(dbSession).toBeDefined();
      expect(dbSession?.sandboxId).toBe('sandbox-tmux-1');

      // Verify event published
      const publishCalls = (mockStreams.publish as ReturnType<typeof vi.fn>).mock.calls;
      const tmuxEvent = publishCalls.find((call) => call[1] === 'sandbox:tmux:created');
      expect(tmuxEvent).toBeDefined();
    });

    it('IT-1555b: returns error when no sandbox exists for codespace', async () => {
      const result = await service.createTmuxSessionForTask('nonexistent-codespace', 'task-1');

      expect(result.ok).toBe(false);
    });
  });

  describe('idle checker (IT-1555)', () => {
    it('IT-1556a: auto-disables after MAX_IDLE_CHECK_FAILURES consecutive failures', async () => {
      vi.useFakeTimers();

      // Create a db proxy that makes sandboxInstances queries throw,
      // causing checkIdleSandboxes to fail on every interval tick
      const brokenDb = new Proxy(db, {
        get(target, prop) {
          if (prop === 'query') {
            return new Proxy(target.query, {
              get(_queryTarget, queryProp) {
                if (queryProp === 'sandboxInstances') {
                  return {
                    findMany: () => {
                      throw new Error('Simulated DB failure');
                    },
                  };
                }
                return (_queryTarget as any)[queryProp];
              },
            });
          }
          return (target as any)[prop];
        },
      });

      const idleService = new SandboxService(brokenDb as any, mockProvider, mockStreams as any);
      idleService.startIdleChecker();
      expect((idleService as any).idleCheckInterval).toBeDefined();

      // The idle check interval is 5 * 60 * 1000 ms = 300_000ms.
      // After 5 consecutive failures (MAX_IDLE_CHECK_FAILURES), it auto-disables.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(300_000);
      }

      expect((idleService as any).idleCheckInterval).toBeNull();

      vi.useRealTimers();
    });

    it('IT-1556b: startIdleChecker is idempotent', () => {
      service.startIdleChecker();
      const firstInterval = (service as any).idleCheckInterval;

      service.startIdleChecker();
      const secondInterval = (service as any).idleCheckInterval;

      // Should be the same interval reference (not replaced)
      expect(firstInterval).toBe(secondInterval);

      service.stopIdleChecker();
    });
  });

  describe('getById (IT-1556)', () => {
    it('IT-1557a: returns sandbox info from DB', async () => {
      await db.insert(sandboxInstances).values({
        id: 'sandbox-getbyid-1',
        codespaceId: 'proj-getbyid-1',
        containerId: 'container-getbyid-1',
        status: 'running',
        image: TEST_AGENT_SANDBOX_IMAGE,
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 15,
      });

      const result = await service.getById('sandbox-getbyid-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.id).toBe('sandbox-getbyid-1');
        expect(result.value?.codespaceId).toBe('proj-getbyid-1');
        expect(result.value?.memoryMb).toBe(2048);
      }
    });

    it('IT-1557b: returns null for nonexistent sandbox', async () => {
      const result = await service.getById('nonexistent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('healthCheck (IT-1557)', () => {
    it('IT-1558a: returns ok when provider is healthy', async () => {
      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
    });

    it('IT-1558b: returns error when provider health check fails', async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        healthy: false,
        message: 'Docker daemon not running',
      });

      const result = await service.healthCheck();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROVIDER_HEALTH_CHECK_FAILED');
      }
    });
  });
});
