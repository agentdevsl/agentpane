-- F02-19 (arch29-W2-Q): codespace_tags.assigned_at parity with SQLite.
-- Mirrors SQLite migration 0024_codespace_tags_assigned_at.sql.
--
-- Postgres already has the column (created in `0004_schema_catchup.sql:88,355`
-- as `"assigned_at" timestamp DEFAULT now() NOT NULL`). This migration is
-- effectively a no-op on PG; using `ADD COLUMN IF NOT EXISTS` keeps the
-- migration idempotent and the parity check happy.

ALTER TABLE "codespace_tags" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp DEFAULT now() NOT NULL;
