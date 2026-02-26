import { and, eq, inArray } from 'drizzle-orm';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../db/schema/shared/enums';
import { projectMembers } from '../db/schema/sqlite/project-members';
import { teamMembers } from '../db/schema/sqlite/team-members';
import { teamProjects } from '../db/schema/sqlite/team-projects';
import { createLogger } from '../lib/logging/logger';
import type { Database } from '../types/database';

const log = createLogger('RbacService');

/** Permission actions mapped to minimum role */
const PERMISSION_MAP: Record<string, RbacRole> = {
  // Viewer actions
  'project:read': 'viewer',
  'task:read': 'viewer',
  'session:read': 'viewer',
  'agent:read': 'viewer',
  'worktree:read': 'viewer',
  'settings:read': 'viewer',
  // Agent Operator actions
  'task:create': 'agent_operator',
  'task:update': 'agent_operator',
  'task:move': 'agent_operator',
  'agent:start': 'agent_operator',
  'agent:stop': 'agent_operator',
  'agent:approve': 'agent_operator',
  'session:create': 'agent_operator',
  'worktree:create': 'agent_operator',
  'worktree:update': 'agent_operator',
  // Admin actions
  'project:create': 'admin',
  'project:update': 'admin',
  'task:delete': 'admin',
  'agent:delete': 'admin',
  'session:delete': 'admin',
  'worktree:delete': 'admin',
  'settings:update': 'admin',
  'keys:manage': 'admin',
  'member:manage': 'admin',
  'token:create': 'admin',
  // Owner actions
  'project:delete': 'owner',
  'team:delete': 'owner',
  'team:transfer': 'owner',
};

export class RbacService {
  constructor(private db: Database) {}

  /**
   * Resolve the effective role for a user on a specific project.
   * Resolution order:
   * 1. Direct project_members override -> use that role
   * 2. Team membership via team_projects -> highest role across linked teams
   * 3. No membership -> null (deny)
   */
  async resolveUserRole(userId: string, projectId: string): Promise<RbacRole | null> {
    // 1. Check direct project member override
    const directMember = await this.db.query.projectMembers?.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
    });
    if (directMember) {
      return directMember.role as RbacRole;
    }

    // 2. Check team memberships via team_projects
    // Find all teams that have this project
    const projectTeams = await this.db
      .select({ teamId: teamProjects.teamId })
      .from(teamProjects)
      .where(eq(teamProjects.projectId, projectId));

    if (projectTeams.length === 0) return null;

    const teamIds = projectTeams.map((t) => t.teamId);

    // Find user's membership in those teams
    const memberships = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds)));

    if (memberships.length === 0) return null;

    // Return highest role
    let highestLevel = 0;
    let highestRole: RbacRole = 'viewer';
    for (const m of memberships) {
      const level = RBAC_ROLE_LEVEL[m.role as RbacRole] ?? 0;
      if (level > highestLevel) {
        highestLevel = level;
        highestRole = m.role as RbacRole;
      }
    }

    return highestRole;
  }

  /**
   * Resolve the highest team role for a user across all their teams.
   * Used for team-level operations where no project context exists.
   */
  async resolveTeamRole(userId: string, teamId: string): Promise<RbacRole | null> {
    const membership = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));

    const first = membership[0];
    if (!first) return null;
    return first.role as RbacRole;
  }

  /**
   * Resolve the highest role a user has across ALL their teams.
   * Used when no specific team or project context.
   */
  async resolveGlobalRole(userId: string): Promise<RbacRole | null> {
    const memberships = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));

    if (memberships.length === 0) return null;

    let highestLevel = 0;
    let highestRole: RbacRole = 'viewer';
    for (const m of memberships) {
      const level = RBAC_ROLE_LEVEL[m.role as RbacRole] ?? 0;
      if (level > highestLevel) {
        highestLevel = level;
        highestRole = m.role as RbacRole;
      }
    }

    return highestRole;
  }

  /**
   * Check if a role meets or exceeds the minimum required role.
   */
  hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean {
    return RBAC_ROLE_LEVEL[userRole] >= RBAC_ROLE_LEVEL[minimumRole];
  }

  /**
   * Apply token ceiling: effective role = min(membership role, token role)
   */
  applyTokenCeiling(membershipRole: RbacRole, tokenRole: RbacRole): RbacRole {
    const memberLevel = RBAC_ROLE_LEVEL[membershipRole];
    const tokenLevel = RBAC_ROLE_LEVEL[tokenRole];
    return memberLevel <= tokenLevel ? membershipRole : tokenRole;
  }

  /**
   * Check if a user can perform a specific action.
   */
  canPerformAction(userRole: RbacRole, action: string): boolean {
    const requiredRole = PERMISSION_MAP[action];
    if (!requiredRole) {
      log.warn('Unknown permission action', { data: { action } });
      return false;
    }
    return this.hasMinimumRole(userRole, requiredRole);
  }

  /**
   * Check if an API token's scope tags overlap with resource tags.
   * Returns true if access is allowed.
   */
  checkTagAccess(tokenScopeTags: string[] | null, resourceTags: string[]): boolean {
    // No tag restriction on token -- allow everything
    if (!tokenScopeTags || tokenScopeTags.length === 0) return true;
    // Resource has no tags and token is tag-restricted -- deny
    if (resourceTags.length === 0) return false;
    // Check overlap
    return tokenScopeTags.some((t) => resourceTags.includes(t));
  }

  /**
   * Check if an API token's project scope allows access to a given project.
   */
  checkProjectScope(tokenProjectId: string | null, requestedProjectId: string): boolean {
    if (!tokenProjectId) return true; // No project restriction
    return tokenProjectId === requestedProjectId;
  }
}
