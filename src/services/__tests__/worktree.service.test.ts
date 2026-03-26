import { describe, expect, it, vi } from 'vitest';
import { WorktreeErrors } from '../../lib/errors/worktree-errors.js';
import { WorktreeService } from '../worktree.service.js';

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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi.fn(async () => ({ stdout: 'branch', stderr: '' }));
    const service = new WorktreeService(db as never, { exec });

    const result = await service.create(createInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_BRANCH_EXISTS');
    }
  });

  it('creates worktree record on success', async () => {
    const db = createDbMock();
    db.query.codespaces.findFirst.mockResolvedValue({
      id: 'p1',
      path: '/tmp/project',
      config: { worktreeRoot: '.worktrees', initScript: undefined },
    });

    // Mock insert returning the initial worktree record
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

    // Mock update returning the activated worktree record
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

    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new WorktreeService(db as never, { exec });

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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
    const result = await service.remove('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(WorktreeErrors.NOT_FOUND);
    }
  });

  it('returns ok when list with no worktrees', async () => {
    const db = createDbMock();
    db.query.worktrees.findMany.mockResolvedValue([]);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
    const result = await service.list('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  // TODO: Fix this test - existsSync check filters out mock paths
  it.skip('list returns worktree info', async () => {
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
    const result = await service.getByBranch('p1', 'agent/123/t1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.id).toBe('w1');
    }
  });

  it('getByBranch returns null when not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
    const result = await service.getByBranch('p1', 'nonexistent');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('copyEnv returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.copyEnv('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('cp'), '/tmp/project');
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

    const exec = vi.fn().mockRejectedValue(new Error('cp failed'));
    const service = new WorktreeService(db as never, { exec });
    const result = await service.copyEnv('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_ENV_COPY_FAILED');
    }
  });

  it('installDeps returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.installDeps('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('bun install', '/tmp/worktree');
  });

  it('installDeps returns error when bun install fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
    });

    const exec = vi.fn().mockRejectedValue(new Error('bun install failed'));
    const service = new WorktreeService(db as never, { exec });
    const result = await service.installDeps('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('runInitScript returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('npm run setup', '/tmp/worktree');
  });

  it('runInitScript sanitizes control characters', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: 'npm\0 run\x08 setup' } },
    });

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('npm run setup', '/tmp/worktree');
  });

  it('runInitScript returns ok when script is only whitespace after sanitization', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: '   ' } },
    });

    const exec = vi.fn();
    const service = new WorktreeService(db as never, { exec });
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('runInitScript returns error when script fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { config: { initScript: 'npm run setup' } },
    });

    const exec = vi.fn().mockRejectedValue(new Error('script failed'));
    const service = new WorktreeService(db as never, { exec });
    const result = await service.runInitScript('w1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    }
  });

  it('commit returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git status

    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: 'M file.ts', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }); // git rev-parse

    const service = new WorktreeService(db as never, { exec });
    const result = await service.commit('w1', 'Fix bug');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('abc123');
    }
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('git commit'), '/tmp/worktree');
  });

  it('commit returns error when git fails', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      path: '/tmp/worktree',
    });

    const exec = vi.fn().mockRejectedValue(new Error('git failed'));
    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.remove('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      '/tmp/project'
    );
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('git branch -D'), '/tmp/project');
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
    const result = await service.remove('w1', true);

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('--force'), '/tmp/project');
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

    const exec = vi.fn().mockRejectedValue(new Error('git failed'));
    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status (no changes)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge

    const service = new WorktreeService(db as never, { exec });
    const result = await service.merge('w1');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('git checkout'), '/tmp/project');
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('git merge'), '/tmp/project');
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: 'CONFLICT' }) // git merge
      .mockResolvedValueOnce({ stdout: 'file1.ts\nfile2.ts', stderr: '' }); // git diff

    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge

    const service = new WorktreeService(db as never, { exec });
    const result = await service.merge('w1', 'develop');

    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('git checkout "develop"'),
      '/tmp/project'
    );
  });

  it('getDiff returns error when worktree not found', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue(null);

    const service = new WorktreeService(db as never, { exec: vi.fn() });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '10\t5\tfile1.ts\n3\t1\tfile2.ts', stderr: '' }) // numstat
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // full diff

    const service = new WorktreeService(db as never, { exec });
    const result = await service.getDiff('w1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files).toHaveLength(2);
      expect(result.value.stats.filesChanged).toBe(2);
      expect(result.value.stats.additions).toBe(13);
      expect(result.value.stats.deletions).toBe(6);
    }
  });

  it('getDiff returns empty when no changes', async () => {
    const db = createDbMock();
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      branch: 'agent/123/t1',
      baseBranch: 'main',
      path: '/tmp/worktree',
    });

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // numstat
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // full diff

    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi.fn().mockRejectedValue(new Error('git failed'));
    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockRejectedValueOnce(new Error('git worktree add failed')); // worktree add

    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
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

    // For worktree lookup in copyEnv
    db.query.worktrees.findFirst.mockResolvedValue({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: {} },
    });

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('cp failed')); // copyEnv

    const service = new WorktreeService(db as never, { exec });
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

    // For worktree lookups
    db.query.worktrees.findFirst.mockImplementation(() => ({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: {} },
    }));

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('bun install failed')); // installDeps (skipEnvCopy=true)

    const service = new WorktreeService(db as never, { exec });
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

    // For worktree lookups
    db.query.worktrees.findFirst.mockImplementation(() => ({
      id: 'w1',
      path: '/tmp/worktree',
      codespace: { path: '/tmp/project', config: { initScript: 'npm run setup' } },
    }));

    const updateWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      .mockRejectedValueOnce(new Error('init script failed')); // initScript

    const service = new WorktreeService(db as never, { exec });
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

    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const service = new WorktreeService(db as never, { exec });
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
});
