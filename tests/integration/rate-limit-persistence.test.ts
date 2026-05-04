/**
 * F06-NEW-08: SQLite-backed rate-limit persistence.
 *
 * Verifies that rate-limit counters survive a process restart.
 *
 *  - Without the fix (in-memory `Map`): the counter resets when a fresh
 *    middleware is constructed, so a request that should be 429 returns 200.
 *  - With the fix (`createSqliteBackend`): the counter is persisted in the
 *    `rate_limit_buckets` table; a fresh middleware reads the persisted
 *    state on the next request and still rejects with 429.
 *
 * Critical: the test must reuse the **same Drizzle DB instance** across the
 * "two middleware lifetimes" because that mirrors the single-machine restart
 * scenario where the SQLite file is preserved on disk while the process
 * memory is wiped. We simulate the restart by creating two independent Hono
 * apps pointing at the same backend factory call. With SQLite persistence
 * the second app shares the bucket state via the table.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getRuntimeSchemaTables } from '../../src/db/schema/runtime-tables.js';
import {
  createInMemoryBackend,
  createRateLimitCleanupJob,
  createSqliteBackend,
  rateLimiter,
} from '../../src/lib/api/rate-limiter.js';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database.js';

const { rateLimitBuckets } = getRuntimeSchemaTables('sqlite');

function makeApp(opts: Parameters<typeof rateLimiter>[0]) {
  const app = new Hono();
  app.use('/*', rateLimiter(opts));
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('Rate limiter SQLite persistence (F06-NEW-08)', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('persists buckets across restart — restart preserves 429 (red→green)', async () => {
    const db = getTestDb();
    // First "process lifetime": construct backend, exhaust the limit.
    const backend1 = createSqliteBackend(db);
    const app1 = makeApp({
      max: 2,
      windowMs: 60_000,
      backend: backend1,
      // Pin the key so both lifetimes target the same bucket.
      keyFrom: () => 'ip:test-restart',
    });

    expect((await app1.request('/test')).status).toBe(200);
    expect((await app1.request('/test')).status).toBe(200);
    // Third request exhausts the limit.
    expect((await app1.request('/test')).status).toBe(429);

    // Persisted state assertion: the bucket exists in the table with count=3.
    const persisted = await db.select().from(rateLimitBuckets);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.count).toBe(3);
    expect(persisted[0]?.key).toBe('ip:test-restart');

    // Simulate process restart: drop backend1, create a fresh backend pointing
    // at the same DB. With persistence, the counter is still at 3 — so the
    // next request must still be 429.
    const backend2 = createSqliteBackend(db);
    const app2 = makeApp({
      max: 2,
      windowMs: 60_000,
      backend: backend2,
      keyFrom: () => 'ip:test-restart',
    });

    const afterRestart = await app2.request('/test');
    expect(
      afterRestart.status,
      'Restart-bypass detected: rate limiter forgot the bucket. Verify createSqliteBackend persists to rate_limit_buckets.'
    ).toBe(429);
  });

  it('control: in-memory backend forgets the bucket on restart (proves the bug exists)', async () => {
    // Same scenario but with the legacy in-memory backend. This documents
    // the bug F06-NEW-08 was opened to fix: counters are lost on restart.
    const backend1 = createInMemoryBackend();
    const app1 = makeApp({
      max: 2,
      windowMs: 60_000,
      backend: backend1,
      keyFrom: () => 'ip:test-mem-restart',
    });

    expect((await app1.request('/test')).status).toBe(200);
    expect((await app1.request('/test')).status).toBe(200);
    expect((await app1.request('/test')).status).toBe(429);

    // Restart: a fresh in-memory backend has an empty Map.
    const backend2 = createInMemoryBackend();
    const app2 = makeApp({
      max: 2,
      windowMs: 60_000,
      backend: backend2,
      keyFrom: () => 'ip:test-mem-restart',
    });

    // The bug: limit counter reset to zero, so this request is incorrectly 200.
    const afterRestart = await app2.request('/test');
    expect(afterRestart.status).toBe(200);
  });

  it('atomically increments concurrent requests via onConflictDoUpdate', async () => {
    // The composite primary key means two concurrent requests on the same
    // bucket must serialise into count: 2, not lose an increment.
    const db = getTestDb();
    const backend = createSqliteBackend(db);
    const app = makeApp({
      max: 100,
      windowMs: 60_000,
      backend,
      keyFrom: () => 'ip:concurrent',
    });

    // 10 concurrent requests.
    const responses = await Promise.all(Array.from({ length: 10 }, () => app.request('/test')));
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const rows = await db.select().from(rateLimitBuckets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(10);
  });

  it('quantises to the windowMs boundary so requests in the same window upsert the same row', async () => {
    const db = getTestDb();
    const backend = createSqliteBackend(db);
    const app = makeApp({
      max: 100,
      windowMs: 60_000,
      backend,
      keyFrom: () => 'ip:window-test',
    });

    await app.request('/test');
    await app.request('/test');
    await app.request('/test');

    // Both requests must hit the same window_start bucket.
    const rows = await db.select().from(rateLimitBuckets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it('different keys get different buckets (separate rows)', async () => {
    const db = getTestDb();
    const backend = createSqliteBackend(db);

    let key = 'ip:user-A';
    const app = makeApp({
      max: 100,
      windowMs: 60_000,
      backend,
      keyFrom: () => key,
    });

    await app.request('/test');
    await app.request('/test');

    key = 'ip:user-B';
    await app.request('/test');

    const rows = await db.select().from(rateLimitBuckets);
    expect(rows.map((r) => r.key).sort()).toEqual(['ip:user-A', 'ip:user-B']);
    const userA = rows.find((r) => r.key === 'ip:user-A');
    const userB = rows.find((r) => r.key === 'ip:user-B');
    expect(userA?.count).toBe(2);
    expect(userB?.count).toBe(1);
  });

  it('cleanup job deletes rows older than 24h, preserves recent rows', async () => {
    const db = getTestDb();
    const cleanup = createRateLimitCleanupJob(db);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Old row (older than 24h).
    await db.insert(rateLimitBuckets).values({
      key: 'ip:old',
      windowStart: now - 2 * dayMs,
      windowMs: 60_000,
      count: 5,
      updatedAt: now - 2 * dayMs,
    });

    // Recent row (10 minutes ago — well within retention).
    await db.insert(rateLimitBuckets).values({
      key: 'ip:recent',
      windowStart: now - 10 * 60 * 1000,
      windowMs: 60_000,
      count: 3,
      updatedAt: now - 10 * 60 * 1000,
    });

    const deleted = await cleanup.runOnce();
    expect(deleted).toBe(1);

    const remaining = await db.select().from(rateLimitBuckets);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.key).toBe('ip:recent');
  });

  it('cleanup job is a BackgroundJob with start/stop/healthSnapshot lifecycle', async () => {
    const db = getTestDb();
    const cleanup = createRateLimitCleanupJob(db);

    expect(cleanup.name).toBe('rateLimitCleanup');
    expect(cleanup.healthSnapshot().running).toBe(false);

    cleanup.start();
    expect(cleanup.healthSnapshot().running).toBe(true);

    // Idempotent.
    cleanup.start();
    expect(cleanup.healthSnapshot().running).toBe(true);

    cleanup.stop();
    expect(cleanup.healthSnapshot().running).toBe(false);

    // Idempotent.
    cleanup.stop();
    expect(cleanup.healthSnapshot().running).toBe(false);
  });

  it('cleanup job records lastRunAt after a successful sweep', async () => {
    const db = getTestDb();
    const cleanup = createRateLimitCleanupJob(db);

    expect(cleanup.healthSnapshot().lastRunAt).toBeUndefined();
    await cleanup.runOnce();
    const snap = cleanup.healthSnapshot();
    expect(snap.lastRunAt).toBeDefined();
    expect(snap.lastError).toBeUndefined();
  });
});
