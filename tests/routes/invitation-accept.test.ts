/**
 * Tests for invitation accept route.
 *
 * Covers:
 * - POST /:token/accept: token validation, email checks, transaction handling
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createInvitationAcceptRoutes } from '../../src/server/routes/invitation-accept';

// ── Mock External Dependencies ──

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
    transaction: vi.fn(),
    query: {
      teams: {
        findFirst: vi.fn(),
      },
    },
  };
}

function buildApp(db: ReturnType<typeof buildMockDb>, authContext: Partial<AuthContext> = {}) {
  const defaultAuth: AuthContext = {
    userId: 'user-001',
    authMethod: 'dev',
    user: { githubEmail: 'test@example.com' } as never,
    ...authContext,
  };

  const routes = createInvitationAcceptRoutes({ db: db as never });

  const app = new Hono();
  app.use('/api/invitations/*', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.route('/api/invitations', routes);
  app.onError((err, c) =>
    c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500)
  );

  return app;
}

// ── Tests ──

describe('POST /api/invitations/:token/accept - Accept invitation', () => {
  let db: ReturnType<typeof buildMockDb>;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    app = buildApp(db);
  });

  it('accepts an invitation and returns 201', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  email: 'test@example.com',
                  teamId: 'team-1',
                  role: 'admin',
                  status: 'accepted',
                },
              ]),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        query: {
          teams: {
            findFirst: vi.fn().mockResolvedValue({ name: 'Test Team' }),
          },
        },
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/valid-token-123/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe('team-1');
    expect(body.data.role).toBe('admin');
    expect(body.data.teamName).toBe('Test Team');
  });

  it('returns 400 for invalid token format', async () => {
    const res = await app.request('/api/invitations/bad!token/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 404 when invitation not found (expired/used/invalid)', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/nonexistent-token/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('returns 403 when user has no verified email', async () => {
    app = buildApp(db, { user: { githubEmail: undefined } as never });
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  email: 'test@example.com',
                  teamId: 'team-1',
                  role: 'admin',
                  status: 'accepted',
                },
              ]),
            }),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/valid-token-123/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when email does not match invitation', async () => {
    app = buildApp(db, { user: { githubEmail: 'different@example.com' } as never });
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  email: 'test@example.com',
                  teamId: 'team-1',
                  role: 'admin',
                  status: 'accepted',
                },
              ]),
            }),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/valid-token-123/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('returns 409 when user is already a team member', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  email: 'test@example.com',
                  teamId: 'team-1',
                  role: 'admin',
                  status: 'accepted',
                },
              ]),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([{ teamId: 'team-1', userId: 'user-001', role: 'admin' }]),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/valid-token-123/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('handles invitation without email restriction (email is null)', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'inv-1',
                  email: null,
                  teamId: 'team-1',
                  role: 'viewer',
                  status: 'accepted',
                },
              ]),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        query: {
          teams: {
            findFirst: vi.fn().mockResolvedValue({ name: 'Open Team' }),
          },
        },
      };
      return fn(tx);
    });

    const res = await app.request('/api/invitations/open-invite-token/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.role).toBe('viewer');
  });

  it('returns 500 when transaction throws', async () => {
    db.transaction.mockRejectedValue(new Error('DB failure'));

    const res = await app.request('/api/invitations/valid-token-123/accept', {
      method: 'POST',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
