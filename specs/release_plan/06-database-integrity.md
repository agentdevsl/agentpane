# Database & Data Integrity Assessment

## Schema Overview

The application uses a dual-database architecture: SQLite (default, via better-sqlite3) and PostgreSQL (via postgres-js), both managed through Drizzle ORM. The schema is defined in parallel across two directories:

- `src/db/schema/sqlite/` -- 44 files using `sqliteTable()`
- `src/db/schema/postgres/` -- 44 files using `pgTable()`
- `src/db/schema/shared/` -- 3 files for enums, types, and cron-config

### Table Count: 42 tables

**Core entity tables (9):** codespaces, tasks, agents, sessions, worktrees, agent_runs, audit_logs, plan_sessions, templates

**RBAC tables (9):** users, user_sessions, teams, team_members, team_invitations, api_tokens, codespace_members, folder_members, project_folders

**Event system tables (4):** event_sources, event_subscriptions, event_log, schedule_executions

**Memory system tables (5):** memory_insights, memory_messages, skill_executions, skill_metrics, dream_sessions, skill_suggestions

**Supporting tables (remaining):** settings, sandbox_configs, sandbox_instances, sandbox_tmux_sessions, session_events, session_summaries, cli_sessions, marketplaces, workflows, terraform_registries, terraform_modules, github_installations, github_tokens, repository_configs, template_codespaces, codespace_tags, task_tags, tags, team_project_folders

### Key Design Decisions

- **IDs:** CUID2 strings via `@paralleldrive/cuid2` (collision-resistant, non-sequential)
- **Timestamps:** Text columns with `datetime('now')` defaults (SQLite) or `timestamp` with `defaultNow()` (PostgreSQL)
- **JSON columns:** `text({ mode: 'json' })` in SQLite, `jsonb` in PostgreSQL
- **Enums:** Application-level const arrays (no DB-level enums) -- validated at TypeScript level only
- **Soft delete:** Intentionally deferred (see DB-012 note in `src/db/schema/index.ts`)

## Migration Strategy

### SQLite: Inline SQL with Version Tracking

SQLite migrations are embedded as raw SQL strings in `src/lib/bootstrap/phases/schema.ts` and applied via a custom migration runner (`src/lib/bootstrap/migrations/runner.ts`).

**Mechanism:**
1. A `schema_migrations` tracking table records applied versions
2. 23 migrations (v1-v23) are defined in `src/lib/bootstrap/migrations/index.ts`
3. Each migration is either a multi-statement SQL block (`sql` property) or individual ALTER TABLE statements (`statements` property)
4. ALTER TABLE statements use try/catch for idempotency (duplicate column errors are caught)
5. Migrations run automatically on server startup and for in-memory test databases

**Strengths:**
- Idempotent design -- safe to re-run
- Version tracking prevents re-application
- Individual ALTER TABLE error handling avoids partial failure blocking

**Weaknesses:**
- Raw SQL strings in `schema.ts` must be manually kept in sync with Drizzle schema definitions
- No rollback capability
- Migrations are not wrapped in transactions (a failed multi-statement migration could leave partial state)

### PostgreSQL: Drizzle Kit Migrations

PostgreSQL uses Drizzle Kit-generated migration files in `src/db/migrations-pg/`.

**Current state:** 4 migrations (0000-0003), the last being nomad sandbox columns.

**CRITICAL ISSUE: PG migrations are severely behind.** The migrations reference `projects` table (not `codespaces`), lack RBAC tables, lack event system tables, lack memory tables, lack project_folders, and are missing 10+ migrations worth of schema changes that exist in the SQLite migration chain. A fresh PostgreSQL deployment would fail or produce a fundamentally incomplete schema.

### Schema Drift Detection

A drift checker exists at `scripts/check-schema-drift.ts` but only verifies that the same module files exist in both `sqlite/index.ts` and `postgres/index.ts`. It does **not** compare column definitions, constraints, or migration state. The Drizzle schema definitions in `src/db/schema/postgres/*.ts` are up-to-date (they reference `codespaces`, have correct columns), but the actual SQL migrations that would create these tables in PostgreSQL are stale.

## Data Validation

### API Layer (Zod Schemas)

Input validation is centralized in `src/server/validation.ts` with comprehensive Zod schemas:

- **Task creation/update:** Title length (1-500), description (max 10k), labels (max 20 items, 50 chars each), skillId regex validation
- **Agent creation:** Name (1-200), codespaceId validated as safe identifier
- **ID parameters:** Regex-validated (`/^[a-zA-Z0-9_-]+$/`, max 100 chars)
- **Team/RBAC:** Email validation, slug format, role enums
- **All body parsing** goes through `parseJsonBody()` which catches SyntaxError for malformed JSON

68 validation points found across 21 route files.

### Service Layer

Services perform business-rule validation:
- **TaskService.create:** Verifies codespace exists before task creation
- **TaskService.moveColumn:** Uses `canTransition()` state machine validation for column moves
- **CodespaceService.delete:** Checks for running agents before deletion
- **AgentExecutionService.start:** Validates state machine transitions, checks concurrency limits

### Database Layer

- **Foreign keys:** Enabled via `PRAGMA foreign_keys = ON` in SQLite client setup
- **Unique constraints:** `codespaces.path`, `session_events(session_id, offset)`, `teams.slug`, `users.github_id`, `api_keys.service`
- **NOT NULL constraints:** Applied on essential fields (id, codespaceId, name, title, status, createdAt, updatedAt)

### Gap: No Enum Validation at DB Level

Enum values (TaskColumn, AgentStatus, WorktreeStatus, etc.) are defined as TypeScript const arrays but not enforced at the database level. Invalid enum values could be inserted via raw DB access or bugs in service code. SQLite lacks native enum types, so this would require CHECK constraints.

## Transaction Safety

### Well-Protected Operations (16 transaction usages found)

The codebase uses `db.transaction()` appropriately for multi-step mutations:

1. **TaskService.create** -- Position calculation + insert (prevents race conditions)
2. **TaskService.moveColumn** -- Session creation + task column update (prevents orphans)
3. **AgentExecutionService.start** -- Task update + agent update + agent_run insert (atomic state change with cleanup on failure)
4. **Teams.create** -- Slug uniqueness check + insert + owner membership (TOCTOU prevention)
5. **Teams.transferOwnership** -- Verify target + swap roles
6. **Teams.delete** -- Verify team + cascade
7. **TeamMembers add/update/remove** -- Check-then-act patterns
8. **TeamInvitations.create** -- Duplicate check + insert
9. **Invitation accept** -- Claim invitation + create membership
10. **CodespaceMembers.add** -- Duplicate check + insert
11. **SettingsService.setBatch** -- Multiple settings upserts
12. **TerraformRegistry.delete** -- Delete modules + registry + settings
13. **RbacTokenService.create** -- Name uniqueness + insert
14. **Me.updateProfile** -- Email uniqueness check + update

### Gap: Non-Transactional Multi-Step Operations

**AgentExecutionService.start cleanup:** When the transaction fails after worktree + session creation, only the worktree is cleaned up (with a catch block). The session created via `sessionService.create()` is not cleaned up on transaction failure. While sessions will eventually cascade-delete with the codespace, orphaned sessions could accumulate.

**CodespaceService.delete:** Calls `worktreeService.prune(id)` before `db.delete(codespaces)`. If the worktree prune fails, the delete does not proceed. However, if the worktree prune succeeds but the DB delete fails, worktrees are orphaned on disk.

**Task.delete:** Does not use a transaction. Cascade deletes handle DB consistency, but any external resources (worktrees on disk) associated with the task are not cleaned up.

## Backup & Recovery

### SQLite Backup

`scripts/backup-db.sh` provides a solid backup mechanism:
- WAL checkpoint before copy (ensures data flush)
- Timestamped backup files
- Automatic cleanup (retains last 7 backups)
- Configurable DB path and backup directory

**Limitations:**
- Manual invocation only -- no cron/scheduled automation
- No point-in-time recovery
- No backup verification (integrity check)
- No remote backup support

### PostgreSQL Backup

**No automated backup exists.** No `pg_dump` script, no WAL archiving configuration, no backup documentation for PostgreSQL deployments.

### Data Retention

`EventCleanupService` handles retention:
- Session events: 30 days default
- Event log: 90 days default
- Configurable via admin settings
- Batch deletion (1000 rows per batch) to avoid lock contention
- Runs every 24 hours with 60-second initial delay

## Dual Database Concerns

### Critical: PostgreSQL Migration Gap

The PostgreSQL migrations (`src/db/migrations-pg/`) are frozen at a pre-codespace-rename state:

| Feature | SQLite Migration | PG Migration |
|---------|-----------------|--------------|
| Base schema | v1 | 0000 |
| Sandbox config column | v2 | Missing |
| Template sync columns | v4 | Missing |
| RBAC tables | v9-v12 | **Missing** |
| Event system | v16-v17 | **Missing** |
| Project folders + codespace rename | v19-v20 | **Missing** |
| Task skill columns | v21 | **Missing** |
| Memory tables | v22 | **Missing** |
| GitHub App columns | v23 | **Missing** |

The PG Drizzle schema files (`src/db/schema/postgres/*.ts`) are correctly updated (they reference `codespaces`, not `projects`), but `drizzle-kit generate` has not been run to produce the corresponding SQL migrations since migration 0003.

**Impact:** Setting `DB_MODE=postgres` and running against a fresh database would:
1. Create tables using the stale PG migration SQL (still using `projects` table name)
2. Drizzle ORM would try to query `codespaces` table which doesn't exist
3. Application would crash on any database operation

### Schema Parity Issues

Even where both schemas are defined, there are minor inconsistencies:

1. **session_events index:** SQLite removed redundant `session_events_offset_idx` (DB-008) but PostgreSQL schema still defines it
2. **session_summaries columns:** SQLite bootstrap SQL includes `cost_usd`, `duration_api_ms`, `cache_read_tokens`, `cache_creation_tokens`, `stop_reason` columns that are not in the PG schema definition
3. **sandbox_configs FK on codespaces:** `codespaces.sandboxConfigId` references `sandboxConfigs.id` without `onDelete` in both schemas -- deleting a sandbox config while codespaces reference it will fail with a FK violation

### Drift Checker Limitations

The `scripts/check-schema-drift.ts` only checks that both index files export the same module names. It does not:
- Compare column definitions between SQLite and PostgreSQL schemas
- Verify that PG migrations produce the same effective schema as SQLite migrations
- Check for missing constraints or indexes

## Critical Issues

### 1. PostgreSQL is Not Production-Ready (CRITICAL)

The PG migration chain is 19 migrations behind SQLite. A PostgreSQL deployment would fail immediately. This blocks any production deployment using PostgreSQL.

### 2. Missing `onDelete` on `codespaces.sandboxConfigId` (HIGH)

Both SQLite and PostgreSQL schemas define `sandboxConfigId` without an `onDelete` clause:
```typescript
sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id)
```
Deleting a sandbox config that is referenced by any codespace will cause a foreign key violation error. Should be `onDelete: 'set null'`.

### 3. Migration Runner Not Transactional (MEDIUM)

The SQLite migration runner applies each migration's statements individually without wrapping the entire migration in a transaction. A partially-applied migration (e.g., crash between ALTER TABLE statements) could leave the database in an inconsistent state. The version would not be recorded, but some columns might already be added.

### 4. No Enum Validation at Database Level (MEDIUM)

All enum-typed columns (`column`, `status`, `type`, `priority`, `role`) accept any text value at the DB level. While TypeScript types provide compile-time safety, runtime bugs or direct DB access could insert invalid values. SQLite CHECK constraints could enforce this.

### 5. Orphaned Session on Agent Start Failure (LOW)

When `AgentExecutionService.start()` creates a session (via `sessionService.create()`) but the subsequent transaction fails, the session is not cleaned up. The worktree cleanup exists but no corresponding session cleanup.

### 6. Disk Resource Cleanup on Task/Codespace Delete (LOW)

Cascade deletes handle DB consistency, but worktree directories on disk may become orphaned if the `prune()` call is skipped or fails silently.

## Recommendations

### Priority 1: Fix PostgreSQL Migration Gap (Effort: 3-5 days)

1. Run `drizzle-kit generate` against the current PG schema to produce new migration files
2. Create a migration that renames `projects` -> `codespaces` and all FK columns
3. Add all missing tables (RBAC, events, memory, project_folders, etc.)
4. Test the full migration chain from scratch on a clean PostgreSQL database
5. Add a CI check that verifies PG migrations are current

### Priority 2: Add `onDelete: 'set null'` to sandboxConfigId (Effort: 1 hour)

Update both `src/db/schema/sqlite/codespaces.ts` and `src/db/schema/postgres/codespaces.ts`:
```typescript
sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id, { onDelete: 'set null' })
```
Add a SQLite migration (v24) with: `-- handled at schema level, no SQL needed for existing data`

### Priority 3: Wrap Migration Runner in Transactions (Effort: 2 hours)

Modify `src/lib/bootstrap/migrations/runner.ts` to wrap each migration in a SQLite transaction:
```typescript
db.prepare('BEGIN').run();
try {
  applyMigration(db, migration);
  recordMigration.run(migration.version, migration.name);
  db.prepare('COMMIT').run();
} catch (e) {
  db.prepare('ROLLBACK').run();
  throw e;
}
```

### Priority 4: Enhance Schema Drift Checker (Effort: 1-2 days)

Extend `scripts/check-schema-drift.ts` to:
- Compare column names and types between SQLite and PG schema definitions
- Verify FK constraint parity (onDelete behavior)
- Check index parity
- Run as part of CI

### Priority 5: Automate SQLite Backups (Effort: 2 hours)

Add a configurable cron/interval to run the existing backup script. Options:
- Add to the `EventCleanupService` (which already runs on a 24-hour interval)
- Add a `backup.intervalHours` setting
- Add backup integrity verification via `PRAGMA integrity_check`

### Priority 6: Add PostgreSQL Backup Script (Effort: 4 hours)

Create `scripts/backup-db-pg.sh` that:
- Uses `pg_dump` with `--format=custom` for compression
- Supports `DATABASE_URL` from environment
- Implements rotation (keep last N backups)
- Documents WAL archiving setup for point-in-time recovery

### Priority 7: Add CHECK Constraints for Enums (Effort: 1 day)

Add SQLite CHECK constraints in a new migration for critical enum columns:
```sql
-- Example for tasks.column
ALTER TABLE tasks ADD CONSTRAINT chk_task_column
  CHECK (column IN ('backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'));
```
Note: SQLite does not support ALTER TABLE ADD CONSTRAINT, so this would require table recreation or be enforced only for new databases.

### Priority 8: Clean Up Orphaned Session on Agent Failure (Effort: 1 hour)

In `AgentExecutionService.start()`, add session cleanup in the catch block alongside the existing worktree cleanup:
```typescript
await this.sessionService.delete(session.value.id).catch(cleanupErr => { ... });
```

### Priority 9: Add Integration Test for PG Schema (Effort: 1-2 days)

Create a test that:
1. Runs all PG migrations against a test PostgreSQL database
2. Verifies all tables exist with expected columns
3. Runs a subset of CRUD operations via Drizzle
4. Add to CI as a separate test job (requires PG service container)
