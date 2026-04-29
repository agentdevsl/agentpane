-- F03-09 (arch29-W2-C): plumb OAuth refresh token through the Claude Agent SDK.
-- Mirrors SQLite migration 0019_api_keys_refresh_token.sql.
--
-- Encrypted column (AES-GCM, base64) — nullable because legacy rows and
-- non-OAuth keys do not carry a refresh token.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "encrypted_refresh_token" text;
