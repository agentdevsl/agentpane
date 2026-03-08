-- Drop AgentCore-specific columns from sandbox_configs
-- These columns were used by the old Docker-centric AgentCore provider
-- AgentCore now uses the settings table for AWS credentials
ALTER TABLE sandbox_configs DROP COLUMN aws_access_key_id;
--> statement-breakpoint
ALTER TABLE sandbox_configs DROP COLUMN aws_secret_access_key;
--> statement-breakpoint
ALTER TABLE sandbox_configs DROP COLUMN aws_region;
--> statement-breakpoint
ALTER TABLE sandbox_configs DROP COLUMN agentcore_runtime_arn;
--> statement-breakpoint
ALTER TABLE sandbox_configs DROP COLUMN ecr_repository_uri;
