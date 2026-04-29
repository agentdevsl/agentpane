#!/usr/bin/env bun
/**
 * Schema Drift Check — SQLite vs PostgreSQL
 *
 * Compares the export lists in sqlite/index.ts and postgres/index.ts to ensure
 * every module re-exported by one is also re-exported by the other.
 *
 * Then, for each shared module, compares column definitions, foreign key
 * onDelete behavior, type tokens (F02-16), and index definitions between the
 * two schemas.
 *
 * Usage:  bun run scripts/check-schema-drift.ts
 * Exit 0 = schemas are in sync, Exit 1 = drift detected.
 *
 * F02-16 (arch29-W2-R): the per-column comparison now extracts a normalized
 * type token (text, text-json, integer-boolean, integer-timestamp_ms, ...)
 * and asserts cross-dialect compatibility against {@link TYPE_COMPAT}. The
 * detection logic is extracted into `scripts/lib/schema-drift.ts` so it can
 * be unit-tested independently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareSchemas, parseSchemaFile } from './lib/schema-drift';

const root = resolve(import.meta.dir, '../src/db/schema');

// ---------------------------------------------------------------------------
// Phase 1: Module-level check
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
// Phase 2: Per-module column / type / onDelete / index drift comparison
// ---------------------------------------------------------------------------

const sharedModules = [...sqliteModules].filter((m) => postgresModules.has(m));
const warnings: string[] = [];
let columnDrift = false;

for (const mod of sharedModules.sort()) {
  const sqlitePath = resolve(root, `sqlite/${mod}.ts`);
  const postgresPath = resolve(root, `postgres/${mod}.ts`);

  if (!existsSync(sqlitePath) || !existsSync(postgresPath)) {
    continue;
  }

  const sqlite = parseSchemaFile(sqlitePath);
  const postgres = parseSchemaFile(postgresPath);

  if (compareSchemas(mod, sqlite, postgres, warnings)) {
    columnDrift = true;
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
