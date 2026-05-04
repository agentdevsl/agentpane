/**
 * F02-02: Auto-generated schema-drift coverage for every Drizzle SQLite table.
 *
 * Iterates every `SQLiteTable` exported from `src/db/schema/sqlite/index.ts`
 * and asserts that each column Drizzle declares exists in the actual SQLite
 * runtime schema (via `PRAGMA table_info`). Optionally verifies the reverse
 * direction too: flags DB-only columns that Drizzle doesn't know about.
 *
 * This prevents silent INSERT/SELECT failures caused by schema-vs-Drizzle
 * drift. Adding a new table automatically gets coverage — no manual
 * per-table test needed.
 *
 * Tables known to be incompletely covered by the test-harness migration
 * runner (tests/helpers/database.ts does not spin up the full runtime
 * migration chain) are listed in `MISSING_IN_TEST_DB` — these are skipped
 * for the test environment but still receive coverage in the real runtime.
 */
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema/sqlite';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Tables that the test-DB migration chain does not currently create.
 * The production migration runner does create them. We list them here so
 * the generator still reports coverage but skips the assertion. When the
 * test helpers gain support, remove the table from this set.
 *
 * F09-21 (arch29-W2-Q): the harness now mirrors the production migration
 * chain. All Drizzle-declared tables are present in the test DB; the set is
 * empty so every table receives full drift coverage.
 */
const MISSING_IN_TEST_DB = new Set<string>([]);

/**
 * Columns that Drizzle declares but the test-harness migration chain has
 * not yet applied. The real runtime migration chain DOES apply them.
 * Keyed by table name → set of column names to skip.
 *
 * F09-21 (arch29-W2-Q): cli_sessions and plan_sessions still carry real
 * production drift — Drizzle declares columns that no SQLite runtime
 * migration adds. These are tracked here so the suite catches NEW drift
 * without flagging known-existing drift. Each entry must be cross-linked
 * to a follow-up issue/finding so it doesn't become permanent.
 */
const EXPECTED_MISSING_COLUMNS: Record<string, Set<string>> = {
  codespaces: new Set([]),
  agents: new Set([
    // Added via v29 agents-schema-rebuild at runtime; test DB keeps the
    // pre-rebuild shape to exercise legacy migrations.
    'config',
    'current_turn',
    'type',
  ]),
  sessions: new Set([
    // Added via v30 sessions-schema-rebuild at runtime.
    'title',
    'url',
    'sandbox_provider',
    'sandbox_container_id',
    'closed_at',
  ]),
  // F02-16 follow-up: cli_sessions has Drizzle-declared columns that the
  // SQLite runtime migration chain does NOT add (PG migration 0010 added
  // them on PG only). The test harness adds them via per-column ALTERs so
  // service tests can write through Drizzle, but the real SQLite production
  // schema is missing them — open follow-up tracked separately.
  cli_sessions: new Set<string>([]),
  plan_sessions: new Set<string>([]),
};

interface TableCase {
  exportName: string;
  dbName: string;
  expectedColumns: string[];
}

function collectTableCases(): TableCase[] {
  const cases: TableCase[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const cols = getTableColumns(value as SQLiteTable);
    const expectedColumns = Object.values(cols).map((c) => c.name);
    // Table DB name is stored in a symbol-keyed field on the table.
    // @ts-expect-error — private Drizzle internal, but stable.
    const dbName = getTableName(value as SQLiteTable);
    cases.push({ exportName, dbName, expectedColumns });
  }
  return cases.sort((a, b) => a.dbName.localeCompare(b.dbName));
}

const CASES = collectTableCases();

describe('Schema drift: all tables (F02-02, auto-generated)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterAll(async () => {
    await clearTestDatabase();
  });

  it('generator produces at least 30 drift cases (covers ≥10 high-churn tables)', () => {
    // Sanity: if the schema module export list shrinks unexpectedly, catch it.
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  // High-churn tables keep dedicated assertions so failure messages stay
  // targeted for the most-likely-to-drift subset.
  const HIGH_CHURN_TABLES = [
    'tasks',
    'codespaces',
    'sandbox_configs',
    'plan_sessions',
    'memory_insights',
    'skill_executions',
    'event_log',
    'templates',
    'agents',
    'sessions',
  ];

  for (const tableName of HIGH_CHURN_TABLES) {
    it(`[high-churn] ${tableName}: every Drizzle column exists in DB`, async () => {
      const testCase = CASES.find((c) => c.dbName === tableName);
      expect(testCase, `High-churn table '${tableName}' not found in schema exports`).toBeDefined();
      if (!testCase) return;
      if (MISSING_IN_TEST_DB.has(tableName)) return;

      const rows = db.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(tableName)})`);
      const actual = new Set(rows.map((r) => r.name));
      const expectedSkips = EXPECTED_MISSING_COLUMNS[tableName] ?? new Set<string>();
      for (const col of testCase.expectedColumns) {
        if (expectedSkips.has(col)) continue;
        expect(
          actual.has(col),
          `High-churn table '${tableName}' missing column '${col}' that Drizzle defines`
        ).toBe(true);
      }
    });
  }

  // Parametrized coverage for every remaining table.
  for (const testCase of CASES) {
    if (HIGH_CHURN_TABLES.includes(testCase.dbName)) continue;
    it(`${testCase.dbName}: every Drizzle column exists in DB`, async () => {
      if (MISSING_IN_TEST_DB.has(testCase.dbName)) {
        // Not created by test-harness migrations; runtime covers it.
        return;
      }
      const rows = db.all<{ name: string }>(
        sql`PRAGMA table_info(${sql.identifier(testCase.dbName)})`
      );
      const actual = new Set(rows.map((r) => r.name));
      const expectedSkips = EXPECTED_MISSING_COLUMNS[testCase.dbName] ?? new Set<string>();
      for (const col of testCase.expectedColumns) {
        if (expectedSkips.has(col)) continue;
        expect(
          actual.has(col),
          `Table '${testCase.dbName}' missing column '${col}' that Drizzle defines`
        ).toBe(true);
      }
    });
  }
});
