# RBAC Middleware Specification

## Overview

This specification defines three Hono middleware functions that enforce Role-Based Access Control in the AgentPane API router. These middlewares run **after** the existing `authMiddleware` (defined in `src/server/router.ts`) and build upon the `AuthContext` it produces.

**Middleware Pipeline Order**:

```
Request
  → cors()
  → logger()
  → requestIdMiddleware()
  → securityHeaders()
  → rateLimiter()
  → authMiddleware()          ← existing: extracts userId + authMethod
  → enrichAuthContext(db)     ← NEW: hydrates user record, team memberships, token scope
  → requireRole(minimumRole) ← NEW: per-route role gate
  → requireTagAccess()       ← NEW: per-route tag restriction (optional)
  → route handler
```

---

## Extended AuthContext Interface

The `enrichAuthContext` middleware extends the base `AuthContext` (from `src/lib/api/auth-middleware.ts`) with RBAC-specific fields:

```typescript
// lib/rbac/auth-context.ts

import type { RbacRole } from './types';

/**
 * User record from the database, hydrated by enrichAuthContext.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  githubLogin?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Extended authentication context with RBAC fields.
 *
 * The base fields (userId, authMethod) are set by authMiddleware.
 * The RBAC fields are set by enrichAuthContext.
 */
export interface AuthContext {
  // Base fields (set by existing authMiddleware)
  userId: string;
  authMethod: 'session' | 'api_token' | 'dev';

  // RBAC fields (set by enrichAuthContext)
  user?: User;
  resolvedRole?: RbacRole;
  roleLevel?: number;
  teamMemberships?: Array<{ teamId: string; role: RbacRole }>;
  tokenScope?: {
    tokenId: string;
    role: RbacRole;
    projectIds: string[] | null;   // null = unrestricted
    tags: string[] | null;          // null = unrestricted
  };
}
```

---

## Middleware 1: `enrichAuthContext(db)`

### Purpose

Runs after `authMiddleware`. Hydrates the `AuthContext` with the full user record, team memberships, and (if applicable) API token scope. Dev-mode users get `owner` role automatically without database lookups.

### Signature

```typescript
import type { Context, Next } from 'hono';
import type { Database } from '@/types/database';

export function enrichAuthContext(db: Database): (c: Context, next: Next) => Promise<Response | void>;
```

### Behavior

```typescript
// lib/rbac/middleware/enrich-auth-context.ts

import type { Context, Next } from 'hono';
import type { Database } from '@/types/database';
import type { AuthContext } from '../auth-context';
import { ROLE_LEVELS } from '../types';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('RBAC:enrich');

export function enrichAuthContext(db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    // If authMiddleware didn't run (e.g., health routes), skip
    if (!auth) {
      return next();
    }

    // Dev-mode: auto-assign owner role, no DB lookups
    if (auth.authMethod === 'dev') {
      auth.resolvedRole = 'owner';
      auth.roleLevel = ROLE_LEVELS.owner; // 4

      if (process.env.NODE_ENV === 'production') {
        log.warn('Dev-mode authentication detected in production environment', {
          userId: auth.userId,
        });
      }

      c.set('auth', auth);
      return next();
    }

    // 1. Hydrate user record
    const user = await db.query.users.findFirst({
      where: eq(users.id, auth.userId),
    });

    if (!user) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not found.',
          },
        },
        401
      );
    }

    auth.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl ?? undefined,
      githubLogin: user.githubLogin ?? undefined,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    // 2. Hydrate team memberships
    const memberships = await db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, auth.userId),
    });

    auth.teamMemberships = memberships.map((m) => ({
      teamId: m.teamId,
      role: m.role as RbacRole,
    }));

    // 3. If authenticated via API token, hydrate token scope
    if (auth.authMethod === 'api_token') {
      // The token was already validated by authMiddleware.
      // Retrieve full token metadata for scope enforcement.
      const token = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.userId, auth.userId),
        // Token is already validated; lookup by userId + active status
        columns: {
          id: true,
          role: true,
          scopeProjectIds: true,
          scopeTags: true,
        },
      });

      if (token) {
        auth.tokenScope = {
          tokenId: token.id,
          role: token.role as RbacRole,
          projectIds: token.scopeProjectIds,
          tags: token.scopeTags,
        };
      }
    }

    c.set('auth', auth);
    return next();
  };
}
```

### Registration

```typescript
// In src/server/router.ts, after the existing authMiddleware:

app.use('/api/*', authMiddleware);
app.use('/api/*', enrichAuthContext(deps.db));  // NEW
```

---

## Middleware 2: `requireRole(minimumRole)`

### Purpose

Per-route middleware factory that enforces a minimum RBAC role. Resolves the user's effective role for the target project (extracted from request params, query, or body) and returns 403 if insufficient.

### Signature

```typescript
import type { MiddlewareHandler } from 'hono';
import type { RbacRole } from '../types';

export function requireRole(minimumRole: RbacRole): MiddlewareHandler;
```

### Behavior

```typescript
// lib/rbac/middleware/require-role.ts

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { AuthContext } from '../auth-context';
import type { RbacRole } from '../types';
import { ROLE_LEVELS, lowerRole } from '../types';
import { resolveUserRole } from '../resolve-role';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('RBAC:requireRole');

/**
 * Extract projectId from multiple possible request locations.
 *
 * Search order:
 *   1. Route param `:projectId`
 *   2. Query parameter `projectId`
 *   3. Request body `projectId` field (for POST/PATCH/PUT)
 *   4. Route param `:id` on `/api/projects/:id` routes
 *
 * Returns null if no projectId can be determined (team-level routes).
 */
async function extractProjectId(c: Context): Promise<string | null> {
  // 1. Route params
  const paramProjectId = c.req.param('projectId');
  if (paramProjectId) return paramProjectId;

  // 2. Check if this is a /api/projects/:id route
  const path = c.req.path;
  if (path.startsWith('/api/projects/')) {
    const paramId = c.req.param('id');
    if (paramId) return paramId;
  }

  // 3. Query parameter
  const queryProjectId = c.req.query('projectId');
  if (queryProjectId) return queryProjectId;

  // 4. Request body (only for methods that have a body)
  const method = c.req.method;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    try {
      const body = await c.req.json();
      if (body?.projectId) return body.projectId;
    } catch {
      // Body parsing failed or no body — not an error
    }
  }

  return null;
}

export function requireRole(minimumRole: RbacRole): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    if (!auth) {
      return c.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
        401
      );
    }

    // Dev-mode: already resolved as owner by enrichAuthContext
    if (auth.authMethod === 'dev') {
      return next();
    }

    // Resolve the projectId from the request
    const projectId = await extractProjectId(c);

    if (projectId) {
      // Project-scoped request: resolve role for this specific project
      const db = c.get('db') as Database;
      const resolution = await resolveUserRole(db, {
        userId: auth.userId,
        projectId,
        tokenRole: auth.tokenScope?.role,
      });

      if (!resolution) {
        log.info('Access denied: no membership found', {
          userId: auth.userId,
          projectId,
          minimumRole,
        });
        return c.json(
          {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You do not have access to this project.',
            },
          },
          403
        );
      }

      // Check if token is scoped to specific projects
      if (auth.tokenScope?.projectIds !== null && auth.tokenScope?.projectIds !== undefined) {
        if (!auth.tokenScope.projectIds.includes(projectId)) {
          log.info('Access denied: token not scoped to project', {
            userId: auth.userId,
            projectId,
            tokenProjectIds: auth.tokenScope.projectIds,
          });
          return c.json(
            {
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'API token is not authorized for this project.',
              },
            },
            403
          );
        }
      }

      // Check minimum role
      if (ROLE_LEVELS[resolution.effectiveRole] < ROLE_LEVELS[minimumRole]) {
        log.info('Access denied: insufficient role', {
          userId: auth.userId,
          projectId,
          effectiveRole: resolution.effectiveRole,
          minimumRole,
          source: resolution.source,
        });
        return c.json(
          {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: `This action requires ${minimumRole} role or higher. Your effective role is ${resolution.effectiveRole}.`,
            },
          },
          403
        );
      }

      // Store resolved role on auth context for downstream handlers
      auth.resolvedRole = resolution.effectiveRole;
      auth.roleLevel = ROLE_LEVELS[resolution.effectiveRole];
      c.set('auth', auth);

    } else {
      // Team-level request (no project context): use highest team role
      if (!auth.teamMemberships || auth.teamMemberships.length === 0) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You are not a member of any team.',
            },
          },
          403
        );
      }

      // Find highest role across all team memberships
      let highestRole: RbacRole = auth.teamMemberships[0].role;
      for (const membership of auth.teamMemberships.slice(1)) {
        if (ROLE_LEVELS[membership.role] > ROLE_LEVELS[highestRole]) {
          highestRole = membership.role;
        }
      }

      // Apply token ceiling
      let effectiveRole = highestRole;
      if (auth.tokenScope?.role) {
        effectiveRole = lowerRole(effectiveRole, auth.tokenScope.role);
      }

      if (ROLE_LEVELS[effectiveRole] < ROLE_LEVELS[minimumRole]) {
        log.info('Access denied: insufficient team role', {
          userId: auth.userId,
          effectiveRole,
          minimumRole,
        });
        return c.json(
          {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: `This action requires ${minimumRole} role or higher. Your effective role is ${effectiveRole}.`,
            },
          },
          403
        );
      }

      auth.resolvedRole = effectiveRole;
      auth.roleLevel = ROLE_LEVELS[effectiveRole];
      c.set('auth', auth);
    }

    return next();
  };
}
```

### Usage in Routes

```typescript
// src/server/routes/tasks.ts

import { requireRole } from '@/lib/rbac/middleware/require-role';

const tasksRouter = new Hono();

// Viewer can list tasks
tasksRouter.get('/', requireRole('viewer'), async (c) => {
  // ...
});

// Agent operator can create tasks
tasksRouter.post('/', requireRole('agent_operator'), async (c) => {
  // ...
});

// Agent operator can move tasks
tasksRouter.patch('/:id/move', requireRole('agent_operator'), async (c) => {
  // ...
});

// Admin can delete projects
// (in projects router)
projectsRouter.delete('/:id', requireRole('admin'), async (c) => {
  // ...
});

// Owner can transfer ownership
// (in teams router)
teamsRouter.post('/:id/transfer-ownership', requireRole('owner'), async (c) => {
  // ...
});
```

### Route-to-Role Mapping

| Route Pattern | Method | Minimum Role |
|--------------|--------|-------------|
| `/api/projects` | GET | `viewer` |
| `/api/projects` | POST | `admin` |
| `/api/projects/:id` | GET | `viewer` |
| `/api/projects/:id` | PATCH | `admin` |
| `/api/projects/:id` | DELETE | `admin` |
| `/api/tasks` | GET | `viewer` |
| `/api/tasks` | POST | `agent_operator` |
| `/api/tasks/:id` | GET | `viewer` |
| `/api/tasks/:id` | PATCH | `agent_operator` |
| `/api/tasks/:id/move` | PATCH | `agent_operator` |
| `/api/tasks/:id` | DELETE | `agent_operator` |
| `/api/agents` | GET | `viewer` |
| `/api/agents/:id/start` | POST | `agent_operator` |
| `/api/agents/:id/stop` | POST | `agent_operator` |
| `/api/agents/:id/approve` | POST | `agent_operator` |
| `/api/agents/:id/reject` | POST | `agent_operator` |
| `/api/sessions` | GET | `viewer` |
| `/api/sessions/:id` | GET | `viewer` |
| `/api/sessions/:id/stream` | GET | `viewer` |
| `/api/worktrees` | GET | `viewer` |
| `/api/settings` | GET | `admin` |
| `/api/settings` | PATCH | `admin` |
| `/api/keys` | GET | `admin` |
| `/api/keys` | POST | `admin` |
| `/api/keys/:id` | DELETE | `admin` |
| `/api/teams/:id/members` | GET | `admin` |
| `/api/teams/:id/members` | POST | `admin` |
| `/api/teams/:id/members/:userId` | PATCH | `admin` |
| `/api/teams/:id/members/:userId` | DELETE | `admin` |
| `/api/teams/:id/delete` | DELETE | `owner` |
| `/api/teams/:id/transfer-ownership` | POST | `owner` |
| `/api/health` | GET | _(no auth)_ |
| `/api/healthz` | GET | _(no auth)_ |
| `/api/readyz` | GET | _(no auth)_ |

---

## Middleware 3: `requireTagAccess()`

### Purpose

For API tokens that are restricted to specific tags (via `scopeTags`). This middleware checks that the target resource's tags overlap with the token's allowed tags. It is bypassed when `scopeTags` is `null` (unrestricted token) or when the request is not from an API token.

### Signature

```typescript
import type { MiddlewareHandler } from 'hono';

export function requireTagAccess(): MiddlewareHandler;
```

### Behavior

```typescript
// lib/rbac/middleware/require-tag-access.ts

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { AuthContext } from '../auth-context';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('RBAC:tagAccess');

/**
 * Extract resource tags from the request context.
 *
 * Tags can come from:
 *   1. The task's `labels` field (for task routes)
 *   2. The project's metadata tags (for project routes)
 *   3. A `tags` query parameter (comma-separated)
 */
async function extractResourceTags(c: Context): Promise<string[]> {
  // Check if resource was already loaded and has tags
  const resource = c.get('resource') as { labels?: string[]; tags?: string[] } | undefined;
  if (resource?.labels) return resource.labels;
  if (resource?.tags) return resource.tags;

  // Check query parameter
  const queryTags = c.req.query('tags');
  if (queryTags) return queryTags.split(',').map(t => t.trim());

  return [];
}

export function requireTagAccess(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    // Skip if no auth context or not an API token request
    if (!auth || auth.authMethod !== 'api_token') {
      return next();
    }

    // Skip if token has no tag restrictions (null = unrestricted)
    if (!auth.tokenScope || auth.tokenScope.tags === null) {
      return next();
    }

    const allowedTags = auth.tokenScope.tags;
    const resourceTags = await extractResourceTags(c);

    // If the resource has no tags and the token is tag-restricted, deny access
    // (tag-restricted tokens can only access resources with matching tags)
    if (resourceTags.length === 0) {
      return c.json(
        { ok: false, error: { code: 'FORBIDDEN', message: 'API token requires tag-scoped resources.' } },
        403
      );
    }

    // Check for overlap: at least one resource tag must be in the allowed set
    const hasOverlap = resourceTags.some(tag => allowedTags.includes(tag));

    if (!hasOverlap) {
      log.info('Access denied: token tag restriction', {
        userId: auth.userId,
        tokenId: auth.tokenScope.tokenId,
        allowedTags,
        resourceTags,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'API token is not authorized for resources with these tags.',
          },
        },
        403
      );
    }

    return next();
  };
}
```

### Usage

Tag access is applied on routes where resources can be tag-filtered:

```typescript
// src/server/routes/tasks.ts

import { requireRole } from '@/lib/rbac/middleware/require-role';
import { requireTagAccess } from '@/lib/rbac/middleware/require-tag-access';

// Tag access check runs after role check
tasksRouter.get('/:id', requireRole('viewer'), requireTagAccess(), async (c) => {
  // Handler only reached if both role AND tag checks pass
});

tasksRouter.patch('/:id', requireRole('agent_operator'), requireTagAccess(), async (c) => {
  // ...
});
```

---

## Error Responses

All RBAC middleware functions produce consistent error responses:

### 401 Unauthorized

Returned when the user cannot be identified or the user record is missing:

```json
{
  "ok": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required."
  }
}
```

### 403 Forbidden

Returned when the user is authenticated but lacks sufficient permissions:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "This action requires admin role or higher. Your effective role is agent_operator."
  }
}
```

For token project restriction:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "API token is not authorized for this project."
  }
}
```

For token tag restriction:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "API token is not authorized for resources with these tags."
  }
}
```

---

## Testing Strategy

### Unit Tests

Each middleware should be tested in isolation with mock Hono contexts:

```typescript
// tests/rbac/middleware/enrich-auth-context.test.ts

describe('enrichAuthContext', () => {
  it('assigns owner role for dev-mode users', async () => { /* ... */ });
  it('hydrates user record from database', async () => { /* ... */ });
  it('hydrates team memberships', async () => { /* ... */ });
  it('hydrates token scope for API token auth', async () => { /* ... */ });
  it('returns 401 when user record not found', async () => { /* ... */ });
  it('logs warning for dev-mode in production', async () => { /* ... */ });
});

// tests/rbac/middleware/require-role.test.ts

describe('requireRole', () => {
  it('allows access when effective role meets minimum', async () => { /* ... */ });
  it('denies access when effective role is below minimum', async () => { /* ... */ });
  it('extracts projectId from route params', async () => { /* ... */ });
  it('extracts projectId from query string', async () => { /* ... */ });
  it('extracts projectId from request body', async () => { /* ... */ });
  it('applies token project restriction', async () => { /* ... */ });
  it('falls back to highest team role for team-level routes', async () => { /* ... */ });
  it('applies token ceiling to team role', async () => { /* ... */ });
  it('passes through for dev-mode users', async () => { /* ... */ });
});

// tests/rbac/middleware/require-tag-access.test.ts

describe('requireTagAccess', () => {
  it('passes through for non-API-token requests', async () => { /* ... */ });
  it('passes through when token has no tag restrictions', async () => { /* ... */ });
  it('allows when resource tags overlap with allowed tags', async () => { /* ... */ });
  it('denies when resource tags do not overlap', async () => { /* ... */ });
  it('allows access to untagged resources', async () => { /* ... */ });
});
```

### Integration Tests

Test the full middleware chain with real database queries:

```typescript
describe('RBAC middleware chain', () => {
  it('viewer can read tasks but not create them', async () => { /* ... */ });
  it('agent_operator can move tasks and start agents', async () => { /* ... */ });
  it('admin can manage settings and create tokens', async () => { /* ... */ });
  it('owner can transfer ownership', async () => { /* ... */ });
  it('token ceiling reduces effective role', async () => { /* ... */ });
  it('token project restriction blocks access to other projects', async () => { /* ... */ });
  it('token tag restriction blocks access to non-matching tasks', async () => { /* ... */ });
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Roles & Permissions](./roles-permissions.md) | Role hierarchy and resolution algorithm |
| [API Tokens](./tokens.md) | Token scope fields used by requireRole and requireTagAccess |
| [Auth Middleware](../application/security/authentication.md) | Existing authMiddleware this extends |
| [API Endpoints](../application/api/endpoints.md) | Routes where middleware is applied |
| [Error Catalog](../application/errors/error-catalog.md) | Error code conventions |
| [Router](../../src/server/router.ts) | Where middleware is registered |
