/**
 * @vitest-environment node
 *
 * arch29-W3-D (F12-06): regression test for the one-release backward-compat
 * redirect from `/api/project-folders/*` to `/api/codespace-folders/*`.
 *
 * The rename was applied at the route file (`project-folders.ts` →
 * `codespace-folders.ts`), the route factory (`createProjectFoldersRoutes` →
 * `createCodespaceFoldersRoutes`) and the public mount path. To avoid breaking
 * external integrations during the deprecation window, the router emits a
 * 308 Permanent Redirect from the old path to the new one. 308 (rather than
 * 301/302) preserves the request method and body, so a `POST /api/project-folders`
 * with a JSON body lands on the new endpoint with the same body.
 *
 * Test bar (red→green):
 *   before fix → no redirect, request hits an unmatched route, returns 401
 *                (auth middleware applies because the path is unknown to the
 *                redirect handler) — FAIL
 *   after fix  → 308 with Location: /api/codespace-folders/...               — PASS
 */
import { describe, expect, it, vi } from 'vitest';
import { createRouter, type RouterDependencies } from '@/server/router';

// ---------------------------------------------------------------------------
// Minimal mocks (mirrors tests/server/router.test.ts)
// ---------------------------------------------------------------------------

function stubDb(): RouterDependencies['db'] {
  return {
    query: {
      codespaces: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }) },
      userSessions: { findFirst: vi.fn().mockResolvedValue(null) },
      apiTokens: { findFirst: vi.fn().mockResolvedValue(null) },
      users: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  } as unknown as RouterDependencies['db'];
}

function stubService(overrides: Record<string, unknown> = {}): any {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return vi.fn().mockResolvedValue({ ok: true, data: {} });
    },
  });
}

function createMinimalDeps(): RouterDependencies {
  return {
    db: stubDb(),
    githubService: stubService(),
    apiKeyService: stubService(),
    templateService: stubService(),
    sandboxConfigService: stubService(),
    taskService: stubService(),
    sessionService: stubService(),
    taskCreationService: stubService(),
    marketplaceService: stubService(),
    agentService: stubService(),
  } as RouterDependencies;
}

async function appFetch(
  app: ReturnType<typeof createRouter>,
  path: string,
  init: RequestInit = {}
) {
  // Redirects are handled by the caller (browser/curl). The Hono `c.redirect`
  // method returns a Response with `status: 308` and a `Location` header — we
  // do NOT follow it, we assert on the Response itself.
  const url = `http://localhost${path}`;
  const req = new Request(url, init);
  return app.fetch(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('arch29-W3-D: project-folders → codespace-folders 308 redirect (F12-06)', () => {
  it('GET /api/project-folders/123 returns 308 with Location: /api/codespace-folders/123', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders/123');

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders/123');
  });

  it('GET /api/project-folders (root) returns 308 with Location: /api/codespace-folders', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders');

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders');
  });

  it('preserves the query string on redirect', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders/123?foo=bar&baz=qux');

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders/123?foo=bar&baz=qux');
  });

  it('preserves the query string on root redirect', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders?teamId=abc-123');

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders?teamId=abc-123');
  });

  it('redirects nested sub-paths (codespaces, summary)', async () => {
    const app = createRouter(createMinimalDeps());

    const res1 = await appFetch(app, '/api/project-folders/abc/codespaces');
    expect(res1.status).toBe(308);
    expect(res1.headers.get('Location')).toBe('/api/codespace-folders/abc/codespaces');

    const res2 = await appFetch(app, '/api/project-folders/abc/summary');
    expect(res2.status).toBe(308);
    expect(res2.headers.get('Location')).toBe('/api/codespace-folders/abc/summary');
  });

  it('preserves the request method on POST (308 keeps method + body)', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'redirected', slug: 'redirected' }),
    });

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders');
  });

  it('preserves the request method on PATCH', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders/xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders/xyz');
  });

  it('preserves the request method on DELETE', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/project-folders/xyz', { method: 'DELETE' });

    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/api/codespace-folders/xyz');
  });

  // The new path must NOT redirect — it is the canonical target.
  it('GET /api/codespace-folders does NOT redirect (it is the canonical path)', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/codespace-folders');

    // Whether 200/401/etc., the key invariant is "no 308 self-loop".
    expect(res.status).not.toBe(308);
  });

  it('GET /api/codespace-folders/123 does NOT redirect', async () => {
    const app = createRouter(createMinimalDeps());

    const res = await appFetch(app, '/api/codespace-folders/123');

    expect(res.status).not.toBe(308);
  });
});
