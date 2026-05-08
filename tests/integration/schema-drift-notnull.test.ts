/**
 * Schema drift: NOT NULL parity between Drizzle and the SQLite runtime schema.
 *
 * Auto-generated for every Drizzle SQLite table: each `notNull()` column in
 * Drizzle must also be `NOT NULL` in the actual table. The PRAGMA table_info
 * `notnull` flag is the source of truth.
 *
 * Why this matters: Drizzle's TypeScript types treat `notNull()` columns as
 * non-nullable on SELECT. If the DB still allows NULL, a SELECT can return
 * `null` for a field the type system says is `string`, leading to silent
 * runtime crashes downstream (`undefined.startsWith is not a function`,
 * UI rendering blank values, etc.). External writers (raw SQL migrations,
 * other tooling) can also leave the column NULL undetected.
 *
 * Sibling of the v43 `tags.team_id` bug: the v19 ALTER TABLE added
 * `tags.project_folder_id` without `NOT NULL`, but Drizzle declares it
 * `notNull()`. This test would have caught it.
 *
 * Notes:
 *  - Primary-key columns are skipped because SQLite's `PRAGMA table_info`
 *    historically reports `notnull=0` for `INTEGER/TEXT PRIMARY KEY` even
 *    though SQLite enforces NOT NULL on them. Comparing PK NOT NULL is
 *    therefore a false-positive trap and not load-bearing.
 *  - `EXPECTED_NULLABLE_DRIFT` carries the known-and-tracked drift entries
 *    so the suite stays green while the underlying migrations are written.
 *    Each entry is keyed to the migration that should fix it; remove the
 *    entry once the migration lands.
 */
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema/sqlite';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

interface PragmaRow {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: 0 | 1;
}

interface TableCase {
  dbName: string;
  notNullColumns: string[];
  primaryKeyColumns: Set<string>;
}

function collectTableCases(): TableCase[] {
  const cases: TableCase[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const cols = getTableColumns(value as SQLiteTable);
    const dbName = getTableName(value as SQLiteTable);
    const notNullColumns: string[] = [];
    const primaryKeyColumns = new Set<string>();
    for (const col of Object.values(cols)) {
      if ((col as { primary?: boolean }).primary) {
        primaryKeyColumns.add(col.name);
      }
      if ((col as { notNull?: boolean }).notNull) {
        notNullColumns.push(col.name);
      }
    }
    cases.push({ dbName, notNullColumns, primaryKeyColumns });
  }
  return cases.sort((a, b) => a.dbName.localeCompare(b.dbName));
}

const CASES = collectTableCases();

/**
 * Known DB-side NOT NULL drift that has not been migrated yet. Each entry
 * MUST be cross-linked to the migration that will fix it. Remove when the
 * migration lands and the column is enforced NOT NULL at the DB layer.
 */
const EXPECTED_NULLABLE_DRIFT: Record<string, Set<string>> = {
  // Legacy stub created by v40-plan-sessions-column-catchup keeps every
  // column nullable for backward compatibility with pre-existing DBs that
  // already had a stub. A future rebuild migration will rebuild plan_sessions
  // with the correct NOT NULL shape.
  plan_sessions: new Set(['task_id', 'codespace_id', 'status', 'created_at', 'updated_at']),
};

describe('Schema drift: NOT NULL parity (auto-generated)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterAll(async () => {
    await clearTestDatabase();
  });

  it('generator produces at least 30 NOT NULL drift cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  for (const testCase of CASES) {
    if (testCase.notNullColumns.length === 0) continue;
    it(`${testCase.dbName}: every notNull() Drizzle column is NOT NULL in DB`, async () => {
      const rows = db.all<PragmaRow>(sql`PRAGMA table_info(${sql.identifier(testCase.dbName)})`);
      if (rows.length === 0) return; // table not present (covered by the column-existence suite)
      const dbColMap = new Map(rows.map((r) => [r.name, r]));
      const expectedSkips = EXPECTED_NULLABLE_DRIFT[testCase.dbName] ?? new Set<string>();

      for (const colName of testCase.notNullColumns) {
        // PK NOT NULL: PRAGMA reports notnull=0 even though SQLite enforces
        // it. Skip to avoid false positives.
        if (testCase.primaryKeyColumns.has(colName)) continue;
        if (expectedSkips.has(colName)) continue;
        const dbCol = dbColMap.get(colName);
        if (!dbCol) continue; // column-existence is checked in the sibling suite
        expect(
          dbCol.notnull,
          `Table '${testCase.dbName}' column '${colName}' is nullable in DB but Drizzle declares notNull(). Add a migration to enforce NOT NULL at the DB layer.`
        ).toBe(1);
      }
    });
  }
});
