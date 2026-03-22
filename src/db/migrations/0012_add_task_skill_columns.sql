-- Add skill columns to tasks for skill-centric task architecture
ALTER TABLE tasks ADD COLUMN skill_id TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN skill_name TEXT;
