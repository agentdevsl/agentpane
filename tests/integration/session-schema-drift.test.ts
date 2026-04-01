/**
 * Integration test: Detect schema drift between Drizzle ORM definitions and actual DB tables.
 *
 * This test prevents the bug where the sessions table schema diverges from
 * what Drizzle expects, causing silent INSERT failures (columns don't exist)
 * that result in 0 sessions being stored despite agents running.
 */
import { getTableColumns, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessions } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Session schema drift detection', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('DB sessions table has all columns defined in Drizzle schema', async () => {
    // Get the columns Drizzle expects
    const drizzleColumns = getTableColumns(sessions);
    const expectedColumns = Object.values(drizzleColumns).map((col) => col.name);

    // Get actual DB columns via pragma
    const tableInfo = db.all<{ name: string }>(sql`PRAGMA table_info(sessions)`);
    const actualColumns = tableInfo.map((col) => col.name);

    // Every Drizzle column must exist in the DB
    for (const expected of expectedColumns) {
      expect(
        actualColumns,
        `DB missing column '${expected}' that Drizzle schema defines`
      ).toContain(expected);
    }
  });

  it('session INSERT succeeds with all Drizzle schema fields', async () => {
    const codespace = await createTestProject();

    // This will fail if the DB table is missing any columns Drizzle tries to write
    const session = await createTestSession(codespace.id, {
      title: 'Schema drift test session',
      status: 'active',
    });

    expect(session).toBeDefined();
    expect(session.id).toBeTruthy();
    expect(session.codespaceId).toBe(codespace.id);
    expect(session.title).toBe('Schema drift test session');
    expect(session.status).toBe('active');
    expect(session.url).toBeTruthy();
    expect(session.createdAt).toBeTruthy();
  });

  it('session can be queried back with all expected fields', async () => {
    const codespace = await createTestProject();
    const created = await createTestSession(codespace.id, {
      title: 'Roundtrip test',
      status: 'active',
    });

    // Query using Drizzle — this validates SELECT column mapping matches DB
    const rows = await db.select().from(sessions);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const found = rows.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Roundtrip test');
    expect(found!.codespaceId).toBe(codespace.id);
    expect(found!.status).toBe('active');
  });
});
