import { createId } from '@paralleldrive/cuid2';
import { createError } from '../../errors/base.js';
import { createLogger } from '../../logging/logger.js';
import { err, ok } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

const log = createLogger('SchemaPhase');

// SQLite migration SQL - creates tables if they don't exist
// Exported for test setup reuse
//
// INTENTIONAL: Raw SQL strings are used here instead of Drizzle ORM schema definitions
// because bootstrap runs BEFORE Drizzle is initialized. The Drizzle ORM requires tables
// to already exist (or be created via drizzle-kit) before it can operate. This bootstrap
// phase uses raw SQL via better-sqlite3's `prepare().run()` to create/migrate tables
// first, after which Drizzle connects to the already-migrated database.
//
// Cross-reference: The authoritative Drizzle schema definitions live in:
//   - src/db/schema/sqlite/  (SQLite column definitions)
//   - src/db/schema/postgres/ (PostgreSQL column definitions)
//   - src/db/schema/shared/   (shared enums and types)
// Any column additions here MUST be mirrored in the Drizzle schema files, and vice versa.
// See also: scripts/check-schema-drift.ts (CI drift checker)
//
// @see CQ-010 in specs/reviews/2026-03-architecture/FINDINGS-MATRIX.md
export const MIGRATION_SQL = `
-- Create tables if they don't exist
CREATE TABLE IF NOT EXISTS "projects" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "path" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "config" TEXT,
  "max_concurrent_agents" INTEGER DEFAULT 3,
  "github_owner" TEXT,
  "github_repo" TEXT,
  "github_installation_id" TEXT,
  "config_path" TEXT DEFAULT '.claude',
  "sandbox_config_id" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "github_installations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "installation_id" TEXT NOT NULL UNIQUE,
  "account_login" TEXT NOT NULL,
  "account_type" TEXT NOT NULL,
  "status" TEXT DEFAULT 'active' NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "github_tokens" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "encrypted_token" TEXT NOT NULL,
  "token_type" TEXT NOT NULL DEFAULT 'pat',
  "scopes" TEXT,
  "github_login" TEXT,
  "github_id" TEXT,
  "is_valid" INTEGER DEFAULT 1,
  "last_validated_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "repository_configs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "installation_id" TEXT NOT NULL REFERENCES "github_installations"("id") ON DELETE CASCADE,
  "owner" TEXT NOT NULL,
  "repo" TEXT NOT NULL,
  "config" TEXT,
  "synced_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "agents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'task' NOT NULL,
  "status" TEXT DEFAULT 'idle' NOT NULL,
  "config" TEXT,
  "current_task_id" TEXT,
  "current_session_id" TEXT,
  "current_turn" INTEGER DEFAULT 0,
  "parent_agent_id" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "task_id" TEXT,
  "agent_id" TEXT REFERENCES "agents"("id") ON DELETE SET NULL,
  "status" TEXT DEFAULT 'idle' NOT NULL,
  "title" TEXT,
  "url" TEXT NOT NULL,
  "sandbox_provider" TEXT,
  "sandbox_container_id" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "closed_at" TEXT
);

CREATE TABLE IF NOT EXISTS "worktrees" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "agent_id" TEXT REFERENCES "agents"("id") ON DELETE SET NULL,
  "task_id" TEXT,
  "branch" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "base_branch" TEXT DEFAULT 'main' NOT NULL,
  "status" TEXT DEFAULT 'creating' NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "merged_at" TEXT,
  "removed_at" TEXT
);

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "agent_id" TEXT REFERENCES "agents"("id") ON DELETE SET NULL,
  "session_id" TEXT REFERENCES "sessions"("id") ON DELETE SET NULL,
  "worktree_id" TEXT REFERENCES "worktrees"("id") ON DELETE SET NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "column" TEXT DEFAULT 'backlog' NOT NULL,
  "position" INTEGER DEFAULT 0 NOT NULL,
  "labels" TEXT DEFAULT '[]',
  "priority" TEXT DEFAULT 'medium',
  "model_override" TEXT,
  "branch" TEXT,
  "diff_summary" TEXT,
  "approved_at" TEXT,
  "approved_by" TEXT,
  "rejection_count" INTEGER DEFAULT 0,
  "rejection_reason" TEXT,
  "plan_options" TEXT,
  "plan" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "started_at" TEXT,
  "completed_at" TEXT,
  "last_agent_status" TEXT
);

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "agent_id" TEXT NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "session_id" TEXT REFERENCES "sessions"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL,
  "started_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "completed_at" TEXT,
  "turns_used" INTEGER DEFAULT 0,
  "tokens_used" INTEGER DEFAULT 0,
  "error_message" TEXT
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "agent_id" TEXT REFERENCES "agents"("id") ON DELETE SET NULL,
  "agent_run_id" TEXT REFERENCES "agent_runs"("id") ON DELETE SET NULL,
  "task_id" TEXT REFERENCES "tasks"("id") ON DELETE SET NULL,
  "project_id" TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "tool" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "input" TEXT,
  "output" TEXT,
  "error_message" TEXT,
  "duration_ms" INTEGER,
  "turn_number" INTEGER,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "service" TEXT NOT NULL UNIQUE,
  "encrypted_key" TEXT NOT NULL,
  "masked_key" TEXT NOT NULL,
  "is_valid" INTEGER DEFAULT 1,
  "last_validated_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "templates" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "scope" TEXT NOT NULL,
  "github_owner" TEXT NOT NULL,
  "github_repo" TEXT NOT NULL,
  "branch" TEXT DEFAULT 'main',
  "config_path" TEXT DEFAULT '.claude',
  "project_id" TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "status" TEXT DEFAULT 'active',
  "last_sync_sha" TEXT,
  "last_synced_at" TEXT,
  "sync_error" TEXT,
  "sync_interval_minutes" INTEGER,
  "next_sync_at" TEXT,
  "cached_skills" TEXT,
  "cached_commands" TEXT,
  "cached_agents" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "template_projects" (
  "template_id" TEXT NOT NULL REFERENCES "templates"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("template_id", "project_id")
);

CREATE TABLE IF NOT EXISTS "sandbox_configs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'docker',
  "is_default" INTEGER DEFAULT 0,
  "base_image" TEXT NOT NULL DEFAULT 'node:22-slim',
  "memory_mb" INTEGER NOT NULL DEFAULT 4096,
  "cpu_cores" REAL NOT NULL DEFAULT 2.0,
  "max_processes" INTEGER NOT NULL DEFAULT 256,
  "timeout_minutes" INTEGER NOT NULL DEFAULT 60,
  "volume_mount_path" TEXT,
  "kube_config_path" TEXT,
  "kube_context" TEXT,
  "kube_namespace" TEXT DEFAULT 'agentpane-sandboxes',
  "network_policy_enabled" INTEGER DEFAULT 1,
  "allowed_egress_hosts" TEXT,
  "nomad_address" TEXT,
  "nomad_token" TEXT,
  "nomad_namespace" TEXT DEFAULT 'default',
  "nomad_datacenter" TEXT,
  "nomad_region" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "session_events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "offset" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "timestamp" INTEGER NOT NULL,
  "user_id" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_events_session_idx" ON "session_events"("session_id");
-- DB-008: Removed redundant session_events_offset_idx (covered by unique_offset below)
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_unique_offset" ON "session_events"("session_id", "offset");

CREATE TABLE IF NOT EXISTS "session_summaries" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL UNIQUE REFERENCES "sessions"("id") ON DELETE CASCADE,
  "duration_ms" INTEGER,
  "turns_count" INTEGER DEFAULT 0,
  "tokens_used" INTEGER DEFAULT 0,
  "files_modified" INTEGER DEFAULT 0,
  "lines_added" INTEGER DEFAULT 0,
  "lines_removed" INTEGER DEFAULT 0,
  "final_status" TEXT,
  "cost_usd" REAL,
  "duration_api_ms" INTEGER,
  "cache_read_tokens" INTEGER,
  "cache_creation_tokens" INTEGER,
  "stop_reason" TEXT,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "marketplaces" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "github_owner" TEXT NOT NULL,
  "github_repo" TEXT NOT NULL,
  "branch" TEXT DEFAULT 'main',
  "plugins_path" TEXT DEFAULT 'plugins',
  "is_default" INTEGER DEFAULT 0,
  "is_enabled" INTEGER DEFAULT 1,
  "status" TEXT DEFAULT 'active',
  "last_sync_sha" TEXT,
  "last_synced_at" TEXT,
  "sync_error" TEXT,
  "cached_plugins" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "workflows" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "nodes" TEXT,
  "edges" TEXT,
  "source_template_id" TEXT REFERENCES "templates"("id") ON DELETE SET NULL,
  "source_template_name" TEXT,
  "viewport" TEXT,
  "status" TEXT DEFAULT 'draft',
  "tags" TEXT,
  "thumbnail" TEXT,
  "ai_generated" INTEGER,
  "ai_model" TEXT,
  "ai_confidence" INTEGER,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "settings" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Seed the official Anthropic plugins marketplace (idempotent)
INSERT OR IGNORE INTO "marketplaces" (
  "id", "name", "github_owner", "github_repo", "branch", "plugins_path", "is_default", "is_enabled", "status"
) VALUES (
  'anthropic-official-marketplace',
  'Claude Plugins Official',
  'anthropics',
  'claude-plugins-official',
  'main',
  'plugins',
  1,
  1,
  'active'
);
`;

// Additional migrations for existing databases
export const SANDBOX_MIGRATION_SQL = `
-- Add sandbox_config_id to projects if it doesn't exist
-- This runs separately because SQLite doesn't support IF NOT EXISTS for ALTER TABLE
ALTER TABLE projects ADD COLUMN sandbox_config_id TEXT;
`;

// Migration for template sync interval columns (for existing databases)
export const TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL = `
-- Add sync_interval_minutes and next_sync_at to templates if they don't exist
ALTER TABLE templates ADD COLUMN sync_interval_minutes INTEGER;
ALTER TABLE templates ADD COLUMN next_sync_at TEXT;
`;

// CLI Sessions migration (for CLI Monitor DB persistence)
export const CLI_SESSIONS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "cli_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL UNIQUE,
  "file_path" TEXT NOT NULL,
  "cwd" TEXT NOT NULL,
  "project_name" TEXT NOT NULL,
  "project_hash" TEXT NOT NULL,
  "git_branch" TEXT,
  "status" TEXT NOT NULL DEFAULT 'idle',
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "turn_count" INTEGER NOT NULL DEFAULT 0,
  "goal" TEXT,
  "recent_output" TEXT,
  "pending_tool_use" TEXT,
  "token_usage" TEXT,
  "performance_metrics" TEXT,
  "model" TEXT,
  "started_at" INTEGER NOT NULL,
  "last_activity_at" INTEGER NOT NULL,
  "is_subagent" INTEGER NOT NULL DEFAULT 0,
  "parent_session_id" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS "idx_cli_sessions_project" ON "cli_sessions"("project_hash", "last_activity_at");
CREATE INDEX IF NOT EXISTS "idx_cli_sessions_status" ON "cli_sessions"("status");
CREATE INDEX IF NOT EXISTS "idx_cli_sessions_last_activity" ON "cli_sessions"("last_activity_at");
`;

// CLI Sessions performance_metrics column migration (for existing databases)
export const CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL = `
ALTER TABLE cli_sessions ADD COLUMN performance_metrics TEXT;
`;

// Terraform registries and modules migration
export const TERRAFORM_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "terraform_registries" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "org_name" TEXT NOT NULL,
  "token_setting_key" TEXT NOT NULL,
  "status" TEXT DEFAULT 'active',
  "last_synced_at" TEXT,
  "sync_error" TEXT,
  "module_count" INTEGER DEFAULT 0,
  "sync_interval_minutes" INTEGER,
  "next_sync_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "terraform_modules" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "registry_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "description" TEXT,
  "readme" TEXT,
  "inputs" TEXT,
  "outputs" TEXT,
  "dependencies" TEXT,
  "published_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tf_modules_registry ON terraform_modules(registry_id);
CREATE INDEX IF NOT EXISTS idx_tf_modules_provider ON terraform_modules(provider);
CREATE INDEX IF NOT EXISTS idx_tf_modules_name ON terraform_modules(name);
`;

export const SANDBOX_CONTAINER_ID_MIGRATION_SQL = `ALTER TABLE sessions ADD COLUMN sandbox_container_id TEXT;`;

// Event system migration (event sources, subscriptions, event log)
export const EVENT_SYSTEM_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "event_sources" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "webhook_secret" TEXT,
  "is_enabled" INTEGER DEFAULT 1 NOT NULL,
  "config" TEXT DEFAULT '{}',
  "event_count" INTEGER DEFAULT 0 NOT NULL,
  "last_event_at" TEXT,
  "status" TEXT DEFAULT 'active' NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_sources_team_idx" ON "event_sources"("team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_sources_slug_idx" ON "event_sources"("slug");

CREATE TABLE IF NOT EXISTS "event_subscriptions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "event_source_id" TEXT NOT NULL REFERENCES "event_sources"("id") ON DELETE CASCADE,
  "target_project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "is_enabled" INTEGER DEFAULT 1 NOT NULL,
  "event_types" TEXT DEFAULT '[]',
  "filters" TEXT DEFAULT '[]',
  "prompt_template" TEXT NOT NULL,
  "auto_start_agent" INTEGER DEFAULT 0 NOT NULL,
  "task_column" TEXT DEFAULT 'backlog' NOT NULL,
  "task_priority" TEXT DEFAULT 'medium' NOT NULL,
  "task_labels" TEXT DEFAULT '[]',
  "matched_count" INTEGER DEFAULT 0 NOT NULL,
  "last_matched_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_subscriptions_source_idx" ON "event_subscriptions"("event_source_id");
CREATE INDEX IF NOT EXISTS "event_subscriptions_project_idx" ON "event_subscriptions"("target_project_id");
CREATE INDEX IF NOT EXISTS "event_subscriptions_source_enabled_idx" ON "event_subscriptions"("event_source_id", "is_enabled");

CREATE TABLE IF NOT EXISTS "event_log" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "event_source_id" TEXT REFERENCES "event_sources"("id") ON DELETE SET NULL,
  "event_type" TEXT NOT NULL,
  "action" TEXT,
  "status" TEXT DEFAULT 'received' NOT NULL,
  "payload" TEXT DEFAULT '{}',
  "matched_subscriptions" TEXT DEFAULT '[]',
  "error" TEXT,
  "delivery_id" TEXT NOT NULL,
  "received_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "processed_at" TEXT
);

CREATE INDEX IF NOT EXISTS "event_log_source_idx" ON "event_log"("event_source_id");
CREATE INDEX IF NOT EXISTS "event_log_received_at_idx" ON "event_log"("received_at");
CREATE INDEX IF NOT EXISTS "event_log_source_status_idx" ON "event_log"("event_source_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "event_log_delivery_idx" ON "event_log"("event_source_id", "delivery_id");
`;

// Schedule executions migration (tracks cron/scheduled task executions)
export const SCHEDULE_EXECUTIONS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schedule_executions (
  id TEXT PRIMARY KEY,
  event_source_id TEXT NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  subscription_id TEXT REFERENCES event_subscriptions(id) ON DELETE SET NULL,
  budget_window TEXT,
  window_execution_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS schedule_executions_event_source_idx ON schedule_executions(event_source_id);
CREATE INDEX IF NOT EXISTS schedule_executions_source_status_idx ON schedule_executions(event_source_id, status);
CREATE INDEX IF NOT EXISTS schedule_executions_source_executed_at_idx ON schedule_executions(event_source_id, executed_at);
CREATE INDEX IF NOT EXISTS schedule_executions_source_scheduled_at_idx ON schedule_executions(event_source_id, scheduled_at);
`;

// Performance indexes migration
export const PERFORMANCE_INDEXES_MIGRATION_SQL = `
-- Index for looking up tasks by agent
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);

-- Composite index for Kanban board queries (project + column + position)
CREATE INDEX IF NOT EXISTS idx_tasks_kanban ON tasks(project_id, column, position);

-- Index for worktree lookup by project
CREATE INDEX IF NOT EXISTS idx_worktrees_project_id ON worktrees(project_id);

-- Index for agents by project
CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id);
`;

// DB-008 + DB-009: Remove redundant index and add missing indexes
// for sessions, agent_runs, and audit_logs lookup columns.
export const DB_REVIEW_INDEXES_MIGRATION_SQL = `
-- DB-008: Remove redundant session_events_offset_idx (covered by session_events_unique_offset)
DROP INDEX IF EXISTS session_events_offset_idx;

-- DB-009: Add index on sessions(project_id) for project-scoped session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

-- DB-009: Add indexes on agent_runs for lookup by agent, project, and task
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_id ON agent_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id ON agent_runs(task_id);

-- DB-009: Add indexes on audit_logs for lookup by agent, project, task, and time
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent_id ON audit_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project_id ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_task_id ON audit_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
`;

// RBAC tables migration (idempotent — uses IF NOT EXISTS)
export const RBAC_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "github_id" INTEGER NOT NULL UNIQUE,
  "github_login" TEXT NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "github_email" TEXT,
  "avatar_url" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "teams" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "joined_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "team_projects" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "project_id")
);

CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "granted_by_team_id" TEXT REFERENCES "teams"("id") ON DELETE SET NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("project_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "tags" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#6B7280',
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tags_team_name_unique" ON "tags"("team_id", "name");

CREATE TABLE IF NOT EXISTS "project_tags" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("project_id", "tag_id")
);

CREATE TABLE IF NOT EXISTS "task_tags" (
  "task_id" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("task_id", "tag_id")
);

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "token_prefix" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "scope_tags" TEXT,
  "scope_project_id" TEXT REFERENCES "projects"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TEXT,
  "last_used_at" TEXT,
  "use_count" INTEGER DEFAULT 0,
  "revoked_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS "team_invitations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "invited_by" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

-- RBAC performance indexes
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_projects_project ON team_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_team ON api_tokens(team_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_status ON api_tokens(status);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_team ON team_invitations(team_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_email ON team_invitations(email);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
CREATE INDEX IF NOT EXISTS "idx_team_invitations_team_email_status" ON "team_invitations" ("team_id", "email", "status");

-- Additional RBAC indexes for query performance
CREATE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login);
CREATE INDEX IF NOT EXISTS idx_tags_team ON tags(team_id);
CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id);
`;

// RBAC schema additions for existing databases where CREATE TABLE IF NOT EXISTS
// won't add new columns to already-existing tables. Each ALTER TABLE is run
// individually wrapped in try/catch so partial failures don't block others.
export const RBAC_SCHEMA_ADDITIONS = [
  `ALTER TABLE tags ADD COLUMN "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL`,
  `ALTER TABLE project_tags ADD COLUMN "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL`,
  `ALTER TABLE task_tags ADD COLUMN "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL`,
  `ALTER TABLE api_tokens ADD COLUMN "use_count" INTEGER DEFAULT 0`,
  // GitHub email for invitation verification (immutable by user, set only during OAuth)
  `ALTER TABLE users ADD COLUMN "github_email" TEXT`,
];

// GitHub token team_id column migration (extracted for reuse)
export const RBAC_GITHUB_TOKEN_MIGRATION_SQL = `ALTER TABLE github_tokens ADD COLUMN team_id TEXT REFERENCES "teams"("id") ON DELETE SET NULL`;

// ---------------------------------------------------------------------------
// Memory service tables (v22)
// ---------------------------------------------------------------------------

export const MEMORY_TABLES_MIGRATION_SQL = `
-- Memory insights (replaces Honcho conclusions)
CREATE TABLE IF NOT EXISTS "memory_insights" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "content" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_session_id" TEXT REFERENCES "sessions"("id") ON DELETE SET NULL,
  "skill_id" TEXT,
  "tags" TEXT DEFAULT '[]',
  "metadata" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_memory_insights_codespace_id" ON "memory_insights"("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_memory_insights_skill_id" ON "memory_insights"("skill_id");
CREATE INDEX IF NOT EXISTS "idx_memory_insights_source_session_id" ON "memory_insights"("source_session_id");

-- Memory messages (captured agent turns)
CREATE TABLE IF NOT EXISTS "memory_messages" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "memory_session_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "task_id" TEXT REFERENCES "tasks"("id") ON DELETE SET NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "turn_number" INTEGER NOT NULL,
  "metadata" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_memory_messages_codespace_id" ON "memory_messages"("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_memory_messages_memory_session_id" ON "memory_messages"("memory_session_id");
CREATE INDEX IF NOT EXISTS "idx_memory_messages_task_id" ON "memory_messages"("task_id");

-- Skill executions (per-run skill tracking)
CREATE TABLE IF NOT EXISTS "skill_executions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "skill_id" TEXT NOT NULL,
  "skill_name" TEXT,
  "task_id" TEXT REFERENCES "tasks"("id") ON DELETE SET NULL,
  "agent_run_id" TEXT REFERENCES "agent_runs"("id") ON DELETE SET NULL,
  "session_id" TEXT REFERENCES "sessions"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL,
  "turns_used" INTEGER,
  "tokens_used" INTEGER,
  "duration_ms" INTEGER,
  "files_modified" INTEGER,
  "lines_added" INTEGER,
  "lines_removed" INTEGER,
  "cost_usd" REAL,
  "error_message" TEXT,
  "started_at" TEXT,
  "completed_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_skill_executions_codespace_id" ON "skill_executions"("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_skill_id" ON "skill_executions"("skill_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_task_id" ON "skill_executions"("task_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_agent_run_id" ON "skill_executions"("agent_run_id");

-- Skill metrics (aggregated, materialized view)
CREATE TABLE IF NOT EXISTS "skill_metrics" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "skill_id" TEXT NOT NULL,
  "skill_name" TEXT NOT NULL,
  "total_runs" INTEGER DEFAULT 0 NOT NULL,
  "success_count" INTEGER DEFAULT 0 NOT NULL,
  "error_count" INTEGER DEFAULT 0 NOT NULL,
  "avg_tokens_used" REAL,
  "avg_turns_used" REAL,
  "avg_duration_ms" REAL,
  "avg_cost_usd" REAL,
  "success_rate" REAL,
  "last_run_at" TEXT,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "skill_metrics_codespace_skill_unique" ON "skill_metrics"("codespace_id", "skill_id");

-- Dream sessions (dreaming execution log)
CREATE TABLE IF NOT EXISTS "dream_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "skills_analyzed" INTEGER DEFAULT 0 NOT NULL,
  "suggestions_generated" INTEGER DEFAULT 0 NOT NULL,
  "tokens_used" INTEGER DEFAULT 0 NOT NULL,
  "cost_usd" REAL,
  "started_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "completed_at" TEXT,
  "error_message" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_dream_sessions_codespace_id" ON "dream_sessions"("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_dream_sessions_status" ON "dream_sessions"("status");

-- Skill suggestions (human-in-the-loop dreaming output)
CREATE TABLE IF NOT EXISTS "skill_suggestions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "dream_session_id" TEXT NOT NULL REFERENCES "dream_sessions"("id") ON DELETE CASCADE,
  "codespace_id" TEXT NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
  "skill_id" TEXT NOT NULL,
  "skill_name" TEXT NOT NULL,
  "suggestion_type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "reasoning" TEXT NOT NULL,
  "current_content" TEXT,
  "suggested_content" TEXT NOT NULL,
  "diff" TEXT,
  "status" TEXT DEFAULT 'pending' NOT NULL,
  "user_notes" TEXT,
  "applied_at" TEXT,
  "applied_by" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_dream_session_id" ON "skill_suggestions"("dream_session_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_codespace_id" ON "skill_suggestions"("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_skill_id" ON "skill_suggestions"("skill_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_status" ON "skill_suggestions"("status");
`;

/**
 * Interface for raw SQLite database objects that support prepare/exec.
 * Compatible with both better-sqlite3 (bootstrap) and bun:sqlite (api.ts).
 */
export interface RawSQLiteDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/**
 * Seeds a default team for existing installations that have github_tokens
 * but no teams. This migrates pre-RBAC installations by:
 * 1. Creating a "Default Team" with slug "default"
 * 2. Associating all orphaned github_tokens (team_id IS NULL) with it
 * 3. Assigning all existing projects to the default team via team_projects
 *
 * This function is idempotent: it only runs when the teams table is empty
 * AND there are github_tokens without a team_id.
 */
export function seedDefaultTeamForExistingTokens(db: RawSQLiteDatabase): void {
  const teamCount = db.prepare('SELECT COUNT(*) as count FROM teams').get() as { count: number };
  const orphanedTokens = db
    .prepare('SELECT COUNT(*) as count FROM github_tokens WHERE team_id IS NULL')
    .get() as { count: number };

  if (teamCount.count === 0 && orphanedTokens.count > 0) {
    const defaultTeamId = createId();

    // Create the default team
    db.prepare(
      `INSERT INTO teams (id, name, slug, description, created_at, updated_at)
       VALUES (?, 'Default Team', 'default', 'Auto-created during RBAC migration', datetime('now'), datetime('now'))`
    ).run(defaultTeamId);

    // Associate orphaned github_tokens with the default team
    db.prepare('UPDATE github_tokens SET team_id = ? WHERE team_id IS NULL').run(defaultTeamId);

    // Assign all existing projects to the default team
    const existingProjects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
    const insertTeamProject = db.prepare(
      `INSERT OR IGNORE INTO team_projects (team_id, project_id, assigned_at)
       VALUES (?, ?, datetime('now'))`
    );
    for (const project of existingProjects) {
      insertTeamProject.run(defaultTeamId, project.id);
    }

    log.info('Created default team and associated tokens/projects', {
      data: {
        teamId: defaultTeamId,
        tokenCount: orphanedTokens.count,
        projectCount: existingProjects.length,
      },
    });
  }
}

export const validateSchema = async (ctx: BootstrapContext) => {
  if (!ctx.db) {
    return err(createError('BOOTSTRAP_NO_DATABASE', 'Database not initialized', 500));
  }

  try {
    // Run all migrations via the consolidated runner
    const { MIGRATIONS } = await import('../migrations/index.js');
    const { runMigrations } = await import('../migrations/runner.js');
    runMigrations(ctx.db, MIGRATIONS);

    // Seed default team for pre-RBAC installations with orphaned tokens
    seedDefaultTeamForExistingTokens(ctx.db);

    // Verify core tables exist using SQLite syntax
    const result = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as { name: string } | undefined;

    if (!result?.name) {
      return err(
        createError(
          'BOOTSTRAP_SCHEMA_VALIDATION_FAILED',
          'Projects table not found after migration',
          500
        )
      );
    }

    // Verify all 11 RBAC tables exist after migration
    const RBAC_TABLES = [
      'users',
      'user_sessions',
      'teams',
      'team_members',
      'team_projects',
      'project_members',
      'tags',
      'project_tags',
      'task_tags',
      'api_tokens',
      'team_invitations',
    ] as const;

    const existingTables = ctx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RBAC_TABLES.map(() => '?').join(', ')})`
      )
      .all(...RBAC_TABLES) as { name: string }[];

    const existingTableNames = new Set(existingTables.map((t) => t.name));
    const missingTables = RBAC_TABLES.filter((t) => !existingTableNames.has(t));

    if (missingTables.length > 0) {
      return err(
        createError(
          'BOOTSTRAP_SCHEMA_VALIDATION_FAILED',
          `RBAC tables missing after migration: ${missingTables.join(', ')}`,
          500
        )
      );
    }

    return ok(undefined);
  } catch (error) {
    log.error('Migration failed', { error });
    return err(
      createError('BOOTSTRAP_SCHEMA_VALIDATION_FAILED', 'Schema migration failed', 500, {
        error: String(error),
      })
    );
  }
};
