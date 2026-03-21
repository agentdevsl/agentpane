import { and, eq } from 'drizzle-orm';
import {
  isValidRbacRole,
  RBAC_ROLE_LEVEL,
  type RbacRole,
  resolveHighestRole,
} from '../db/schema/shared/enums';
import { codespaceMembers } from '../db/schema/sqlite/codespace-members';
import { codespaces } from '../db/schema/sqlite/codespaces';
import { folderMembers } from '../db/schema/sqlite/folder-members';
import { teamMembers } from '../db/schema/sqlite/team-members';
import { teamProjectFolders } from '../db/schema/sqlite/team-project-folders';
import { createLogger } from '../lib/logging/logger';
import type { Database } from '../types/database';

const log = createLogger('RbacService');

/** Permission actions mapped to minimum role */
const PERMISSION_MAP: Record<string, RbacRole> = {
  // Viewer actions
  'codespace:read': 'viewer',
  'task:read': 'viewer',
  'session:read': 'viewer',
  'agent:read': 'viewer',
  'worktree:read': 'viewer',
  'settings:read': 'viewer',
  'folder:read': 'viewer',
  // Agent Operator actions
  'task:create': 'agent_operator',
  'task:update': 'agent_operator',
  'task:move': 'agent_operator',
  'task:delete': 'agent_operator',
  'task:label': 'agent_operator',
  'agent:start': 'agent_operator',
  'agent:stop': 'agent_operator',
  'agent:approve_plan': 'agent_operator',
  'agent:reject_plan': 'agent_operator',
  'agent:approve_task': 'agent_operator',
  'session:create': 'agent_operator',
  'worktree:create': 'agent_operator',
  'worktree:update': 'agent_operator',
  // Admin actions
  'codespace:create': 'admin',
  'codespace:update': 'admin',
  'codespace:delete': 'admin',
  'codespace:manage_members': 'admin',
  'codespace:sandbox_config': 'admin',
  'agent:delete': 'admin',
  'session:delete': 'admin',
  'worktree:delete': 'admin',
  'settings:update': 'admin',
  'keys:manage': 'admin',
  'team:manage_members': 'admin',
  'team:create_tokens': 'admin',
  'team:manage_settings': 'admin',
  'team:view_audit': 'admin',
  'folder:create': 'admin',
  'folder:update': 'admin',
  'folder:delete': 'admin',
  'folder:manage_members': 'admin',
  // Owner actions
  'team:delete': 'owner',
  'team:transfer_owner': 'owner',
  'team:promote_owner': 'owner',
};

export class RbacService {
  constructor(private db: Database) {}

  /**
   * Resolve the effective role for a user on a specific codespace.
   * Resolution order:
   * 1. Direct codespace_members override -> use that role
   * 2. Folder-level role via codespace.projectFolderId -> folder_members
   * 3. Team membership via team_project_folders -> team_members -> highest role
   * 4. No membership -> null (deny)
   */
  async resolveUserRole(userId: string, codespaceId: string): Promise<RbacRole | null> {
    // 1. Check direct codespace member override
    const directMember = await this.db.query.codespaceMembers.findFirst({
      where: and(
        eq(codespaceMembers.codespaceId, codespaceId),
        eq(codespaceMembers.userId, userId)
      ),
    });
    if (directMember) {
      const validated = isValidRbacRole(directMember.role);
      if (!validated) {
        log.warn('Invalid role in codespace_members', {
          data: { userId, codespaceId, role: directMember.role },
        });
        return null;
      }
      return validated;
    }

    // 2. Get the codespace's projectFolderId to check folder-level role
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
      columns: { projectFolderId: true },
    });

    if (!codespace) {
      return null;
    }

    const folderId = codespace.projectFolderId;

    // 3. Check folder_members for folder-level role
    const folderMember = await this.db.query.folderMembers.findFirst({
      where: and(eq(folderMembers.projectFolderId, folderId), eq(folderMembers.userId, userId)),
    });
    if (folderMember) {
      const validated = isValidRbacRole(folderMember.role);
      if (!validated) {
        log.warn('Invalid role in folder_members', {
          data: { userId, folderId, role: folderMember.role },
        });
        return null;
      }
      return validated;
    }

    // 4. Check team memberships via team_project_folders (single JOIN)
    const memberships = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teamProjectFolders, eq(teamMembers.teamId, teamProjectFolders.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teamProjectFolders.projectFolderId, folderId)));

    return resolveHighestRole(memberships)?.role ?? null;
  }

  /**
   * Resolve the effective role for a user on a specific project folder.
   * Resolution order:
   * 1. Direct folder_members override -> use that role
   * 2. Team membership via team_project_folders -> team_members -> highest role
   * 3. No membership -> null (deny)
   */
  async resolveUserFolderRole(userId: string, folderId: string): Promise<RbacRole | null> {
    // 1. Check direct folder member override
    const directMember = await this.db.query.folderMembers.findFirst({
      where: and(eq(folderMembers.projectFolderId, folderId), eq(folderMembers.userId, userId)),
    });
    if (directMember) {
      const validated = isValidRbacRole(directMember.role);
      if (!validated) {
        log.warn('Invalid role in folder_members', {
          data: { userId, folderId, role: directMember.role },
        });
        return null;
      }
      return validated;
    }

    // 2. Check team memberships via team_project_folders (single JOIN)
    const memberships = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teamProjectFolders, eq(teamMembers.teamId, teamProjectFolders.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teamProjectFolders.projectFolderId, folderId)));

    return resolveHighestRole(memberships)?.role ?? null;
  }

  /**
   * Resolve the highest team role for a user across all their teams.
   * Used for team-level operations where no codespace/folder context exists.
   */
  async resolveTeamRole(userId: string, teamId: string): Promise<RbacRole | null> {
    const membership = await this.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
    });

    if (!membership) return null;
    const validated = isValidRbacRole(membership.role);
    if (!validated) {
      log.warn('Invalid role in team_members', {
        data: { userId, teamId, role: membership.role },
      });
      return null;
    }
    return validated;
  }

  /**
   * Resolve the highest role a user has across ALL their teams.
   * Used when no specific team or codespace context.
   */
  async resolveGlobalRole(userId: string): Promise<RbacRole | null> {
    const memberships = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));

    return resolveHighestRole(memberships)?.role ?? null;
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
   * Check if an API token's codespace scope allows access to a given codespace.
   */
  checkCodespaceScope(tokenCodespaceId: string | null, requestedCodespaceId: string): boolean {
    if (!tokenCodespaceId) return true; // No codespace restriction
    return tokenCodespaceId === requestedCodespaceId;
  }
}
