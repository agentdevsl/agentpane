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

export const RBAC_ROLES = ['owner', 'admin', 'agent_operator', 'viewer'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

export const RBAC_ROLE_LEVEL: Readonly<Record<RbacRole, number>> = Object.freeze({
  owner: 4,
  admin: 3,
  agent_operator: 2,
  viewer: 1,
});

/** Validate that a string is a recognized RBAC role. Returns the role or null. */
export function isValidRbacRole(value: string): RbacRole | null {
  return (RBAC_ROLES as readonly string[]).includes(value) ? (value as RbacRole) : null;
}

/** Resolve the highest role from a list of role objects. Returns null if empty. */
export function resolveHighestRole(
  roles: Array<{ role: string }>
): { role: RbacRole; level: number } | null {
  let highestRole: RbacRole | null = null;
  let highestLevel = -1;

  for (const m of roles) {
    const validated = isValidRbacRole(m.role);
    if (!validated) {
      // Log but don't crash — unknown role should not grant access
      console.warn(`[RBAC] Unknown role value in database: "${m.role}"`);
      continue;
    }
    const level = RBAC_ROLE_LEVEL[validated];
    if (level > highestLevel) {
      highestLevel = level;
      highestRole = validated;
    }
  }

  if (!highestRole) return null;
  return { role: highestRole, level: highestLevel };
}

export const INVITATION_STATUS = ['pending', 'accepted', 'declined', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];

export const API_TOKEN_STATUS = ['active', 'revoked', 'expired'] as const;
export type ApiTokenStatus = (typeof API_TOKEN_STATUS)[number];

export const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook', 'cron'] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

export const EVENT_SOURCE_STATUS = ['active', 'error', 'disabled'] as const;
export type EventSourceStatus = (typeof EVENT_SOURCE_STATUS)[number];

export const EVENT_LOG_STATUS = [
  'received',
  'matched',
  'task_created',
  'ignored',
  'error',
] as const;
export type EventLogStatus = (typeof EVENT_LOG_STATUS)[number];

export const SCHEDULE_EXECUTION_STATUS = [
  'executed',
  'skipped_budget',
  'skipped_disabled',
  'error',
] as const;
export type ScheduleExecutionStatus = (typeof SCHEDULE_EXECUTION_STATUS)[number];

export const BUDGET_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
