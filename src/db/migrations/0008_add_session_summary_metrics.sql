ALTER TABLE session_summaries ADD COLUMN cost_usd REAL;
ALTER TABLE session_summaries ADD COLUMN duration_api_ms INTEGER;
ALTER TABLE session_summaries ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE session_summaries ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE session_summaries ADD COLUMN stop_reason TEXT;
