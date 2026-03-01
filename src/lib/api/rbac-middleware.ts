/**
 * RBAC Middleware
 *
 * Provides role-based access control middleware for Hono API routes.
 * Slots in after the existing authMiddleware in the request pipeline.
 */

import { eq, sql } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole, resolveHighestRole } from '../../db/schema/shared/enums';
import { agents } from '../../db/schema/sqlite/agents';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import { projectTags } from '../../db/schema/sqlite/project-tags';
import { sessions } from '../../db/schema/sqlite/sessions';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import { tasks } from '../../db/schema/sqlite/tasks';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { createLogger } from '../logging/logger';
import type { AuthContext } from './auth-middleware';

interface CachedApiToken {
  id: string;
  role: RbacRole;
  scopeProjectId: string | null;
  scopeTags: string[] | null;
  expiresAt: string | null;
}

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
      return c.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    const rbacAuth: AuthContext = { ...auth };

    // Dev-mode users get owner role automatically
    if (auth.authMethod === 'dev') {
      // Dev-mode should be unreachable in production (auth middleware gates on NODE_ENV).
      // Block here as defense-in-depth in case the auth layer is misconfigured.
      if (process.env.NODE_ENV !== 'development') {
        log.error('SECURITY: Dev-mode authentication detected in production', {
          data: { userId: auth.userId, path: c.req.path },
        });
        return c.json(
          { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
          401
        );
      }
      rbacAuth.resolvedRole = 'owner';
      rbacAuth.roleLevel = RBAC_ROLE_LEVEL.owner;
      c.set('auth', rbacAuth);
      return next();
    }

    try {
      // Look up user record and team memberships in parallel
      if (auth.userId) {
        const [user, memberships] = await Promise.all([
          db.query.users.findFirst({
            where: eq(users.id, auth.userId),
          }),
          db
            .select({ teamId: teamMembers.teamId, role: teamMembers.role })
            .from(teamMembers)
            .where(eq(teamMembers.userId, auth.userId)),
        ]);

        if (user) {
          rbacAuth.user = {
            id: user.id,
            githubId: user.githubId,
            githubLogin: user.githubLogin,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
          };

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
        } else {
          log.warn('User record not found for authenticated userId', {
            data: { userId: auth.userId, path: c.req.path },
          });
          return c.json(
            { ok: false, error: { code: 'UNAUTHORIZED', message: 'User account not found' } },
            401
          );
        }
      }

      // Load token scope for API token auth
      if (auth.authMethod === 'api_token') {
        // Use cached token from createAuthMiddleware to avoid duplicate hash+query
        const token = c.get('_resolvedApiToken') as CachedApiToken | undefined;

        if (token) {
          // Check if token has expired
          if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
            // Lazily update status to expired (fire-and-forget)
            void db
              .update(apiTokens)
              .set({ status: 'expired' })
              .where(eq(apiTokens.id, token.id))
              .catch((err) => log.error('Failed to update expired token status', { error: err }));
            return c.json(
              { ok: false, error: { code: 'UNAUTHORIZED', message: 'API token has expired' } },
              401
            );
          }
          // Validate that the token's role is a recognized RBAC role
          const tokenLevel = RBAC_ROLE_LEVEL[token.role];
          if (tokenLevel === undefined) {
            log.error('API token has invalid role in database', {
              data: { tokenId: token.id, role: token.role },
            });
            return c.json(
              {
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: 'Token configuration error' },
              },
              500
            );
          }

          rbacAuth.tokenScope = {
            tokenId: token.id,
            role: token.role,
            projectId: token.scopeProjectId,
            tags: token.scopeTags as string[] | null,
          };

          // Cap the resolved role at the token's role ceiling
          if (rbacAuth.resolvedRole) {
            if (rbacAuth.roleLevel && rbacAuth.roleLevel > tokenLevel) {
              rbacAuth.resolvedRole = token.role;
              rbacAuth.roleLevel = tokenLevel;
            }
          } else {
            // User has no membership role — use token role as effective role
            rbacAuth.resolvedRole = token.role;
            rbacAuth.roleLevel = tokenLevel;
          }

          // Update lastUsedAt and useCount asynchronously (fire-and-forget to avoid blocking the request)
          void db
            .update(apiTokens)
            .set({
              lastUsedAt: new Date().toISOString(),
              useCount: sql`COALESCE(${apiTokens.useCount}, 0) + 1`,
            })
            .where(eq(apiTokens.id, token.id))
            .catch((err) => log.warn('Failed to update token usage tracking', { error: err }));
        } else {
          // Token not found in cache — deny access
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
 * - Project context (from :id param, ?projectId query, or body.projectId)
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

    // Try to extract projectId from route params, query, or request body
    let projectId = c.req.param('id') ?? c.req.query('projectId');

    // Fallback: try to extract projectId from the request body (only for methods that have a body)
    if (!projectId && ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      try {
        const body = await c.req.raw.clone().json();
        if (body && typeof body === 'object' && typeof body.projectId === 'string') {
          projectId = body.projectId;
        }
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) {
          log.error('Unexpected error parsing request body for projectId', {
            error: parseError,
            data: { path: c.req.path },
          });
          // If we couldn't extract a projectId from URL and body parsing failed unexpectedly,
          // deny rather than falling back to potentially less-restrictive global role
          if (!projectId) {
            return c.json(
              {
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions' },
              },
              500
            );
          }
        }
      }
    }

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
 * Tag resolver functions - resolve tags for a given resource ID
 */
type TagResolver = (id: string, db: Database) => Promise<string[]>;

const TAG_RESOLVERS: { [K in 'project' | 'task' | 'session' | 'agent']: TagResolver } = {
  project: async (id, db) => {
    const rows = await db
      .select({ tagId: projectTags.tagId })
      .from(projectTags)
      .where(eq(projectTags.projectId, id));
    return rows.map((r) => r.tagId);
  },
  task: async (id, db) => {
    const rows = await db
      .select({ tagId: taskTags.tagId })
      .from(taskTags)
      .where(eq(taskTags.taskId, id));
    if (rows.length > 0) return rows.map((r) => r.tagId);
    // Fallback to parent project tags
    const taskRows = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, id));
    if (taskRows[0]?.projectId) {
      return TAG_RESOLVERS.project(taskRows[0].projectId, db);
    }
    return [];
  },
  session: async (id, db) => {
    const sessionRows = await db
      .select({ taskId: sessions.taskId, projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, id));
    const session = sessionRows[0];
    if (!session) return [];
    if (session.taskId) {
      const resolvedTaskTags = await TAG_RESOLVERS.task(session.taskId, db);
      if (resolvedTaskTags.length > 0) return resolvedTaskTags;
    }
    if (session.projectId) {
      return TAG_RESOLVERS.project(session.projectId, db);
    }
    return [];
  },
  agent: async (id, db) => {
    const agentRows = await db
      .select({ projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, id));
    if (agentRows[0]?.projectId) {
      return TAG_RESOLVERS.project(agentRows[0].projectId, db);
    }
    return [];
  },
};

/** Map URL path prefixes to resource types */
type TagResourceType = keyof typeof TAG_RESOLVERS;
const PATH_TO_RESOURCE: Array<[string, TagResourceType]> = [
  ['/api/projects/', 'project'],
  ['/api/tasks/', 'task'],
  ['/api/sessions/', 'session'],
  ['/api/agents/', 'agent'],
];

/**
 * Middleware that checks tag-based access for API tokens with tag restrictions.
 */
export function requireTagAccess(db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    if (!auth) {
      return c.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    // Only API tokens can have tag restrictions; skip for all other auth methods
    if (auth.authMethod !== 'api_token') {
      return next();
    }

    // Skip if token has no tag restrictions
    if (!auth.tokenScope?.tags || auth.tokenScope.tags.length === 0) {
      return next();
    }

    const scopeTags = auth.tokenScope.tags;
    const path = c.req.path;

    // Determine resource type from path
    let resourceType: TagResourceType | null = null;
    for (const [prefix, type] of PATH_TO_RESOURCE) {
      if (path.startsWith(prefix)) {
        resourceType = type;
        break;
      }
    }

    if (!resourceType) {
      log.warn('Tag-restricted token denied on unrecognized resource path', {
        data: { path, tokenId: auth.tokenScope.tokenId },
      });
      return c.json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Tag-restricted tokens cannot access this resource type',
          },
        },
        403
      );
    }

    const resourceId = c.req.param('id');
    if (!resourceId) {
      log.warn('Tag-restricted token denied on collection endpoint (no resource ID)', {
        data: { path, resourceType, tokenId: auth.tokenScope.tokenId },
      });
      return c.json(
        {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Tag-restricted tokens must specify a resource ID' },
        },
        403
      );
    }

    const resolver = TAG_RESOLVERS[resourceType];

    let resourceTags: string[];
    try {
      resourceTags = await resolver(resourceId, db);
    } catch (error) {
      log.error('Failed to resolve resource tags', { error, data: { resourceType, resourceId } });
      return c.json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to check tag access' } },
        500
      );
    }

    // Deny if resource has no tags (invisible to tag-restricted tokens)
    if (resourceTags.length === 0) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Resource not accessible with tag-restricted token',
          },
        },
        403
      );
    }

    if (!scopeTags.some((t) => resourceTags.includes(t))) {
      return c.json(
        {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Token tags do not match resource tags' },
        },
        403
      );
    }

    return next();
  };
}
