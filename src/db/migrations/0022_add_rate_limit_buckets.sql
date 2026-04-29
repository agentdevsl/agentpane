-- F06-NEW-08: Persist rate-limit counters across process restarts.
--
-- The previous in-memory `Map`-backed limiter would reset every time the
-- server restarted, making the limiter trivially bypassable. Each row is
-- a single bucket: (key, window_start, count). Composite primary key on
-- (key, window_start) lets concurrent inserts dedupe via INSERT ... ON
-- CONFLICT DO UPDATE. Cleanup of expired buckets older than 24h runs as
-- a BackgroundJob.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx ON rate_limit_buckets(updated_at);
