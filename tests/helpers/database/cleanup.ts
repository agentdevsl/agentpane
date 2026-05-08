import type { Database as SQLiteDatabase } from 'better-sqlite3';
import type { TestDatabase } from './schema-metadata';
import {
  getSchemaTableNames,
  quoteSqlIdentifier,
  SQLITE_LEGACY_TABLE_NAMES,
} from './schema-metadata';

type PostgresClient = ReturnType<typeof import('postgres').default>;

export async function clearDatabase(input: {
  dbMode: string;
  pgClient: PostgresClient | null;
  testDb: TestDatabase | null;
  testSqlite: SQLiteDatabase | null;
}): Promise<void> {
  const { dbMode, pgClient, testDb, testSqlite } = input;
  if (!testDb) {
    return;
  }

  const tableNames = getSchemaTableNames();

  if (dbMode === 'postgres' && pgClient) {
    // Keep cleanup in lockstep with the Drizzle schema; TRUNCATE ... CASCADE
    // handles FK ordering for Postgres, so the table order does not matter.
    const tableList = tableNames.map(quoteSqlIdentifier).join(', ');
    await pgClient.unsafe(`TRUNCATE TABLE ${tableList} CASCADE`);
    // Re-seed the default project folder so FK constraints are satisfied.
    await pgClient`INSERT INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280')
      ON CONFLICT (id) DO NOTHING`;
    return;
  }

  if (testSqlite) {
    const deleteStatements = [...tableNames, ...SQLITE_LEGACY_TABLE_NAMES]
      .map((tableName) => `DELETE FROM ${quoteSqlIdentifier(tableName)};`)
      .join('\n      ');

    testSqlite.exec(`
      PRAGMA foreign_keys = OFF;
      ${deleteStatements}
      PRAGMA foreign_keys = ON;
    `);
    // Re-seed the default project folder so FK constraints are satisfied.
    testSqlite.exec(`
      INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280');
    `);
    // Ensure FK enforcement is active (a test may have disabled it temporarily).
    testSqlite.pragma('foreign_keys = ON');
    return;
  }

  throw new Error('SQLite test cleanup requires the raw better-sqlite3 connection');
}
