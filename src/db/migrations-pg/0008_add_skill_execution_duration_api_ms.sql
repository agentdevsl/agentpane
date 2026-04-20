-- 0008_add_skill_execution_duration_api_ms.sql
-- Add API-only duration tracking to skill_executions and skill_metrics.
-- Mirrors SQLite migration 0015_add_skill_execution_duration_api_ms.sql.

ALTER TABLE "skill_executions" ADD COLUMN IF NOT EXISTS "duration_api_ms" integer;--> statement-breakpoint
ALTER TABLE "skill_metrics" ADD COLUMN IF NOT EXISTS "avg_duration_api_ms" double precision;
