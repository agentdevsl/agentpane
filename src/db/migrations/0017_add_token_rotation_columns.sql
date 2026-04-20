-- F06-09: Add rotation-tracking columns to token storage tables.
--
-- The `api_tokens` table already has `expires_at`; add `rotated_at`.
-- The legacy `api_keys` (Anthropic keys etc.) and `github_tokens` tables
-- have neither — add both so the rotation dashboard has something to
-- surface. Existing rows get NULL (no rotation recorded, no expiry).
ALTER TABLE api_tokens ADD COLUMN rotated_at TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_at TEXT;
ALTER TABLE github_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE github_tokens ADD COLUMN rotated_at TEXT;
