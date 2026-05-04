import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema/sqlite';
import {
  PROJECT_FOLDERS_ALTER_STATEMENTS,
  PROJECT_FOLDERS_MIGRATION_SQL,
} from '../../src/lib/bootstrap/migrations/v19-project-folders';
import {
  CLI_SESSIONS_MIGRATION_SQL,
  EVENT_SYSTEM_MIGRATION_SQL,
  MEMORY_TABLES_MIGRATION_SQL,
  MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
  SCHEDULE_EXECUTIONS_MIGRATION_SQL,
  TERRAFORM_MIGRATION_SQL,
} from '../../src/lib/bootstrap/phases/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';

const DB_MODE = process.env.DB_MODE ?? 'sqlite';

// Use BetterSQLite3Database as the database type for tests
type TestDatabase = BetterSQLite3Database<typeof schema>;

let testSqlite: SQLiteDatabase | null = null;
let testDb: TestDatabase | null = null;
let pgClient: ReturnType<typeof import('postgres').default> | null = null;

export async function setupTestDatabase(): Promise<TestDatabase> {
  if (testDb) {
    return testDb;
  }

  if (DB_MODE === 'postgres') {
    const postgres = (await import('postgres')).default;
    const { drizzle: drizzlePg } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const pgSchema = await import('../../src/db/schema/postgres/index.js');

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required when DB_MODE=postgres');
    }

    pgClient = postgres(connectionString);
    const db = drizzlePg(pgClient, { schema: pgSchema });
    await migrate(db, { migrationsFolder: './src/db/migrations-pg' });

    // Cast for compatibility — services use the union Database type
    testDb = db as unknown as TestDatabase;
    return testDb;
  }

  // Use in-memory SQLite for tests.
  // FK checking is OFF because the v19 migration adds codespace_id columns
  // but can't remove the NOT NULL constraint on legacy project_id columns.
  // Drizzle ORM only writes to codespace_id, causing NOT NULL failures.
  testSqlite = new Database(':memory:');
  testSqlite.pragma('foreign_keys = OFF');

  testDb = drizzle(testSqlite, { schema });

  // Monkey-patch `transaction()` to support async callbacks.
  // better-sqlite3 transactions are synchronous, but the source code uses
  // `async (tx) => { await tx.update(...) }`. Since all Drizzle operations
  // on better-sqlite3 resolve synchronously, we wrap the async callback
  // inside a native synchronous transaction that captures the result.
  const originalTransaction = testDb.transaction.bind(testDb);
  (testDb as any).transaction = (callback: (tx: any) => any) => {
    let result: any;
    const syncWrapper = (tx: any) => {
      result = callback(tx);
      // If it's a promise, better-sqlite3 will throw. Instead, we handle it.
      return result;
    };
    try {
      return originalTransaction(syncWrapper as any);
    } catch (e: any) {
      // If the error is about returning a promise, the callback returned a
      // thenable. Since better-sqlite3 ops resolve sync, the result is
      // already available. Re-run inside a manual BEGIN/COMMIT.
      if (e?.message?.includes('promise') || e?.message?.includes('Promise')) {
        testSqlite!.exec('BEGIN');
        try {
          // Re-invoke callback with a proxy tx that delegates to testDb
          const txResult = callback(testDb as any);
          testSqlite!.exec('COMMIT');
          return txResult;
        } catch (innerErr) {
          testSqlite!.exec('ROLLBACK');
          throw innerErr;
        }
      }
      throw e;
    }
  };

  // Run base migrations.
  // Patch: make project_id nullable so Drizzle (which only writes codespace_id)
  // doesn't fail on NOT NULL constraints for the legacy column.
  const patchedMigration = MIGRATION_SQL.replace(
    /"project_id" TEXT NOT NULL/g,
    '"project_id" TEXT'
  ).replace(/"target_project_id" TEXT NOT NULL/g, '"target_project_id" TEXT');
  testSqlite.exec(patchedMigration);

  // Add team_id column to github_tokens before running RBAC migration.
  // RBAC_MIGRATION_SQL creates an index on github_tokens(team_id), so the
  // column must exist first. Ignore errors in case the column already exists.
  try {
    testSqlite.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
  } catch {
    // column may already exist — safe to ignore
  }

  // Run RBAC migrations (creates teams, task_tags, api_tokens, etc.)
  const patchedRbac = RBAC_MIGRATION_SQL.replace(
    /"project_id" TEXT NOT NULL/g,
    '"project_id" TEXT'
  );
  testSqlite.exec(patchedRbac);

  // Run event system migrations (event_sources, event_subscriptions, event_log)
  const patchedEvents = EVENT_SYSTEM_MIGRATION_SQL.replace(
    /"target_project_id" TEXT NOT NULL/g,
    '"target_project_id" TEXT'
  );
  testSqlite.exec(patchedEvents);

  // Run v19 project folders + codespace rename migration
  testSqlite.exec(PROJECT_FOLDERS_MIGRATION_SQL);

  // Run v20 ALTER TABLE statements for FK column renames (idempotent)
  for (const stmt of PROJECT_FOLDERS_ALTER_STATEMENTS) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Idempotent — column may already exist
    }
  }

  // Add skill columns to tasks (migration 0012)
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN skill_id TEXT');
  } catch {
    // Column may already exist
  }
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN skill_name TEXT');
  } catch {
    // Column may already exist
  }

  // Add execution skill columns to tasks (migration 0014)
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN execution_skill_id TEXT');
  } catch {
    // Column may already exist
  }
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN execution_skill_name TEXT');
  } catch {
    // Column may already exist
  }

  // Add agent approval mode columns to tasks (migration 0016)
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN approval_mode TEXT');
  } catch {
    // Column may already exist
  }
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN agent_review_result TEXT');
  } catch {
    // Column may already exist
  }
  try {
    testSqlite.exec('ALTER TABLE tasks ADD COLUMN agent_reviewed_at TEXT');
  } catch {
    // Column may already exist
  }

  // GitHub App columns (migration 23)
  try {
    testSqlite.exec(
      'ALTER TABLE github_installations ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL'
    );
  } catch {
    // Column may already exist
  }
  try {
    testSqlite.exec(
      'ALTER TABLE event_sources ADD COLUMN github_installation_id TEXT REFERENCES github_installations(id) ON DELETE SET NULL'
    );
  } catch {
    // Column may already exist
  }

  // F06-09: token rotation columns (migration 0017).
  // F03-09 (arch29-W2-C): encrypted refresh token column (migration 0019).
  for (const stmt of [
    'ALTER TABLE api_tokens ADD COLUMN rotated_at TEXT',
    'ALTER TABLE api_keys ADD COLUMN expires_at TEXT',
    'ALTER TABLE api_keys ADD COLUMN rotated_at TEXT',
    'ALTER TABLE api_keys ADD COLUMN encrypted_refresh_token TEXT',
    'ALTER TABLE github_tokens ADD COLUMN expires_at TEXT',
    'ALTER TABLE github_tokens ADD COLUMN rotated_at TEXT',
  ]) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Column may already exist — idempotent
    }
  }

  // F05-05: event_outbox (migration 0018), F02-18 epoch-ms shape (migration v36).
  // The test harness skips the legacy TEXT-timestamp shape and creates the
  // table directly with INTEGER epoch-ms columns to match the current Drizzle
  // schema. Production databases run the v32 → v36 migration chain to convert
  // existing rows; the harness has no rows to convert so it can skip ahead.
  try {
    testSqlite.exec(`
CREATE TABLE IF NOT EXISTS event_outbox (
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
CREATE INDEX IF NOT EXISTS event_outbox_status_idx ON event_outbox(status);
CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_at_idx ON event_outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_idx ON event_outbox(status, next_attempt_at);
`);
  } catch {
    // Table may already exist
  }

  // F05-25: session_events.stream_kind discriminator (migration 0019 / v33).
  // The base schema creates session_events without the column; add it nullable,
  // backfill from streamId prefix, then rebuild to enforce NOT NULL + CHECK.
  try {
    const cols = testSqlite.prepare('PRAGMA table_info(session_events)').all() as Array<{
      name: string;
    }>;
    const hasStreamKind = cols.some((c) => c.name === 'stream_kind');
    if (!hasStreamKind) {
      testSqlite.exec(`
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
`);
    }
  } catch {
    // Idempotent — table may already have been rebuilt
  }

  // F06-NEW-08: rate_limit_buckets (runtime v35).
  try {
    testSqlite.exec(`
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx ON rate_limit_buckets(updated_at);
`);
  } catch {
    // Table may already exist
  }

  // F09-21 (arch29-W2-Q): mirror the production migration chain so the
  // schema-drift suite can exercise every table Drizzle exports. Without these,
  // 12 of ~50 tables were skipped in the test DB via MISSING_IN_TEST_DB and
  // their drift went undetected on PRs.

  // Terraform tables (runtime v8 — TERRAFORM_MIGRATION_SQL). Idempotent.
  try {
    testSqlite.exec(TERRAFORM_MIGRATION_SQL);
  } catch {
    // Table may already exist
  }

  // CLI Monitor sessions (runtime v6/v7). Idempotent.
  try {
    testSqlite.exec(CLI_SESSIONS_MIGRATION_SQL);
  } catch {
    // Table may already exist
  }

  // F02-16 follow-up: cli_sessions has Drizzle-declared columns that no SQLite
  // runtime migration adds (PG migration 0010 added them on the PG side).
  // Add them to the test DB so service-layer tests using the Drizzle schema
  // don't fail with "no such column". Real production drift is tracked in
  // EXPECTED_MISSING_COLUMNS at tests/integration/schema-drift-all-tables.test.ts.
  for (const stmt of [
    'ALTER TABLE cli_sessions ADD COLUMN slug TEXT',
    'ALTER TABLE cli_sessions ADD COLUMN cli_version TEXT',
    'ALTER TABLE cli_sessions ADD COLUMN permission_mode TEXT',
    'ALTER TABLE cli_sessions ADD COLUMN topology TEXT',
    'ALTER TABLE cli_sessions ADD COLUMN queue_operations TEXT',
    'ALTER TABLE cli_sessions ADD COLUMN tool_invocations TEXT',
  ]) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Column may already exist — idempotent
    }
  }

  // Schedule executions (runtime v17). Idempotent.
  try {
    testSqlite.exec(SCHEDULE_EXECUTIONS_MIGRATION_SQL);
  } catch {
    // Table may already exist
  }

  // Memory service tables (runtime v22 — insights, messages, skill_executions,
  // skill_metrics, dream_sessions, skill_suggestions). Idempotent.
  try {
    testSqlite.exec(MEMORY_TABLES_MIGRATION_SQL);
  } catch {
    // Tables may already exist
  }

  // Memory insight status / category / updated_at + skill_executions.insight_ids_used
  // (runtime v27 — memory-insight-status-category). Idempotent per-statement.
  for (const stmt of [
    `ALTER TABLE memory_insights ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE memory_insights ADD COLUMN category TEXT`,
    `ALTER TABLE memory_insights ADD COLUMN updated_at TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_memory_insights_status ON memory_insights(status)`,
    `ALTER TABLE skill_executions ADD COLUMN insight_ids_used TEXT`,
  ]) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Column may already exist — idempotent
    }
  }

  // Memory insight effectiveness score (runtime v28). Idempotent.
  try {
    testSqlite.exec(`ALTER TABLE memory_insights ADD COLUMN effectiveness_score REAL`);
  } catch {
    // Column may already exist
  }

  // Skill execution duration_api_ms + skill_metrics.avg_duration_api_ms
  // (PG migration 0008 / SQLite drizzle-kit 0015 — applied at runtime
  // indirectly via MEMORY_TABLES_MIGRATION_SQL not including these columns
  // historically). Add explicitly for parity with PG.
  for (const stmt of [
    `ALTER TABLE skill_executions ADD COLUMN duration_api_ms INTEGER`,
    `ALTER TABLE skill_metrics ADD COLUMN avg_duration_api_ms REAL`,
  ]) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Column may already exist
    }
  }

  // Sandbox instances + tmux sessions (runtime v33 — sandbox-unique-partial-index).
  // Mirrors the bootstrap migration's CREATE TABLE IF NOT EXISTS shape.
  try {
    testSqlite.exec(`
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
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_instances_codespace_active_unique
  ON sandbox_instances(codespace_id)
  WHERE status IN ('creating', 'running', 'idle', 'stopping');
CREATE INDEX IF NOT EXISTS sandbox_instances_status_idx ON sandbox_instances(status);

CREATE TABLE IF NOT EXISTS sandbox_tmux_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  sandbox_id TEXT NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
  session_name TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  window_count INTEGER DEFAULT 1 NOT NULL,
  attached INTEGER DEFAULT 0 NOT NULL,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
  CONSTRAINT sandbox_session_unique UNIQUE (sandbox_id, session_name)
);
`);
  } catch {
    // Tables may already exist
  }

  // F02-19 (arch29-W2-Q, runtime v38): codespace_tags.assigned_at column.
  try {
    testSqlite.exec(
      `ALTER TABLE codespace_tags ADD COLUMN assigned_at TEXT NOT NULL DEFAULT (datetime('now'))`
    );
  } catch {
    // Column may already exist — idempotent
  }

  // MAY-14: runtime v40 plan_sessions column catch-up for legacy v19 stubs.
  for (const stmt of [
    `ALTER TABLE plan_sessions ADD COLUMN turns TEXT DEFAULT '[]'`,
    `ALTER TABLE plan_sessions ADD COLUMN github_issue_url TEXT`,
    `ALTER TABLE plan_sessions ADD COLUMN github_issue_number INTEGER`,
    `ALTER TABLE plan_sessions ADD COLUMN completed_at TEXT`,
  ]) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Column may already exist — idempotent
    }
  }

  // F02-20 (arch29-W2-Q, runtime v39): api_tokens.scope_codespace_id FK behavior fix.
  // Rebuild api_tokens with ON DELETE SET NULL (was CASCADE in v19). Skip if the
  // table already has the correct behavior (PG mode + fresh installs).
  try {
    // Only rebuild if the existing table still has CASCADE on scope_codespace_id.
    // We detect this by inspecting the FK list — pragma_foreign_key_list returns
    // the on_delete action token.
    const fkRows = testSqlite.prepare(`PRAGMA foreign_key_list(api_tokens)`).all() as Array<{
      from: string;
      on_delete: string;
    }>;
    const scopeFk = fkRows.find((r) => r.from === 'scope_codespace_id');
    if (scopeFk && scopeFk.on_delete === 'CASCADE') {
      testSqlite.exec(`
DROP TABLE IF EXISTS api_tokens_new_v39;
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

DROP TABLE api_tokens;
ALTER TABLE api_tokens_new_v39 RENAME TO api_tokens;

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_team ON api_tokens(team_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_status ON api_tokens(status);
`);
    }
  } catch {
    // Idempotent — table may already have been rebuilt
  }

  return testDb;
}

/**
 * Execute raw SQL on the test database
 * Useful for creating additional tables or running custom migrations
 */
export function execRawSql(sql: string): void {
  if (DB_MODE === 'postgres') {
    throw new Error('execRawSql is not supported in postgres mode — use pgClient directly');
  }
  if (!testSqlite) {
    throw new Error('Test database not initialized');
  }
  testSqlite.exec(sql);
}

export async function clearTestDatabase(): Promise<void> {
  if (!testDb) {
    return;
  }

  if (DB_MODE === 'postgres' && pgClient) {
    // Truncate all tables in FK-safe order
    await pgClient`TRUNCATE TABLE
      audit_logs, agent_runs, session_events, session_summaries,
      sessions, worktrees, tasks, agents,
      template_codespaces, templates,
      repository_configs, github_tokens, github_installations,
      sandbox_configs, sandboxes, volume_mounts,
      terraform_modules, terraform_registries,
      workflows, plan_sessions, cli_sessions,
      event_log, event_subscriptions, event_sources,
      api_keys, settings, marketplaces,
      codespace_members, codespace_tags, folder_members,
      team_project_folders, codespaces, project_folders
    CASCADE`;
    // Re-seed the default project folder so FK constraints are satisfied
    await pgClient`INSERT INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280')
      ON CONFLICT (id) DO NOTHING`;
    return;
  }

  // Fast batch cleanup for SQLite — single FFI call instead of 27 ORM round-trips
  if (testSqlite) {
    testSqlite.exec(`
      PRAGMA defer_foreign_keys = ON;
      DELETE FROM audit_logs;
      DELETE FROM event_log;
      DELETE FROM event_outbox;
      DELETE FROM rate_limit_buckets;
      DELETE FROM event_subscriptions;
      DELETE FROM event_sources;
      DELETE FROM agent_runs;
      DELETE FROM session_events;
      DELETE FROM sessions;
      DELETE FROM worktrees;
      DELETE FROM tasks;
      DELETE FROM agents;
      DELETE FROM repository_configs;
      DELETE FROM github_installations;
      DELETE FROM github_tokens;
      DELETE FROM task_tags;
      DELETE FROM codespace_tags;
      DELETE FROM api_tokens;
      DELETE FROM team_invitations;
      DELETE FROM codespace_members;
      DELETE FROM template_codespaces;
      DELETE FROM folder_members;
      DELETE FROM team_project_folders;
      DELETE FROM team_members;
      DELETE FROM tags;
      DELETE FROM teams;
      DELETE FROM codespaces;
      DELETE FROM project_folders;
      DELETE FROM projects;
      DELETE FROM sandbox_configs;
      DELETE FROM marketplaces;
      PRAGMA defer_foreign_keys = OFF;
    `);
    // Re-seed the default project folder so FK constraints are satisfied
    testSqlite.exec(`
      INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280');
    `);
    // Ensure FK enforcement is active (a test may have disabled it temporarily)
    testSqlite.pragma('foreign_keys = ON');
    return;
  }

  // Fallback: Drizzle ORM cleanup (for edge cases where testSqlite is null)
  await testDb.delete(schema.auditLogs);
  await testDb.delete(schema.eventLog);
  await testDb.delete(schema.eventSubscriptions);
  await testDb.delete(schema.eventSources);
  await testDb.delete(schema.agentRuns);
  await testDb.delete(schema.sessionEvents);
  await testDb.delete(schema.sessions);
  await testDb.delete(schema.worktrees);
  await testDb.delete(schema.tasks);
  await testDb.delete(schema.agents);
  await testDb.delete(schema.repositoryConfigs);
  await testDb.delete(schema.githubInstallations);
  await testDb.delete(schema.githubTokens);
  await testDb.delete(schema.taskTags);
  await testDb.delete(schema.codespaceTags);
  await testDb.delete(schema.apiTokens);
  await testDb.delete(schema.teamInvitations);
  await testDb.delete(schema.codespaceMembers);
  await testDb.delete(schema.templateCodespaces);
  await testDb.delete(schema.folderMembers);
  await testDb.delete(schema.teamProjectFolders);
  await testDb.delete(schema.teamMembers);
  await testDb.delete(schema.tags);
  await testDb.delete(schema.teams);
  await testDb.delete(schema.codespaces);
  await testDb.delete(schema.projectFolders);
  await testDb.delete(schema.sandboxConfigs);
  await testDb.delete(schema.marketplaces);

  // Re-seed the default project folder so FK constraints are satisfied
  await testDb.insert(schema.projectFolders).values({
    id: 'default-folder',
    name: 'Default',
    slug: 'default',
    description: 'Default project folder for tests',
    icon: 'Folder',
    color: '#6B7280',
  });
}

export async function closeTestDatabase(): Promise<void> {
  if (DB_MODE === 'postgres' && pgClient) {
    await pgClient.end();
    pgClient = null;
    testDb = null;
    return;
  }

  if (testSqlite) {
    testSqlite.close();
    testSqlite = null;
    testDb = null;
  }
}

export function getTestDb(): TestDatabase {
  if (!testDb) {
    throw new Error('Test database not initialized');
  }
  return testDb;
}

export type SeedOptions = {
  projects?: number;
  tasksPerProject?: number;
  agentsPerProject?: number;
};

export async function seedTestDatabase(options: SeedOptions = {}): Promise<schema.Codespace[]> {
  const { projects = 1, tasksPerProject = 5, agentsPerProject = 2 } = options;

  const createdProjects: schema.Codespace[] = [];

  for (let projectIndex = 0; projectIndex < projects; projectIndex += 1) {
    const project = await createTestProject({
      name: `Test Project ${projectIndex + 1}`,
    });
    createdProjects.push(project);

    for (let agentIndex = 0; agentIndex < agentsPerProject; agentIndex += 1) {
      await createTestAgent(project.id, { name: `Agent ${agentIndex + 1}` });
    }

    for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex += 1) {
      await createTestTask(project.id, { title: `Task ${taskIndex + 1}` });
    }
  }

  return createdProjects;
}
