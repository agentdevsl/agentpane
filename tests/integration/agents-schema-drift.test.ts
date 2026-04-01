/**
 * Integration test: Detect schema drift between Drizzle ORM definitions and actual DB tables.
 *
 * This test prevents the bug where the agents table schema diverges from
 * what Drizzle expects, causing silent INSERT failures (columns don't exist)
 * that result in agents not being stored despite creation calls succeeding.
 */
import { getTableColumns, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject as createTestCodespace } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Agent schema drift detection', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('DB agents table has all columns defined in Drizzle schema', async () => {
    // Get the columns Drizzle expects
    const drizzleColumns = getTableColumns(agents);
    const expectedColumns = Object.values(drizzleColumns).map((col) => col.name);

    // Get actual DB columns via pragma
    const tableInfo = db.all<{ name: string }>(sql`PRAGMA table_info(agents)`);
    const actualColumns = tableInfo.map((col) => col.name);

    // Every Drizzle column must exist in the DB
    for (const expected of expectedColumns) {
      expect(
        actualColumns,
        `DB missing column '${expected}' that Drizzle schema defines`
      ).toContain(expected);
    }
  });

  it('agent INSERT succeeds with all Drizzle schema fields', async () => {
    const codespace = await createTestCodespace();

    // This will fail if the DB table is missing any columns Drizzle tries to write
    const agent = await createTestAgent(codespace.id, {
      name: 'Schema drift test agent',
      status: 'idle',
      type: 'task',
    });

    expect(agent).toBeDefined();
    expect(agent.id).toBeTruthy();
    expect(agent.codespaceId).toBe(codespace.id);
    expect(agent.name).toBe('Schema drift test agent');
    expect(agent.status).toBe('idle');
    expect(agent.type).toBe('task');
    expect(agent.createdAt).toBeTruthy();
  });

  it('agent can be queried back with all expected fields', async () => {
    const codespace = await createTestCodespace();
    const created = await createTestAgent(codespace.id, {
      name: 'Roundtrip test',
      status: 'idle',
      type: 'task',
    });

    // Query using Drizzle — this validates SELECT column mapping matches DB
    const rows = await db.select().from(agents);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const found = rows.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Roundtrip test');
    expect(found!.codespaceId).toBe(codespace.id);
    expect(found!.status).toBe('idle');
    expect(found!.type).toBe('task');
  });
});
