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
import type { BootstrapPhaseResult, DatabaseResult, ServerConfig } from '../types.js';

const log = createLogger('DatabaseBootstrap');

/**
 * Missing-DATABASE_URL signaled via a sentinel so the orchestrator can decide
 * to exit (fatal). Keeps `initializeDatabase` callers compatible.
 */
export class MissingDatabaseUrlError extends Error {
  constructor() {
    super('DATABASE_URL is required when DB_MODE=postgres');
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * Try-initialize the database, returning a BootstrapPhaseResult on failure.
 * Replaces the old `process.exit` call with a fatal phase result (F01-05).
 *
 * Any DB initialization failure is fatal — the server has no meaningful
 * mode of operation without a working database, regardless of whether
 * the configured driver is SQLite or PostgreSQL. The orchestrator
 * responds to `fatal: true` by exiting (see `applyPhaseResult`).
 */
export async function tryInitializeDatabase(
  config: ServerConfig
): Promise<{ result: BootstrapPhaseResult; database: DatabaseResult | null }> {
  try {
    const database = await initializeDatabase(config);
    return { result: { ok: true }, database };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { result: { ok: false, fatal: true, error }, database: null };
  }
}

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
    throw new MissingDatabaseUrlError();
  }

  // F02-05: pass validated pool / client config to postgres-js.
  const pg = config.postgres;
  const pgClient = postgres(connectionString, {
    max: pg.max,
    idle_timeout: pg.idleTimeoutSeconds,
    max_lifetime: pg.maxLifetimeSeconds,
    connect_timeout: pg.connectTimeoutSeconds,
    connection: { application_name: pg.applicationName },
    ssl:
      pg.ssl === 'disable'
        ? false
        : pg.ssl === 'require' || pg.ssl === 'prefer'
          ? pg.ssl
          : undefined,
  });
  log.info('PostgreSQL client initialized', {
    data: {
      max: pg.max,
      idleTimeoutSeconds: pg.idleTimeoutSeconds,
      maxLifetimeSeconds: pg.maxLifetimeSeconds,
      connectTimeoutSeconds: pg.connectTimeoutSeconds,
      applicationName: pg.applicationName,
      ssl: pg.ssl ?? 'driver-default',
    },
  });
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
