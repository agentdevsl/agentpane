import { describe, expect, it, vi } from 'vitest';
import { WorktreeErrors } from '../../lib/errors/worktree-errors.js';
import type { CommandResult } from '../worktree.service.js';
import { WorktreeService } from '../worktree.service.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn(() => Promise.resolve()) };
});

const mockAgent = { id: 'a1', name: 'Agent 1', codespaceId: 'p1' };

const createDbMock = () => ({
  query: {
    codespaces: {
      findFirst: vi.fn(),
    },
    agents: {
      findFirst: vi.fn().mockResolvedValue(mockAgent),
    },
    worktrees: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn() })),
    })),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
});

/**
 * F06-NEW-01: WorktreeService now requires `execArgs` on the CommandRunner
 * for every git/cp invocation. `exec` is reserved for the user-authored
 * `initScript` path. Tests construct a runner whose `exec` and `execArgs`
 * share the same mock impl so a single `mockResolvedValueOnce(...)` chain
 * still works regardless of which API path the production code chooses.
 */
type SharedMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<CommandResult>>>;

const createRunner = (impl?: SharedMock | ((...args: unknown[]) => Promise<CommandResult>)) => {
  const fn = (impl ?? vi.fn(async () => ({ stdout: '', stderr: '' }))) as SharedMock;
  return {
    fn,
    runner: {
      exec: fn,
      execArgs: fn,
    },
  };
};

// Standard test input for worktree creation
const createInput = {
  codespaceId: 'p1',
  agentId: 'a1',
  taskId: 't1',
  taskTitle: 'Fix login bug',
};

describe('WorktreeService', () => {
  it('returns error when project missing', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  it('returns error when branch exists', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    const { fn, runner } = createRunner(vi.fn(async () => ({ stdout: 'branch', stderr: '' })));
    const service = new WorktreeService(db as never, runner);

    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_BRANCH_EXISTS');
    }
    // F06-NEW-01: branch-list invocation goes through positional argv
    expect(fn).toHaveBeenCalledWith(
      ['git', 'branch', '--list', expect.stringContaining('fix-login-bug')],
      '/tmp/project'
    );
  });

  it('creates worktree record on success', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees', initScript: undefined },
    });

    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'creating',
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

    const updateReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'active',
      },
    ]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);

    const result = await service.create(createInput, {
      skipEnvCopy: true,
      skipDepsInstall: true,
      skipInitScript: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('w1');
    }
  });

  it('returns error when remove cannot find worktree', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.remove('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('returns ok when list with no worktrees', async () => {
    const db = createDbMock();
    db.query.worktrees.findMany.mockResolvedValue([]);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.list('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it('list returns worktree info', async () => {
    const db = createDbMock();
    db.query.worktrees.findMany.mockResolvedValue([
      {
        id: 'w1',
        branch: 'agent/123/t1',
        status: 'active',
        path: '/tmp/worktree',
        updatedAt: new Date('2024-01-01'),
      },
      {
        id: 'w2',
        branch: 'agent/456/t2',
        status: 'creating',
        path: '/tmp/worktree2',
        updatedAt: null,
      },
    ]);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.list('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toEqual({
        id: 'w1',
        branch: 'agent/123/t1',
        status: 'active',
        path: '/tmp/worktree',
        updatedAt: new Date('2024-01-01'),
      });
    }
  });

  it('getStatus returns worktree status info', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      status: 'active',
      path: '/tmp/worktree',
      updatedAt: new Date('2024-01-01'),
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.getStatus('w1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('w1');
      expect(result.value.branch).toBe('agent/123/t1');
      expect(result.value.status).toBe('active');
    }
  });

  it('getStatus returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.getStatus('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('getByBranch returns worktree when found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      codespaceId: 'p1',
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.getByBranch('p1', 'agent/123/t1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.id).toBe('w1');
    }
  });

  it('getByBranch returns null when not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.getByBranch('p1', 'nonexistent');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('copyEnv returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.copyEnv('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('copyEnv succeeds when worktree exists', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: {
        path: '/tmp/project',
        config: { envFile: '.env.local' },
      },
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.copyEnv('w1');

    expect(result.ok).toBe(true);
    // F06-NEW-01: positional argv with `--` separator.
    expect(fn).toHaveBeenCalledWith(
      ['cp', '--', expect.stringContaining('.env.local'), expect.stringContaining('.env.local')],
      '/tmp/project'
    );
  });

  it('copyEnv returns error when cp fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: {
        path: '/tmp/project',
        config: {},
      },
    });

    const { runner } = createRunner(vi.fn(async () => Promise.reject(new Error('cp failed'))));
    const service = new WorktreeService(db as never, runner);
    const result = await service.copyEnv('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_ENV_COPY_FAILED');
    }
  });

  it('installDeps returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.installDeps('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('installDeps runs bun install successfully', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.installDeps('w1');

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledWith(['bun', 'install'], '/tmp/worktree');
  });

  it('installDeps returns error when bun install fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
    });

    const { runner } = createRunner(
      vi.fn(async () => Promise.reject(new Error('bun install failed')))
    );
    const service = new WorktreeService(db as never, runner);
    const result = await service.installDeps('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('runInitScript returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('runInitScript returns ok when no init script configured', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: {} },
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
  });

  it('runInitScript executes init script', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: 'npm run setup' } },
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    // initScript intentionally goes through `exec` (user-authored shell).
    expect(fn).toHaveBeenCalledWith('npm run setup', '/tmp/worktree');
  });

  it('runInitScript sanitizes control characters', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: 'npm\0 run\x08 setup' } },
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledWith('npm run setup', '/tmp/worktree');
  });

  it('runInitScript returns ok when script is only whitespace after sanitization', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: '   ' } },
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runInitScript returns error when script fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: 'npm run setup' } },
    });

    const { runner } = createRunner(vi.fn(async () => Promise.reject(new Error('script failed'))));
    const service = new WorktreeService(db as never, runner);
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('commit returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.commit('missing', 'message');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('commit returns empty sha when nothing to commit', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git status
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.commit('w1', 'message');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('');
    }
  });

  it('commit creates commit and returns sha', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
    });

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: 'M file.ts', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }); // git rev-parse
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.commit('w1', 'Fix bug');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('abc123');
    }
    // F06-NEW-01: commit message arrives as a literal argv entry, NOT
    // interpolated into a shell string.
    expect(fn).toHaveBeenCalledWith(['git', 'commit', '-m', 'Fix bug'], '/tmp/worktree');
  });

  it('commit returns error when git fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
    });

    const { runner } = createRunner(vi.fn(async () => Promise.reject(new Error('git failed'))));
    const service = new WorktreeService(db as never, runner);
    const result = await service.commit('w1', 'message');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  it('remove successfully removes worktree and branch', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.remove('w1');

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledWith(['git', 'worktree', 'remove', '/tmp/worktree'], '/tmp/project');
    expect(fn).toHaveBeenCalledWith(['git', 'branch', '-D', 'agent/123/t1'], '/tmp/project');
  });

  it('remove with force flag', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const { fn, runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.remove('w1', true);

    expect(result.ok).toBe(true);
    // F06-NEW-01: --force is its own argv element, never string-interpolated.
    expect(fn).toHaveBeenCalledWith(
      ['git', 'worktree', 'remove', '/tmp/worktree', '--force'],
      '/tmp/project'
    );
  });

  it('remove returns error when git fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const { runner } = createRunner(vi.fn(async () => Promise.reject(new Error('git failed'))));
    const service = new WorktreeService(db as never, runner);
    const result = await service.remove('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_REMOVAL_FAILED');
    }
  });

  it('prune removes stale worktrees', async () => {
    const db = createDbMock();
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    db.query.worktrees.findMany.mockResolvedValue([
      {
        id: 'w1',
        branch: 'agent/123/t1',
        path: '/tmp/worktree',
        status: 'active',
        updatedAt: staleDate,
      },
    ]);
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.prune('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pruned).toBe(1);
      expect(result.value.failed).toHaveLength(0);
    }
  });

  it('prune tracks failed removals', async () => {
    const db = createDbMock();
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    db.query.worktrees.findMany.mockResolvedValue([
      {
        id: 'w1',
        branch: 'agent/123/t1',
        path: '/tmp/worktree',
        status: 'active',
        updatedAt: staleDate,
      },
    ]);
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.prune('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pruned).toBe(0);
      expect(result.value.failed).toHaveLength(1);
      expect(result.value.failed[0]?.worktreeId).toBe('w1');
    }
  });

  it('merge returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.merge('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('merge commits and merges to target branch', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status (no changes)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.merge('w1');

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledWith(['git', 'checkout', 'main'], '/tmp/project');
    expect(fn).toHaveBeenCalledWith(
      ['git', 'merge', 'agent/123/t1', '--no-ff', '-m', expect.any(String)],
      '/tmp/project'
    );
  });

  it('merge returns conflict error on merge conflict', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: 'CONFLICT' }) // git merge
      .mockResolvedValueOnce({ stdout: 'file1.ts\nfile2.ts', stderr: '' }) // git diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge --abort
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.merge('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_MERGE_CONFLICT');
    }
  });

  it('merge uses custom target branch', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project' },
    });

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.merge('w1', 'develop');

    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledWith(['git', 'checkout', 'develop'], '/tmp/project');
  });

  it('getDiff returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.getDiff('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('getDiff returns diff statistics', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '10\t5\tfile1.ts\n3\t1\tfile2.ts', stderr: '' }) // numstat
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // full diff
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.getDiff('w1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files).toHaveLength(2);
      expect(result.value.stats.filesChanged).toBe(2);
      expect(result.value.stats.additions).toBe(13);
      expect(result.value.stats.deletions).toBe(6);
    }
    // F06-NEW-01: revspec is a single argv element, never interpolated.
    expect(fn).toHaveBeenCalledWith(['git', 'diff', '--numstat', 'main...HEAD'], '/tmp/worktree');
  });

  it('getDiff returns empty when no changes', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // numstat
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // full diff
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.getDiff('w1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files).toHaveLength(0);
      expect(result.value.stats.filesChanged).toBe(0);
    }
  });

  it('getDiff returns error when git fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
    });

    const { runner } = createRunner(vi.fn(async () => Promise.reject(new Error('git failed'))));
    const service = new WorktreeService(db as never, runner);
    const result = await service.getDiff('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  it('create returns error when git worktree add fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockRejectedValueOnce(new Error('git worktree add failed')); // worktree add
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  it('create returns error when insert fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    db.insert.mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  it('create sets error status when env copy fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'creating',
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: {} },
    });

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('cp failed')); // copyEnv
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_ENV_COPY_FAILED');
    }
  });

  it('create sets error status when deps install fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'creating',
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

    db.query.worktrees.findFirst.mockImplementation(() => ({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: {} },
    }));

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('bun install failed')); // installDeps
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput, { skipEnvCopy: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('create sets error status when init script fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees', initScript: 'npm run setup' },
    });

    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'creating',
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

    db.query.worktrees.findFirst.mockImplementation(() => ({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: { initScript: 'npm run setup' } },
    }));

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const fn = vi
      .fn<(...args: unknown[]) => Promise<CommandResult>>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('init script failed')); // initScript
    const { runner } = createRunner(fn);
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput, { skipEnvCopy: true, skipDepsInstall: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('create returns error when final update fails', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees' },
    });

    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        codespaceId: 'p1',
        branch: 'agent/x/t1',
        path: '/tmp/worktree',
        status: 'creating',
      },
    ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

    const updateReturning = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const { runner } = createRunner();
    const service = new WorktreeService(db as never, runner);
    const result = await service.create(createInput, {
      skipEnvCopy: true,
      skipDepsInstall: true,
      skipInitScript: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    }
  });

  // ── F06-NEW-01 / F06-NEW-03: shell-injection regression tests ──

  describe('F06-NEW-01: shell injection via positional argv', () => {
    it('hostile branch name with `; rm -rf /;` is treated as a literal argv element', async () => {
      const db = createDbMock();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'p1',
        path: '/tmp/project',
        config: { worktreeRoot: '.worktrees' },
      });

      const malicious = "evil'; rm -rf /; echo '";
      const insertReturning = vi.fn().mockResolvedValue([
        {
          id: 'w1',
          codespaceId: 'p1',
          branch: malicious,
          path: '/tmp/worktree',
          status: 'creating',
        },
      ]);
      db.insert.mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

      const updateReturning = vi.fn().mockResolvedValue([
        {
          id: 'w1',
          codespaceId: 'p1',
          branch: malicious,
          path: '/tmp/worktree',
          status: 'active',
        },
      ]);
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
      });

      const { fn, runner } = createRunner();
      const service = new WorktreeService(db as never, runner);
      // Use the malicious string as a task title fragment so the slugified
      // branch contains the dangerous chars (slug-style: rejected mostly).
      // We instead exercise `commit()` where the message arrives raw.
      const wt = await service.create(
        { ...createInput, taskTitle: 'safe-title' },
        { skipEnvCopy: true, skipDepsInstall: true, skipInitScript: true }
      );
      expect(wt.ok).toBe(true);

      // For commit(): the message is LLM-controlled and may contain ANY
      // shell metachar. Verify it arrives as a single argv string.
      db.query.worktrees.findFirst.mockResolvedValue({
        id: 'w1',
        branch: 'safe-title-t1',
        path: '/tmp/worktree',
      });
      fn.mockReset();
      fn.mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: 'M file.ts', stderr: '' }) // git status
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '' }); // git rev-parse

      await service.commit('w1', malicious);

      // The malicious string must appear as a SINGLE argv element, not
      // split into separate shell tokens by `;` or quote-broken interpolation.
      const commitCall = fn.mock.calls.find(
        (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('commit')
      );
      expect(commitCall).toBeDefined();
      const argv = commitCall![0] as string[];
      expect(argv).toEqual(['git', 'commit', '-m', malicious]);
      // Critical: the malicious payload is NOT shell-interpolated into a
      // multi-statement string. It's a single argv element.
      expect(argv.some((a) => a === malicious)).toBe(true);
      expect(argv.some((a) => a.includes('rm -rf') && a !== malicious)).toBe(false);
    });

    it('hostile path in copyEnv goes through `cp -- src target` argv', async () => {
      const db = createDbMock();
      db.query.worktrees.findFirst.mockResolvedValue({
        id: 'w1',
        path: '/tmp/worktree',
        codespace: {
          path: '/tmp/project',
          // envFile from codespace config is admin-controlled but a hostile
          // admin (or compromised setting) could specify an injection.
          config: { envFile: '.env"; rm -rf /; #' },
        },
      });

      const { fn, runner } = createRunner();
      const service = new WorktreeService(db as never, runner);
      await service.copyEnv('w1');

      const argv = fn.mock.calls[0]![0] as string[];
      expect(argv[0]).toBe('cp');
      expect(argv[1]).toBe('--');
      // Source and target paths each contain the malicious string verbatim
      // — but they're SEPARATE argv elements, so `cp` sees them as filenames.
      expect(argv[2]).toContain('.env"; rm -rf /; #');
      expect(argv[3]).toContain('.env"; rm -rf /; #');
    });

    it('runner without execArgs (legacy stub) throws on git operations', async () => {
      const db = createDbMock();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'p1',
        path: '/tmp/project',
        config: { worktreeRoot: '.worktrees' },
      });

      const legacyRunner = { exec: vi.fn(async () => ({ stdout: '', stderr: '' })) };
      const service = new WorktreeService(db as never, legacyRunner);

      // F06-NEW-01: a runner without `execArgs` is rejected by the service
      // when it reaches the first git/cp call. The branch-check is the
      // first such call in `create()` — `requireExecArgs` throws which
      // propagates straight up because the throw is OUTSIDE the try/catch
      // (the type-checker enforces it via `requireExecArgs`).
      await expect(service.create(createInput)).rejects.toThrow(
        /CommandRunner\.execArgs is required/
      );
    });
  });

  describe('F06-NEW-06: validateShellCommand hardening', () => {
    it('rejects U+2028 line separator', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('foo\u2028bar')).toThrow();
    });

    it('rejects U+2029 paragraph separator', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('foo\u2029bar')).toThrow();
    });

    it('rejects NULL byte', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('foo\u0000bar')).toThrow();
    });

    it('rejects standalone `&`', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('cmd & other')).toThrow();
    });

    it('rejects redirection `>` and `<`', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('cmd > file')).toThrow();
      expect(() => validateShellCommand('cmd < file')).toThrow();
    });

    it('rejects shell variable-expansion sequence', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-expansion sequence is the test input
      const dollarBrace = '${HOME}';
      expect(() => validateShellCommand(`echo ${dollarBrace}`)).toThrow();
    });

    it('rejects backslash-newline continuation', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('cmd \\\nother')).toThrow();
    });

    it('rejects `\\t` tab', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('cmd\twith\ttab')).toThrow();
    });

    it('rejects `\\v` vertical tab', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('cmd\vwith\vvtab')).toThrow();
    });

    it('still rejects original metacharacters', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('a; b')).toThrow();
      expect(() => validateShellCommand('a | b')).toThrow();
      expect(() => validateShellCommand('a `b`')).toThrow();
      expect(() => validateShellCommand('a $(b)')).toThrow();
      expect(() => validateShellCommand('a && b')).toThrow();
      expect(() => validateShellCommand('a || b')).toThrow();
      expect(() => validateShellCommand('a\nb')).toThrow();
      expect(() => validateShellCommand('a\rb')).toThrow();
    });

    it('accepts plain alphanumeric command', async () => {
      const { validateShellCommand } = await import('../worktree.service.js');
      expect(() => validateShellCommand('npm run setup')).not.toThrow();
      expect(() => validateShellCommand('git status')).not.toThrow();
    });
  });
});
