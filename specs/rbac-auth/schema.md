# RBAC Database Schema Specification

## Overview

This document defines 11 new database tables for the RBAC system. All tables follow the existing AgentPane SQLite conventions:

- **Primary keys**: `TEXT` columns with `cuid2` generated IDs
- **Timestamps**: `TEXT` columns with `datetime('now')` defaults
- **Enums**: `TEXT` columns validated at the application layer (no native SQLite enums)
- **JSON**: `TEXT` columns with `{ mode: 'json' }` in Drizzle
- **Booleans**: `INTEGER` columns with `{ mode: 'boolean' }` (0/1)
- **Foreign keys**: Inline `REFERENCES` with `ON DELETE CASCADE` or `ON DELETE SET NULL`

---

## Enum Additions

Add to `src/db/schema/shared/enums.ts`:

```typescript
// RBAC role hierarchy (higher level = more permissions)
export const RBAC_ROLES = ['viewer', 'agent_operator', 'admin', 'owner'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

// Role level for comparison (viewer=1, owner=4)
export const RBAC_ROLE_LEVEL: Record<RbacRole, number> = {
  viewer: 1,
  agent_operator: 2,
  admin: 3,
  owner: 4,
};

// API token status
export const API_TOKEN_STATUS = ['active', 'revoked', 'expired'] as const;
export type ApiTokenStatus = (typeof API_TOKEN_STATUS)[number];

// Team invitation status
export const INVITATION_STATUS = ['pending', 'accepted', 'declined', 'expired', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];
```

---

## Table 1: users

Stores authenticated user identities sourced from GitHub OAuth.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/users.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  // GitHub identity
  githubId: integer('github_id').notNull().unique(),
  githubLogin: text('github_login').notNull(),
  // Profile
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "github_id" INTEGER NOT NULL UNIQUE,
  "github_login" TEXT NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "avatar_url" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_idx" ON "users"("github_id");
CREATE INDEX IF NOT EXISTS "users_github_login_idx" ON "users"("github_login");
```

### Notes

- `githubId` is an integer because GitHub user IDs are numeric. The `UNIQUE` constraint prevents duplicate user records from the same GitHub account.
- `githubLogin` is **not** unique at the database level because GitHub usernames can be renamed. Lookups should use `githubId`.
- `name`, `email`, and `avatarUrl` are synced from GitHub on each login and may be null if the user has not set them on GitHub.

---

## Table 2: user_sessions

Server-side session tokens for authenticated users. Each row represents an active login session.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/user-sessions.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const userSessions = sqliteTable('user_sessions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Opaque bearer token (SHA-256 of the raw token sent to the client)
  token: text('token').notNull().unique(),
  // Expiration
  expiresAt: text('expires_at').notNull(),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_sessions_user_id_idx" ON "user_sessions"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_idx" ON "user_sessions"("token");
```

### Notes

- The `token` column stores a SHA-256 hash of the raw bearer token. The raw token is only sent to the client once at creation time. Lookup is done by hashing the incoming `Authorization: Bearer <raw>` header and querying by hash.
- Expired sessions should be cleaned up periodically (e.g., on bootstrap or via a cron-like interval).

---

## Table 3: teams

Organizational unit that owns projects and groups users.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/teams.ts (teams table only; team_members and team_projects below)
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const teams = sqliteTable('teams', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "teams" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "teams_slug_idx" ON "teams"("slug");
```

### Notes

- `slug` is a URL-safe, lowercase, hyphenated version of the team name (e.g., "My Team" becomes "my-team"). Used in URLs and API paths. Must be unique.
- The user who creates a team is automatically added as `owner` in `team_members`.

---

## Table 4: team_members

Junction table linking users to teams with a role assignment.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/teams.ts (continued, same file as teams)
import { primaryKey } from 'drizzle-orm/sqlite-core';
import type { RbacRole } from '../shared/enums';
import { users } from './users';

export const teamMembers = sqliteTable('team_members', {
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<RbacRole>().notNull().default('viewer'),
  joinedAt: text('joined_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.teamId, table.userId] }),
}));

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'viewer',
  "joined_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "team_members_user_id_idx" ON "team_members"("user_id");
```

### Notes

- Composite primary key `(team_id, user_id)` ensures a user can belong to a team only once.
- `role` is one of: `owner`, `admin`, `agent_operator`, `viewer`.
- Every team must have at least one `owner`. The application layer enforces this constraint (preventing removal of the last owner).

---

## Table 5: team_projects

Junction table assigning projects to teams. A project can belong to multiple teams.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/teams.ts (continued, same file)
import { projects } from './projects';

export const teamProjects = sqliteTable('team_projects', {
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.teamId, table.projectId] }),
}));

export type TeamProject = typeof teamProjects.$inferSelect;
export type NewTeamProject = typeof teamProjects.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "team_projects" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "project_id")
);

CREATE INDEX IF NOT EXISTS "team_projects_project_id_idx" ON "team_projects"("project_id");
```

### Notes

- When a project is assigned to a team, all team members inherit access to that project at their team role level (unless overridden in `project_members`).
- Removing a team-project assignment does **not** delete per-user project overrides in `project_members` that reference `grantedByTeamId`. Those should be cleaned up by the service layer.

---

## Table 6: project_members

Per-project role overrides for individual users. Allows granting a user a different role on a specific project than their team role.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/project-members.ts
import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RbacRole } from '../shared/enums';
import { projects } from './projects';
import { teams } from './teams';
import { users } from './users';

export const projectMembers = sqliteTable('project_members', {
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<RbacRole>().notNull(),
  // If this override was granted via a team assignment, track which team
  grantedByTeamId: text('granted_by_team_id')
    .references(() => teams.id, { onDelete: 'set null' }),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.userId] }),
}));

export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "granted_by_team_id" TEXT REFERENCES "teams"("id") ON DELETE SET NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("project_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "project_members_user_id_idx" ON "project_members"("user_id");
```

### Notes

- `grantedByTeamId` is nullable. When null, the override was granted directly (not inherited from a team). When set, it records which team assignment originated this override.
- Effective role resolution logic (implemented in the RBAC service):
  1. Check `project_members` for a direct project-level role.
  2. Check `team_members` for all teams the user belongs to that have this project assigned (via `team_projects`).
  3. Take the **highest** role from all sources.

---

## Table 7: tags

Team-scoped tags that can be applied to projects and tasks for filtering and API token scoping.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/tags.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { teams } from './teams';

export const tags = sqliteTable('tags', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'), // hex color, e.g., '#3fb950'
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  uniqueTeamName: uniqueIndex('tags_team_name_idx').on(table.teamId, table.name),
}));

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "tags" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tags_team_name_idx" ON "tags"("team_id", "name");
```

### Notes

- Tag names are unique per team. The same tag name can exist in different teams.
- `color` is optional. If null, the UI assigns a default color based on the tag name hash.

---

## Table 8: project_tags

Junction table associating tags with projects.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/tags.ts (continued, same file)
import { primaryKey } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

export const projectTags = sqliteTable('project_tags', {
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.tagId] }),
}));

export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "project_tags" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  PRIMARY KEY ("project_id", "tag_id")
);
```

---

## Table 9: task_tags

Junction table associating tags with tasks.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/tags.ts (continued, same file)
import { tasks } from './tasks';

export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.taskId, table.tagId] }),
}));

export type TaskTag = typeof taskTags.$inferSelect;
export type NewTaskTag = typeof taskTags.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "task_tags" (
  "task_id" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  PRIMARY KEY ("task_id", "tag_id")
);
```

---

## Table 10: api_tokens

API tokens for programmatic access. Scoped to a team with an optional tag filter and optional single-project restriction.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/api-tokens.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ApiTokenStatus, RbacRole } from '../shared/enums';
import { projects } from './projects';
import { teams } from './teams';
import { users } from './users';

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  // Who created this token
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Which team this token operates within
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  // Human-readable name (e.g., "CI/CD Pipeline", "Monitoring Bot")
  name: text('name').notNull(),
  // SHA-256 hash of the raw token
  tokenHash: text('token_hash').notNull().unique(),
  // First 8 characters of the raw token for display (e.g., "ap_live_a1b2c3d4...")
  tokenPrefix: text('token_prefix').notNull(),
  // Maximum role this token can assume (capped at creator's role)
  role: text('role').$type<RbacRole>().notNull(),
  // Optional: restrict to resources matching these tag names (JSON array)
  scopeTags: text('scope_tags', { mode: 'json' }).$type<string[]>(),
  // Optional: restrict to a single project
  scopeProjectId: text('scope_project_id')
    .references(() => projects.id, { onDelete: 'set null' }),
  // Token lifecycle
  status: text('status').$type<ApiTokenStatus>().notNull().default('active'),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "token_prefix" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "scope_tags" TEXT,
  "scope_project_id" TEXT REFERENCES "projects"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TEXT,
  "last_used_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_hash_idx" ON "api_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "api_tokens_user_id_idx" ON "api_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "api_tokens_team_id_idx" ON "api_tokens"("team_id");
CREATE INDEX IF NOT EXISTS "api_tokens_status_idx" ON "api_tokens"("status");
```

### Notes

- **Token format**: Raw tokens follow the pattern `ap_live_<32 random hex chars>`. The prefix `ap_live_` (8 chars) is stored in `tokenPrefix` for identification in the UI.
- **Hash storage**: Only the SHA-256 hash is stored. The raw token is shown once at creation and never again.
- **Role ceiling**: The `role` on the token cannot exceed the creating user's role in the team. Enforced at creation time by the service layer.
- **Tag scoping**: When `scopeTags` is set (e.g., `["production"]`), the token can only access projects and tasks that have at least one matching tag. When null, the token has access to all resources within the team (subject to role).
- **Project scoping**: When `scopeProjectId` is set, the token is restricted to that single project. This is more restrictive than tag scoping.
- **Status transitions**: `active` -> `revoked` (manual), `active` -> `expired` (automatic when `expiresAt` is passed).
- **Conflict with existing `api_keys` table**: The existing `api_keys` table stores encrypted service API keys (Anthropic, etc.). The new `api_tokens` table stores user-facing API tokens for AgentPane access. These are different concepts and do not conflict.

---

## Table 11: team_invitations

Pending invitations for users to join a team.

### Drizzle Schema

```typescript
// src/db/schema/sqlite/team-invitations.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { InvitationStatus, RbacRole } from '../shared/enums';
import { teams } from './teams';
import { users } from './users';

export const teamInvitations = sqliteTable('team_invitations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  // Who sent the invitation
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Invitee's email (may not yet have an AgentPane account)
  email: text('email').notNull(),
  // Role the invitee will receive upon acceptance
  role: text('role').$type<RbacRole>().notNull().default('viewer'),
  // Unique token for the invitation link
  token: text('token').notNull().unique(),
  // Invitation lifecycle
  status: text('status').$type<InvitationStatus>().notNull().default('pending'),
  expiresAt: text('expires_at').notNull(),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type TeamInvitation = typeof teamInvitations.$inferSelect;
export type NewTeamInvitation = typeof teamInvitations.$inferInsert;
```

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS "team_invitations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "invited_by" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'viewer',
  "token" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_invitations_token_idx" ON "team_invitations"("token");
CREATE INDEX IF NOT EXISTS "team_invitations_team_id_idx" ON "team_invitations"("team_id");
CREATE INDEX IF NOT EXISTS "team_invitations_email_idx" ON "team_invitations"("email");
```

### Notes

- `token` is a cryptographically random string used in the invitation URL (e.g., `/invite/<token>`).
- `email` is the invited person's email. When they authenticate via GitHub OAuth, the system matches their GitHub email to pending invitations and auto-accepts them (or presents the invitation for manual acceptance).
- **Status transitions**: `pending` -> `accepted` | `declined` | `expired` | `revoked`. Only `pending` invitations can transition. `revoked` is set by an admin cancelling the invitation.
- Default expiry is 7 days from creation.

---

## Existing Table Modification: github_tokens

Add a `team_id` column to associate GitHub tokens with teams.

### ALTER TABLE Migration

```sql
ALTER TABLE github_tokens ADD COLUMN team_id TEXT REFERENCES "teams"("id") ON DELETE SET NULL;
```

### Updated Drizzle Schema

Add to `src/db/schema/sqlite/github.ts`:

```typescript
// Add to the githubTokens table definition:
teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
```

### Notes

- Existing `github_tokens` rows will have `team_id = NULL` after migration. The migration script creates a default team and backfills this column (see [migration.md](./migration.md)).
- When `team_id` is set, the token is shared across the team. When null, it operates in legacy single-user mode.

---

## Complete Index Summary

| Table | Index Name | Columns | Type |
|-------|-----------|---------|------|
| users | `users_github_id_idx` | github_id | UNIQUE |
| users | `users_github_login_idx` | github_login | INDEX |
| user_sessions | `user_sessions_user_id_idx` | user_id | INDEX |
| user_sessions | `user_sessions_token_idx` | token | UNIQUE |
| teams | `teams_slug_idx` | slug | UNIQUE |
| team_members | (primary key) | team_id, user_id | PK |
| team_members | `team_members_user_id_idx` | user_id | INDEX |
| team_projects | (primary key) | team_id, project_id | PK |
| team_projects | `team_projects_project_id_idx` | project_id | INDEX |
| project_members | (primary key) | project_id, user_id | PK |
| project_members | `project_members_user_id_idx` | user_id | INDEX |
| tags | `tags_team_name_idx` | team_id, name | UNIQUE |
| project_tags | (primary key) | project_id, tag_id | PK |
| task_tags | (primary key) | task_id, tag_id | PK |
| api_tokens | `api_tokens_hash_idx` | token_hash | UNIQUE |
| api_tokens | `api_tokens_user_id_idx` | user_id | INDEX |
| api_tokens | `api_tokens_team_id_idx` | team_id | INDEX |
| api_tokens | `api_tokens_status_idx` | status | INDEX |
| team_invitations | `team_invitations_token_idx` | token | UNIQUE |
| team_invitations | `team_invitations_team_id_idx` | team_id | INDEX |
| team_invitations | `team_invitations_email_idx` | email | INDEX |

---

## Relations

Add to `src/db/schema/sqlite/relations.ts`:

```typescript
import { users } from './users';
import { userSessions } from './user-sessions';
import { teams, teamMembers, teamProjects } from './teams';
import { projectMembers } from './project-members';
import { tags, projectTags, taskTags } from './tags';
import { apiTokens } from './api-tokens';
import { teamInvitations } from './team-invitations';

// User relations
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(userSessions),
  teamMemberships: many(teamMembers),
  projectMemberships: many(projectMembers),
  apiTokens: many(apiTokens),
  sentInvitations: many(teamInvitations),
}));

// User session relations
export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id],
  }),
}));

// Team relations
export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  projects: many(teamProjects),
  tags: many(tags),
  apiTokens: many(apiTokens),
  invitations: many(teamInvitations),
}));

// Team member relations
export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

// Team project relations
export const teamProjectsRelations = relations(teamProjects, ({ one }) => ({
  team: one(teams, {
    fields: [teamProjects.teamId],
    references: [teams.id],
  }),
  project: one(projects, {
    fields: [teamProjects.projectId],
    references: [projects.id],
  }),
}));

// Project member relations
export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMembers.userId],
    references: [users.id],
  }),
  grantedByTeam: one(teams, {
    fields: [projectMembers.grantedByTeamId],
    references: [teams.id],
  }),
}));

// Tag relations
export const tagsRelations = relations(tags, ({ one, many }) => ({
  team: one(teams, {
    fields: [tags.teamId],
    references: [teams.id],
  }),
  projectTags: many(projectTags),
  taskTags: many(taskTags),
}));

// Project tag relations
export const projectTagsRelations = relations(projectTags, ({ one }) => ({
  project: one(projects, {
    fields: [projectTags.projectId],
    references: [projects.id],
  }),
  tag: one(tags, {
    fields: [projectTags.tagId],
    references: [tags.id],
  }),
}));

// Task tag relations
export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTags.taskId],
    references: [tasks.id],
  }),
  tag: one(tags, {
    fields: [taskTags.tagId],
    references: [tags.id],
  }),
}));

// API token relations
export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, {
    fields: [apiTokens.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [apiTokens.teamId],
    references: [teams.id],
  }),
  scopeProject: one(projects, {
    fields: [apiTokens.scopeProjectId],
    references: [projects.id],
  }),
}));

// Team invitation relations
export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  team: one(teams, {
    fields: [teamInvitations.teamId],
    references: [teams.id],
  }),
  inviter: one(users, {
    fields: [teamInvitations.invitedBy],
    references: [users.id],
  }),
}));
```

### Additions to Existing Relations

Add to the existing `projectsRelations`:

```typescript
// Add to projectsRelations in relations.ts
export const projectsRelations = relations(projects, ({ one, many }) => ({
  // ... existing relations ...
  teamProjects: many(teamProjects),
  projectMembers: many(projectMembers),
  projectTags: many(projectTags),
}));
```

Add to the existing `tasksRelations`:

```typescript
// Add to tasksRelations in relations.ts
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  // ... existing relations ...
  taskTags: many(taskTags),
}));
```

---

## Zod Validation Schemas

```typescript
// src/db/schema/shared/rbac-validation.ts
import { z } from 'zod';
import { RBAC_ROLES, API_TOKEN_STATUS, INVITATION_STATUS } from './enums';

// User (upserted from GitHub OAuth, not user-created)
export const upsertUserSchema = z.object({
  githubId: z.number().int().positive(),
  githubLogin: z.string().min(1).max(39),
  name: z.string().max(255).nullable().optional(),
  email: z.string().email().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

// Team
export const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(500).optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

// Team member
export const addTeamMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(RBAC_ROLES),
});

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(RBAC_ROLES),
});

// Team invitation
export const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(RBAC_ROLES).default('viewer'),
});

// Project member override
export const setProjectMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(RBAC_ROLES),
});

// Tag
export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

// API token
export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(RBAC_ROLES),
  scopeTags: z.array(z.string().min(1).max(50)).optional(),
  scopeProjectId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

// Type exports
export type UpsertUserInput = z.infer<typeof upsertUserSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type SetProjectMemberInput = z.infer<typeof setProjectMemberSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
```

---

## Entity Relationship Diagram

```
                         ┌─────────────────┐
                         │     users       │
                         ├─────────────────┤
                         │ id (PK)         │
                         │ github_id (UQ)  │
                         │ github_login    │
                         │ name            │
                         │ email           │
                         │ avatar_url      │
                         └──┬──────┬───────┘
                            │      │
               ┌────────────┘      └────────────┐
               │                                │
               ▼                                ▼
    ┌──────────────────┐            ┌──────────────────────┐
    │  user_sessions   │            │    team_members      │
    ├──────────────────┤            ├──────────────────────┤
    │ id (PK)          │            │ team_id (PK/FK)      │
    │ user_id (FK)     │            │ user_id (PK/FK)      │
    │ token (UQ)       │            │ role                 │
    │ expires_at       │            │ joined_at            │
    └──────────────────┘            └──────────┬───────────┘
                                               │
                                               ▼
                                    ┌──────────────────┐
                                    │     teams        │
                                    ├──────────────────┤
                                    │ id (PK)          │
                                    │ name             │
                                    │ slug (UQ)        │
                                    │ description      │
                                    └──┬───┬───┬───┬───┘
                                       │   │   │   │
                    ┌──────────────────┘   │   │   └───────────────────┐
                    │                      │   │                       │
                    ▼                      ▼   ▼                       ▼
         ┌────────────────┐    ┌────────────┐ ┌─────────────┐  ┌──────────────────┐
         │ team_projects  │    │   tags     │ │ api_tokens  │  │team_invitations  │
         ├────────────────┤    ├────────────┤ ├─────────────┤  ├──────────────────┤
         │ team_id (PK/FK)│    │ id (PK)   │ │ id (PK)     │  │ id (PK)          │
         │ project_id     │    │ team_id   │ │ user_id     │  │ team_id (FK)     │
         │  (PK/FK)       │    │ name      │ │ team_id     │  │ invited_by (FK)  │
         │ assigned_at    │    │ color     │ │ name        │  │ email            │
         └───────┬────────┘    └──┬────────┘ │ token_hash  │  │ role             │
                 │                │          │ role        │  │ token (UQ)       │
                 ▼                │          │ scope_tags  │  │ status           │
         ┌────────────┐          │          │ scope_proj  │  │ expires_at       │
         │  projects  │          │          │ status      │  └──────────────────┘
         │  (existing)│◄─────────┤          └─────────────┘
         └─────┬──────┘          │
               │                 ├──────────────┐
               │                 │              │
               ▼                 ▼              ▼
    ┌──────────────────┐  ┌────────────┐ ┌────────────┐
    │ project_members  │  │project_tags│ │ task_tags   │
    ├──────────────────┤  ├────────────┤ ├────────────┤
    │ project_id       │  │ project_id │ │ task_id    │
    │  (PK/FK)         │  │  (PK/FK)   │ │  (PK/FK)   │
    │ user_id (PK/FK)  │  │ tag_id     │ │ tag_id     │
    │ role             │  │  (PK/FK)   │ │  (PK/FK)   │
    │ granted_by_team  │  └────────────┘ └────────────┘
    └──────────────────┘

    ┌─────────────────────┐
    │  github_tokens      │
    │  (existing, modified)│
    ├─────────────────────┤
    │ ...existing cols... │
    │ team_id (FK, new)   │
    └─────────────────────┘
```

---

## Schema File Organization

New files to create:

| File Path | Tables |
|-----------|--------|
| `src/db/schema/sqlite/users.ts` | `users` |
| `src/db/schema/sqlite/user-sessions.ts` | `userSessions` |
| `src/db/schema/sqlite/teams.ts` | `teams`, `teamMembers`, `teamProjects` |
| `src/db/schema/sqlite/project-members.ts` | `projectMembers` |
| `src/db/schema/sqlite/tags.ts` | `tags`, `projectTags`, `taskTags` |
| `src/db/schema/sqlite/api-tokens.ts` | `apiTokens` (replace existing, see note) |
| `src/db/schema/sqlite/team-invitations.ts` | `teamInvitations` |

Files to modify:

| File Path | Change |
|-----------|--------|
| `src/db/schema/shared/enums.ts` | Add `RBAC_ROLES`, `API_TOKEN_STATUS`, `INVITATION_STATUS` |
| `src/db/schema/sqlite/github.ts` | Add `teamId` column to `githubTokens` |
| `src/db/schema/sqlite/relations.ts` | Add all RBAC relations |
| `src/db/schema/sqlite/index.ts` | Re-export new schema files |

### Note on `api-tokens.ts` vs existing `api-keys.ts`

The existing `src/db/schema/sqlite/api-keys.ts` defines the `apiKeys` table for storing encrypted service API keys (Anthropic, OpenAI). The new `api-tokens.ts` file defines the `apiTokens` table for user-facing API access tokens. These are separate tables serving different purposes. Both files should coexist.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [README.md](./README.md) | Phase overview and design decisions |
| [migration.md](./migration.md) | Migration strategy for these tables |
| [Existing Schema Spec](../application/database/schema.md) | Base schema these tables extend |
| [Bootstrap Schema](../../src/lib/bootstrap/phases/schema.ts) | Where migration SQL is executed |
| [Shared Enums](../../src/db/schema/shared/enums.ts) | Where RBAC_ROLES enum is added |
