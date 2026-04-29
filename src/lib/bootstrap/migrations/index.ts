import {
  CLI_SESSIONS_MIGRATION_SQL,
  CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL,
  DB_REVIEW_INDEXES_MIGRATION_SQL,
  EVENT_SYSTEM_MIGRATION_SQL,
  MEMORY_TABLES_MIGRATION_SQL,
  MIGRATION_SQL,
  PERFORMANCE_INDEXES_MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
  RBAC_SCHEMA_ADDITIONS,
  SANDBOX_CONTAINER_ID_MIGRATION_SQL,
  SANDBOX_MIGRATION_SQL,
  SCHEDULE_EXECUTIONS_MIGRATION_SQL,
  TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL,
  TERRAFORM_MIGRATION_SQL,
} from '../phases/schema.js';
import {
  PROJECT_FOLDERS_ALTER_STATEMENTS,
  PROJECT_FOLDERS_MIGRATION_SQL,
} from './v19-project-folders.js';

/**
 * A single migration step in the ordered migration sequence.
 *
 * Exactly one of `sql` or `statements` must be provided:
 * - `sql`: SQL string to execute via db.exec() (multi-statement blocks)
 * - `statements`: Array of individual SQL strings, each executed separately
 *                 with try/catch for ALTER TABLE idempotency
 */
interface MigrationBase {
  version: number;
  name: string;
}

export type Migration =
  | (MigrationBase & { sql: string; statements?: never })
  | (MigrationBase & { statements: string[]; sql?: never });

/**
 * Ordered list of all SQLite migrations.
 *
 * IMPORTANT: Only append to this array. Never reorder or remove entries.
 * The version numbers must be strictly increasing.
 */
export const MIGRATIONS: Migration[] = [
  // 1. Base schema — all core tables
  { version: 1, name: 'base-schema', sql: MIGRATION_SQL },

  // 2. Add sandbox_config_id to projects
  { version: 2, name: 'sandbox-config-column', sql: SANDBOX_MIGRATION_SQL },

  // 3. Add sandbox_container_id to sessions
  { version: 3, name: 'sandbox-container-id', sql: SANDBOX_CONTAINER_ID_MIGRATION_SQL },

  // 4. Template sync interval columns
  { version: 4, name: 'template-sync-interval', sql: TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL },

  // 5. Performance indexes (idempotent — IF NOT EXISTS)
  { version: 5, name: 'performance-indexes', sql: PERFORMANCE_INDEXES_MIGRATION_SQL },

  // 6. CLI sessions table
  { version: 6, name: 'cli-sessions', sql: CLI_SESSIONS_MIGRATION_SQL },

  // 7. CLI sessions performance_metrics column
  { version: 7, name: 'cli-sessions-perf-metrics', sql: CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL },

  // 8. Terraform tables
  { version: 8, name: 'terraform-tables', sql: TERRAFORM_MIGRATION_SQL },

  // 9. RBAC tables
  { version: 9, name: 'rbac-tables', sql: RBAC_MIGRATION_SQL },

  // 10. RBAC schema additions (individual ALTER TABLEs)
  { version: 10, name: 'rbac-schema-additions', statements: [...RBAC_SCHEMA_ADDITIONS] },

  // 11. GitHub tokens team_id column
  { version: 11, name: 'github-tokens-team-id', sql: RBAC_GITHUB_TOKEN_MIGRATION_SQL },

  // 12. Index on github_tokens(team_id) — must follow version 11
  {
    version: 12,
    name: 'github-tokens-team-index',
    sql: 'CREATE INDEX IF NOT EXISTS idx_github_tokens_team ON github_tokens(team_id)',
  },

  // 13. Nomad sandbox columns
  {
    version: 13,
    name: 'sandbox-nomad-columns',
    statements: [
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_address TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_token TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_namespace TEXT DEFAULT 'default'`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_datacenter TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_region TEXT`,
    ],
  },

  // 14. AgentCore sandbox columns — REMOVED (arch29-W2-D, F04-04 / F04-05).
  //     The AgentCore feature has been deleted from the codebase. The columns
  //     were added by Drizzle migration 0010 and dropped by 0011. Existing
  //     databases that ran the old version-14 step retain the dropped columns;
  //     fresh installs never receive them. Kept as a tombstone (no-op) to
  //     preserve sequential version numbering.
  {
    version: 14,
    name: 'sandbox-agentcore-columns-removed',
    statements: [],
  },

  // 15. Agents parent_agent_id column
  {
    version: 15,
    name: 'agents-parent-agent-id',
    sql: `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;`,
  },

  // 16. Event system tables (idempotent — IF NOT EXISTS)
  { version: 16, name: 'event-system', sql: EVENT_SYSTEM_MIGRATION_SQL },

  // 17. Schedule executions table (idempotent — IF NOT EXISTS)
  { version: 17, name: 'schedule-executions', sql: SCHEDULE_EXECUTIONS_MIGRATION_SQL },

  // 18. DB review indexes — remove redundant index, add missing indexes (DB-008, DB-009)
  { version: 18, name: 'db-review-indexes', sql: DB_REVIEW_INDEXES_MIGRATION_SQL },

  // 19. Project folders tenancy model + project→codespace rename (tables + data migration)
  { version: 19, name: 'project-folders-and-codespace-rename', sql: PROJECT_FOLDERS_MIGRATION_SQL },

  // 20. Project folders — FK column renames via ALTER TABLE (individual statements for idempotency)
  {
    version: 20,
    name: 'project-folders-alter-columns',
    statements: [...PROJECT_FOLDERS_ALTER_STATEMENTS],
  },

  // 21. Add skill_id and skill_name columns to tasks table
  {
    version: 21,
    name: 'task-skill-columns',
    statements: [
      `ALTER TABLE tasks ADD COLUMN skill_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN skill_name TEXT`,
    ],
  },

  // 22. Memory service tables (insights, messages, skill tracking, dreaming)
  { version: 22, name: 'memory-tables', sql: MEMORY_TABLES_MIGRATION_SQL },

  // 23. GitHub App columns: teamId on installations, githubInstallationId on event_sources
  {
    version: 23,
    name: 'github-app-columns',
    statements: [
      `ALTER TABLE github_installations ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL`,
      `ALTER TABLE event_sources ADD COLUMN github_installation_id TEXT REFERENCES github_installations(id) ON DELETE SET NULL`,
    ],
  },

  // 24. Fix missing onDelete on codespaces.sandboxConfigId — recreate FK with SET NULL
  // SQLite does not support ALTER TABLE ... ALTER CONSTRAINT, so this is a schema-level fix
  // that takes effect on new databases. Existing databases will continue to work (the FK
  // constraint just defaults to NO ACTION). The Drizzle schema now specifies onDelete: 'set null'.
  {
    version: 24,
    name: 'sandbox-config-fk-on-delete',
    sql: `-- Schema-level fix: onDelete 'set null' is now defined in Drizzle schema.
-- For existing databases, the FK behavior defaults to NO ACTION which is safe.
-- A full table rebuild would be needed to change FK behavior in SQLite,
-- which is not worth the risk for an existing production database.
SELECT 1;`,
  },

  // 25. Add CHECK constraints for critical enum columns on new databases.
  // Uses CREATE TABLE IF NOT EXISTS with CHECK constraints for validation tables,
  // then creates triggers to validate enum values on INSERT/UPDATE.
  {
    version: 25,
    name: 'enum-check-triggers',
    sql: `
-- Trigger-based enum validation for critical columns.
-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so we use BEFORE triggers.

-- tasks.column validation
CREATE TRIGGER IF NOT EXISTS trg_tasks_column_insert
BEFORE INSERT ON tasks
WHEN NEW."column" NOT IN ('backlog', 'queued', 'in_progress', 'waiting_approval', 'verified')
BEGIN
  SELECT RAISE(ABORT, 'Invalid task column value');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_column_update
BEFORE UPDATE OF "column" ON tasks
WHEN NEW."column" NOT IN ('backlog', 'queued', 'in_progress', 'waiting_approval', 'verified')
BEGIN
  SELECT RAISE(ABORT, 'Invalid task column value');
END;

-- agents.status validation
CREATE TRIGGER IF NOT EXISTS trg_agents_status_insert
BEFORE INSERT ON agents
WHEN NEW.status NOT IN ('idle', 'starting', 'planning', 'running', 'paused', 'error', 'completed')
BEGIN
  SELECT RAISE(ABORT, 'Invalid agent status value');
END;

CREATE TRIGGER IF NOT EXISTS trg_agents_status_update
BEFORE UPDATE OF status ON agents
WHEN NEW.status NOT IN ('idle', 'starting', 'planning', 'running', 'paused', 'error', 'completed')
BEGIN
  SELECT RAISE(ABORT, 'Invalid agent status value');
END;

-- worktrees.status validation
CREATE TRIGGER IF NOT EXISTS trg_worktrees_status_insert
BEFORE INSERT ON worktrees
WHEN NEW.status NOT IN ('creating', 'active', 'merging', 'removing', 'removed', 'error')
BEGIN
  SELECT RAISE(ABORT, 'Invalid worktree status value');
END;

CREATE TRIGGER IF NOT EXISTS trg_worktrees_status_update
BEFORE UPDATE OF status ON worktrees
WHEN NEW.status NOT IN ('creating', 'active', 'merging', 'removing', 'removed', 'error')
BEGIN
  SELECT RAISE(ABORT, 'Invalid worktree status value');
END;

-- agents.type validation
CREATE TRIGGER IF NOT EXISTS trg_agents_type_insert
BEFORE INSERT ON agents
WHEN NEW.type NOT IN ('task', 'conversational', 'background')
BEGIN
  SELECT RAISE(ABORT, 'Invalid agent type value');
END;

CREATE TRIGGER IF NOT EXISTS trg_agents_type_update
BEFORE UPDATE OF type ON agents
WHEN NEW.type NOT IN ('task', 'conversational', 'background')
BEGIN
  SELECT RAISE(ABORT, 'Invalid agent type value');
END;

-- tasks.priority validation (nullable, so allow NULL)
CREATE TRIGGER IF NOT EXISTS trg_tasks_priority_insert
BEFORE INSERT ON tasks
WHEN NEW.priority IS NOT NULL AND NEW.priority NOT IN ('high', 'medium', 'low')
BEGIN
  SELECT RAISE(ABORT, 'Invalid task priority value');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_priority_update
BEFORE UPDATE OF priority ON tasks
WHEN NEW.priority IS NOT NULL AND NEW.priority NOT IN ('high', 'medium', 'low')
BEGIN
  SELECT RAISE(ABORT, 'Invalid task priority value');
END;
`,
  },

  // v26 intentionally skipped — some deployed databases already applied v26 as an earlier
  // iteration of enum-check-triggers (now consolidated into v25). Reusing v26 would cause
  // those databases to skip this migration silently. Using v27 ensures it runs everywhere.

  // 27. Memory insight status, category, updated_at columns + skill_executions insight tracking
  {
    version: 27,
    name: 'memory-insight-status-category',
    statements: [
      `ALTER TABLE memory_insights ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE memory_insights ADD COLUMN category TEXT`,
      `ALTER TABLE memory_insights ADD COLUMN updated_at TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_memory_insights_status ON memory_insights(status)`,
      `ALTER TABLE skill_executions ADD COLUMN insight_ids_used TEXT`,
    ],
  },

  // 28. Memory insight effectiveness score column
  {
    version: 28,
    name: 'memory-insight-effectiveness-score',
    statements: [`ALTER TABLE memory_insights ADD COLUMN effectiveness_score REAL`],
  },

  // 29. Rebuild agents table to match current Drizzle schema
  // Old schema had: model, max_turns, permission_mode, system_prompt, etc.
  // New schema has: type, config (JSON), simplified columns
  {
    version: 29,
    name: 'agents-schema-rebuild',
    statements: [
      // Null out orphaned FK references before rebuild to prevent FK violations
      `UPDATE agents SET current_task_id = NULL WHERE current_task_id IS NOT NULL AND current_task_id NOT IN (SELECT id FROM tasks)`,
      `UPDATE agents SET current_session_id = NULL WHERE current_session_id IS NOT NULL AND current_session_id NOT IN (SELECT id FROM sessions)`,
      `CREATE TABLE IF NOT EXISTS agents_new (
        id TEXT PRIMARY KEY NOT NULL,
        codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'task' NOT NULL,
        status TEXT DEFAULT 'idle' NOT NULL,
        config TEXT,
        current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        current_turn INTEGER DEFAULT 0,
        parent_agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now')) NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')) NOT NULL
      )`,
      `INSERT OR IGNORE INTO agents_new (id, codespace_id, name, type, status, current_task_id, current_session_id, current_turn, created_at, updated_at)
        SELECT id, codespace_id, name, 'task', status, current_task_id, current_session_id, 0, created_at, updated_at
        FROM agents`,
      `DROP TABLE agents`,
      `ALTER TABLE agents_new RENAME TO agents`,
      `CREATE INDEX IF NOT EXISTS idx_agents_codespace_id ON agents(codespace_id)`,
    ],
  },

  // 30. Rebuild sessions table to match current Drizzle schema
  // Old schema had: sdk_session_id, started_at, ended_at, total_input_tokens, etc.
  // New schema has: title, url, sandbox_provider, sandbox_container_id, status default 'idle'
  {
    version: 30,
    name: 'sessions-schema-rebuild',
    statements: [
      // Null out orphaned FK references before rebuild to prevent FK violations
      `UPDATE sessions SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks)`,
      `UPDATE sessions SET agent_id = NULL WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents)`,
      `CREATE TABLE IF NOT EXISTS sessions_new (
        id TEXT PRIMARY KEY NOT NULL,
        codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        status TEXT DEFAULT 'idle' NOT NULL,
        title TEXT,
        url TEXT NOT NULL DEFAULT '',
        sandbox_provider TEXT,
        sandbox_container_id TEXT,
        created_at TEXT DEFAULT (datetime('now')) NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')) NOT NULL,
        closed_at TEXT
      )`,
      `INSERT OR IGNORE INTO sessions_new (id, codespace_id, task_id, agent_id, status, created_at, updated_at)
        SELECT id, codespace_id, task_id, agent_id,
          CASE WHEN status = 'active' THEN 'active' WHEN status = 'closed' THEN 'closed' ELSE 'idle' END,
          created_at, updated_at
        FROM sessions WHERE codespace_id IS NOT NULL`,
      `DROP TABLE sessions`,
      `ALTER TABLE sessions_new RENAME TO sessions`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_codespace_id ON sessions(codespace_id)`,
    ],
  },

  // 31. Add execution skill columns for skill chaining (plan → implement)
  {
    version: 31,
    name: 'task-execution-skill-columns',
    statements: [
      `ALTER TABLE tasks ADD COLUMN execution_skill_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN execution_skill_name TEXT`,
    ],
  },

  // 32. Event outbox for transactional durable-streams publishes (F05-05)
  {
    version: 32,
    name: 'event-outbox',
    sql: `
CREATE TABLE IF NOT EXISTS event_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS event_outbox_status_idx ON event_outbox(status);
CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_at_idx ON event_outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_idx ON event_outbox(status, next_attempt_at);
`,
  },

  // 33. Sandbox UNIQUE lifecycle fix (F04-08, arch29-W2-E):
  // Rebuild sandbox_instances so the global UNIQUE on codespace_id is replaced
  // by a partial unique index that fires only while the sandbox is in an
  // *active* state. This unblocks the natural stop -> create lifecycle:
  // before this fix, calling SandboxService.create() for a codespace whose
  // previous sandbox row had moved to 'stopped' threw SQLITE_CONSTRAINT_UNIQUE.
  //
  // SQLite cannot drop a column-level UNIQUE constraint in place (the
  // automatic sqlite_autoindex_* cannot be dropped), so we rebuild the
  // table. The migration is idempotent on fresh installs (the table is
  // created in step 1 with the new shape, then the rebuild is a no-op
  // copy of zero rows).
  {
    version: 33,
    name: 'sandbox-unique-partial-index',
    sql: `
-- Step 1: ensure the target table exists. On fresh installs, this is the
-- only statement that meaningfully runs (the rest become no-ops because
-- the rebuild pivot copies zero rows).
CREATE TABLE IF NOT EXISTS sandbox_instances (
  id TEXT PRIMARY KEY NOT NULL,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  status TEXT DEFAULT 'stopped' NOT NULL,
  image TEXT NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpu_cores INTEGER NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL,
  volume_mounts TEXT DEFAULT '[]',
  env TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
  stopped_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Step 2: rebuild without the column-level UNIQUE on codespace_id.
-- Existing databases that already have the OLD shape (column-level UNIQUE)
-- get the new shape too. Drop any leftover staging table from a prior
-- partial run to keep this idempotent.
DROP TABLE IF EXISTS sandbox_instances_new_v33;

CREATE TABLE sandbox_instances_new_v33 (
  id TEXT PRIMARY KEY NOT NULL,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  status TEXT DEFAULT 'stopped' NOT NULL,
  image TEXT NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpu_cores INTEGER NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL,
  volume_mounts TEXT DEFAULT '[]',
  env TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
  stopped_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Step 3: copy rows. Per CLAUDE.md "Migration safety": pre-filter rows
-- whose codespace_id no longer points to a real codespace so the FK in
-- the new table doesn't fail. INSERT OR IGNORE is belt-and-suspenders for
-- duplicate-PK skips on retries.
INSERT OR IGNORE INTO sandbox_instances_new_v33 (
  id, codespace_id, container_id, status, image, memory_mb, cpu_cores,
  idle_timeout_minutes, volume_mounts, env, error_message,
  created_at, last_activity_at, stopped_at, updated_at
)
SELECT
  id, codespace_id, container_id, status, image, memory_mb, cpu_cores,
  idle_timeout_minutes, volume_mounts, env, error_message,
  created_at, last_activity_at, stopped_at, updated_at
FROM sandbox_instances
WHERE codespace_id IS NOT NULL
  AND codespace_id IN (SELECT id FROM codespaces);

-- Step 4: pivot the table.
DROP TABLE sandbox_instances;
ALTER TABLE sandbox_instances_new_v33 RENAME TO sandbox_instances;

-- Step 5: install the partial unique index. Only one active sandbox per
-- codespace at a time; stopped/error rows can coexist freely so the
-- create-after-stop lifecycle works.
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_instances_codespace_active_unique
  ON sandbox_instances(codespace_id)
  WHERE status IN ('creating', 'running', 'idle', 'stopping');

-- Step 6: supporting index for status-filtered queries (reconciliation
-- phase reads by status).
CREATE INDEX IF NOT EXISTS sandbox_instances_status_idx ON sandbox_instances(status);
`,
  },
];
