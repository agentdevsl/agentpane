import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree, WorktreeStatus } from '@/db/schema';
import { WorktreeErrors } from '@/lib/errors/worktree-errors';
import { err, ok } from '@/lib/utils/result';
import { createWorktreesRoutes } from '@/server/routes/worktrees';

const sampleWorktree: Worktree = {
  id: 'worktree-1',
  codespaceId: 'proj-1',
  taskId: 'task-1',
  branch: 'agent/abc123/task-1',
  path: '/tmp/worktrees/agent-abc123-task-1',
  baseBranch: 'main',
  status: 'active' as WorktreeStatus,
  mergedAt: null,
  removedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const sampleWorktreeStatus = {
  id: sampleWorktree.id,
  branch: sampleWorktree.branch,
  status: sampleWorktree.status,
  path: sampleWorktree.path,
  updatedAt: sampleWorktree.updatedAt,
};

describe('Worktree API', () => {
  // Mock worktree service
  const mockWorktreeService = {
    list: vi.fn(),
    create: vi.fn(),
    getStatus: vi.fn(),
    remove: vi.fn(),
    getDiff: vi.fn(),
    commit: vi.fn(),
    merge: vi.fn(),
    prune: vi.fn(),
  };

  // Create app instance
  let app: ReturnType<typeof createWorktreesRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createWorktreesRoutes({
      worktreeService: mockWorktreeService as never,
    });
  });

  describe('GET /api/worktrees', () => {
    it('lists worktrees for a project', async () => {
      mockWorktreeService.list.mockResolvedValue(ok([sampleWorktreeStatus]));

      const response = await app.request('/?codespaceId=az2h33gpcldsq0a0wdimza6m');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.items).toHaveLength(1);
      expect(data.data.items[0].id).toBe(sampleWorktree.id);
    });

    it('validates codespaceId is required', async () => {
      const response = await app.request('/');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('MISSING_PARAMS');
    });
  });

  describe('POST /api/worktrees', () => {
    it('creates a worktree', async () => {
      mockWorktreeService.create.mockResolvedValue(ok(sampleWorktree));

      const response = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codespaceId: 'az2h33gpcldsq0a0wdimza6m',
          agentId: 'agent-1',
          taskId: 'bz3h44gpcldsq0a0xdimza7n',
          taskTitle: 'Test task',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.id).toBe(sampleWorktree.id);
    });

    it('validates required fields', async () => {
      const response = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codespaceId: 'az2h33gpcldsq0a0wdimza6m',
          taskId: 'bz3h44gpcldsq0a0xdimza7n',
          // Missing agentId and taskTitle
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/worktrees/:id', () => {
    it('gets worktree status', async () => {
      mockWorktreeService.getStatus.mockResolvedValue(ok(sampleWorktreeStatus));

      const response = await app.request('/worktree-1');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.id).toBe(sampleWorktree.id);
    });

    it('returns 404 for missing worktree', async () => {
      mockWorktreeService.getStatus.mockResolvedValue(err(WorktreeErrors.NOT_FOUND));

      const response = await app.request('/worktree-404');

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/worktrees/:id', () => {
    it('removes a worktree', async () => {
      mockWorktreeService.remove.mockResolvedValue(ok(undefined));

      const response = await app.request('/worktree-1', {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data).toBeNull();
    });

    it('returns 400 for missing worktree', async () => {
      mockWorktreeService.remove.mockResolvedValue(err(WorktreeErrors.NOT_FOUND));

      const response = await app.request('/worktree-404', {
        method: 'DELETE',
      });

      // Route returns 400 for WORKTREE_NOT_FOUND error code (not 404)
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  describe('GET /api/worktrees/:id/diff', () => {
    it('gets worktree diff', async () => {
      const diff = {
        files: [
          { path: 'src/index.ts', status: 'modified', additions: 5, deletions: 2, hunks: [] },
        ],
        stats: { filesChanged: 1, additions: 5, deletions: 2 },
      };
      mockWorktreeService.getDiff.mockResolvedValue(ok(diff));

      const response = await app.request('/worktree-1/diff');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.stats.filesChanged).toBe(1);
    });

    it('returns 400 for missing worktree', async () => {
      mockWorktreeService.getDiff.mockResolvedValue(err(WorktreeErrors.NOT_FOUND));

      const response = await app.request('/worktree-404/diff');

      // Route returns 400 for WORKTREE_NOT_FOUND error code (not 404)
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  describe('POST /api/worktrees/:id/commit', () => {
    it('commits changes', async () => {
      const sha = 'abc123def456';
      mockWorktreeService.commit.mockResolvedValue(ok(sha));

      const response = await app.request('/worktree-1/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'feat: add new feature',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.sha).toBe(sha);
    });

    it('validates message is required', async () => {
      const response = await app.request('/worktree-1/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/worktrees/:id/merge', () => {
    it('merges worktree to target branch', async () => {
      mockWorktreeService.merge.mockResolvedValue(ok(undefined));

      const response = await app.request('/worktree-1/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetBranch: 'develop',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.merged).toBe(true);
    });

    it('returns 409 for merge conflicts', async () => {
      mockWorktreeService.merge.mockResolvedValue(
        err({
          code: 'MERGE_CONFLICT',
          message: 'Merge conflict detected',
          details: { files: ['src/index.ts'] },
        })
      );

      const response = await app.request('/worktree-1/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetBranch: 'develop',
        }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('MERGE_CONFLICT');
      expect(data.conflicts).toContain('src/index.ts');
    });
  });

  describe('POST /api/worktrees/prune', () => {
    it('prunes stale worktrees', async () => {
      mockWorktreeService.prune.mockResolvedValue(ok({ pruned: 2, failed: [] }));

      const response = await app.request('/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codespaceId: 'az2h33gpcldsq0a0wdimza6m',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.pruned).toBe(2);
    });

    it('validates codespaceId is required', async () => {
      const response = await app.request('/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('MISSING_PARAMS');
    });
  });
});
