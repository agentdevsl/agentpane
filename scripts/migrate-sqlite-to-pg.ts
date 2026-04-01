#!/usr/bin/env bun
/**
 * SQLite → PostgreSQL data migration script.
 *
 * Reads all rows from an existing SQLite database and writes them into a
 * PostgreSQL 18 instance. Handles boolean/JSON type conversions, circular FK
 * dependencies (tasks↔sessions↔worktrees), batched inserts, and dry-run mode.
 *
 * Usage:
 *   bun run db:migrate:sqlite-to-pg [options]
 *
 * Options:
 *   --sqlite-path <path>   Source SQLite file (default: ./data/agentpane.db)
 *   --database-url <url>   Target PG connection (default: $DATABASE_URL)
 *   --batch-size <n>       Rows per INSERT (default: 500)
 *   --dry-run              Read/validate only, rollback all writes
 *   --clean                TRUNCATE all PG tables before migrating
 *   --verbose              Log each row as it's converted
 */

import { Database } from 'bun:sqlite';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
  sqlitePath: string;
  databaseUrl: string;
  batchSize: number;
  dryRun: boolean;
  clean: boolean;
  verbose: boolean;
}

interface TableDef {
  name: string;
  primaryKey: string | string[];
  booleanCols: string[];
  jsonCols: string[];
  circularFkCols: string[];
}

interface DeferredUpdate {
  table: string;
  primaryKey: string | string[];
  pkValues: Record<string, unknown>;
  column: string;
  value: unknown;
}

interface MigrateResult {
  table: string;
  rowCount: number;
  durationMs: number;
  deferred: DeferredUpdate[];
}

class DryRunRollback extends Error {
  constructor() {
    super('DRY_RUN_ROLLBACK');
  }
}

// ---------------------------------------------------------------------------
// Table definitions -- ordered by dependency depth; circular FKs handled via deferred updates
// ---------------------------------------------------------------------------

const TABLE_DEFS: TableDef[] = [
  // Phase 1: No foreign keys
  {
    name: 'settings',
    primaryKey: 'key',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'api_keys',
    primaryKey: 'id',
    booleanCols: ['is_valid'],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'github_tokens',
    primaryKey: 'id',
    booleanCols: ['is_valid'],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'github_installations',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'sandbox_configs',
    primaryKey: 'id',
    booleanCols: ['is_default', 'network_policy_enabled'],
    jsonCols: ['allowed_egress_hosts'],
    circularFkCols: [],
  },
  {
    name: 'terraform_registries',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'marketplaces',
    primaryKey: 'id',
    booleanCols: ['is_default', 'is_enabled'],
    jsonCols: ['cached_plugins'],
    circularFkCols: [],
  },
  {
    name: 'cli_sessions',
    primaryKey: 'id',
    booleanCols: ['is_subagent'],
    jsonCols: [],
    circularFkCols: [],
  },

  // Phase 2: Parent tables
  {
    name: 'projects',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['config'],
    circularFkCols: [],
  },
  {
    name: 'agents',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['config'],
    circularFkCols: [],
  },

  // Phase 3: Circular FK group
  {
    name: 'tasks',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['labels', 'diff_summary', 'plan_options'],
    circularFkCols: ['session_id', 'worktree_id'],
  },
  {
    name: 'sessions',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: ['task_id'],
  },
  {
    name: 'worktrees',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: ['task_id'],
  },

  // Phase 4: Remaining children
  {
    name: 'templates',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['cached_skills', 'cached_commands', 'cached_agents'],
    circularFkCols: [],
  },
  {
    name: 'repository_configs',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['config'],
    circularFkCols: [],
  },
  {
    name: 'sandbox_instances',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['volume_mounts', 'env'],
    circularFkCols: [],
  },
  {
    name: 'agent_runs',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'session_events',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['data'],
    circularFkCols: [],
  },
  {
    name: 'session_summaries',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'audit_logs',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['input', 'output'],
    circularFkCols: [],
  },
  {
    name: 'template_projects',
    primaryKey: ['template_id', 'project_id'],
    booleanCols: [],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'sandbox_tmux_sessions',
    primaryKey: 'id',
    booleanCols: ['attached'],
    jsonCols: [],
    circularFkCols: [],
  },
  {
    name: 'plan_sessions',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['turns'],
    circularFkCols: [],
  },
  {
    name: 'terraform_modules',
    primaryKey: 'id',
    booleanCols: [],
    jsonCols: ['inputs', 'outputs', 'dependencies'],
    circularFkCols: [],
  },
  {
    name: 'workflows',
    primaryKey: 'id',
    booleanCols: ['ai_generated'],
    jsonCols: ['nodes', 'edges', 'viewport', 'tags'],
    circularFkCols: [],
  },
];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    sqlitePath: './data/agentpane.db',
    databaseUrl: process.env.DATABASE_URL ?? '',
    batchSize: 500,
    dryRun: false,
    clean: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sqlite-path':
        if (args[i + 1] === undefined) {
          console.error('[migrate] ERROR: --sqlite-path requires a value');
          process.exit(1);
        }
        config.sqlitePath = args[++i];
        break;
      case '--database-url':
        if (args[i + 1] === undefined) {
          console.error('[migrate] ERROR: --database-url requires a value');
          process.exit(1);
        }
        config.databaseUrl = args[++i];
        break;
      case '--batch-size':
        if (args[i + 1] === undefined) {
          console.error('[migrate] ERROR: --batch-size requires a value');
          process.exit(1);
        }
        config.batchSize = Number.parseInt(args[++i], 10);
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--clean':
        config.clean = true;
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--help':
        console.log(`Usage: bun scripts/migrate-sqlite-to-pg.ts [options]

Options:
  --sqlite-path <path>   Source SQLite file (default: ./data/agentpane.db)
  --database-url <url>   Target PG connection (default: $DATABASE_URL)
  --batch-size <n>       Rows per INSERT batch (default: 500)
  --dry-run              Validate only, rollback all writes
  --clean                TRUNCATE all PG tables before migrating
  --verbose              Log each row as it's converted`);
        process.exit(0);
    }
  }

  if (!config.databaseUrl) {
    console.error('[migrate] ERROR: --database-url or DATABASE_URL required');
    process.exit(1);
  }

  if (Number.isNaN(config.batchSize) || config.batchSize <= 0) {
    console.error(
      `[migrate] ERROR: --batch-size must be a positive integer, got '${config.batchSize}'`
    );
    process.exit(1);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

// ---------------------------------------------------------------------------
// Type conversion helpers
// ---------------------------------------------------------------------------

function convertBoolean(value: unknown): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

function convertJson(
  value: unknown,
  context?: { table: string; column: string; pk: string }
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      const truncated = String(value).slice(0, 120);
      console.warn(
        `[migrate] WARNING: JSON parse failed` +
          (context ? ` (table=${context.table}, column=${context.column}, pk=${context.pk})` : '') +
          `: ${truncated}${String(value).length > 120 ? '...' : ''}`
      );
      return value;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Column discovery
// ---------------------------------------------------------------------------

function getSqliteColumns(sqliteDb: Database, tableName: string): string[] {
  const cols = sqliteDb.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[];
  return cols.map((c) => c.name);
}

async function getPgColumns(
  pgSql: postgres.TransactionSql | postgres.Sql,
  tableName: string
): Promise<string[]> {
  const cols = await pgSql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  return cols.map((c) => c.column_name);
}

async function getCommonColumns(
  sqliteDb: Database,
  pgSql: postgres.TransactionSql | postgres.Sql,
  tableName: string
): Promise<string[]> {
  const sqliteCols = new Set(getSqliteColumns(sqliteDb, tableName));
  const pgCols = await getPgColumns(pgSql, tableName);
  return pgCols.filter((c) => sqliteCols.has(c));
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

async function preflight(_config: Config, sqliteDb: Database, pgSql: postgres.Sql): Promise<void> {
  // Verify SQLite has tables
  const sqliteTables = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const sqliteTableNames = new Set(sqliteTables.map((t) => t.name));

  for (const def of TABLE_DEFS) {
    if (!sqliteTableNames.has(def.name)) {
      console.warn(`[migrate] WARNING: SQLite table '${def.name}' not found — will skip`);
    }
  }

  // Verify PG connection
  const [{ test }] = await pgSql`SELECT 1 as test`;
  if (test !== 1) throw new Error('PG connection test failed');

  // Verify PG tables exist
  const pgTables = await pgSql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  const pgTableNames = new Set(pgTables.map((t) => t.table_name));

  const missing = TABLE_DEFS.filter((d) => !pgTableNames.has(d.name));
  if (missing.length > 0) {
    throw new Error(
      `PG missing tables: ${missing.map((m) => m.name).join(', ')}. Run migrations first.`
    );
  }

  log(`Pre-flight passed: ${sqliteTableNames.size} SQLite tables, ${pgTableNames.size} PG tables`);
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

function convertRow(
  row: Record<string, unknown>,
  tableDef: TableDef,
  columns: string[]
): { converted: Record<string, unknown>; deferred: DeferredUpdate[] } {
  const converted: Record<string, unknown> = {};
  const deferred: DeferredUpdate[] = [];

  // Build a PK string for logging context
  const pkString = Array.isArray(tableDef.primaryKey)
    ? tableDef.primaryKey.map((k) => String(row[k])).join(',')
    : String(row[tableDef.primaryKey]);

  for (const col of columns) {
    let value = row[col];

    // Normalize undefined to null
    if (value === undefined) value = null;

    // Boolean conversion
    if (tableDef.booleanCols.includes(col)) {
      value = convertBoolean(value);
    }

    // JSON conversion
    if (tableDef.jsonCols.includes(col)) {
      value = convertJson(value, { table: tableDef.name, column: col, pk: pkString });
    }

    // Circular FK: NULL on insert, defer update
    if (tableDef.circularFkCols.includes(col) && value !== null) {
      const pkValues: Record<string, unknown> = {};
      if (Array.isArray(tableDef.primaryKey)) {
        for (const pk of tableDef.primaryKey) {
          pkValues[pk] = row[pk];
        }
      } else {
        pkValues[tableDef.primaryKey] = row[tableDef.primaryKey];
      }

      deferred.push({
        table: tableDef.name,
        primaryKey: tableDef.primaryKey,
        pkValues,
        column: col,
        value,
      });
      value = null;
    }

    converted[col] = value;
  }

  return { converted, deferred };
}

// ---------------------------------------------------------------------------
// Batched insert
// ---------------------------------------------------------------------------

async function batchInsert(
  tx: postgres.TransactionSql,
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  batchSize: number
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await tx`INSERT INTO ${tx(tableName)} ${tx(batch, ...columns)}`;
  }
}

// ---------------------------------------------------------------------------
// Deferred FK updates
// ---------------------------------------------------------------------------

async function applyDeferredUpdates(
  tx: postgres.TransactionSql,
  updates: DeferredUpdate[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  for (const update of updates) {
    const key = `${update.table}.${update.column}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);

    if (typeof update.primaryKey === 'string') {
      await tx`
        UPDATE ${tx(update.table)}
        SET ${tx({ [update.column]: update.value })}
        WHERE ${tx(update.primaryKey)} = ${update.pkValues[update.primaryKey]}
      `;
    } else if (Array.isArray(update.primaryKey)) {
      // Build compound WHERE clause for composite primary keys
      const conditions = update.primaryKey.map((pk) => tx`${tx(pk)} = ${update.pkValues[pk]}`);
      let where = conditions[0];
      for (let i = 1; i < conditions.length; i++) {
        where = tx`${where} AND ${conditions[i]}`;
      }
      await tx`
        UPDATE ${tx(update.table)}
        SET ${tx({ [update.column]: update.value })}
        WHERE ${where}
      `;
    } else {
      throw new Error(
        `Unsupported primaryKey type for table '${update.table}': ${typeof update.primaryKey}`
      );
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Migrate a single table
// ---------------------------------------------------------------------------

async function migrateTable(
  sqliteDb: Database,
  tx: postgres.TransactionSql,
  tableDef: TableDef,
  columns: string[],
  config: Config
): Promise<MigrateResult> {
  const start = Date.now();

  const rows = sqliteDb.prepare(`SELECT * FROM "${tableDef.name}"`).all() as Record<
    string,
    unknown
  >[];

  if (rows.length === 0) {
    return {
      table: tableDef.name,
      rowCount: 0,
      durationMs: Date.now() - start,
      deferred: [],
    };
  }

  const convertedRows: Record<string, unknown>[] = [];
  const allDeferred: DeferredUpdate[] = [];

  for (const row of rows) {
    const { converted, deferred } = convertRow(row, tableDef, columns);
    convertedRows.push(converted);
    allDeferred.push(...deferred);

    if (config.verbose) {
      const pkVal = Array.isArray(tableDef.primaryKey)
        ? tableDef.primaryKey.map((k) => row[k]).join(',')
        : row[tableDef.primaryKey as string];
      console.log(`  [verbose] ${tableDef.name} pk=${pkVal}`);
    }
  }

  await batchInsert(tx, tableDef.name, columns, convertedRows, config.batchSize);

  return {
    table: tableDef.name,
    rowCount: rows.length,
    durationMs: Date.now() - start,
    deferred: allDeferred,
  };
}

// ---------------------------------------------------------------------------
// Truncate all tables (for --clean)
// ---------------------------------------------------------------------------

async function truncateAllTables(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(`TRUNCATE TABLE
    audit_logs, agent_runs, session_events, session_summaries,
    sandbox_tmux_sessions, template_projects, plan_sessions,
    sessions, worktrees, tasks, agents,
    templates, repository_configs, sandbox_instances,
    terraform_modules, workflows,
    terraform_registries, marketplaces, cli_sessions,
    sandbox_configs, github_installations, github_tokens,
    api_keys, settings, projects
  CASCADE`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  log(config.dryRun ? 'DRY RUN — no data will be committed' : 'Starting migration');
  log(`SQLite: ${config.sqlitePath}`);
  try {
    const safeUrl = new URL(config.databaseUrl);
    safeUrl.password = '***';
    safeUrl.username = '***';
    log(`PostgreSQL: ${safeUrl.toString()}`);
  } catch {
    log(`PostgreSQL: [invalid URL]`);
  }
  log(`Batch size: ${config.batchSize}`);
  log('');

  const sqliteDb = new Database(config.sqlitePath, { readonly: true, strict: true });
  const pgSql = postgres(config.databaseUrl);

  try {
    await preflight(config, sqliteDb, pgSql);
    log('');

    let totalRows = 0;
    const startTime = Date.now();
    const tableCount = TABLE_DEFS.length;

    try {
      await pgSql.begin(async (tx) => {
        // Disable all user triggers (including FK constraint enforcement) for the migration
        await tx.unsafe('SET session_replication_role = replica');

        if (config.clean) {
          log('Truncating all PG tables...');
          await truncateAllTables(tx);
          log('');
        }

        const allDeferred: DeferredUpdate[] = [];

        for (let i = 0; i < TABLE_DEFS.length; i++) {
          const tableDef = TABLE_DEFS[i];
          const num = String(i + 1).padStart(2, ' ');

          const columns = await getCommonColumns(sqliteDb, tx, tableDef.name);
          if (columns.length === 0) {
            log(`${num}/${tableCount}  ${tableDef.name.padEnd(25, '.')} no common columns (skip)`);
            continue;
          }

          const result = await migrateTable(sqliteDb, tx, tableDef, columns, config);
          allDeferred.push(...result.deferred);
          totalRows += result.rowCount;

          const rowStr =
            result.rowCount === 0
              ? '0 rows (skip)'
              : `${result.rowCount} rows (${result.durationMs}ms)`;
          const deferStr =
            result.deferred.length > 0 ? ` [${result.deferred.length} deferred]` : '';
          log(`${num}/${tableCount}  ${tableDef.name.padEnd(25, '.')} ${rowStr}${deferStr}`);
        }

        // Apply deferred FK updates
        if (allDeferred.length > 0) {
          log('');
          log(`Applying ${allDeferred.length} deferred FK updates...`);
          const counts = await applyDeferredUpdates(tx, allDeferred);
          for (const [key, count] of counts) {
            log(`  ${key}: ${count} rows`);
          }
        }

        // Re-enable all triggers before transaction commits
        await tx.unsafe('SET session_replication_role = DEFAULT');

        if (config.dryRun) {
          throw new DryRunRollback();
        }
      });
    } catch (e) {
      if (e instanceof DryRunRollback) {
        log('');
        log('DRY RUN complete — transaction rolled back, no data written');
      } else {
        throw e;
      }
    }

    log('');
    log('=== Migration Complete ===');
    log(`Total rows: ${totalRows.toLocaleString()}`);
    log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    log(`Tables: ${tableCount}/${tableCount}`);
    if (config.dryRun) log('Mode: DRY RUN (no data committed)');
  } catch (error) {
    console.error('[migrate] FATAL:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    sqliteDb.close();
    await pgSql.end();
  }
}

void main();
