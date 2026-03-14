# RBAC & User Management Specification

## Purpose

Role-Based Access Control (RBAC), user management, teams, and API tokens for AgentPane. This specification introduces multi-user identity, team-scoped authorization, project-level role assignment, tag-based filtering, invite-only team membership, and per-team GitHub token management.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Identity provider** | GitHub OAuth | AgentPane already integrates with GitHub; reuse the OAuth flow for user identity. No password storage required. |
| **Role scope** | Per-team + per-project | Teams own projects. Users inherit their team role on assigned projects, but project-level overrides allow finer control (e.g., grant a contractor Viewer on one project only). |
| **Role hierarchy** | Owner > Admin > Agent Operator > Viewer (4-tier) | Covers the full spectrum: infrastructure owners, team admins, day-to-day agent operators, and read-only stakeholders. |
| **Tag-based filtering** | Tags on projects and tasks, scoped to a team | Enables API tokens and views to be filtered by tag (e.g., "production", "staging") without complex per-resource ACLs. |
| **Team membership model** | Invite-only | Prevents unauthorized access. Team owners/admins send invitations; invitees accept to join. No open registration or self-service join. |
| **GitHub tokens** | Per-team, not per-user | Teams share a single GitHub PAT/OAuth token for repo access. Simplifies token rotation and avoids per-user token sprawl. The existing `github_tokens` table gains a `team_id` column. |
| **API token scoping** | Role + optional tag filter + optional project | API tokens carry a role ceiling, optional tag scope, and optional single-project scope. This prevents over-privileged automation keys. |
| **Session management** | Opaque bearer tokens with expiry | User sessions use a secure random token stored in `user_sessions`. No JWTs -- server-side lookup keeps revocation instant. |
| **SQLite compatibility** | Text columns for enums, `datetime('now')` defaults, cuid2 PKs | Matches every existing table in the codebase. No native enums, no integer timestamps. |

---

## Document Tree

```
specs/rbac-auth/
├── README.md              # This file - overview, decisions, phases
├── schema.md              # Database schema (11 new tables, Drizzle definitions)
└── migration.md           # Migration strategy, backward compatibility, rollback
```

---

## Role Definitions

| Role | Level | Capabilities |
|------|-------|-------------|
| **Owner** | 4 | Full control. Create/delete teams, manage billing, transfer ownership, all Admin capabilities. |
| **Admin** | 3 | Manage team members and invitations, assign projects to teams, configure sandbox settings, manage GitHub tokens, all Agent Operator capabilities. |
| **Agent Operator** | 2 | Create/edit/delete tasks, start/stop agents, approve/reject agent output, manage worktrees, view sessions. Cannot manage team membership or settings. |
| **Viewer** | 1 | Read-only access to projects, tasks, sessions, and agent output. Cannot modify anything or trigger agent execution. |

### Role Hierarchy Rules

- A higher-level role implicitly includes all capabilities of lower-level roles.
- Project-level role overrides the team-inherited role **only if the project role is higher** (roles never downgrade via project override).
- API tokens are capped at the role of the user who created them.

---

## Phase Overview

### Phase 1: Schema & Models

**Scope**: Database tables, Drizzle ORM schema files, TypeScript types, Zod validation schemas, and enums.

**Deliverables**:
- 11 new tables (see [schema.md](./schema.md))
- `RbacRole` enum added to `src/db/schema/shared/enums.ts`
- Drizzle schema files in `src/db/schema/sqlite/` and `src/db/schema/postgres/`
- Relations added to `src/db/schema/sqlite/relations.ts`
- Migration SQL added to `src/lib/bootstrap/phases/schema.ts`
- Zod validation schemas for all create/update operations

**Key files to create or modify**:

| File | Action |
|------|--------|
| `src/db/schema/shared/enums.ts` | Add `RBAC_ROLES` const array and `RbacRole` type |
| `src/db/schema/sqlite/users.ts` | New - users table |
| `src/db/schema/sqlite/user-sessions.ts` | New - user sessions table |
| `src/db/schema/sqlite/teams.ts` | New - teams, team_members, team_projects tables |
| `src/db/schema/sqlite/project-members.ts` | New - project_members table |
| `src/db/schema/sqlite/tags.ts` | New - tags, project_tags, task_tags tables |
| `src/db/schema/sqlite/api-tokens.ts` | New - api_tokens table |
| `src/db/schema/sqlite/team-invitations.ts` | New - team_invitations table |
| `src/db/schema/sqlite/relations.ts` | Modify - add RBAC relations |
| `src/db/schema/sqlite/index.ts` | Modify - re-export new schema files |
| `src/lib/bootstrap/phases/schema.ts` | Modify - add RBAC migration SQL |

### Phase 2: Service Layer, Middleware & Routes

**Scope**: Authorization middleware, RBAC service, user service, team service, API token service, and protected Hono routes.

**Deliverables**:
- `rbac.service.ts` - Role resolution (effective role for user + project)
- `user.service.ts` - GitHub OAuth callback, user upsert, session management
- `team.service.ts` - Team CRUD, member management, invitation workflow
- `api-token.service.ts` - Token generation, hashing, validation, revocation
- `auth.middleware.ts` - Hono middleware that extracts user from session/API token and attaches to context
- `rbac.middleware.ts` - Hono middleware factory: `requireRole('admin')`, `requireProjectRole('agent_operator')`
- Protected route handlers for all RBAC endpoints

**Key routes to add**:

| Method | Path | Role Required |
|--------|------|---------------|
| `GET` | `/api/auth/github` | Public |
| `GET` | `/api/auth/github/callback` | Public |
| `POST` | `/api/auth/logout` | Authenticated |
| `GET` | `/api/users/me` | Authenticated |
| `POST` | `/api/teams` | Authenticated |
| `GET` | `/api/teams` | Authenticated |
| `GET` | `/api/teams/:id` | Team member |
| `PATCH` | `/api/teams/:id` | Admin |
| `DELETE` | `/api/teams/:id` | Owner |
| `POST` | `/api/teams/:id/members` | Admin |
| `DELETE` | `/api/teams/:id/members/:userId` | Admin |
| `PATCH` | `/api/teams/:id/members/:userId` | Admin |
| `POST` | `/api/teams/:id/invitations` | Admin |
| `POST` | `/api/teams/:id/invitations/:inviteId/accept` | Invitee |
| `POST` | `/api/teams/:id/invitations/:inviteId/decline` | Invitee |
| `DELETE` | `/api/teams/:id/invitations/:inviteId` | Admin |
| `POST` | `/api/teams/:id/projects` | Admin |
| `DELETE` | `/api/teams/:id/projects/:projectId` | Admin |
| `GET` | `/api/teams/:id/tokens` | Admin |
| `POST` | `/api/teams/:id/tokens` | Admin |
| `DELETE` | `/api/teams/:id/tokens/:tokenId` | Admin |
| `POST` | `/api/projects/:id/members` | Admin |
| `DELETE` | `/api/projects/:id/members/:userId` | Admin |
| `POST` | `/api/teams/:id/tags` | Admin |
| `DELETE` | `/api/teams/:id/tags/:tagId` | Admin |

### Phase 3: UI (Future)

**Scope**: Frontend components for team management, user settings, invitation flow, API token management, and role-aware UI guards.

**Status**: Not yet specified. Will be defined after Phase 2 is implemented and validated.

**Anticipated components**:
- Team settings dialog
- Member management panel
- Invitation acceptance page
- API token management panel
- Role-aware route guards (TanStack Router `beforeLoad`)
- Tag management UI
- User profile / avatar in header

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../application/database/schema.md) | Existing tables referenced by RBAC foreign keys (projects, tasks) |
| [API Endpoints](../application/api/endpoints.md) | Existing endpoints that will require RBAC middleware |
| [Authentication](../application/security/authentication.md) | Current auth spec; RBAC extends this with user identity and roles |
| [Security Model](../application/security/security-model.md) | RBAC adds authorization layer on top of existing audit logging |
| [GitHub App](../application/integrations/github-app.md) | GitHub OAuth reused for user identity; tokens scoped to teams |
| [Bootstrap](../application/architecture/app-bootstrap.md) | Schema migration runs during bootstrap phase 2 |
