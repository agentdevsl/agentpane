-- 0010_add_cli_session_extended_columns.sql
-- Add extended cli_sessions columns that are declared in Drizzle but were
-- never included in any migration. Surfaced by the F02-13 PG migration-
-- safety test.
--
-- The equivalent SQLite columns are added implicitly — bun:sqlite tolerates
-- late column additions through ALTER TABLE in tests/integration and the
-- columns are optional in application code. This migration brings PG in
-- line with the Drizzle schema.

ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "cli_version" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "permission_mode" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "topology" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "queue_operations" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "tool_invocations" text;
