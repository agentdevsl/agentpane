import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_CONFIG } from '../../lib/config/types.js';
import { ProjectErrors } from '../../lib/errors/project-errors.js';
import { ProjectService } from '../project.service.js';

const createDbMock = () => ({
  query: {
    projects: {
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

describe('ProjectService', () => {
  it('creates project with derived name', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue(null);

    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: 'p1', name: 'repo', path: '/tmp/repo', config: DEFAULT_PROJECT_CONFIG },
      ]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new ProjectService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.create({ path: '/tmp/repo' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('repo');
    }
  });

  it('returns error for non-git repo', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const service = new ProjectService(db as never, worktrees as never, {
      exec: vi.fn(async () => {
        throw new Error('not a git repo');
      }),
    });

    const result = await service.validatePath('/tmp/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_NOT_A_GIT_REPO');
    }
  });

  it('returns error when deleting project with running agents', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.query.agents.findMany.mockResolvedValue([{ id: 'a1', status: 'running' }]);

    const service = new ProjectService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.delete('p1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = ProjectErrors.HAS_RUNNING_AGENTS(1);
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('returns default list when no projects', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findMany.mockResolvedValue([]);

    const service = new ProjectService(db as never, worktrees as never, {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
