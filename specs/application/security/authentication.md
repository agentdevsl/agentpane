# AgentPane Authentication Specification

## Overview

This specification defines the authentication and authorization architecture for AgentPane, covering user identity, session management, API protection, GitHub OAuth integration, and role-based access control (RBAC). AgentPane supports multi-user teams with fine-grained permissions.

**Design Principles**:

- **GitHub Identity**: User identity derived from GitHub OAuth
- **Session-Based**: Secure HTTP-only cookies for web sessions
- **API Key Authentication**: Bearer tokens with RBAC role ceiling and optional scoping
- **Team-Based Access Control**: Users belong to teams; teams own projects
- **RBAC**: 4 hierarchical roles enforce least-privilege access
- **Defense in Depth**: Multiple layers of validation (auth middleware, RBAC middleware, tag-based access)

> **Detailed RBAC specification**: See `specs/application/security/rbac.md` (if created) and the implementation in `src/services/rbac.service.ts` and `src/lib/api/rbac-middleware.ts`.

---

## Architecture

### Authentication Flow Overview

```text
+-----------------------------------------------------------------------------+
|                              User Browser                                    |
|  +-----------+    +-----------+    +-----------+    +-----------+            |
|  |  Login    |--->|  GitHub   |--->| Callback  |--->| Dashboard |            |
|  |  Page     |    |  OAuth    |    | Handler   |    | (Auth'd)  |            |
|  +-----------+    +-----------+    +-----------+    +-----------+            |
+-----------------------------------------------------------------------------+
         |                |                |                |
         v                v                v                v
+-----------------------------------------------------------------------------+
|                           AgentPane Server (Hono)                            |
|  +-----------+    +-----------+    +-----------+    +-----------+            |
|  | /login    |    | /api/auth/|    | /api/auth/|    | Auth +    |            |
|  | (redirect)|    |  github   |    |  callback |    | RBAC MW   |            |
|  +-----------+    +-----------+    +-----------+    +-----------+            |
|                                          |                |                  |
|                                          v                v                  |
|                                   +--------------------------+               |
|                                   |   SQLite Database        |               |
|                                   |   - users table          |               |
|                                   |   - user_sessions table  |               |
|                                   |   - team_members table   |               |
|                                   |   - project_members table|               |
|                                   |   - api_tokens table     |               |
|                                   +--------------------------+               |
+-----------------------------------------------------------------------------+
```

### Authentication Methods (checked in order)

| Priority | Method | Use Case | Identity Source |
|----------|--------|----------|-----------------|
| 0 | **SKIP_AUTH bypass** | Local development (NODE_ENV=development + SKIP_AUTH=true) | `dev-user` |
| 1 | **Session cookie** | Web UI sessions | `agentpane_session` HTTP-only cookie |
| 2 | **Bearer API key** | Programmatic / CI access | `Authorization: Bearer <key>` header |
| 3 | **Dev fallback** | Local development (NODE_ENV=development) | `X-Dev-User` header or `local-dev` |

---

## Authentication Context

```typescript
// src/lib/api/auth-middleware.ts

export interface AuthContext {
  userId: string;
  authMethod: 'session' | 'api_token' | 'dev';

  // Populated by enrichAuthContext RBAC middleware
  user?: {
    id: string;
    githubId: number;
    githubLogin: string;
    name: string | null;
    email: string | null;
    githubEmail: string | null;   // Immutable OAuth email for invitation verification
    avatarUrl: string | null;
  };
  resolvedRole?: RbacRole;        // Effective role after resolution
  roleLevel?: number;             // Numeric level (owner=4, admin=3, agent_operator=2, viewer=1)
  teamMemberships?: Array<{
    teamId: string;
    role: RbacRole;
  }>;
  tokenScope?: {                  // Populated for API token auth
    tokenId: string;
    role: RbacRole;               // Token's role ceiling
    projectId: string | null;     // Optional project scope restriction
    tags: string[] | null;        // Optional tag-based scope restriction
  };
}
```

---

## RBAC Integration

### Roles (Hierarchical)

| Role | Level | Description |
|------|-------|-------------|
| `owner` | 4 | Full control including team deletion and ownership transfer |
| `admin` | 3 | Project management, member management, settings, API key management |
| `agent_operator` | 2 | Task and agent operations (create, start, stop, approve) |
| `viewer` | 1 | Read-only access to projects, tasks, sessions, agents |

### Role Resolution

1. **Direct project membership** (`project_members` table) -- highest priority
2. **Team membership via `team_projects`** -- join through team_members + team_projects, use highest role across linked teams
3. **No membership** -- deny (return null)

For global operations (no project context), the highest role across all team memberships is used.

### API Token Role Ceiling

When authenticated via API token, the effective role is `min(membership_role, token_role)`. The token can never grant more access than the user's actual team membership provides.

### Permission Map

```typescript
// src/services/rbac.service.ts

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
  'project:create': 'admin',
  'project:update': 'admin',
  'project:delete': 'admin',
  'project:manage_members': 'admin',
  'project:sandbox_config': 'admin',
  'agent:delete': 'admin',
  'session:delete': 'admin',
  'worktree:delete': 'admin',
  'settings:update': 'admin',
  'keys:manage': 'admin',
  'team:manage_members': 'admin',
  'team:create_tokens': 'admin',
  'team:manage_settings': 'admin',
  'team:view_audit': 'admin',

  // Owner actions
  'team:delete': 'owner',
  'team:transfer_owner': 'owner',
  'team:promote_owner': 'owner',
};
```

### Middleware Pipeline

The request authentication pipeline has three middleware layers:

```text
Request
  |
  v
[1] authMiddleware (getAuthContext)
    - Extracts userId and authMethod from cookie / Bearer header / dev bypass
    - Sets c.get('auth') with basic AuthContext
  |
  v
[2] enrichAuthContext (RBAC middleware)
    - Looks up user record and team memberships in parallel
    - For API tokens: loads token scope, validates expiry, applies role ceiling
    - For dev-mode: grants owner role, blocks if NODE_ENV !== 'development'
    - Enriches auth with resolvedRole, roleLevel, teamMemberships, tokenScope
  |
  v
[3] requireRole(minimumRole) (per-route RBAC guard)
    - Resolves project context from route params, query, or request body
    - Calls rbacService.resolveUserRole() for project-scoped role
    - Applies token ceiling and project scope restriction
    - Returns 403 if effective role < minimumRole
  |
  v
[Optional] requireTagAccess (tag-based access control)
    - Only for API tokens with tag restrictions
    - Resolves resource tags (project -> task -> session -> agent)
    - Denies if token tags don't overlap with resource tags
```

---

## GitHub OAuth Flow

### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/github` | GET | No | Redirect to GitHub OAuth authorization |
| `/api/auth/github/callback` | GET | No | Handle OAuth callback, upsert user, create session |
| `/api/auth/logout` | POST | Yes | End session, delete from DB, clear cookie |

### Implementation Details

- **OAuth state**: Random 16-byte hex stored in `oauth_state` HTTP-only cookie (10-minute expiry)
- **Session token**: Random 32-byte base64url, stored hashed (SHA-256) in `user_sessions` table
- **Session cookie**: `agentpane_session`, HTTP-only, SameSite=Lax, Secure, 30-day max age
- **User upsert**: On callback, upsert user by `githubId`; always update `githubEmail` from OAuth
- **Scopes requested**: `read:user user:email`

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/server/routes/auth.ts` | GitHub OAuth routes (redirect, callback, logout) |
| `src/lib/api/auth-middleware.ts` | Auth context extraction, session/API key validation |
| `src/lib/api/rbac-middleware.ts` | RBAC enrichment, role enforcement, tag-based access |
| `src/services/rbac.service.ts` | RBAC service (role resolution, permission checks, token ceiling) |
| `src/db/schema/shared/enums.ts` | RBAC roles enum and level map |
| `src/db/schema/sqlite/users.ts` | Users table schema |
| `src/db/schema/sqlite/user-sessions.ts` | User sessions table schema |
| `src/db/schema/sqlite/team-members.ts` | Team membership table |
| `src/db/schema/sqlite/project-members.ts` | Direct project membership overrides |
| `src/db/schema/sqlite/api-tokens.ts` | API tokens table with role, scope, tags |

---

## API Key Authentication

API keys provide programmatic access with RBAC-controlled permissions.

### Token Structure

- **Prefix**: First 8 characters shown for identification
- **Hash**: SHA-256 hash stored in database
- **Role**: RBAC role ceiling (`owner`, `admin`, `agent_operator`, `viewer`)
- **Project scope**: Optional restriction to a single project
- **Tag scope**: Optional restriction to resources matching specific tags
- **Expiry**: Optional expiration date (lazily marked as `expired` on use)
- **Usage tracking**: `lastUsedAt` and `useCount` updated on each use (fire-and-forget)

### Token Lifecycle

| Status | Description |
|--------|-------------|
| `active` | Token is valid and usable |
| `revoked` | Manually revoked by user/admin |
| `expired` | Past expiration date (lazily updated on use) |

---

## Development Mode

When `NODE_ENV=development`:

1. **SKIP_AUTH=true**: All requests bypass auth with userId `dev-user` and owner role
2. **X-Dev-User header**: Custom user identity for testing
3. **No credentials**: Falls back to `local-dev` userId
4. **Session without validator**: Accepted without DB validation in dev mode

The `enrichAuthContext` middleware blocks dev-mode tokens in production as a defense-in-depth measure.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | User, UserSession, TeamMember, ProjectMember, ApiToken tables |
| [Error Catalog](../errors/error-catalog.md) | Auth error codes (UNAUTHORIZED, FORBIDDEN) |
| [API Endpoints](../api/endpoints.md) | Protected routes with auth requirements |
| [Security Model](./security-model.md) | Overall security architecture |
| [Sandbox](./sandbox.md) | Credential injection into sandbox containers |
