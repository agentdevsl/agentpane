import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRoutes } from '../../src/server/routes/git';

/**
 * Integration tests for /api/git routes.
 *
 * Each endpoint requires `codespaceId` query param (validated via
 * requireQueryId), then delegates to GitService. Cover the missing-param,
 * invalid-id, success, and error branches for each.
 */

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string, status = 500) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockGitService() {
  return {
    getStatus: vi.fn(),
    listBranches: vi.fn(),
    listCommits: vi.fn(),
    listRemoteBranches: vi.fn(),
  };
}

describe('Git Routes (IT-1810)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockGitService>;

  beforeEach(() => {
    svc = createMockGitService();
    app = createGitRoutes({ gitService: svc as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── /status ─────────────────────────────────────────

  it('IT-1810-1: GET /status returns 400 when codespaceId missing', async () => {
    const res = await app.request('http://localhost/status');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('MISSING_PARAMS');
  });

  it('IT-1810-2: GET /status returns 400 on invalid codespaceId', async () => {
    const res = await app.request('http://localhost/status?codespaceId=bad..id');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-1810-3: GET /status returns service result', async () => {
    svc.getStatus.mockResolvedValue(ok({ branch: 'main', isDirty: false }));
    const res = await app.request('http://localhost/status?codespaceId=cs-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.branch).toBe('main');
  });

  it('IT-1810-4: GET /status surfaces service error', async () => {
    svc.getStatus.mockResolvedValue(err('GIT_ERROR', 'no repo'));
    const res = await app.request('http://localhost/status?codespaceId=cs-1');
    expect(res.status).toBe(500);
  });

  // ─── /branches ───────────────────────────────────────

  it('IT-1810-5: GET /branches missing param', async () => {
    const res = await app.request('http://localhost/branches');
    expect(res.status).toBe(400);
  });

  it('IT-1810-6: GET /branches returns service result', async () => {
    svc.listBranches.mockResolvedValue(ok([{ name: 'main' }, { name: 'dev' }]));
    const body = await (await app.request('http://localhost/branches?codespaceId=cs-1')).json();
    expect(body.data).toHaveLength(2);
  });

  it('IT-1810-7: GET /branches surfaces service error', async () => {
    svc.listBranches.mockResolvedValue(err('GIT_ERROR', 'no repo'));
    const res = await app.request('http://localhost/branches?codespaceId=cs-1');
    expect(res.status).toBe(500);
  });

  // ─── /commits ────────────────────────────────────────

  it('IT-1810-8: GET /commits missing param', async () => {
    const res = await app.request('http://localhost/commits');
    expect(res.status).toBe(400);
  });

  it('IT-1810-9: GET /commits passes branch and limit', async () => {
    svc.listCommits.mockResolvedValue(ok([{ sha: 'abc' }]));
    const res = await app.request('http://localhost/commits?codespaceId=cs-1&branch=dev&limit=10');
    expect(res.status).toBe(200);
    expect(svc.listCommits).toHaveBeenCalledWith('cs-1', { branch: 'dev', limit: 10 });
  });

  it('IT-1810-10: GET /commits leaves branch undefined when empty', async () => {
    svc.listCommits.mockResolvedValue(ok([]));
    await app.request('http://localhost/commits?codespaceId=cs-1');
    expect(svc.listCommits).toHaveBeenCalledWith('cs-1', { branch: undefined, limit: 50 });
  });

  it('IT-1810-11: GET /commits surfaces service error', async () => {
    svc.listCommits.mockResolvedValue(err('GIT_ERROR', 'no repo'));
    const res = await app.request('http://localhost/commits?codespaceId=cs-1');
    expect(res.status).toBe(500);
  });

  // ─── /remote-branches ────────────────────────────────

  it('IT-1810-12: GET /remote-branches missing param', async () => {
    const res = await app.request('http://localhost/remote-branches');
    expect(res.status).toBe(400);
  });

  it('IT-1810-13: GET /remote-branches returns result', async () => {
    svc.listRemoteBranches.mockResolvedValue(ok([{ name: 'origin/main' }]));
    const body = await (
      await app.request('http://localhost/remote-branches?codespaceId=cs-1')
    ).json();
    expect(body.data).toHaveLength(1);
  });

  it('IT-1810-14: GET /remote-branches surfaces service error', async () => {
    svc.listRemoteBranches.mockResolvedValue(err('GIT_ERROR', 'no remote'));
    const res = await app.request('http://localhost/remote-branches?codespaceId=cs-1');
    expect(res.status).toBe(500);
  });
});
