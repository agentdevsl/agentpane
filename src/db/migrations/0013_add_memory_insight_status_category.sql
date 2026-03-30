-- Add status, category, and updated_at columns to memory_insights
-- for insight lifecycle management (active/pending_review/rejected),
-- categorization, and consolidation tracking.
ALTER TABLE memory_insights ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE memory_insights ADD COLUMN category TEXT;
--> statement-breakpoint
ALTER TABLE memory_insights ADD COLUMN updated_at TEXT;
--> statement-breakpoint
CREATE INDEX idx_memory_insights_status ON memory_insights(status);
--> statement-breakpoint
-- Add insight_ids_used to skill_executions for tracking which insights
-- were injected into agent context during execution.
ALTER TABLE skill_executions ADD COLUMN insight_ids_used TEXT;
