/**
 * RBAC Middleware
 *
 * Provides role-based access control middleware for Hono API routes.
 * Slots in after the existing authMiddleware in the request pipeline.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import {
  RBAC_ROLE_LEVEL,
  RBAC_ROLES,
  type RbacRole,
  resolveHighestRole,
} from '../../db/schema/shared/enums';
import { agents } from '../../db/schema/sqlite/agents';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import { codespaceTags } from '../../db/schema/sqlite/codespace-tags';
import { sessions } from '../../db/schema/sqlite/sessions';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import { tasks } from '../../db/schema/sqlite/tasks';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { createLogger } from '../logging/logger';
import type { AuthContext } from './auth-middleware';
import { isDevAuthAllowed } from './dev-auth.js';

interface CachedApiToken {
  id: string;
  role: RbacRole;
  scopeCodespaceId: string | null;
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
      // No auth context means the upstream authMiddleware intentionally skipped
      // this request (e.g. /api/auth/*, health endpoints). Pass through silently.
      return next();
    }

    const rbacAuth: AuthContext = { ...auth };

    // Dev-mode users get owner role automatically.
    // Defense-in-depth (F06-05): route the gate through `isDevAuthAllowed()`
    // so bootstrap, auth-middleware, and rbac-middleware all share a single
    // source of truth. If this layer sees a 'dev' authMethod when the
    // helper says it shouldn't be allowed, something upstream is
    // misconfigured — log loudly and refuse.
    if (auth.authMethod === 'dev') {
      if (!isDevAuthAllowed()) {
        log.error('SECURITY: Dev-mode authentication detected with isDevAuthAllowed=false', {
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
            githubEmail: user.githubEmail,
            avatarUrl: user.avatarUrl,
          };

          rbacAuth.teamMemberships = memberships
            .filter((m) => {
              const valid = (RBAC_ROLES as readonly string[]).includes(m.role);
              if (!valid) {
                log.warn('Skipping team membership with invalid role', {
                  data: { userId: auth.userId, teamId: m.teamId, role: m.role },
                });
              }
              return valid;
            })
            .map((m) => ({
              teamId: m.teamId,
              role: m.role as RbacRole,
            }));

          // Find highest global role (resolveHighestRole validates roles internally)
          const highest = resolveHighestRole(memberships);
          if (highest) {
            rbacAuth.resolvedRole = highest.role;
            rbacAuth.roleLevel = highest.level;
          } else if (memberships.length > 0) {
            log.warn('User has team memberships but no valid role resolved', {
              data: { userId: auth.userId, membershipCount: memberships.length, path: c.req.path },
            });
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
              .catch((err) =>
                log.error('Failed to update expired token status', {
                  error: err,
                  data: { tokenId: token.id },
                })
              );
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
            codespaceId: token.scopeCodespaceId,
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
            .catch((err) =>
              log.error('Failed to update token usage tracking', {
                error: err,
                data: { tokenId: token.id },
              })
            );
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
 * - Codespace context (from :id param, ?codespaceId query, or body.codespaceId)
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

    // Try to extract codespaceId from route params, query, or request body.
    // Only use :id as codespaceId on /api/codespaces/* routes — on other routes
    // (tasks, sessions, agents, worktrees) the :id is a different resource.
    const path = c.req.path;
    let codespaceId = c.req.query('codespaceId');
    if (!codespaceId && path.startsWith('/api/codespaces/')) {
      codespaceId = c.req.param('id');
    }

    // Fallback: try to extract codespaceId from the request body (only for methods that have a body).
    // NOTE (AR-010): This clones and parses the request body, adding overhead for every
    // POST/PUT/PATCH passing through requireRole. For routes where codespaceId is always in the
    // URL or query string, this parse is wasted work. Consider passing codespaceId explicitly
    // in query params to avoid the body clone overhead in hot paths.
    if (!codespaceId && ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      try {
        const body = await c.req.raw.clone().json();
        if (body && typeof body === 'object' && typeof body.codespaceId === 'string') {
          codespaceId = body.codespaceId;
        }
      } catch (parseError) {
        // SyntaxError means the body is not JSON (e.g. form-data, empty body, binary).
        // This is expected for non-JSON endpoints and is silently ignored.
        if (!(parseError instanceof SyntaxError)) {
          log.error('Unexpected error parsing request body for codespaceId', {
            error: parseError,
            data: { path: c.req.path },
          });
          // If we couldn't extract a codespaceId from URL and body parsing failed unexpectedly,
          // deny rather than falling back to potentially less-restrictive global role
          if (!codespaceId) {
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

    if (codespaceId) {
      // Codespace-scoped: resolve role for this specific codespace
      effectiveRole = await rbacService.resolveUserRole(auth.userId, codespaceId);

      // Apply token ceiling if applicable
      if (effectiveRole && auth.tokenScope) {
        effectiveRole = rbacService.applyTokenCeiling(effectiveRole, auth.tokenScope.role);

        // Check codespace scope restriction
        if (!rbacService.checkCodespaceScope(auth.tokenScope.codespaceId ?? null, codespaceId)) {
          return c.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Token not scoped for this codespace' },
            },
            403
          );
        }
      }
    } else {
      // No codespace context -- use global role
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

const TAG_RESOLVERS: { [K in 'codespace' | 'task' | 'session' | 'agent']: TagResolver } = {
  codespace: async (id, db) => {
    const rows = await db
      .select({ tagId: codespaceTags.tagId })
      .from(codespaceTags)
      .where(eq(codespaceTags.codespaceId, id));
    return rows.map((r) => r.tagId);
  },
  task: async (id, db) => {
    const rows = await db
      .select({ tagId: taskTags.tagId })
      .from(taskTags)
      .where(eq(taskTags.taskId, id));
    if (rows.length > 0) return rows.map((r) => r.tagId);
    // Fallback to parent codespace tags
    const taskRows = await db
      .select({ codespaceId: tasks.codespaceId })
      .from(tasks)
      .where(eq(tasks.id, id));
    if (taskRows[0]?.codespaceId) {
      return TAG_RESOLVERS.codespace(taskRows[0].codespaceId, db);
    }
    return [];
  },
  session: async (id, db) => {
    const sessionRows = await db
      .select({ taskId: sessions.taskId, codespaceId: sessions.codespaceId })
      .from(sessions)
      .where(eq(sessions.id, id));
    const session = sessionRows[0];
    if (!session) return [];
    if (session.taskId) {
      const resolvedTaskTags = await TAG_RESOLVERS.task(session.taskId, db);
      if (resolvedTaskTags.length > 0) return resolvedTaskTags;
    }
    if (session.codespaceId) {
      return TAG_RESOLVERS.codespace(session.codespaceId, db);
    }
    return [];
  },
  agent: async (id, db) => {
    const agentRows = await db
      .select({ codespaceId: agents.codespaceId })
      .from(agents)
      .where(eq(agents.id, id));
    if (agentRows[0]?.codespaceId) {
      return TAG_RESOLVERS.codespace(agentRows[0].codespaceId, db);
    }
    return [];
  },
};

/** Map URL path prefixes to resource types */
type TagResourceType = keyof typeof TAG_RESOLVERS;
const PATH_TO_RESOURCE: Array<[string, TagResourceType]> = [
  ['/api/codespaces', 'codespace'],
  ['/api/tasks', 'task'],
  ['/api/sessions', 'session'],
  ['/api/agents', 'agent'],
];

/**
 * Match a request path against a resource-prefix table.
 *
 * Accepts both bare collection (`/api/codespaces`) and any sub-path
 * (`/api/codespaces/<id>`, `/api/codespaces/summaries`, etc.). Critically,
 * `/api/codespaces` and `/api/codespaces/` are both treated as collection
 * endpoints, while `/api/codespaces-of-something-else` does NOT match
 * (the next char after the prefix must be `/` or end-of-string).
 */
function matchResourceType(path: string): TagResourceType | null {
  for (const [prefix, type] of PATH_TO_RESOURCE) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return type;
    }
  }
  return null;
}

/**
 * Pure-path resource ID detector.
 *
 * `requireTagAccess` is wired as a wildcard middleware (`/api/*`), which means
 * Hono has not yet matched the specific route — `c.req.param('id')` returns
 * undefined for ALL paths, even single-resource fetches like `/api/tasks/<id>`.
 * The original implementation relied on per-route mounting, which was lost in
 * the global pipeline.
 *
 * To recover correctness without restructuring the middleware tree, derive the
 * resource ID directly from the path: anything past the prefix that isn't a
 * known sub-collection name (e.g. `summaries`, `create-with-ai`) is treated as
 * a `:id`-style segment.
 *
 * Returns `null` when the path is a collection endpoint (no id segment) or a
 * known sub-collection.
 */
const KNOWN_SUB_COLLECTIONS: { [K in TagResourceType]?: ReadonlySet<string> } = {
  codespace: new Set(['summaries', 'create-with-ai']),
  task: new Set(['create-with-ai']),
};

function extractResourceId(path: string, resourceType: TagResourceType): string | null {
  const prefix = PATH_TO_RESOURCE.find(([_, type]) => type === resourceType)?.[0];
  if (!prefix) return null;
  // Strip the prefix and any leading slash.
  const tail = path === prefix ? '' : path.slice(prefix.length + 1);
  if (tail.length === 0) return null;

  // The first segment after the prefix is either a resource ID or a
  // sub-collection name. Sub-collections (like `summaries`) should NOT be
  // treated as a resource ID — they are themselves collection endpoints.
  const firstSegment = tail.split('/')[0] ?? '';
  if (firstSegment.length === 0) return null;

  const subCollections = KNOWN_SUB_COLLECTIONS[resourceType];
  if (subCollections?.has(firstSegment)) return null;

  return firstSegment;
}

/**
 * Middleware that checks tag-based access for API tokens with tag restrictions.
 *
 * Two modes:
 * 1. **Resource endpoint** (`:id` present): resolve the resource's tags and
 *    deny if there is no overlap with the token's scope tags.
 * 2. **Collection endpoint** (no `:id`, recognized resource type): set
 *    `auth.tagFilter` on the request context so the route handler can filter
 *    its results. Without this hook, F06-NEW-07 lets tag-restricted tokens
 *    list every resource (because the middleware previously 403'd, which
 *    forced operators to either grant unrestricted tokens or strip
 *    `requireTagAccess` from their global pipeline).
 *
 * Unrecognized resource paths still return 403.
 */
export function requireTagAccess(db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    if (!auth) {
      // No auth context — unauthenticated path (skipped by authMiddleware). Pass through.
      return next();
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

    // Determine resource type from path. The matcher accepts the bare
    // collection (`/api/codespaces`) and any sub-path under it.
    const resourceType: TagResourceType | null = matchResourceType(path);

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

    // Prefer path-based detection because the middleware is mounted at
    // `/api/*` (before Hono's route matching populates `c.req.param('id')`).
    // We fall back to the param if the runtime did pre-match (e.g. tests that
    // attach the middleware per-route).
    const resourceId = extractResourceId(path, resourceType) ?? c.req.param('id');
    if (!resourceId) {
      // F06-NEW-07: collection endpoint. Set the tag filter on the auth context
      // and pass through; the route handler is responsible for narrowing its
      // result set via `applyTokenTagFilter` (see helpers below).
      const updatedAuth: AuthContext = {
        ...auth,
        tagFilter: {
          resourceType,
          scopeTags,
        },
      };
      c.set('auth', updatedAuth);
      log.debug('Tag-restricted token: collection filter applied', {
        data: { path, resourceType, tokenId: auth.tokenScope.tokenId, scopeTags },
      });
      return next();
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

/**
 * Resolve the set of resource IDs of a given type that a tag-restricted token
 * should be able to see, based on the token's scope tags.
 *
 * Semantics mirror the per-resource `TAG_RESOLVERS`:
 *   - **codespace**: codespaces directly tagged with any of `scopeTags`.
 *   - **task**: tasks directly tagged OR tasks whose parent codespace is tagged.
 *   - **session**: sessions whose linked task or parent codespace is tagged.
 *   - **agent**: agents whose parent codespace is tagged.
 *
 * Returns `null` to mean *no filter*. Returns an empty array to mean *no
 * accessible resources* (and therefore the list result must be empty).
 *
 * F06-NEW-07: this helper is the engine behind `applyTokenTagFilter` and is
 * exported for routes that need to filter directly in their Drizzle queries
 * (e.g. via `inArray(table.id, ids)`) rather than post-fetch.
 */
export async function getAccessibleResourceIds(
  db: Database,
  resourceType: 'codespace' | 'task' | 'session' | 'agent',
  scopeTags: string[]
): Promise<string[]> {
  if (scopeTags.length === 0) {
    // No tags = no restriction, so an empty filter would mean *no results*.
    // Callers should treat `[]` as "deny everything"; that's the safe default
    // for tag-restricted tokens with empty scope tags (which the middleware
    // already short-circuits, but we keep the invariant explicit).
    return [];
  }

  // Step 1: codespaces directly tagged with any scope tag.
  const taggedCodespaceRows = await db
    .select({ codespaceId: codespaceTags.codespaceId })
    .from(codespaceTags)
    .where(inArray(codespaceTags.tagId, scopeTags));
  const taggedCodespaceIds = Array.from(new Set(taggedCodespaceRows.map((r) => r.codespaceId)));

  if (resourceType === 'codespace') {
    return taggedCodespaceIds;
  }

  if (resourceType === 'task') {
    // Tasks directly tagged.
    const directTaggedRows = await db
      .select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(inArray(taskTags.tagId, scopeTags));
    const directIds = directTaggedRows.map((r) => r.taskId);

    // Tasks under a tagged codespace (inheritance).
    let inheritedIds: string[] = [];
    if (taggedCodespaceIds.length > 0) {
      const inheritedRows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.codespaceId, taggedCodespaceIds));
      inheritedIds = inheritedRows.map((r) => r.id);
    }
    return Array.from(new Set([...directIds, ...inheritedIds]));
  }

  if (resourceType === 'agent') {
    if (taggedCodespaceIds.length === 0) return [];
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.codespaceId, taggedCodespaceIds));
    return rows.map((r) => r.id);
  }

  // session: union of (sessions whose taskId is in accessible-tasks) and
  // (sessions whose codespaceId is in tagged-codespaces).
  const accessibleTaskIds = await getAccessibleResourceIds(db, 'task', scopeTags);
  const accessibleSessionIds = new Set<string>();

  if (accessibleTaskIds.length > 0) {
    const byTask = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.taskId, accessibleTaskIds));
    for (const row of byTask) accessibleSessionIds.add(row.id);
  }
  if (taggedCodespaceIds.length > 0) {
    const byCodespace = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.codespaceId, taggedCodespaceIds));
    for (const row of byCodespace) accessibleSessionIds.add(row.id);
  }
  return Array.from(accessibleSessionIds);
}

/**
 * Filter a list of fetched resources to only those visible to a tag-restricted
 * token. Returns the input unchanged when no `tagFilter` is set on the auth
 * context (i.e. unrestricted tokens, session/dev auth, or scoped resource
 * routes that already enforce per-ID access).
 *
 * Use this from list-route handlers AFTER fetching the result set:
 *
 * ```ts
 * const auth = c.get('auth') as AuthContext | undefined;
 * const filtered = await applyTokenTagFilter(db, auth, items, (item) => item.id);
 * ```
 *
 * `getId` extracts the resource ID from each item — kept generic so the helper
 * works against `Codespace`, `Task`, `Session`, or `Agent` shapes without
 * coupling to specific schemas.
 *
 * F06-NEW-07: this is the read-time enforcement that prevents tag-restricted
 * tokens from seeing every resource via `GET /api/codespaces` and friends.
 */
export async function applyTokenTagFilter<T>(
  db: Database,
  auth: AuthContext | undefined,
  items: T[],
  getId: (item: T) => string
): Promise<T[]> {
  if (!auth?.tagFilter) return items;
  if (items.length === 0) return items;

  const accessibleIds = await getAccessibleResourceIds(
    db,
    auth.tagFilter.resourceType,
    auth.tagFilter.scopeTags
  );
  const idSet = new Set(accessibleIds);
  return items.filter((item) => idSet.has(getId(item)));
}
