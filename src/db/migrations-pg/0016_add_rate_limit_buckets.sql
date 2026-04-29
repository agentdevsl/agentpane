-- F06-NEW-08: Persist rate-limit counters across process restarts.
--
-- Mirrors SQLite migration 0022_add_rate_limit_buckets.sql.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  window_ms BIGINT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx ON rate_limit_buckets(updated_at);
