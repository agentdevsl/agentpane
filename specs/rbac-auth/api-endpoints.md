# RBAC API Endpoints Specification

## Overview

Complete REST API specification for AgentPane Role-Based Access Control. These endpoints manage teams, team membership, invitations, project-level role overrides, scoped API tokens, tags, and user profile. All endpoints require authentication unless noted otherwise. All responses follow the standard `ok/error` envelope.

---

## Response Format

### Success Response

```typescript
{
  "ok": true,
  "data": T  // Response data type varies by endpoint
}
```

### Error Response

```typescript
{
  "ok": false,
  "error": {
    "code": string,      // Error code (see RBAC Error Codes below)
    "message": string,   // Human-readable message
    "details"?: object   // Additional error context
  }
}
```

---

## Role Hierarchy

Roles are ordered by privilege level. Higher roles inherit all permissions of lower roles.

| Role | Level | Description |
|------|-------|-------------|
| `viewer` | 1 | Read-only access to team resources |
| `member` | 2 | Create/edit tasks, run agents |
| `admin` | 3 | Manage members, invitations, settings |
| `owner` | 4 | Full control including team deletion |

```typescript
type TeamRole = 'viewer' | 'member' | 'admin' | 'owner';
```

---

## Authentication

All endpoints require one of:

1. **Session cookie** - Set by OAuth login flow (GitHub OAuth or email/password)
2. **API token** - `Authorization: Bearer ap_...` header with a scoped token

API tokens carry an embedded role and optional scope restrictions (tags, project). The effective role is the **minimum** of the token role and the user's actual team role.

---

## Teams

### POST /api/teams

Create a new team. The authenticated user becomes the team owner.

**Request Schema:**

```typescript
const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
});
```

If `slug` is omitted, it is derived from `name` by lowercasing, replacing spaces with hyphens, and stripping non-alphanumeric characters.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    slug: string,
    description: string | null,
    createdAt: string,
    updatedAt: string,
    membership: {
      userId: string,
      role: "owner",
      joinedAt: string
    }
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 409 | `TEAM_SLUG_EXISTS` | Slug already taken |

**Example:**

```bash
curl -X POST "/api/teams" \
  -H "Content-Type: application/json" \
  -d '{"name": "Platform Team", "description": "Infrastructure and platform services"}'
```

---

### GET /api/teams

List all teams where the authenticated user is a member.

**Request Schema:**

```typescript
// Query parameters
const listTeamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(20),
  search: z.string().optional(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      id: string,
      name: string,
      slug: string,
      description: string | null,
      memberCount: number,
      myRole: TeamRole,
      createdAt: string,
      updatedAt: string
    }>,
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |

---

### GET /api/teams/:id

Get team details. Requires team membership.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    slug: string,
    description: string | null,
    memberCount: number,
    projectCount: number,
    myRole: TeamRole,
    createdAt: string,
    updatedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `TEAM_ACCESS_DENIED` | Not a member of this team |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |

---

### PATCH /api/teams/:id

Update team details. Requires `admin` or `owner` role in the team.

**Request Schema:**

```typescript
const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: Team  // Updated team object
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 409 | `TEAM_SLUG_EXISTS` | Slug already taken |

---

### DELETE /api/teams/:id

Delete a team and all associated data (members, invitations, tokens, tags). Requires `owner` role. This is a destructive operation -- projects are **not** deleted but are disassociated from the team.

**Response Schema:**

```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |

---

## Team Members

### POST /api/teams/:id/members

Add a member to the team directly (bypassing invitation flow). Requires `admin` or `owner` role.

**Request Schema:**

```typescript
const addMemberSchema = z.object({
  userId: z.string().cuid2(),
  role: z.enum(['viewer', 'member', 'admin']),
});
```

Note: The `owner` role cannot be assigned via this endpoint. Ownership transfer is a separate operation.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    userId: string,
    teamId: string,
    role: TeamRole,
    joinedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 404 | `USER_NOT_FOUND` | Target user does not exist |
| 409 | `MEMBER_ALREADY_EXISTS` | User is already a member |

---

### GET /api/teams/:id/members

List team members. Any team member can access this endpoint.

**Request Schema:**

```typescript
// Query parameters
const listMembersSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  role: z.enum(['viewer', 'member', 'admin', 'owner']).optional(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      userId: string,
      name: string,
      email: string,
      avatarUrl: string | null,
      role: TeamRole,
      joinedAt: string
    }>,
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `TEAM_ACCESS_DENIED` | Not a member of this team |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |

---

### PATCH /api/teams/:id/members/:uid

Update a member's role. Requires `admin` or `owner` role. Constraints:

- Cannot change your own role (prevents accidental self-demotion)
- Cannot demote the last remaining owner
- Only `owner` can promote someone to `admin`; `admin` can only assign `viewer` or `member`

**Request Schema:**

```typescript
const updateMemberRoleSchema = z.object({
  role: z.enum(['viewer', 'member', 'admin']),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    userId: string,
    teamId: string,
    role: TeamRole,
    joinedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 400 | `CANNOT_CHANGE_OWN_ROLE` | Cannot modify your own role |
| 400 | `CANNOT_DEMOTE_LAST_OWNER` | Team must have at least one owner |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 404 | `MEMBER_NOT_FOUND` | User is not a member of this team |

---

### DELETE /api/teams/:id/members/:uid

Remove a member from the team. Requires `admin` or `owner` role. Cannot remove the last owner.

**Response Schema:**

```typescript
{
  ok: true,
  data: { removed: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `CANNOT_REMOVE_LAST_OWNER` | Team must have at least one owner |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 404 | `MEMBER_NOT_FOUND` | User is not a member of this team |

---

## Invitations

### POST /api/teams/:id/invitations

Create a team invitation. Requires `admin` or `owner` role. Generates a unique token with a 7-day expiry. Sends an invitation email (if email service is configured).

**Request Schema:**

```typescript
const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['viewer', 'member', 'admin']),
});
```

Note: Cannot invite with `owner` role. Ownership must be transferred explicitly.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    teamId: string,
    email: string,
    role: TeamRole,
    token: string,          // Unique invitation token
    expiresAt: string,      // ISO 8601 timestamp (7 days from creation)
    invitedBy: string,      // User ID of inviter
    createdAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 409 | `INVITATION_ALREADY_EXISTS` | Pending invitation for this email already exists |
| 409 | `MEMBER_ALREADY_EXISTS` | User with this email is already a member |

---

### GET /api/teams/:id/invitations

List pending invitations for a team. Requires `admin` or `owner` role.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      id: string,
      email: string,
      role: TeamRole,
      expiresAt: string,
      invitedBy: {
        userId: string,
        name: string
      },
      createdAt: string
    }>
  }
}
```

Note: The invitation `token` is NOT included in list responses for security.

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |

---

### DELETE /api/teams/:id/invitations/:iid

Revoke a pending invitation. Requires `admin` or `owner` role.

**Response Schema:**

```typescript
{
  ok: true,
  data: { revoked: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin or owner role |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 404 | `INVITATION_NOT_FOUND` | Invitation does not exist or already accepted |

---

### POST /api/invitations/:token/accept

Accept a team invitation. The authenticated user's email must match the invitation email. On success, the user is added to the team with the invited role and the invitation is consumed.

**Request Schema:**

No body required. The token is in the URL path.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    teamId: string,
    teamName: string,
    role: TeamRole,
    joinedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INVITATION_EMAIL_MISMATCH` | Authenticated user email does not match invitation |
| 404 | `INVITATION_NOT_FOUND` | Token does not exist |
| 410 | `INVITATION_EXPIRED` | Invitation has expired (past 7-day window) |
| 409 | `MEMBER_ALREADY_EXISTS` | User is already a member of this team |

---

## Project Members

Project members provide per-project role overrides. A user's effective role for a project is the **higher** of their team role and their project-specific override.

### POST /api/projects/:id/members

Add a project-level role override. Requires `admin` role in the team that owns the project, or project-level `admin`.

**Request Schema:**

```typescript
const addProjectMemberSchema = z.object({
  userId: z.string().cuid2(),
  role: z.enum(['viewer', 'member', 'admin']),
  teamId: z.string().cuid2().optional(),  // Required if project belongs to multiple teams
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    userId: string,
    projectId: string,
    role: TeamRole,
    effectiveRole: TeamRole,  // Max of team role and project role
    grantedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin role |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |
| 404 | `USER_NOT_FOUND` | Target user does not exist |
| 409 | `PROJECT_MEMBER_EXISTS` | User already has a project-level override |

---

### GET /api/projects/:id/members

List project members with their effective roles (combining team role and project override).

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      userId: string,
      name: string,
      email: string,
      avatarUrl: string | null,
      teamRole: TeamRole | null,       // Role from team membership
      projectRole: TeamRole | null,    // Project-level override (null if none)
      effectiveRole: TeamRole,         // Max of teamRole and projectRole
      source: "team" | "project" | "both"  // Where access comes from
    }>
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `PROJECT_ACCESS_DENIED` | No access to this project |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |

---

### PATCH /api/projects/:id/members/:uid

Update a project-level role override.

**Request Schema:**

```typescript
const updateProjectMemberSchema = z.object({
  role: z.enum(['viewer', 'member', 'admin']),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    userId: string,
    projectId: string,
    role: TeamRole,
    effectiveRole: TeamRole
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin role |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |
| 404 | `PROJECT_MEMBER_NOT_FOUND` | No project-level override exists for this user |

---

### DELETE /api/projects/:id/members/:uid

Remove a project-level role override. The user's access reverts to their team role (they are not removed from the team).

**Response Schema:**

```typescript
{
  ok: true,
  data: { removed: true, revertedToTeamRole: TeamRole }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin role |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |
| 404 | `PROJECT_MEMBER_NOT_FOUND` | No project-level override exists for this user |

---

## API Tokens

API tokens provide programmatic access with scoped permissions. Tokens use the `ap_` prefix for identification and are shown to the user exactly once at creation time. Only the token hash and a 6-character prefix are stored in the database.

### POST /api/tokens

Create a scoped API token. The full token is returned only in this response.

**Request Schema:**

```typescript
const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  teamId: z.string().cuid2(),
  role: z.enum(['viewer', 'member', 'admin']),
  scopeTags: z.array(z.string().cuid2()).optional(),      // Restrict to resources with these tags
  scopeProjectId: z.string().cuid2().optional(),           // Restrict to a single project
  expiresInDays: z.number().min(1).max(365).optional(),    // Default: 90 days
});
```

Token role cannot exceed the user's role in the specified team.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    token: string,          // "ap_..." -- SHOWN ONCE, never returned again
    prefix: string,         // First 10 chars for identification (e.g. "ap_a1b2c3")
    teamId: string,
    role: TeamRole,
    scopeTags: string[] | null,
    scopeProjectId: string | null,
    expiresAt: string,
    createdAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 400 | `TOKEN_ROLE_EXCEEDS_USER_ROLE` | Token role is higher than user's team role |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `TEAM_ACCESS_DENIED` | Not a member of the specified team |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |

---

### GET /api/tokens

List the authenticated user's API tokens. The full token value is never returned.

**Request Schema:**

```typescript
// Query parameters
const listTokensSchema = z.object({
  teamId: z.string().cuid2().optional(),  // Filter by team
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      id: string,
      name: string,
      prefix: string,         // "ap_a1b2c3" for display
      teamId: string,
      teamName: string,
      role: TeamRole,
      scopeTags: string[] | null,
      scopeProjectId: string | null,
      lastUsedAt: string | null,
      expiresAt: string,
      createdAt: string
    }>
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |

---

### GET /api/tokens/:id

Get details for a specific API token.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    prefix: string,
    teamId: string,
    teamName: string,
    role: TeamRole,
    scopeTags: Array<{ id: string, name: string, color: string }> | null,
    scopeProjectId: string | null,
    scopeProjectName: string | null,
    lastUsedAt: string | null,
    expiresAt: string,
    createdAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 404 | `TOKEN_NOT_FOUND` | Token does not exist or does not belong to user |

---

### DELETE /api/tokens/:id

Revoke (delete) an API token. Takes effect immediately -- any in-flight requests using this token will fail.

**Response Schema:**

```typescript
{
  ok: true,
  data: { revoked: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 404 | `TOKEN_NOT_FOUND` | Token does not exist or does not belong to user |

---

## Tags

Tags are team-scoped labels that can be assigned to projects and tasks. They enable organizational grouping and are used as access-control scopes for API tokens (see tags spec for full behavior).

### POST /api/tags

Create a tag within a team.

**Request Schema:**

```typescript
const createTagSchema = z.object({
  teamId: z.string().cuid2(),
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),  // Hex color
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    teamId: string,
    name: string,
    color: string,
    createdAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires member role or above |
| 404 | `TEAM_NOT_FOUND` | Team does not exist |
| 409 | `TAG_NAME_EXISTS` | Tag with this name already exists in the team |

---

### GET /api/tags

List tags for a team.

**Request Schema:**

```typescript
// Query parameters
const listTagsSchema = z.object({
  teamId: z.string().cuid2(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    items: Array<{
      id: string,
      teamId: string,
      name: string,
      color: string,
      projectCount: number,   // Number of projects using this tag
      taskCount: number,       // Number of tasks using this tag
      createdAt: string
    }>
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Missing teamId query parameter |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `TEAM_ACCESS_DENIED` | Not a member of the specified team |

---

### DELETE /api/tags/:id

Delete a tag. Cascade-deletes all tag assignments (project-tag, task-tag junctions). API tokens scoped to this tag lose that scope restriction.

**Response Schema:**

```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires admin role in the tag's team |
| 404 | `TAG_NOT_FOUND` | Tag does not exist |

---

### POST /api/projects/:id/tags

Assign a tag to a project.

**Request Schema:**

```typescript
const assignProjectTagSchema = z.object({
  tagId: z.string().cuid2(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    projectId: string,
    tagId: string,
    assignedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires member role or above |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |
| 404 | `TAG_NOT_FOUND` | Tag does not exist |
| 409 | `TAG_ALREADY_ASSIGNED` | Tag is already assigned to this project |

---

### DELETE /api/projects/:id/tags/:tagId

Remove a tag from a project.

**Response Schema:**

```typescript
{
  ok: true,
  data: { removed: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires member role or above |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist |
| 404 | `TAG_NOT_FOUND` | Tag is not assigned to this project |

---

### POST /api/tasks/:id/tags

Assign a tag to a task.

**Request Schema:**

```typescript
const assignTaskTagSchema = z.object({
  tagId: z.string().cuid2(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    taskId: string,
    tagId: string,
    assignedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires member role or above |
| 404 | `TASK_NOT_FOUND` | Task does not exist |
| 404 | `TAG_NOT_FOUND` | Tag does not exist |
| 409 | `TAG_ALREADY_ASSIGNED` | Tag is already assigned to this task |

---

### DELETE /api/tasks/:id/tags/:tagId

Remove a tag from a task.

**Response Schema:**

```typescript
{
  ok: true,
  data: { removed: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 403 | `INSUFFICIENT_ROLE` | Requires member role or above |
| 404 | `TASK_NOT_FOUND` | Task does not exist |
| 404 | `TAG_NOT_FOUND` | Tag is not assigned to this task |

---

## Me (Current User)

### GET /api/me

Get the authenticated user's profile, including all team memberships and roles.

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    email: string,
    avatarUrl: string | null,
    teams: Array<{
      id: string,
      name: string,
      slug: string,
      role: TeamRole,
      joinedAt: string
    }>,
    createdAt: string,
    updatedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `AUTH_REQUIRED` | Not authenticated |

---

### PATCH /api/me

Update the current user's profile.

**Request Schema:**

```typescript
const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
});
```

**Response Schema:**

```typescript
{
  ok: true,
  data: {
    id: string,
    name: string,
    email: string,
    avatarUrl: string | null,
    updatedAt: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | Not authenticated |
| 409 | `EMAIL_ALREADY_EXISTS` | Another user already has this email |

---

## RBAC Error Codes

Summary of all error codes introduced by the RBAC system:

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_REQUIRED` | 401 | No valid session or API token provided |
| `TOKEN_EXPIRED` | 401 | API token has expired |
| `TOKEN_REVOKED` | 401 | API token has been revoked |
| `TEAM_NOT_FOUND` | 404 | Team ID does not exist |
| `TEAM_SLUG_EXISTS` | 409 | Team slug already taken |
| `TEAM_ACCESS_DENIED` | 403 | User is not a member of this team |
| `INSUFFICIENT_ROLE` | 403 | User's role is below the required level |
| `MEMBER_NOT_FOUND` | 404 | User is not a member of the specified team |
| `MEMBER_ALREADY_EXISTS` | 409 | User is already a team member |
| `CANNOT_CHANGE_OWN_ROLE` | 400 | Users cannot modify their own role |
| `CANNOT_DEMOTE_LAST_OWNER` | 400 | Team must retain at least one owner |
| `CANNOT_REMOVE_LAST_OWNER` | 400 | Cannot remove the last owner from a team |
| `INVITATION_NOT_FOUND` | 404 | Invitation token does not exist |
| `INVITATION_EXPIRED` | 410 | Invitation has expired (past 7-day TTL) |
| `INVITATION_EMAIL_MISMATCH` | 403 | Authenticated user email does not match invitation |
| `INVITATION_ALREADY_EXISTS` | 409 | Pending invitation for this email already exists |
| `PROJECT_ACCESS_DENIED` | 403 | User has no access to this project |
| `PROJECT_MEMBER_EXISTS` | 409 | Project-level override already exists |
| `PROJECT_MEMBER_NOT_FOUND` | 404 | No project-level override for this user |
| `TOKEN_NOT_FOUND` | 404 | API token does not exist or is not owned by user |
| `TOKEN_ROLE_EXCEEDS_USER_ROLE` | 400 | Requested token role exceeds user's team role |
| `TAG_NOT_FOUND` | 404 | Tag does not exist |
| `TAG_NAME_EXISTS` | 409 | Tag name already exists within the team |
| `TAG_ALREADY_ASSIGNED` | 409 | Tag is already assigned to the resource |
| `USER_NOT_FOUND` | 404 | User ID does not exist |
| `EMAIL_ALREADY_EXISTS` | 409 | Email address already in use by another user |

---

## Middleware

### Authentication Middleware

Applied to all `/api/*` routes. Extracts identity from session cookie or `Authorization: Bearer ap_...` header.

```typescript
// Pseudocode for auth middleware
async function authMiddleware(c: Context, next: Next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (token?.startsWith('ap_')) {
    // API token auth
    const apiToken = await validateApiToken(token);
    if (!apiToken) throw createError('AUTH_REQUIRED', 'Invalid API token', 401);
    if (apiToken.expiresAt < new Date()) throw createError('TOKEN_EXPIRED', 'Token expired', 401);
    if (apiToken.revokedAt) throw createError('TOKEN_REVOKED', 'Token revoked', 401);

    c.set('userId', apiToken.userId);
    c.set('tokenId', apiToken.id);
    c.set('tokenScopes', {
      teamId: apiToken.teamId,
      role: apiToken.role,
      tags: apiToken.scopeTags,
      projectId: apiToken.scopeProjectId,
    });
  } else {
    // Session cookie auth
    const session = await getSession(c);
    if (!session) throw createError('AUTH_REQUIRED', 'Authentication required', 401);
    c.set('userId', session.userId);
  }

  await next();
}
```

### Role Guard Middleware

Parameterized middleware for role checks on team-scoped routes.

```typescript
function requireRole(minRole: TeamRole) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');
    const teamId = c.req.param('id'); // or derived from resource
    const membership = await getTeamMembership(userId, teamId);

    if (!membership) throw createError('TEAM_ACCESS_DENIED', 'Not a team member', 403);
    if (roleLevel(membership.role) < roleLevel(minRole)) {
      throw createError('INSUFFICIENT_ROLE', `Requires ${minRole} role or above`, 403);
    }

    // If using API token, effective role is min of token role and membership role
    const tokenScopes = c.get('tokenScopes');
    if (tokenScopes) {
      const effectiveRole = minRoleOf(tokenScopes.role, membership.role);
      if (roleLevel(effectiveRole) < roleLevel(minRole)) {
        throw createError('INSUFFICIENT_ROLE', `Token role insufficient`, 403);
      }
    }

    c.set('teamRole', membership.role);
    await next();
  };
}
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Tags](./tags.md) | Tag system details and token scoping behavior |
| [GitHub Tokens](./github-tokens.md) | Per-team GitHub token migration |
| [Database Schema](../application/database/schema.md) | Core tables referenced by RBAC |
| [Error Catalog](../application/errors/error-catalog.md) | Base error patterns extended here |
| [API Endpoints](../application/api/endpoints.md) | Existing endpoints that gain auth middleware |
| [Pagination](../application/api/pagination.md) | Cursor-based pagination used by list endpoints |
