import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGitToken } from '../../lib/sandbox/git-token-resolver.js';
import { initializeK8sWorkspace } from '../../lib/sandbox/k8s-workspace-initializer.js';
import { ContainerAgentService } from '../container-agent.service.js';

vi.mock('../../lib/sandbox/git-token-resolver.js', () => ({
  resolveGitToken: vi.fn(),
  deriveGitHubFromPath: vi.fn().mockReturnValue(null),
}));
vi.mock('../../lib/sandbox/k8s-workspace-initializer.js', () => ({
  initializeK8sWorkspace: vi.fn(),
}));

/**
 * Minimal mocks for ContainerAgentService constructor dependencies.
 */

// --- DB Mock ---
function createDbMock() {
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(),
      run: vi.fn(),
    })),
    run: vi.fn(),
  }));

  return {
    query: {
      codespaces: { findFirst: vi.fn() },
      agents: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
      worktrees: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn() })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

// --- Sandbox Provider Mock ---
/** Create a mock readable stream compatible with readline.createInterface */
function createMockReadableStream() {
  const { Readable } = require('node:stream');
  const stream = new Readable({ read() {} });
  stream.push(null); // immediately end the stream
  return stream;
}

function createProviderMock() {
  const sandbox = {
    id: 'sandbox-1',
    status: 'running' as const,
    containerId: 'abc123def456',
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execStream: vi.fn().mockResolvedValue({
      stdout: createMockReadableStream(),
      stderr: createMockReadableStream(),
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn(),
    }),
  };
  return {
    get: vi.fn().mockResolvedValue(sandbox),
    getById: vi.fn().mockResolvedValue(sandbox),
    sandbox,
  };
}

// --- Streams Mock ---
function createStreamsMock() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

// --- API Key Mock ---
function createApiKeyMock() {
  return {
    getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat01-test-token'),
  };
}

// --- Worktree Service Mock ---
function createWorktreeMock(overrides?: Record<string, string>) {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'wt-1',
        branch: 'fix-login-abc123',
        path: '/Users/test/project/.worktrees/fix-login-abc123',
        ...overrides,
      },
    }),
    getStatus: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'wt-1',
        branch: 'fix-login-abc123',
        status: 'active',
        path: '/Users/test/project/.worktrees/fix-login-abc123',
      },
    }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    commit: vi.fn().mockResolvedValue({ ok: true, value: 'abc123' }),
  };
}

// --- K8s Sandbox Provider Mock ---
function createK8sProviderMock() {
  const sandbox = {
    id: 'sandbox-k8s-1',
    status: 'running' as const,
    containerId: 'k8s-pod-abc123',
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execStream: vi.fn().mockResolvedValue({
      stdout: createMockReadableStream(),
      stderr: createMockReadableStream(),
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn(),
    }),
  };
  return {
    name: 'kubernetes',
    get: vi.fn().mockResolvedValue(sandbox),
    getById: vi.fn().mockResolvedValue(sandbox),
    sandbox,
  };
}

// --- GitHub Token Service Mock ---
function createGithubTokenServiceMock() {
  return {
    getDecryptedToken: vi.fn().mockResolvedValue('ghp_test123'),
  };
}

describe('ContainerAgentService — worktree integration', () => {
  let db: ReturnType<typeof createDbMock>;
  let provider: ReturnType<typeof createProviderMock>;
  let streams: ReturnType<typeof createStreamsMock>;
  let apiKey: ReturnType<typeof createApiKeyMock>;
  let worktreeService: ReturnType<typeof createWorktreeMock>;
  let service: ContainerAgentService;

  const project = {
    id: 'p1',
    name: 'Test Project',
    path: '/Users/test/project',
    config: { model: 'claude-sonnet-4-6' },
  };

  const task = {
    id: 't1',
    title: 'Fix login bug',
    codespaceId: 'p1',
    worktreeId: null as string | null,
  };

  beforeEach(() => {
    db = createDbMock();
    provider = createProviderMock();
    streams = createStreamsMock();
    apiKey = createApiKeyMock();
    worktreeService = createWorktreeMock();

    db.query.codespaces.findFirst.mockResolvedValue(project);
    db.query.tasks.findFirst.mockResolvedValue(task);

    service = new ContainerAgentService(
      db as never,
      provider as never,
      streams as never,
      apiKey as never,
      worktreeService as never
    );
  });

  // --- Task 1: Path translation ---

  it('translates worktree path to /workspace/... format on creation', async () => {
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // The execStream should be called with AGENT_CWD = /workspace/.worktrees/fix-login-abc123
    const execStreamCall = provider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace/.worktrees/fix-login-abc123');
  });

  it('translates recovered worktree path for execution phase', async () => {
    // Task already has worktreeId from planning phase
    db.query.tasks.findFirst.mockResolvedValue({
      ...task,
      worktreeId: 'wt-1',
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Execute plan',
      phase: 'execute',
      sdkSessionId: 'sdk-123',
    });

    const execStreamCall = provider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace/.worktrees/fix-login-abc123');
  });

  it('falls back to /workspace when worktree creation fails', async () => {
    worktreeService.create.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_CREATION_FAILED', message: 'git error' },
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const execStreamCall = provider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace');
  });

  // --- Task 2: Cleanup ---

  it('commits worktree changes on completed status', async () => {
    // Start agent to populate running agents
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Simulate completion via the internal method (accessed via prototype)
    const handleComplete = (service as any).containerExec.handleAgentComplete.bind(
      (service as any).containerExec
    );
    await handleComplete('t1', 'completed', 5);

    expect(worktreeService.commit).toHaveBeenCalledWith(
      'wt-1',
      expect.stringContaining('completed')
    );
  });

  it('cleans up worktree on cancelled status', async () => {
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const handleComplete = (service as any).containerExec.handleAgentComplete.bind(
      (service as any).containerExec
    );
    await handleComplete('t1', 'cancelled', 0);

    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  it('cleans up worktree on agent error', async () => {
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const handleError = (service as any).containerExec.handleAgentError.bind(
      (service as any).containerExec
    );
    await handleError('t1', 'SDK crash', 2);

    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  it('cleans up worktree and clears task fields on plan rejection', async () => {
    // Set up task with worktreeId
    db.query.tasks.findFirst.mockReturnValue({
      ...task,
      worktreeId: 'wt-1',
      plan: 'Some plan',
      lastAgentStatus: 'planning',
    } as any);

    // Override db.update mock so the atomic WHERE guard with lastAgentStatus='planning'
    // returns a row (simulating a successful update)
    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 't1' }]),
          run: vi.fn(),
        })),
        run: vi.fn(),
      })),
    });

    // Put a pending plan in memory
    (service as any).state.setPendingPlan('t1', {
      taskId: 't1',
      sessionId: 's1',
      codespaceId: 'p1',
      plan: 'Some plan',
      turnCount: 3,
      sdkSessionId: 'sdk-1',
      createdAt: new Date(),
    });

    const result = await service.rejectPlan('t1', 'Bad plan');

    expect(result.ok).toBe(true);

    // Should have cleared worktreeId and branch in the DB update
    // Verify DB update was called (to set worktreeId/branch to null)
    expect(db.update).toHaveBeenCalled();

    // Worktree removal is async/best-effort
    // Give it a tick to fire
    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  // --- Path translation edge cases ---

  it('returns /workspace when paths do not match', () => {
    const translate = (service as any).worktreeInit.translatePathForContainer.bind(
      (service as any).worktreeInit
    );
    expect(translate('/other/path/.worktrees/foo', '/Users/test/project')).toBe('/workspace');
  });

  it('handles trailing slash correctly', () => {
    const translate = (service as any).worktreeInit.translatePathForContainer.bind(
      (service as any).worktreeInit
    );
    // Path without trailing slash on host
    expect(translate('/Users/test/project/.worktrees/foo', '/Users/test/project')).toBe(
      '/workspace/.worktrees/foo'
    );
  });

  // --- Gap 1: Early error path worktree cleanup ---

  it('cleans up worktree when execStream fails after worktree creation', async () => {
    // Make execStream throw to simulate container exec failure
    provider.sandbox.execStream.mockRejectedValue(new Error('Container exec failed'));

    const result = await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Agent start should fail
    expect(result.ok).toBe(false);

    // Worktree should have been cleaned up
    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  // --- Gap 3: stopAgent worktree cleanup ---

  it('cleans up worktree as safety net during stopAgent', async () => {
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const result = await service.stopAgent('t1');
    expect(result.ok).toBe(true);

    // Worktree should have been cleaned up directly in stopAgent
    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  // --- Gap 4: handlePlanReady DB failure worktree cleanup ---

  it('cleans up worktree when plan DB persistence fails in handlePlanReady', async () => {
    // Start agent to populate running agents with a worktree
    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Make db.update throw to simulate DB failure during plan persistence.
    // The Drizzle ORM chain is: db.update(table).set({...}).where(eq(...))
    // The await resolves at .where(), so .where() must throw to trigger the catch.
    db.update.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => {
          throw new Error('DB write failed');
        }),
        run: vi.fn(),
      })),
    }));

    // Trigger handlePlanReady and await it (async method)
    const handlePlanReady = (service as any).planApproval.handlePlanReady.bind(
      (service as any).planApproval
    );
    await handlePlanReady('t1', 's1', 'p1', {
      plan: 'Test plan',
      turnCount: 3,
      sdkSessionId: 'sdk-1',
    });

    // cleanupWorktree is called with `void` (fire-and-forget) inside the catch,
    // so flush the microtask queue to let the promise settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Worktree should have been cleaned up
    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
  });

  // --- Gap 7: cleanupWorktree treats NOT_FOUND as success ---

  it('treats NOT_FOUND error as success in cleanupWorktree', async () => {
    worktreeService.remove.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_NOT_FOUND', message: 'Worktree not found' },
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Trigger error handler which calls cleanupWorktree
    const handleError = (service as any).containerExec.handleAgentError.bind(
      (service as any).containerExec
    );
    await handleError('t1', 'SDK crash', 2);

    // Should have called remove (even though it returned NOT_FOUND)
    expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
    // Should not throw — NOT_FOUND is treated as success
  });

  // --- Gap 9: Concurrent startAgent race protection ---

  it('prevents concurrent startAgent calls for the same task', async () => {
    // First call succeeds and registers as running
    const result1 = await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });
    expect(result1.ok).toBe(true);

    // Second call should fail because the first agent is already running
    const result2 = await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's2',
      prompt: 'Fix the bug',
      phase: 'plan',
    });
    expect(result2.ok).toBe(false);
  });
});

describe('ContainerAgentService — K8s worktree integration', () => {
  let db: ReturnType<typeof createDbMock>;
  let k8sProvider: ReturnType<typeof createK8sProviderMock>;
  let streams: ReturnType<typeof createStreamsMock>;
  let apiKey: ReturnType<typeof createApiKeyMock>;
  let worktreeService: ReturnType<typeof createWorktreeMock>;
  let githubTokenService: ReturnType<typeof createGithubTokenServiceMock>;
  let service: ContainerAgentService;

  const project = {
    id: 'p1',
    name: 'Test Project',
    path: '/Users/test/project',
    githubOwner: 'test-org',
    githubRepo: 'test-repo',
    githubInstallationId: null as string | null,
    config: { model: 'claude-sonnet-4-6' },
  };

  const task = {
    id: 't1',
    title: 'Fix login bug',
    codespaceId: 'p1',
    worktreeId: null as string | null,
    branch: null as string | null,
  };

  beforeEach(() => {
    db = createDbMock();
    k8sProvider = createK8sProviderMock();
    streams = createStreamsMock();
    apiKey = createApiKeyMock();
    worktreeService = createWorktreeMock();
    githubTokenService = createGithubTokenServiceMock();

    db.query.codespaces.findFirst.mockResolvedValue(project);
    db.query.tasks.findFirst.mockResolvedValue(task);

    vi.mocked(resolveGitToken).mockReset();
    vi.mocked(initializeK8sWorkspace).mockReset();

    service = new ContainerAgentService(
      db as never,
      k8sProvider as never,
      streams as never,
      apiKey as never,
      worktreeService as never,
      githubTokenService as never
    );
  });

  it('K8s provider skips host WorktreeService', async () => {
    vi.mocked(resolveGitToken).mockResolvedValue({
      token: 'ghp_test',
      owner: 'test-org',
      repo: 'test-repo',
    });
    vi.mocked(initializeK8sWorkspace).mockResolvedValue({
      worktreePath: '/workspace/.worktrees/fix-login-bug-abc123',
      branch: 'fix-login-bug-abc123',
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Host WorktreeService.create should NOT be called for K8s
    expect(worktreeService.create).not.toHaveBeenCalled();

    // AGENT_CWD should match the K8s worktree path
    const execStreamCall = k8sProvider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace/.worktrees/fix-login-bug-abc123');
  });

  it('planning phase clones + creates worktree, passes correct AGENT_CWD', async () => {
    vi.mocked(resolveGitToken).mockResolvedValue({
      token: 'ghp_test',
      owner: 'org',
      repo: 'repo',
    });
    vi.mocked(initializeK8sWorkspace).mockResolvedValue({
      worktreePath: '/workspace/.worktrees/fix-bug-abc123',
      branch: 'fix-bug-abc123',
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const execStreamCall = k8sProvider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace/.worktrees/fix-bug-abc123');
  });

  it('codespaces without GitHub config fall back to empty /workspace', async () => {
    // Override project to have no GitHub config
    db.query.codespaces.findFirst.mockResolvedValue({
      ...project,
      githubOwner: null,
      githubRepo: null,
    });

    vi.mocked(resolveGitToken).mockResolvedValue(null);

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const execStreamCall = k8sProvider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace');
  });

  it('git clone failure falls back gracefully to /workspace', async () => {
    vi.mocked(resolveGitToken).mockResolvedValue({
      token: 'ghp_test',
      owner: 'test-org',
      repo: 'test-repo',
    });
    // Simulate clone/worktree failure — initializeK8sWorkspace returns fallback
    vi.mocked(initializeK8sWorkspace).mockResolvedValue({
      worktreePath: '/workspace',
      branch: null,
    });

    await service.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    const execStreamCall = k8sProvider.sandbox.execStream.mock.calls[0]!;
    const env = (execStreamCall[0] as { env: Record<string, string> }).env;
    expect(env.AGENT_CWD).toBe('/workspace');
  });

  it('Docker mode is unaffected (regression test)', async () => {
    // Create a Docker provider (default, no name or name='docker')
    const dockerProvider = createProviderMock();
    const dockerService = new ContainerAgentService(
      db as never,
      dockerProvider as never,
      streams as never,
      apiKey as never,
      worktreeService as never
    );

    await dockerService.startAgent({
      codespaceId: 'p1',
      taskId: 't1',
      sessionId: 's1',
      prompt: 'Fix the bug',
      phase: 'plan',
    });

    // Host WorktreeService.create SHOULD be called for Docker
    expect(worktreeService.create).toHaveBeenCalled();

    // resolveGitToken should NOT be called for Docker
    expect(resolveGitToken).not.toHaveBeenCalled();
  });
});
