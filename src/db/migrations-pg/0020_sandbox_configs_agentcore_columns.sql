-- Mirror SQLite bootstrap migration v14 — the AWS Bedrock AgentCore columns
-- on sandbox_configs were never added on the PostgreSQL side, so credentials
-- supplied through /api/sandbox-configs were silently dropped under DB_MODE=postgres.

ALTER TABLE "sandbox_configs" ADD COLUMN IF NOT EXISTS "aws_access_key_id" text;
ALTER TABLE "sandbox_configs" ADD COLUMN IF NOT EXISTS "aws_secret_access_key" text;
ALTER TABLE "sandbox_configs" ADD COLUMN IF NOT EXISTS "aws_region" text;
ALTER TABLE "sandbox_configs" ADD COLUMN IF NOT EXISTS "agentcore_runtime_arn" text;
ALTER TABLE "sandbox_configs" ADD COLUMN IF NOT EXISTS "ecr_repository_uri" text;
