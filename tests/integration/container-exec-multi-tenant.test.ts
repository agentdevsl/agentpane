/**
 * Integration test for ContainerExecService multi-tenant gate enforcement.
 *
 * The gate is implemented in shared-helpers (assertSharedSandboxAllowed)
 * and called from ContainerExecService.startAgent. The unit-project test
 * verifies the helper directly; this test exercises the integration path
 * end-to-end so the integration project sees the gate-rejection branch
 * (lines 342-352 in container-exec.service.ts).
 */

import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import { ContainerExecService } from '../../src/services/container-agent/container-exec.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createMockApiKeyService,
  createMockDurableStreamsService,
  createMockSandbox,
  createMockSandboxProvider,
} from '../mocks/mock-services';

// Mock settings service to avoid file I/O
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  getFullModelId: vi.fn().mockImplementation((model: string) => model),
}));

vi.mock('../../src/lib/sandbox/skill-injector.js', () => ({
  injectSkills: vi.fn().mockResolvedValue({ injected: 0, skipped: 0, errors: [] }),
  injectAgents: vi.fn().mockResolvedValue({ injected: 0, skipped: 0, errors: [] }),
}));

vi.mock('../../src/services/template.service.js', () => ({
  TemplateService: class MockTemplateService {
    getMergedConfig = vi.fn().mockResolvedValue({ ok: true, value: { skills: [], agents: [] } });
  },
}));

vi.mock('../../src/lib/agents/container-bridge.js', () => ({
  createContainerBridge: vi.fn().mockImplementation((opts) => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    processStderr: vi.fn(),
    _opts: opts,
  })),
}));

function createMockReadable(): Readable {
  const readable = new Readable({ read() {} });
  readable.push(null);
  return readable;
}

describe('ContainerExecService — multi-tenant gate enforcement (IT-1410)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let service: ContainerExecService;
  const originalMultiTenant = process.env.MULTI_TENANT;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    const mockSandbox = createMockSandbox({
      id: 'sandbox-mt-1',
      codespaceId: 'proj-mt-1',
      containerId: 'container-mt',
      status: 'running',
      execStream: vi.fn().mockResolvedValue({
        stdout: createMockReadable(),
        stderr: createMockReadable(),
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const provider = createMockSandboxProvider({
      get: vi.fn().mockResolvedValue(mockSandbox),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    state = new SandboxStateManager();
    service = new ContainerExecService(
      {
        db: db as never,
        provider,
        streams: createMockDurableStreamsService(),
        apiKeyService: createMockApiKeyService({
          getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat01-test'),
        }),
        worktreeService: undefined,
        githubTokenService: undefined,
        skillTrackingService: null,
      } as never,
      state,
      {
        resolveWorktree: vi.fn().mockResolvedValue({
          worktreeId: 'wt-mt',
          worktreePath: '/workspace/.worktrees/mt',
        }),
        initializeRemoteWorkspace: vi.fn().mockResolvedValue(null),
        cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      } as never,
      vi.fn().mockResolvedValue(undefined),
      () => undefined
    );
  });

  afterEach(async () => {
    if (originalMultiTenant === undefined) {
      delete process.env.MULTI_TENANT;
    } else {
      process.env.MULTI_TENANT = originalMultiTenant;
    }
    state.dispose();
    await clearTestDatabase();
  });

  it('returns MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX when env=true and mode=shared', async () => {
    process.env.MULTI_TENANT = 'true';

    // Insert sandbox.mode = shared
    await db.insert(settings).values({
      key: 'sandbox.mode',
      value: JSON.stringify('shared'),
    });

    const codespace = await createTestProject({ id: 'proj-mt-1' });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const result = await service.startAgent({
      codespaceId: codespace.id,
      taskId: task.id,
      sessionId: 'sess-mt-1',
      prompt: 'go',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }

    // Cleanup settings
    await db.delete(settings).where(eq(settings.key, 'sandbox.mode'));
  });

  it('proceeds normally when env=true and mode=per-project', async () => {
    process.env.MULTI_TENANT = 'true';
    await db.insert(settings).values({
      key: 'sandbox.mode',
      value: JSON.stringify('per-project'),
    });

    const codespace = await createTestProject({ id: 'proj-mt-1' });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const result = await service.startAgent({
      codespaceId: codespace.id,
      taskId: task.id,
      sessionId: 'sess-mt-pp',
      prompt: 'go',
    });

    expect(result.ok).toBe(true);

    await db.delete(settings).where(eq(settings.key, 'sandbox.mode'));
  });

  it('rejects shared mode under implicit multi-tenant (multiple users in DB)', async () => {
    delete process.env.MULTI_TENANT; // env unset → implicit inference path
    await createTestUser({ githubLogin: 'alice' });
    await createTestUser({ githubLogin: 'bob' });

    await db.insert(settings).values({
      key: 'sandbox.mode',
      value: JSON.stringify('shared'),
    });

    const codespace = await createTestProject({ id: 'proj-mt-1' });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const result = await service.startAgent({
      codespaceId: codespace.id,
      taskId: task.id,
      sessionId: 'sess-mt-implicit',
      prompt: 'go',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }

    await db.delete(settings).where(eq(settings.key, 'sandbox.mode'));
  });
});
