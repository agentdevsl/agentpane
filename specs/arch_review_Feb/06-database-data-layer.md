# 06 - Database & Data Layer Architecture Review

**Reviewer:** reviewer-6
**Date:** 2026-02-17
**Scope:** Database schema, Drizzle ORM usage, migration strategy, data access patterns, dual-DB architecture

---

## 1. Overview

AgentPane uses a **dual-dialect database architecture** built on Drizzle ORM. The primary runtime is **SQLite** (via `better-sqlite3`) for local/development use, with a parallel **PostgreSQL** schema intended for production deployments. The database layer consists of:

- **22 tables** across domain areas: projects, tasks, agents, sessions, worktrees, sandboxes, templates, terraform, CLI monitoring, workflows, and settings
- **Drizzle ORM** for type-safe schema definitions and query building
- **Dual schema directories** (`src/db/schema/sqlite/` and `src/db/schema/postgres/`) maintaining parallel table definitions
- **A hybrid migration strategy** combining Drizzle Kit-generated migrations with hand-written SQL in a bootstrap phase module

The architecture is pragmatic for a local-first agent orchestration tool but carries significant technical debt from maintaining two parallel schema definitions and an ad-hoc migration approach.

---

## 2. Schema Design

### 2.1 Table Inventory

| Table | Purpose | Primary Key | FK References |
|-------|---------|-------------|---------------|
| `projects` | Project definitions | CUID2 text | github_installations, sandbox_configs |
| `tasks` | Kanban task cards | CUID2 text | projects, agents, sessions, worktrees |
| `agents` | Agent instances | CUID2 text | projects |
| `agent_runs` | Agent execution history | CUID2 text | agents, tasks, projects, sessions |
| `sessions` | Real-time agent sessions | CUID2 text | projects, tasks, agents |
| `session_events` | Durable stream events | CUID2 text | sessions |
| `session_summaries` | Session metrics/stats | CUID2 text | sessions (1:1) |
| `worktrees` | Git worktree tracking | CUID2 text | projects, agents, tasks |
| `audit_logs` | Tool execution audit trail | CUID2 text | agents, agent_runs, tasks, projects |
| `settings` | Key-value configuration | text (key) | None |
| `api_keys` | Encrypted API keys | CUID2 text | None |
| `github_tokens` | Encrypted GitHub PATs | CUID2 text | None |
| `github_installations` | GitHub App installs | CUID2 text | None |
| `repository_configs` | GitHub repo configs | CUID2 text | github_installations |
| `templates` | Template definitions | CUID2 text | projects |
| `template_projects` | Template-project junction | Composite PK | templates, projects |
| `sandbox_configs` | Sandbox configurations | CUID2 text | None |
| `sandbox_instances` | Running sandboxes | CUID2 text | projects (1:1) |
| `sandbox_tmux_sessions` | Tmux sessions in sandbox | CUID2 text | sandbox_instances, tasks |
| `terraform_registries` | Terraform registries | CUID2 text | None |
| `terraform_modules` | Terraform modules | CUID2 text | terraform_registries |
| `marketplaces` | Plugin marketplaces | CUID2 text | None |
| `workflows` | Workflow designer graphs | CUID2 text | templates |
| `plan_sessions` | Multi-turn planning | CUID2 text | tasks, projects |
| `cli_sessions` | CLI Monitor sessions | CUID2 text | None |

### 2.2 Relationships

The schema centers around the `projects` table as the root entity. Key relationship chains:

```
projects ─┬── tasks ──── agents
           │              │
           ├── sessions ──┘
           │     │
           │     └── session_events
           │     └── session_summaries
           │
           ├── worktrees
           ├── agents ─── agent_runs
           ├── audit_logs
           ├── templates ─── template_projects
           ├── sandbox_instances ─── sandbox_tmux_sessions
           └── plan_sessions
```

Relations are defined via Drizzle's `relations()` helper in `src/db/schema/sqlite/relations.ts` (lines 1-219) and mirrored in the PostgreSQL variant.

### 2.3 ID Strategy

All tables use **CUID2** identifiers generated via `@paralleldrive/cuid2`. These are collision-resistant, URL-safe, and generated at the application layer (not the database). The `settings` table is the exception, using a natural key (`key` column) as primary key.

### 2.4 Timestamp Strategy

- **SQLite**: Timestamps stored as ISO 8601 **text** strings, defaulting to `(datetime('now'))`
- **PostgreSQL**: Timestamps stored as native `timestamp` columns with `mode: 'string'`, defaulting to `now()`
- **Application-level updates**: `updatedAt` is manually set via `new Date().toISOString()` in every service method

### 2.5 JSON Column Usage

The schema makes extensive use of JSON columns for semi-structured data:

| Table | Column | Stored Type |
|-------|--------|-------------|
| `projects` | `config` | `ProjectConfig` (worktree settings, tools, model, env vars) |
| `tasks` | `labels` | `string[]` |
| `tasks` | `diffSummary` | `DiffSummary` |
| `tasks` | `planOptions` | `StoredPlanOptions` |
| `agents` | `config` | `AgentConfig` |
| `session_events` | `data` | Arbitrary event payload |
| `templates` | `cachedSkills`, `cachedCommands`, `cachedAgents` | Typed arrays |
| `terraform_modules` | `inputs`, `outputs`, `dependencies` | Typed arrays |
| `sandbox_configs` | `allowedEgressHosts` | `string[]` |
| `sandbox_instances` | `volumeMounts`, `env` | Typed records |
| `workflows` | `nodes`, `edges`, `viewport`, `tags` | Typed graph data |
| `plan_sessions` | `turns` | `PlanTurnRecord[]` |
| `cli_sessions` | Multiple columns | Various JSON payloads |

In SQLite, these use `text('col', { mode: 'json' })` (stored as serialized strings). In PostgreSQL, core columns use native `jsonb`.

---

## 3. Drizzle ORM Usage

### 3.1 Configuration

Two Drizzle config files support the dual-dialect approach:

- **`drizzle.config.ts`** (line 1-12): SQLite configuration pointing to `src/db/schema/sqlite/index.ts`
- **`drizzle.config.pg.ts`** (line 1-11): PostgreSQL configuration pointing to `src/db/schema/postgres/index.ts`

### 3.2 Database Client Initialization

The database client (`src/db/client.ts`) dynamically selects the dialect based on the `DB_MODE` environment variable:

```typescript
const mode = getDbMode(); // 'sqlite' | 'postgres'
const db = mode === 'postgres'
  ? createPostgresDatabase()
  : drizzleSqlite(sqliteInstance, { schema: sqliteSchema });
```

Key configuration for SQLite (lines 80-82):
- `journal_mode = WAL` - Enables write-ahead logging for better concurrency
- `foreign_keys = ON` - Enforces referential integrity

### 3.3 Schema Re-exports

The main schema index (`src/db/schema/index.ts`) re-exports SQLite schema by default:
```typescript
export * from './sqlite';
```

The comment explicitly warns against using `export * as namespace` due to Drizzle ORM's `extractTablesRelationalConfig` crashing on null-prototype objects.

### 3.4 Query Patterns

Services use Drizzle's relational query API (`db.query.table.findFirst/findMany`) for reads and the builder API (`db.insert/update/delete`) for writes. Examples from `TaskService`:

```typescript
// Relational query with filter
const task = await this.db.query.tasks.findFirst({
  where: eq(tasks.id, id),
});

// Builder pattern for insert
const [task] = await this.db.insert(tasks).values({...}).returning();

// Builder pattern for update
const [updated] = await this.db.update(tasks).set({...}).where(eq(tasks.id, id)).returning();
```

### 3.5 Type Safety

Types are inferred from the schema using Drizzle's `$inferSelect` and `$inferInsert`:

```typescript
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

The `Database` type (`src/types/database.ts`, line 18) is aliased to `SqliteDatabase`, with a comment explaining that the PostgreSQL instance is cast to this type at runtime since the API surface is identical.

---

## 4. Migration Strategy

### 4.1 Drizzle Kit Migrations

Drizzle Kit generates migration files in two directories:
- `src/db/migrations/` - SQLite migrations (1 generated + 5 hand-written)
- `src/db/migrations-pg/` - PostgreSQL migrations (3 generated)

The SQLite migration journal (`src/db/migrations/meta/_journal.json`) shows only **one** entry, suggesting Drizzle Kit was used for the initial schema generation and then abandoned in favor of manual migrations.

### 4.2 Bootstrap Schema Module

The primary migration mechanism is a **hand-written SQL string** embedded in `src/lib/bootstrap/phases/schema.ts`. This file contains:

| Constant | Purpose | Lines |
|----------|---------|-------|
| `MIGRATION_SQL` | Full schema creation (CREATE TABLE IF NOT EXISTS) | 7-306 |
| `SANDBOX_MIGRATION_SQL` | Add sandbox_config_id to projects | 310-314 |
| `TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL` | Add sync interval columns to templates | 317-321 |
| `SANDBOX_K8S_MIGRATION_SQL` | Add K8s columns to sandbox_configs | 324-333 |
| `CLI_SESSIONS_MIGRATION_SQL` | Create cli_sessions table | 336-365 |
| `CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL` | Add performance_metrics column | 368-370 |
| `TERRAFORM_MIGRATION_SQL` | Create terraform tables | 373-410 |
| `SANDBOX_CONTAINER_ID_MIGRATION_SQL` | Add sandbox_container_id to sessions | 412 |
| `PERFORMANCE_INDEXES_MIGRATION_SQL` | Create performance indexes | 415-427 |

The main `MIGRATION_SQL` is executed on every startup via `CREATE TABLE IF NOT EXISTS`, making it idempotent. The additional migration constants appear to be applied separately (some via the bootstrap phase, some manually).

### 4.3 Hand-Written Migration Files

Five additional SQL migration files exist in `src/db/migrations/`:

| File | Purpose |
|------|---------|
| `0004_add_templates.sql` | Creates templates table with indexes |
| `0005_add_task_priority.sql` | ALTERs tasks to add priority column |
| `0006_add_template_sync_interval.sql` | ALTERs templates for sync interval |
| `0007_add_session_sandbox_provider.sql` | ALTERs sessions for sandbox_provider |
| `0008_add_session_summary_metrics.sql` | ALTERs session_summaries for cost/metrics |

These are **not** referenced by the Drizzle migration journal and appear to be applied via the bootstrap SQL string instead.

---

## 5. Data Access Patterns

### 5.1 Service Architecture

All services accept a `Database` type and use constructor injection:

```typescript
export class TaskService {
  constructor(private db: Database, ...) {}
}
```

This enables testing with in-memory SQLite databases.

### 5.2 Read Patterns

Services consistently use Drizzle's relational query API for reads:
- `db.query.tasks.findFirst({ where: eq(tasks.id, id) })` for single record lookups
- `db.query.tasks.findMany({ where: ..., orderBy: ..., limit, offset })` for lists
- Raw SQL via `db.select({ count: sql<number>`count(*)` }).from(table)` for aggregates

### 5.3 Write Patterns

All writes use Drizzle's builder API with `.returning()` to get the updated record:
- `db.insert(table).values({...}).returning()`
- `db.update(table).set({...}).where(eq(table.id, id)).returning()`
- `db.delete(table).where(eq(table.id, id))`

### 5.4 Transaction Usage

Transaction usage is **minimal**. Only one instance was found:

- `SettingsService.setMany()` (`src/services/settings.service.ts`, line 181): Uses `db.transaction()` to atomically upsert multiple settings with `onConflictDoUpdate`.

Multi-step operations that logically should be atomic (e.g., `TaskService.moveColumn` creating a session then updating a task) do **not** use transactions.

### 5.5 N+1 Query Pattern

`ProjectService.listWithSummaries()` (`src/services/project.service.ts`, lines 183-255) exhibits a classic N+1 query pattern:

1. Fetches all projects
2. For each project, fetches all tasks (to count by column)
3. For each project, fetches running agents
4. For each running agent, fetches current task title

This results in `2N + A` queries where N = project count and A = total running agents.

---

## 6. Dual-DB Architecture

### 6.1 SQLite (Primary)

SQLite is the default and fully supported runtime:
- File-based storage at `./data/agentpane.db` (configurable via `SQLITE_DATA_DIR`)
- In-memory mode for E2E/test environments
- WAL journaling for concurrent reads
- Foreign keys enforced via pragma

### 6.2 PostgreSQL (Secondary)

PostgreSQL support exists as a parallel implementation:
- Enabled via `DB_MODE=postgres` environment variable
- Connection string from `DATABASE_URL`
- Uses `postgres` (postgres.js) driver
- Schema uses native PostgreSQL types: `jsonb` instead of `text` for JSON, `timestamp` instead of `text` for dates, `boolean` for booleans

### 6.3 Schema Parity Issues

The dual schema directories are maintained manually and have **drift**:

- **PostgreSQL `sessions` table is missing** `sandbox_provider` and `sandbox_container_id` columns that exist in the SQLite schema (added via migration 0007 and bootstrap SQL)
- **PostgreSQL `session_summaries` table is missing** `cost_usd`, `duration_api_ms`, `cache_read_tokens`, `cache_creation_tokens`, and `stop_reason` columns (added via migration 0008)
- **PostgreSQL `cli_sessions` table** may not exist in the PG schema (no `cli-sessions.ts` was found in postgres schema directory but the index re-exports it)
- The bootstrap SQL with `MIGRATION_SQL` and all supplementary `*_MIGRATION_SQL` constants only contain SQLite dialect SQL

### 6.4 Type Unification

The `Database` type (`src/types/database.ts`) is aliased to `SqliteDatabase`, and the PostgreSQL instance is cast to this type. This works because Drizzle's runtime API is dialect-agnostic, but it means:
- TypeScript types reflect SQLite column types (text timestamps, text JSON)
- PostgreSQL-native features (jsonb operators, timestamp arithmetic) cannot be used type-safely

---

## 7. Performance

### 7.1 Index Coverage

**Explicitly defined indexes:**

| Table | Index | Type | Definition Location |
|-------|-------|------|---------------------|
| `session_events` | `session_events_session_idx` | Regular | Schema + bootstrap SQL |
| `session_events` | `session_events_offset_idx` | Composite | Schema + bootstrap SQL |
| `session_events` | `session_events_unique_offset` | Unique | Schema + bootstrap SQL |
| `cli_sessions` | `idx_cli_sessions_project` | Composite | Schema |
| `cli_sessions` | `idx_cli_sessions_status` | Regular | Schema |
| `cli_sessions` | `idx_cli_sessions_last_activity` | Regular | Schema |
| `tasks` | `idx_tasks_agent_id` | Regular | Bootstrap SQL only |
| `tasks` | `idx_tasks_kanban` | Composite | Bootstrap SQL only |
| `worktrees` | `idx_worktrees_project_id` | Regular | Bootstrap SQL only |
| `agents` | `idx_agents_project_id` | Regular | Bootstrap SQL only |
| `templates` | Multiple (4 indexes) | Various | Migration 0004 only |

**Missing indexes for common query patterns:**

- `sessions.project_id` - filtered in `listSessionsWithFilters` but no index
- `sessions.status` - filtered but no index
- `sessions.created_at` - used for date range queries and ordering
- `tasks.project_id + column` without the kanban composite - used in many service calls
- `audit_logs.project_id` - filtered in audit queries
- `audit_logs.created_at` - used for time-range queries
- `agent_runs.agent_id` - used for agent history lookups
- `agent_runs.task_id` - used for task execution history

### 7.2 Connection Management

- **SQLite**: Single process-level connection, synchronous I/O via better-sqlite3
- **PostgreSQL**: Module-level singleton via `postgres()` client, connection exposed via `pgClient` for shutdown cleanup
- No connection pooling configuration visible for PostgreSQL

### 7.3 Query Optimization

- The `DurableStreamsService.publish()` method (`src/services/durable-streams.service.ts`, lines 488-503) queries `MAX(offset)` for every published event. Under high-throughput streaming this becomes a bottleneck as it hits the database for every event.
- `ProjectService.listWithSummaries()` fetches all tasks for every project and filters in-memory rather than using SQL aggregation.

---

## 8. Findings

### DB-001: Dual Schema Maintenance Creates Drift Risk
**Severity:** High
**Description:** The SQLite and PostgreSQL schemas are maintained as separate, parallel file trees. Schema changes must be applied to both directories manually, and several columns have already drifted (e.g., `sandbox_provider`, `sandbox_container_id`, session summary metrics). This will cause runtime failures if PostgreSQL mode is activated.
**Affected Files:**
- `src/db/schema/sqlite/sessions.ts:22-23` (has `sandboxProvider`, `sandboxContainerId`)
- `src/db/schema/postgres/sessions.ts:1-27` (missing both columns)
- `src/db/schema/sqlite/session-summaries.ts:21-25` (has cost/cache metrics)
- `src/db/schema/postgres/session-summaries.ts` (likely missing these columns)
**Recommendation:** Either (a) generate the PostgreSQL schema programmatically from a single source-of-truth schema, (b) use a shared schema definition with dialect-specific overrides, or (c) drop PostgreSQL support if it is not being tested or used. Add a CI check that compares column sets between dialects.

### DB-002: Ad-Hoc Migration Strategy Lacks Versioning
**Severity:** High
**Description:** The migration strategy is fragmented across three mechanisms: (1) Drizzle Kit-generated SQL in `src/db/migrations/`, (2) hand-written migration files (0004-0008), and (3) embedded SQL constants in `src/lib/bootstrap/phases/schema.ts`. Only `MIGRATION_SQL` is executed on every startup; the supplementary `*_MIGRATION_SQL` constants are defined but their execution path is unclear. There is no migration version tracking beyond `CREATE TABLE IF NOT EXISTS` idempotency.
**Affected Files:**
- `src/lib/bootstrap/phases/schema.ts:7-306` (main migration)
- `src/lib/bootstrap/phases/schema.ts:310-427` (supplementary migrations with no clear execution)
- `src/db/migrations/meta/_journal.json:1-13` (only 1 entry)
**Recommendation:** Consolidate on a single migration strategy. Either use Drizzle Kit's migration system properly (with `drizzle-kit migrate`) or build a versioned migration runner that tracks applied migrations in a `_migrations` table. The current approach risks data loss on schema changes that are not idempotent.

### DB-003: Missing Transactions for Multi-Step Operations
**Severity:** High
**Description:** `TaskService.moveColumn()` performs multiple database operations that should be atomic: creating a session record, updating the task, and triggering an agent. If the task update fails after the session is created, an orphaned session remains. Only `SettingsService.setMany()` uses transactions.
**Affected Files:**
- `src/services/task.service.ts:321-410` (`moveColumn` - creates session then updates task without transaction)
- `src/services/task.service.ts:584-643` (`approve` - updates task, merges worktree, removes worktree without transaction)
**Recommendation:** Wrap multi-step database operations in `db.transaction()` calls. For operations that mix DB writes with external side effects (e.g., agent startup), use the "outbox pattern": write all DB changes in a transaction, then trigger side effects after commit.

### DB-004: N+1 Query in ProjectService.listWithSummaries
**Severity:** Medium
**Description:** `listWithSummaries()` fetches all projects, then for each project queries all tasks and running agents, then for each running agent queries the current task. For 10 projects with 5 running agents total, this produces ~25 queries.
**Affected Files:**
- `src/services/project.service.ts:183-255`
**Recommendation:** Replace with a single query using Drizzle's `with` clause or a raw SQL query with `GROUP BY` and `COUNT` aggregation. Alternatively, use `db.query.projects.findMany({ with: { tasks: true, agents: true } })` to eagerly load related data in fewer queries.

### DB-005: No updatedAt Auto-Update Mechanism
**Severity:** Medium
**Description:** Every service method manually sets `updatedAt: new Date().toISOString()`. This is error-prone -- if any write path misses this assignment, the timestamp becomes stale. SQLite does not support trigger-based auto-update easily, but the pattern should be centralized.
**Affected Files:**
- `src/services/task.service.ts` (7 manual `updatedAt` assignments)
- `src/services/project.service.ts` (uses `updateTimestamp()` helper -- better)
- `src/services/sandbox.service.ts` (2 manual assignments)
- `src/services/session/session-stream.service.ts` (2 manual assignments)
- `src/services/api-key.service.ts` (1 manual assignment)
**Recommendation:** Create a Drizzle middleware or wrapper function that automatically sets `updatedAt` on all `update()` calls. The `ProjectService.updateTimestamp()` pattern is a step in the right direction but should be extracted to a shared utility.

### DB-006: Legacy Alias Export Creates Confusion
**Severity:** Low
**Description:** `src/db/client.ts` line 127 exports `sqlite as pglite` with a warning comment: "Despite the name, this is the SQLite instance, not PostgreSQL." This misleading alias can cause bugs when developers assume `pglite` refers to a PostgreSQL connection.
**Affected Files:**
- `src/db/client.ts:125-127`
**Recommendation:** Remove the `pglite` alias. If consumers depend on it, rename to something unambiguous or remove after verifying no imports reference it.

### DB-007: Session Events Offset Calculation is a Performance Bottleneck
**Severity:** Medium
**Description:** `DurableStreamsService.publish()` queries `MAX(offset)` from `session_events` for every single event published. During active agent sessions that may produce hundreds of events per second, this creates a query-per-event overhead.
**Affected Files:**
- `src/services/durable-streams.service.ts:488-503`
**Recommendation:** Maintain an in-memory offset counter per stream (initialized from the database on stream creation) and increment it locally. Only fall back to the database query when the counter is not available (e.g., after a server restart).

### DB-008: Indexes Defined in Bootstrap SQL Not in Drizzle Schema
**Severity:** Medium
**Description:** Performance indexes for `tasks`, `worktrees`, and `agents` are defined in `PERFORMANCE_INDEXES_MIGRATION_SQL` as raw SQL strings but are not reflected in the Drizzle schema files. This means Drizzle Kit is unaware of them, and they may not be created in PostgreSQL deployments.
**Affected Files:**
- `src/lib/bootstrap/phases/schema.ts:415-427` (index definitions)
- `src/db/schema/sqlite/tasks.ts` (no index definitions)
- `src/db/schema/sqlite/agents.ts` (no index definitions)
- `src/db/schema/sqlite/worktrees.ts` (no index definitions)
**Recommendation:** Move index definitions into the Drizzle schema files using the table's third argument (the index/constraint callback), as already done for `session_events` and `cli_sessions`. This ensures indexes are tracked by Drizzle Kit and created for both dialects.

### DB-009: Missing Foreign Key on terraform_modules.registry_id
**Severity:** Low
**Description:** The `terraform_modules` table defines `registry_id` as a plain `text` column without a `.references()` call to `terraform_registries.id`. The Drizzle relation is defined, but the database-level FK constraint is missing.
**Affected Files:**
- `src/db/schema/sqlite/terraform.ts:43` (`registryId: text('registry_id').notNull()` -- no `.references()`)
- `src/db/schema/sqlite/relations.ts:213-218` (Drizzle relation exists)
**Recommendation:** Add `.references(() => terraformRegistries.id, { onDelete: 'cascade' })` to the column definition to enforce referential integrity at the database level.

### DB-010: Schema Test Coverage is Minimal
**Severity:** Low
**Description:** The schema test file (`src/db/schema/__tests__/schema.test.ts`) only verifies that table objects and their `id` columns are defined. It does not test column types, defaults, constraints, foreign keys, or JSON column serialization.
**Affected Files:**
- `src/db/schema/__tests__/schema.test.ts:1-59`
**Recommendation:** Add tests that verify: (a) insert/select roundtrip for each table, (b) JSON columns serialize/deserialize correctly, (c) foreign key constraints are enforced, (d) default values are applied, (e) unique constraints reject duplicates.

### DB-011: No Soft Delete Strategy
**Severity:** Low
**Description:** All delete operations use hard deletes (`db.delete(table).where(...)`) with cascade semantics. For audit-sensitive tables like `audit_logs`, `agent_runs`, and `sessions`, this means historical data can be permanently lost when parent records are deleted.
**Affected Files:**
- `src/services/task.service.ts:308-319` (hard delete)
- `src/services/project.service.ts:285-307` (hard delete with cascade)
- `src/services/session/session-crud.service.ts:215-231` (hard delete with cascade)
**Recommendation:** Consider soft deletes (a `deleted_at` timestamp column) for tables where audit history is valuable. At minimum, ensure `audit_logs` and `agent_runs` use `ON DELETE SET NULL` rather than `ON DELETE CASCADE` from the `projects` table -- `agent_runs` currently cascades on project delete, destroying run history.

### DB-012: Timestamps as Text Strings Prevent SQL Date Operations
**Severity:** Medium
**Description:** SQLite timestamps are stored as ISO 8601 text strings (e.g., `"2026-02-17T10:30:00.000Z"`). While SQLite's `datetime()` function can work with these, Drizzle's query builder does not generate dialect-appropriate comparisons for text-based dates. The `listSessionsWithFilters` method uses `gte`/`lte` on text columns, which works only because ISO 8601 is lexicographically sortable -- but this is fragile and prevents using SQLite's date functions.
**Affected Files:**
- `src/db/schema/sqlite/projects.ts:24-25` (text timestamps)
- `src/services/session/session-crud.service.ts:154-159` (gte/lte on text dates)
**Recommendation:** For SQLite, consider using Unix epoch integers for timestamps (consistent with `cli_sessions.startedAt` which already uses integer timestamps). This enables proper numeric comparisons and is more storage-efficient. Alternatively, continue with text but document the ISO 8601 sorting requirement.

### DB-013: Inconsistent Timestamp Types Across Tables
**Severity:** Medium
**Description:** Most tables use `text` for timestamps with `datetime('now')` defaults, but `cli_sessions` uses `integer` for `startedAt` and `lastActivityAt` (Unix epoch) while using `text` for `createdAt` and `updatedAt`. The `session_events` table uses `integer` for `timestamp`. This inconsistency makes it harder to write uniform queries and date comparisons across tables.
**Affected Files:**
- `src/db/schema/sqlite/cli-sessions.ts:27-28` (integer timestamps)
- `src/db/schema/sqlite/cli-sessions.ts:37-38` (text timestamps)
- `src/db/schema/sqlite/session-events.ts:19` (integer timestamp)
**Recommendation:** Standardize on one timestamp representation. If backward compatibility prevents migration, document the convention and add TypeScript helper functions that abstract the difference.

---

## 9. Summary

### Strengths

1. **Type-safe schema definitions** via Drizzle ORM with inferred TypeScript types
2. **CUID2 IDs** provide secure, collision-resistant identifiers without database sequences
3. **WAL mode and foreign keys** are correctly enabled for SQLite
4. **Comprehensive relations** defined for all table relationships
5. **Idempotent bootstrap migration** ensures schema is always up-to-date on startup
6. **Session events** have proper indexes (session + offset composite, unique offset constraint)
7. **JSON column typing** provides compile-time safety for semi-structured data
8. **Clean separation** of concerns with schema files organized by table

### Key Risks

1. **Dual-schema drift** is the highest risk -- PostgreSQL mode will fail on missing columns
2. **Lack of migration versioning** means there is no rollback capability and no way to verify which migrations have been applied
3. **Missing transactions** in multi-step operations can leave the database in inconsistent states
4. **N+1 queries** in project listing will degrade as the number of projects grows

### Priority Recommendations

| Priority | Finding | Impact |
|----------|---------|--------|
| P0 | DB-001: Schema drift between SQLite/PG | Runtime failures in PG mode |
| P0 | DB-002: Migration strategy lacks versioning | Data loss risk on upgrades |
| P1 | DB-003: Missing transactions | Inconsistent state |
| P1 | DB-008: Indexes not in Drizzle schema | Missing indexes in PG mode |
| P2 | DB-004: N+1 queries | Performance at scale |
| P2 | DB-005: Manual updatedAt | Stale timestamps |
| P2 | DB-007: Per-event offset query | Streaming performance |
| P2 | DB-012: Text timestamps | Query limitations |
| P3 | DB-006, DB-009, DB-010, DB-011, DB-013 | Code quality/correctness |
