-- Add execution skill columns for skill chaining (plan → implement)
ALTER TABLE tasks ADD COLUMN execution_skill_id TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN execution_skill_name TEXT;
