# Role-Based Access Control (RBAC)

Consolidated specification for the AgentPane RBAC system, reflecting the actual implementation on the `main` branch. This document covers identity, authentication, team-based authorization, API tokens, tags, and GitHub token resolution.

Previous design documents are archived at `specs/archive/rbac-auth-original/`.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Identity provider | GitHub OAuth | Reuses the existing GitHub integration; no password storage required |
| Role scope | Per-team + per-project override | Teams own projects. Users inherit their team role on assigned projects; project-level overrides allow finer control |
| Role hierarchy | Owner > Admin > Agent Operator > Viewer (4-tier) | Covers infrastructure owners, team admins, day-to-day agent operators, and read-only stakeholders |
| Session management | SHA-256 hashed opaque bearer tokens | Server-side lookup keeps revocation instant; no JWTs |
| API token storage | SHA-256 hash only; raw shown once | Defense-in-depth -- database breach does not expose usable tokens |
| Team membership | Invite-only | Prevents unauthorized access; admins/owners send invitations |
| GitHub tokens | Per-team (one token per team) | Simplifies rotation; `github_tokens.team_id` column links to teams |
| API token scoping | Role ceiling + optional tag/project filter | Prevents over-privileged automation keys |
| Dev-mode bypass | Auto-grant `owner` when `SKIP_AUTH=true` + `NODE_ENV=development` | Local development works without OAuth setup |
| SQLite compatibility | Text columns for enums, `datetime('now')` defaults, cuid2 PKs | Matches every existing table in the codebase |

---

## Role Hierarchy

Four roles ordered by privilege level. Each tier inherits all permissions of lower tiers.

| Role | Level | Identifier | Description |
|------|-------|------------|-------------|
| Owner | 4 | `owner` | Full control. Delete teams, transfer ownership, all admin capabilities. At least one owner per team. |
| Admin | 3 | `admin` | Manage members, invitations, projects, settings, API tokens. Cannot delete team or transfer ownership. |
| Agent Operator | 2 | `agent_operator` | Create/edit/move/delete tasks, start/stop agents, approve/reject plans. |
| Viewer | 1 | `viewer` | Read-only access to projects, tasks, sessions, agents. |

### TypeScript Definitions

```
src/db/schema/shared/enums.ts
```

```typescript
export const RBAC_ROLES = ['owner', 'admin', 'agent_operator', 'viewer'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

export const RBAC_ROLE_LEVEL: Readonly<Record<RbacRole, number>> = Object.freeze({
  owner: 4,
  admin: 3,
  agent_operator: 2,
  viewer: 1,
});

export function isValidRbacRole(value: string): RbacRole | null;
export function resolveHighestRole(roles: Array<{ role: string }>): { role: RbacRole; level: number } | null;
```

### Permission Matrix

Defined as a constant map in `src/services/rbac.service.ts`:

| Action Category | Minimum Role |
|----------------|-------------|
| `project:read`, `task:read`, `session:read`, `agent:read`, `worktree:read` | `viewer` |
| `task:create`, `task:update`, `task:move`, `task:delete`, `task:label` | `agent_operator` |
| `agent:start`, `agent:stop`, `agent:approve_plan`, `agent:reject_plan` | `agent_operator` |
| `project:create`, `project:update`, `project:delete`, `project:manage_members` | `admin` |
| `team:manage_members`, `team:create_tokens`, `team:manage_settings` | `admin` |
| `team:delete`, `team:transfer_owner`, `team:promote_owner` | `owner` |

---

## Database Schema

Eleven tables plus one ALTER TABLE migration. All tables follow existing AgentPane SQLite conventions (TEXT PKs with cuid2, TEXT timestamps with `datetime('now')` defaults).

### Table Summary

| Table | PK | Purpose | File |
|-------|-----|---------|------|
| `users` | `id` | GitHub OAuth identities | `src/db/schema/sqlite/users.ts` |
| `user_sessions` | `id` | Server-side bearer tokens (SHA-256 hashed) | `src/db/schema/sqlite/user-sessions.ts` |
| `teams` | `id` | Organizational units | `src/db/schema/sqlite/teams.ts` |
| `team_members` | `(team_id, user_id)` | User-team role assignments | `src/db/schema/sqlite/team-members.ts` |
| `team_projects` | `(team_id, project_id)` | Project-team assignments | `src/db/schema/sqlite/team-projects.ts` |
| `team_invitations` | `id` | Pending membership invites (7-day TTL) | `src/db/schema/sqlite/team-invitations.ts` |
| `project_members` | `(project_id, user_id)` | Per-project role overrides | `src/db/schema/sqlite/project-members.ts` |
| `api_tokens` | `id` | Scoped API access tokens (hash-only storage) | `src/db/schema/sqlite/api-tokens.ts` |
| `tags` | `id` | Team-scoped labels | `src/db/schema/sqlite/tags.ts` |
| `project_tags` | `(project_id, tag_id)` | Project-tag junction | `src/db/schema/sqlite/project-tags.ts` |
| `task_tags` | `(task_id, tag_id)` | Task-tag junction | `src/db/schema/sqlite/task-tags.ts` |

Modified table: `github_tokens` gains a nullable `team_id` column referencing `teams.id` (ON DELETE SET NULL).

### Key Columns

**users**: `id`, `github_id` (UNIQUE integer), `github_login`, `name`, `email`, `github_email`, `avatar_url`, timestamps.

**user_sessions**: `id`, `user_id` (FK users, CASCADE), `token` (UNIQUE, SHA-256 hash), `expires_at`, `created_at`. Session max age is 30 days.

**teams**: `id`, `name`, `slug` (UNIQUE), `description`, timestamps.

**team_members**: `team_id` (FK teams, CASCADE), `user_id` (FK users, CASCADE), `role` (TEXT, default `'viewer'`), `joined_at`. Composite PK.

**team_projects**: `team_id` (FK teams, CASCADE), `project_id` (FK projects, CASCADE), `assigned_at`. Composite PK.

**team_invitations**: `id`, `team_id` (FK), `invited_by` (FK users), `email`, `role`, `token` (UNIQUE, SHA-256 hashed), `status` (pending/accepted/declined/expired/revoked), `expires_at`, `created_at`.

**project_members**: `project_id` (FK projects, CASCADE), `user_id` (FK users, CASCADE), `role`, `granted_by_team_id` (FK teams, SET NULL), `created_at`. Composite PK.

**api_tokens**: `id`, `user_id` (FK), `team_id` (FK), `name`, `token_hash` (UNIQUE, SHA-256), `token_prefix` (first 12 chars), `role`, `scope_tags` (JSON text), `scope_project_id` (FK projects, SET NULL), `status` (active/revoked/expired), `expires_at`, `last_used_at`, `use_count`, `revoked_at`, `created_at`.

**tags**: `id`, `team_id` (FK), `name`, `color` (hex, optional), `created_at`. Unique index on `(team_id, name)`.

### Index Summary

| Table | Index | Type |
|-------|-------|------|
| users | `users_github_id_idx` | UNIQUE |
| users | `users_github_login_idx` | INDEX |
| user_sessions | `user_sessions_user_id_idx`, `user_sessions_token_idx` | INDEX, UNIQUE |
| teams | `teams_slug_idx` | UNIQUE |
| team_members | `team_members_user_id_idx` | INDEX |
| team_projects | `team_projects_project_id_idx` | INDEX |
| project_members | `project_members_user_id_idx` | INDEX |
| tags | `tags_team_name_idx` | UNIQUE |
| api_tokens | `api_tokens_hash_idx` (UNIQUE), `api_tokens_user_id_idx`, `api_tokens_team_id_idx`, `api_tokens_status_idx` | Mixed |
| team_invitations | `team_invitations_token_idx` (UNIQUE), `team_invitations_team_id_idx`, `team_invitations_email_idx` | Mixed |

### Migration

All tables use `CREATE TABLE IF NOT EXISTS` in the `RBAC_MIGRATION_SQL` constant inside `src/lib/bootstrap/phases/schema.ts`. The `github_tokens.team_id` ALTER TABLE is wrapped in try/catch for idempotency.

Drizzle relations are defined in `src/db/schema/sqlite/relations.ts`.

---

## Authentication

### GitHub OAuth Flow

Implemented in `src/server/routes/auth.ts`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/github` | GET | Redirect to GitHub OAuth authorization (sets CSRF state cookie) |
| `/api/auth/github/callback` | GET | Exchange code for token, upsert user, create session, redirect to app |
| `/api/auth/logout` | POST | Delete session from DB, clear cookie |

The callback:
1. Exchanges the OAuth code for an access token via `github.com/login/oauth/access_token`
2. Fetches user info from `api.github.com/user`
3. Upserts a `users` row (keyed by `github_id`)
4. Creates a `user_sessions` row with a SHA-256 hash of a random 32-byte token
5. Sets the raw token as an `HttpOnly; SameSite=Lax; Secure` cookie named `agentpane_session`

### Auth Middleware Chain

Defined in `src/server/router.ts` and `src/lib/api/rbac-middleware.ts`. The middleware pipeline order is:

```
Request
  -> cors()
  -> logger()
  -> requestIdMiddleware()
  -> securityHeaders()
  -> rateLimiter()
  -> authMiddleware(db)        -- extracts userId + authMethod from session/token/dev
  -> enrichAuthContext(db)     -- hydrates user record, team memberships, token scope
  -> [route-level: requireRole(minimumRole, rbacService)]
  -> [route-level: requireTagAccess(db)]
  -> route handler
```

### `getAuthContext()` (`src/lib/api/auth-middleware.ts`)

Checks authentication in order:
1. `SKIP_AUTH=true` + `NODE_ENV=development` -- returns `{ userId: 'dev-user', authMethod: 'dev' }`
2. Session cookie (`agentpane_session`) -- validates via `validateSessionToken` callback (hashes token, queries `user_sessions`)
3. `Authorization: Bearer <token>` -- validates via `validateApiKey` callback (hashes token, queries `api_tokens`)
4. Development fallback (`NODE_ENV=development`) -- accepts `X-Dev-User` header or defaults to `local-dev`

Skips auth entirely for `/api/health*` and `/api/auth/*` paths.

### `AuthContext` Interface

```typescript
interface AuthContext {
  userId: string;
  authMethod: 'session' | 'api_token' | 'dev';
  // Populated by enrichAuthContext:
  user?: { id, githubId, githubLogin, name, email, githubEmail, avatarUrl };
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
```

---

## RBAC Middleware

Three middleware functions in `src/lib/api/rbac-middleware.ts`.

### `enrichAuthContext(db)`

Runs after `authMiddleware` on all `/api/*` routes. Behavior:

- **Dev-mode**: Grants `owner` role, level 4. Blocks dev-mode in production with 401.
- **Session/token users**: Parallel-fetches user record (`users` table) and team memberships (`team_members` table). Returns 401 if user record not found.
- **API token users**: Reads the cached `_resolvedApiToken` from context (set by `createAuthMiddleware` to avoid duplicate hash+query). Checks expiry, validates role, applies token ceiling to resolved role. Updates `lastUsedAt` and `useCount` asynchronously (fire-and-forget).

### `requireRole(minimumRole, rbacService)`

Per-route middleware factory. Applied on individual route handlers.

- Dev-mode users always pass.
- If no `resolvedRole` exists, returns 403.
- Extracts `projectId` from route params (only on `/api/projects/*`), query string, or request body.
- For project-scoped requests: calls `rbacService.resolveUserRole()` for the specific project, applies token ceiling, checks token project scope.
- For non-project requests: uses the global `resolvedRole` from `enrichAuthContext`.
- Returns 403 with descriptive message if effective role is below minimum.

### `requireTagAccess(db)`

For API tokens with `scopeTags` restrictions. Uses a table-driven tag resolver pattern:

| Resource Type | Path Prefix | Tag Resolution |
|--------------|-------------|----------------|
| project | `/api/projects/` | Direct `project_tags` lookup |
| task | `/api/tasks/` | `task_tags` lookup, fallback to parent project's tags |
| session | `/api/sessions/` | Resolve via task chain, then project |
| agent | `/api/agents/` | Resolve via project |

Rules:
- Non-API-token requests: pass through.
- Tokens with no `scopeTags` (null/empty): pass through.
- Untagged resources: denied (invisible to tag-restricted tokens).
- Collection endpoints (no `:id`): denied with message requiring resource ID.
- No tag overlap: denied.

---

## Service Layer

### `RbacService` (`src/services/rbac.service.ts`)

Core permission resolution engine (177 lines).

**`resolveUserRole(userId, projectId)`**: Resolves effective role for a user on a specific project.
1. Check `project_members` for direct override.
2. Check `team_members` via `team_projects` JOIN for team-inherited roles. Takes the highest role across all linked teams.
3. Returns `null` if no membership found (deny).

**`resolveTeamRole(userId, teamId)`**: Resolves a user's role in a specific team via `team_members` lookup.

**`resolveGlobalRole(userId)`**: Returns the highest role across all team memberships.

**`hasMinimumRole(userRole, minimumRole)`**: Compares role levels.

**`applyTokenCeiling(membershipRole, tokenRole)`**: Returns `min(membership, token)` by level.

**`checkTagAccess(tokenScopeTags, resourceTags)`**: OR-based tag overlap check. Denies untagged resources when token has tag restrictions.

**`checkProjectScope(tokenProjectId, requestedProjectId)`**: Single-project scope check for tokens.

**`canPerformAction(userRole, action)`**: Looks up action in `PERMISSION_MAP` and checks role level.

### `RbacTokenService` (`src/services/rbac-token.service.ts`)

API token lifecycle management (283 lines).

**Token format**: `ap_` + 32 random bytes base64url-encoded (~47 chars total). Validated by regex `/^ap_[A-Za-z0-9_-]{42,44}$/`.

**`generateToken()`**: Creates a raw `ap_`-prefixed token string.

**`hashToken(raw)`**: SHA-256 hex digest.

**`isValidFormat(raw)`**: Regex validation.

**`create(params)`**: Transactional creation with:
- Name uniqueness check (per user, non-revoked tokens)
- Active token count limit (25 per user)
- SHA-256 hash storage
- Returns raw token exactly once

**`resolveToken(rawToken)`**: Format validation, hash, lookup by hash + active status, expiry check. Returns `ResolvedToken | null`.

**`revoke(tokenId, userId)`**: Atomic update with `ne(status, 'revoked')` guard. Distinguishes not-found from already-revoked.

**`enrichScopeTags(scopeTags)`**: Fetches full tag details (name, color) for display.

### `GitHubTokenService` (`src/services/github-token.service.ts`)

GitHub PAT management with per-team token resolution (606 lines).

**`resolveGitHubTokenForProject(projectId)`**: Resolution chain:
1. Find teams via `team_projects` for the project.
2. Look for a `github_tokens` row matching any of those team IDs.
3. Fall back to global token (`team_id IS NULL`).

**`saveToken(token)`**: Validates format, validates with GitHub API, encrypts and stores. Replaces any existing token (singleton model per call).

**`getTokenInfo()`**: Returns masked token info without exposing the raw PAT.

**`revalidateToken()`**: Re-validates saved token against GitHub API and updates `is_valid` status.

---

## API Routes

### Route File Organization

| File | Mount Point | Purpose |
|------|-------------|---------|
| `src/server/routes/auth.ts` | `/api/auth` | GitHub OAuth + session management |
| `src/server/routes/me.ts` | `/api/me` | Current user profile |
| `src/server/routes/teams.ts` | `/api/teams` | Team CRUD + ownership transfer |
| `src/server/routes/team-members.ts` | `/api/teams/:id/members` | Team membership management |
| `src/server/routes/team-invitations.ts` | `/api/teams/:id/invitations` | Invitation lifecycle |
| `src/server/routes/invitation-accept.ts` | `/api/invitations` | Token-based invitation acceptance |
| `src/server/routes/team-projects.ts` | `/api/teams/:id/projects` | Project-team assignment |
| `src/server/routes/team-github-token.ts` | `/api/teams/:id/github-token` | Per-team GitHub token management |
| `src/server/routes/rbac-tokens.ts` | `/api/tokens` | API token CRUD |
| `src/server/routes/project-members.ts` | `/api/projects/:id/members` | Project-level role overrides |
| `src/server/routes/tags.ts` | `/api/tags`, `/api/projects/:id/tags`, `/api/tasks/:id/tags` | Tag CRUD and assignment |

### Teams (`/api/teams`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/teams` | Authenticated | Create team; creator becomes owner |
| GET | `/api/teams` | Authenticated | List user's teams (with search, cursor pagination, member/project counts) |
| GET | `/api/teams/:id` | Team member (viewer+) | Get team details with memberCount, projectCount, myRole |
| PATCH | `/api/teams/:id` | Admin | Update name, slug, description |
| DELETE | `/api/teams/:id` | Owner | Delete team (cascades invitations, tokens, tags, members, project associations) |
| POST | `/api/teams/:id/transfer-ownership` | Owner | Transfer ownership (atomic: promote target + demote self to admin) |

### Team Members (`/api/teams/:id/members`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/teams/:id/members` | Admin | Add member (only owners can assign admin role) |
| GET | `/api/teams/:id/members` | Team member | List members with user details, pagination, optional role filter |
| PATCH | `/api/teams/:id/members/:uid` | Admin | Update role (self-change prevented, last-owner demotion prevented, admins cannot assign admin) |
| DELETE | `/api/teams/:id/members/:uid` | Admin | Remove member (self-removal prevented, last-owner removal prevented, only owners can remove owners) |

### Team Invitations (`/api/teams/:id/invitations`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/teams/:id/invitations` | Admin | Create invitation (hashed token, 7-day expiry, duplicate/existing-member checks) |
| GET | `/api/teams/:id/invitations` | Admin | List pending invitations (enriched with inviter name) |
| POST | `/api/teams/:id/invitations/:iid/decline` | Invitee | Decline invitation (email match verified via `githubEmail`) |
| DELETE | `/api/teams/:id/invitations/:iid` | Admin | Revoke invitation |
| POST | `/api/invitations/:token/accept` | Authenticated | Accept invitation (token hashed for lookup, email match verified, creates team membership) |

### Team Projects (`/api/teams/:id/projects`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/teams/:id/projects` | Admin | Assign project to team (verifies project exists, prevents duplicates) |
| DELETE | `/api/teams/:id/projects/:projectId` | Admin | Remove project from team |

### API Tokens (`/api/tokens`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/tokens` | Authenticated | Create token (role ceiling, scope validation, transactional, 25-token limit, raw token returned once) |
| GET | `/api/tokens` | Authenticated | List user's tokens (pagination, status/team filters, optional admin team-wide listing with `allTeam=true`) |
| GET | `/api/tokens/:id` | Token owner | Get token details (enriched scope tags with names/colors, scope project name, team name) |
| DELETE | `/api/tokens/:id` | Token owner | Revoke token (atomic, distinguishes not-found from already-revoked) |

### Project Members (`/api/projects/:id/members`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/projects/:id/members` | Admin | Add project-level role override |
| GET | `/api/projects/:id/members` | Team member | List project members |
| PATCH | `/api/projects/:id/members/:uid` | Admin | Update project-level role |
| DELETE | `/api/projects/:id/members/:uid` | Admin | Remove project-level override |

### Tags

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/tags` | Agent Operator+ | Create tag within a team |
| GET | `/api/tags` | Team member | List tags with project/task counts |
| DELETE | `/api/tags/:id` | Admin | Delete tag (cascades to junction tables) |
| POST | `/api/projects/:id/tags` | Agent Operator+ | Assign tag to project |
| DELETE | `/api/projects/:id/tags/:tagId` | Agent Operator+ | Remove tag from project |
| POST | `/api/tasks/:id/tags` | Agent Operator+ | Assign tag to task |
| DELETE | `/api/tasks/:id/tags/:tagId` | Agent Operator+ | Remove tag from task |

### User Profile (`/api/me`)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/me` | Authenticated | Get profile with team memberships |
| PATCH | `/api/me` | Authenticated | Update name/email |

---

## Role Resolution Algorithm

Implemented in `RbacService.resolveUserRole()`:

```
1. Check project_members for direct project override
   -> If found, use that role

2. Check team_members via team_projects JOIN
   -> Collect all teams the user belongs to that link to the project
   -> Take the HIGHEST role across all linked teams

3. If request uses an API token:
   -> effective_role = min(membership_role, token_role)
   -> Token can only REDUCE permissions, never elevate

4. No membership found -> DENY (return null)
```

### Token Role Ceiling Examples

| User Membership Role | Token Role | Effective Role |
|---------------------|------------|----------------|
| `admin` | `admin` | `admin` |
| `admin` | `agent_operator` | `agent_operator` |
| `agent_operator` | `admin` | `agent_operator` |
| `viewer` | `owner` | `viewer` |

---

## Dev-Mode Bypass

When `SKIP_AUTH=true` and `NODE_ENV=development`:
- `getAuthContext()` returns `{ userId: 'dev-user', authMethod: 'dev' }`
- `enrichAuthContext` grants `owner` role at level 4, no DB lookups
- `requireRole` passes all dev-mode requests
- `requireTeamRole` / `requireProjectRole` helpers return null (authorized) for dev-mode

Defense-in-depth: `enrichAuthContext` blocks dev-mode when `NODE_ENV !== 'development'` and logs a security error.

---

## Tag System

Tags are team-scoped labels for organizing projects/tasks and restricting API token access.

### Scoping Rules for API Tokens

1. Token without `scopeTags` (null): unrestricted access within team.
2. Token with `scopeTags`: can only access resources tagged with at least one matching tag (OR-based).
3. Untagged resources: invisible to tag-restricted tokens (deny-by-default).
4. Task tag resolution: checks task's own tags first, falls back to parent project's tags.
5. Session/agent tag resolution: follows the task/project chain.

### Color Format

Hex strings with `#` prefix (e.g., `#3B82F6`). Optional -- the DB allows null with a default of `#6B7280`.

---

## GitHub Token Per-Team Resolution

The `github_tokens` table has a nullable `team_id` column. Token resolution for a project follows this chain:

1. Find teams associated with the project via `team_projects`.
2. Look for a `github_tokens` row matching any of those team IDs.
3. Fall back to global token (`team_id IS NULL`).

Team-specific endpoints:
- `GET /api/teams/:id/github-token` -- get team's token info
- `PUT /api/teams/:id/github-token` -- set/replace team's token
- `DELETE /api/teams/:id/github-token` -- remove team's token
- `POST /api/teams/:id/github-token/validate` -- re-validate against GitHub API

---

## Validation Schemas

Defined in `src/server/validation.ts`. Key schemas:

```typescript
createTeamSchema:    { name, slug? (regex /^[a-z0-9-]+$/), description? }
updateTeamSchema:    { name?, slug?, description? }
addTeamMemberSchema: { userId, role: enum(RBAC_ROLES) }
updateTeamMemberSchema: { role: enum(['viewer', 'agent_operator', 'admin']) }
createInvitationSchema: { email, role: enum(['viewer', 'agent_operator', 'admin']) }
createApiTokenSchema: { teamId, name, role, scopeTags?, scopeProjectId?, expiresInDays? }
transferOwnershipSchema: { targetUserId }
```

---

## Shared Helpers

Defined in `src/server/shared.ts`:

- **`hashToken(token)`**: SHA-256 hex digest. Used for session tokens, invitation tokens, and API tokens.
- **`requireTeamRole(auth, rbacService, teamId, minimumRole)`**: Dev-mode passthrough, resolves team role, checks minimum. Returns 403 Response or null.
- **`requireTeamRoleResolved(...)`**: Same as above but also returns the resolved role string (avoids re-querying when callers need the role downstream).
- **`requireProjectRole(auth, rbacService, projectId, minimumRole)`**: Project-scoped role check.
- **`parsePagination(c)`**: Extracts cursor/limit from query (default 50, max 100).
- **`isValidId(id)`**: Regex validation for cuid2 and kebab-case IDs.

---

## Error Codes

Error codes returned by the RBAC system:

| Code | HTTP | When |
|------|------|------|
| `UNAUTHORIZED` | 401 | No valid session or API token |
| `FORBIDDEN` | 403 | Authenticated but insufficient scope (token project/tag restriction) |
| `INSUFFICIENT_ROLE` | 403 | User's role is below required level |
| `TEAM_SLUG_EXISTS` | 409 | Team slug already taken |
| `MEMBER_ALREADY_EXISTS` | 409 | User already a team member |
| `MEMBER_NOT_FOUND` | 404 | User not a member of the team |
| `CANNOT_CHANGE_OWN_ROLE` | 400 | Cannot modify own role |
| `CANNOT_DEMOTE_LAST_OWNER` | 400 | Team must have at least one owner |
| `CANNOT_REMOVE_LAST_OWNER` | 409 | Cannot remove the last owner |
| `CANNOT_REMOVE_SELF` | 400 | Cannot remove self via member removal endpoint |
| `CANNOT_TRANSFER_TO_SELF` | 400 | Cannot transfer ownership to yourself |
| `INVITATION_ALREADY_EXISTS` | 409 | Pending invitation for email already exists |
| `INVITATION_EMAIL_MISMATCH` | 403 | Authenticated email does not match invitation |
| `TOKEN_NAME_EXISTS` | 409 | Non-revoked token with same name exists |
| `LIMIT_EXCEEDED` | 400 | Max 25 active tokens per user |
| `ALREADY_REVOKED` | 409 | Token already revoked |
| `TOKEN_NOT_FOUND` | 404 | Token does not exist or not owned by user |
| `PROJECT_ALREADY_ASSIGNED` | 409 | Project already assigned to team |
| `TAG_NAME_EXISTS` | 409 | Tag name exists within team |
| `TAG_ALREADY_ASSIGNED` | 409 | Tag already assigned to resource |

---

## Implementation File Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/api/auth-middleware.ts` | 287 | Auth context extraction, session/token/dev-mode |
| `src/lib/api/rbac-middleware.ts` | 541 | enrichAuthContext, requireRole, requireTagAccess |
| `src/services/rbac.service.ts` | 177 | Permission resolution engine |
| `src/services/rbac-token.service.ts` | 283 | API token lifecycle (generate, hash, create, resolve, revoke) |
| `src/services/github-token.service.ts` | 606 | GitHub PAT management with team resolution |
| `src/server/routes/auth.ts` | 259 | GitHub OAuth + session endpoints |
| `src/server/routes/teams.ts` | 490 | Team CRUD + ownership transfer |
| `src/server/routes/team-members.ts` | 421 | Membership management |
| `src/server/routes/team-invitations.ts` | 338 | Invitation lifecycle |
| `src/server/routes/invitation-accept.ts` | ~160 | Token-based invitation acceptance |
| `src/server/routes/team-projects.ts` | 129 | Project-team assignment |
| `src/server/routes/rbac-tokens.ts` | 507 | API token CRUD |
| `src/server/routes/project-members.ts` | ~230 | Project role overrides |
| `src/server/routes/tags.ts` | ~410 | Tag CRUD and assignment |
| `src/server/routes/me.ts` | ~140 | User profile |
| `src/server/shared.ts` | 215 | Hash, pagination, role check helpers |
| `src/server/validation.ts` | ~250 | Zod schemas for all RBAC inputs |
| `src/db/schema/shared/enums.ts` | 134 | RBAC_ROLES, role levels, validation helpers |
| `src/db/schema/sqlite/users.ts` | Schema | users table |
| `src/db/schema/sqlite/user-sessions.ts` | Schema | user_sessions table |
| `src/db/schema/sqlite/teams.ts` | Schema | teams table |
| `src/db/schema/sqlite/team-members.ts` | Schema | team_members table |
| `src/db/schema/sqlite/team-projects.ts` | Schema | team_projects table |
| `src/db/schema/sqlite/team-invitations.ts` | Schema | team_invitations table |
| `src/db/schema/sqlite/project-members.ts` | Schema | project_members table |
| `src/db/schema/sqlite/api-tokens.ts` | Schema | api_tokens table |
| `src/db/schema/sqlite/tags.ts` | Schema | tags + project_tags |
| `src/db/schema/sqlite/project-tags.ts` | Schema | project_tags junction |
| `src/db/schema/sqlite/task-tags.ts` | Schema | task_tags junction |
| `src/db/schema/sqlite/relations.ts` | Relations | All RBAC Drizzle relations |
| `src/lib/bootstrap/phases/schema.ts` | Migration | RBAC_MIGRATION_SQL constant |
| `src/server/router.ts` | Router | Middleware chain, route mounting |

---

## Cross-References

| Document | Relationship |
|----------|-------------|
| [Authentication](./authentication.md) | Base auth spec; RBAC extends with user identity and roles |
| [Security Model](./security-model.md) | RBAC adds authorization layer on top of audit logging |
| [Database Schema](../database/schema.md) | Core tables referenced by RBAC foreign keys |
| [API Endpoints](../api/endpoints.md) | Existing endpoints that require RBAC middleware |
| [GitHub App](../integrations/github-app.md) | GitHub OAuth reused for user identity |
| [Bootstrap](../architecture/app-bootstrap.md) | Schema migration runs during bootstrap phase 2 |
| [Error Catalog](../errors/error-catalog.md) | Base error patterns extended by RBAC codes |
