/**
 * RBAC Middleware
 *
 * Provides role-based access control middleware for Hono API routes.
 * Slots in after the existing authMiddleware in the request pipeline.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole, resolveHighestRole } from '../../db/schema/shared/enums';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { createLogger } from '../logging/logger';
import type { AuthContext } from './auth-middleware';

const log = createLogger('RbacMiddleware');

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
    if (!auth) {
      log.warn('enrichAuthContext called without auth context', { data: { path: c.req.path } });
      return next();
    }

    const rbacAuth: AuthContext = { ...auth };

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
        const user = await db.query.users.findFirst({
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
          const highest = resolveHighestRole(memberships);
          if (highest) {
            rbacAuth.resolvedRole = highest.role;
            rbacAuth.roleLevel = highest.level;
          }
        }
      }

      // Load token scope for API token auth
      if (auth.authMethod === 'api_token') {
        const authHeader = c.req.header('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          const rawToken = authHeader.substring(7);
          const tokenHash = createHash('sha256').update(rawToken).digest('hex');

          const tokenRecords = await db
            .select({
              id: apiTokens.id,
              role: apiTokens.role,
              scopeProjectId: apiTokens.scopeProjectId,
              scopeTags: apiTokens.scopeTags,
            })
            .from(apiTokens)
            .where(and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')));

          const token = tokenRecords[0];
          if (token) {
            rbacAuth.tokenScope = {
              tokenId: token.id,
              role: token.role as RbacRole,
              projectId: token.scopeProjectId,
              tags: token.scopeTags as string[] | null,
            };

            // Cap the resolved role at the token's role ceiling
            if (rbacAuth.resolvedRole) {
              const tokenLevel = RBAC_ROLE_LEVEL[token.role as RbacRole];
              if (rbacAuth.roleLevel && rbacAuth.roleLevel > tokenLevel) {
                rbacAuth.resolvedRole = token.role as RbacRole;
                rbacAuth.roleLevel = tokenLevel;
              }
            }

            // Update lastUsedAt asynchronously (fire-and-forget to avoid blocking the request)
            db.update(apiTokens)
              .set({ lastUsedAt: new Date().toISOString() })
              .where(eq(apiTokens.id, token.id))
              .catch((err) => log.warn('Failed to update token lastUsedAt', { error: err }));
          } else {
            // Token hash not found or token is not active — deny access
            log.warn('API token not found or inactive', { data: { path: c.req.path } });
            return c.json(
              {
                ok: false,
                error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked API token' },
              },
              401
            );
          }
        }
      }
    } catch (error) {
      log.error('Failed to enrich auth context', { error });
      if (auth.authMethod === 'api_token') {
        return c.json(
          {
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to validate token permissions' },
          },
          500
        );
      }
      // For session users, deny access rather than fail open
      return c.json(
        {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to load user permissions' },
        },
        500
      );
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
    const auth = c.get('auth') as AuthContext | undefined;

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
    const updatedAuth: AuthContext = {
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
    const auth = c.get('auth') as AuthContext | undefined;

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
