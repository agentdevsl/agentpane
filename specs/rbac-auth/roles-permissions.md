# RBAC Roles & Permissions Specification

## Overview

This specification defines the Role-Based Access Control (RBAC) system for AgentPane. The system provides a 4-tier role hierarchy that governs access to projects, tasks, agents, sessions, and administrative operations. Roles are resolved through a combination of direct project membership, team membership, and API token scoping.

**Design Principles**:

- **Least Privilege**: Users receive the minimum role needed for their function
- **Additive Resolution**: When multiple membership paths exist, the highest role wins
- **Token Ceiling**: API tokens can never exceed the holder's resolved role
- **Dev-Mode Bypass**: Local development grants full owner access automatically

---

## Role Hierarchy

AgentPane defines four role tiers. Each tier inherits all permissions from the tiers below it.

| Role | Level | Identifier | Description |
|------|-------|------------|-------------|
| Owner | 4 | `owner` | Full control over the team. Can delete the team, transfer ownership, and perform all administrative operations. There must always be at least one owner per team. |
| Admin | 3 | `admin` | Manages team members, projects, settings, and API tokens. Can create tokens scoped to any role at or below admin level. Cannot delete the team or transfer ownership. |
| Agent Operator | 2 | `agent_operator` | Day-to-day task and agent operations. Can create, edit, and move tasks across Kanban columns. Can start and stop agents, approve or reject agent plans, and manage agent execution. |
| Viewer | 1 | `viewer` | Read-only access to all projects, tasks, sessions, and agents within their membership scope. Cannot modify any resources. |

### TypeScript Definitions

```typescript
// lib/rbac/types.ts

export type RbacRole = 'owner' | 'admin' | 'agent_operator' | 'viewer';

export const ROLE_LEVELS: Record<RbacRole, number> = {
  owner: 4,
  admin: 3,
  agent_operator: 2,
  viewer: 1,
} as const;

/**
 * Check if a role meets or exceeds the minimum required level.
 */
export function hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean {
  return ROLE_LEVELS[userRole] >= ROLE_LEVELS[minimumRole];
}

/**
 * Return the higher of two roles.
 */
export function higherRole(a: RbacRole, b: RbacRole): RbacRole {
  return ROLE_LEVELS[a] >= ROLE_LEVELS[b] ? a : b;
}

/**
 * Return the lower of two roles (used for token ceiling).
 */
export function lowerRole(a: RbacRole, b: RbacRole): RbacRole {
  return ROLE_LEVELS[a] <= ROLE_LEVELS[b] ? a : b;
}
```

---

## Permission Matrix

### Core Permissions

| Action | Minimum Role | Notes |
|--------|-------------|-------|
| **View** | | |
| View projects | `viewer` | Only projects within membership scope |
| View tasks | `viewer` | Includes all Kanban columns |
| View sessions | `viewer` | Includes session history and events |
| View agents | `viewer` | Includes agent status, runs, audit logs |
| View worktrees | `viewer` | Read-only worktree listing |
| **Task Operations** | | |
| Create tasks | `agent_operator` | Create new tasks in any column |
| Edit task title/description | `agent_operator` | Modify task content |
| Move tasks between columns | `agent_operator` | Drag-drop on Kanban board |
| Delete tasks | `agent_operator` | Soft-delete with audit trail |
| Add/remove task labels | `agent_operator` | Tag management |
| **Agent Operations** | | |
| Start agents | `agent_operator` | Trigger agent execution on tasks |
| Stop agents | `agent_operator` | Cancel running agent |
| Approve agent plans | `agent_operator` | Accept plan during planning phase |
| Reject agent plans | `agent_operator` | Reject with reason |
| Approve task completion | `agent_operator` | Accept agent's work |
| **Project Management** | | |
| Create projects | `admin` | New project setup |
| Edit project settings | `admin` | Config, env vars, tool whitelist |
| Delete projects | `admin` | Permanent removal |
| Manage project members | `admin` | Add/remove/change roles within project |
| Configure sandbox mode | `admin` | Docker/K8s/Nomad settings |
| **Team Administration** | | |
| Manage team members | `admin` | Invite, remove, change roles |
| Create API tokens (any scope) | `admin` | Tokens scoped up to admin level |
| Manage settings | `admin` | Global application settings |
| View audit logs | `admin` | Security and operational audit trail |
| **Ownership Operations** | | |
| Delete team | `owner` | Irreversible team deletion |
| Transfer ownership | `owner` | Reassign owner role to another member |
| Promote to owner | `owner` | Only owners can create other owners |

### Permission Lookup Table

```typescript
// lib/rbac/permissions.ts

import type { RbacRole } from './types';

/**
 * Canonical permission identifiers used throughout the application.
 * Each permission maps to a minimum required role.
 */
export const PERMISSIONS = {
  // View permissions
  'project:read':           'viewer',
  'task:read':              'viewer',
  'session:read':           'viewer',
  'agent:read':             'viewer',
  'worktree:read':          'viewer',

  // Task operations
  'task:create':            'agent_operator',
  'task:update':            'agent_operator',
  'task:move':              'agent_operator',
  'task:delete':            'agent_operator',
  'task:label':             'agent_operator',

  // Agent operations
  'agent:start':            'agent_operator',
  'agent:stop':             'agent_operator',
  'agent:approve_plan':     'agent_operator',
  'agent:reject_plan':      'agent_operator',
  'agent:approve_task':     'agent_operator',

  // Project management
  'project:create':         'admin',
  'project:update':         'admin',
  'project:delete':         'admin',
  'project:manage_members': 'admin',
  'project:sandbox_config': 'admin',

  // Team administration
  'team:manage_members':    'admin',
  'team:create_tokens':     'admin',
  'team:manage_settings':   'admin',
  'team:view_audit':        'admin',

  // Ownership
  'team:delete':            'owner',
  'team:transfer_owner':    'owner',
  'team:promote_owner':     'owner',
} as const satisfies Record<string, RbacRole>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: RbacRole, permission: Permission): boolean {
  const requiredRole = PERMISSIONS[permission];
  return ROLE_LEVELS[role] >= ROLE_LEVELS[requiredRole];
}
```

---

## Role Resolution Algorithm

Role resolution determines a user's effective permission level for a given resource. The algorithm considers direct project membership, team-based membership, and API token scoping.

### Resolution Steps

```
1. Check `project_members` for direct project override
   └── If found → use that role (direct assignment takes priority)

2. Check `team_members` via `team_projects` linkage
   └── Collect all teams the user belongs to that are linked to the project
   └── Take the HIGHEST role across all linked teams

3. If request is via API token:
   └── effective role = min(token.role, resolved membership role)
   └── Token can only REDUCE permissions, never elevate

4. No membership found → DENY (return null)
```

### Implementation

```typescript
// lib/rbac/resolve-role.ts

import type { Database } from '@/types/database';
import type { RbacRole } from './types';
import { ROLE_LEVELS, higherRole, lowerRole } from './types';

export interface RoleResolutionInput {
  userId: string;
  projectId: string;
  tokenRole?: RbacRole;  // Present when request is via API token
}

export interface RoleResolutionResult {
  effectiveRole: RbacRole;
  source: 'project_member' | 'team_member' | 'dev_mode';
  teamId?: string;
}

/**
 * Resolve a user's effective role for a given project.
 *
 * @returns The resolved role, or null if the user has no access.
 */
export async function resolveUserRole(
  db: Database,
  input: RoleResolutionInput
): Promise<RoleResolutionResult | null> {
  const { userId, projectId, tokenRole } = input;

  // Step 1: Check direct project membership
  const projectMember = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.userId, userId),
      eq(projectMembers.projectId, projectId),
    ),
  });

  if (projectMember) {
    let effectiveRole = projectMember.role as RbacRole;

    // Apply token ceiling if applicable
    if (tokenRole) {
      effectiveRole = lowerRole(effectiveRole, tokenRole);
    }

    return {
      effectiveRole,
      source: 'project_member',
    };
  }

  // Step 2: Check team memberships via team_projects
  const teamMemberships = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teamProjects, eq(teamMembers.teamId, teamProjects.teamId))
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamProjects.projectId, projectId),
      )
    );

  if (teamMemberships.length > 0) {
    // Take the highest role across all linked teams
    let highestRole = teamMemberships[0].role as RbacRole;
    let highestTeamId = teamMemberships[0].teamId;

    for (const membership of teamMemberships.slice(1)) {
      const candidateRole = membership.role as RbacRole;
      if (ROLE_LEVELS[candidateRole] > ROLE_LEVELS[highestRole]) {
        highestRole = candidateRole;
        highestTeamId = membership.teamId;
      }
    }

    let effectiveRole = highestRole;

    // Apply token ceiling if applicable
    if (tokenRole) {
      effectiveRole = lowerRole(effectiveRole, tokenRole);
    }

    return {
      effectiveRole,
      source: 'team_member',
      teamId: highestTeamId,
    };
  }

  // Step 4: No membership found — deny
  return null;
}
```

---

## Dev-Mode Override

When the application is running in development mode (`authMethod === 'dev'`), the authenticated user automatically receives `owner` role level (4). All permission checks pass without database lookups.

### Behavior

```typescript
// In enrichAuthContext middleware:
if (auth.authMethod === 'dev') {
  auth.resolvedRole = 'owner';
  auth.roleLevel = 4;
  // No team memberships or token scope to resolve
  return next();
}
```

### Conditions for Dev-Mode

Dev-mode is active when any of the following are true:
- `NODE_ENV` is unset or set to `'development'`
- `SKIP_AUTH` is set to `'true'`
- The user was authenticated via `X-Dev-User` header

### Security Note

Dev-mode MUST NOT be active in production. The `enrichAuthContext` middleware should log a warning if dev-mode is detected when `NODE_ENV === 'production'`.

---

## Database Tables

The RBAC system requires the following additional tables (extending the existing schema in `db/schema/`):

### `team_members`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | CUID2 |
| `team_id` | `text` FK | References `teams.id` |
| `user_id` | `text` FK | References `users.id` |
| `role` | `text` | One of: `owner`, `admin`, `agent_operator`, `viewer` |
| `created_at` | `timestamp` | When membership was created |
| `updated_at` | `timestamp` | Last role change |

**Unique constraint**: `(team_id, user_id)`

### `project_members`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | CUID2 |
| `project_id` | `text` FK | References `projects.id` |
| `user_id` | `text` FK | References `users.id` |
| `role` | `text` | Role override for this specific project |
| `created_at` | `timestamp` | When membership was created |
| `updated_at` | `timestamp` | Last role change |

**Unique constraint**: `(project_id, user_id)`

### `team_projects`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | CUID2 |
| `team_id` | `text` FK | References `teams.id` |
| `project_id` | `text` FK | References `projects.id` |
| `created_at` | `timestamp` | When link was created |

**Unique constraint**: `(team_id, project_id)`

---

## Edge Cases

### Owner Demotion Protection

An owner cannot demote themselves if they are the last owner of the team. The system must enforce that at least one owner always exists per team.

```typescript
async function validateOwnerDemotion(
  db: Database,
  teamId: string,
  userId: string,
  newRole: RbacRole
): Promise<boolean> {
  if (newRole === 'owner') return true;

  const ownerCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, 'owner'),
        ne(teamMembers.userId, userId),
      )
    );

  return ownerCount[0].count > 0;
}
```

### Orphaned Project Access

If a project has no `project_members` and no `team_projects` entries, only users with a direct project membership or the team owner can access it. The UI should prompt admins to configure access.

### Token Role Ceiling Examples

| User Membership Role | Token Role | Effective Role |
|---------------------|------------|----------------|
| `admin` | `admin` | `admin` |
| `admin` | `agent_operator` | `agent_operator` |
| `agent_operator` | `admin` | `agent_operator` |
| `viewer` | `owner` | `viewer` |

The effective role is always `min(membership_role, token_role)`.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Middleware](./middleware.md) | Implements role checking in request pipeline |
| [API Tokens](./tokens.md) | Token scoping and role ceiling |
| [Authentication](../application/security/authentication.md) | Existing auth flow that RBAC extends |
| [Security Model](../application/security/security-model.md) | Agent-level security controls |
| [Database Schema](../application/database/schema.md) | Existing schema this extends |
| [API Endpoints](../application/api/endpoints.md) | Routes that require role checks |
