-- F05-25: add `stream_kind` discriminator to session_events.
--
-- Existing rows are backfilled from the streamId prefix:
--   plan:*       -> 'plan'
--   sandbox:*    -> 'sandbox'
--   terraform:*  -> 'terraform' (rare — terraform streams are normally ephemeral)
--   topology:*   -> 'topology'
--   cli-monitor  -> 'cli-monitor'
--   else         -> 'session'
--
-- After backfill the column is enforced as NOT NULL via a table rebuild that
-- also adds a CHECK constraint over the legal value space. SQLite cannot
-- ALTER COLUMN to add NOT NULL/CHECK in place, so the rebuild + copy + swap
-- approach is the standard pattern.

-- 1. Add the column nullable so existing rows survive.
ALTER TABLE session_events ADD COLUMN stream_kind TEXT;

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

-- 3. Rebuild the table with NOT NULL + CHECK so the discriminator is enforced.
CREATE TABLE session_events_new (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  stream_kind TEXT NOT NULL CHECK (stream_kind IN ('session','plan','sandbox','terraform','topology','cli-monitor')),
  "offset" INTEGER NOT NULL,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO session_events_new (id, session_id, stream_kind, "offset", type, channel, data, timestamp, user_id, created_at)
SELECT id, session_id, stream_kind, "offset", type, channel, data, timestamp, user_id, created_at FROM session_events;

DROP TABLE session_events;
ALTER TABLE session_events_new RENAME TO session_events;

-- 4. Recreate indexes (preserved from the previous schema plus the new stream_kind index).
CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS session_events_unique_offset ON session_events(session_id, "offset");
CREATE INDEX IF NOT EXISTS session_events_created_at_idx ON session_events(created_at);
CREATE INDEX IF NOT EXISTS session_events_session_type_idx ON session_events(session_id, type);
CREATE INDEX IF NOT EXISTS session_events_stream_kind_session_idx ON session_events(stream_kind, session_id);
