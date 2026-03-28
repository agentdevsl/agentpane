/**
 * Tests for team GitHub token management routes.
 *
 * Covers:
 * - GET /: token info with masking
 * - PUT /: set/replace token with validation
 * - DELETE /: remove token
 * - POST /validate: validate token against GitHub API
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createTeamGitHubTokenRoutes } from '../../src/server/routes/team-github-token';
import type { RbacService } from '../../src/services/rbac.service';

// ── Mock External Dependencies ──

const { mockGetAuthenticated, mockDecryptToken } = vi.hoisted(() => ({
  mockGetAuthenticated: vi.fn(),
  mockDecryptToken: vi.fn((enc: string) => `decrypted-${enc}`),
}));

vi.mock('../../src/lib/crypto/server-encryption.js', () => ({
  decryptToken: mockDecryptToken,
  encryptToken: vi.fn((tok: string) => `encrypted-${tok}`),
  isValidPATFormat: vi.fn((tok: string) => tok.startsWith('ghp_') || tok.startsWith('github_pat_')),
  maskToken: vi.fn((tok: string) => `${tok.slice(0, 7)}****`),
}));

vi.mock('octokit', () => {
  return {
    Octokit: function OctokitMock() {
      return {
        rest: {
          users: {
            getAuthenticated: mockGetAuthenticated,
          },
        },
      };
    },
  };
});

vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helpers ──

function buildMockDb() {
  return {
    query: {
      githubTokens: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
}

function buildMockRbacService(overrides: Partial<RbacService> = {}): RbacService {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as RbacService;
}

function buildApp(
  db: ReturnType<typeof buildMockDb>,
  rbacService: RbacService,
  authContext: Partial<AuthContext> = {}
) {
  const defaultAuth: AuthContext = {
    userId: 'user-admin-001',
    authMethod: 'dev',
    ...authContext,
  };

  const routes = createTeamGitHubTokenRoutes({ db: db as never, rbacService });

  const app = new Hono();
  app.use('/api/teams/:id/github-token/*', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.use('/api/teams/:id/github-token', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.route('/api/teams/:id/github-token', routes);
  app.onError((err, c) =>
    c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500)
  );

  return app;
}

const VALID_TEAM_ID = 'team-aaa-001';

// ── Tests ──

describe('GET /api/teams/:id/github-token - Get token info', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);
    mockGetAuthenticated.mockResolvedValue({
      data: { login: 'testuser', id: 12345 },
    });
  });

  it('returns masked token info', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue({
      id: 'tok-1',
      encryptedToken: 'enc-data',
      tokenType: 'pat',
      scopes: 'repo',
      githubLogin: 'testuser',
      githubId: '12345',
      isValid: true,
      lastValidatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('tok-1');
    expect(body.data.maskedToken).toContain('****');
    expect(body.data.githubLogin).toBe('testuser');
    expect(body.data.isValid).toBe(true);
  });

  it('returns 400 for invalid team id', async () => {
    const res = await app.request('/api/teams/!!!/github-token');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 404 when no token configured', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue(null);

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 500 when database throws', async () => {
    db.query.githubTokens.findFirst.mockRejectedValue(new Error('DB failure'));

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DB_ERROR');
  });

  it('returns decryptionError flag when decryption fails', async () => {
    mockDecryptToken.mockImplementationOnce(() => {
      throw new Error('decryption failed');
    });
    db.query.githubTokens.findFirst.mockResolvedValue({
      id: 'tok-1',
      encryptedToken: 'corrupt-data',
      tokenType: 'pat',
      scopes: null,
      githubLogin: 'testuser',
      githubId: '12345',
      isValid: true,
      lastValidatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.maskedToken).toBe('****');
    expect(body.data.decryptionError).toBe(true);
  });

  it('returns 403 when user lacks admin role (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('PUT /api/teams/:id/github-token - Set token', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);
    mockGetAuthenticated.mockResolvedValue({
      data: { login: 'testuser', id: 12345 },
    });
  });

  it('sets a new GitHub token', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'tok-new',
            githubLogin: 'testuser',
            isValid: true,
            lastValidatedAt: '2026-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_validtokenabc123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.tokenInfo.id).toBe('tok-new');
    expect(body.data.tokenInfo.githubLogin).toBe('testuser');
  });

  it('returns 400 for invalid team id', async () => {
    const res = await app.request('/api/teams/!!!/github-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_validtoken' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 400 for invalid PAT format', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-token-format' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_FORMAT');
  });

  it('returns 400 for missing token field', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns 400 when GitHub API rejects token (401)', async () => {
    mockGetAuthenticated.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials'), { status: 401 })
    );

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_invalidtoken' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 400 when GitHub API returns non-401 error', async () => {
    mockGetAuthenticated.mockRejectedValueOnce(
      Object.assign(new Error('Server error'), { status: 500 })
    );

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_sometoken' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 500 when database insert returns null', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([null]),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_validtokenabc123' }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DB_ERROR');
  });

  it('returns 500 when database throws during save', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error('DB failure')),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_validtokenabc123' }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 403 when user lacks admin role (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_validtoken' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('DELETE /api/teams/:id/github-token - Remove token', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);
  });

  it('deletes the team token', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'tok-1' }]),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeNull();
  });

  it('returns 400 for invalid team id', async () => {
    const res = await app.request('/api/teams/!!!/github-token', {
      method: 'DELETE',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 404 when no token to delete', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 500 when database throws', async () => {
    db.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('DB failure')),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 403 when user lacks admin role (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('POST /api/teams/:id/github-token/validate - Validate token', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);
    mockGetAuthenticated.mockResolvedValue({
      data: { login: 'testuser', id: 12345 },
    });
  });

  it('validates the token successfully', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue({
      id: 'tok-1',
      encryptedToken: 'enc-data',
      isValid: true,
    });
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.isValid).toBe(true);
  });

  it('returns 400 for invalid team id', async () => {
    const res = await app.request('/api/teams/!!!/github-token/validate', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 404 when no token configured', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue(null);

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns isValid=false when token is invalid (401)', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue({
      id: 'tok-1',
      encryptedToken: 'enc-data',
      isValid: true,
    });
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    mockGetAuthenticated.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials'), { status: 401 })
    );

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.isValid).toBe(false);
    expect(body.data.validationError).toBeDefined();
  });

  it('preserves previous isValid when rate limited (429)', async () => {
    db.query.githubTokens.findFirst.mockResolvedValue({
      id: 'tok-1',
      encryptedToken: 'enc-data',
      isValid: true,
    });
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    mockGetAuthenticated.mockRejectedValueOnce(
      Object.assign(new Error('Rate limited'), { status: 429 })
    );

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.isValid).toBe(true);
    expect(body.data.validationError).toBeDefined();
  });

  it('returns 500 when database throws', async () => {
    db.query.githubTokens.findFirst.mockRejectedValue(new Error('DB failure'));

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DB_ERROR');
  });

  it('returns 403 when user lacks admin role (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/github-token/validate`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});
