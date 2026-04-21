#!/usr/bin/env bun
/**
 * F11-05: Migration state verifier (read-only).
 *
 * Verifies the DB schema is current without applying any migrations. Used by
 * app pods on startup when migrations are expected to have already been
 * applied by the Helm `pre-upgrade` Job. If drift is detected the pod should
 * refuse to start so the operator can run the Job manually.
 *
 * For PostgreSQL, we compare Drizzle's `__drizzle_migrations` ledger against
 * the bundled migration journal (`src/db/migrations-pg/meta/_journal.json`).
 * For SQLite, we compare the `schema_migrations` table's MAX(version) against
 * the highest version in the bundled MIGRATIONS array.
 *
 * Exit codes:
 *   0  schema is up-to-date (safe to start)
 *   1  pending migrations exist or verification failed (fatal)
 *
 * Usage:
 *   DB_MODE=postgres DATABASE_URL=postgres://... bun scripts/migrate-check-only.ts
 *   DB_MODE=sqlite DB_PATH=/data/agentpane.db bun scripts/migrate-check-only.ts
 */

import { Database as BunSQLite } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { MIGRATIONS } from '../src/lib/bootstrap/migrations/index.js';

function log(level: 'info' | 'error', msg: string, fields?: Record<string, unknown>): void {
  // Callers pass structured fields flat (e.g. `{ mode }`); we serialise them
  // under a single `data` key so parsers see one consistent level of nesting.
  // An earlier contract let callers pass `{ data: {...} }` which double-wrapped
  // into `data.data.*` — avoid by only ever wrapping once here.
  const line = { level, msg, ...(fields ? { data: fields } : {}), ts: new Date().toISOString() };
  console.log(JSON.stringify(line));
}

async function checkPg(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log('error', 'DATABASE_URL is required when DB_MODE=postgres');
    return false;
  }

  // Read the bundled migration journal — the list of migrations the build
  // *expects* to be applied.
  const journalPath = resolve(import.meta.dir, '../src/db/migrations-pg/meta/_journal.json');
  let expectedCount = 0;
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries?: Array<{ idx: number; tag: string }>;
    };
    expectedCount = journal.entries?.length ?? 0;
  } catch (e) {
    log('error', 'Failed to read migrations journal', {
      path: journalPath,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }

  const client = postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: 'agentpane-migrate-check' },
  });

  try {
    // Drizzle's migration table lives in `drizzle.__drizzle_migrations` by default.
    // If the schema has never been migrated at all the table won't exist — that
    // is a clear "pending" signal.
    const rows = await client`
      SELECT COUNT(*)::int AS c
      FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
    `;
    const tableExists = (rows[0]?.c ?? 0) > 0;
    if (!tableExists) {
      log('error', 'drizzle.__drizzle_migrations not found — migrations have not been applied', {
        expectedCount,
      });
      return false;
    }

    const countRows = await client`
      SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations
    `;
    const appliedCount = countRows[0]?.c ?? 0;

    if (appliedCount < expectedCount) {
      log('error', 'Pending migrations detected', {
        appliedCount,
        expectedCount,
      });
      return false;
    }

    log('info', 'PostgreSQL schema is up-to-date', {
      appliedCount,
      expectedCount,
    });
    return true;
  } finally {
    await client.end({ timeout: 5 });
  }
}

function checkSqlite(): boolean {
  const dbPath = process.env.DB_PATH ?? './data/agentpane.db';
  const sqlite = new BunSQLite(dbPath, { readonly: true });
  try {
    const tableRow = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1"
      )
      .get();
    if (!tableRow) {
      log('error', 'schema_migrations not found — migrations have not been applied', {
        dbPath,
      });
      return false;
    }

    const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
      | { v: number | null }
      | undefined;
    const applied = row?.v ?? 0;
    const expected = MIGRATIONS.reduce((acc, m) => (m.version > acc ? m.version : acc), 0);

    if (applied < expected) {
      log('error', 'Pending SQLite migrations detected', {
        applied,
        expected,
      });
      return false;
    }

    log('info', 'SQLite schema is up-to-date', { applied, expected });
    return true;
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  const mode = (process.env.DB_MODE ?? 'sqlite').toLowerCase();
  log('info', 'Starting migration check', { mode });

  const ok = mode === 'postgres' ? await checkPg() : checkSqlite();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', 'Migration check failed', { error: e.message, stack: e.stack });
  process.exit(1);
});
