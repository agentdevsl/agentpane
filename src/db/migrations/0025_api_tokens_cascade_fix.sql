-- F02-20 (arch29-W2-Q): SQLite api_tokens.scope_codespace_id had ON DELETE CASCADE
-- where Drizzle and Postgres declare ON DELETE SET NULL.
--
-- The v19 inline migration added the column with the wrong FK behavior:
--   ALTER TABLE api_tokens ADD COLUMN scope_codespace_id TEXT
--     REFERENCES codespaces(id) ON DELETE CASCADE
-- (`v19-project-folders.ts:149`). Drizzle (`src/db/schema/sqlite/api-tokens.ts:25`)
-- and Postgres (`src/db/migrations-pg/0004_schema_catchup.sql:328`) both declare
-- ON DELETE SET NULL, so deleting a codespace silently revokes API tokens on
-- SQLite while preserving them on Postgres.
--
-- Fix: rebuild api_tokens with the correct FK behavior. SQLite cannot ALTER
-- a foreign-key constraint in place; the rebuild pattern matches v29/v30.
--
-- The actual SQLite migration runs through the bootstrap MIGRATIONS array
-- (v39: api-tokens-cascade-fix). This file is the drizzle-kit equivalent for
-- documentation parity with the runtime migration chain.

-- Step 1: drop any leftover staging table from a partial prior run.
DROP TABLE IF EXISTS `api_tokens_new_v39`;

-- Step 2: create the rebuilt table with the correct FK behavior.
CREATE TABLE `api_tokens_new_v39` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `team_id` TEXT NOT NULL REFERENCES `teams`(`id`) ON DELETE CASCADE,
  `name` TEXT NOT NULL,
  `token_hash` TEXT NOT NULL UNIQUE,
  `token_prefix` TEXT NOT NULL,
  `role` TEXT NOT NULL,
  `scope_tags` TEXT,
  `scope_project_id` TEXT,
  `scope_codespace_id` TEXT REFERENCES `codespaces`(`id`) ON DELETE SET NULL,
  `status` TEXT NOT NULL DEFAULT 'active',
  `expires_at` TEXT,
  `rotated_at` TEXT,
  `use_count` INTEGER DEFAULT 0,
  `last_used_at` TEXT,
  `revoked_at` TEXT,
  `created_at` TEXT DEFAULT (datetime('now')) NOT NULL
);

-- Step 3: copy rows. Pre-null orphaned scope_codespace_id (FK-safe, per CLAUDE.md
-- "Migration safety"). Note: scope_codespace_id was previously CASCADE-delete'd,
-- so the only orphans would be from manual DELETEs of codespaces with FKs disabled.
INSERT INTO `api_tokens_new_v39` (
  `id`, `user_id`, `team_id`, `name`, `token_hash`, `token_prefix`, `role`,
  `scope_tags`, `scope_project_id`, `scope_codespace_id`, `status`,
  `expires_at`, `rotated_at`, `use_count`, `last_used_at`, `revoked_at`, `created_at`
)
SELECT
  `id`, `user_id`, `team_id`, `name`, `token_hash`, `token_prefix`, `role`,
  `scope_tags`, `scope_project_id`,
  CASE WHEN `scope_codespace_id` IS NOT NULL
       AND `scope_codespace_id` IN (SELECT `id` FROM `codespaces`)
    THEN `scope_codespace_id`
    ELSE NULL
  END,
  `status`, `expires_at`, `rotated_at`, `use_count`, `last_used_at`, `revoked_at`, `created_at`
FROM `api_tokens`;

-- Step 4: pivot the table.
DROP TABLE `api_tokens`;
ALTER TABLE `api_tokens_new_v39` RENAME TO `api_tokens`;

-- Step 5: recreate indexes that lived on the original table.
CREATE INDEX IF NOT EXISTS `idx_api_tokens_user` ON `api_tokens`(`user_id`);
CREATE INDEX IF NOT EXISTS `idx_api_tokens_team` ON `api_tokens`(`team_id`);
CREATE INDEX IF NOT EXISTS `idx_api_tokens_status` ON `api_tokens`(`status`);
