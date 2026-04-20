-- F05-05: Transactional outbox for durable-streams publishes.
--
-- Producers insert into this table inside the same SQLite transaction as the
-- state change that produced the event. The EventOutboxRelayService polls
-- every 50ms and publishes to the Caddy durable-streams server.

CREATE TABLE IF NOT EXISTS event_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS event_outbox_status_idx ON event_outbox(status);
CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_at_idx ON event_outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_idx ON event_outbox(status, next_attempt_at);
