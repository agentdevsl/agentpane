import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHealthRoutes } from '../../src/server/routes/health';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for the /api/health routes.
 *
 * Uses the real test database for connectivity checks. Mocks the GitHub token
 * service (no live OAuth dependency), the optional sandbox/k8s providers, and
 * `fetch` for streams reachability. Exercises the readiness gate, all check
 * branches, the liveness probe, and the readiness probe (success and DB
 * failure).
 */

const ok = <T>(value: T) => ({ ok: true as const, value });
const errResult = (code: string, message: string, status = 500) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockGithubService(impl: { tokenInfo?: unknown; throws?: boolean } = {}) {
  return {
    getTokenInfo: vi.fn().mockImplementation(() => {
      if (impl.throws) throw new Error('boom');
      if (impl.tokenInfo === undefined) {
        return Promise.resolve(ok(null));
      }
      return Promise.resolve(ok(impl.tokenInfo));
    }),
  } as never;
}

describe('Health Routes (IT-1770)', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await clearTestDatabase();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Readiness gate ──────────────────────────────────

  it('IT-1770-1: GET / returns 503 when isSandboxReady=false', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      isSandboxReady: () => false,
    });
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.data.status).toBe('initializing');
    expect(body.data.message).toContain('initializing');
  });

  it('IT-1770-2: GET / passes readiness gate when isSandboxReady=true', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      isSandboxReady: () => true,
    });
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('healthy');
    expect(body.data.checks.database.status).toBe('ok');
  });

  // ─── Database check ──────────────────────────────────

  it('IT-1770-3: GET / reports DB ok with version', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
    });
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.checks.database.status).toBe('ok');
    expect(body.data.checks.database.mode).toBe('sqlite');
    expect(body.data.checks.database.version).toMatch(/SQLite/);
    expect(body.data.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('IT-1770-4: GET / reports DB error when query fails', async () => {
    const failingDb = {
      query: { codespaces: { findFirst: vi.fn().mockRejectedValue(new Error('DB down')) } },
    };
    const app = createHealthRoutes({
      db: failingDb as never,
      githubService: createMockGithubService(),
    });
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.checks.database.status).toBe('error');
    expect(body.data.checks.database.error).toContain('DB down');
    expect(body.data.status).toBe('degraded');
    expect(body.ok).toBe(false);
  });

  // ─── GitHub check ────────────────────────────────────

  it('IT-1770-5: GET / reports github ok when valid token info present', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService({
        tokenInfo: { isValid: true, githubLogin: 'me' },
      }),
    });
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.checks.github.status).toBe('ok');
    expect(body.data.checks.github.login).toBe('me');
  });

  it('IT-1770-6: GET / reports github error when token invalid', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService({
        tokenInfo: { isValid: false, githubLogin: 'me' },
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.github.status).toBe('error');
  });

  it('IT-1770-7: GET / reports github error when service result not-ok', async () => {
    const svc = {
      getTokenInfo: vi.fn().mockResolvedValue(errResult('TOKEN_FAILED', 'fail')),
    } as never;
    const app = createHealthRoutes({ db: getTestDb(), githubService: svc });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.github.status).toBe('error');
  });

  it('IT-1770-8: GET / reports github error when getTokenInfo throws', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService({ throws: true }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.github.status).toBe('error');
  });

  // ─── Sandbox check ───────────────────────────────────

  it('IT-1770-9: GET / reports sandbox ok when running container present', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getSandboxProvider: () => ({
        list: async () => [
          { id: 's-1', codespaceId: 'cs-1', containerId: 'c-1', status: 'running' },
        ],
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.sandbox.status).toBe('ok');
    expect(body.data.checks.sandbox.containerId).toBe('c-1');
    expect(body.data.checks.sandbox.containerCount).toBe(1);
  });

  it('IT-1770-10: GET / reports sandbox error when no running but some present', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getSandboxProvider: () => ({
        list: async () => [
          { id: 's-2', codespaceId: 'cs-1', containerId: 'c-2', status: 'stopped' },
        ],
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.sandbox.status).toBe('error');
    expect(body.data.checks.sandbox.containerCount).toBe(1);
    expect(body.data.checks.sandbox.error).toContain('No running containers');
  });

  it('IT-1770-11: GET / reports sandbox ok with zero count when list is empty', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getSandboxProvider: () => ({ list: async () => [] }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.sandbox.status).toBe('ok');
    expect(body.data.checks.sandbox.containerCount).toBe(0);
  });

  it('IT-1770-12: GET / reports sandbox error when list throws', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getSandboxProvider: () => ({
        list: async () => {
          throw new Error('docker down');
        },
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.sandbox.status).toBe('error');
    expect(body.data.checks.sandbox.error).toContain('docker down');
  });

  it('IT-1770-13: GET / leaves sandbox=not_configured when no provider', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getSandboxProvider: () => null,
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.sandbox.status).toBe('not_configured');
    expect(body.data.checks.sandboxInit.status).toBe('pending');
  });

  // ─── K8s check ───────────────────────────────────────

  it('IT-1770-14: GET / reports k8s ok with extracted details', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getK8sProvider: () => ({
        healthCheck: async () => ({
          healthy: true,
          details: {
            crdRegistered: true,
            namespaceExists: true,
            controller: { installed: true },
            clusterVersion: 'v1.30.0',
          },
        }),
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.kubernetes.status).toBe('ok');
    expect(body.data.checks.kubernetes.crdRegistered).toBe(true);
    expect(body.data.checks.kubernetes.namespaceExists).toBe(true);
    expect(body.data.checks.kubernetes.controllerInstalled).toBe(true);
    expect(body.data.checks.kubernetes.clusterVersion).toBe('v1.30.0');
  });

  it('IT-1770-15: GET / reports k8s ok=false when healthy=false', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getK8sProvider: () => ({ healthCheck: async () => ({ healthy: false }) }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.kubernetes.status).toBe('error');
    expect(body.data.checks.kubernetes.crdRegistered).toBe(false);
    expect(body.data.checks.kubernetes.clusterVersion).toBeNull();
  });

  it('IT-1770-16: GET / reports k8s error when healthCheck throws', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
      getK8sProvider: () => ({
        healthCheck: async () => {
          throw new Error('k8s API down');
        },
      }),
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.checks.kubernetes.status).toBe('error');
    expect(body.data.checks.kubernetes.error).toContain('k8s API down');
  });

  // ─── Streams check ───────────────────────────────────

  it('IT-1770-17: GET / reports streams ok when fetch returns 200', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 })) as never;
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
        streamsUrl: 'http://streams.example.com',
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.streams.status).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('IT-1770-18: GET / reports streams ok when fetch returns 404 (server reachable)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 })) as never;
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
        streamsUrl: 'http://streams.example.com',
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.streams.status).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('IT-1770-19: GET / reports streams error when fetch returns 500', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 })) as never;
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
        streamsUrl: 'http://streams.example.com',
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.streams.status).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('IT-1770-20: GET / reports streams error when fetch throws', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('unreachable')) as never;
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
        streamsUrl: 'http://streams.example.com',
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.streams.status).toBe('error');
      expect(body.data.checks.streams.error).toContain('unreachable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ─── API key check ───────────────────────────────────

  it('IT-1770-21: GET / reports apiKey ok when ANTHROPIC_API_KEY present', async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.apiKey.status).toBe('ok');
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('IT-1770-22: GET / reports apiKey not_configured when no key', async () => {
    const origApi = process.env.ANTHROPIC_API_KEY;
    const origOauth = process.env.CLAUDE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_OAUTH_TOKEN;
    try {
      const app = createHealthRoutes({
        db: getTestDb(),
        githubService: createMockGithubService(),
      });
      const body = await (await app.request('http://localhost/')).json();
      expect(body.data.checks.apiKey.status).toBe('not_configured');
    } finally {
      if (origApi !== undefined) process.env.ANTHROPIC_API_KEY = origApi;
      if (origOauth !== undefined) process.env.CLAUDE_OAUTH_TOKEN = origOauth;
    }
  });

  // ─── Liveness ────────────────────────────────────────

  it('IT-1770-23: GET /liveness returns alive', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
    });
    const res = await app.request('http://localhost/liveness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('alive');
  });

  // ─── Readiness ───────────────────────────────────────

  it('IT-1770-24: GET /readiness returns ready when DB up', async () => {
    const app = createHealthRoutes({
      db: getTestDb(),
      githubService: createMockGithubService(),
    });
    const res = await app.request('http://localhost/readiness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.dbLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('IT-1770-25: GET /readiness returns 503 when DB query throws', async () => {
    const failingDb = {
      query: { codespaces: { findFirst: vi.fn().mockRejectedValue(new Error('DB down')) } },
    };
    const app = createHealthRoutes({
      db: failingDb as never,
      githubService: createMockGithubService(),
    });
    const res = await app.request('http://localhost/readiness');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('not_ready');
    expect(body.error).toContain('DB down');
  });
});
