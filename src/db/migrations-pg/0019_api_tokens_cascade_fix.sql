-- F02-20 (arch29-W2-Q): api_tokens.scope_codespace_id ON DELETE SET NULL parity.
-- Mirrors SQLite migration 0025_api_tokens_cascade_fix.sql.
--
-- Postgres already has the correct FK behavior (created in
-- `0004_schema_catchup.sql:328` as `ON DELETE SET NULL`). This migration is a
-- no-op on PG; the SQLite side needed a full table rebuild because SQLite
-- cannot ALTER a foreign-key constraint in place. Adding this file keeps
-- migration parity with SQLite for `scripts/check-migration-parity.ts`.

-- Verify the existing FK behavior is correct. If a deployment somehow has
-- ON DELETE CASCADE here (e.g., via a manual schema edit), the script below
-- corrects it by recreating the constraint with SET NULL semantics.
DO $$
DECLARE
  fk_action text;
BEGIN
  SELECT confdeltype INTO fk_action
  FROM pg_constraint
  WHERE conname = 'api_tokens_scope_codespace_id_codespaces_id_fk'
    AND conrelid = 'api_tokens'::regclass;

  -- Postgres FK action codes: 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE,
  -- 'n' = SET NULL, 'd' = SET DEFAULT.
  IF fk_action IS NOT NULL AND fk_action <> 'n' THEN
    ALTER TABLE "api_tokens"
      DROP CONSTRAINT "api_tokens_scope_codespace_id_codespaces_id_fk";
    ALTER TABLE "api_tokens"
      ADD CONSTRAINT "api_tokens_scope_codespace_id_codespaces_id_fk"
      FOREIGN KEY ("scope_codespace_id") REFERENCES "codespaces"("id") ON DELETE SET NULL;
  END IF;
END $$;
