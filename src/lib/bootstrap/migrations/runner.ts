import { createLogger } from '../../logging/logger.js';
import type { RawSQLiteDatabase } from '../phases/schema.js';
import type { Migration } from './index.js';

const log = createLogger('MigrationRunner');

/**
 * Ensures the schema_migrations tracking table exists.
 */
function ensureTrackingTable(db: RawSQLiteDatabase): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

/**
 * Returns the highest migration version that has been applied, or 0 if none.
 */
function getMaxAppliedVersion(db: RawSQLiteDatabase): number {
  const row = db.prepare('SELECT MAX(version) as max_version FROM schema_migrations').get() as
    | { max_version: number | null }
    | undefined;
  return row?.max_version ?? 0;
}

/**
 * Applies a single migration. For migrations with `statements`, each
 * statement is executed individually with try/catch to handle SQLite
 * ALTER TABLE idempotency (duplicate column errors are expected on re-runs).
 */
function applyMigration(db: RawSQLiteDatabase, migration: Migration): void {
  if (migration.statements) {
    for (const stmt of migration.statements) {
      try {
        db.prepare(stmt).run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('duplicate column')) {
          log.warn(`Migration v${migration.version} (${migration.name}) statement note: ${msg}`);
        }
      }
    }
  } else if (migration.sql) {
    try {
      // Use exec for multi-statement SQL blocks (CREATE TABLE, CREATE INDEX, etc.)
      (db as RawSQLiteDatabase & { exec: (sql: string) => void }).exec(migration.sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // ALTER TABLE migrations may fail with "duplicate column" on re-runs
      if (msg.includes('duplicate column')) {
        return;
      }
      throw e;
    }
  }
}

/**
 * Run all pending migrations in order against the given database.
 *
 * - Creates the `schema_migrations` tracking table if it doesn't exist
 * - Skips migrations that have already been applied (by version number)
 * - Records each newly applied migration with a timestamp
 * - Idempotent: safe to call on both fresh and existing databases
 */
export function runMigrations(db: RawSQLiteDatabase, migrations: Migration[]): void {
  ensureTrackingTable(db);

  const maxApplied = getMaxAppliedVersion(db);
  const pending = migrations.filter((m) => m.version > maxApplied);

  if (pending.length === 0) {
    log.info('All migrations up to date', { data: { currentVersion: maxApplied } });
    return;
  }

  log.info(`Applying ${pending.length} pending migration(s)`, {
    data: { from: maxApplied, to: pending[pending.length - 1]?.version },
  });

  const recordMigration = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of pending) {
    applyMigration(db, migration);
    recordMigration.run(migration.version, migration.name);
    log.info(`Applied migration v${migration.version}: ${migration.name}`);
  }
}
