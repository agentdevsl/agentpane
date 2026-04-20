#!/usr/bin/env bun
/**
 * F02-01: SQLite ↔ PostgreSQL migration parity check.
 *
 * Verifies that every SQLite drizzle-kit migration file in src/db/migrations/
 * has a corresponding PostgreSQL migration in src/db/migrations-pg/ that
 * performs the equivalent schema change.
 *
 * Because the two chains use different numbering (SQLite reached 0017 while
 * PG consolidated through 0004_schema_catchup.sql), parity is asserted by
 * the `name` suffix — the canonical identifier after the leading four-digit
 * index. For example, `0014_add_task_execution_skill_columns.sql` on the
 * SQLite side must be matched by a PG migration whose name ends in
 * `_add_task_execution_skill_columns.sql` OR whose contents contain the
 * full SQL mirror of that change (enforced for pre-0004 migrations which
 * were consolidated into `0004_schema_catchup.sql`).
 *
 * Historically, SQLite migrations 0004–0012 were consolidated into the
 * PostgreSQL `0004_schema_catchup.sql` mega-migration, so those are allow-
 * listed. Any NEW SQLite migration (> 0012) MUST have its own dedicated
 * PG migration — the mega-migration is frozen.
 *
 * Usage:  bun run scripts/check-migration-parity.ts
 * Exit 0 = parity OK, Exit 1 = missing PG counterpart.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQLITE_DIR = resolve(import.meta.dir, '../src/db/migrations');
const PG_DIR = resolve(import.meta.dir, '../src/db/migrations-pg');

/**
 * SQLite migrations whose changes were folded into `0004_schema_catchup.sql`.
 * These do NOT require a standalone PG migration — the catch-up covers them.
 * If you add a NEW SQLite migration, DO NOT add it to this list; create a
 * matching per-change PG migration instead.
 */
const PRE_CATCHUP_ALLOWLIST = new Set<string>([
  '0000_clever_red_skull',
  '0004_add_templates',
  '0005_add_task_priority',
  '0006_add_template_sync_interval',
  '0007_add_session_sandbox_provider',
  '0008_add_session_summary_metrics',
  '0009_add_agent_parent',
  '0010_add_agentcore_columns',
  '0011_drop_agentcore_columns',
  '0012_add_task_skill_columns',
]);

/**
 * Explicit SQLite tag → PG tag mapping for cases where the canonical suffix
 * differs (e.g. SQLite's `0013_add_memory_insight_...` maps to PG's
 * `0005_memory_insight_...`). Going forward, keep the suffixes identical
 * so this map stays small.
 */
const EXPLICIT_PAIRS: Record<string, string> = {
  '0013_add_memory_insight_status_category': '0005_memory_insight_status_category',
};

function listMigrationTags(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

/** Extract the canonical name (suffix after the 4-digit index). */
function canonicalName(tag: string): string {
  const m = tag.match(/^\d{4}_(.+)$/);
  return m ? m[1] : tag;
}

const sqliteTags = listMigrationTags(SQLITE_DIR);
const pgTags = listMigrationTags(PG_DIR);
const pgCatchupSql = readFileSync(
  resolve(PG_DIR, '0004_schema_catchup.sql'),
  'utf-8'
).toLowerCase();

const pgCanonicalSet = new Set(pgTags.map(canonicalName));

const missing: string[] = [];
const catchupCovered: string[] = [];
const matched: string[] = [];

const pgTagSet = new Set(pgTags);

for (const sqlTag of sqliteTags) {
  if (PRE_CATCHUP_ALLOWLIST.has(sqlTag)) {
    catchupCovered.push(sqlTag);
    continue;
  }
  const canonical = canonicalName(sqlTag);
  const explicit = EXPLICIT_PAIRS[sqlTag];
  if (explicit && pgTagSet.has(explicit)) {
    matched.push(sqlTag);
    continue;
  }
  if (pgCanonicalSet.has(canonical)) {
    matched.push(sqlTag);
    continue;
  }
  // Final fallback: scan the catch-up for the SQL change, in case a new
  // migration was merged there by mistake. This is treated as a WARNING,
  // not a pass — the catch-up is frozen and new migrations should stand
  // alone.
  if (pgCatchupSql.includes(canonical.toLowerCase())) {
    console.warn(
      `WARN: SQLite ${sqlTag} appears inside 0004_schema_catchup.sql — create a dedicated PG migration instead.`
    );
    missing.push(sqlTag);
    continue;
  }
  missing.push(sqlTag);
}

console.log(`Migration parity: ${sqliteTags.length} SQLite migrations`);
console.log(
  `  matched by dedicated PG migration: ${matched.length} (${matched.join(', ') || 'none'})`
);
console.log(
  `  covered by pre-catchup allowlist:  ${catchupCovered.length} (consolidated into 0004_schema_catchup.sql)`
);

if (missing.length > 0) {
  console.error(`\nFAIL: ${missing.length} SQLite migration(s) have no matching PG migration:`);
  for (const tag of missing) {
    console.error(`  - ${tag}  →  expected src/db/migrations-pg/*_${canonicalName(tag)}.sql`);
  }
  console.error(
    '\nEvery new SQLite migration (> 0012) must have a dedicated per-change PG migration.'
  );
  process.exit(1);
}

console.log('\nPASS: every SQLite migration has a matching PG migration (or allowlisted).');
process.exit(0);
