-- 0009_add_agent_approval_columns.sql
-- Add agent approval-mode columns to tasks.
-- Mirrors SQLite migration 0016_add_agent_approval_columns.sql.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "approval_mode" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent_review_result" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent_reviewed_at" timestamp;
