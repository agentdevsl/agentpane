import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODESPACE_CONFIG } from '../../lib/config/types.js';
import { CodespaceErrors } from '../../lib/errors/codespace-errors.js';
import { CodespaceService } from '../codespace.service.js';

const createDbMock = () => ({
  query: {
    codespaces: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    agents: {
      findMany: vi.fn(),
    },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
});

const createWorktreeServiceMock = () => ({
  prune: vi.fn(),
});

describe('CodespaceService', () => {
  it('creates codespace with derived name', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.codespaces.findFirst.mockResolvedValue(null);

    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: 'p1', name: 'repo', path: '/tmp/repo', config: DEFAULT_CODESPACE_CONFIG },
      ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new CodespaceService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.create({ projectFolderId: 'pf1', path: '/tmp/repo' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('repo');
    }
  });

  it('returns error for non-git repo', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const service = new CodespaceService(db as never, worktrees as never, {
      exec: vi.fn(async () => {
        throw new Error('not a git repo');
      }),
    });

    const result = await service.validatePath('/tmp/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CODESPACE_NOT_A_GIT_REPO');
    }
  });

  it('returns error when deleting codespace with running agents', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.codespaces.findFirst.mockResolvedValue({ id: 'p1' });
    db.query.agents.findMany.mockResolvedValue([{ id: 'a1', status: 'running' }]);

    const service = new CodespaceService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.delete('p1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = CodespaceErrors.HAS_RUNNING_AGENTS(1);
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('returns default list when no codespaces', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.codespaces.findMany.mockResolvedValue([]);

    const service = new CodespaceService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  // ── F06-02: cloneRepository uses positional argv ──

  it('F06-02: cloneRepository routes through execArgs when available (no shell interp)', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    const calls: Array<{ kind: 'exec' | 'execArgs'; value: unknown[] }> = [];
    const execArgs = vi.fn(async (argv: string[], _cwd: string) => {
      calls.push({ kind: 'execArgs', value: [...argv] });
      // `test -d` should fail (directory doesn't exist yet) so clone proceeds
      if (argv[0] === 'test' && argv[1] === '-d') {
        throw new Error('not a directory');
      }
      return { stdout: '', stderr: '' };
    });
    const exec = vi.fn(async (cmd: string, _cwd: string) => {
      calls.push({ kind: 'exec', value: [cmd] });
      return { stdout: '', stderr: '' };
    });

    const service = new CodespaceService(db as never, worktrees as never, { exec, execArgs });

    const result = await service.cloneRepository('https://github.com/org/repo.git', '/tmp/clones');

    expect(result.ok).toBe(true);
    // Every command went through execArgs — `exec` was not invoked at all.
    expect(exec).not.toHaveBeenCalled();
    // Clone call uses `--` separator to prevent hostile URLs starting with
    // `-` from being interpreted as git-clone options.
    const cloneCall = execArgs.mock.calls.find((c) => c[0][0] === 'git');
    expect(cloneCall).toBeDefined();
    expect(cloneCall![0]).toEqual([
      'git',
      'clone',
      '--',
      'https://github.com/org/repo.git',
      '/tmp/clones/repo',
    ]);
  });

  it('F06-02: cloneRepository rejects leading-dash URLs even though argv is safe', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    const execArgs = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const service = new CodespaceService(db as never, worktrees as never, { exec, execArgs });

    // `--upload-pack=malicious` is a real git-clone flag injection vector
    // when a hostile URL begins with `-`. We reject at the service layer.
    const result = await service.cloneRepository('--upload-pack=/tmp/pwn', '/tmp/clones');

    expect(result.ok).toBe(false);
    expect(execArgs).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('F06-02: cloneRepository with hostile URL passes metachars literally through execArgs', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    const execArgs = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'test' && argv[1] === '-d') {
        throw new Error('not a dir');
      }
      return { stdout: '', stderr: '' };
    });
    const exec = vi.fn();

    const service = new CodespaceService(db as never, worktrees as never, { exec, execArgs });

    // A URL containing `$(...)`, backticks, semicolons. These are valid
    // characters inside a URL string and must pass through to git literally.
    const hostileUrl = 'https://user:$(whoami)@git/repo.git';
    const result = await service.cloneRepository(hostileUrl, '/tmp/clones');

    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    const cloneCall = execArgs.mock.calls.find((c) => c[0][0] === 'git' && c[0][1] === 'clone');
    expect(cloneCall).toBeDefined();
    // The hostile URL is in argv[3] verbatim — no shell ever saw it.
    expect(cloneCall![0][3]).toBe(hostileUrl);
  });
});
