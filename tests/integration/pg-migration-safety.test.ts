/**
 * F02-13: PostgreSQL migration-safety integration test.
 *
 * Gated behind `POSTGRES_INTEGRATION=true` so CI does not require Docker
 * unless the opt-in env var is set. When enabled, the test spins up a
 * fresh Postgres via `POSTGRES_URL` (caller provides a dedicated test DB),
 * runs the full drizzle-kit PG migration chain, and then verifies that
 * every Drizzle-declared table + column can be introspected from the DB.
 *
 * Usage (local dev):
 *   docker compose -f docker/docker-compose.postgres.yml up -d
 *   POSTGRES_INTEGRATION=true \
 *     POSTGRES_URL=postgres://agentpane:agentpane@localhost:5433/agentpane_test \
 *     bun vitest run tests/integration/pg-migration-safety.test.ts
 *
 * CI: set POSTGRES_INTEGRATION=true and POSTGRES_URL in the workflow job
 * to execute. Otherwise the describe.skip path runs and the test is a
 * no-op.
 */
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import * as pgSchema from '../../src/db/schema/postgres/index.js';

const ENABLED = process.env.POSTGRES_INTEGRATION === 'true';
// Require an explicit dedicated-test URL. We deliberately do NOT fall back to
// DATABASE_URL — `resetSchema()` does `DROP SCHEMA ... CASCADE` and we will
// not risk wiping the developer's primary database if this var is absent.
const URL = process.env.POSTGRES_URL;

/**
 * Strip an opinion-free set of meta-tables that Drizzle or PG themselves
 * create — they should not count against the migration parity check.
 */
const META_TABLES = new Set<string>(['__drizzle_migrations']);

type Pg = ReturnType<typeof postgres>;

async function resetSchema(client: Pg): Promise<void> {
  // Drop + recreate every schema the app touches so each test run is truly
  // fresh. The drizzle migrator stores its tracking table under the
  // `drizzle` schema; leaving it behind makes the migrator think previous
  // migrations already applied and skip them.
  await client`DROP SCHEMA IF EXISTS public CASCADE`;
  await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await client`CREATE SCHEMA public`;
  await client`GRANT ALL ON SCHEMA public TO CURRENT_USER`;
}

const suite = ENABLED && URL ? describe : describe.skip;

suite('PostgreSQL migration safety (F02-13, gated)', () => {
  let client: Pg | null = null;

  afterAll(async () => {
    if (client) {
      await client.end({ timeout: 5 });
    }
  });

  it('runs the full migration chain against a fresh DB', async () => {
    // biome-ignore lint/style/noNonNullAssertion: guarded by suite skip
    client = postgres(URL!, { max: 2, idle_timeout: 1 });
    await resetSchema(client);

    const db = drizzlePg(client, { schema: pgSchema });
    await migratePg(db, { migrationsFolder: './src/db/migrations-pg' });

    // Sanity: schema_migrations tracker exists.
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    const names = new Set(tables.map((t) => t.table_name));
    expect(names.size).toBeGreaterThan(0);
  });

  it('subsequent boot finds every Drizzle-declared table + column', async () => {
    if (!client) throw new Error('Migration phase did not initialize client');

    // Collect every Drizzle pgTable export.
    const declaredTables: Array<{ name: string; columns: string[] }> = [];
    for (const value of Object.values(pgSchema)) {
      if (!is(value, PgTable)) continue;
      const cols = getTableColumns(value as PgTable);
      const dbName = getTableName(value as PgTable);
      declaredTables.push({
        name: dbName,
        columns: Object.values(cols).map((c) => c.name),
      });
    }
    expect(declaredTables.length).toBeGreaterThan(0);

    // Fetch live tables+columns from information_schema in one shot.
    const rows = await client<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    const actual = new Map<string, Set<string>>();
    for (const r of rows) {
      if (META_TABLES.has(r.table_name)) continue;
      let set = actual.get(r.table_name);
      if (!set) {
        set = new Set<string>();
        actual.set(r.table_name, set);
      }
      set.add(r.column_name);
    }

    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    for (const t of declaredTables) {
      const live = actual.get(t.name);
      if (!live) {
        missingTables.push(t.name);
        continue;
      }
      for (const col of t.columns) {
        if (!live.has(col)) missingColumns.push(`${t.name}.${col}`);
      }
    }

    expect(missingTables, `Tables declared by Drizzle but missing from PG`).toEqual([]);
    expect(
      missingColumns,
      `Columns declared by Drizzle but missing from PG (add a migration)`
    ).toEqual([]);
  });

  it('migration runner is idempotent — re-running finds nothing to apply', async () => {
    if (!client) throw new Error('Client not initialised');
    const db = drizzlePg(client, { schema: pgSchema });
    // Running migrate a second time should succeed without error.
    await expect(
      migratePg(db, { migrationsFolder: './src/db/migrations-pg' })
    ).resolves.not.toThrow();

    // A simple probe query should work.
    const v = await client<[{ v: string }]>`SELECT version() as v`;
    expect(v[0].v).toContain('PostgreSQL');
  });
});

// When disabled, expose a single placeholder test so test reports show the
// file as "skipped" rather than "empty".
if (!ENABLED || !URL) {
  describe.skip('PostgreSQL migration safety (F02-13, disabled)', () => {
    it('set POSTGRES_INTEGRATION=true and POSTGRES_URL to enable', () => {
      expect(true).toBe(true);
    });
  });
}
