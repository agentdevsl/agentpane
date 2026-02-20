/**
 * Default configuration for Nomad connections
 */
export const NOMAD_DEFAULTS = {
  address: 'http://127.0.0.1:4646',
  namespace: 'default',
  region: 'global',
  datacenter: 'dc1',
  waitTimeout: '30s',
  readyTimeoutMs: 120_000,
} as const;

/**
 * Nomad job meta keys used for AgentPane tracking
 */
export const NOMAD_META = {
  SANDBOX_ID: 'agentpane-sandbox-id',
  PROJECT_ID: 'agentpane-project-id',
  TASK_ID: 'agentpane-task-id',
} as const;

/**
 * Prefix for all AgentPane-managed Nomad jobs
 */
export const NOMAD_JOB_PREFIX = 'agentpane-' as const;
