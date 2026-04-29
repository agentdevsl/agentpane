-- F04-08 (arch29-W2-E): Sandbox UNIQUE lifecycle fix.
--
-- The original schema declared `codespace_id UNIQUE` on `sandbox_instances`,
-- which made the natural stop -> create lifecycle impossible: once a sandbox
-- was stopped, the next `SandboxService.create()` for the same codespace
-- failed with a unique-constraint violation on the still-present row, even
-- though the intent was "at most one *active* sandbox per codespace".
--
-- Fix: drop the global UNIQUE on `codespace_id` and replace it with a
-- partial unique index that fires only while the sandbox is in an active
-- status. Stopped/error rows can coexist freely so the stop -> create
-- lifecycle works.

-- Drop the old UNIQUE constraint. PG names it via the column's `.unique()`
-- declaration: `<table>_<column>_unique`. The DROP is idempotent because
-- IF EXISTS swallows the absence in case a prior migration already removed it.
ALTER TABLE "sandbox_instances" DROP CONSTRAINT IF EXISTS "sandbox_instances_codespace_id_unique";

-- Install the partial unique index. Active = rows whose status indicates the
-- sandbox is alive or transitioning toward alive.
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_instances_codespace_active_unique"
  ON "sandbox_instances" ("codespace_id")
  WHERE status IN ('creating', 'running', 'idle', 'stopping');
