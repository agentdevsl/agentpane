import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubRoutes } from '../github.js';

// ── Mock GitHub Token Service ──

function createMockGitHubService() {
  return {
    listUserOrgs: vi.fn(),
    listUserRepos: vi.fn(),
    listReposForOwner: vi.fn(),
    getTokenInfo: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    revalidateToken: vi.fn(),
    getDecryptedToken: vi.fn(),
    getOctokit: vi.fn(),
    createRepoFromTemplate: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const githubService = createMockGitHubService();
  const routes = createGitHubRoutes({ githubService: githubService as never });
  const app = new Hono();
  app.route('/api/github', routes);
  return { app, githubService };
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

describe('GitHub API Routes', () => {
  // ── GET /api/github/orgs ──

  describe('GET /api/github/orgs', () => {
    it('returns orgs list on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.listUserOrgs.mockResolvedValue({
        ok: true,
        value: [{ login: 'my-org', id: 1 }],
      });

      const res = await request(app, 'GET', '/api/github/orgs');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.orgs).toHaveLength(1);
      expect(json.data.orgs[0].login).toBe('my-org');
    });

    it('returns 401 when service fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.listUserOrgs.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'No token' },
      });

      const res = await request(app, 'GET', '/api/github/orgs');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/github/repos ──

  describe('GET /api/github/repos', () => {
    it('returns user repos on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.listUserRepos.mockResolvedValue({
        ok: true,
        value: [{ name: 'my-repo', full_name: 'user/my-repo' }],
      });

      const res = await request(app, 'GET', '/api/github/repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(1);
      expect(json.data.repos[0].name).toBe('my-repo');
    });

    it('returns 401 when service fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.listUserRepos.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'No token' },
      });

      const res = await request(app, 'GET', '/api/github/repos');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/github/repos/:owner ──

  describe('GET /api/github/repos/:owner', () => {
    it('returns repos for an owner', async () => {
      const { app, githubService } = createTestApp();
      githubService.listReposForOwner.mockResolvedValue({
        ok: true,
        value: [{ name: 'org-repo', full_name: 'my-org/org-repo' }],
      });

      const res = await request(app, 'GET', '/api/github/repos/my-org');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(1);
      expect(githubService.listReposForOwner).toHaveBeenCalledWith('my-org');
    });

    it('returns 401 when service fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.listReposForOwner.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Token invalid' },
      });

      const res = await request(app, 'GET', '/api/github/repos/my-org');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/github/token ──

  describe('GET /api/github/token', () => {
    it('returns token info on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.getTokenInfo.mockResolvedValue({
        ok: true,
        value: {
          id: 'tok-1',
          maskedToken: 'ghp_****abcd',
          githubLogin: 'testuser',
          isValid: true,
          lastValidatedAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
        },
      });

      const res = await request(app, 'GET', '/api/github/token');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.tokenInfo.maskedToken).toBe('ghp_****abcd');
      expect(json.data.tokenInfo.isValid).toBe(true);
    });

    it('returns 500 when service fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.getTokenInfo.mockResolvedValue({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'DB error' },
      });

      const res = await request(app, 'GET', '/api/github/token');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/github/token ──

  describe('POST /api/github/token', () => {
    it('saves a token on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.saveToken.mockResolvedValue({
        ok: true,
        value: {
          id: 'tok-1',
          maskedToken: 'ghp_****abcd',
          githubLogin: 'testuser',
          isValid: true,
          lastValidatedAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
        },
      });

      const res = await request(app, 'POST', '/api/github/token', { token: 'ghp_testtoken123' });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.tokenInfo.maskedToken).toBe('ghp_****abcd');
      expect(githubService.saveToken).toHaveBeenCalledWith('ghp_testtoken123');
    });

    it('returns 400 when token is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/token', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service rejects token', async () => {
      const { app, githubService } = createTestApp();
      githubService.saveToken.mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_FORMAT', message: 'Bad token format' },
      });

      const res = await request(app, 'POST', '/api/github/token', { token: 'bad-token' });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_FORMAT');
    });
  });

  // ── DELETE /api/github/token ──

  describe('DELETE /api/github/token', () => {
    it('deletes token on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.deleteToken.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/github/token');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 500 when delete fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.deleteToken.mockResolvedValue({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'Delete failed' },
      });

      const res = await request(app, 'DELETE', '/api/github/token');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/github/revalidate ──

  describe('POST /api/github/revalidate', () => {
    it('returns validation result on success', async () => {
      const { app, githubService } = createTestApp();
      githubService.revalidateToken.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/github/revalidate');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.isValid).toBe(true);
    });

    it('returns 500 when revalidation fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.revalidateToken.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'No token stored' },
      });

      const res = await request(app, 'POST', '/api/github/revalidate');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/github/clone ──

  describe('POST /api/github/clone', () => {
    it('returns 400 when url is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        destination: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when destination is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        url: 'https://github.com/user/repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid GitHub URL', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        url: 'https://evil.com/repo',
        destination: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_URL');
    });
  });

  // ── POST /api/github/create-from-template ──

  describe('POST /api/github/create-from-template', () => {
    it('returns 400 when required fields are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when template creation fails', async () => {
      const { app, githubService } = createTestApp();
      githubService.createRepoFromTemplate.mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Template not found' },
      });

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when fullName is missing from response', async () => {
      const { app, githubService } = createTestApp();
      githubService.createRepoFromTemplate.mockResolvedValue({
        ok: true,
        value: { fullName: null, cloneUrl: 'https://github.com/user/repo.git' },
      });

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_RESPONSE');
    });

    it('returns 400 when templateRepo is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        name: 'new-repo',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when clonePath is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('passes all fields to createRepoFromTemplate', async () => {
      const { app, githubService } = createTestApp();
      githubService.createRepoFromTemplate.mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Template not found' },
      });

      await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'myorg',
        templateRepo: 'my-template',
        name: 'new-project',
        owner: 'myorg',
        description: 'A new project',
        isPrivate: true,
        clonePath: '/tmp/repos',
      });

      expect(githubService.createRepoFromTemplate).toHaveBeenCalledWith({
        templateOwner: 'myorg',
        templateRepo: 'my-template',
        name: 'new-project',
        owner: 'myorg',
        description: 'A new project',
        isPrivate: true,
      });
    });

    it('returns 500 when cloneUrl is missing from response', async () => {
      const { app, githubService } = createTestApp();
      // Mock repo creation success with fullName but no cloneUrl
      githubService.createRepoFromTemplate.mockResolvedValue({
        ok: true,
        value: { fullName: 'user/new-repo', cloneUrl: null },
      });
      // Mock waitForRepoReady — need getOctokit for that path
      githubService.getOctokit.mockResolvedValue({
        rest: {
          repos: {
            listCommits: vi.fn().mockResolvedValue({ data: [{ sha: 'abc' }] }),
          },
        },
      });

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_RESPONSE');
    });

    it('returns 500 when repo is not ready after max attempts', async () => {
      const { app, githubService } = createTestApp();
      githubService.createRepoFromTemplate.mockResolvedValue({
        ok: true,
        value: { fullName: 'user/new-repo', cloneUrl: 'https://github.com/user/new-repo.git' },
      });
      // Mock getOctokit that always returns empty commits (repo never ready)
      githubService.getOctokit.mockResolvedValue({
        rest: {
          repos: {
            listCommits: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
      });

      const res = await request(app, 'POST', '/api/github/create-from-template', {
        templateOwner: 'owner',
        templateRepo: 'template',
        name: 'new-repo',
        clonePath: '/tmp/test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('REPO_NOT_READY');
    }, 120000); // Longer timeout since it retries
  });

  // ── POST /api/github/clone (additional tests) ──

  describe('POST /api/github/clone (additional)', () => {
    it('returns 400 when both url and destination are empty strings', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        url: '',
        destination: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-HTTPS URLs', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        url: 'http://github.com/user/repo',
        destination: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_URL');
    });

    it('rejects URLs with non-GitHub domains', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/github/clone', {
        url: 'https://gitlab.com/user/repo',
        destination: '/tmp/test',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_URL');
    });
  });

  // ── POST /api/github/revalidate (additional) ──

  describe('POST /api/github/revalidate (additional)', () => {
    it('returns isValid false when token is invalid but revalidation succeeds', async () => {
      const { app, githubService } = createTestApp();
      githubService.revalidateToken.mockResolvedValue({ ok: true, value: false });

      const res = await request(app, 'POST', '/api/github/revalidate');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.isValid).toBe(false);
    });
  });
});
