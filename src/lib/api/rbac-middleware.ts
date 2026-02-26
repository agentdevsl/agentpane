/**
 * RBAC Middleware
 *
 * Provides role-based access control middleware for Hono API routes.
 * Slots in after the existing authMiddleware in the request pipeline.
 */

import { eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../db/schema/shared/enums';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { createLogger } from '../logging/logger';
import type { AuthContext } from './auth-middleware';

const log = createLogger('RbacMiddleware');

/** Extended AuthContext with RBAC fields */
export interface RbacAuthContext extends AuthContext {
  user?: {
    id: string;
    githubId: number;
    githubLogin: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  resolvedRole?: RbacRole;
  roleLevel?: number;
  teamMemberships?: Array<{ teamId: string; role: RbacRole }>;
  tokenScope?: {
    tokenId: string;
    role: RbacRole;
    projectId: string | null;
    tags: string[] | null;
  };
}

/**
 * Middleware that enriches the auth context with RBAC information.
 * Runs after the existing authMiddleware.
 *
 * - For dev-mode users: grants owner role automatically
 * - For session users: looks up user record and team memberships
 * - For API token users: resolves token scope and permissions
 */
export function enrichAuthContext(db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth) return next();

    const rbacAuth: RbacAuthContext = { ...auth };

    // Dev-mode users get owner role automatically
    if (auth.authMethod === 'dev') {
      rbacAuth.resolvedRole = 'owner';
      rbacAuth.roleLevel = RBAC_ROLE_LEVEL.owner;
      c.set('auth', rbacAuth);
      return next();
    }

    try {
      // Look up user record
      if (auth.userId) {
        const user = await db.query.users?.findFirst({
          where: eq(users.id, auth.userId),
        });

        if (user) {
          rbacAuth.user = {
            id: user.id,
            githubId: user.githubId,
            githubLogin: user.githubLogin,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
          };

          // Load team memberships
          const memberships = await db
            .select({ teamId: teamMembers.teamId, role: teamMembers.role })
            .from(teamMembers)
            .where(eq(teamMembers.userId, user.id));

          rbacAuth.teamMemberships = memberships.map((m) => ({
            teamId: m.teamId,
            role: m.role as RbacRole,
          }));

          // Find highest global role
          if (memberships.length > 0) {
            let highestLevel = 0;
            let highestRole: RbacRole = 'viewer';
            for (const m of memberships) {
              const level = RBAC_ROLE_LEVEL[m.role as RbacRole] ?? 0;
              if (level > highestLevel) {
                highestLevel = level;
                highestRole = m.role as RbacRole;
              }
            }
            rbacAuth.resolvedRole = highestRole;
            rbacAuth.roleLevel = highestLevel;
          }
        }
      }

      // If API token, load token scope
      if (auth.authMethod === 'api_token' && auth.userId) {
        // The userId was set by validateApiKey to the actual user ID
        // Token scope was loaded during validation - look up the token details
        // This is done in the token validation callback in api.ts
      }
    } catch (error) {
      log.error('Failed to enrich auth context', { error });
      // Don't fail the request - proceed with basic auth context
    }

    c.set('auth', rbacAuth);
    return next();
  };
}

/**
 * Middleware factory that requires a minimum RBAC role for the route.
 *
 * Resolves the effective role based on:
 * - Project context (from :id param or body.projectId)
 * - Team context (from :id param on team routes)
 * - Global context (highest role across all teams)
 *
 * Dev-mode users always pass (owner role).
 * Returns 403 if the user's role is insufficient.
 */
export function requireRole(minimumRole: RbacRole, rbacService: RbacService) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as RbacAuthContext | undefined;

    if (!auth) {
      return c.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    // Dev-mode users always pass
    if (auth.authMethod === 'dev') {
      return next();
    }

    // If user has no resolved role, deny
    if (!auth.resolvedRole) {
      return c.json(
        {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'No role assigned. Join a team first.' },
        },
        403
      );
    }

    // Try to extract projectId from route params or query
    const projectId = c.req.param('id') ?? c.req.query('projectId');

    let effectiveRole: RbacRole | null = null;

    if (projectId) {
      // Project-scoped: resolve role for this specific project
      effectiveRole = await rbacService.resolveUserRole(auth.userId, projectId);

      // Apply token ceiling if applicable
      if (effectiveRole && auth.tokenScope) {
        effectiveRole = rbacService.applyTokenCeiling(effectiveRole, auth.tokenScope.role);

        // Check project scope restriction
        if (!rbacService.checkProjectScope(auth.tokenScope.projectId, projectId)) {
          return c.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Token not scoped for this project' },
            },
            403
          );
        }
      }
    } else {
      // No project context -- use global role
      effectiveRole = auth.resolvedRole;
    }

    if (!effectiveRole || !rbacService.hasMinimumRole(effectiveRole, minimumRole)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: `Requires ${minimumRole} role or higher`,
          },
        },
        403
      );
    }

    // Store the resolved role for this request
    const updatedAuth: RbacAuthContext = {
      ...auth,
      resolvedRole: effectiveRole,
      roleLevel: RBAC_ROLE_LEVEL[effectiveRole],
    };
    c.set('auth', updatedAuth);

    return next();
  };
}

/**
 * Middleware that checks tag-based access for API tokens with tag restrictions.
 *
 * Bypassed when:
 * - User is not using an API token
 * - Token has no tag restrictions (scopeTags is null)
 * - User is in dev mode
 */
export function requireTagAccess(_db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as RbacAuthContext | undefined;

    if (!auth) return next();

    // Skip for non-token auth or dev mode
    if (auth.authMethod === 'dev' || auth.authMethod !== 'api_token') {
      return next();
    }

    // Skip if token has no tag restrictions
    if (!auth.tokenScope?.tags || auth.tokenScope.tags.length === 0) {
      return next();
    }

    // Tag access checking will be done at the service/query layer
    // The middleware ensures the tokenScope.tags is available for query filtering
    return next();
  };
}
