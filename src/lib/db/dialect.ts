/**
 * Dialect-neutral SQL helpers for the dual-mode (SQLite + Postgres) Database.
 *
 * F02-15 (April 29 review, P0): several services were issuing SQLite-specific
 * raw SQL (`json_set`, `json_extract`, `datetime('now')`,
 * `PRAGMA wal_checkpoint`) on the dual-dialect `Database` type. With
 * `DB_MODE=postgres`, every cron tick raised
 * `function json_set(jsonb, text, text) does not exist` and the scheduler /
 * event-cleanup / memory-route paths were broken at runtime.
 *
 * This module exposes:
 *   - `getDbDialect()` — read `process.env.DB_MODE` once and cache it.
 *   - `jsonExtractText(col, ...path)` — portable equivalent of
 *     SQLite `json_extract(col, '$.a.b')` (returns text).
 *   - `jsonSet(col, path, value)` — portable equivalent of SQLite
 *     `json_set(col, '$.a', value)`. Uses `jsonb_set` on Postgres.
 *   - `currentTimestampSql()` — `CURRENT_TIMESTAMP` works on both dialects;
 *     callers usually prefer `new Date().toISOString()` from JS so the value
 *     is captured at JS-call time and is identical on both dialects.
 *   - `runRaw(db, query)` — runs a raw `sql` template, dispatching to
 *     `db.run()` on SQLite and `db.execute()` on Postgres. Returns a
 *     `{ changes: number }` shape matching the SQLite contract.
 *
 * IMPORTANT: do not import this from the schema layer. Schemas are
 * dialect-specific and use Drizzle's column-level helpers; this module is
 * for query-level dialect bridging in service code.
 */

import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '../../types/database.js';

export type DbDialect = 'sqlite' | 'postgres';

let cachedDialect: DbDialect | null = null;

/**
 * Read `DB_MODE` from the environment once and cache. Defaults to
 * `'sqlite'` if not set, matching the rest of the codebase
 * (`src/db/client.ts:38`, `src/server/routes/health.ts:11`,
 * `src/server/bootstrap/server-config.ts`).
 *
 * Exported so tests can verify the dispatch path.
 */
export function getDbDialect(): DbDialect {
  if (cachedDialect !== null) return cachedDialect;
  const raw = process.env.DB_MODE ?? 'sqlite';
  if (raw !== 'sqlite' && raw !== 'postgres') {
    throw new Error(`Invalid DB_MODE="${raw}". Must be "sqlite" or "postgres".`);
  }
  cachedDialect = raw;
  return cachedDialect;
}

/**
 * Test-only: reset the cached dialect so individual tests can flip
 * `process.env.DB_MODE` between sqlite and postgres without leaking
 * cached state across `describe` blocks.
 */
export function _resetDbDialectCacheForTests(): void {
  cachedDialect = null;
}

/**
 * Build a portable SQL fragment that extracts the value at a JSON path
 * from a JSON-typed column as text.
 *
 * SQLite path syntax:  `json_extract(col, '$.a.b')`
 * Postgres path syntax: `(col #>> '{a,b}')`
 *
 * Both return NULL when the path is missing.
 *
 * @param col   Drizzle column reference (or any `SQL` fragment).
 * @param parts JSON object keys forming the path, e.g. `['a', 'b']` for `$.a.b`.
 */
export function jsonExtractText(col: SQL | unknown, ...parts: string[]): SQL {
  if (parts.length === 0) {
    throw new Error('jsonExtractText requires at least one path part');
  }
  validatePathParts(parts);

  if (getDbDialect() === 'postgres') {
    // Use `#>>` (text extraction at path). Path is a literal `{a,b}` PG array;
    // values are pre-validated to contain only safe characters so building
    // the literal as a string is safe.
    const pgPath = `{${parts.join(',')}}`;
    return sql`(${col} #>> ${pgPath})`;
  }
  // SQLite — build the JSON path expression `$.a.b`.
  const sqlitePath = `$.${parts.join('.')}`;
  return sql`json_extract(${col}, ${sqlitePath})`;
}

/**
 * Build a portable SQL UPDATE fragment that sets a value at a JSON path
 * inside a JSON-typed column. Returns an `SQL` fragment suitable for
 * embedding in a `SET col = ${jsonSet(...)}` clause.
 *
 * SQLite: `json_set(col, '$.a.b', value)`
 * Postgres: `jsonb_set(col::jsonb, '{a,b}', to_jsonb(value::text), true)`
 *
 * NOTE: On Postgres, scalar values are coerced via `to_jsonb` so a JS string
 * `'foo'` becomes the JSON string `"foo"`. Pass `null` to write a JSON null.
 *
 * @param col   Drizzle column reference.
 * @param path  JSON object keys, e.g. `['nextRunAt']` for `$.nextRunAt`.
 * @param value Scalar value to write — string, number, boolean, or null.
 */
export function jsonSet(
  col: SQL | unknown,
  path: string[],
  value: string | number | boolean | null
): SQL {
  if (path.length === 0) {
    throw new Error('jsonSet requires at least one path part');
  }
  validatePathParts(path);

  if (getDbDialect() === 'postgres') {
    // Build the path as a PG text array literal `{a,b}`.
    const pgPath = `{${path.join(',')}}`;

    // PG `jsonb_set` requires a `jsonb` value. We use `to_jsonb` to coerce
    // a typed scalar; postgres-js sends bound parameters with implicit
    // `unknown` types so we cast them explicitly to disambiguate the
    // `to_jsonb(anyelement)` polymorphic resolution.
    // Treat `null` literally — a null JS value maps to a JSON null. We use
    // the raw `'null'::jsonb` so the column stores a JSON null rather than
    // SQL NULL (which would mean "leave unchanged").
    if (value === null) {
      return sql`jsonb_set(${col}::jsonb, ${pgPath}::text[], 'null'::jsonb, true)`;
    }
    if (typeof value === 'boolean') {
      return sql`jsonb_set(${col}::jsonb, ${pgPath}::text[], to_jsonb(${value}::boolean), true)`;
    }
    if (typeof value === 'number') {
      // Use numeric for both integers and floats — preserves precision.
      return sql`jsonb_set(${col}::jsonb, ${pgPath}::text[], to_jsonb(${value}::numeric), true)`;
    }
    // string
    return sql`jsonb_set(${col}::jsonb, ${pgPath}::text[], to_jsonb(${value}::text), true)`;
  }

  // SQLite — `json_set` accepts scalar values directly.
  const sqlitePath = `$.${path.join('.')}`;
  return sql`json_set(${col}, ${sqlitePath}, ${value})`;
}

/**
 * Compose multiple json_set / jsonb_set calls into a single SQL fragment.
 * Useful when an UPDATE needs to set several JSON paths atomically.
 *
 * Example:
 *   SET config = ${jsonSetMany(eventSources.config, [
 *     [['nextRunAt'], '2026-01-01T00:00:00Z'],
 *     [['lastRunAt'], '2026-01-01T00:00:00Z'],
 *   ])}
 */
export function jsonSetMany(
  col: SQL | unknown,
  patches: Array<[string[], string | number | boolean | null]>
): SQL {
  const head = patches[0];
  if (!head) {
    throw new Error('jsonSetMany requires at least one patch');
  }

  // Fold by recursively wrapping the previous result.
  let current: SQL = jsonSet(col, head[0], head[1]);
  for (let i = 1; i < patches.length; i++) {
    const next = patches[i];
    if (!next) continue;
    current = jsonSet(current, next[0], next[1]);
  }
  return current;
}

/**
 * Portable `CURRENT_TIMESTAMP` SQL — works identically on SQLite and
 * Postgres. SQLite returns `'YYYY-MM-DD HH:MM:SS'` (UTC) by default;
 * Postgres returns a `timestamptz`. For most callers, prefer
 * `new Date().toISOString()` from JS to capture a JS-side ISO 8601 string —
 * it round-trips through both dialects identically.
 */
export function currentTimestampSql(): SQL {
  return sql`CURRENT_TIMESTAMP`;
}

/**
 * Run a raw `sql` template against the database, returning a uniform
 * `{ changes: number }` shape. Dispatches to:
 *   - `db.run(query)` on SQLite (returns `{ changes }` natively).
 *   - `db.execute(query)` on Postgres (returns the postgres-js Result
 *     object with `.count` for affected rows).
 *
 * Use this for any UPDATE/DELETE/INSERT that does not have a clean
 * Drizzle query-builder representation. For pure SELECTs, prefer
 * `db.query.<table>...`.
 */
export async function runRaw(db: Database, query: SQL): Promise<{ changes: number }> {
  if (getDbDialect() === 'postgres') {
    // Cast through unknown — `Database` is structurally typed as the
    // SQLite shape but at runtime in postgres mode it is a
    // `PostgresJsDatabase` and exposes `execute()`. The `Result` type
    // returned by postgres-js extends `Array` and exposes a `count`.
    const result = (await (
      db as unknown as { execute: (q: SQL) => Promise<{ count?: number; length?: number }> }
    ).execute(query)) as { count?: number; length?: number };
    const changes = typeof result?.count === 'number' ? result.count : (result?.length ?? 0);
    return { changes };
  }
  // SQLite — better-sqlite3 / bun-sqlite returns `{ changes, lastInsertRowid }`
  // synchronously. Some test mocks return a Promise via `mockResolvedValue`,
  // so we `await` the result to handle both cases uniformly.
  const result = (await (db as unknown as { run: (q: SQL) => { changes: number } | Promise<{ changes: number }> }).run(query)) as { changes: number };
  return { changes: result.changes };
}

/**
 * Validate a JSON path part to prevent SQL injection via path keys.
 * JSON object keys in path expressions are concatenated into the SQL
 * literal (`$.a.b` for SQLite, `{a,b}` for Postgres) and are not
 * parameterised by the driver — so we lock them down to a safe charset.
 *
 * Permitted: ASCII letters, digits, underscore, dash. Anything else is
 * rejected to avoid a malicious key like `';DROP TABLE`. All current
 * call sites use static identifiers, so this is a defensive belt-and-
 * braces measure.
 */
function validatePathParts(parts: string[]): void {
  const SAFE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const p of parts) {
    if (!SAFE.test(p)) {
      throw new Error(`Unsafe JSON path part: ${JSON.stringify(p)}`);
    }
  }
}
