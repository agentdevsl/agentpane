-- Add agent approval mode columns to tasks table
ALTER TABLE tasks ADD COLUMN approval_mode TEXT;
ALTER TABLE tasks ADD COLUMN agent_review_result TEXT;
ALTER TABLE tasks ADD COLUMN agent_reviewed_at TEXT;
