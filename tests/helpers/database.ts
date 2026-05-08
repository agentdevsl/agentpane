import type { Database as SQLiteDatabase } from 'better-sqlite3';
import { MIGRATIONS } from '../../src/lib/bootstrap/migrations/index';
import { runMigrations } from '../../src/lib/bootstrap/migrations/runner';
import { clearDatabase } from './database/cleanup';
import { createSqliteTestConnection } from './database/connection';
import type { TestDatabase } from './database/schema-metadata';

export type { TestDatabase } from './database/schema-metadata';
export { type SeedOptions, seedTestDatabase } from './database/seed';

const DB_MODE = process.env.DB_MODE ?? 'sqlite';

let testSqlite: SQLiteDatabase | null = null;
let testDb: TestDatabase | null = null;
let pgClient: ReturnType<typeof import('postgres').default> | null = null;

export async function setupTestDatabase(): Promise<TestDatabase> {
  if (testDb) {
    return testDb;
  }

  if (DB_MODE === 'postgres') {
    const postgres = (await import('postgres')).default;
    const { drizzle: drizzlePg } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const pgSchema = await import('../../src/db/schema/postgres/index.js');

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required when DB_MODE=postgres');
    }

    pgClient = postgres(connectionString);
    const db = drizzlePg(pgClient, { schema: pgSchema });
    await migrate(db, { migrationsFolder: './src/db/migrations-pg' });

    // Cast for compatibility — services use the union Database type
    testDb = db as unknown as TestDatabase;
    return testDb;
  }

  const connection = createSqliteTestConnection();
  testSqlite = connection.sqlite;
  testDb = connection.db;

  // Use the same SQLite runtime migration runner that production uses. Fresh
  // test databases start with FK checks disabled because historical migrations
  // rebuild interdependent tables; FK behavior is re-enabled immediately after.
  runMigrations(testSqlite, MIGRATIONS);
  testSqlite.pragma('foreign_keys = ON');

  return testDb;
}

/**
 * Execute raw SQL on the test database
 * Useful for creating additional tables or running custom migrations
 */
export function execRawSql(sql: string): void {
  if (DB_MODE === 'postgres') {
    throw new Error('execRawSql is not supported in postgres mode — use pgClient directly');
  }
  if (!testSqlite) {
    throw new Error('Test database not initialized');
  }
  testSqlite.exec(sql);
}

/**
 * Execute parameterized raw SQL on the test database.
 * Use this for legacy tables that are not represented in the Drizzle schema.
 */
export function runRawSql(sql: string, params: readonly unknown[] = []): void {
  if (DB_MODE === 'postgres') {
    throw new Error('runRawSql is not supported in postgres mode — use pgClient directly');
  }
  if (!testSqlite) {
    throw new Error('Test database not initialized');
  }
  testSqlite.prepare(sql).run(...params);
}

export async function clearTestDatabase(): Promise<void> {
  await clearDatabase({ dbMode: DB_MODE, pgClient, testDb, testSqlite });
}

export async function closeTestDatabase(): Promise<void> {
  if (DB_MODE === 'postgres' && pgClient) {
    await pgClient.end();
    pgClient = null;
    testDb = null;
    return;
  }

  if (testSqlite) {
    testSqlite.close();
    testSqlite = null;
    testDb = null;
  }
}

export function getTestDb(): TestDatabase {
  if (!testDb) {
    throw new Error('Test database not initialized');
  }
  return testDb;
}
