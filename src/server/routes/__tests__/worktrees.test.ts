import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createWorktreesRoutes } from '../worktrees.js';

// ── Mock Worktree Service ──

function createMockWorktreeService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getStatus: vi.fn(),
    getDiff: vi.fn(),
    commit: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
    prune: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const worktreeService = createMockWorktreeService();
  const routes = createWorktreesRoutes({ worktreeService: worktreeService as never });
  const app = new Hono();
  app.route('/api/worktrees', routes);
  return { app, worktreeService };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Worktrees API Routes', () => {
  // ── GET /api/worktrees ──

  describe('GET /api/worktrees', () => {
    it('returns worktrees list for a project', async () => {
      const { app, worktreeService } = createTestApp();
      const mockWorktrees = [
        { id: 'wt-1', branch: 'feature/task-1', codespaceId: 'proj-1' },
        { id: 'wt-2', branch: 'feature/task-2', codespaceId: 'proj-1' },
      ];
      worktreeService.list.mockResolvedValue({ ok: true, value: mockWorktrees });

      const res = await request(app, 'GET', '/api/worktrees?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/worktrees');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });
  });

  // ── POST /api/worktrees ──

  describe('POST /api/worktrees', () => {
    it('creates a worktree', async () => {
      const { app, worktreeService } = createTestApp();
      const created = {
        id: 'wt-new',
        branch: 'feature/task-1',
        path: '/tmp/worktrees/wt-new',
      };
      worktreeService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/worktrees', {
        codespaceId: 'proj-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskTitle: 'My Task',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('wt-new');
    });

    it('returns 400 when required fields are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/worktrees', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/worktrees', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 400 when service reports creation failure', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.create.mockResolvedValue({
        ok: false,
        error: { code: 'WORKTREE_CREATE_FAILED', message: 'Git error' },
      });

      const res = await request(app, 'POST', '/api/worktrees', {
        codespaceId: 'proj-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskTitle: 'My Task',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKTREE_CREATE_FAILED');
    });
  });

  // ── GET /api/worktrees/:id ──

  describe('GET /api/worktrees/:id', () => {
    it('returns worktree status by id', async () => {
      const { app, worktreeService } = createTestApp();
      const worktree = {
        id: 'wt-1',
        branch: 'feature/task-1',
        status: 'active',
        path: '/tmp/worktrees/wt-1',
      };
      worktreeService.getStatus.mockResolvedValue({ ok: true, value: worktree });

      const res = await request(app, 'GET', '/api/worktrees/wt-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('wt-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/worktrees/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when worktree not found', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.getStatus.mockResolvedValue({ ok: false, error: {} });

      const res = await request(app, 'GET', '/api/worktrees/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /api/worktrees/:id ──

  describe('DELETE /api/worktrees/:id', () => {
    it('removes a worktree', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.remove.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/worktrees/wt-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
      expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', false);
    });

    it('removes a worktree with force flag', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.remove.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/worktrees/wt-1?force=true');

      expect(res.status).toBe(200);
      expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/worktrees/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when worktree not found', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.remove.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Worktree not found' },
      });

      const res = await request(app, 'DELETE', '/api/worktrees/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── GET /api/worktrees/:id/diff ──

  describe('GET /api/worktrees/:id/diff', () => {
    it('returns diff for a worktree', async () => {
      const { app, worktreeService } = createTestApp();
      const diff = {
        files: [{ path: 'src/foo.ts', additions: 5, deletions: 2 }],
        rawDiff: '--- a/src/foo.ts\n+++ b/src/foo.ts',
      };
      worktreeService.getDiff.mockResolvedValue({ ok: true, value: diff });

      const res = await request(app, 'GET', '/api/worktrees/wt-1/diff');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.files).toHaveLength(1);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/worktrees/bad!id/diff');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when worktree not found', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.getDiff.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Worktree not found' },
      });

      const res = await request(app, 'GET', '/api/worktrees/nonexistent-id/diff');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── POST /api/worktrees/:id/commit ──

  describe('POST /api/worktrees/:id/commit', () => {
    it('commits changes in a worktree', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.commit.mockResolvedValue({ ok: true, value: 'abc1234' });

      const res = await request(app, 'POST', '/api/worktrees/wt-1/commit', {
        message: 'feat: add new feature',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.sha).toBe('abc1234');
    });

    it('returns 400 when message is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/worktrees/wt-1/commit', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/worktrees/bad!id/commit', {
        message: 'test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/worktrees/wt-1/commit', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 404 when worktree not found', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.commit.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Worktree not found' },
      });

      const res = await request(app, 'POST', '/api/worktrees/nonexistent-id/commit', {
        message: 'test commit',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── POST /api/worktrees/:id/merge ──

  describe('POST /api/worktrees/:id/merge', () => {
    it('merges a worktree', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.merge.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/worktrees/wt-1/merge', {});

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.merged).toBe(true);
    });

    it('merges and deletes worktree when deleteAfterMerge is true', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.merge.mockResolvedValue({ ok: true, value: true });
      worktreeService.remove.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/worktrees/wt-1/merge', {
        deleteAfterMerge: true,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.merged).toBe(true);
      expect(worktreeService.remove).toHaveBeenCalledWith('wt-1', true);
    });

    it('returns 409 on merge conflict', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.merge.mockResolvedValue({
        ok: false,
        error: {
          code: 'MERGE_CONFLICT',
          message: 'Merge conflict detected',
          details: { files: ['src/foo.ts'] },
        },
      });

      const res = await request(app, 'POST', '/api/worktrees/wt-1/merge', {});

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MERGE_CONFLICT');
      expect(json.conflicts).toContain('src/foo.ts');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/worktrees/bad!id/merge', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when worktree not found', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.merge.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Worktree not found' },
      });

      const res = await request(app, 'POST', '/api/worktrees/nonexistent-id/merge', {});

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/worktrees/prune ──

  describe('POST /api/worktrees/prune', () => {
    it('prunes worktrees for a project', async () => {
      const { app, worktreeService } = createTestApp();
      worktreeService.prune.mockResolvedValue({ ok: true, value: { pruned: 2 } });

      const res = await request(app, 'POST', '/api/worktrees/prune', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.pruned).toBe(2);
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/worktrees/prune', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/worktrees/prune', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });
  });
});
