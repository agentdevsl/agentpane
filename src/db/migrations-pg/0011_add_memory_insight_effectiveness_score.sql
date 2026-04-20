-- 0011_add_memory_insight_effectiveness_score.sql
-- Add memory_insights.effectiveness_score, mirroring SQLite migration v28.
-- Surfaced by the F02-13 PG migration-safety test.

ALTER TABLE "memory_insights" ADD COLUMN IF NOT EXISTS "effectiveness_score" double precision;
