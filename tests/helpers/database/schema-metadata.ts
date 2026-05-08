import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getTableName, isTable } from 'drizzle-orm/table';
import * as schema from '../../../src/db/schema/sqlite';

export type TestDatabase = BetterSQLite3Database<typeof schema>;

export const SQLITE_LEGACY_TABLE_NAMES = ['projects'] as const;

export function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier in test schema cleanup: ${identifier}`);
  }

  return `"${identifier}"`;
}

export function getSchemaTableNames(): string[] {
  return Array.from(
    new Set(
      Object.values(schema)
        .filter(isTable)
        .map((table) => getTableName(table))
    )
  ).sort();
}
