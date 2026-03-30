-- 0005_memory_insight_status_category.sql
-- Add status, category, updated_at columns to memory_insights
-- and insight_ids_used to skill_executions (matches SQLite migration v27).

ALTER TABLE "memory_insights" ADD COLUMN "status" text NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "memory_insights" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "memory_insights" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_memory_insights_status" ON "memory_insights" ("status");--> statement-breakpoint
ALTER TABLE "skill_executions" ADD COLUMN "insight_ids_used" jsonb;
