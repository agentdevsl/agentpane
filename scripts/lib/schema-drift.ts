/**
 * Schema-drift detection helpers — F02-16 (arch29-W2-R).
 *
 * Pure helpers extracted from `scripts/check-schema-drift.ts` so they can be
 * unit-tested directly. The script file remains the CLI entry point and
 * re-exports / consumes these helpers.
 *
 * Coverage gates:
 *   - Phase 1: module-level parity (the export lists in `sqlite/index.ts`
 *     and `postgres/index.ts` must contain the same module set).
 *   - Phase 2: per-shared-module column existence + onDelete + type-token
 *     comparison + index parity.
 *
 * F02-16: the type-token comparison was previously absent — the script
 * extracted column NAMES only, leaving real drifts (text vs jsonb, text vs
 * timestamp) silently blessed. The {@link normalizeTypeToken} +
 * {@link typesCompatible} pair surface those drifts as warnings.
 */

import { readFileSync } from 'node:fs';

export interface ColumnInfo {
  propertyName: string;
  dbColumnName: string;
  /**
   * F02-16: normalized type token. Holds a dialect-neutral key that captures
   * the storage type AND the most common Drizzle modes (e.g. `text-json`,
   * `integer-boolean`, `integer-timestamp_ms`). Two columns with the same
   * normalized type token are considered compatible across dialects.
   */
  typeToken: string;
  onDelete?: string;
}

export interface TableInfo {
  tableName: string;
  columns: Map<string, ColumnInfo>;
}

export interface IndexInfo {
  name: string;
  columns: string;
}

/**
 * Track delimiter depth to find the matching close character.
 * Starts just past the opening delimiter and returns the index just past the close.
 */
export function findMatchingClose(
  content: string,
  startIdx: number,
  open: string,
  close: string
): number {
  let depth = 1;
  let i = startIdx;
  while (i < content.length && depth > 0) {
    if (content[i] === open) depth++;
    else if (content[i] === close) depth--;
    i++;
  }
  return i;
}

/**
 * F02-16: normalize a Drizzle column declaration to a dialect-neutral type
 * token. The token is the primary cross-dialect compatibility key — two
 * columns must share a token (or share an entry in the {@link TYPE_COMPAT}
 * map) to be considered drift-free.
 */
export function normalizeTypeToken(drizzleType: string, fullChunk: string): string {
  const modeMatch = fullChunk.match(/\{\s*mode\s*:\s*['"]([^'"]+)['"]/);
  const mode = modeMatch ? modeMatch[1] : null;

  switch (drizzleType) {
    case 'jsonb':
      return 'text-json';
    case 'boolean':
      return 'integer-boolean';
    case 'timestamp':
    case 'timestamptz':
      return 'text-timestamp';
    case 'serial':
    case 'bigserial':
      return 'integer';
    case 'doublePrecision':
    case 'numeric':
      return 'real';
    case 'varchar':
      return 'text';
    case 'uuid':
      return 'text';
    case 'smallint':
      return 'integer';
    case 'bigint':
      if (mode === 'number') return 'integer-timestamp_ms';
      return 'integer';
    case 'text':
      if (mode === 'json') return 'text-json';
      return 'text';
    case 'integer':
      if (mode === 'boolean') return 'integer-boolean';
      if (mode === 'timestamp_ms') return 'integer-timestamp_ms';
      if (mode === 'timestamp') return 'integer-timestamp';
      return 'integer';
    case 'real':
      return 'real';
    case 'blob':
      return 'blob';
    default:
      return drizzleType;
  }
}

/**
 * F02-16: cross-dialect type compatibility map. Two columns whose normalized
 * type tokens differ must appear in this matrix on at least one side to be
 * considered drift-free.
 */
export const TYPE_COMPAT: Record<string, ReadonlySet<string>> = {
  'text-json': new Set(['text-json']),
  'integer-boolean': new Set(['integer-boolean']),
  'text-timestamp': new Set(['text-timestamp', 'text']),
  'integer-timestamp_ms': new Set(['integer-timestamp_ms', 'integer']),
  integer: new Set(['integer', 'integer-timestamp_ms']),
  text: new Set(['text', 'text-timestamp']),
  real: new Set(['real']),
  blob: new Set(['blob']),
  unknown: new Set(['unknown']),
};

/**
 * F02-16: returns true if the two type tokens are considered drift-free.
 */
export function typesCompatible(sqliteToken: string, pgToken: string): boolean {
  if (sqliteToken === pgToken) return true;
  const sqliteCompat = TYPE_COMPAT[sqliteToken];
  if (sqliteCompat?.has(pgToken)) return true;
  const pgCompat = TYPE_COMPAT[pgToken];
  if (pgCompat?.has(sqliteToken)) return true;
  return false;
}

/**
 * Extract column definitions from a table body string.
 * Recognises text/integer/real/blob/jsonb/timestamp/boolean/serial/varchar/
 * numeric/uuid/bigint/bigserial/doublePrecision/smallint columns and reads
 * their `mode: '...'` annotations to compute the type token (F02-16).
 */
export function extractColumns(body: string): Map<string, ColumnInfo> {
  const columns = new Map<string, ColumnInfo>();

  const lines = body.split('\n');
  const columnChunks: string[] = [];
  let currentChunk = '';
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      if (currentChunk) currentChunk += `\n${line}`;
      continue;
    }

    const propStart = /^(\w+)\s*:/.test(trimmed);
    if (propStart && depth === 0 && currentChunk) {
      columnChunks.push(currentChunk);
      currentChunk = '';
    }

    currentChunk += (currentChunk ? '\n' : '') + line;

    for (const ch of trimmed) {
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
  }
  if (currentChunk) columnChunks.push(currentChunk);

  for (const chunk of columnChunks) {
    const trimmed = chunk.trim();

    const propMatch = trimmed.match(/^(\w+)\s*:/);
    if (!propMatch) continue;
    const propertyName = propMatch[1];

    const typeAndNameMatch = trimmed.match(
      /:\s*(text|integer|real|blob|jsonb|timestamp|timestamptz|boolean|serial|varchar|numeric|uuid|bigint|bigserial|doublePrecision|smallint)\s*\(\s*['"]([^'"]+)['"]/
    );
    const drizzleType = typeAndNameMatch ? typeAndNameMatch[1] : 'unknown';
    const dbColumnName = typeAndNameMatch ? typeAndNameMatch[2] : propertyName;
    const typeToken = normalizeTypeToken(drizzleType, trimmed);

    let onDelete: string | undefined;
    const refMatch = trimmed.match(/\.references\s*\([^)]*\{[^}]*onDelete\s*:\s*['"]([^'"]+)['"]/s);
    if (refMatch) {
      onDelete = refMatch[1];
    }

    columns.set(propertyName, { propertyName, dbColumnName, typeToken, onDelete });
  }

  return columns;
}

/**
 * Parse a schema file and extract both table/column info and index info in a single pass.
 */
export function parseSchemaFile(filePath: string): {
  tables: Map<string, TableInfo>;
  indexes: Map<string, IndexInfo[]>;
} {
  const content = readFileSync(filePath, 'utf-8');
  return parseSchemaContent(content);
}

export function parseSchemaContent(content: string): {
  tables: Map<string, TableInfo>;
  indexes: Map<string, IndexInfo[]>;
} {
  const tables = new Map<string, TableInfo>();
  const indexes = new Map<string, IndexInfo[]>();

  const tableRe =
    /export\s+const\s+\w+\s*=\s*(?:sqliteTable|pgTable)\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;

  for (const tableMatch of content.matchAll(tableRe)) {
    const tableName = tableMatch[1];
    const bodyStart = tableMatch.index + tableMatch[0].length;

    const bodyEnd = findMatchingClose(content, bodyStart, '{', '}');
    const body = content.slice(bodyStart, bodyEnd - 1);
    tables.set(tableName, { tableName, columns: extractColumns(body) });

    const callStart = content.lastIndexOf('(', bodyStart);
    const callEnd = findMatchingClose(content, callStart + 1, '(', ')');
    const fullCall = content.slice(callStart, callEnd);

    const indexRe = /(?:unique)?[Ii]ndex\(\s*['"]([^'"]+)['"]\s*\)\.on\(([^)]+)\)/g;
    const tableIndexes: IndexInfo[] = [];
    for (const idxMatch of fullCall.matchAll(indexRe)) {
      const colRefs = [...idxMatch[2].matchAll(/(?:table|t)\.(\w+)/g)].map((m) => m[1]);
      tableIndexes.push({ name: idxMatch[1], columns: colRefs.join(', ') });
    }
    if (tableIndexes.length > 0) {
      indexes.set(tableName, tableIndexes);
    }
  }

  return { tables, indexes };
}

/**
 * Compare a sqlite/postgres pair of parsed-schema structures and emit
 * warnings for any drift. Returns `true` if drift was found.
 */
export function compareSchemas(
  mod: string,
  sqlite: ReturnType<typeof parseSchemaContent>,
  postgres: ReturnType<typeof parseSchemaContent>,
  warnings: string[]
): boolean {
  let columnDrift = false;

  for (const name of sqlite.tables.keys()) {
    if (!postgres.tables.has(name)) {
      warnings.push(`[${mod}] Table '${name}' exists in SQLite but not in PostgreSQL`);
      columnDrift = true;
    }
  }
  for (const name of postgres.tables.keys()) {
    if (!sqlite.tables.has(name)) {
      warnings.push(`[${mod}] Table '${name}' exists in PostgreSQL but not in SQLite`);
      columnDrift = true;
    }
  }

  for (const [tableName, sqliteTable] of sqlite.tables) {
    const pgTable = postgres.tables.get(tableName);
    if (!pgTable) continue;

    const sqliteCols = sqliteTable.columns;
    const pgCols = pgTable.columns;

    for (const colName of sqliteCols.keys()) {
      if (!pgCols.has(colName)) {
        warnings.push(
          `[${mod}] Table '${tableName}': column '${colName}' exists in SQLite but missing from PostgreSQL`
        );
        columnDrift = true;
      }
    }

    for (const colName of pgCols.keys()) {
      if (!sqliteCols.has(colName)) {
        warnings.push(
          `[${mod}] Table '${tableName}': column '${colName}' exists in PostgreSQL but missing from SQLite`
        );
        columnDrift = true;
      }
    }

    for (const [colName, sqliteCol] of sqliteCols) {
      const pgCol = pgCols.get(colName);
      if (!pgCol) continue;

      const sqlDel = sqliteCol.onDelete;
      const pgDel = pgCol.onDelete;
      if (sqlDel !== pgDel) {
        const sqlLabel = sqlDel ? `'${sqlDel}'` : 'no reference/onDelete';
        const pgLabel = pgDel ? `'${pgDel}'` : 'no reference/onDelete';
        warnings.push(
          `[${mod}] Table '${tableName}', column '${colName}': onDelete mismatch — SQLite=${sqlLabel}, PostgreSQL=${pgLabel}`
        );
        columnDrift = true;
      }

      // F02-16: normalized type-token comparison.
      if (!typesCompatible(sqliteCol.typeToken, pgCol.typeToken)) {
        warnings.push(
          `[${mod}] Table '${tableName}', column '${colName}': type drift — SQLite='${sqliteCol.typeToken}', PostgreSQL='${pgCol.typeToken}'`
        );
        columnDrift = true;
      }
    }
  }

  const allIndexedTables = new Set([...sqlite.indexes.keys(), ...postgres.indexes.keys()]);
  for (const tableName of allIndexedTables) {
    const sqliteIdxs = sqlite.indexes.get(tableName) || [];
    const postgresIdxs = postgres.indexes.get(tableName) || [];

    const sqliteIdxMap = new Map(sqliteIdxs.map((idx) => [idx.name, idx]));
    const postgresIdxMap = new Map(postgresIdxs.map((idx) => [idx.name, idx]));

    for (const idx of sqliteIdxs) {
      if (!postgresIdxMap.has(idx.name)) {
        warnings.push(
          `[${mod}] Table '${tableName}': index '${idx.name}' (${idx.columns}) exists in SQLite but missing from PostgreSQL`
        );
        columnDrift = true;
      }
    }

    for (const idx of postgresIdxs) {
      if (!sqliteIdxMap.has(idx.name)) {
        warnings.push(
          `[${mod}] Table '${tableName}': index '${idx.name}' (${idx.columns}) exists in PostgreSQL but missing from SQLite`
        );
        columnDrift = true;
      }
    }

    for (const [idxName, sqliteIdx] of sqliteIdxMap) {
      const pgIdx = postgresIdxMap.get(idxName);
      if (!pgIdx || sqliteIdx.columns === pgIdx.columns) continue;

      warnings.push(
        `[${mod}] Table '${tableName}': index '${idxName}' column mismatch — SQLite=(${sqliteIdx.columns}), PostgreSQL=(${pgIdx.columns})`
      );
      columnDrift = true;
    }
  }

  return columnDrift;
}
