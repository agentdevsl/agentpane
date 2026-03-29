-- 0004_schema_catchup.sql
-- Comprehensive catch-up migration to bring PostgreSQL schema in line with
-- the current Drizzle schema (equivalent to SQLite migrations v4 through v25).
--
-- Major changes:
--   1. Rename projects -> codespaces (and all FK columns project_id -> codespace_id)
--   2. Rename template_projects -> template_codespaces (and column renames)
--   3. Create all missing tables (users, teams, folders, events, memory, skills, etc.)
--   4. Add missing columns to existing tables
--   5. Add missing indexes

BEGIN;

-- ============================================================================
-- SECTION 1: Create prerequisite tables (needed before FK references)
-- ============================================================================

-- 1a. users
CREATE TABLE IF NOT EXISTS "users" (
    "id" text PRIMARY KEY NOT NULL,
    "github_id" integer NOT NULL UNIQUE,
    "github_login" text NOT NULL,
    "name" text,
    "email" text,
    "github_email" text,
    "avatar_url" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 1b. teams
CREATE TABLE IF NOT EXISTS "teams" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "slug" text NOT NULL UNIQUE,
    "description" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 1c. project_folders
CREATE TABLE IF NOT EXISTS "project_folders" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "slug" text NOT NULL UNIQUE,
    "description" text,
    "icon" text NOT NULL DEFAULT 'Folder',
    "color" text NOT NULL DEFAULT '#6B7280',
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 1d. user_sessions
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "token" text NOT NULL UNIQUE,
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- 1e. team_members
CREATE TABLE IF NOT EXISTS "team_members" (
    "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text NOT NULL DEFAULT 'viewer',
    "joined_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("team_id", "user_id")
);

-- 1f. team_invitations
CREATE TABLE IF NOT EXISTS "team_invitations" (
    "id" text PRIMARY KEY NOT NULL,
    "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "invited_by" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "email" text NOT NULL,
    "role" text NOT NULL DEFAULT 'viewer',
    "token" text NOT NULL UNIQUE,
    "status" text NOT NULL DEFAULT 'pending',
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- 1g. team_project_folders
CREATE TABLE IF NOT EXISTS "team_project_folders" (
    "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "project_folder_id" text NOT NULL REFERENCES "project_folders"("id") ON DELETE CASCADE,
    "assigned_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("team_id", "project_folder_id")
);

-- 1h. folder_members
CREATE TABLE IF NOT EXISTS "folder_members" (
    "project_folder_id" text NOT NULL REFERENCES "project_folders"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "granted_by_team_id" text REFERENCES "teams"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("project_folder_id", "user_id")
);

-- ============================================================================
-- SECTION 2: Rename projects -> codespaces
-- ============================================================================

-- 2a. Drop all foreign key constraints referencing "projects"
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_project_id_projects_id_fk";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_project_id_projects_id_fk";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_project_id_projects_id_fk";
ALTER TABLE "plan_sessions" DROP CONSTRAINT IF EXISTS "plan_sessions_project_id_projects_id_fk";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_github_installation_id_github_installations_id_fk";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_sandbox_config_id_sandbox_configs_id_fk";
ALTER TABLE "sandbox_instances" DROP CONSTRAINT IF EXISTS "sandbox_instances_project_id_projects_id_fk";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_project_id_projects_id_fk";
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_project_id_projects_id_fk";
ALTER TABLE "template_projects" DROP CONSTRAINT IF EXISTS "template_projects_project_id_projects_id_fk";
ALTER TABLE "template_projects" DROP CONSTRAINT IF EXISTS "template_projects_template_id_templates_id_fk";
ALTER TABLE "templates" DROP CONSTRAINT IF EXISTS "templates_project_id_projects_id_fk";
ALTER TABLE "worktrees" DROP CONSTRAINT IF EXISTS "worktrees_project_id_projects_id_fk";

-- 2b. Drop unique constraint on projects.path before rename
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_path_unique";

-- 2c. Rename the table
ALTER TABLE "projects" RENAME TO "codespaces";

-- 2d. Add project_folder_id column to codespaces (nullable first for backfill)
ALTER TABLE "codespaces" ADD COLUMN IF NOT EXISTS "project_folder_id" text;

-- 2d-i. Create a default project folder for existing codespaces
INSERT INTO "project_folders" ("id", "name", "slug", "description")
SELECT 'default_folder', 'Default', 'default', 'Auto-created for existing codespaces'
WHERE NOT EXISTS (SELECT 1 FROM "project_folders" WHERE "id" = 'default_folder');

-- 2d-ii. Backfill project_folder_id for existing codespaces
UPDATE "codespaces" SET "project_folder_id" = 'default_folder' WHERE "project_folder_id" IS NULL;

-- 2d-iii. Set NOT NULL constraint to match Drizzle schema
ALTER TABLE "codespaces" ALTER COLUMN "project_folder_id" SET NOT NULL;

-- 2e. Re-add unique constraint on codespaces.path
ALTER TABLE "codespaces" ADD CONSTRAINT "codespaces_path_unique" UNIQUE ("path");

-- 2f. Rename project_id -> codespace_id in all referencing tables
ALTER TABLE "agent_runs" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "agents" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "audit_logs" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "plan_sessions" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "sandbox_instances" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "sessions" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "tasks" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "worktrees" RENAME COLUMN "project_id" TO "codespace_id";

-- Also rename unique constraint on sandbox_instances
ALTER TABLE "sandbox_instances" DROP CONSTRAINT IF EXISTS "sandbox_instances_project_id_unique";
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_codespace_id_unique" UNIQUE ("codespace_id");

-- 2g. Re-create all FK constraints pointing to "codespaces"
ALTER TABLE "codespaces" ADD CONSTRAINT "codespaces_project_folder_id_project_folders_id_fk"
    FOREIGN KEY ("project_folder_id") REFERENCES "project_folders"("id") ON DELETE CASCADE;
ALTER TABLE "codespaces" ADD CONSTRAINT "codespaces_github_installation_id_github_installations_id_fk"
    FOREIGN KEY ("github_installation_id") REFERENCES "github_installations"("id") ON DELETE SET NULL;
ALTER TABLE "codespaces" ADD CONSTRAINT "codespaces_sandbox_config_id_sandbox_configs_id_fk"
    FOREIGN KEY ("sandbox_config_id") REFERENCES "sandbox_configs"("id") ON DELETE SET NULL;

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;

-- Re-add non-project FK constraints that were dropped
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_agent_run_id_agent_runs_id_fk"
    FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;

ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_session_id_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_worktree_id_worktrees_id_fk"
    FOREIGN KEY ("worktree_id") REFERENCES "worktrees"("id") ON DELETE SET NULL;

ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;

-- ============================================================================
-- SECTION 3: Rename template_projects -> template_codespaces
-- ============================================================================

-- 3a. Drop template_projects and recreate as template_codespaces
-- (Rename table + rename column)
ALTER TABLE "template_projects" RENAME TO "template_codespaces";
ALTER TABLE "template_codespaces" RENAME COLUMN "project_id" TO "codespace_id";

-- Drop old PK constraint and add new one
ALTER TABLE "template_codespaces" DROP CONSTRAINT IF EXISTS "template_projects_template_id_project_id_pk";
ALTER TABLE "template_codespaces" ADD PRIMARY KEY ("template_id", "codespace_id");

-- Re-add FK constraints
ALTER TABLE "template_codespaces" ADD CONSTRAINT "template_codespaces_template_id_templates_id_fk"
    FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE;
ALTER TABLE "template_codespaces" ADD CONSTRAINT "template_codespaces_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;

-- ============================================================================
-- SECTION 3b: Update templates table - rename project_id -> codespace_id
-- ============================================================================

ALTER TABLE "templates" RENAME COLUMN "project_id" TO "codespace_id";
ALTER TABLE "templates" ADD CONSTRAINT "templates_codespace_id_codespaces_id_fk"
    FOREIGN KEY ("codespace_id") REFERENCES "codespaces"("id") ON DELETE CASCADE;

-- ============================================================================
-- SECTION 4: Add missing columns to existing tables
-- ============================================================================

-- 4a. github_installations: add team_id
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "team_id" text
    REFERENCES "teams"("id") ON DELETE SET NULL;

-- 4b. sessions: add sandbox_provider and sandbox_container_id
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "sandbox_provider" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "sandbox_container_id" text;

-- 4c. agents: add parent_agent_id
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "parent_agent_id" text;

-- 4d. tasks: add skill_id and skill_name
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "skill_id" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "skill_name" text;

-- 4e. session_summaries: add cost_usd, duration_api_ms, cache_read_tokens, cache_creation_tokens, stop_reason
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "cost_usd" double precision;
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "duration_api_ms" integer;
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "cache_creation_tokens" integer;
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "stop_reason" text;

-- ============================================================================
-- SECTION 5: Create codespace_members (formerly project_members concept)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "codespace_members" (
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "granted_by_team_id" text REFERENCES "teams"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("codespace_id", "user_id")
);

-- ============================================================================
-- SECTION 6: Create api_tokens
-- ============================================================================

CREATE TABLE IF NOT EXISTS "api_tokens" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "token_hash" text NOT NULL UNIQUE,
    "token_prefix" text NOT NULL,
    "role" text NOT NULL,
    "scope_tags" jsonb,
    "scope_codespace_id" text REFERENCES "codespaces"("id") ON DELETE SET NULL,
    "status" text NOT NULL DEFAULT 'active',
    "expires_at" timestamp,
    "use_count" integer DEFAULT 0,
    "last_used_at" timestamp,
    "revoked_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- ============================================================================
-- SECTION 7: Create tags, codespace_tags, task_tags
-- ============================================================================

CREATE TABLE IF NOT EXISTS "tags" (
    "id" text PRIMARY KEY NOT NULL,
    "project_folder_id" text NOT NULL REFERENCES "project_folders"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "color" text NOT NULL DEFAULT '#6B7280',
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tags_folder_name_unique" ON "tags" ("project_folder_id", "name");

CREATE TABLE IF NOT EXISTS "codespace_tags" (
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "tag_id" text NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
    "assigned_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("codespace_id", "tag_id")
);

CREATE TABLE IF NOT EXISTS "task_tags" (
    "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
    "tag_id" text NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
    "assigned_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("task_id", "tag_id")
);

-- ============================================================================
-- SECTION 8: Create event_sources, event_subscriptions, event_log, schedule_executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS "event_sources" (
    "id" text PRIMARY KEY NOT NULL,
    "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "slug" text NOT NULL UNIQUE,
    "webhook_secret" text,
    "is_enabled" boolean NOT NULL DEFAULT true,
    "config" jsonb DEFAULT '{}',
    "event_count" integer NOT NULL DEFAULT 0,
    "last_event_at" timestamp,
    "github_installation_id" text REFERENCES "github_installations"("id") ON DELETE SET NULL,
    "status" text NOT NULL DEFAULT 'active',
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_sources_team_idx" ON "event_sources" ("team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_sources_slug_idx" ON "event_sources" ("slug");

CREATE TABLE IF NOT EXISTS "event_subscriptions" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "event_source_id" text NOT NULL REFERENCES "event_sources"("id") ON DELETE CASCADE,
    "target_codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "is_enabled" boolean NOT NULL DEFAULT true,
    "event_types" jsonb DEFAULT '[]',
    "filters" jsonb DEFAULT '[]',
    "prompt_template" text NOT NULL,
    "auto_start_agent" boolean NOT NULL DEFAULT false,
    "task_column" text NOT NULL DEFAULT 'backlog',
    "task_priority" text NOT NULL DEFAULT 'medium',
    "task_labels" jsonb DEFAULT '[]',
    "matched_count" integer NOT NULL DEFAULT 0,
    "last_matched_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_subscriptions_source_idx" ON "event_subscriptions" ("event_source_id");
CREATE INDEX IF NOT EXISTS "event_subscriptions_codespace_idx" ON "event_subscriptions" ("target_codespace_id");
CREATE INDEX IF NOT EXISTS "event_subscriptions_source_enabled_idx" ON "event_subscriptions" ("event_source_id", "is_enabled");

CREATE TABLE IF NOT EXISTS "event_log" (
    "id" text PRIMARY KEY NOT NULL,
    "event_source_id" text REFERENCES "event_sources"("id") ON DELETE SET NULL,
    "event_type" text NOT NULL,
    "action" text,
    "status" text NOT NULL DEFAULT 'received',
    "payload" jsonb DEFAULT '{}',
    "matched_subscriptions" jsonb DEFAULT '[]',
    "error" text,
    "delivery_id" text NOT NULL,
    "received_at" timestamp DEFAULT now() NOT NULL,
    "processed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "event_log_source_idx" ON "event_log" ("event_source_id");
CREATE INDEX IF NOT EXISTS "event_log_received_at_idx" ON "event_log" ("received_at");
CREATE INDEX IF NOT EXISTS "event_log_source_status_idx" ON "event_log" ("event_source_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "event_log_delivery_idx" ON "event_log" ("event_source_id", "delivery_id");

CREATE TABLE IF NOT EXISTS "schedule_executions" (
    "id" text PRIMARY KEY NOT NULL,
    "event_source_id" text NOT NULL REFERENCES "event_sources"("id") ON DELETE CASCADE,
    "status" text NOT NULL,
    "scheduled_at" timestamp NOT NULL,
    "executed_at" timestamp NOT NULL,
    "task_id" text REFERENCES "tasks"("id") ON DELETE SET NULL,
    "subscription_id" text REFERENCES "event_subscriptions"("id") ON DELETE SET NULL,
    "budget_window" text,
    "window_execution_count" integer NOT NULL DEFAULT 0,
    "error" text,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "schedule_executions_event_source_idx" ON "schedule_executions" ("event_source_id");
CREATE INDEX IF NOT EXISTS "schedule_executions_source_status_idx" ON "schedule_executions" ("event_source_id", "status");
CREATE INDEX IF NOT EXISTS "schedule_executions_source_executed_at_idx" ON "schedule_executions" ("event_source_id", "executed_at");
CREATE INDEX IF NOT EXISTS "schedule_executions_source_scheduled_at_idx" ON "schedule_executions" ("event_source_id", "scheduled_at");

-- ============================================================================
-- SECTION 9: Create memory tables (memory_insights, memory_messages)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "memory_insights" (
    "id" text PRIMARY KEY NOT NULL,
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "content" text NOT NULL,
    "source" text NOT NULL,
    "source_session_id" text REFERENCES "sessions"("id") ON DELETE SET NULL,
    "skill_id" text,
    "tags" jsonb DEFAULT '[]',
    "metadata" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "memory_messages" (
    "id" text PRIMARY KEY NOT NULL,
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "memory_session_id" text NOT NULL,
    "agent_id" text NOT NULL,
    "task_id" text REFERENCES "tasks"("id") ON DELETE SET NULL,
    "role" text NOT NULL,
    "content" text NOT NULL,
    "turn_number" integer NOT NULL,
    "metadata" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- ============================================================================
-- SECTION 10: Create skill tables (skill_executions, skill_metrics, dream_sessions, skill_suggestions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "skill_executions" (
    "id" text PRIMARY KEY NOT NULL,
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "skill_id" text NOT NULL,
    "skill_name" text,
    "task_id" text REFERENCES "tasks"("id") ON DELETE SET NULL,
    "agent_run_id" text REFERENCES "agent_runs"("id") ON DELETE SET NULL,
    "session_id" text REFERENCES "sessions"("id") ON DELETE SET NULL,
    "status" text NOT NULL,
    "turns_used" integer,
    "tokens_used" integer,
    "duration_ms" integer,
    "files_modified" integer,
    "lines_added" integer,
    "lines_removed" integer,
    "cost_usd" double precision,
    "error_message" text,
    "started_at" timestamp,
    "completed_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "skill_metrics" (
    "id" text PRIMARY KEY NOT NULL,
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "skill_id" text NOT NULL,
    "skill_name" text NOT NULL,
    "total_runs" integer NOT NULL DEFAULT 0,
    "success_count" integer NOT NULL DEFAULT 0,
    "error_count" integer NOT NULL DEFAULT 0,
    "avg_tokens_used" double precision,
    "avg_turns_used" double precision,
    "avg_duration_ms" double precision,
    "avg_cost_usd" double precision,
    "success_rate" double precision,
    "last_run_at" timestamp,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "skill_metrics_codespace_skill_unique"
    ON "skill_metrics" ("codespace_id", "skill_id");

CREATE TABLE IF NOT EXISTS "dream_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "codespace_id" text REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "type" text NOT NULL,
    "status" text NOT NULL,
    "skills_analyzed" integer NOT NULL DEFAULT 0,
    "suggestions_generated" integer NOT NULL DEFAULT 0,
    "tokens_used" integer NOT NULL DEFAULT 0,
    "cost_usd" double precision,
    "started_at" timestamp DEFAULT now() NOT NULL,
    "completed_at" timestamp,
    "error_message" text,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "skill_suggestions" (
    "id" text PRIMARY KEY NOT NULL,
    "dream_session_id" text NOT NULL REFERENCES "dream_sessions"("id") ON DELETE CASCADE,
    "codespace_id" text NOT NULL REFERENCES "codespaces"("id") ON DELETE CASCADE,
    "skill_id" text NOT NULL,
    "skill_name" text NOT NULL,
    "suggestion_type" text NOT NULL,
    "title" text NOT NULL,
    "reasoning" text NOT NULL,
    "current_content" text,
    "suggested_content" text NOT NULL,
    "diff" text,
    "status" text NOT NULL DEFAULT 'pending',
    "user_notes" text,
    "applied_at" timestamp,
    "applied_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- SECTION 11: Add github_tokens.team_id (matches SQLite migration v11-v12)
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "team_id" text
    REFERENCES "teams"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_github_tokens_team" ON "github_tokens" ("team_id");

-- SECTION 12: Add missing indexes from Drizzle schema
CREATE INDEX IF NOT EXISTS "session_events_created_at_idx" ON "session_events" ("created_at");

-- Memory indexes
CREATE INDEX IF NOT EXISTS "idx_memory_insights_codespace_id" ON "memory_insights" ("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_memory_insights_skill_id" ON "memory_insights" ("skill_id");
CREATE INDEX IF NOT EXISTS "idx_memory_insights_source_session_id" ON "memory_insights" ("source_session_id");
CREATE INDEX IF NOT EXISTS "idx_memory_messages_codespace_id" ON "memory_messages" ("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_memory_messages_memory_session_id" ON "memory_messages" ("memory_session_id");
CREATE INDEX IF NOT EXISTS "idx_memory_messages_task_id" ON "memory_messages" ("task_id");

-- Skill indexes
CREATE INDEX IF NOT EXISTS "idx_skill_executions_codespace_id" ON "skill_executions" ("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_skill_id" ON "skill_executions" ("skill_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_task_id" ON "skill_executions" ("task_id");
CREATE INDEX IF NOT EXISTS "idx_skill_executions_agent_run_id" ON "skill_executions" ("agent_run_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_dream_session_id" ON "skill_suggestions" ("dream_session_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_codespace_id" ON "skill_suggestions" ("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_skill_id" ON "skill_suggestions" ("skill_id");
CREATE INDEX IF NOT EXISTS "idx_skill_suggestions_status" ON "skill_suggestions" ("status");

-- Dream indexes
CREATE INDEX IF NOT EXISTS "idx_dream_sessions_codespace_id" ON "dream_sessions" ("codespace_id");
CREATE INDEX IF NOT EXISTS "idx_dream_sessions_status" ON "dream_sessions" ("status");

COMMIT;
