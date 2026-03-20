/**
 * Database Bootstrap Phase
 *
 * Initializes SQLite or PostgreSQL based on configuration.
 * Handles WAL pragmas, migrations, and schema seeding.
 */

import { Database as BunSQLite } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as pgSchema from '../../../db/schema/postgres/index.js';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { MIGRATIONS } from '../../../lib/bootstrap/migrations/index.js';
import { runMigrations } from '../../../lib/bootstrap/migrations/runner.js';
import { seedDefaultTeamForExistingTokens } from '../../../lib/bootstrap/phases/schema.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { Database } from '../../../types/database.js';
import type { DatabaseResult, ServerConfig } from '../types.js';

const log = createLogger('DatabaseBootstrap');

/**
 * Initialize the database based on the configured mode.
 *
 * SQLite: creates file, enables WAL mode, runs migrations, seeds defaults.
 * PostgreSQL: connects, runs Drizzle Kit migrations.
 */
export async function initializeDatabase(config: ServerConfig): Promise<DatabaseResult> {
  log.info(`Database mode: ${config.dbMode}`);

  if (config.dbMode === 'postgres') {
    return initializePostgres(config);
  }
  return initializeSqlite(config);
}

async function initializePostgres(config: ServerConfig): Promise<DatabaseResult> {
  const connectionString = config.databaseUrl;
  if (!connectionString) {
    log.error('DATABASE_URL is required when DB_MODE=postgres');
    process.exit(1);
  }

  const pgClient = postgres(connectionString);
  const db = drizzlePg(pgClient, { schema: pgSchema }) as unknown as Database;

  await migratePg(db as unknown as ReturnType<typeof drizzlePg>, {
    migrationsFolder: './src/db/migrations-pg',
  });
  log.info('PostgreSQL migrations applied');

  return { db, sqlite: null, pgClient };
}

function initializeSqlite(config: ServerConfig): DatabaseResult {
  const dbPath = config.dbPath;
  const sqlite = new BunSQLite(dbPath);

  // Enable WAL mode for better concurrent read performance and crash recovery
  sqlite.exec('PRAGMA journal_mode=WAL');
  sqlite.exec('PRAGMA busy_timeout=5000');
  sqlite.exec('PRAGMA foreign_keys=ON');
  log.info('SQLite WAL mode enabled', { data: { dbPath } });

  // Run all migrations via the consolidated runner
  runMigrations(sqlite, MIGRATIONS);

  // Seed default team for existing installations with orphaned github_tokens
  seedDefaultTeamForExistingTokens(sqlite);

  const db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as Database;

  return { db, sqlite, pgClient: null };
}
