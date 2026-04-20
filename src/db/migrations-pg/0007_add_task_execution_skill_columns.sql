-- 0007_add_task_execution_skill_columns.sql
-- Add execution skill columns for skill chaining (plan → implement).
-- Mirrors SQLite migration 0014_add_task_execution_skill_columns.sql.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "execution_skill_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "execution_skill_name" text;
