// SQLite doesn't have native enums - use const arrays with type inference
// Validation happens at the application level

export const TASK_COLUMNS = [
  'backlog',
  'queued',
  'in_progress',
  'waiting_approval',
  'verified',
] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

export const AGENT_STATUS = [
  'idle',
  'starting',
  'planning',
  'running',
  'paused',
  'error',
  'completed',
] as const;
export type AgentStatus = (typeof AGENT_STATUS)[number];

export const AGENT_TYPES = ['task', 'conversational', 'background'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const WORKTREE_STATUS = [
  'creating',
  'active',
  'merging',
  'removing',
  'removed',
  'error',
] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUS)[number];

export const TOOL_STATUS = ['pending', 'running', 'complete', 'error'] as const;
export type ToolStatus = (typeof TOOL_STATUS)[number];

export const SESSION_STATUS = [
  'idle',
  'initializing',
  'active',
  'paused',
  'closing',
  'closed',
  'error',
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const SANDBOX_TYPES = ['docker', 'devcontainer', 'kubernetes', 'nomad'] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];
