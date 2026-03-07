-- Migration: Add AgentCore-specific configuration columns to sandbox_configs table
-- These columns support AWS AgentCore as a sandbox provider

ALTER TABLE sandbox_configs ADD COLUMN aws_access_key_id text;
ALTER TABLE sandbox_configs ADD COLUMN aws_secret_access_key text;
ALTER TABLE sandbox_configs ADD COLUMN aws_region text;
ALTER TABLE sandbox_configs ADD COLUMN agentcore_runtime_arn text;
ALTER TABLE sandbox_configs ADD COLUMN ecr_repository_uri text;
