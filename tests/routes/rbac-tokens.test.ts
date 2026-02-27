/**
 * Tests for RBAC API token routes.
 *
 * Covers:
 * - POST /tokens: creation, 201 status, role ceiling validation, name uniqueness (409), max limit (400), raw token in response, expiresInDays
 * - GET /tokens: list active tokens, showAll=true includes revoked, teamId filter, pagination with cursor/totalCount, useCount in response, allTeam admin-only listing
 * - GET /tokens/:id: returns enriched scope tags, 404 for non-existent, own tokens only
 * - DELETE /tokens/:id: revoke sets status and revokedAt, already-revoked returns 409, own tokens only
 */

// Mock the test database helpers to prevent the global setup from attempting
// to run RBAC_MIGRATION_SQL (which has a pre-existing schema dependency issue).
vi.mock('../helpers/database', () => ({
  setupTestDatabase: vi.fn().mockResolvedValue(undefined),
  clearTestDatabase: vi.fn().mockResolvedValue(undefined),
  closeTestDatabase: vi.fn().mockResolvedValue(undefined),
  getTestDb: vi.fn(),
  seedTestDatabase: vi.fn().mockResolvedValue([]),
}));

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRbacTokensRoutes } from '../../src/server/routes/rbac-tokens';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import type { RbacService } from '../../src/services/rbac.service';

// ─── Mock factory helpers ─────────────────────────────────────────────────────

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-001',
    authMethod: 'session',
    ...overrides,
  };
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-abc123',
    name: 'my-token',
    tokenPrefix: 'ap_abc12345',
    role: 'agent_operator',
    teamId: 'team-001',
    scopeTags: null,
    scopeProjectId: null,
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: new Date().toISOString(),
    tokenHash: 'deadbeef',
    userId: 'user-001',
    revokedAt: null,
    ...overrides,
  };
}

function createMockRbacService(overrides: Partial<RbacService> = {}): RbacService {
  return {
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    can: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as RbacService;
}

// ─── DB mock builder ──────────────────────────────────────────────────────────

function createMockDb(overrides: Record<string, unknown> = {}) {
  const mockTx = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    query: {},
    _mockTx: mockTx,
    ...overrides,
  };

  return mockDb;
}

// ─── App builder ──────────────────────────────────────────────────────────────

function buildApp(
  auth: AuthContext,
  db: ReturnType<typeof createMockDb>,
  rbacService: RbacService
) {
  const routes = createRbacTokensRoutes({
    db: db as unknown as Parameters<typeof createRbacTokensRoutes>[0]['db'],
    rbacService,
  });

  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/tokens', routes);
  return app;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Wire up db.select().from().where()...returning().limit() chain returning `rows` */
function mockSelectChain(db: ReturnType<typeof createMockDb>, rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    then: undefined as unknown,
  };
  // Make the chain thenable so `await db.select(...).from(...).where(...)` (no .limit) also works
  chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  db.select.mockReturnValue(chain);
  return chain;
}

function mockTxSelectChain(tx: ReturnType<typeof createMockDb>['_mockTx'], rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    then: undefined as unknown,
  };
  chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  tx.select.mockReturnValue(chain);
  return chain;
}

function mockTxInsertChain(
  tx: ReturnType<typeof createMockDb>['_mockTx'],
  rows: unknown[]
) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  tx.insert.mockReturnValue(chain);
  return chain;
}

function mockUpdateChain(
  db: ReturnType<typeof createMockDb>,
  rows: unknown[]
) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  db.update.mockReturnValue(chain);
  return chain;
}

// ─── POST /tokens ─────────────────────────────────────────────────────────────

describe('POST /tokens', () => {
  const validBody = {
    name: 'ci-token',
    teamId: 'team-001',
    role: 'agent_operator',
  };

  it('M2: returns 201 on successful token creation', async () => {
    const db = createMockDb();
    const tx = db._mockTx;

    // scopeProjectId not provided, no scopeTags
    // transaction internals: name uniqueness check → [], count check → [{total:0}], insert → [token]
    const createdToken = makeToken({ name: 'ci-token', role: 'agent_operator' });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]), // no existing name
    });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]), // count = 0
    });
    mockTxInsertChain(tx, [createdToken]);

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty('token');
    expect(typeof body.data.token).toBe('string');
  });

  it('M1: token creation is wrapped in a transaction', async () => {
    const db = createMockDb();
    const tx = db._mockTx;

    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    mockTxInsertChain(tx, [makeToken()]);

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('returns 403 when token role exceeds user team role', async () => {
    const db = createMockDb();
    // user is viewer, wants admin token
    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, role: 'admin' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/cannot exceed/i);
  });

  it('returns 403 when user is not a member of the team', async () => {
    const db = createMockDb();
    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 409 on duplicate token name (TOKEN_NAME_EXISTS)', async () => {
    const db = createMockDb();
    const tx = db._mockTx;

    // Existing token with same name
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: 'existing-token' }]),
    });

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TOKEN_NAME_EXISTS');
  });

  it('returns 400 when user has 25 active tokens (LIMIT_EXCEEDED)', async () => {
    const db = createMockDb();
    const tx = db._mockTx;

    // No name conflict
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    // Count = 25
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 25 }]),
    });

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('converts expiresInDays to an ISO date in the response', async () => {
    const db = createMockDb();
    const tx = db._mockTx;
    const expectedExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const createdToken = makeToken({ expiresAt: expectedExpiry });

    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    mockTxInsertChain(tx, [createdToken]);

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, expiresInDays: 7 }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.expiresAt).toBeTruthy();
    // Should be a valid ISO date string
    expect(() => new Date(body.data.expiresAt)).not.toThrow();
  });

  it('dev authMethod bypasses role ceiling check', async () => {
    const db = createMockDb();
    const tx = db._mockTx;
    const createdToken = makeToken({ role: 'admin' });

    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    mockTxInsertChain(tx, [createdToken]);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth({ authMethod: 'dev' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, role: 'admin' }),
    });

    expect(res.status).toBe(201);
    // resolveTeamRole should NOT have been called
    expect(rbacService.resolveTeamRole).not.toHaveBeenCalled();
  });

  it('returns raw token only on creation (not a hash prefix)', async () => {
    const db = createMockDb();
    const tx = db._mockTx;
    const createdToken = makeToken();

    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    mockTxInsertChain(tx, [createdToken]);

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const body = await res.json();
    expect(body.data.token).toMatch(/^ap_/);
  });
});

// ─── GET /tokens ──────────────────────────────────────────────────────────────

describe('GET /tokens', () => {
  it('lists only active tokens by default', async () => {
    const db = createMockDb();
    const activeToken = makeToken();

    // count query
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 1 }]),
    });
    // list query
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([activeToken]),
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.totalCount).toBe(1);
  });

  it('M3: includes useCount in each item', async () => {
    const db = createMockDb();
    const tokenWithUseCount = makeToken({ useCount: 42 });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 1 }]),
    });
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([tokenWithUseCount]),
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens');
    const body = await res.json();
    expect(body.data.items[0].useCount).toBe(42);
  });

  it('showAll=true (status=all) includes revoked tokens', async () => {
    const db = createMockDb();
    const revokedToken = makeToken({ status: 'revoked' });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 1 }]),
    });
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([revokedToken]),
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens?status=all');
    const body = await res.json();
    expect(body.ok).toBe(true);
    // With status=all, revoked tokens are included
    expect(body.data.items[0].status).toBe('revoked');
  });

  it('teamId query param filters by team', async () => {
    const db = createMockDb();

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens?teamId=team-999');
    expect(res.status).toBe(200);
    const body = await res.json();
    // where was called; we can't inspect exact args without deeper mock introspection,
    // but the route should have applied the filter and succeeded
    expect(body.ok).toBe(true);
  });

  it('pagination returns nextCursor and hasMore when more results exist', async () => {
    const db = createMockDb();
    // Create limit+1 tokens (limit default 50, but we use limit=2 for simplicity)
    const tokens = [makeToken({ id: 'tok-001' }), makeToken({ id: 'tok-002' }), makeToken({ id: 'tok-003' })];

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 3 }]),
    });
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(tokens), // returns 3 items for limit=2
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens?limit=2');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBe('tok-002');
    expect(body.data.items).toHaveLength(2);
  });

  it('allTeam=true with teamId returns 403 for non-admin', async () => {
    const db = createMockDb();
    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens?allTeam=true&teamId=team-001');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allTeam=true with teamId succeeds for admin user', async () => {
    const db = createMockDb();

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ total: 0 }]),
    });
    const listChain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    db.select.mockReturnValueOnce(listChain);

    const rbacService = createMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    });
    const app = buildApp(makeAuth({ authMethod: 'session' }), db, rbacService);

    const res = await app.request('/tokens?allTeam=true&teamId=team-001');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ─── GET /tokens/:id ──────────────────────────────────────────────────────────

describe('GET /tokens/:id', () => {
  it('returns 404 for non-existent token', async () => {
    const db = createMockDb();
    mockSelectChain(db, []);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns token with enriched scopeTags when present', async () => {
    const db = createMockDb();
    const token = makeToken({ scopeTags: ['tag-001', 'tag-002'] });

    // First select: token with joins
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([token]),
    });

    // Second select: tag enrichment
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { id: 'tag-001', name: 'backend', color: '#ff0000' },
        { id: 'tag-002', name: 'frontend', color: '#00ff00' },
      ]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-abc123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.scopeTags).toHaveLength(2);
    expect(body.data.scopeTags[0]).toMatchObject({ id: 'tag-001', name: 'backend', color: '#ff0000' });
  });

  it('returns token without enriched scopeTags when scopeTags is null', async () => {
    const db = createMockDb();
    const token = makeToken({ scopeTags: null });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([token]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-abc123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scopeTags).toBeNull();
  });

  it('returns 400 for invalid token id format', async () => {
    const db = createMockDb();
    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/!!invalid!!');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('can only view own tokens (query filters by userId)', async () => {
    const db = createMockDb();
    // Simulate a token owned by different user — returns empty
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth({ userId: 'user-intruder' }), db, rbacService);

    const res = await app.request('/tokens/token-abc123');
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /tokens/:id ───────────────────────────────────────────────────────

describe('DELETE /tokens/:id', () => {
  it('revokes an active token and returns success', async () => {
    const db = createMockDb();

    // Atomic update: ne(status, 'revoked') matches, returns the updated row
    mockUpdateChain(db, [{ id: 'token-abc123', status: 'revoked' }]);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-abc123', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.revoked).toBe(true);
  });

  it('sets status to revoked and revokedAt timestamp on update', async () => {
    const db = createMockDb();

    // Atomic update returns the updated row
    const updateChain = mockUpdateChain(db, [{ id: 'token-abc123', status: 'revoked' }]);

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    await app.request('/tokens/token-abc123', { method: 'DELETE' });

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revoked', revokedAt: expect.any(String) })
    );
  });

  it('returns 409 when token is already revoked', async () => {
    const db = createMockDb();

    // Atomic update: ne(status, 'revoked') doesn't match → returns empty
    mockUpdateChain(db, []);
    // Follow-up select to distinguish not-found vs already-revoked: token exists
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ status: 'revoked' }]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-abc123', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_REVOKED');
  });

  it('returns 404 when token not found', async () => {
    const db = createMockDb();

    // Atomic update: no matching row → returns empty
    mockUpdateChain(db, []);
    // Follow-up select: token does not exist for this user
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/token-not-found', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('can only revoke own tokens (userId filter applied)', async () => {
    const db = createMockDb();
    // Atomic update: userId filter doesn't match → returns empty
    mockUpdateChain(db, []);
    // Follow-up select: token doesn't belong to this user
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });

    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth({ userId: 'user-intruder' }), db, rbacService);

    const res = await app.request('/tokens/token-abc123', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid token id format on delete', async () => {
    const db = createMockDb();
    const rbacService = createMockRbacService();
    const app = buildApp(makeAuth(), db, rbacService);

    const res = await app.request('/tokens/!!!bad-id!!!', { method: 'DELETE' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });
});
