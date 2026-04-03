import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sandboxInstances } from '../../src/db/schema';
import type { Sandbox, SandboxProvider } from '../../src/lib/sandbox/providers/sandbox-provider';
import type { SandboxConfig, SandboxMetrics, TmuxSession } from '../../src/lib/sandbox/types';
import { SANDBOX_DEFAULTS } from '../../src/lib/sandbox/types';
import { SandboxService } from '../../src/services/sandbox.service';
import { createTestProject } from '../factories/project.factory';
import { execRawSql } from '../helpers/database';

// Additional migration SQL for sandbox tables (not in main MIGRATION_SQL)
const SANDBOX_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "sandbox_instances" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL UNIQUE,
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

function setupSandboxTables(): void {
  execRawSql(SANDBOX_TABLES_SQL);
}

function clearSandboxTables(): void {
  try {
    execRawSql('DELETE FROM sandbox_tmux_sessions');
    execRawSql('DELETE FROM sandbox_instances');
  } catch {
    // Tables may not exist yet
  }
}

import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock factories for external I/O boundaries
// ---------------------------------------------------------------------------

function createMockSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: overrides.id ?? createId(),
    codespaceId: overrides.codespaceId ?? createId(),
    containerId: overrides.containerId ?? `container-${createId()}`,
    status: overrides.status ?? 'running',
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execAsRoot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    createTmuxSession: vi.fn().mockResolvedValue({
      name: 'agent-test',
      sandboxId: 'sb-1',
      createdAt: new Date().toISOString(),
      windowCount: 1,
      attached: false,
    } satisfies TmuxSession),
    listTmuxSessions: vi.fn().mockResolvedValue([]),
    killTmuxSession: vi.fn().mockResolvedValue(undefined),
    sendKeysToTmux: vi.fn().mockResolvedValue(undefined),
    captureTmuxPane: vi.fn().mockResolvedValue(''),
    stop: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn().mockResolvedValue({
      cpuUsagePercent: 10,
      memoryUsageMb: 512,
      memoryLimitMb: 4096,
      diskUsageMb: 100,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptime: 3600,
    } satisfies SandboxMetrics),
    touch: vi.fn(),
    getLastActivity: vi.fn().mockReturnValue(new Date()),
    ...overrides,
  };
}

function createMockProvider(sandbox?: Sandbox): SandboxProvider {
  const mockSandbox = sandbox ?? createMockSandbox();
  return {
    name: 'mock-docker',
    create: vi.fn().mockImplementation(async (config: SandboxConfig) => {
      // Use the config.id if provided (as the real provider should)
      return createMockSandbox({
        id: config.id ?? createId(),
        codespaceId: config.codespaceId,
      });
    }),
    get: vi.fn().mockResolvedValue(mockSandbox),
    getById: vi.fn().mockResolvedValue(mockSandbox),
    list: vi.fn().mockResolvedValue([]),
    pullImage: vi.fn().mockResolvedValue(undefined),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    cleanup: vi.fn().mockResolvedValue(0),
  };
}

function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1),
    publishPlanStarted: vi.fn().mockResolvedValue(undefined),
    publishPlanTurn: vi.fn().mockResolvedValue(undefined),
    publishPlanToken: vi.fn().mockResolvedValue(undefined),
    publishPlanInteraction: vi.fn().mockResolvedValue(undefined),
    publishPlanCompleted: vi.fn().mockResolvedValue(undefined),
    publishPlanError: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SandboxService (IT-420)', () => {
  let db: ReturnType<typeof getTestDb>;
  let provider: ReturnType<typeof createMockProvider>;
  let streams: ReturnType<typeof createMockStreams>;
  let service: SandboxService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    setupSandboxTables();
    provider = createMockProvider();
    streams = createMockStreams();
    service = new SandboxService(db as any, provider, streams as any);
  });

  afterEach(async () => {
    service.stopIdleChecker();
    clearSandboxTables();
    await clearTestDatabase();
  });

  // ---------- create ---------------------------------------------------------

  it('IT-421: create sandbox — stores record in database and returns SandboxInfo', async () => {
    const project = await createTestProject();

    const config: SandboxConfig = {
      codespaceId: project.id,
      codespacePath: project.path,
      image: SANDBOX_DEFAULTS.image,
      memoryMb: SANDBOX_DEFAULTS.memoryMb,
      cpuCores: SANDBOX_DEFAULTS.cpuCores,
      idleTimeoutMinutes: SANDBOX_DEFAULTS.idleTimeoutMinutes,
      volumeMounts: [],
    };

    const result = await service.create(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = result.value;
    expect(info.codespaceId).toBe(project.id);
    expect(info.status).toBe('running');
    expect(info.image).toBe(SANDBOX_DEFAULTS.image);
    expect(info.memoryMb).toBe(SANDBOX_DEFAULTS.memoryMb);
    expect(info.cpuCores).toBe(SANDBOX_DEFAULTS.cpuCores);

    // Verify database record
    const dbSandbox = await db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.codespaceId, project.id),
    });
    expect(dbSandbox).toBeTruthy();
    expect(dbSandbox!.status).toBe('running');
    expect(dbSandbox!.image).toBe(SANDBOX_DEFAULTS.image);
  });

  it('IT-422: create sandbox publishes stream events (creating + ready)', async () => {
    const project = await createTestProject();

    const config: SandboxConfig = {
      codespaceId: project.id,
      codespacePath: project.path,
      image: 'node:22-slim',
      memoryMb: 2048,
      cpuCores: 1,
      idleTimeoutMinutes: 15,
      volumeMounts: [],
    };

    await service.create(config);

    // Stream should be created with sandbox:-prefixed ID
    expect(streams.createStream).toHaveBeenCalledTimes(1);
    const createStreamArgs = streams.createStream.mock.calls[0];
    expect(createStreamArgs[0]).toMatch(/^sandbox:/);

    // Publish calls: sandbox:creating then sandbox:ready
    expect(streams.publish).toHaveBeenCalledTimes(2);
    const publishCalls = streams.publish.mock.calls;
    expect(publishCalls[0][1]).toBe('sandbox:creating');
    // Last event should be sandbox:ready
    expect(publishCalls[publishCalls.length - 1][1]).toBe('sandbox:ready');
  });

  it('IT-423: create sandbox pulls image when not available locally', async () => {
    (provider.isImageAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const project = await createTestProject();

    const config: SandboxConfig = {
      codespaceId: project.id,
      codespacePath: project.path,
      image: 'custom:latest',
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      volumeMounts: [],
    };

    await service.create(config);

    expect(provider.pullImage).toHaveBeenCalledWith('custom:latest');
  });

  it('IT-424: create sandbox returns error when provider.create fails', async () => {
    (provider.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Docker daemon not running')
    );

    const project = await createTestProject();

    const config: SandboxConfig = {
      codespaceId: project.id,
      codespacePath: project.path,
      image: SANDBOX_DEFAULTS.image,
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      volumeMounts: [],
    };

    const result = await service.create(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_CONTAINER_CREATION_FAILED');
  });

  // ---------- getByCodespaceId / getById ------------------------------------

  it('IT-425: getByCodespaceId returns sandbox info when exists', async () => {
    const project = await createTestProject();

    // Insert a sandbox record directly
    await db.insert(sandboxInstances).values({
      id: createId(),
      codespaceId: project.id,
      containerId: 'container-abc',
      status: 'running',
      image: SANDBOX_DEFAULTS.image,
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    const result = await service.getByCodespaceId(project.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.codespaceId).toBe(project.id);
    expect(result.value!.status).toBe('running');
  });

  it('IT-426: getByCodespaceId returns null when no sandbox exists', async () => {
    const result = await service.getByCodespaceId('nonexistent-codespace');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('IT-427: getById returns sandbox info when exists', async () => {
    const project = await createTestProject();
    const sandboxId = createId();

    await db.insert(sandboxInstances).values({
      id: sandboxId,
      codespaceId: project.id,
      containerId: 'container-xyz',
      status: 'running',
      image: 'node:22',
      memoryMb: 2048,
      cpuCores: 1,
      idleTimeoutMinutes: 15,
    });

    const result = await service.getById(sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.id).toBe(sandboxId);
  });

  it('IT-428: getById returns null for nonexistent sandbox', async () => {
    const result = await service.getById('nonexistent-sandbox-id');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // ---------- stop -----------------------------------------------------------

  it('IT-429: stop sandbox updates DB status to stopped and publishes events', async () => {
    const project = await createTestProject();
    const sandboxId = createId();

    await db.insert(sandboxInstances).values({
      id: sandboxId,
      codespaceId: project.id,
      containerId: 'container-to-stop',
      status: 'running',
      image: SANDBOX_DEFAULTS.image,
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    const result = await service.stop(sandboxId);

    expect(result.ok).toBe(true);

    // Verify DB status updated
    const dbSandbox = await db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.id, sandboxId),
    });
    expect(dbSandbox!.status).toBe('stopped');
    expect(dbSandbox!.stoppedAt).not.toBeNull();

    // Verify stop events published
    const publishCalls = streams.publish.mock.calls;
    const stopEvents = publishCalls.map((c: unknown[]) => c[1]);
    expect(stopEvents).toContain('sandbox:stopping');
    expect(stopEvents).toContain('sandbox:stopped');
  });

  it('IT-430: stop nonexistent sandbox returns CONTAINER_NOT_FOUND error', async () => {
    const result = await service.stop('nonexistent-sandbox');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-431: stop sandbox updates DB to error status when provider.stop fails', async () => {
    const project = await createTestProject();
    const sandboxId = createId();

    await db.insert(sandboxInstances).values({
      id: sandboxId,
      codespaceId: project.id,
      containerId: 'container-fail-stop',
      status: 'running',
      image: SANDBOX_DEFAULTS.image,
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    // Make the sandbox.stop() call fail
    const mockSandbox = createMockSandbox({ id: sandboxId });
    (mockSandbox.stop as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Container unresponsive')
    );
    (provider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

    const result = await service.stop(sandboxId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_CONTAINER_STOP_FAILED');

    // DB should be updated to error status
    const dbSandbox = await db.query.sandboxInstances.findFirst({
      where: eq(sandboxInstances.id, sandboxId),
    });
    expect(dbSandbox!.status).toBe('error');
    expect(dbSandbox!.errorMessage).toContain('Container unresponsive');
  });

  // ---------- getOrCreateForCodespace ----------------------------------------

  it('IT-432: getOrCreateForCodespace returns existing running sandbox', async () => {
    const project = await createTestProject({
      config: {
        sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
      },
    });

    const sandboxId = createId();
    await db.insert(sandboxInstances).values({
      id: sandboxId,
      codespaceId: project.id,
      containerId: 'existing-container',
      status: 'running',
      image: SANDBOX_DEFAULTS.image,
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    const result = await service.getOrCreateForCodespace(project.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(sandboxId);
    expect(result.value.status).toBe('running');

    // Should NOT have called provider.create since sandbox already exists
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('IT-433: getOrCreateForCodespace returns error when codespace not found', async () => {
    const result = await service.getOrCreateForCodespace('nonexistent-codespace-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
  });

  it('IT-434: getOrCreateForCodespace returns error when sandbox not enabled', async () => {
    const project = await createTestProject({
      config: {
        sandbox: { enabled: false, provider: 'docker', idleTimeoutMinutes: 30 },
      },
    });

    const result = await service.getOrCreateForCodespace(project.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_NOT_ENABLED');
  });

  // ---------- exec -----------------------------------------------------------

  it('IT-435: exec delegates to provider sandbox and returns result', async () => {
    const mockSandbox = createMockSandbox();
    (mockSandbox.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: 'hello world',
      stderr: '',
    });
    (provider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockSandbox);

    const result = await service.exec(mockSandbox.id, 'echo', ['hello world']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);
    expect(result.value.stdout).toBe('hello world');
  });

  it('IT-436: exec returns CONTAINER_NOT_FOUND when sandbox does not exist', async () => {
    (provider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await service.exec('nonexistent', 'ls');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-437: exec returns CONTAINER_NOT_RUNNING when sandbox is stopped', async () => {
    const stoppedSandbox = createMockSandbox({ status: 'stopped' });
    (provider.getById as ReturnType<typeof vi.fn>).mockResolvedValue(stoppedSandbox);

    const result = await service.exec(stoppedSandbox.id, 'ls');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_RUNNING');
  });

  // ---------- healthCheck ----------------------------------------------------

  it('IT-438: healthCheck returns healthy result from provider', async () => {
    (provider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      healthy: true,
      message: 'Docker is running',
    });

    const result = await service.healthCheck();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.healthy).toBe(true);
  });

  it('IT-439: healthCheck returns error when provider is unhealthy', async () => {
    (provider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      healthy: false,
      message: 'Docker daemon not reachable',
    });

    const result = await service.healthCheck();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SANDBOX_PROVIDER_HEALTH_CHECK_FAILED');
  });

  // ---------- idle checker ---------------------------------------------------

  it('IT-440: idle checker start/stop lifecycle', () => {
    // Starting and stopping should not throw
    service.startIdleChecker();
    service.stopIdleChecker();

    // Double-stop should be safe
    expect(() => service.stopIdleChecker()).not.toThrow();
  });

  it('IT-441: startIdleChecker is idempotent — calling twice does not create multiple timers', () => {
    service.startIdleChecker();
    service.startIdleChecker(); // Should be no-op
    service.stopIdleChecker();
  });
});
