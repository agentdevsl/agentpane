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
});
