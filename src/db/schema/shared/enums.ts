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

export const RBAC_ROLE_LEVEL: Record<RbacRole, number> = {
  owner: 4,
  admin: 3,
  agent_operator: 2,
  viewer: 1,
};

/** Resolve the highest role from a list of role strings. Returns null if empty. */
export function resolveHighestRole(
  roles: Array<{ role: string }>
): { role: RbacRole; level: number } | null {
  let highestLevel = 0;
  let highestRole: RbacRole = 'viewer';
  let found = false;
  for (const m of roles) {
    if (!RBAC_ROLES.includes(m.role as RbacRole)) continue;
    found = true;
    const level = RBAC_ROLE_LEVEL[m.role as RbacRole];
    if (level > highestLevel) {
      highestLevel = level;
      highestRole = m.role as RbacRole;
    }
  }
  return found ? { role: highestRole, level: highestLevel } : null;
}

export const INVITATION_STATUS = ['pending', 'accepted', 'declined', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];

export const API_TOKEN_STATUS = ['active', 'revoked', 'expired'] as const;
export type ApiTokenStatus = (typeof API_TOKEN_STATUS)[number];
