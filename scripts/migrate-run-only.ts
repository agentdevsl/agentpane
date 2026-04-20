#!/usr/bin/env bun
/**
 * F11-05: Out-of-band migration runner.
 *
 * Runs database migrations without starting the API server. Used by the
 * Helm `pre-upgrade,pre-install` hook Job so that a single replica applies
 * migrations before the Deployment rollout proceeds. With this in place the
 * app pods can boot with DB migrations treated as already-applied, avoiding
 * the race where N replicas all attempt to run `migratePg()` concurrently.
 *
 * Behaviour mirrors `src/server/bootstrap/phases/database.ts`:
 *   - DB_MODE=postgres -> drizzle-orm/postgres-js/migrator against
 *     `src/db/migrations-pg`
 *   - otherwise -> SQLite migrations via the consolidated runner
 *
 * Exit codes:
 *   0  migrations applied (or already up-to-date)
 *   1  missing DATABASE_URL / connection failure / migration error
 *
 * Usage:
 *   DB_MODE=postgres DATABASE_URL=postgres://... bun scripts/migrate-run-only.ts
 *   DB_MODE=sqlite DB_PATH=/data/agentpane.db bun scripts/migrate-run-only.ts
 */

import { Database as BunSQLite } from 'bun:sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { MIGRATIONS } from '../src/lib/bootstrap/migrations/index.js';
import { runMigrations } from '../src/lib/bootstrap/migrations/runner.js';

function log(level: 'info' | 'error', msg: string, data?: Record<string, unknown>): void {
  const line = { level, msg, ...(data ? { data } : {}), ts: new Date().toISOString() };
  // biome-ignore lint/suspicious/noConsole: stdout is the intended interface for a standalone migration tool
  console.log(JSON.stringify(line));
}

async function runPgMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log('error', 'DATABASE_URL is required when DB_MODE=postgres');
    process.exit(1);
  }

  const client = postgres(url, {
    max: 1,
    idle_timeout: 5,
    max_lifetime: 30,
    connect_timeout: 15,
    connection: { application_name: 'agentpane-migrate' },
  });

  try {
    const db = drizzlePg(client);
    await migratePg(db, { migrationsFolder: './src/db/migrations-pg' });
    log('info', 'PostgreSQL migrations applied');
  } finally {
    await client.end({ timeout: 5 });
  }
}

function runSqliteMigrations(): void {
  const dbPath = process.env.DB_PATH ?? './data/agentpane.db';
  const sqlite = new BunSQLite(dbPath);
  try {
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA busy_timeout=5000');
    sqlite.exec('PRAGMA foreign_keys=ON');
    runMigrations(sqlite, MIGRATIONS);
    log('info', 'SQLite migrations applied', { data: { dbPath } });
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  const mode = (process.env.DB_MODE ?? 'sqlite').toLowerCase();
  log('info', 'Starting migration runner', { data: { mode } });

  if (mode === 'postgres') {
    await runPgMigrations();
  } else {
    runSqliteMigrations();
  }
}

main().catch((err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', 'Migration failed', { data: { error: e.message, stack: e.stack } });
  process.exit(1);
});
