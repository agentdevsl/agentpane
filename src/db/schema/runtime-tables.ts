import { type DbDialect, getDbDialect } from '../../lib/db/dialect.js';
import * as postgresSchema from './postgres/index.js';
import * as sqliteRuntimeSchema from './sqlite/index.js';

export type RuntimeSchemaTables = typeof sqliteRuntimeSchema;

function postgresTables(): RuntimeSchemaTables {
  return postgresSchema as unknown as RuntimeSchemaTables;
}

function sqliteTables(): RuntimeSchemaTables {
  return sqliteRuntimeSchema;
}

/**
 * Resolve Drizzle table objects for runtime code that can run under either
 * DB_MODE. This avoids importing SQLite schema objects directly in dual-mode
 * services while preserving the existing SQLite-shaped Database type.
 */
export function getRuntimeSchemaTables(dialect: DbDialect = getDbDialect()): RuntimeSchemaTables {
  return dialect === 'postgres' ? postgresTables() : sqliteTables();
}
