/**
 * F05-23 / F06-NEW-11 (arch29-W2-K) — Caddy stream auth tenant scope.
 *
 * Without this fix the verify-stream endpoint only checks "logged in" — any
 * authenticated user could subscribe to any session/plan/sandbox stream by
 * guessing or scraping the CUID. Direct subscribes via Caddy at
 * `/v1/stream/{kind}/{id}` bypass the Hono router (the only path post-PR-176
 * since the in-API SSE endpoint was removed), so verify-stream is the sole
 * gate.
 *
 * This test exercises that gate:
 *   1. User A subscribes to user A's session  → 200 (allowed).
 *   2. User B subscribes to user A's session  → 403 (cross-tenant denied).
 *   3. Same matrix for plans and sandboxes.
 *   4. Unknown stream id  → 404.
 *   5. cli-monitor (singleton)  → 200 for any authenticated user.
 *
 * Without the fix all "B → A" cases would return 200; with the fix they 403.
 */

import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectFolders,
  sessions,
  teamMembers,
  teamProjectFolders,
  teams,
  userSessions,
  users,
} from '../../src/db/schema';
import { planSessions } from '../../src/db/schema/sqlite/plan-sessions';
import { sandboxInstances } from '../../src/db/schema/sqlite/sandboxes';
import { tasks } from '../../src/db/schema/sqlite/tasks';
import { createAuthRoutes } from '../../src/server/routes/auth.js';
import { hashToken } from '../../src/server/shared.js';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * The minimal in-memory test schema does not include `plan_sessions` or
 * `sandbox_instances`. Create them on demand with the shape Drizzle expects
 * — matches the production migrations but with FKs relaxed (the helper runs
 * with `foreign_keys = OFF` anyway).
 */
function ensureStreamEntityTables(): void {
  execRawSql(`
    CREATE TABLE IF NOT EXISTS sandbox_instances (
      id TEXT PRIMARY KEY NOT NULL,
      codespace_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      status TEXT DEFAULT 'stopped' NOT NULL,
      image TEXT NOT NULL,
      memory_mb INTEGER NOT NULL,
      cpu_cores INTEGER NOT NULL,
      idle_timeout_minutes INTEGER NOT NULL,
      volume_mounts TEXT DEFAULT '[]',
      env TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
      stopped_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);
  // The v19 migration creates a stub plan_sessions; we drop and recreate to
  // match the active Drizzle schema (codespace_id NOT NULL).
  execRawSql(`
    DROP TABLE IF EXISTS plan_sessions;
    CREATE TABLE plan_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      codespace_id TEXT NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      turns TEXT DEFAULT '[]',
      github_issue_url TEXT,
      github_issue_number INTEGER,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);
}

interface TenantSetup {
  userId: string;
  sessionToken: string;
  codespaceId: string;
}

async function seedTenant(label: string): Promise<TenantSetup> {
  const db = getTestDb();
  const userId = `user-${label}-${createId().slice(0, 6)}`;
  const githubId = Math.floor(Math.random() * 2_000_000_000) + 1;

  await db.insert(users).values({
    id: userId,
    githubId,
    githubLogin: `gh-${label}-${userId.slice(-6)}`,
    name: `Tenant ${label}`,
    email: `${label}@example.test`,
  });

  const folderId = createId();
  await db.insert(projectFolders).values({
    id: folderId,
    name: `Folder-${label}`,
    slug: `folder-${label}-${folderId.slice(0, 6)}`,
  });

  const teamId = createId();
  await db.insert(teams).values({
    id: teamId,
    name: `Team-${label}`,
    slug: `team-${label}-${teamId.slice(0, 8)}`,
  });
  await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
  await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

  const codespace = await createTestProject({ projectFolderId: folderId, name: `cs-${label}` });

  const sessionToken = `tok-${label}-${createId().slice(0, 8)}`;
  await db.insert(userSessions).values({
    id: createId(),
    userId,
    token: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  return { userId, sessionToken, codespaceId: codespace.id };
}

async function createSessionForCodespace(codespaceId: string): Promise<string> {
  const db = getTestDb();
  const id = createId();
  await db.insert(sessions).values({
    id,
    codespaceId,
    status: 'active',
    url: `http://localhost:3000/sessions/${id}`,
  });
  return id;
}

async function createPlanSessionForCodespace(codespaceId: string): Promise<string> {
  const db = getTestDb();
  const taskId = createId();
  await db.insert(tasks).values({
    id: taskId,
    codespaceId,
    title: 'plan-task',
    column: 'backlog',
  });
  const id = createId();
  await db.insert(planSessions).values({
    id,
    taskId,
    codespaceId,
    status: 'active',
    turns: [],
  });
  return id;
}

async function createSandboxForCodespace(codespaceId: string): Promise<string> {
  const db = getTestDb();
  const id = createId();
  await db.insert(sandboxInstances).values({
    id,
    codespaceId,
    containerId: `cont-${id}`,
    status: 'running',
    image: 'test:latest',
    memoryMb: 512,
    cpuCores: 1,
    idleTimeoutMinutes: 30,
    volumeMounts: [],
  });
  return id;
}

function buildApp() {
  const app = new Hono();
  app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
  return app;
}

async function callVerify(opts: {
  app: ReturnType<typeof buildApp>;
  uri: string;
  token?: string;
}): Promise<Response> {
  const headers: Record<string, string> = { 'X-Original-URI': opts.uri };
  if (opts.token) headers.Cookie = `agentpane_session=${opts.token}`;
  return opts.app.request('/api/auth/verify-stream', { method: 'POST', headers });
}

describe('verify-stream per-stream tenant scope (F05-23, F06-NEW-11)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    ensureStreamEntityTables();
  });

  afterEach(async () => {
    try {
      execRawSql('DELETE FROM plan_sessions');
      execRawSql('DELETE FROM sandbox_instances');
    } catch {
      // tables may have been dropped between tests — safe to ignore
    }
    await clearTestDatabase();
  });

  it('allows a user to subscribe to their own session stream', async () => {
    const a = await seedTenant('a');
    const sessionId = await createSessionForCodespace(a.codespaceId);
    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/sessions/${sessionId}`,
      token: a.sessionToken,
    });
    expect(res.status).toBe(200);
  });

  it('blocks user B from subscribing to user A session stream (cross-tenant 403)', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    const sessionIdA = await createSessionForCodespace(a.codespaceId);

    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/sessions/${sessionIdA}`,
      token: b.sessionToken,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('FORBIDDEN');
  });

  it('blocks user B from subscribing to user A plan stream (cross-tenant 403)', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    const planId = await createPlanSessionForCodespace(a.codespaceId);

    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/plans/${planId}`,
      token: b.sessionToken,
    });
    expect(res.status).toBe(403);
  });

  it('blocks user B from subscribing to user A sandbox stream (cross-tenant 403)', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    const sandboxId = await createSandboxForCodespace(a.codespaceId);

    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/sandboxes/${sandboxId}`,
      token: b.sessionToken,
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown stream id', async () => {
    const a = await seedTenant('a');
    const app = buildApp();
    const res = await callVerify({
      app,
      uri: '/v1/stream/sessions/does-not-exist',
      token: a.sessionToken,
    });
    expect(res.status).toBe(404);
  });

  it('allows owner to subscribe to their own plan stream', async () => {
    const a = await seedTenant('a');
    const planId = await createPlanSessionForCodespace(a.codespaceId);

    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/plans/${planId}`,
      token: a.sessionToken,
    });
    expect(res.status).toBe(200);
  });

  it('allows owner to subscribe to their own sandbox stream', async () => {
    const a = await seedTenant('a');
    const sandboxId = await createSandboxForCodespace(a.codespaceId);

    const app = buildApp();
    const res = await callVerify({
      app,
      uri: `/v1/stream/sandboxes/${sandboxId}`,
      token: a.sessionToken,
    });
    expect(res.status).toBe(200);
  });

  it('cli-monitor singleton stream allows any authenticated user', async () => {
    const b = await seedTenant('b');
    const app = buildApp();
    const res = await callVerify({
      app,
      uri: '/v1/stream/cli-monitor',
      token: b.sessionToken,
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 (not 403) when no session cookie is supplied', async () => {
    // Layered: even before the per-stream check we must require a valid
    // session cookie. Direct Caddy subscribes that bypass Hono cannot reach
    // /v1/stream/* without forward_auth returning 200, so the cookie check
    // remains the first line of defence.
    const app = buildApp();
    const res = await callVerify({
      app,
      uri: '/v1/stream/sessions/anything',
    });
    expect(res.status).toBe(401);
  });
});
