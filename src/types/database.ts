import type { InferInsertModel, InferSelectModel, Table } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RuntimeSchemaTables } from '../db/schema/runtime-tables.js';

export type SqliteDatabase = BetterSQLite3Database<RuntimeSchemaTables>;
export type PostgresDatabase = PostgresJsDatabase<RuntimeSchemaTables>;

/**
 * Canonical database type used throughout the application.
 *
 * Uses the runtime schema shape so service code sees the same logical table
 * namespace for both SQLite and Postgres. The concrete Drizzle database is
 * still structurally SQLite-shaped because using a raw
 * `SqliteDatabase | PostgresDatabase` union makes Drizzle's generic query
 * builders uncallable at current call sites; Postgres-only runtime methods are
 * modeled explicitly where shared helpers need them.
 */
export type Database = SqliteDatabase & Partial<Pick<PostgresDatabase, 'execute'>>;

export type TableModel<T extends Table> = InferSelectModel<T>;
export type TableInsert<T extends Table> = InferInsertModel<T>;
