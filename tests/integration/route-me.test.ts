import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createMeRoutes } from '../../src/server/routes/me';
import { createTestTeam, createTestTeamMember } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for the `/api/me` profile routes.
 *
 * Exercises the dev-mode synthetic profile branch, the user lookup with team
 * memberships, the PATCH email-uniqueness transaction, and validation +
 * not-found error branches.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function buildApp(auth: AuthContext) {
  const db = getTestDb();
  const wrapper = new Hono();
  wrapper.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  wrapper.route('/', createMeRoutes({ db }));
  return wrapper;
}

describe('Me Routes (IT-1750)', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-1750-1: GET / returns synthetic dev profile', async () => {
    const app = buildApp({
      authMethod: 'dev',
      userId: 'dev-user',
    } as AuthContext);
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('dev-user');
    expect(body.data.authMethod).toBe('dev');
    expect(body.data.teams).toEqual([]);
  });

  it('IT-1750-2: GET / returns 404 when user not found', async () => {
    const app = buildApp({
      authMethod: 'session',
      userId: 'no-such-user',
    } as AuthContext);
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1750-3: GET / returns user profile with team memberships', async () => {
    const user = await createTestUser({ name: 'Real User', email: 'real@test.com' });
    const team = await createTestTeam({ name: 'My Team', slug: 'my-team' });
    await createTestTeamMember(team.id, user.id, { role: 'admin' });

    const app = buildApp({
      authMethod: 'session',
      userId: user.id,
    } as AuthContext);

    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(user.id);
    expect(body.data.name).toBe('Real User');
    expect(body.data.email).toBe('real@test.com');
    expect(body.data.teams).toHaveLength(1);
    expect(body.data.teams[0]).toMatchObject({
      teamId: team.id,
      role: 'admin',
      name: 'My Team',
      slug: 'my-team',
    });
  });

  it('IT-1750-4: PATCH / rejects dev-mode profile updates', async () => {
    const app = buildApp({
      authMethod: 'dev',
      userId: 'dev-user',
    } as AuthContext);
    const res = await app.request(
      jsonRequest('http://localhost/', { name: 'New' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('IT-1750-5: PATCH / rejects empty body', async () => {
    const user = await createTestUser();
    const app = buildApp({
      authMethod: 'session',
      userId: user.id,
    } as AuthContext);
    const res = await app.request(jsonRequest('http://localhost/', {}, { method: 'PATCH' }));
    expect(res.status).toBe(400);
  });

  it('IT-1750-6: PATCH / updates name', async () => {
    const user = await createTestUser({ name: 'Old Name' });
    const app = buildApp({
      authMethod: 'session',
      userId: user.id,
    } as AuthContext);
    const res = await app.request(
      jsonRequest('http://localhost/', { name: 'New Name' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('New Name');
  });

  it('IT-1750-7: PATCH / updates email', async () => {
    const user = await createTestUser({ email: 'old@test.com' });
    const app = buildApp({
      authMethod: 'session',
      userId: user.id,
    } as AuthContext);
    const res = await app.request(
      jsonRequest('http://localhost/', { email: 'new@test.com' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe('new@test.com');
  });

  it('IT-1750-8: PATCH / rejects email already in use by another user', async () => {
    const other = await createTestUser({ email: 'taken@test.com' });
    const me = await createTestUser({ email: 'mine@test.com' });
    expect(other.id).not.toBe(me.id);
    const app = buildApp({
      authMethod: 'session',
      userId: me.id,
    } as AuthContext);
    const res = await app.request(
      jsonRequest('http://localhost/', { email: 'taken@test.com' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('IT-1750-9: PATCH / allows updating to the same email (excludes self in uniqueness check)', async () => {
    const user = await createTestUser({ email: 'me@test.com' });
    const app = buildApp({
      authMethod: 'session',
      userId: user.id,
    } as AuthContext);
    const res = await app.request(
      jsonRequest(
        'http://localhost/',
        { email: 'me@test.com', name: 'Same Email' },
        { method: 'PATCH' }
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe('me@test.com');
    expect(body.data.name).toBe('Same Email');
  });

  it('IT-1750-10: PATCH / returns 404 when authenticated user no longer exists', async () => {
    const app = buildApp({
      authMethod: 'session',
      userId: 'ghost-user',
    } as AuthContext);
    const res = await app.request(
      jsonRequest('http://localhost/', { name: 'Ghost' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
