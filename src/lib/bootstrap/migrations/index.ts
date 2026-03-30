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

  // 14. AgentCore sandbox columns
  {
    version: 14,
    name: 'sandbox-agentcore-columns',
    statements: [
      `ALTER TABLE sandbox_configs ADD COLUMN aws_access_key_id TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN aws_secret_access_key TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN aws_region TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN agentcore_runtime_arn TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN ecr_repository_uri TEXT`,
    ],
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
];
