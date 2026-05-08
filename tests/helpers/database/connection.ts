import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../src/db/schema/sqlite';
import type { TestDatabase } from './schema-metadata';

export type SqliteTestConnection = {
  db: TestDatabase;
  sqlite: SQLiteDatabase;
};

export function createSqliteTestConnection(): SqliteTestConnection {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');

  const db = drizzle(sqlite, { schema });
  installAsyncTransactionShim(db, sqlite);

  return { db, sqlite };
}

function installAsyncTransactionShim(db: TestDatabase, sqlite: SQLiteDatabase): void {
  let transactionQueue: Promise<unknown> = Promise.resolve();

  // better-sqlite3 transactions are synchronous, but source code often uses
  // async callbacks. Serialize those callbacks inside BEGIN IMMEDIATE so the
  // SQLite harness at least preserves one-writer-at-a-time semantics.
  const originalTransaction = db.transaction.bind(db);
  (db as unknown as { transaction: (callback: (tx: unknown) => unknown) => unknown }).transaction =
    (callback) => {
      if (callback.constructor.name !== 'AsyncFunction') {
        return originalTransaction(callback as never);
      }

      const runTransaction = transactionQueue.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const value = await callback(db);
          sqlite.exec('COMMIT');
          return value;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      });

      transactionQueue = runTransaction.catch(() => undefined);
      return runTransaction;
    };
}
