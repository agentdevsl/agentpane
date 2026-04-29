-- F05-25: add `stream_kind` discriminator to session_events for Postgres.
--
-- Existing rows are backfilled from the streamId prefix:
--   plan:*       -> 'plan'
--   sandbox:*    -> 'sandbox'
--   terraform:*  -> 'terraform' (rare — terraform streams are normally ephemeral)
--   topology:*   -> 'topology'
--   cli-monitor  -> 'cli-monitor'
--   else         -> 'session'

-- 1. Add the column nullable to survive existing rows.
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS stream_kind TEXT;

-- 2. Backfill from the streamId prefix.
UPDATE session_events
SET stream_kind = CASE
  WHEN session_id = 'cli-monitor' THEN 'cli-monitor'
  WHEN session_id LIKE 'plan:%' THEN 'plan'
  WHEN session_id LIKE 'sandbox:%' THEN 'sandbox'
  WHEN session_id LIKE 'terraform:%' THEN 'terraform'
  WHEN session_id LIKE 'topology:%' THEN 'topology'
  ELSE 'session'
END
WHERE stream_kind IS NULL;

-- 3. Enforce NOT NULL + CHECK so the discriminator is binding.
ALTER TABLE session_events ALTER COLUMN stream_kind SET NOT NULL;

ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_stream_kind_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_stream_kind_check
  CHECK (stream_kind IN ('session','plan','sandbox','terraform','topology','cli-monitor'));

-- 4. Add the streamKind-scoped index for cleanup/admin queries.
CREATE INDEX IF NOT EXISTS session_events_stream_kind_session_idx ON session_events(stream_kind, session_id);
