import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static analysis test for PostgreSQL migration integrity.
 *
 * This test reads the raw SQL migration files and the Drizzle journal
 * without spinning up a PostgreSQL instance.  It verifies that:
 *   - All migration files referenced in the journal exist on disk
 *   - CREATE TABLE statements cover the expected set of tables
 *   - Critical columns are present in each table
 *   - Foreign-key constraints reference valid tables
 *   - The journal metadata is internally consistent
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'src/db/migrations-pg');
const META_DIR = resolve(MIGRATIONS_DIR, 'meta');
const JOURNAL_PATH = resolve(META_DIR, '_journal.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readAllMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

function readMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
}

/**
 * Extract all table names from CREATE TABLE statements across all migrations.
 * Handles both quoted and unquoted identifiers, and IF NOT EXISTS.
 */
function extractCreateTables(sql: string): string[] {
  const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  const tables: string[] = [];
  for (const match of sql.matchAll(regex)) {
    tables.push(match[1].toLowerCase());
  }
  return [...new Set(tables)].sort();
}

/**
 * Extract table renames from ALTER TABLE ... RENAME TO statements.
 * Returns array of { from, to } pairs.
 */
function extractTableRenames(sql: string): Array<{ from: string; to: string }> {
  const regex = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/gi;
  const renames: Array<{ from: string; to: string }> = [];
  for (const m of sql.matchAll(regex)) {
    renames.push({ from: m[1].toLowerCase(), to: m[2].toLowerCase() });
  }
  return renames;
}

/**
 * Compute the effective set of tables after applying all CREATE TABLE and
 * RENAME TO operations across the full migration chain.
 */
function computeEffectiveTables(sql: string): string[] {
  const created = new Set(extractCreateTables(sql));
  const renames = extractTableRenames(sql);
  for (const { from, to } of renames) {
    // The original name was created, now renamed
    created.delete(from);
    created.add(to);
  }
  return [...created].sort();
}

/**
 * Extract columns for a given table from the CREATE TABLE block.
 * Returns lowercased column names.
 */
function extractColumnsForTable(sql: string, tableName: string): string[] {
  // Match the CREATE TABLE block — greedy up to the closing ");".
  const tableRegex = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${tableName}"?\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  );
  const tableMatch = tableRegex.exec(sql);
  if (!tableMatch) return [];

  const body = tableMatch[1];
  // Each column definition starts with "column_name" at the beginning of a
  // line (after optional whitespace).  We extract quoted names.
  const colRegex = /^\s+"([a-z_][a-z0-9_]*)"/gm;
  const cols: string[] = [];
  for (const m of body.matchAll(colRegex)) {
    cols.push(m[1].toLowerCase());
  }
  return cols;
}

/**
 * Extract all foreign key constraints from ALTER TABLE ... ADD CONSTRAINT ...
 * FOREIGN KEY statements.
 */
interface ForeignKey {
  constraintName: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

function extractAlterTableForeignKeys(sql: string): ForeignKey[] {
  // Handle both "public"."table"("col") and "table"("col") reference formats
  const fkRegex =
    /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY\s+\("([^"]+)"\)\s+REFERENCES\s+(?:"public"\s*\.\s*)?"([^"]+)"\("([^"]+)"\)/gi;
  const keys: ForeignKey[] = [];
  for (const m of sql.matchAll(fkRegex)) {
    keys.push({
      sourceTable: m[1].toLowerCase(),
      constraintName: m[2],
      sourceColumn: m[3].toLowerCase(),
      targetTable: m[4].toLowerCase(),
      targetColumn: m[5].toLowerCase(),
    });
  }
  return keys;
}

/**
 * Extract inline REFERENCES from CREATE TABLE column definitions.
 * e.g.: "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
 */
interface InlineFK {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

function extractInlineForeignKeys(sql: string): InlineFK[] {
  const keys: InlineFK[] = [];
  // Find each CREATE TABLE block
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(([\s\S]*?)\);/gi;
  for (const tableMatch of sql.matchAll(tableRegex)) {
    const tableName = tableMatch[1].toLowerCase();
    const body = tableMatch[2];
    // Look for inline REFERENCES in column definitions
    const colRefRegex = /"([a-z_][a-z0-9_]*)"\s+[^,]*?REFERENCES\s+"([^"]+)"\("([^"]+)"\)/gi;
    for (const colMatch of body.matchAll(colRefRegex)) {
      keys.push({
        sourceTable: tableName,
        sourceColumn: colMatch[1].toLowerCase(),
        targetTable: colMatch[2].toLowerCase(),
        targetColumn: colMatch[3].toLowerCase(),
      });
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Tables present in the Drizzle PG schema definitions (source of truth).
// Derived from src/db/schema/postgres/*.ts pgTable() calls — 48 tables.
// ---------------------------------------------------------------------------

const DRIZZLE_PG_TABLES = [
  'agent_runs',
  'agents',
  'api_keys',
  'api_tokens',
  'audit_logs',
  'cli_sessions',
  'codespace_members',
  'codespace_tags',
  'codespaces',
  'dream_sessions',
  'event_log',
  'event_outbox',
  'event_sources',
  'event_subscriptions',
  'folder_members',
  'github_installations',
  'github_tokens',
  'marketplaces',
  'memory_insights',
  'memory_messages',
  'plan_sessions',
  'project_folders',
  'rate_limit_buckets',
  'repository_configs',
  'sandbox_configs',
  'sandbox_instances',
  'sandbox_tmux_sessions',
  'schedule_executions',
  'session_events',
  'session_summaries',
  'sessions',
  'settings',
  'skill_executions',
  'skill_metrics',
  'skill_suggestions',
  'tags',
  'task_tags',
  'tasks',
  'team_invitations',
  'team_members',
  'team_project_folders',
  'teams',
  'template_codespaces',
  'templates',
  'terraform_modules',
  'terraform_registries',
  'user_sessions',
  'users',
  'workflows',
  'worktrees',
].sort();

/**
 * All tables that should exist after applying every migration.
 * This includes:
 * - Tables from 0000 (initial creation)
 * - Tables added in 0004 (schema catch-up)
 * - Renames applied: projects->codespaces, template_projects->template_codespaces
 *
 * The effective table set should match the Drizzle schema exactly.
 */
const EXPECTED_EFFECTIVE_TABLES = [...DRIZZLE_PG_TABLES].sort();

/**
 * Tables created via CREATE TABLE across all migrations (before renames).
 * Includes both original names and new names from 0004.
 */
const ALL_CREATED_TABLES = [
  // From 0000 (initial)
  'agent_runs',
  'agents',
  'api_keys',
  'audit_logs',
  'cli_sessions',
  'github_installations',
  'github_tokens',
  'marketplaces',
  'plan_sessions',
  'projects', // renamed to codespaces in 0004
  'repository_configs',
  'sandbox_configs',
  'sandbox_instances',
  'sandbox_tmux_sessions',
  'session_events',
  'session_summaries',
  'sessions',
  'settings',
  'tasks',
  'template_projects', // renamed to template_codespaces in 0004
  'templates',
  'terraform_modules',
  'terraform_registries',
  'workflows',
  'worktrees',
  // From 0004 (schema catch-up)
  'api_tokens',
  'codespace_members',
  'codespace_tags',
  'dream_sessions',
  'event_log',
  'event_outbox',
  'event_sources',
  'event_subscriptions',
  'folder_members',
  'memory_insights',
  'memory_messages',
  'project_folders',
  'rate_limit_buckets',
  'schedule_executions',
  'skill_executions',
  'skill_metrics',
  'skill_suggestions',
  'tags',
  'task_tags',
  'team_invitations',
  'team_members',
  'team_project_folders',
  'teams',
  'user_sessions',
  'users',
].sort();

// Critical columns that every table must have (at minimum: a primary key).
// We check columns from the CREATE TABLE block (original column names).
const CRITICAL_COLUMNS: Record<string, string[]> = {
  // From 0000 — these use original column names (project_id, not codespace_id)
  agents: ['id', 'project_id', 'name', 'status', 'type', 'created_at'],
  tasks: ['id', 'project_id', 'title', 'column', 'position', 'priority', 'created_at'],
  sessions: ['id', 'project_id', 'status', 'url', 'created_at'],
  worktrees: ['id', 'project_id', 'branch', 'path', 'status', 'created_at'],
  agent_runs: ['id', 'agent_id', 'task_id', 'project_id', 'status', 'started_at'],
  audit_logs: ['id', 'tool', 'status', 'created_at'],
  // F05-25: `stream_kind` is added via ALTER TABLE (migration 0013), not the
  // original CREATE TABLE — it doesn't appear in extractColumnsForTable
  // output, so we keep this list aligned with the CREATE TABLE columns.
  session_events: ['id', 'session_id', 'offset', 'type', 'channel', 'data', 'timestamp'],
  settings: ['key', 'value', 'updated_at'],
  sandbox_configs: ['id', 'name', 'type', 'created_at'],
  sandbox_instances: ['id', 'project_id', 'container_id', 'status', 'created_at'],
  templates: ['id', 'name', 'scope', 'github_owner', 'github_repo', 'created_at'],
  workflows: ['id', 'name', 'nodes', 'edges', 'status', 'created_at'],
  cli_sessions: ['id', 'session_id', 'file_path', 'cwd', 'status', 'created_at'],
  plan_sessions: ['id', 'task_id', 'project_id', 'status', 'created_at'],
  terraform_registries: ['id', 'name', 'org_name', 'status', 'created_at'],
  terraform_modules: ['id', 'registry_id', 'name', 'namespace', 'provider', 'version'],
  github_installations: ['id', 'installation_id', 'account_login', 'created_at'],
  github_tokens: ['id', 'encrypted_token', 'token_type', 'created_at'],
  marketplaces: ['id', 'name', 'github_owner', 'github_repo', 'created_at'],
  projects: ['id', 'name', 'path', 'created_at'],
  // From 0004 — new tables
  users: ['id', 'github_id', 'github_login', 'created_at'],
  teams: ['id', 'name', 'slug', 'created_at'],
  project_folders: ['id', 'name', 'slug', 'created_at'],
  user_sessions: ['id', 'user_id', 'token', 'expires_at', 'created_at'],
  team_members: ['team_id', 'user_id', 'role'],
  team_invitations: ['id', 'team_id', 'email', 'role', 'token', 'status', 'created_at'],
  codespace_members: ['codespace_id', 'user_id', 'role', 'created_at'],
  api_tokens: ['id', 'user_id', 'team_id', 'name', 'token_hash', 'status', 'created_at'],
  tags: ['id', 'project_folder_id', 'name', 'color', 'created_at'],
  codespace_tags: ['codespace_id', 'tag_id'],
  task_tags: ['task_id', 'tag_id'],
  event_sources: ['id', 'team_id', 'name', 'type', 'slug', 'status', 'created_at'],
  event_subscriptions: ['id', 'name', 'event_source_id', 'target_codespace_id', 'created_at'],
  event_log: ['id', 'event_type', 'status', 'delivery_id'],
  schedule_executions: ['id', 'event_source_id', 'status', 'scheduled_at', 'created_at'],
  memory_insights: ['id', 'codespace_id', 'content', 'source', 'created_at'],
  memory_messages: ['id', 'codespace_id', 'memory_session_id', 'role', 'content', 'created_at'],
  skill_executions: ['id', 'codespace_id', 'skill_id', 'status', 'created_at'],
  skill_metrics: ['id', 'codespace_id', 'skill_id', 'skill_name'],
  dream_sessions: ['id', 'type', 'status', 'created_at'],
  skill_suggestions: ['id', 'dream_session_id', 'codespace_id', 'skill_id', 'status', 'created_at'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgreSQL Schema Static Analysis', () => {
  const allSql = readAllMigrationSql();
  const migrationFiles = readMigrationFiles();
  const journal = readJournal();
  const createdTables = extractCreateTables(allSql);
  const effectiveTables = computeEffectiveTables(allSql);
  const alterForeignKeys = extractAlterTableForeignKeys(allSql);
  const inlineForeignKeys = extractInlineForeignKeys(allSql);

  // -----------------------------------------------------------------------
  // 1. Migration files can be read and parsed
  // -----------------------------------------------------------------------
  describe('Migration files are readable', () => {
    it('should have at least one migration SQL file', () => {
      expect(migrationFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('should have non-empty SQL content', () => {
      expect(allSql.length).toBeGreaterThan(0);
    });

    it('each migration file should be valid UTF-8 and non-empty', () => {
      for (const file of migrationFiles) {
        const content = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
        expect(content.trim().length, `${file} should not be empty`).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 2. All expected tables exist in the migration chain
  // -----------------------------------------------------------------------
  describe('CREATE TABLE completeness', () => {
    it('should contain all expected CREATE TABLE statements', () => {
      for (const table of ALL_CREATED_TABLES) {
        expect(createdTables, `Missing CREATE TABLE for "${table}"`).toContain(table);
      }
    });

    it('should match the expected count of CREATE TABLE statements', () => {
      expect(createdTables.length).toBe(ALL_CREATED_TABLES.length);
    });

    it('should not have unexpected tables outside the known set', () => {
      for (const table of createdTables) {
        expect(
          ALL_CREATED_TABLES,
          `Unexpected table "${table}" found in migrations but not in expected list`
        ).toContain(table);
      }
    });

    it('effective tables (after renames) should match the Drizzle PG schema', () => {
      expect(effectiveTables).toEqual(EXPECTED_EFFECTIVE_TABLES);
    });

    it('should apply expected table renames', () => {
      const renames = extractTableRenames(allSql);
      const renameMap = new Map(renames.map((r) => [r.from, r.to]));
      expect(renameMap.get('projects')).toBe('codespaces');
      expect(renameMap.get('template_projects')).toBe('template_codespaces');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Critical columns exist in migration SQL
  // -----------------------------------------------------------------------
  describe('Critical columns', () => {
    for (const [table, expectedCols] of Object.entries(CRITICAL_COLUMNS)) {
      it(`"${table}" should have columns: ${expectedCols.join(', ')}`, () => {
        const actualCols = extractColumnsForTable(allSql, table);
        expect(
          actualCols.length,
          `Could not find CREATE TABLE block for "${table}"`
        ).toBeGreaterThan(0);
        for (const col of expectedCols) {
          expect(actualCols, `"${table}" is missing column "${col}"`).toContain(col);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // 4. Foreign key constraints reference valid tables
  // -----------------------------------------------------------------------
  describe('Foreign key constraints (ALTER TABLE)', () => {
    it('should have ALTER TABLE foreign key constraints defined', () => {
      expect(alterForeignKeys.length).toBeGreaterThan(0);
    });

    it('every ALTER TABLE FK source table should exist as created or renamed table', () => {
      for (const fk of alterForeignKeys) {
        expect(
          effectiveTables.includes(fk.sourceTable) || createdTables.includes(fk.sourceTable),
          `FK "${fk.constraintName}" references source table "${fk.sourceTable}" which does not exist`
        ).toBe(true);
      }
    });

    it('every ALTER TABLE FK target table should exist as created or renamed table', () => {
      for (const fk of alterForeignKeys) {
        expect(
          effectiveTables.includes(fk.targetTable) || createdTables.includes(fk.targetTable),
          `FK "${fk.constraintName}" references target table "${fk.targetTable}" which does not exist`
        ).toBe(true);
      }
    });

    it('FK target columns should be "id" or a known primary key', () => {
      for (const fk of alterForeignKeys) {
        expect(
          ['id', 'key'],
          `FK "${fk.constraintName}" targets column "${fk.targetColumn}" which is not a standard PK`
        ).toContain(fk.targetColumn);
      }
    });

    it('should have expected core FK relationships', () => {
      const fkPairs = alterForeignKeys.map(
        (fk) => `${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}`
      );

      // Core entity relationships (re-created in 0004 with codespace_id)
      expect(fkPairs).toContain('agent_runs.agent_id->agents');
      expect(fkPairs).toContain('agent_runs.task_id->tasks');
      expect(fkPairs).toContain('session_events.session_id->sessions');
      expect(fkPairs).toContain('tasks.agent_id->agents');
      expect(fkPairs).toContain('tasks.session_id->sessions');
      expect(fkPairs).toContain('tasks.worktree_id->worktrees');
      expect(fkPairs).toContain('worktrees.agent_id->agents');
      expect(fkPairs).toContain('worktrees.task_id->tasks');
      expect(fkPairs).toContain('audit_logs.agent_id->agents');
      expect(fkPairs).toContain('plan_sessions.task_id->tasks');
    });

    it('should have codespace FK relationships from catch-up migration', () => {
      const fkPairs = alterForeignKeys.map(
        (fk) => `${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}`
      );

      // From 0004: codespace_id -> codespaces relationships (after rename)
      expect(fkPairs).toContain('agents.codespace_id->codespaces');
      expect(fkPairs).toContain('tasks.codespace_id->codespaces');
      expect(fkPairs).toContain('sessions.codespace_id->codespaces');
      expect(fkPairs).toContain('worktrees.codespace_id->codespaces');
      expect(fkPairs).toContain('codespaces.project_folder_id->project_folders');
    });

    it('should define ON DELETE behavior for all ALTER TABLE FK statements', () => {
      const fkStatements = allSql.match(/ALTER\s+TABLE[^;]*FOREIGN\s+KEY[^;]*REFERENCES[^;]*/gi);
      expect(fkStatements).not.toBeNull();
      for (const stmt of fkStatements!) {
        expect(
          stmt.toLowerCase(),
          `FK statement missing ON DELETE clause:\n${stmt.slice(0, 120)}...`
        ).toMatch(/on delete (cascade|set null|no action|restrict|set default)/i);
      }
    });
  });

  describe('Foreign key constraints (inline REFERENCES)', () => {
    it('should have inline REFERENCES in CREATE TABLE definitions', () => {
      expect(inlineForeignKeys.length).toBeGreaterThan(0);
    });

    it('inline FK target tables should exist', () => {
      for (const fk of inlineForeignKeys) {
        expect(
          effectiveTables.includes(fk.targetTable) || createdTables.includes(fk.targetTable),
          `Inline FK in "${fk.sourceTable}.${fk.sourceColumn}" references non-existent table "${fk.targetTable}"`
        ).toBe(true);
      }
    });

    it('inline FK target columns should be "id" (standard PK)', () => {
      for (const fk of inlineForeignKeys) {
        expect(
          fk.targetColumn,
          `Inline FK "${fk.sourceTable}.${fk.sourceColumn}" targets non-PK column "${fk.targetColumn}"`
        ).toBe('id');
      }
    });

    it('should have inline FKs for new tables created in 0004', () => {
      const inlinePairs = inlineForeignKeys.map(
        (fk) => `${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}`
      );

      // user_sessions references users
      expect(inlinePairs).toContain('user_sessions.user_id->users');
      // team_members references teams and users
      expect(inlinePairs).toContain('team_members.team_id->teams');
      expect(inlinePairs).toContain('team_members.user_id->users');
      // team_invitations references teams
      expect(inlinePairs).toContain('team_invitations.team_id->teams');
      // codespace_members references users
      expect(inlinePairs).toContain('codespace_members.user_id->users');
      // tags references project_folders
      expect(inlinePairs).toContain('tags.project_folder_id->project_folders');
      // event_sources references teams
      expect(inlinePairs).toContain('event_sources.team_id->teams');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Migration journal consistency
  // -----------------------------------------------------------------------
  describe('Migration journal', () => {
    it('journal file should exist and be valid JSON', () => {
      expect(journal).toBeDefined();
      expect(journal.version).toBeDefined();
      expect(journal.dialect).toBe('postgresql');
    });

    it('journal should have entries for all migration SQL files', () => {
      const journalTags = journal.entries.map((e) => e.tag);
      for (const file of migrationFiles) {
        const tag = file.replace('.sql', '');
        expect(
          journalTags,
          `Migration file "${file}" has no corresponding journal entry`
        ).toContain(tag);
      }
    });

    it('all journal entries should have corresponding SQL files', () => {
      const fileNames = new Set(migrationFiles.map((f) => f.replace('.sql', '')));
      for (const entry of journal.entries) {
        expect(
          fileNames.has(entry.tag),
          `Journal entry "${entry.tag}" has no corresponding SQL file`
        ).toBe(true);
      }
    });

    it('journal entries should have sequential indices', () => {
      for (let i = 0; i < journal.entries.length; i++) {
        expect(journal.entries[i].idx, `Entry at position ${i} has wrong idx`).toBe(i);
      }
    });

    it('journal entries should have monotonically increasing timestamps', () => {
      for (let i = 1; i < journal.entries.length; i++) {
        expect(
          journal.entries[i].when,
          `Entry ${i} timestamp should be after entry ${i - 1}`
        ).toBeGreaterThan(journal.entries[i - 1].when);
      }
    });

    it('journal entry count should match migration file count', () => {
      expect(journal.entries.length).toBe(migrationFiles.length);
    });

    it('all journal entries should use breakpoints', () => {
      for (const entry of journal.entries) {
        expect(entry.breakpoints, `Entry "${entry.tag}" should use breakpoints`).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 6. ALTER TABLE mutations in subsequent migrations
  // -----------------------------------------------------------------------
  describe('Subsequent migration mutations', () => {
    it('migration 0001 should alter cli_sessions columns to bigint', () => {
      const sql0001 = readFileSync(resolve(MIGRATIONS_DIR, '0001_overconfident_raza.sql'), 'utf8');
      expect(sql0001).toMatch(/ALTER\s+TABLE\s+"cli_sessions"/i);
      expect(sql0001).toMatch(/started_at.*bigint/i);
      expect(sql0001).toMatch(/last_activity_at.*bigint/i);
    });

    it('migration 0002 should alter session_events timestamp to bigint', () => {
      const sql0002 = readFileSync(resolve(MIGRATIONS_DIR, '0002_amused_talon.sql'), 'utf8');
      expect(sql0002).toMatch(/ALTER\s+TABLE\s+"session_events"/i);
      expect(sql0002).toMatch(/timestamp.*bigint/i);
    });

    it('migration 0003 should add nomad columns to sandbox_configs', () => {
      const sql0003 = readFileSync(resolve(MIGRATIONS_DIR, '0003_nomad_columns.sql'), 'utf8');
      expect(sql0003).toMatch(/ALTER\s+TABLE\s+"sandbox_configs"/i);
      const expectedCols = [
        'nomad_address',
        'nomad_token',
        'nomad_namespace',
        'nomad_datacenter',
        'nomad_region',
      ];
      for (const col of expectedCols) {
        expect(sql0003, `Missing nomad column "${col}"`).toContain(col);
      }
    });

    it('migration 0004 should rename projects to codespaces', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      expect(sql0004).toMatch(/ALTER\s+TABLE\s+"projects"\s+RENAME\s+TO\s+"codespaces"/i);
    });

    it('migration 0004 should rename template_projects to template_codespaces', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      expect(sql0004).toMatch(
        /ALTER\s+TABLE\s+"template_projects"\s+RENAME\s+TO\s+"template_codespaces"/i
      );
    });

    it('migration 0004 should rename project_id columns to codespace_id', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      // These tables had project_id renamed to codespace_id
      const tablesWithRenamedColumn = [
        'agent_runs',
        'agents',
        'audit_logs',
        'plan_sessions',
        'sandbox_instances',
        'sessions',
        'tasks',
        'worktrees',
      ];
      for (const table of tablesWithRenamedColumn) {
        expect(sql0004, `Missing column rename for "${table}.project_id"`).toMatch(
          new RegExp(
            `ALTER\\s+TABLE\\s+"${table}"\\s+RENAME\\s+COLUMN\\s+"project_id"\\s+TO\\s+"codespace_id"`,
            'i'
          )
        );
      }
    });

    it('migration 0004 should create all new tables', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      const newTables = [
        'users',
        'teams',
        'project_folders',
        'user_sessions',
        'team_members',
        'team_invitations',
        'team_project_folders',
        'folder_members',
        'codespace_members',
        'api_tokens',
        'tags',
        'codespace_tags',
        'task_tags',
        'event_sources',
        'event_subscriptions',
        'event_log',
        'schedule_executions',
        'memory_insights',
        'memory_messages',
        'skill_executions',
        'skill_metrics',
        'dream_sessions',
        'skill_suggestions',
      ];
      for (const table of newTables) {
        expect(sql0004, `Migration 0004 should create table "${table}"`).toMatch(
          new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"${table}"`, 'i')
        );
      }
    });

    it('migration 0004 should add new columns to existing tables', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      // Spot-check new columns added to existing tables
      expect(sql0004).toContain('skill_id');
      expect(sql0004).toContain('skill_name');
      expect(sql0004).toContain('parent_agent_id');
      expect(sql0004).toContain('sandbox_provider');
      expect(sql0004).toContain('sandbox_container_id');
      expect(sql0004).toContain('cost_usd');
      expect(sql0004).toContain('stop_reason');
    });

    it('migration 0004 should be wrapped in a transaction', () => {
      const sql0004 = readFileSync(resolve(MIGRATIONS_DIR, '0004_schema_catchup.sql'), 'utf8');
      // The file starts with comment lines, then BEGIN
      expect(sql0004).toMatch(/\bBEGIN\b/);
      expect(sql0004.trim()).toMatch(/COMMIT;\s*$/);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Snapshot files exist for completed migrations
  // -----------------------------------------------------------------------
  describe('Snapshot files', () => {
    it('meta directory should contain snapshot files', () => {
      const metaFiles = readdirSync(META_DIR).filter((f) => f.endsWith('_snapshot.json'));
      expect(metaFiles.length).toBeGreaterThan(0);
    });

    it('snapshot files should be valid JSON', () => {
      const metaFiles = readdirSync(META_DIR).filter((f) => f.endsWith('_snapshot.json'));
      for (const file of metaFiles) {
        const content = readFileSync(resolve(META_DIR, file), 'utf8');
        expect(() => JSON.parse(content), `Snapshot ${file} is not valid JSON`).not.toThrow();
      }
    });

    it('latest snapshot should contain tables from the initial migration', () => {
      const metaFiles = readdirSync(META_DIR)
        .filter((f) => f.endsWith('_snapshot.json'))
        .sort();
      const latestSnapshot = JSON.parse(
        readFileSync(resolve(META_DIR, metaFiles[metaFiles.length - 1]), 'utf8')
      );
      const snapshotTables = Object.keys(latestSnapshot.tables || {}).map((t) =>
        t.replace('public.', '')
      );

      // The latest snapshot (0002) captures state after 0000-0002.
      // Tables from 0000 should all be present.
      const initialTables = [
        'agent_runs',
        'agents',
        'api_keys',
        'audit_logs',
        'cli_sessions',
        'github_installations',
        'github_tokens',
        'marketplaces',
        'plan_sessions',
        'projects',
        'repository_configs',
        'sandbox_configs',
        'sandbox_instances',
        'sandbox_tmux_sessions',
        'session_events',
        'session_summaries',
        'sessions',
        'settings',
        'tasks',
        'template_projects',
        'templates',
        'terraform_modules',
        'terraform_registries',
        'workflows',
        'worktrees',
      ];

      for (const table of initialTables) {
        expect(snapshotTables, `Latest snapshot missing table "${table}"`).toContain(table);
      }
    });
  });
});
