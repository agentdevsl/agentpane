import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../services/git.service.js';
import { createGitRoutes } from '../git.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      codespaces: {
        findFirst: vi.fn(),
      },
    },
  };
}

// ── Mock Command Runner ──

function createMockCommandRunner() {
  const exec = vi.fn();
  return {
    exec,
    execArgs: vi.fn((argv: string[], cwd: string) => exec(argv.join(' '), cwd)),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const db = createMockDb();
  const commandRunner = createMockCommandRunner();
  const gitService = new GitService(db as never, commandRunner);
  const routes = createGitRoutes({ gitService });
  const app = new Hono();
  app.route('/api/git', routes);
  return { app, db, commandRunner };
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

describe('Git API Routes', () => {
  // ── GET /api/git/status ──

  describe('GET /api/git/status', () => {
    it('returns git status for a project', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      // Mock git rev-parse (branch)
      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n' };
        }
        if (cmd.includes('git status --porcelain')) {
          return { stdout: 'M  src/file.ts\n?? new-file.ts\n' };
        }
        if (cmd.includes('rev-list --left-right')) {
          return { stdout: '2\t1\n' };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/status?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.currentBranch).toBe('main');
      expect(json.data.repoName).toBe('my-project');
      expect(json.data.status).toBe('dirty');
      expect(json.data.untracked).toBe(1);
      expect(json.data.ahead).toBe(2);
      expect(json.data.behind).toBe(1);
    });

    it('returns clean status when no changes', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n' };
        }
        if (cmd.includes('git status --porcelain')) {
          return { stdout: '\n' };
        }
        if (cmd.includes('rev-list --left-right')) {
          return { stdout: '0\t0\n' };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/status?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('clean');
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/status');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid codespaceId', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/status?codespaceId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not found', async () => {
      const { app, db } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/git/status?codespaceId=nonexistent');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_PROJECT_NOT_FOUND');
    });

    it('returns 500 on git command error', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });
      commandRunner.exec.mockRejectedValue(new Error('git not found'));

      const res = await request(app, 'GET', '/api/git/status?codespaceId=proj-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_COMMAND_FAILED');
    });

    it('handles no upstream branch gracefully', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'feature-branch\n' };
        }
        if (cmd.includes('git status --porcelain')) {
          return { stdout: '' };
        }
        if (cmd.includes('rev-list --left-right')) {
          throw new Error('fatal: no upstream');
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/status?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.ahead).toBe(0);
      expect(json.data.behind).toBe(0);
    });
  });

  // ── GET /api/git/branches ──

  describe('GET /api/git/branches', () => {
    it('returns branches list', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n' };
        }
        if (cmd.includes('for-each-ref')) {
          return {
            stdout: 'main|abc123full|abc123|[ahead 1]\nfeature|def456full|def456|\n',
          };
        }
        if (cmd.includes('rev-list --count')) {
          return { stdout: '3\n' };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/branches?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(1);
      // main is HEAD, should be first
      expect(json.data.items[0].name).toBe('main');
      expect(json.data.items[0].isHead).toBe(true);
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/branches');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid codespaceId', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/branches?codespaceId=../bad');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not found', async () => {
      const { app, db } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/git/branches?codespaceId=nonexistent');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_PROJECT_NOT_FOUND');
    });

    it('returns 500 on git command error', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });
      commandRunner.exec.mockRejectedValue(new Error('git not found'));

      const res = await request(app, 'GET', '/api/git/branches?codespaceId=proj-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_COMMAND_FAILED');
    });
  });

  // ── GET /api/git/commits ──

  describe('GET /api/git/commits', () => {
    it('returns commit list for a project', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      const SEP = '\x1e';
      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('git log')) {
          return {
            stdout: `COMMIT_STARTabc123${SEP}abc1${SEP}Fix bug${SEP}John Doe${SEP}2024-01-15T10:00:00Z\n 2 files changed, 10 insertions(+), 3 deletions(-)\n\nCOMMIT_STARTdef456${SEP}def4${SEP}Add feature${SEP}Jane Doe${SEP}2024-01-14T09:00:00Z\n 1 file changed, 5 insertions(+)\n`,
          };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/commits?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
      expect(json.data.items[0].hash).toBe('abc123');
      expect(json.data.items[0].author).toBe('John Doe');
      expect(json.data.items[0].filesChanged).toBe(2);
      expect(json.data.items[0].additions).toBe(10);
      expect(json.data.items[0].deletions).toBe(3);
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/commits');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid codespaceId', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/commits?codespaceId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid branch name', async () => {
      const { app, db } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      const res = await request(
        app,
        'GET',
        '/api/git/commits?codespaceId=proj-1&branch=bad..branch'
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_INVALID_BRANCH');
    });

    it('returns 404 when project not found', async () => {
      const { app, db } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/git/commits?codespaceId=nonexistent');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_PROJECT_NOT_FOUND');
    });

    it('returns 500 on git command error', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });
      commandRunner.exec.mockRejectedValue(new Error('git log failed'));

      const res = await request(app, 'GET', '/api/git/commits?codespaceId=proj-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_COMMAND_FAILED');
    });

    it('uses specified branch parameter', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('git log')) {
          expect(cmd).toContain('feature/my-branch');
          return { stdout: '' };
        }
        return { stdout: '' };
      });

      const res = await request(
        app,
        'GET',
        '/api/git/commits?codespaceId=proj-1&branch=feature/my-branch'
      );

      expect(res.status).toBe(200);
    });
  });

  // ── GET /api/git/remote-branches ──

  describe('GET /api/git/remote-branches', () => {
    it('returns remote branches list', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('git fetch')) {
          return { stdout: '' };
        }
        if (cmd.includes('for-each-ref')) {
          return {
            stdout: 'origin/main|abc123full|abc123\norigin/feature|def456full|def456\n',
          };
        }
        if (cmd.includes('rev-list --count')) {
          return { stdout: '5\n' };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/remote-branches?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBe(2);
      expect(json.data.items[0].name).toBe('feature');
      expect(json.data.items[1].name).toBe('main');
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/remote-branches');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid codespaceId', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/git/remote-branches?codespaceId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not found', async () => {
      const { app, db } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/git/remote-branches?codespaceId=nonexistent');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_PROJECT_NOT_FOUND');
    });

    it('filters out HEAD pointer entries', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });

      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('git fetch')) {
          return { stdout: '' };
        }
        if (cmd.includes('for-each-ref')) {
          return {
            stdout: 'origin/HEAD|abc123full|abc123\norigin/main|def456full|def456\n',
          };
        }
        if (cmd.includes('rev-list --count')) {
          return { stdout: '0\n' };
        }
        return { stdout: '' };
      });

      const res = await request(app, 'GET', '/api/git/remote-branches?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      // HEAD pointer should be filtered out
      expect(json.data.items.every((b: { name: string }) => b.name !== 'HEAD')).toBe(true);
    });

    it('returns 500 on git command error', async () => {
      const { app, db, commandRunner } = createTestApp();
      db.query.codespaces.findFirst.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
      });
      // fetch succeeds but for-each-ref fails
      commandRunner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('git fetch')) {
          return { stdout: '' };
        }
        throw new Error('git error');
      });

      const res = await request(app, 'GET', '/api/git/remote-branches?codespaceId=proj-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('GIT_COMMAND_FAILED');
    });
  });
});
