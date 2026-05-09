import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubRoutes } from '../../src/server/routes/github';

type SpawnReturn = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

function stubBun(exitCode: number, stderrText = ''): { spawn: () => SpawnReturn } {
  return {
    spawn: () => ({
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderrText));
          controller.close();
        },
      }),
    }),
  };
}

/**
 * Integration tests for the GitHub routes.
 *
 * Focuses on the validation, error mapping, and result shaping that does not
 * require Bun.spawn (clone/create-from-template's git invocation is best
 * exercised by the higher-level integration tests). Bun-specific code paths
 * are exercised via the validation gates that gate them.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message, status: 400 },
});

function createMockGithubTokenService() {
  return {
    listUserOrgs: vi.fn(),
    listReposForOwner: vi.fn(),
    listUserRepos: vi.fn(),
    getTokenInfo: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    revalidateToken: vi.fn(),
    getDecryptedToken: vi.fn(),
    getOctokit: vi.fn(),
    createRepoFromTemplate: vi.fn(),
  };
}

describe('GitHub Routes (IT-1780)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockGithubTokenService>;
  let originalBun: unknown;
  let tmpRoot: string;

  beforeEach(() => {
    svc = createMockGithubTokenService();
    app = createGitHubRoutes({ githubService: svc as never });
    originalBun = (globalThis as { Bun?: unknown }).Bun;
    tmpRoot = mkdtempSync(join(tmpdir(), 'route-github-'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    (globalThis as { Bun?: unknown }).Bun = originalBun;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  // ─── GET /orgs ────────────────────────────────────────

  it('IT-1780-1: GET /orgs returns mapped list', async () => {
    svc.listUserOrgs.mockResolvedValue(ok([{ login: 'me' }]));
    const res = await app.request('http://localhost/orgs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgs).toHaveLength(1);
  });

  it('IT-1780-2: GET /orgs returns 401 on service error', async () => {
    svc.listUserOrgs.mockResolvedValue(err('UNAUTHORIZED', 'no token'));
    const res = await app.request('http://localhost/orgs');
    expect(res.status).toBe(401);
  });

  // ─── POST /clone ──────────────────────────────────────

  it('IT-1780-3: POST /clone rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/clone', { url: '' }));
    expect(res.status).toBe(400);
  });

  it('IT-1780-4: POST /clone rejects non-GitHub URL', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://gitlab.com/x/y',
        destination: '~/repos',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_URL');
  });

  it('IT-1780-5: POST /clone rejects path traversal in destination', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://github.com/x/y',
        destination: '/etc',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PATH');
  });

  it('IT-1780-5b: POST /clone returns FOLDER_EXISTS when target exists', async () => {
    // Create the would-be target so existsSync returns true.
    const dest = mkdtempSync(join(tmpdir(), 'clone-dest-'));
    const repoFolder = join(dest, 'y');
    mkdtempSync(repoFolder.replace(/y$/, 'yXXXXXX')); // any folder with prefix
    // Recreate with the exact `y` name
    require('node:fs').mkdirSync(repoFolder, { recursive: true });
    // Make destination valid: under /tmp
    const tmpDest = `/tmp/${dest.replace(/^.*\//, '')}`;
    require('node:fs').mkdirSync(tmpDest, { recursive: true });
    require('node:fs').mkdirSync(`${tmpDest}/y`, { recursive: true });

    svc.getDecryptedToken.mockResolvedValue(null);
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://github.com/x/y',
        destination: tmpDest,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('FOLDER_EXISTS');
    rmSync(tmpDest, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('IT-1780-5c: POST /clone succeeds when Bun.spawn returns 0', async () => {
    (globalThis as { Bun?: unknown }).Bun = stubBun(0);
    const tmpDest = `/tmp/route-github-clone-${Date.now()}-ok`;
    svc.getDecryptedToken.mockResolvedValue(null);
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://github.com/x/y',
        destination: tmpDest,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe(`${tmpDest}/y`);
    rmSync(tmpDest, { recursive: true, force: true });
  });

  it('IT-1780-5d: POST /clone returns CLONE_FAILED when exit code non-zero, redacts token', async () => {
    // Pseudo-token used only as a string to prove the redaction step happens.
    const fakeToken = 'PLACEHOLDER-TOKEN-VALUE';
    (globalThis as { Bun?: unknown }).Bun = stubBun(
      128,
      `error: failed for https://${fakeToken}@github.com/x/y`
    );
    const tmpDest = `/tmp/route-github-clone-${Date.now()}-fail`;
    svc.getDecryptedToken.mockResolvedValue(fakeToken);
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://github.com/x/y',
        destination: tmpDest,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('CLONE_FAILED');
    // Token should not appear in stderr (it goes to logs only). Sanity check.
    expect(JSON.stringify(body)).not.toContain(fakeToken);
    rmSync(tmpDest, { recursive: true, force: true });
  });

  it('IT-1780-5e: POST /clone returns CLONE_ERROR when Bun.spawn throws', async () => {
    (globalThis as { Bun?: unknown }).Bun = {
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    };
    const tmpDest = `/tmp/route-github-clone-${Date.now()}-throw`;
    svc.getDecryptedToken.mockResolvedValue(null);
    const res = await app.request(
      jsonRequest('http://localhost/clone', {
        url: 'https://github.com/x/y',
        destination: tmpDest,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('CLONE_ERROR');
    expect(body.error.message).toContain('spawn EACCES');
    rmSync(tmpDest, { recursive: true, force: true });
  });

  // ─── POST /create-from-template ───────────────────────

  it('IT-1780-6: POST /create-from-template rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/create-from-template', {}));
    expect(res.status).toBe(400);
  });

  it('IT-1780-7: POST /create-from-template returns 400 when create fails', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(err('CREATE_FAILED', 'boom'));
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: '~/repos',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CREATE_FAILED');
  });

  it('IT-1780-8: POST /create-from-template returns 500 when fullName missing', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(ok({ cloneUrl: 'x' }));
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: '~/repos',
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_RESPONSE');
  });

  it('IT-1780-8b: POST /create-from-template returns REPO_NOT_READY when getOctokit returns null', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    // No octokit → waitForRepoReady returns false immediately on the first call.
    svc.getOctokit.mockResolvedValue(null);
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: `/tmp/create-from-template-${Date.now()}`,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('REPO_NOT_READY');
  });

  it('IT-1780-8c: POST /create-from-template returns INVALID_PATH when clonePath unsafe', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: '/etc',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PATH');
  });

  it('IT-1780-8d: POST /create-from-template clones successfully', async () => {
    (globalThis as { Bun?: unknown }).Bun = stubBun(0);
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    svc.getDecryptedToken.mockResolvedValue(null);

    const tmpDest = `/tmp/cft-success-${Date.now()}`;
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: tmpDest,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe(`${tmpDest}/c`);
    expect(body.data.repoFullName).toBe('x/y');
    rmSync(tmpDest, { recursive: true, force: true });
  });

  it('IT-1780-8e: POST /create-from-template returns FOLDER_EXISTS when target dir already present', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    const tmpDest = `/tmp/cft-exists-${Date.now()}`;
    require('node:fs').mkdirSync(`${tmpDest}/c`, { recursive: true });

    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: tmpDest,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('FOLDER_EXISTS');
    rmSync(tmpDest, { recursive: true, force: true });
  });

  it('IT-1780-8f: POST /create-from-template returns 500 when cloneUrl missing', async () => {
    svc.createRepoFromTemplate.mockResolvedValue(ok({ fullName: 'x/y' }));
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    const tmpDest = `/tmp/cft-no-cloneurl-${Date.now()}`;
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: tmpDest,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_RESPONSE');
    expect(body.error.message).toContain('cloneUrl');
  });

  it('IT-1780-8g: POST /create-from-template returns CLONE_FAILED when git exits non-zero', async () => {
    (globalThis as { Bun?: unknown }).Bun = stubBun(128, 'fatal: bad clone');
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    svc.getDecryptedToken.mockResolvedValue(null);
    const tmpDest = `/tmp/cft-fail-${Date.now()}`;
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: tmpDest,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('CLONE_FAILED');
    rmSync(tmpDest, { recursive: true, force: true });
  });

  it('IT-1780-8h: POST /create-from-template returns CLONE_ERROR when spawn throws', async () => {
    (globalThis as { Bun?: unknown }).Bun = {
      spawn: () => {
        throw new Error('cannot exec git');
      },
    };
    svc.createRepoFromTemplate.mockResolvedValue(
      ok({ fullName: 'x/y', cloneUrl: 'https://github.com/x/y' })
    );
    svc.getOctokit.mockResolvedValue({
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1' }] }),
        },
      },
    });
    svc.getDecryptedToken.mockResolvedValue(null);
    const tmpDest = `/tmp/cft-throw-${Date.now()}`;
    const res = await app.request(
      jsonRequest('http://localhost/create-from-template', {
        templateOwner: 'a',
        templateRepo: 'b',
        name: 'c',
        clonePath: tmpDest,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('CLONE_ERROR');
    expect(body.error.message).toContain('cannot exec git');
    rmSync(tmpDest, { recursive: true, force: true });
  });

  // ─── GET /repos/:owner ────────────────────────────────

  it('IT-1780-9: GET /repos/:owner returns repo list', async () => {
    svc.listReposForOwner.mockResolvedValue(ok([{ name: 'r1' }]));
    const res = await app.request('http://localhost/repos/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.repos).toHaveLength(1);
    expect(svc.listReposForOwner).toHaveBeenCalledWith('me');
  });

  it('IT-1780-10: GET /repos/:owner returns 401 on service error', async () => {
    svc.listReposForOwner.mockResolvedValue(err('UNAUTHORIZED', 'no token'));
    const res = await app.request('http://localhost/repos/me');
    expect(res.status).toBe(401);
  });

  // ─── GET /repos ────────────────────────────────────────

  it('IT-1780-11: GET /repos returns user repos', async () => {
    svc.listUserRepos.mockResolvedValue(ok([{ name: 'r1' }, { name: 'r2' }]));
    const res = await app.request('http://localhost/repos');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.repos).toHaveLength(2);
  });

  it('IT-1780-12: GET /repos returns 401 on service error', async () => {
    svc.listUserRepos.mockResolvedValue(err('UNAUTHORIZED', 'no token'));
    const res = await app.request('http://localhost/repos');
    expect(res.status).toBe(401);
  });

  // ─── GET /token ────────────────────────────────────────

  it('IT-1780-13: GET /token returns token info', async () => {
    svc.getTokenInfo.mockResolvedValue(ok({ githubLogin: 'me', isValid: true }));
    const res = await app.request('http://localhost/token');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tokenInfo.githubLogin).toBe('me');
  });

  it('IT-1780-14: GET /token returns 500 on service error', async () => {
    svc.getTokenInfo.mockResolvedValue(err('TOKEN_LOAD', 'fail'));
    const res = await app.request('http://localhost/token');
    expect(res.status).toBe(500);
  });

  // ─── POST /token ───────────────────────────────────────

  it('IT-1780-15: POST /token rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/token', { token: '' }));
    expect(res.status).toBe(400);
  });

  it('IT-1780-16: POST /token saves token', async () => {
    svc.saveToken.mockResolvedValue(ok({ githubLogin: 'me' }));
    const res = await app.request(jsonRequest('http://localhost/token', { token: 'ghp_xxx' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tokenInfo.githubLogin).toBe('me');
    expect(svc.saveToken).toHaveBeenCalledWith('ghp_xxx');
  });

  it('IT-1780-17: POST /token returns 400 on service error', async () => {
    svc.saveToken.mockResolvedValue(err('INVALID_TOKEN', 'bad token'));
    const res = await app.request(jsonRequest('http://localhost/token', { token: 'bad' }));
    expect(res.status).toBe(400);
  });

  // ─── DELETE /token ─────────────────────────────────────

  it('IT-1780-18: DELETE /token succeeds', async () => {
    svc.deleteToken.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/token', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('IT-1780-19: DELETE /token returns 500 on service error', async () => {
    svc.deleteToken.mockResolvedValue(err('DELETE_FAILED', 'fail'));
    const res = await app.request('http://localhost/token', { method: 'DELETE' });
    expect(res.status).toBe(500);
  });

  // ─── POST /revalidate ──────────────────────────────────

  it('IT-1780-20: POST /revalidate returns isValid=true', async () => {
    svc.revalidateToken.mockResolvedValue(ok(true));
    const res = await app.request('http://localhost/revalidate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isValid).toBe(true);
  });

  it('IT-1780-21: POST /revalidate returns 500 on service error', async () => {
    svc.revalidateToken.mockResolvedValue(err('REVALIDATE_FAILED', 'fail'));
    const res = await app.request('http://localhost/revalidate', { method: 'POST' });
    expect(res.status).toBe(500);
  });
});
