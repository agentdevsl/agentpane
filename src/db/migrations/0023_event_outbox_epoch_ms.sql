-- F02-18 (arch29-W2-R): event_outbox timestamps as epoch ms (SQLite, vestigial copy).
--
-- This file lives in the vestigial `src/db/migrations/` folder for parity
-- with the PG migration `0017_event_outbox_epoch_ms.sql` (enforced by
-- `scripts/check-migration-parity.ts`). The runtime SQLite migration is
-- `v36/event-outbox-epoch-ms` in `src/lib/bootstrap/migrations/index.ts`,
-- which is the only path actually executed against a live database. The
-- folder is documented as vestigial in F02-26.
--
-- Strategy mirrors the runtime migration: rebuild `event_outbox` with
-- INTEGER epoch-ms columns, copy rows via `strftime('%s', ...) * 1000`,
-- pivot, and recreate indexes.

DROP TABLE IF EXISTS event_outbox_new_v36;

CREATE TABLE event_outbox_new_v36 (
  id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

INSERT INTO event_outbox_new_v36 (
  id, stream_id, type, payload, status, attempts,
  next_attempt_at, last_error, created_at, published_at
)
SELECT
  id, stream_id, type, payload, status, attempts,
  CAST(strftime('%s', next_attempt_at) AS INTEGER) * 1000,
  last_error,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CASE
    WHEN published_at IS NULL THEN NULL
    ELSE CAST(strftime('%s', published_at) AS INTEGER) * 1000
  END
FROM event_outbox;

DROP TABLE event_outbox;
ALTER TABLE event_outbox_new_v36 RENAME TO event_outbox;

CREATE INDEX IF NOT EXISTS event_outbox_status_idx ON event_outbox(status);
CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_at_idx ON event_outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_idx ON event_outbox(status, next_attempt_at);
