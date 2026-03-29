#!/usr/bin/env bun
/**
 * Schema Drift Check — SQLite vs PostgreSQL
 *
 * Compares the export lists in sqlite/index.ts and postgres/index.ts to ensure
 * every module re-exported by one is also re-exported by the other.
 *
 * Then, for each shared module, compares column definitions, foreign key
 * onDelete behavior, and index definitions between the two schemas.
 *
 * Usage:  bun run scripts/check-schema-drift.ts
 * Exit 0 = schemas are in sync, Exit 1 = drift detected.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../src/db/schema');

// ---------------------------------------------------------------------------
// Phase 1: Module-level check (existing logic)
// ---------------------------------------------------------------------------

function extractModules(indexPath: string): Set<string> {
  const content = readFileSync(indexPath, 'utf-8');
  const modules = new Set<string>();
  const re = /export\s+\*\s+from\s+['"]\.\/([^'"]+)['"]/g;
  for (const match of content.matchAll(re)) {
    modules.add(match[1]);
  }
  return modules;
}

const sqliteIndex = resolve(root, 'sqlite/index.ts');
const postgresIndex = resolve(root, 'postgres/index.ts');

const sqliteModules = extractModules(sqliteIndex);
const postgresModules = extractModules(postgresIndex);

const missingSqlite = [...postgresModules].filter((m) => !sqliteModules.has(m));
const missingPostgres = [...sqliteModules].filter((m) => !postgresModules.has(m));

let moduleDrift = false;

if (missingPostgres.length > 0) {
  console.error('ERROR: Schema drift detected: modules in SQLite but MISSING from PostgreSQL:');
  for (const m of missingPostgres.sort()) {
    console.error(`  - ${m}`);
  }
  moduleDrift = true;
}

if (missingSqlite.length > 0) {
  console.error('ERROR: Schema drift detected: modules in PostgreSQL but MISSING from SQLite:');
  for (const m of missingSqlite.sort()) {
    console.error(`  - ${m}`);
  }
  moduleDrift = true;
}

// ---------------------------------------------------------------------------
// Phase 2 & 3: Column-level and index-level comparison for shared modules
// ---------------------------------------------------------------------------

interface ColumnInfo {
  propertyName: string;
  dbColumnName: string;
  onDelete?: string;
}

interface TableInfo {
  tableName: string;
  columns: Map<string, ColumnInfo>;
}

interface IndexInfo {
  name: string;
  columns: string;
}

/**
 * Track delimiter depth to find the matching close character.
 * Starts just past the opening delimiter and returns the index just past the close.
 */
function findMatchingClose(content: string, startIdx: number, open: string, close: string): number {
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
 * Parse a schema file and extract both table/column info and index info in a single pass.
 * Avoids reading the same file twice (once for columns, once for indexes).
 */
function parseSchemaFile(filePath: string): {
  tables: Map<string, TableInfo>;
  indexes: Map<string, IndexInfo[]>;
} {
  const content = readFileSync(filePath, 'utf-8');
  const tables = new Map<string, TableInfo>();
  const indexes = new Map<string, IndexInfo[]>();

  const tableRe =
    /export\s+const\s+\w+\s*=\s*(?:sqliteTable|pgTable)\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;

  for (const tableMatch of content.matchAll(tableRe)) {
    const tableName = tableMatch[1];
    const bodyStart = tableMatch.index + tableMatch[0].length;

    // Extract column body (inside the first { ... })
    const bodyEnd = findMatchingClose(content, bodyStart, '{', '}');
    const body = content.slice(bodyStart, bodyEnd - 1);
    tables.set(tableName, { tableName, columns: extractColumns(body) });

    // Extract indexes from the full table call
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
 * Extract column definitions from a table body string.
 *
 * Matches patterns like:
 *   columnName: text('db_col_name')...
 *   columnName: integer('db_col_name')...
 *   columnName: jsonb('db_col_name')...
 *   columnName: timestamp('db_col_name', ...)...
 *
 * Also extracts .references(() => ..., { onDelete: '...' }) if present.
 */
function extractColumns(body: string): Map<string, ColumnInfo> {
  const columns = new Map<string, ColumnInfo>();

  // Split body into top-level property definitions.
  // Each column starts at the beginning of a line (after whitespace) with an identifier followed by ':'
  // We need to handle multi-line column definitions, so we track brace/paren depth.
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
      // Comment or empty line — include in current chunk for continuity
      if (currentChunk) currentChunk += `\n${line}`;
      continue;
    }

    // Check if this line starts a new property (identifier: ...)
    // But only at depth 0
    const propStart = /^(\w+)\s*:/.test(trimmed);
    if (propStart && depth === 0 && currentChunk) {
      columnChunks.push(currentChunk);
      currentChunk = '';
    }

    currentChunk += (currentChunk ? '\n' : '') + line;

    // Track depth for parens and braces
    for (const ch of trimmed) {
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
  }
  if (currentChunk) columnChunks.push(currentChunk);

  for (const chunk of columnChunks) {
    const trimmed = chunk.trim();

    // Extract property name
    const propMatch = trimmed.match(/^(\w+)\s*:/);
    if (!propMatch) continue;
    const propertyName = propMatch[1];

    // Extract DB column name from the type function call: text('col_name'), integer('col_name'), etc.
    const dbColMatch = trimmed.match(
      /:\s*(?:text|integer|real|blob|jsonb|timestamp|boolean|serial|varchar|numeric|uuid)\s*\(\s*['"]([^'"]+)['"]/
    );
    const dbColumnName = dbColMatch ? dbColMatch[1] : propertyName;

    // Extract onDelete from .references(...)
    let onDelete: string | undefined;
    const refMatch = trimmed.match(/\.references\s*\([^)]*\{[^}]*onDelete\s*:\s*['"]([^'"]+)['"]/s);
    if (refMatch) {
      onDelete = refMatch[1];
    }

    columns.set(propertyName, { propertyName, dbColumnName, onDelete });
  }

  return columns;
}

// Compare tables, columns, and indexes across shared modules (single pass per file pair)
const sharedModules = [...sqliteModules].filter((m) => postgresModules.has(m));
let columnDrift = false;
const warnings: string[] = [];

for (const mod of sharedModules.sort()) {
  const sqlitePath = resolve(root, `sqlite/${mod}.ts`);
  const postgresPath = resolve(root, `postgres/${mod}.ts`);

  if (!existsSync(sqlitePath) || !existsSync(postgresPath)) {
    continue;
  }

  // Parse both files once (extracts tables + indexes together)
  const sqlite = parseSchemaFile(sqlitePath);
  const postgres = parseSchemaFile(postgresPath);

  // --- Table-level drift ---
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

  // --- Column-level drift for shared tables ---
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

    // Compare onDelete behavior for shared columns
    for (const [colName, sqliteCol] of sqliteCols) {
      const pgCol = pgCols.get(colName);
      if (!pgCol) continue;

      const sqlDel = sqliteCol.onDelete;
      const pgDel = pgCol.onDelete;
      if (sqlDel === pgDel) continue;

      const sqlLabel = sqlDel ? `'${sqlDel}'` : 'no reference/onDelete';
      const pgLabel = pgDel ? `'${pgDel}'` : 'no reference/onDelete';
      warnings.push(
        `[${mod}] Table '${tableName}', column '${colName}': onDelete mismatch — SQLite=${sqlLabel}, PostgreSQL=${pgLabel}`
      );
      columnDrift = true;
    }
  }

  // --- Index-level drift ---
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

    // Compare columns for shared indexes
    for (const [idxName, sqliteIdx] of sqliteIdxMap) {
      const pgIdx = postgresIdxMap.get(idxName);
      if (!pgIdx || sqliteIdx.columns === pgIdx.columns) continue;

      warnings.push(
        `[${mod}] Table '${tableName}': index '${idxName}' column mismatch — SQLite=(${sqliteIdx.columns}), PostgreSQL=(${pgIdx.columns})`
      );
      columnDrift = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

if (warnings.length > 0) {
  console.warn('\nColumn/Index drift warnings:');
  for (const w of warnings) {
    console.warn(`  WARNING: ${w}`);
  }
  console.warn(`\n${warnings.length} warning(s) found.`);
}

if (moduleDrift) {
  console.error('\nSchema drift check FAILED — module-level mismatches detected.');
  process.exit(1);
}

if (columnDrift) {
  console.error('\nSchema drift check FAILED — column/index-level drift detected.');
  process.exit(1);
}

console.log(
  `\nSchema drift check passed — ${sharedModules.length} shared modules compared, SQLite and PostgreSQL schemas are in sync.`
);
process.exit(0);
