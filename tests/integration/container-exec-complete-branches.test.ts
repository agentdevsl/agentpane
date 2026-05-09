/**
 * Integration tests for ContainerExecService.handleAgentComplete()
 * worktree auto-commit branches and other edge paths not covered by
 * the existing container-exec-service.test.ts.
 *
 * Targets uncovered ranges 1334-1379 (commit success, commit error, commit
 * throws) and 916-959 / 965-979 (GitHub injection paths and sandbox env
 * application — exercised here via state-only setup that drives the post-
 * commit path).
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { ContainerExecService } from '../../src/services/container-agent/container-exec.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createMockApiKeyService,
  createMockDurableStreamsService,
  createMockSandbox,
  createMockSandboxProvider,
} from '../mocks/mock-services';

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  getFullModelId: vi.fn().mockImplementation((m: string) => m),
}));

vi.mock('../../src/lib/sandbox/skill-injector.js', () => ({
  injectSkills: vi.fn().mockResolvedValue({ injected: 0, skipped: 0, errors: [] }),
}));

vi.mock('../../src/services/template.service.js', () => ({
  TemplateService: class {
    getMergedConfig = vi.fn().mockResolvedValue({ ok: true, value: { skills: [] } });
  },
}));

vi.mock('../../src/lib/agents/container-bridge.js', () => ({
  createContainerBridge: vi.fn().mockImplementation((opts) => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    processStderr: vi.fn(),
    _opts: opts,
  })),
}));

function makeReadable() {
  const r = new Readable({ read() {} });
  r.push(null);
  return r;
}

function makeExecResult() {
  return {
    stdout: makeReadable(),
    stderr: makeReadable(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ContainerExecService.handleAgentComplete — worktree auto-commit branches', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let mockProvider: ReturnType<typeof createMockSandboxProvider>;
  let mockStreams: ReturnType<typeof createMockDurableStreamsService>;
  let mockApiKeyService: ReturnType<typeof createMockApiKeyService>;
  let mockSandbox: ReturnType<typeof createMockSandbox>;
  let mockWorktreeInit: {
    resolveWorktree: ReturnType<typeof vi.fn>;
    initializeRemoteWorkspace: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();

    mockSandbox = createMockSandbox({
      id: 'sb-1',
      codespaceId: 'proj-1',
      containerId: 'c-1',
      status: 'running',
      execStream: vi.fn().mockResolvedValue(makeExecResult()),
    });
    mockProvider = createMockSandboxProvider({
      get: vi.fn().mockResolvedValue(mockSandbox),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      create: vi.fn().mockResolvedValue(mockSandbox),
    });
    mockStreams = createMockDurableStreamsService();
    mockApiKeyService = createMockApiKeyService({
      getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-test'),
    });
    mockWorktreeInit = {
      resolveWorktree: vi.fn(),
      initializeRemoteWorkspace: vi.fn(),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    };
    state = new SandboxStateManager();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  function makeService(worktreeService: unknown) {
    const deps = {
      db: db as any,
      provider: mockProvider,
      streams: mockStreams,
      apiKeyService: mockApiKeyService,
      worktreeService,
      githubTokenService: undefined,
      skillTrackingService: null,
    };
    return new ContainerExecService(
      deps as any,
      state,
      mockWorktreeInit as any,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockReturnValue(undefined)
    );
  }

  async function setupTaskAndAgent(taskId: string, opts: { worktreeId?: string } = {}) {
    const project = await createTestProject({ id: 'proj-1' });
    const task = await createTestTask(project.id, {
      title: 'Auto-commit branch task',
      column: 'in_progress',
    });
    const agentId = `agent-${task.id}`;
    await db.insert(agents).values({
      id: agentId,
      codespaceId: project.id,
      name: 'Container Agent',
      type: 'task',
      status: 'running',
      currentTaskId: task.id,
      currentSessionId: null,
    });
    state.setRunningAgent(task.id, {
      taskId: task.id,
      sessionId: `session-${taskId}`,
      codespaceId: project.id,
      sandboxId: mockSandbox.id,
      bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
      execResult: makeExecResult(),
      stopFilePath: `/tmp/.agent-stop-${task.id}`,
      startedAt: new Date(),
      stopRequested: false,
      phase: 'execute',
      worktreeId: opts.worktreeId,
    });
    return { project, task, agentId };
  }

  it('IT-CE-CMP1: invokes worktreeService.commit on completed status with worktreeId', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: true, value: 'abc123' });
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp1', { worktreeId: 'wt-cmp1' });

    await service.handleAgentComplete(task.id, 'completed', 7);

    expect(commit).toHaveBeenCalledWith('wt-cmp1', expect.stringContaining('completed'));
    const taskRow = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskRow?.column).toBe('waiting_approval');
  });

  it('IT-CE-CMP2: invokes worktreeService.commit on turn_limit status', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: true, value: '' });
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp2', { worktreeId: 'wt-cmp2' });

    await service.handleAgentComplete(task.id, 'turn_limit', 50);

    expect(commit).toHaveBeenCalledWith('wt-cmp2', expect.stringContaining('reached turn limit'));
  });

  it('IT-CE-CMP3: skips worktreeService.commit on cancelled status', async () => {
    const commit = vi.fn();
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp3', { worktreeId: 'wt-cmp3' });

    await service.handleAgentComplete(task.id, 'cancelled', 3);

    expect(commit).not.toHaveBeenCalled();
  });

  it('IT-CE-CMP4: skips worktreeService.commit on error status', async () => {
    const commit = vi.fn();
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp4', { worktreeId: 'wt-cmp4' });

    await service.handleAgentComplete(task.id, 'error', 0);

    expect(commit).not.toHaveBeenCalled();
  });

  it('IT-CE-CMP5: skips worktreeService.commit when no worktreeId on agent', async () => {
    const commit = vi.fn();
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp5'); // no worktreeId

    await service.handleAgentComplete(task.id, 'completed', 5);

    expect(commit).not.toHaveBeenCalled();
  });

  it('IT-CE-CMP6: skips worktreeService.commit when worktreeService is undefined', async () => {
    const service = makeService(undefined);
    const { task } = await setupTaskAndAgent('cmp6', { worktreeId: 'wt-cmp6' });

    await service.handleAgentComplete(task.id, 'completed', 5);
    // Just verify it does not throw — task should still complete
    const taskRow = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskRow?.column).toBe('waiting_approval');
  });

  it('IT-CE-CMP7: publishes a system message on commit error result', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: false, error: new Error('merge conflict') });
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp7', { worktreeId: 'wt-cmp7' });

    await service.handleAgentComplete(task.id, 'completed', 5);

    expect(commit).toHaveBeenCalled();
    expect(mockStreams.publish).toHaveBeenCalledWith(
      expect.any(String),
      'container-agent:message',
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Failed to commit worktree changes'),
      })
    );
  });

  it('IT-CE-CMP8: publishes system message when commit throws', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('git unreachable'));
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp8', { worktreeId: 'wt-cmp8' });

    await service.handleAgentComplete(task.id, 'completed', 5);

    expect(mockStreams.publish).toHaveBeenCalledWith(
      expect.any(String),
      'container-agent:message',
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('git unreachable'),
      })
    );
  });

  it('IT-CE-CMP9: tolerates streams.publish rejection on commit failure (logs warn)', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: false, error: new Error('boom') });
    mockStreams.publish = vi.fn().mockRejectedValue(new Error('stream down'));
    const service = makeService({ commit });
    const { task } = await setupTaskAndAgent('cmp9', { worktreeId: 'wt-cmp9' });

    // Should not throw — publishErr is swallowed by .catch()
    await expect(service.handleAgentComplete(task.id, 'completed', 5)).resolves.not.toThrow();
  });

  it('IT-CE-CMP10: returns early when agent is not in running map', async () => {
    const service = makeService(undefined);
    // Do NOT call setupTaskAndAgent — there's no running agent
    await service.handleAgentComplete('nonexistent-task', 'completed', 5);
    // No assertion needed beyond not throwing — this exercises the early-return branch
    expect(state.hasRunningAgent('nonexistent-task')).toBe(false);
  });
});
