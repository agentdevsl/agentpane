/**
 * Functional Bug-Proving Tests for Drizzle parameter binding type mismatches.
 *
 * Pattern hunted: passing a JS value into a raw `sql\`...${value}\`` template
 * (or into Drizzle's parameter binder) where `value` is not one of the types
 * better-sqlite3 can bind: number, string, bigint, buffer, null.
 *
 * Reference fix that motivated this hunt: commit `c5af0be2` —
 * `scheduler.service.ts:resumeSource()` was passing a JS boolean directly
 * into a Drizzle parameterised template. SQLite's better-sqlite3 driver
 * threw `TypeError: SQLite3 can only bind numbers, strings, bigints,
 * buffers, and null` because booleans aren't bindable.
 *
 * This file targets a sibling latent bug found in `src/lib/db/dialect.ts`:
 *   - `jsonSet(col, path, value)` — the SQLite branch (line 146) passes the
 *     `value` argument directly into a `sql\`json_set(${col}, ${path}, ${value})\``
 *     template. The function signature accepts `boolean` (matching the PG
 *     branch which has explicit boolean handling), but the SQLite branch
 *     would crash with the same TypeError if any caller ever supplied one.
 *
 * The PG branch already handles booleans via an explicit `to_jsonb(${value}::boolean)`
 * cast, so it works fine. The asymmetry is the bug.
 *
 * Currently no production caller passes a boolean (all callers are scheduler
 * code passing strings/numbers/null), but the API surface declares boolean
 * as a valid value type. This test pins the SQLite branch's behaviour so a
 * future caller doesn't crash in production.
 *
 * Run: npx vitest run --project functional tests/functional/prove-drizzle-binding-bugs.test.ts
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventSources, teams } from '../../src/db/schema';
import { _resetDbDialectCacheForTests, jsonSet, runRaw } from '../../src/lib/db/dialect';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Prove: Drizzle binding bugs (jsonSet boolean on SQLite)', () => {
  beforeEach(async () => {
    process.env.DB_MODE = 'sqlite';
    _resetDbDialectCacheForTests();
    await setupTestDatabase();
    await clearTestDatabase();
  });

  afterEach(() => {
    _resetDbDialectCacheForTests();
  });

  it('jsonSet on SQLite must accept a JS boolean value without crashing the driver', async () => {
    const db = getTestDb();

    // Seed a team + event source so we have a JSON column to update.
    const teamId = 'team_binding_001';
    const sourceId = 'src_binding_001';
    await db.insert(teams).values({
      id: teamId,
      name: 'binding-test-team',
      slug: 'binding-test-team',
      createdBy: 'user_x',
    });
    await db.insert(eventSources).values({
      id: sourceId,
      teamId,
      name: 'binding-test-source',
      slug: 'binding-test-source',
      type: 'cron',
      isEnabled: true,
      config: { scheduleType: 'cron', cronExpression: '*/5 * * * *', timezone: 'UTC' },
    });

    // Build the same shape `jsonSetMany` would produce when given a boolean
    // patch: `[['featureFlag'], true]`.
    const patch = jsonSet(eventSources.config, ['featureFlag'], true);

    // Wrap in an UPDATE so it actually exercises the binder. Before the fix
    // this throws `TypeError: SQLite3 can only bind numbers, strings,
    // bigints, buffers, and null` because the SQLite branch interpolates the
    // raw boolean as a parameter.
    await expect(
      runRaw(db, sql`UPDATE event_sources SET config = ${patch} WHERE id = ${sourceId}`)
    ).resolves.toBeDefined();

    // Verify the boolean round-tripped as JSON true (not the strings "true"
    // or "1") so a future Postgres consumer reads the same shape.
    const row = await db.query.eventSources.findFirst({
      where: (t, { eq }) => eq(t.id, sourceId),
    });
    expect(row).toBeDefined();
    const cfg = row?.config as Record<string, unknown>;
    expect(cfg.featureFlag).toBe(true);
  });

  it('jsonSet on SQLite must accept a JS boolean false without crashing', async () => {
    const db = getTestDb();

    const teamId = 'team_binding_002';
    const sourceId = 'src_binding_002';
    await db.insert(teams).values({
      id: teamId,
      name: 'binding-test-team-2',
      slug: 'binding-test-team-2',
      createdBy: 'user_x',
    });
    await db.insert(eventSources).values({
      id: sourceId,
      teamId,
      name: 'binding-test-source-2',
      slug: 'binding-test-source-2',
      type: 'cron',
      isEnabled: true,
      config: { scheduleType: 'cron', cronExpression: '*/5 * * * *', timezone: 'UTC' },
    });

    const patch = jsonSet(eventSources.config, ['featureFlag'], false);

    await expect(
      runRaw(db, sql`UPDATE event_sources SET config = ${patch} WHERE id = ${sourceId}`)
    ).resolves.toBeDefined();

    const row = await db.query.eventSources.findFirst({
      where: (t, { eq }) => eq(t.id, sourceId),
    });
    const cfg = row?.config as Record<string, unknown>;
    expect(cfg.featureFlag).toBe(false);
  });
});
