# GitHub Token Per-Team Migration Specification

## Overview

This spec defines the migration of the `github_tokens` table from a singleton (no team association) model to a per-team model, where each team can have its own GitHub Personal Access Token. This enables multi-team setups where different teams connect to different GitHub organizations.

---

## Current State

The existing `github_tokens` table has no team association:

```typescript
// src/db/schema/sqlite/github.ts (current)
export const githubTokens = sqliteTable('github_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  encryptedToken: text('encrypted_token').notNull(),
  tokenType: text('token_type').notNull().default('pat'),
  scopes: text('scopes'),
  githubLogin: text('github_login'),
  githubId: text('github_id'),
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

**Limitations of the current model:**

- All projects share the same GitHub PAT
- No way to connect different teams to different GitHub organizations
- No isolation between teams' GitHub credentials
- Single token failure affects all projects

---

## Target State

The `github_tokens` table gains a `team_id` column, associating each token with a specific team. Tokens without a `team_id` continue to function as global tokens for backward compatibility.

```typescript
// src/db/schema/sqlite/github.ts (target)
export const githubTokens = sqliteTable('github_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  // NEW: Team association (nullable for backward compatibility)
  teamId: text('team_id')
    .references(() => teams.id, { onDelete: 'set null' }),

  encryptedToken: text('encrypted_token').notNull(),
  tokenType: text('token_type').notNull().default('pat'),
  scopes: text('scopes'),
  githubLogin: text('github_login'),
  githubId: text('github_id'),
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

### New Index

```typescript
export const githubTokenIndexes = {
  teamIdx: index('github_tokens_team_idx').on(githubTokens.teamId),
};
```

---

## Migration

### SQL Migration

```sql
-- Step 1: Add the team_id column (nullable)
ALTER TABLE github_tokens ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;

-- Step 2: Create index for team lookups
CREATE INDEX github_tokens_team_idx ON github_tokens(team_id);
```

### Drizzle Migration

```typescript
// src/db/migrations/XXXX_add_github_token_team_id.ts
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export async function up(db: BetterSQLite3Database) {
  db.run(sql`ALTER TABLE github_tokens ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL`);
  db.run(sql`CREATE INDEX github_tokens_team_idx ON github_tokens(team_id)`);
}

export async function down(db: BetterSQLite3Database) {
  db.run(sql`DROP INDEX IF EXISTS github_tokens_team_idx`);
  // SQLite does not support DROP COLUMN directly.
  // To roll back, recreate the table without team_id.
  // In practice, this migration is forward-only.
}
```

---

## Bootstrap Behavior

During the application bootstrap phase, existing tokens are associated with a "default" team. This is handled in the schema initialization phase (Phase 2 of the 6-phase bootstrap).

### Default Team Assignment

```typescript
// Pseudocode for bootstrap migration
async function assignOrphanedGitHubTokens(db: Database) {
  // Find tokens without a team_id
  const orphanedTokens = await db
    .select()
    .from(githubTokens)
    .where(isNull(githubTokens.teamId));

  if (orphanedTokens.length === 0) return;

  // Find or create the "default" team
  let defaultTeam = await db
    .select()
    .from(teams)
    .where(eq(teams.slug, 'default'))
    .limit(1)
    .then(rows => rows[0]);

  if (!defaultTeam) {
    defaultTeam = await db
      .insert(teams)
      .values({
        name: 'Default',
        slug: 'default',
        description: 'Auto-created team for migrated resources',
      })
      .returning()
      .then(rows => rows[0]);
  }

  // Assign all orphaned tokens to the default team
  await db
    .update(githubTokens)
    .set({ teamId: defaultTeam.id })
    .where(isNull(githubTokens.teamId));

  console.log(`[bootstrap] Assigned ${orphanedTokens.length} GitHub token(s) to default team`);
}
```

---

## Token Resolution

When a project needs a GitHub token (for operations like creating PRs, reading repos, etc.), the token is resolved using the following priority chain:

### Resolution Priority

1. **Project-level override**: If the project has an explicit `githubTokenId` set, use that token.
2. **Team token**: Look up the token associated with the project's team.
3. **Global token**: Fall back to any token with `team_id IS NULL` (backward compatibility).
4. **No token**: Return an error indicating GitHub is not configured.

```typescript
// services/github-token-resolver.ts
async function resolveGitHubToken(projectId: string): Promise<GitHubToken | null> {
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then(rows => rows[0]);

  if (!project) return null;

  // 1. Project-level override
  if (project.githubTokenId) {
    const token = await db
      .select()
      .from(githubTokens)
      .where(
        and(
          eq(githubTokens.id, project.githubTokenId),
          eq(githubTokens.isValid, true)
        )
      )
      .limit(1)
      .then(rows => rows[0]);
    if (token) return token;
  }

  // 2. Team token
  if (project.teamId) {
    const token = await db
      .select()
      .from(githubTokens)
      .where(
        and(
          eq(githubTokens.teamId, project.teamId),
          eq(githubTokens.isValid, true)
        )
      )
      .limit(1)
      .then(rows => rows[0]);
    if (token) return token;
  }

  // 3. Global fallback (no team_id)
  const globalToken = await db
    .select()
    .from(githubTokens)
    .where(
      and(
        isNull(githubTokens.teamId),
        eq(githubTokens.isValid, true)
      )
    )
    .limit(1)
    .then(rows => rows[0]);

  return globalToken ?? null;
}
```

---

## UI Changes

### Project Settings

The project settings dialog gains a "GitHub Token" dropdown:

- **Label**: "GitHub Token"
- **Options**:
  - "Team default" (uses the team's token, shown as `@team-name`)
  - Each available team token listed by `githubLogin` and team name
  - "None" (no GitHub integration)
- **Behavior**: Selecting a specific token sets `project.githubTokenId`; selecting "Team default" clears the override.

### Team Settings

The team settings page gains a "GitHub" section:

- **Current Token**: Shows the GitHub login associated with the team's token, or "Not configured"
- **Add/Replace Token**: Button to add or replace the team's GitHub PAT
- **Validate**: Button to re-validate the token against the GitHub API
- **Remove**: Button to remove the team's GitHub token (with confirmation)

### Settings > GitHub (Global)

The existing global GitHub settings page shows:

- A list of all GitHub tokens across all teams
- Which team each token belongs to
- A "Global (no team)" section for legacy tokens
- An action to migrate global tokens to a specific team

---

## Backward Compatibility

The migration is designed to be fully backward compatible:

| Scenario | Behavior |
|----------|----------|
| Existing token, no `team_id` | Works as before -- treated as global token |
| New token created with `teamId` | Scoped to that team |
| Project with no team | Falls back to global token |
| Project with team but no team token | Falls back to global token |
| `team_id` team deleted | `team_id` set to NULL (ON DELETE SET NULL), token becomes global |

### API Compatibility

Existing GitHub token API endpoints continue to work:

- `GET /api/github/token` -- Returns the effective token (uses resolution chain)
- `POST /api/github/token` -- Creates a token (now accepts optional `teamId`)
- `DELETE /api/github/token` -- Deletes the token

New team-aware endpoints are added:

- `GET /api/teams/:id/github-token` -- Get the team's GitHub token info
- `PUT /api/teams/:id/github-token` -- Set/replace the team's GitHub token
- `DELETE /api/teams/:id/github-token` -- Remove the team's GitHub token
- `POST /api/teams/:id/github-token/validate` -- Validate the team's token against GitHub API

---

## Multiple Tokens Per Team

The current design allows **one token per team**. This is enforced at the application level, not the database level (no unique constraint on `team_id`). This decision enables a future extension where teams might have multiple tokens for different GitHub organizations, without requiring another migration.

In the current implementation:

- Creating a new token for a team that already has one replaces the existing token
- The UI shows a single token per team with a "Replace" action
- The token resolution logic uses `LIMIT 1` and orders by `created_at DESC` to pick the newest

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `GITHUB_TOKEN_NOT_FOUND` | 404 | No GitHub token found for team or globally |
| `GITHUB_TOKEN_INVALID` | 401 | Token failed validation against GitHub API |
| `GITHUB_TOKEN_SCOPE_INSUFFICIENT` | 403 | Token lacks required scopes (e.g., `repo`) |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](./api-endpoints.md) | Team management endpoints |
| [Tags](./tags.md) | Tags and tokens share team scope |
| [Database Schema](../application/database/schema.md) | Base `github_tokens` table definition |
| [GitHub App](../application/integrations/github-app.md) | GitHub OAuth flow and App integration |
| [Bootstrap](../application/architecture/app-bootstrap.md) | Phase 2 schema initialization runs migration |
