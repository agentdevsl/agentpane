-- F06-09: Add rotation-tracking columns to token storage tables.
-- Mirrors SQLite migration 0017_add_token_rotation_columns.sql.

ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp;
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp;
