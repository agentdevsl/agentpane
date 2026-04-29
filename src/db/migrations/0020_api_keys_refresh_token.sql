-- F03-09 (arch29-W2-C): plumb OAuth refresh token through the Claude Agent SDK.
--
-- The agent-runner already accepts CLAUDE_OAUTH_REFRESH_TOKEN and threads it
-- into the credentials file. The host side hardcoded `null` because no column
-- existed to store it. Add an encrypted column (mirrors `encrypted_key`) so
-- the host can populate it at OAuth grant time and forward it to the runner.
--
-- Nullable: legacy api_keys rows have no refresh token, and non-OAuth keys
-- (e.g., regular `sk-ant-api*`) never carry one. The runner falls back to
-- `null` (the SDK rejects empty string) when the column is absent.

ALTER TABLE api_keys ADD COLUMN encrypted_refresh_token TEXT;
