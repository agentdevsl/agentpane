import {
  CLI_SESSIONS_MIGRATION_SQL,
  CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL,
  EVENT_SYSTEM_MIGRATION_SQL,
  MIGRATION_SQL,
  PERFORMANCE_INDEXES_MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
  RBAC_SCHEMA_ADDITIONS,
  SANDBOX_CONTAINER_ID_MIGRATION_SQL,
  SANDBOX_MIGRATION_SQL,
  SCHEDULE_EXECUTIONS_MIGRATION_SQL,
  TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL,
  TERRAFORM_MIGRATION_SQL,
} from '../phases/schema.js';

/**
 * A single migration step in the ordered migration sequence.
 *
 * - `sql`: SQL string to execute via db.exec()
 * - `statements`: Array of individual SQL strings, each executed separately
 *                 with try/catch for ALTER TABLE idempotency
 *
 * Exactly one of `sql` or `statements` must be provided.
 */
export interface Migration {
  version: number;
  name: string;
  sql?: string;
  statements?: string[];
}

/**
 * Ordered list of all SQLite migrations.
 *
 * IMPORTANT: Only append to this array. Never reorder or remove entries.
 * The version numbers must be strictly increasing.
 */
export const MIGRATIONS: Migration[] = [
  // 1. Base schema — all core tables
  { version: 1, name: 'base-schema', sql: MIGRATION_SQL },

  // 2. Add sandbox_config_id to projects
  { version: 2, name: 'sandbox-config-column', sql: SANDBOX_MIGRATION_SQL },

  // 3. Add sandbox_container_id to sessions
  { version: 3, name: 'sandbox-container-id', sql: SANDBOX_CONTAINER_ID_MIGRATION_SQL },

  // 4. Template sync interval columns
  { version: 4, name: 'template-sync-interval', sql: TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL },

  // 5. Performance indexes (idempotent — IF NOT EXISTS)
  { version: 5, name: 'performance-indexes', sql: PERFORMANCE_INDEXES_MIGRATION_SQL },

  // 6. CLI sessions table
  { version: 6, name: 'cli-sessions', sql: CLI_SESSIONS_MIGRATION_SQL },

  // 7. CLI sessions performance_metrics column
  { version: 7, name: 'cli-sessions-perf-metrics', sql: CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL },

  // 8. Terraform tables
  { version: 8, name: 'terraform-tables', sql: TERRAFORM_MIGRATION_SQL },

  // 9. RBAC tables
  { version: 9, name: 'rbac-tables', sql: RBAC_MIGRATION_SQL },

  // 10. RBAC schema additions (individual ALTER TABLEs)
  { version: 10, name: 'rbac-schema-additions', statements: [...RBAC_SCHEMA_ADDITIONS] },

  // 11. GitHub tokens team_id column
  { version: 11, name: 'github-tokens-team-id', sql: RBAC_GITHUB_TOKEN_MIGRATION_SQL },

  // 12. Index on github_tokens(team_id) — must follow version 11
  {
    version: 12,
    name: 'github-tokens-team-index',
    sql: 'CREATE INDEX IF NOT EXISTS idx_github_tokens_team ON github_tokens(team_id)',
  },

  // 13. Nomad sandbox columns
  {
    version: 13,
    name: 'sandbox-nomad-columns',
    statements: [
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_address TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_token TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_namespace TEXT DEFAULT 'default'`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_datacenter TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN nomad_region TEXT`,
    ],
  },

  // 14. AgentCore sandbox columns
  {
    version: 14,
    name: 'sandbox-agentcore-columns',
    statements: [
      `ALTER TABLE sandbox_configs ADD COLUMN aws_access_key_id TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN aws_secret_access_key TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN aws_region TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN agentcore_runtime_arn TEXT`,
      `ALTER TABLE sandbox_configs ADD COLUMN ecr_repository_uri TEXT`,
    ],
  },

  // 15. Agents parent_agent_id column
  {
    version: 15,
    name: 'agents-parent-agent-id',
    sql: `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;`,
  },

  // 16. Event system tables (idempotent — IF NOT EXISTS)
  { version: 16, name: 'event-system', sql: EVENT_SYSTEM_MIGRATION_SQL },

  // 17. Schedule executions table (idempotent — IF NOT EXISTS)
  { version: 17, name: 'schedule-executions', sql: SCHEDULE_EXECUTIONS_MIGRATION_SQL },
];
