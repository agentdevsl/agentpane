-- Add Nomad sandbox configuration columns
ALTER TABLE sandbox_configs ADD COLUMN nomad_address TEXT;
ALTER TABLE sandbox_configs ADD COLUMN nomad_token TEXT;
ALTER TABLE sandbox_configs ADD COLUMN nomad_namespace TEXT DEFAULT 'default';
ALTER TABLE sandbox_configs ADD COLUMN nomad_datacenter TEXT;
ALTER TABLE sandbox_configs ADD COLUMN nomad_region TEXT;
