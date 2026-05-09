/**
 * Schema drift: detect DB-side columns that no Drizzle schema declares —
 * the inverse of `schema-drift-all-tables.test.ts`.
 *
 * The v43 `tags.team_id` bug was an orphan column: bootstrap created
 * `tags.team_id NOT NULL`, the v19 migration added `project_folder_id`
 * without dropping `team_id`, and Drizzle (`src/db/schema/sqlite/tags.ts`)
 * only declared `project_folder_id`. The result: every `db.insert(tags)`
 * call rejected with `NOT NULL constraint failed: tags.team_id`.
 *
 * This suite finds columns the bootstrap leaves behind. NOT NULL orphans
 * are immediately bug-equivalent to the v43 case (any Drizzle insert that
 * omits the column fails). Nullable orphans are dead-weight cruft but
 * harmless on insert; they live in `KNOWN_LEGACY_NULLABLE_COLUMNS` so the
 * suite catches new orphan growth without flapping on intentional legacy
 * carry-overs from the projects→codespaces rename.
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
  drizzleColumns: Set<string>;
}

function collectTableCases(): TableCase[] {
  const cases: TableCase[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const cols = getTableColumns(value as SQLiteTable);
    cases.push({
      dbName: getTableName(value as SQLiteTable),
      drizzleColumns: new Set(Object.values(cols).map((c) => c.name)),
    });
  }
  return cases.sort((a, b) => a.dbName.localeCompare(b.dbName));
}

const CASES = collectTableCases();

/**
 * Legacy columns intentionally retained at the DB layer after the
 * projects→codespaces rename and similar refactors. Each entry is a
 * nullable column with no DB-level constraint — Drizzle ignores it on
 * inserts, and removing it would require a costly table rebuild for
 * negligible gain. Add a column here ONLY when you have verified:
 *   1. The DB column has no NOT NULL constraint (otherwise it is a v43-
 *      style insert-blocker and must be dropped, not whitelisted).
 *   2. No service writes to it via raw SQL.
 *   3. The column does not satisfy any application-level invariant.
 */
const KNOWN_LEGACY_NULLABLE_COLUMNS: Record<string, Set<string>> = {
  // Pre-v19 project FK that v19 migrated to `codespace_id`. Nullable post-
  // rename; no service writes to it. Cannot be dropped without a full table
  // rebuild that nulls every legacy reference first.
  audit_logs: new Set(['project_id']),
  templates: new Set(['project_id']),
  api_tokens: new Set(['scope_project_id']),
  // v46 plan_sessions-schema-rebuild drops the legacy project_id and
  // session_id columns; no whitelist entry needed any more.
};

describe('Schema drift: orphan column detection (siblings of v43 tags.team_id)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterAll(async () => {
    await clearTestDatabase();
  });

  for (const testCase of CASES) {
    it(`${testCase.dbName}: every DB column is declared in Drizzle (or whitelisted as legacy)`, async () => {
      const rows = db.all<PragmaRow>(sql`PRAGMA table_info(${sql.identifier(testCase.dbName)})`);
      if (rows.length === 0) return; // table not present (covered by the column-existence suite)
      const allowedLegacy = KNOWN_LEGACY_NULLABLE_COLUMNS[testCase.dbName] ?? new Set<string>();

      for (const row of rows) {
        if (testCase.drizzleColumns.has(row.name)) continue;
        if (allowedLegacy.has(row.name)) {
          // A column on the legacy whitelist must remain nullable. If a
          // future migration silently re-adds NOT NULL, this guard catches
          // the v43-style regression immediately.
          expect(
            row.notnull,
            `Legacy nullable column '${testCase.dbName}.${row.name}' is now NOT NULL — Drizzle inserts will fail. Either drop the column or update Drizzle to declare it.`
          ).toBe(0);
          continue;
        }
        // An undeclared column with NOT NULL is a v43-style bug: every
        // Drizzle insert must include it, but Drizzle has no way to know.
        expect(
          row.notnull,
          `Orphan NOT NULL column '${testCase.dbName}.${row.name}' (sibling of v43 tags.team_id bug) — every Drizzle insert will fail. Drop the column or add it to the Drizzle schema.`
        ).toBe(0);
        // Otherwise emit a structured failure so the orphan is at least
        // visible. The whitelist must be updated explicitly.
        throw new Error(
          `Orphan column '${testCase.dbName}.${row.name}' is not declared in Drizzle and not whitelisted as legacy. ` +
            `Either: (a) add to Drizzle schema, (b) drop via a new migration, or (c) add to KNOWN_LEGACY_NULLABLE_COLUMNS in this test if it is intentional cruft from a rename.`
        );
      }
    });
  }
});
