#!/usr/bin/env bun
/**
 * Schema Drift Check — SQLite vs PostgreSQL
 *
 * Compares the export lists in sqlite/index.ts and postgres/index.ts to ensure
 * every module re-exported by one is also re-exported by the other.
 *
 * Usage:  bun run scripts/check-schema-drift.ts
 * Exit 0 = schemas are in sync, Exit 1 = drift detected.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../src/db/schema');

function extractModules(indexPath: string): Set<string> {
  const content = readFileSync(indexPath, 'utf-8');
  const modules = new Set<string>();
  // Match lines like: export * from './foo-bar';
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

// Filter out shared modules that are re-exported (e.g. ../shared/enums)
// Those are handled separately and always shared.

const missingSqlite = [...postgresModules].filter((m) => !sqliteModules.has(m));
const missingPostgres = [...sqliteModules].filter((m) => !postgresModules.has(m));

let driftDetected = false;

if (missingPostgres.length > 0) {
  console.error('Schema drift detected: modules in SQLite but MISSING from PostgreSQL:');
  for (const m of missingPostgres.sort()) {
    console.error(`  - ${m}`);
  }
  driftDetected = true;
}

if (missingSqlite.length > 0) {
  console.error('Schema drift detected: modules in PostgreSQL but MISSING from SQLite:');
  for (const m of missingSqlite.sort()) {
    console.error(`  - ${m}`);
  }
  driftDetected = true;
}

if (driftDetected) {
  console.error('\nSchema drift check FAILED. Fix the above discrepancies.');
  process.exit(1);
} else {
  console.log('Schema drift check passed — SQLite and PostgreSQL index exports are in sync.');
  process.exit(0);
}
