# RBAC Migration Strategy

## Overview

This document defines how the 11 new RBAC tables and 1 table modification are introduced into existing AgentPane databases without data loss or downtime. The strategy follows the same idempotent `CREATE TABLE IF NOT EXISTS` pattern used throughout the codebase in `src/lib/bootstrap/phases/schema.ts`.

---

## Migration Approach

### Idempotent Table Creation

All new tables use `CREATE TABLE IF NOT EXISTS`, matching the existing pattern in `MIGRATION_SQL`. This means:

- **Fresh installs**: All tables are created on first startup.
- **Existing installs**: Tables that already exist are silently skipped.
- **Re-runs**: The migration can be executed any number of times without error or data loss.

The RBAC migration SQL is appended to the existing `MIGRATION_SQL` constant in `src/lib/bootstrap/phases/schema.ts`, or exported as a separate `RBAC_MIGRATION_SQL` constant and executed in sequence (following the pattern of `SANDBOX_MIGRATION_SQL`, `CLI_SESSIONS_MIGRATION_SQL`, etc.).

---

## Migration SQL

### New Constant: `RBAC_MIGRATION_SQL`

Add to `src/lib/bootstrap/phases/schema.ts`:

```typescript
export const RBAC_MIGRATION_SQL = `
-- =============================================
-- RBAC Tables - Role-Based Access Control
-- =============================================

-- Users (GitHub OAuth identities)
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

-- User sessions (server-side bearer tokens)
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "expires_at" TEXT NOT NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_sessions_user_id_idx" ON "user_sessions"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_idx" ON "user_sessions"("token");

-- Teams (organizational units)
CREATE TABLE IF NOT EXISTS "teams" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "teams_slug_idx" ON "teams"("slug");

-- Team members (user-team role assignments)
CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'viewer',
  "joined_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "team_members_user_id_idx" ON "team_members"("user_id");

-- Team projects (project-team assignments)
CREATE TABLE IF NOT EXISTS "team_projects" (
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "assigned_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("team_id", "project_id")
);

CREATE INDEX IF NOT EXISTS "team_projects_project_id_idx" ON "team_projects"("project_id");

-- Project members (per-project role overrides)
CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "granted_by_team_id" TEXT REFERENCES "teams"("id") ON DELETE SET NULL,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY ("project_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "project_members_user_id_idx" ON "project_members"("user_id");

-- Tags (team-scoped labels for filtering)
CREATE TABLE IF NOT EXISTS "tags" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "team_id" TEXT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tags_team_name_idx" ON "tags"("team_id", "name");

-- Project tags (project-tag associations)
CREATE TABLE IF NOT EXISTS "project_tags" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  PRIMARY KEY ("project_id", "tag_id")
);

-- Task tags (task-tag associations)
CREATE TABLE IF NOT EXISTS "task_tags" (
  "task_id" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "tag_id" TEXT NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  PRIMARY KEY ("task_id", "tag_id")
);

-- API tokens (programmatic access tokens)
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

-- Team invitations (pending membership invites)
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
`;
```

### ALTER TABLE Migration: `github_tokens.team_id`

Following the existing pattern (e.g., `SANDBOX_MIGRATION_SQL`), add a separate constant for the ALTER TABLE migration because SQLite does not support `IF NOT EXISTS` for `ALTER TABLE`:

```typescript
export const RBAC_GITHUB_TOKEN_MIGRATION_SQL = `
ALTER TABLE github_tokens ADD COLUMN team_id TEXT REFERENCES "teams"("id") ON DELETE SET NULL;
`;
```

---

## Execution Order

The RBAC migration executes in the `validateSchema` function in `src/lib/bootstrap/phases/schema.ts`, following the existing pattern of running idempotent migrations and wrapping ALTER TABLE statements in try/catch blocks.

```typescript
export const validateSchema = async (ctx: BootstrapContext) => {
  if (!ctx.db) {
    return err(createError('BOOTSTRAP_NO_DATABASE', 'Database not initialized', 500));
  }

  try {
    // 1. Run existing core migration (existing)
    ctx.db.exec(MIGRATION_SQL);

    // 2. Run existing ALTER TABLE migrations (existing, each in try/catch)
    try { ctx.db.exec(SANDBOX_MIGRATION_SQL); } catch { /* column already exists */ }
    try { ctx.db.exec(TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL); } catch { /* column already exists */ }
    // ... other existing migrations ...

    // 3. Run RBAC table creation (idempotent, safe to re-run)
    ctx.db.exec(RBAC_MIGRATION_SQL);

    // 4. Run RBAC ALTER TABLE migration (wrapped in try/catch for idempotency)
    try {
      ctx.db.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
    } catch {
      // Column already exists - ignore
    }

    // 5. Run default team seeding for existing github_tokens (see below)
    seedDefaultTeamForExistingTokens(ctx.db);

    // ... existing verification ...
    return ok(undefined);
  } catch (error) {
    // ... existing error handling ...
  }
};
```

**Order matters**: The `RBAC_MIGRATION_SQL` must run before `RBAC_GITHUB_TOKEN_MIGRATION_SQL` because the ALTER TABLE references the `teams` table which is created by the first migration.

---

## Default Team Creation for Existing Installations

When migrating an existing database that has `github_tokens` rows but no teams, the migration creates a default team and associates existing tokens with it.

### Seed Function

```typescript
function seedDefaultTeamForExistingTokens(db: BetterSQLite3Database): void {
  // Check if teams table is empty AND github_tokens has rows without team_id
  const teamCount = db.prepare('SELECT COUNT(*) as count FROM teams').get() as { count: number };
  const orphanedTokens = db.prepare(
    'SELECT COUNT(*) as count FROM github_tokens WHERE team_id IS NULL'
  ).get() as { count: number };

  if (teamCount.count === 0 && orphanedTokens.count > 0) {
    const defaultTeamId = createId();

    // Create the default team
    db.prepare(`
      INSERT INTO teams (id, name, slug, description, created_at, updated_at)
      VALUES (?, 'Default Team', 'default', 'Auto-created during RBAC migration', datetime('now'), datetime('now'))
    `).run(defaultTeamId);

    // Associate orphaned github_tokens with the default team
    db.prepare('UPDATE github_tokens SET team_id = ? WHERE team_id IS NULL').run(defaultTeamId);

    // Assign all existing projects to the default team
    const existingProjects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
    const insertTeamProject = db.prepare(`
      INSERT OR IGNORE INTO team_projects (team_id, project_id, assigned_at)
      VALUES (?, ?, datetime('now'))
    `);
    for (const project of existingProjects) {
      insertTeamProject.run(defaultTeamId, project.id);
    }

    console.log(`[RBAC Migration] Created default team '${defaultTeamId}' and associated ${orphanedTokens.count} GitHub token(s) and ${existingProjects.length} project(s)`);
  }
}
```

### Behavior

| Scenario | Outcome |
|----------|---------|
| Fresh install (no github_tokens) | No default team created; user creates teams via UI/API |
| Existing install with github_tokens, no teams | Default team "Default Team" created; tokens and projects associated |
| Existing install with teams already | No action (idempotent) |
| Existing install, re-run migration | No action (teams table is not empty) |

---

## Dev-Mode Backward Compatibility

In development mode (when `NODE_ENV !== 'production'` or when a `DEV_MODE` setting is present), the application should operate without requiring authentication. This ensures that existing development workflows are not disrupted by the introduction of RBAC.

### Dev User Auto-Grant

When RBAC middleware detects that no user is authenticated and dev mode is active, it synthesizes a dev user context:

```typescript
// In auth.middleware.ts
const DEV_USER: AuthContext = {
  userId: 'dev-user',
  githubLogin: 'dev',
  role: 'owner', // Full access in dev mode
  teamId: null,  // Not team-scoped
  isDevMode: true,
};

export const authMiddleware = createMiddleware(async (c, next) => {
  // Check for bearer token or session cookie
  const user = await resolveAuthFromRequest(c);

  if (user) {
    c.set('auth', user);
    return next();
  }

  // Dev mode: auto-grant owner role
  if (isDevMode()) {
    c.set('auth', DEV_USER);
    return next();
  }

  return c.json({ error: 'Unauthorized' }, 401);
});
```

### Dev Mode Detection

Dev mode is determined by the following (checked in order):

1. `process.env.NODE_ENV === 'development'`
2. The `rbac.devMode` setting in the `settings` table is `'true'`
3. No GitHub OAuth client ID is configured (indicating OAuth is not set up)

### Behavior Matrix

| Environment | Auth Required | Default Role | Teams Required |
|-------------|---------------|-------------|----------------|
| Development (no OAuth configured) | No | owner (auto-granted) | No |
| Development (OAuth configured) | Yes | Per team/project role | Yes |
| Production | Yes | Per team/project role | Yes |

---

## No Data Loss Guarantees

The migration strategy is designed to prevent data loss at every step:

### Table Creation

- `CREATE TABLE IF NOT EXISTS` never drops or modifies existing tables.
- New tables do not alter any existing table structure.
- All new foreign keys reference existing tables (`projects`, `tasks`) using `ON DELETE CASCADE` or `ON DELETE SET NULL`, which is consistent with existing FK behavior.

### Column Addition

- `ALTER TABLE github_tokens ADD COLUMN team_id` adds a nullable column. Existing rows get `NULL` for `team_id`, which is valid.
- The `DEFAULT` is not specified on the ALTER (SQLite limitation for some column types), so null is the implicit default.

### Data Seeding

- The default team creation uses `INSERT` only -- no `UPDATE` to existing data except setting the new `team_id` column on `github_tokens` (which was just added and is null).
- `INSERT OR IGNORE` on `team_projects` prevents duplicate entries on re-runs.
- No existing rows in any table are deleted or modified beyond the `team_id` backfill.

### Verification

After migration, the bootstrap phase verifies:

```typescript
// Verify RBAC tables exist
const rbacTables = ['users', 'user_sessions', 'teams', 'team_members',
  'team_projects', 'project_members', 'tags', 'project_tags',
  'task_tags', 'api_tokens', 'team_invitations'];

for (const table of rbacTables) {
  const result = ctx.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;

  if (!result?.name) {
    return err(createError(
      'BOOTSTRAP_SCHEMA_VALIDATION_FAILED',
      `RBAC table '${table}' not found after migration`,
      500
    ));
  }
}
```

---

## Rollback Strategy

If the RBAC migration needs to be rolled back, follow this procedure. Note that SQLite does not support `DROP COLUMN`, so the `github_tokens.team_id` column cannot be removed without recreating the table.

### Level 1: Disable RBAC (No Schema Changes)

The simplest rollback is to disable RBAC at the application layer without modifying the database:

1. Set `rbac.devMode` to `'true'` in the `settings` table.
2. All requests are auto-granted `owner` role via the dev user fallback.
3. RBAC tables remain in the database but are unused.
4. No data loss.

```sql
INSERT OR REPLACE INTO settings (key, value, updated_at)
VALUES ('rbac.devMode', 'true', datetime('now'));
```

### Level 2: Drop RBAC Tables (Reversible)

If a clean removal is needed, drop the RBAC tables in reverse dependency order. This loses all RBAC data (users, teams, roles, tokens, invitations) but preserves all other application data.

```sql
-- Drop in reverse dependency order
DROP TABLE IF EXISTS "task_tags";
DROP TABLE IF EXISTS "project_tags";
DROP TABLE IF EXISTS "team_invitations";
DROP TABLE IF EXISTS "api_tokens";
DROP TABLE IF EXISTS "project_members";
DROP TABLE IF EXISTS "team_projects";
DROP TABLE IF EXISTS "team_members";
DROP TABLE IF EXISTS "tags";
DROP TABLE IF EXISTS "teams";
DROP TABLE IF EXISTS "user_sessions";
DROP TABLE IF EXISTS "users";

-- Drop RBAC indexes (most are auto-dropped with tables, but explicit for safety)
DROP INDEX IF EXISTS "users_github_id_idx";
DROP INDEX IF EXISTS "users_github_login_idx";
DROP INDEX IF EXISTS "user_sessions_user_id_idx";
DROP INDEX IF EXISTS "user_sessions_token_idx";
DROP INDEX IF EXISTS "teams_slug_idx";
DROP INDEX IF EXISTS "team_members_user_id_idx";
DROP INDEX IF EXISTS "team_projects_project_id_idx";
DROP INDEX IF EXISTS "project_members_user_id_idx";
DROP INDEX IF EXISTS "tags_team_name_idx";
DROP INDEX IF EXISTS "api_tokens_hash_idx";
DROP INDEX IF EXISTS "api_tokens_user_id_idx";
DROP INDEX IF EXISTS "api_tokens_team_id_idx";
DROP INDEX IF EXISTS "api_tokens_status_idx";
DROP INDEX IF EXISTS "team_invitations_token_idx";
DROP INDEX IF EXISTS "team_invitations_team_id_idx";
DROP INDEX IF EXISTS "team_invitations_email_idx";
```

### Level 3: Remove github_tokens.team_id (Destructive)

SQLite does not support `ALTER TABLE DROP COLUMN` (prior to SQLite 3.35.0, and better-sqlite3 may or may not support it depending on the bundled SQLite version). The safe approach is to recreate the table:

```sql
-- 1. Create a new table without team_id
CREATE TABLE "github_tokens_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "encrypted_token" TEXT NOT NULL,
  "token_type" TEXT NOT NULL DEFAULT 'pat',
  "scopes" TEXT,
  "github_login" TEXT,
  "github_id" TEXT,
  "is_valid" INTEGER DEFAULT 1,
  "last_validated_at" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);

-- 2. Copy data (excluding team_id)
INSERT INTO "github_tokens_new" (id, encrypted_token, token_type, scopes, github_login, github_id, is_valid, last_validated_at, created_at, updated_at)
SELECT id, encrypted_token, token_type, scopes, github_login, github_id, is_valid, last_validated_at, created_at, updated_at
FROM "github_tokens";

-- 3. Drop old table
DROP TABLE "github_tokens";

-- 4. Rename new table
ALTER TABLE "github_tokens_new" RENAME TO "github_tokens";
```

**Warning**: Level 3 should only be used if absolutely necessary. The `team_id` column being `NULL` causes no harm when RBAC is disabled.

---

## Migration Testing Checklist

Before deploying the migration, verify the following:

- [ ] Fresh database: All 11 tables created, all indexes present
- [ ] Existing database (no RBAC tables): All 11 tables created, `github_tokens.team_id` added
- [ ] Existing database (with RBAC tables): No errors, no duplicate tables, no data changes
- [ ] Default team creation: Runs only when teams table is empty and orphaned tokens exist
- [ ] Default team creation: Assigns all existing projects to the default team
- [ ] Dev mode: Unauthenticated requests succeed with owner role
- [ ] Production mode: Unauthenticated requests return 401
- [ ] Rollback Level 1: Setting `rbac.devMode` to `'true'` bypasses auth
- [ ] Rollback Level 2: Dropping RBAC tables does not affect existing app functionality
- [ ] Bootstrap verification: All 11 RBAC tables pass the existence check

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [README.md](./README.md) | Phase overview and design decisions |
| [schema.md](./schema.md) | Table definitions referenced by this migration |
| [Bootstrap Schema](../../src/lib/bootstrap/phases/schema.ts) | Where migration SQL is executed |
| [Existing Migrations](../../src/lib/bootstrap/phases/schema.ts) | Existing migration patterns (SANDBOX_MIGRATION_SQL, etc.) |
