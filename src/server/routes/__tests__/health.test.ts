import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createHealthRoutes } from '../health.js';

// ── Mock Dependencies ──

function createMockDb(shouldFail = false) {
  return {
    query: {
      codespaces: {
        findFirst: shouldFail
          ? vi.fn().mockRejectedValue(new Error('DB connection failed'))
          : vi.fn().mockResolvedValue({ id: 'proj-1' }),
      },
    },
    all: vi.fn().mockReturnValue([{ v: '3.45.0' }]),
  };
}

function createMockGithubService(opts?: { configured?: boolean; valid?: boolean }) {
  const { configured = true, valid = true } = opts ?? {};
  return {
    getTokenInfo: vi
      .fn()
      .mockResolvedValue(
        configured
          ? { ok: true, value: { isValid: valid, githubLogin: 'testuser' } }
          : { ok: true, value: null }
      ),
  };
}

function createMockSandboxProvider(sandboxes?: Array<{ status: string }>) {
  const list = vi.fn().mockResolvedValue(
    (sandboxes ?? []).map((s, i) => ({
      id: `sb-${i}`,
      codespaceId: `proj-${i}`,
      containerId: `cnt-${i}`,
      status: s.status,
    }))
  );
  return { list };
}

// ── Test App Factory ──

function createTestApp(opts?: {
  dbFail?: boolean;
  githubConfigured?: boolean;
  githubValid?: boolean;
  sandboxes?: Array<{ status: string }> | null;
}) {
  const db = createMockDb(opts?.dbFail);
  const githubService = createMockGithubService({
    configured: opts?.githubConfigured,
    valid: opts?.githubValid,
  });
  const sandboxProvider =
    opts?.sandboxes !== undefined && opts?.sandboxes !== null
      ? createMockSandboxProvider(opts.sandboxes)
      : null;

  const routes = createHealthRoutes({
    db: db as never,
    githubService: githubService as never,
    getSandboxProvider: sandboxProvider ? () => sandboxProvider : undefined,
  });
  const app = new Hono();
  app.route('/api/health', routes);
  return { app, db, githubService, sandboxProvider };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string) {
  return app.request(path, { method });
}

// ── Tests ──

describe('Health API Routes', () => {
  // ── GET /api/health ──

  describe('GET /api/health', () => {
    it('returns healthy status when database is ok', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/health');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('healthy');
      expect(json.data.checks.database.status).toBe('ok');
      expect(json.data.timestamp).toBeDefined();
      expect(json.data.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('returns degraded status when database is down', async () => {
      const { app } = createTestApp({ dbFail: true });

      const res = await request(app, 'GET', '/api/health');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.data.status).toBe('degraded');
      expect(json.data.checks.database.status).toBe('error');
      expect(json.data.checks.database.error).toBe('DB connection failed');
    });

    it('returns github ok when token is valid', async () => {
      const { app } = createTestApp({ githubConfigured: true, githubValid: true });

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.github.status).toBe('ok');
      expect(json.data.checks.github.login).toBe('testuser');
    });

    it('returns github error when token is invalid', async () => {
      const { app } = createTestApp({ githubConfigured: true, githubValid: false });

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.github.status).toBe('error');
    });

    it('returns sandbox not_configured when no provider', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.sandbox.status).toBe('not_configured');
    });

    it('returns sandbox ok with running containers', async () => {
      const { app } = createTestApp({ sandboxes: [{ status: 'running' }] });

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.sandbox.status).toBe('ok');
      expect(json.data.checks.sandbox.containerCount).toBe(1);
    });

    it('returns sandbox ok with zero containers (on-demand)', async () => {
      const { app } = createTestApp({ sandboxes: [] });

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.sandbox.status).toBe('ok');
      expect(json.data.checks.sandbox.containerCount).toBe(0);
    });

    it('returns sandbox error when containers exist but none running', async () => {
      const { app } = createTestApp({ sandboxes: [{ status: 'stopped' }] });

      const res = await request(app, 'GET', '/api/health');

      const json = await res.json();
      expect(json.data.checks.sandbox.status).toBe('error');
      expect(json.data.checks.sandbox.error).toContain('No running containers');
    });
  });

  // ── GET /api/health/liveness ──

  describe('GET /api/health/liveness', () => {
    it('returns alive status', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/health/liveness');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.status).toBe('alive');
    });
  });

  // ── GET /api/health/readiness ──

  describe('GET /api/health/readiness', () => {
    it('returns ready when database is accessible', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/health/readiness');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.status).toBe('ready');
      expect(json.dbLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns 503 when database is unreachable', async () => {
      const { app } = createTestApp({ dbFail: true });

      const res = await request(app, 'GET', '/api/health/readiness');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.status).toBe('not_ready');
      expect(json.error).toBe('DB connection failed');
    });
  });
});
