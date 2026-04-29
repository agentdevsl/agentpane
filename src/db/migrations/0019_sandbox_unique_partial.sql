-- F04-08 (arch29-W2-E): Sandbox UNIQUE lifecycle fix.
--
-- The original schema declared `codespace_id UNIQUE` on `sandbox_instances`,
-- which made the natural stop -> create lifecycle impossible: once a sandbox
-- was stopped, the next `SandboxService.create()` for the same codespace
-- failed with SQLITE_CONSTRAINT_UNIQUE on the still-present row, even though
-- the intent was "at most one *active* sandbox per codespace".
--
-- Fix: drop the column-level UNIQUE on `codespace_id` and replace it with a
-- partial unique index that fires only while the sandbox is in an active
-- status. Stopped/error rows can coexist freely so the stop -> create
-- lifecycle works.
--
-- The actual SQLite migration runs through the bootstrap MIGRATIONS array
-- (v33: sandbox-unique-partial-index). This file is the drizzle-kit
-- equivalent for documentation parity. SQLite cannot drop a column-level
-- UNIQUE in place; the bootstrap migration rebuilds the table.
--> statement-breakpoint
DROP INDEX IF EXISTS `sandbox_instances_project_id_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `sandbox_instances_codespace_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sandbox_instances_codespace_active_unique`
  ON `sandbox_instances` (`codespace_id`)
  WHERE status IN ('creating', 'running', 'idle', 'stopping');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sandbox_instances_status_idx` ON `sandbox_instances` (`status`);
