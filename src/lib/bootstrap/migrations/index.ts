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

  // 34. F05-25: stream_kind discriminator on session_events.
  // Adds the column nullable, backfills from streamId prefix, then rebuilds the
  // table to enforce NOT NULL + CHECK so the discriminator is binding for new
  // writers. Adds an index to support stream-kind-scoped scans.
  {
    version: 34,
    name: 'session-events-stream-kind',
    sql: `
ALTER TABLE session_events ADD COLUMN stream_kind TEXT;

UPDATE session_events
SET stream_kind = CASE
  WHEN session_id = 'cli-monitor' THEN 'cli-monitor'
  WHEN session_id LIKE 'plan:%' THEN 'plan'
  WHEN session_id LIKE 'sandbox:%' THEN 'sandbox'
  WHEN session_id LIKE 'terraform:%' THEN 'terraform'
  WHEN session_id LIKE 'topology:%' THEN 'topology'
  ELSE 'session'
END
WHERE stream_kind IS NULL;

CREATE TABLE session_events_new (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  stream_kind TEXT NOT NULL CHECK (stream_kind IN ('session','plan','sandbox','terraform','topology','cli-monitor')),
  "offset" INTEGER NOT NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO session_events_new (id, session_id, stream_kind, "offset", type, channel, data, timestamp, user_id, created_at)
SELECT id, session_id, stream_kind, "offset", type, channel, data, timestamp, user_id, created_at FROM session_events;

DROP TABLE session_events;
ALTER TABLE session_events_new RENAME TO session_events;

CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS session_events_unique_offset ON session_events(session_id, "offset");
CREATE INDEX IF NOT EXISTS session_events_created_at_idx ON session_events(created_at);
CREATE INDEX IF NOT EXISTS session_events_session_type_idx ON session_events(session_id, type);
CREATE INDEX IF NOT EXISTS session_events_stream_kind_session_idx ON session_events(stream_kind, session_id);
`,
  },

  // 35. F06-NEW-08: persist rate-limit counters across restarts.
  // Each row is a single bucket: (key, window_start, count). Composite primary
  // key on (key, window_start) lets concurrent inserts dedupe via INSERT ...
  // ON CONFLICT DO UPDATE. Cleanup of expired buckets older than 24h runs as
  // a BackgroundJob.
  {
    version: 35,
    name: 'rate-limit-buckets',
    sql: `
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx ON rate_limit_buckets(updated_at);
`,
  },

  // 36. F02-18 (arch29-W2-R): event_outbox timestamps as epoch ms.
  //
  // Convert `next_attempt_at` / `created_at` / `published_at` from TEXT (ISO
  // string) to INTEGER (epoch ms) so the relay's `lte(nextAttemptAt, now)`
  // comparison is numeric on both SQLite and Postgres. The previous lex-string
  // ordering only worked for UTC ISO timestamps and was brittle across
  // dialects.
  //
  // The migration uses the established v29/v30/v33 table-rebuild pattern:
  // SQLite cannot ALTER COLUMN type in place, so we create a staging table,
  // copy existing rows with `strftime('%s', ...) * 1000` to convert ISO text
  // to epoch ms, drop the original, and rename the staging table. Indexes
  // are recreated post-rename.
  //
  // Idempotency: leftover staging tables from a partial prior run are dropped
  // first. On a fresh install the original `event_outbox` table was created
  // by v32 with TEXT timestamps; this rebuild converts those to INTEGER.
  // Schema-drift parity with the Drizzle declaration (now `integer` in both
  // dialects) is verified by `tests/integration/event-outbox-schema-drift.test.ts`.
  {
    version: 36,
    name: 'event-outbox-epoch-ms',
    sql: `
-- Step 1: Drop any leftover staging table from a partial prior run.
DROP TABLE IF EXISTS event_outbox_new_v36;

-- Step 2: Create the rebuilt table with INTEGER epoch-ms timestamps.
CREATE TABLE event_outbox_new_v36 (
  id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

-- Step 3: Copy rows, converting ISO-text timestamps to epoch ms.
-- strftime('%s', text) returns seconds since epoch; multiply by 1000 for ms.
-- For NULL published_at, preserve NULL via a CASE.
INSERT INTO event_outbox_new_v36 (
  id, stream_id, type, payload, status, attempts,
  next_attempt_at, last_error, created_at, published_at
)
SELECT
  id, stream_id, type, payload, status, attempts,
  CAST(strftime('%s', next_attempt_at) AS INTEGER) * 1000,
  last_error,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CASE
    WHEN published_at IS NULL THEN NULL
    ELSE CAST(strftime('%s', published_at) AS INTEGER) * 1000
  END
FROM event_outbox;

-- Step 4: Pivot the table.
DROP TABLE event_outbox;
ALTER TABLE event_outbox_new_v36 RENAME TO event_outbox;

-- Step 5: Recreate the supporting indexes.
CREATE INDEX IF NOT EXISTS event_outbox_status_idx ON event_outbox(status);
CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_at_idx ON event_outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_idx ON event_outbox(status, next_attempt_at);
`,
  },

  // 37. F06-09 follow-up (arch29-W2-Q): backfill token rotation columns into the
  // runtime migration chain. The drizzle-kit migration `0017_add_token_rotation_columns.sql`
  // declares these but no inline runtime migration applied them, so the runtime
  // schema differed from the drizzle-kit baseline. The v39 api_tokens rebuild
  // below references `rotated_at`, so this must run first.
  //
  // Idempotent: ALTER TABLE ADD COLUMN is wrapped per-statement; the runner
  // catches "duplicate column" errors and proceeds.
  {
    version: 37,
    name: 'token-rotation-columns',
    statements: [
      `ALTER TABLE api_tokens ADD COLUMN rotated_at TEXT`,
      `ALTER TABLE api_keys ADD COLUMN expires_at TEXT`,
      `ALTER TABLE api_keys ADD COLUMN rotated_at TEXT`,
      `ALTER TABLE github_tokens ADD COLUMN expires_at TEXT`,
      `ALTER TABLE github_tokens ADD COLUMN rotated_at TEXT`,
    ],
  },

  // 38. F02-19 (arch29-W2-Q): codespace_tags.assigned_at missing in SQLite.
  //
  // Drizzle declares `assigned_at` notNull() (`src/db/schema/sqlite/codespace-tags.ts:15`)
  // but the v19 inline migration creates the table without the column
  // (`v19-project-folders.ts:84-88`). On SQLite, INSERTs succeed because Drizzle
  // supplies a JS-side default, but SELECTs return undefined while the type
  // system claims string. PG already has the column in `0004_schema_catchup.sql`.
  //
  // Fix: add the column with the same default as Drizzle declares. Existing
  // rows get the current time as their assigned_at (the column default applies
  // to NULL backfills via SQLite's ALTER TABLE ADD COLUMN ... DEFAULT semantics).
  // Use individual `statements` so the migration is idempotent — retry-safe if
  // a prior run partially succeeded.
  {
    version: 38,
    name: 'codespace-tags-assigned-at',
    statements: [
      `ALTER TABLE codespace_tags ADD COLUMN assigned_at TEXT NOT NULL DEFAULT (datetime('now'))`,
    ],
  },

  // 39. F02-20 (arch29-W2-Q): rebuild api_tokens to fix scope_codespace_id FK behavior.
  //
  // The v19 inline migration added `scope_codespace_id` with `ON DELETE CASCADE`
  // (`v19-project-folders.ts:149`), but Drizzle declares `onDelete: 'set null'`
  // (`src/db/schema/sqlite/api-tokens.ts:25`) and PG matches Drizzle. The result:
  // deleting a codespace silently revokes API tokens on SQLite while preserving
  // them on PG. Operationally surprising and silently divergent.
  //
  // SQLite cannot ALTER a foreign-key constraint in place, so the fix is the
  // v29/v30 table-rebuild pattern. Per CLAUDE.md "Migration safety": null any
  // orphaned scope_codespace_id values before the rebuild so the new FK
  // doesn't fail. INSERT (no OR IGNORE — F02-22) copies all rows.
  {
    version: 39,
    name: 'api-tokens-cascade-fix',
    sql: `
-- Step 1: drop any leftover staging table from a partial prior run.
DROP TABLE IF EXISTS api_tokens_new_v39;

-- Step 2: create the rebuilt table with the correct FK behavior.
CREATE TABLE api_tokens_new_v39 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  role TEXT NOT NULL,
  scope_tags TEXT,
  scope_project_id TEXT,
  scope_codespace_id TEXT REFERENCES codespaces(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  rotated_at TEXT,
  use_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Step 3: copy rows. Pre-null orphaned scope_codespace_id values (rows where
-- the codespace no longer exists) so the new FK doesn't fail on rebuild.
INSERT INTO api_tokens_new_v39 (
  id, user_id, team_id, name, token_hash, token_prefix, role,
  scope_tags, scope_project_id, scope_codespace_id,
  status, expires_at, rotated_at, use_count, last_used_at, revoked_at, created_at
)
SELECT
  id, user_id, team_id, name, token_hash, token_prefix, role,
  scope_tags, scope_project_id,
  CASE WHEN scope_codespace_id IS NOT NULL
       AND scope_codespace_id IN (SELECT id FROM codespaces)
    THEN scope_codespace_id
    ELSE NULL
  END,
  status, expires_at, rotated_at, use_count, last_used_at, revoked_at, created_at
FROM api_tokens;

-- Step 4: pivot the table.
DROP TABLE api_tokens;
ALTER TABLE api_tokens_new_v39 RENAME TO api_tokens;

-- Step 5: recreate the supporting indexes that lived on the original table.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_team ON api_tokens(team_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_status ON api_tokens(status);
`,
  },

  // 40. MAY-14: backfill legacy plan_sessions columns.
  //
  // The v19 project-folder migration can create a compatibility stub with
  // only the legacy identifiers and timestamps. Current Drizzle declares
  // turns, GitHub issue linkage, and completed_at; add those columns so
  // upgraded SQLite databases match the runtime schema.
  //
  // Some databases were upgraded past v20 before the v19 stub-creation was
  // added, so plan_sessions may be missing entirely. Create the legacy
  // shape first if absent — the subsequent ALTERs then succeed (or no-op
  // via duplicate-column suppression in the runner).
  {
    version: 40,
    name: 'plan-sessions-column-catchup',
    statements: [
      `CREATE TABLE IF NOT EXISTS plan_sessions (
        id TEXT PRIMARY KEY,
        codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE,
        project_id TEXT,
        task_id TEXT,
        session_id TEXT,
        status TEXT DEFAULT 'active' NOT NULL,
        created_at TEXT DEFAULT (datetime('now')) NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')) NOT NULL
      )`,
      `ALTER TABLE plan_sessions ADD COLUMN turns TEXT DEFAULT '[]'`,
      `ALTER TABLE plan_sessions ADD COLUMN github_issue_url TEXT`,
      `ALTER TABLE plan_sessions ADD COLUMN github_issue_number INTEGER`,
      `ALTER TABLE plan_sessions ADD COLUMN completed_at TEXT`,
    ],
  },

  // 41. MAY-14: rebuild legacy project_id tables to match the codespace-era
  // Drizzle write shape.
  //
  // The v19 project-folder migration added codespace_id / target_codespace_id
  // compatibility columns but could not remove NOT NULL from the legacy
  // project_id / target_project_id columns. Current Drizzle schemas write
  // through codespace_id only, so fresh runtime-migrated SQLite databases
  // rejected inserts into tasks, worktrees, agent_runs, and event_subscriptions
  // unless callers also supplied legacy project ids. The test harness had a
  // patched copy of MIGRATION_SQL for this; production should own the fix.
  {
    version: 41,
    name: 'codespace-era-table-rebuilds',
    sql: `
DROP TABLE IF EXISTS tasks_new_v41;
CREATE TABLE tasks_new_v41 (
  id TEXT PRIMARY KEY NOT NULL,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  "column" TEXT DEFAULT 'backlog' NOT NULL,
  position INTEGER DEFAULT 0 NOT NULL,
  labels TEXT DEFAULT '[]',
  priority TEXT DEFAULT 'medium',
  model_override TEXT,
  branch TEXT,
  diff_summary TEXT,
  approved_at TEXT,
  approved_by TEXT,
  rejection_count INTEGER DEFAULT 0,
  rejection_reason TEXT,
  plan_options TEXT,
  plan TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_agent_status TEXT,
  skill_id TEXT,
  skill_name TEXT,
  execution_skill_id TEXT,
  execution_skill_name TEXT,
  approval_mode TEXT,
  agent_review_result TEXT,
  agent_reviewed_at TEXT
);

INSERT OR IGNORE INTO tasks_new_v41 (
  id, codespace_id, agent_id, session_id, worktree_id, title, description,
  "column", position, labels, priority, model_override, branch, diff_summary,
  approved_at, approved_by, rejection_count, rejection_reason, plan_options,
  plan, created_at, updated_at, started_at, completed_at, last_agent_status,
  skill_id, skill_name, execution_skill_id, execution_skill_name,
  approval_mode, agent_review_result, agent_reviewed_at
)
SELECT
  id, COALESCE(codespace_id, project_id), agent_id, session_id, worktree_id,
  title, description, "column", position, labels, priority, model_override,
  branch, diff_summary, approved_at, approved_by, rejection_count,
  rejection_reason, plan_options, plan, created_at, updated_at, started_at,
  completed_at, last_agent_status, skill_id, skill_name, execution_skill_id,
  execution_skill_name, NULL, NULL, NULL
FROM tasks
WHERE COALESCE(codespace_id, project_id) IS NOT NULL
  AND COALESCE(codespace_id, project_id) IN (SELECT id FROM codespaces);

DROP TABLE tasks;
ALTER TABLE tasks_new_v41 RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_kanban ON tasks(codespace_id, "column", position);

DROP TABLE IF EXISTS worktrees_new_v41;
CREATE TABLE worktrees_new_v41 (
  id TEXT PRIMARY KEY NOT NULL,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  base_branch TEXT DEFAULT 'main' NOT NULL,
  status TEXT DEFAULT 'creating' NOT NULL,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL,
  merged_at TEXT,
  removed_at TEXT
);

INSERT OR IGNORE INTO worktrees_new_v41 (
  id, codespace_id, agent_id, task_id, branch, path, base_branch, status,
  created_at, updated_at, merged_at, removed_at
)
SELECT
  id, COALESCE(codespace_id, project_id), agent_id, task_id, branch, path,
  base_branch, status, created_at, updated_at, merged_at, removed_at
FROM worktrees
WHERE COALESCE(codespace_id, project_id) IS NOT NULL
  AND COALESCE(codespace_id, project_id) IN (SELECT id FROM codespaces);

DROP TABLE worktrees;
ALTER TABLE worktrees_new_v41 RENAME TO worktrees;
CREATE INDEX IF NOT EXISTS idx_worktrees_codespace_id ON worktrees(codespace_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_branch ON worktrees(codespace_id, branch);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);

DROP TABLE IF EXISTS agent_runs_new_v41;
CREATE TABLE agent_runs_new_v41 (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')) NOT NULL,
  completed_at TEXT,
  turns_used INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  error_message TEXT
);

INSERT OR IGNORE INTO agent_runs_new_v41 (
  id, agent_id, task_id, codespace_id, session_id, status, started_at,
  completed_at, turns_used, tokens_used, error_message
)
SELECT
  id, agent_id, task_id, COALESCE(codespace_id, project_id), session_id,
  status, started_at, completed_at, turns_used, tokens_used, error_message
FROM agent_runs
WHERE COALESCE(codespace_id, project_id) IS NOT NULL
  AND COALESCE(codespace_id, project_id) IN (SELECT id FROM codespaces);

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new_v41 RENAME TO agent_runs;
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_codespace_id ON agent_runs(codespace_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id ON agent_runs(task_id);

DROP TABLE IF EXISTS event_subscriptions_new_v41;
CREATE TABLE event_subscriptions_new_v41 (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  event_source_id TEXT NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  target_codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  is_enabled INTEGER DEFAULT 1 NOT NULL,
  event_types TEXT DEFAULT '[]',
  filters TEXT DEFAULT '[]',
  prompt_template TEXT NOT NULL,
  auto_start_agent INTEGER DEFAULT 0 NOT NULL,
  task_column TEXT DEFAULT 'backlog' NOT NULL,
  task_priority TEXT DEFAULT 'medium' NOT NULL,
  task_labels TEXT DEFAULT '[]',
  matched_count INTEGER DEFAULT 0 NOT NULL,
  last_matched_at TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);

INSERT OR IGNORE INTO event_subscriptions_new_v41 (
  id, name, event_source_id, target_codespace_id, is_enabled, event_types,
  filters, prompt_template, auto_start_agent, task_column, task_priority,
  task_labels, matched_count, last_matched_at, created_at, updated_at
)
SELECT
  id, name, event_source_id, COALESCE(target_codespace_id, target_project_id),
  is_enabled, event_types, filters, prompt_template, auto_start_agent,
  task_column, task_priority, task_labels, matched_count, last_matched_at,
  created_at, updated_at
FROM event_subscriptions
WHERE COALESCE(target_codespace_id, target_project_id) IS NOT NULL
  AND COALESCE(target_codespace_id, target_project_id) IN (SELECT id FROM codespaces);

DROP TABLE event_subscriptions;
ALTER TABLE event_subscriptions_new_v41 RENAME TO event_subscriptions;
CREATE INDEX IF NOT EXISTS event_subscriptions_source_idx ON event_subscriptions(event_source_id);
CREATE INDEX IF NOT EXISTS event_subscriptions_codespace_idx ON event_subscriptions(target_codespace_id);
CREATE INDEX IF NOT EXISTS event_subscriptions_source_enabled_idx ON event_subscriptions(event_source_id, is_enabled);
`,
  },
  // 42. MAY-15: finish SQLite runtime schema parity with Drizzle.
  //
  // These columns/tables were previously patched only by tests/helpers/database.ts,
  // which meant integration tests could write through Drizzle while a freshly
  // runtime-migrated SQLite database still drifted from the application schema.
  // Keep these as idempotent per-statement catch-ups so production, local dev,
  // and tests all converge through the same migration runner.
  {
    version: 42,
    name: 'sqlite-schema-parity-catchup',
    statements: [
      `ALTER TABLE api_keys ADD COLUMN encrypted_refresh_token TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN slug TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN cli_version TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN permission_mode TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN topology TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN queue_operations TEXT`,
      `ALTER TABLE cli_sessions ADD COLUMN tool_invocations TEXT`,
      `CREATE TABLE IF NOT EXISTS sandbox_tmux_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        sandbox_id TEXT NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
        session_name TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        window_count INTEGER DEFAULT 1 NOT NULL,
        attached INTEGER DEFAULT 0 NOT NULL,
        created_at TEXT DEFAULT (datetime('now')) NOT NULL,
        last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
        CONSTRAINT sandbox_session_unique UNIQUE (sandbox_id, session_name)
      )`,
      `ALTER TABLE skill_executions ADD COLUMN duration_api_ms INTEGER`,
      `ALTER TABLE skill_metrics ADD COLUMN avg_duration_api_ms REAL`,
    ],
  },
];
