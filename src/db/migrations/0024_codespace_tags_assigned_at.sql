-- F02-19 (arch29-W2-Q): codespace_tags.assigned_at missing in SQLite.
--
-- Drizzle declares `assigned_at` as `text('assigned_at').default(sql\`(datetime('now'))\`).notNull()`
-- (`src/db/schema/sqlite/codespace-tags.ts:15`) but the v19 inline migration creates the table
-- without the column (`v19-project-folders.ts:84-88`). On SQLite, INSERTs succeed because Drizzle
-- supplies a JS-side default, but SELECTs return `undefined` while the type system claims `string`.
-- PG already has the column (created in `0004_schema_catchup.sql`).
--
-- Fix: add the missing column with the same default. Existing rows backfill to the current time.
-- The actual SQLite migration runs through the bootstrap MIGRATIONS array
-- (v38: codespace-tags-assigned-at). This file is the drizzle-kit equivalent for documentation
-- parity with the runtime migration chain.

ALTER TABLE `codespace_tags` ADD COLUMN `assigned_at` TEXT NOT NULL DEFAULT (datetime('now'));
