import * as fs from 'node:fs';
import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { MIGRATIONS } from '../lib/bootstrap/migrations/index';
import { runMigrations } from '../lib/bootstrap/migrations/runner';
import * as pgSchema from './schema/postgres';
import * as sqliteSchema from './schema/sqlite';

// Re-export the Database type for external use
export type { SQLiteDatabase };

// Check if we're running in a browser environment
const isBrowser = () => {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
};

// Get data directory from environment or use default
const getDataDir = () => {
  if (typeof process !== 'undefined' && process.env?.SQLITE_DATA_DIR) {
    return process.env.SQLITE_DATA_DIR;
  }
  return './data';
};

// Check if we're in E2E test mode (use in-memory database)
const isE2EMode = () => {
  if (typeof process !== 'undefined') {
    return process.env?.VITE_E2E_SEED === 'true' || process.env?.NODE_ENV === 'test';
  }
  return false;
};

// Get database mode from environment
const getDbMode = (): 'sqlite' | 'postgres' => {
  if (typeof process !== 'undefined') {
    const mode = process.env?.DB_MODE ?? 'sqlite';
    if (mode !== 'sqlite' && mode !== 'postgres') {
      throw new Error(`Invalid DB_MODE="${mode}". Must be "sqlite" or "postgres".`);
    }
    return mode;
  }
  return 'sqlite';
};

// Run schema migrations on a database using the consolidated runner
const runMigration = (sqlite: SQLiteDatabase): void => {
  runMigrations(sqlite, MIGRATIONS);
};

// Create SQLite database connection (server-side only)
const createSqliteDatabase = (): SQLiteDatabase | null => {
  // Don't create database in browser - this module should only run on server
  if (isBrowser()) {
    return null;
  }

  if (isE2EMode()) {
    // Use in-memory database for tests
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runMigration(sqlite); // Run migration for test databases too
    return sqlite;
  }

  const dataDir = getDataDir();
  const dbPath = `${dataDir}/agentpane.db`;

  // Ensure data directory exists (server-side only)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL'); // Better concurrency
  sqlite.pragma('foreign_keys = ON'); // Enforce FK constraints
  sqlite.pragma('busy_timeout = 5000'); // Wait up to 5s for write lock (QW-1)

  // Run schema migration on startup (CREATE TABLE IF NOT EXISTS is idempotent)
  runMigration(sqlite);

  return sqlite;
};

let pgClientInstance: ReturnType<typeof postgres> | null = null;

// Create PostgreSQL database connection
const createPostgresDatabase = () => {
  const connectionString = typeof process !== 'undefined' ? process.env?.DATABASE_URL : undefined;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_MODE=postgres');
  }
  pgClientInstance = postgres(connectionString);
  return drizzlePg(pgClientInstance, { schema: pgSchema });
};

const mode = getDbMode();
const sqliteInstance = mode === 'sqlite' ? createSqliteDatabase() : null;
export const sqlite: SQLiteDatabase | null = sqliteInstance;
export const db =
  mode === 'postgres'
    ? createPostgresDatabase()
    : sqliteInstance
      ? drizzleSqlite(sqliteInstance, { schema: sqliteSchema })
      : null;

// Export for server-side use with custom data directory
export const createServerDb = (dataDir: string = './data') => {
  const dbPath = `${dataDir}/agentpane.db`;
  const serverSqlite = new Database(dbPath);
  serverSqlite.pragma('journal_mode = WAL');
  serverSqlite.pragma('foreign_keys = ON');
  serverSqlite.pragma('busy_timeout = 5000'); // Wait up to 5s for write lock (QW-1)
  runMigration(serverSqlite); // Run migration on startup
  return drizzleSqlite(serverSqlite, { schema: sqliteSchema });
};

// Export the postgres client so consumers can close it
export const pgClient = pgClientInstance;

// WARNING: Despite the name, this is the SQLite instance, not PostgreSQL.
// Legacy alias from before real PG support was added.
export { sqlite as pglite };
