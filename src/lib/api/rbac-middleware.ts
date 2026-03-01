/**
 * RBAC Middleware
 *
 * Provides role-based access control middleware for Hono API routes.
 * Slots in after the existing authMiddleware in the request pipeline.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole, resolveHighestRole } from '../../db/schema/shared/enums';
import { agents } from '../../db/schema/sqlite/agents';
import { type ApiToken, apiTokens } from '../../db/schema/sqlite/api-tokens';
import { projectTags } from '../../db/schema/sqlite/project-tags';
import { sessions } from '../../db/schema/sqlite/sessions';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import { tasks } from '../../db/schema/sqlite/tasks';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import { hashToken } from '../../server/shared';
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
      return c.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    const rbacAuth: AuthContext = { ...auth };

    // Dev-mode users get owner role automatically
    if (auth.authMethod === 'dev') {
      if (process.env.NODE_ENV === 'production') {
        log.error('SECURITY: Dev-mode authentication detected in production', {
          data: { userId: auth.userId, path: c.req.path },
        });
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
        // Reuse the token record cached by createAuthMiddleware to avoid
        // a redundant SHA-256 hash + DB query on every request.
        const cachedRecord = c.get('apiTokenRecord') as ApiToken | undefined;
        let token:
          | Pick<ApiToken, 'id' | 'role' | 'scopeProjectId' | 'scopeTags' | 'expiresAt'>
          | undefined;

        if (cachedRecord) {
          token = cachedRecord;
        } else {
          // Fallback: re-derive from Authorization header (should not happen in normal flow)
          const authHeader = c.req.header('Authorization');
          if (authHeader?.startsWith('Bearer ')) {
            const rawToken = authHeader.substring(7).trim();
            if (!rawToken || (!rawToken.startsWith('ap_') && rawToken.length < 20)) {
              return c.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API token format' } },
                401
              );
            }
            const tokenHash = hashToken(rawToken);

            const tokenRecords = await db
              .select({
                id: apiTokens.id,
                role: apiTokens.role,
                scopeProjectId: apiTokens.scopeProjectId,
                scopeTags: apiTokens.scopeTags,
                expiresAt: apiTokens.expiresAt,
              })
              .from(apiTokens)
              .where(and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')));

            token = tokenRecords[0];
          }
        }

        if (token) {
          // Check if token has expired
          if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
            // Lazily update status to expired (fire-and-forget)
            void db
              .update(apiTokens)
              .set({ status: 'expired' })
              .where(eq(apiTokens.id, token.id))
              .catch((err) => log.warn('Failed to update expired token status', { error: err }));
            return c.json(
              { ok: false, error: { code: 'UNAUTHORIZED', message: 'API token has expired' } },
              401
            );
          }
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
          } else {
            // User has no membership role — use token role as effective role
            rbacAuth.resolvedRole = token.role as RbacRole;
            rbacAuth.roleLevel = RBAC_ROLE_LEVEL[token.role as RbacRole];
          }

          // Update lastUsedAt and useCount asynchronously (fire-and-forget to avoid blocking the request)
          void db
            .update(apiTokens)
            .set({
              lastUsedAt: new Date().toISOString(),
              useCount: sql`COALESCE(${apiTokens.useCount}, 0) + 1`,
            })
            .where(eq(apiTokens.id, token.id))
            .catch((err) => log.error('Failed to update token usage tracking', { error: err }));
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

    // Try to extract projectId from route params, query, or request body
    let projectId = c.req.param('id') ?? c.req.query('projectId');

    // Fallback: try to extract projectId from the request body (only for methods that have a body)
    if (!projectId && ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      try {
        const body = await c.req.raw.clone().json();
        if (body && typeof body === 'object' && typeof body.projectId === 'string') {
          projectId = body.projectId;
        }
      } catch {
        // Body is not JSON or not available — continue without projectId
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
 * Middleware that checks tag-based access for API tokens with tag restrictions.
 *
 * For API tokens with scopeTags, this middleware verifies that the requested
 * resource (project or task) has at least one tag matching the token's allowed tags.
 *
 * Bypassed when:
 * - User is not using an API token
 * - Token has no tag restrictions (scopeTags is null or empty)
 * - User is in dev mode
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

    // Skip for non-token auth or dev mode
    if (auth.authMethod === 'dev' || auth.authMethod !== 'api_token') {
      return next();
    }

    // Skip if token has no tag restrictions
    if (!auth.tokenScope?.tags || auth.tokenScope.tags.length === 0) {
      return next();
    }

    const scopeTags = auth.tokenScope.tags;

    // Determine the resource type from the route path
    const path = c.req.path;

    // For project routes: check project tags
    if (path.startsWith('/api/projects/')) {
      const projectId = c.req.param('id');
      if (projectId) {
        const projectTagRows = await db
          .select({ tagId: projectTags.tagId })
          .from(projectTags)
          .where(eq(projectTags.projectId, projectId));

        const resourceTagIds = projectTagRows.map((r) => r.tagId);

        if (!scopeTags.some((t) => resourceTagIds.includes(t))) {
          return c.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Token tags do not match project tags' },
            },
            403
          );
        }
      }
    }

    // For task routes: check task tags, fallback to parent project tags
    if (path.startsWith('/api/tasks/')) {
      const taskId = c.req.param('id');
      if (taskId) {
        const taskTagRows = await db
          .select({ tagId: taskTags.tagId })
          .from(taskTags)
          .where(eq(taskTags.taskId, taskId));

        const resourceTagIds = taskTagRows.map((r) => r.tagId);

        // Check task's own tags first
        if (!scopeTags.some((t) => resourceTagIds.includes(t))) {
          // Fallback: look up the task's parent project and check project tags
          const taskRows = await db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, taskId));

          const taskRow = taskRows[0];
          if (taskRow?.projectId) {
            const parentProjectTagRows = await db
              .select({ tagId: projectTags.tagId })
              .from(projectTags)
              .where(eq(projectTags.projectId, taskRow.projectId));

            const parentTagIds = parentProjectTagRows.map((r) => r.tagId);

            if (!scopeTags.some((t) => parentTagIds.includes(t))) {
              return c.json(
                {
                  ok: false,
                  error: {
                    code: 'FORBIDDEN',
                    message: 'Token tags do not match task or project tags',
                  },
                },
                403
              );
            }
          } else {
            // Task not found or has no projectId — deny access
            return c.json(
              {
                ok: false,
                error: { code: 'FORBIDDEN', message: 'Token tags do not match task tags' },
              },
              403
            );
          }
        }
      }
    }

    // For session routes: check task tags (via session.taskId), fallback to project tags (via session.projectId)
    if (path.startsWith('/api/sessions/')) {
      const sessionId = c.req.param('id');
      if (sessionId) {
        const sessionRows = await db
          .select({ taskId: sessions.taskId, projectId: sessions.projectId })
          .from(sessions)
          .where(eq(sessions.id, sessionId));

        const sessionRow = sessionRows[0];
        if (sessionRow) {
          let tagMatch = false;

          // When both taskId and projectId are available, fetch tags in parallel
          if (sessionRow.taskId && sessionRow.projectId) {
            const [sessionTaskTagRows, sessionProjectTagRows] = await Promise.all([
              db
                .select({ tagId: taskTags.tagId })
                .from(taskTags)
                .where(eq(taskTags.taskId, sessionRow.taskId)),
              db
                .select({ tagId: projectTags.tagId })
                .from(projectTags)
                .where(eq(projectTags.projectId, sessionRow.projectId)),
            ]);

            // Check task tags first
            const sessionTaskTagIds = sessionTaskTagRows.map((r) => r.tagId);
            if (scopeTags.some((t) => sessionTaskTagIds.includes(t))) {
              tagMatch = true;
            }

            // Fallback: check project tags
            if (!tagMatch) {
              const sessionProjectTagIds = sessionProjectTagRows.map((r) => r.tagId);
              if (scopeTags.some((t) => sessionProjectTagIds.includes(t))) {
                tagMatch = true;
              }
            }
          } else if (sessionRow.taskId) {
            // Only task tags to check
            const sessionTaskTagRows = await db
              .select({ tagId: taskTags.tagId })
              .from(taskTags)
              .where(eq(taskTags.taskId, sessionRow.taskId));

            const sessionTaskTagIds = sessionTaskTagRows.map((r) => r.tagId);
            if (scopeTags.some((t) => sessionTaskTagIds.includes(t))) {
              tagMatch = true;
            }
          } else if (sessionRow.projectId) {
            // Only project tags to check
            const sessionProjectTagRows = await db
              .select({ tagId: projectTags.tagId })
              .from(projectTags)
              .where(eq(projectTags.projectId, sessionRow.projectId));

            const sessionProjectTagIds = sessionProjectTagRows.map((r) => r.tagId);
            if (scopeTags.some((t) => sessionProjectTagIds.includes(t))) {
              tagMatch = true;
            }
          }

          if (!tagMatch) {
            return c.json(
              {
                ok: false,
                error: {
                  code: 'FORBIDDEN',
                  message: 'Token tags do not match session resource tags',
                },
              },
              403
            );
          }
        } else {
          // Session not found — deny access for tag-restricted tokens
          return c.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Session not found' },
            },
            403
          );
        }
      }
    }

    // For agent routes: check project tags via agent.projectId
    if (path.startsWith('/api/agents/')) {
      const agentId = c.req.param('id');
      if (agentId) {
        const agentRows = await db
          .select({ projectId: agents.projectId })
          .from(agents)
          .where(eq(agents.id, agentId));

        const agentRow = agentRows[0];
        if (agentRow?.projectId) {
          const agentProjectTagRows = await db
            .select({ tagId: projectTags.tagId })
            .from(projectTags)
            .where(eq(projectTags.projectId, agentRow.projectId));

          const agentProjectTagIds = agentProjectTagRows.map((r) => r.tagId);

          if (!scopeTags.some((t) => agentProjectTagIds.includes(t))) {
            return c.json(
              {
                ok: false,
                error: { code: 'FORBIDDEN', message: 'Token tags do not match agent project tags' },
              },
              403
            );
          }
        } else {
          // Agent not found — deny access for tag-restricted tokens
          return c.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Agent not found' },
            },
            403
          );
        }
      }
    }

    return next();
  };
}
