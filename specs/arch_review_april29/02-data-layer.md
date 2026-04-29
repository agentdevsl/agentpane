# 02 — Data Layer (April 29 Review)

## Summary

Re-review of the data layer at HEAD `25c1c4f0`. The April PRs (#176/#178/#179) materially closed three of the prior P1 findings (F02-01 migration parity, F02-02 schema-drift coverage for 49 tables, F02-05 PG pool config, F02-13 PG migration safety test) but introduced new gaps and several P0 issues remain unaddressed. The biggest unresolved problem is that 61 service/route files import directly from `src/db/schema/sqlite/`, and several services issue **SQLite-specific raw SQL** (`json_set`, `json_extract`, `datetime('now')`, `PRAGMA wal_checkpoint`) on the dual-dialect `Database` type. With `DB_MODE=postgres` set, the scheduler, event-cleanup, and session-stream services would fail at runtime — yet the F02-13 PG safety test only verifies migrations and column shape, not query compatibility. F02-05's PG pool config fix landed in `src/server/bootstrap/phases/database.ts` but two **other** Postgres clients (`src/db/client.ts:94`, `src/lib/bootstrap/phases/postgres.ts:21`) still use the unconfigured `postgres(connectionString)` form. JSON column parity is incomplete: `event_outbox.payload` is `text` in SQLite vs `jsonb` in PG, `event_outbox.next_attempt_at` is `text` vs `timestamptz`, and CLI sessions has 6 untyped JSON-as-text columns in SQLite (`pendingToolUse`, `tokenUsage`, `performanceMetrics`, `topology`, `queueOperations`, `toolInvocations`) that bypass Drizzle's marshalling. Drift coverage now spans 49 tables but the auto-generator only checks **column existence**, not types — so `text` vs `jsonb`, `integer` vs `boolean`, `text` vs `timestamptz` mismatches are silently accepted. Two findings from prior review are confirmed open: F02-04 (3 unsafe casts still present), F02-11 (codespace.delete still not transactional). One real bug surfaced by drift suite was acknowledged but never fixed: `codespace_tags.assigned_at` is missing from the SQLite schema (`v19-project-folders.ts:84-88` doesn't add the column).

## Map

| Area | Files | Purpose |
| --- | --- | --- |
| Schema definitions (dual) | `src/db/schema/sqlite/*.ts` (47 modules) · `src/db/schema/postgres/*.ts` (47 modules) · `src/db/schema/shared/{enums,types,cron-config}.ts` | Drizzle tables, kept in parallel; index.ts re-exports |
| Database bootstrap | `src/server/bootstrap/phases/database.ts:62-132` (primary server) · `src/lib/bootstrap/phases/postgres.ts:10-57` (legacy bootstrap) · `src/db/client.ts:36-117` (worker/CLI) | WAL pragmas, drizzle wiring, PG client init |
| SQLite migrations (inline runtime) | `src/lib/bootstrap/migrations/index.ts` (32 versions, ends at v32) · `runner.ts:36-104` · `v19-project-folders.ts` | Ordered SQL with `schema_migrations` tracking |
| Drizzle-kit migrations (SQLite) | `src/db/migrations/` (16 SQL files: 0000, 0004–0018) | **Vestigial** — never applied at runtime; only consumed by `scripts/check-migration-parity.ts` |
| Drizzle-kit migrations (PG) | `src/db/migrations-pg/` (13 SQL files: 0000–0012, plus 0004 mega-catchup) | Applied via `migratePg()` at runtime |
| Drift / parity tests | `tests/integration/schema-drift-all-tables.test.ts` (49 auto cases, 10 high-churn) · `migration-parity.test.ts` · `pg-migration-safety.test.ts` (gated) · `pg-schema.test.ts` (static) · `agents-schema-drift.test.ts` · `session-schema-drift.test.ts` | Coverage now ≥30 tables; type checks absent |
| Schema-drift script | `scripts/check-schema-drift.ts:62-360` | Compares column **names** + onDelete + index names; **does not** compare column types |
| Migration parity script | `scripts/check-migration-parity.ts` | Compares SQLite drizzle-kit folder vs PG; SQLite drizzle-kit folder is vestigial — script protects against ghosts |
| Raw SQL hotspots (SQLite-only) | `src/services/scheduler.service.ts:153,242-248,392-398,656-661,711-716,738-740,808-815,848-859` (json_set, json_extract, datetime('now')) · `src/services/event-cleanup.service.ts:236` (PRAGMA wal_checkpoint) · `src/services/session/session-stream.service.ts:244-252` (datetime('now') in INSERT) · `src/server/routes/memory.ts:326` (json_extract) | PG-incompatible queries |
| Direct SQLite-dialect imports | 61 sites in `src/services/`, `src/server/routes/`, `src/server/bootstrap/` | Services bind to SQLite table objects regardless of `DB_MODE` |
| Unsafe casts | `src/services/container-agent/plan-approval.service.ts:223,500,511` · `container-exec.service.ts:1219` | `as unknown as TaskPlanRow` etc. |
| Uncached JSON.parse calls | 47 sites across `src/services/` and `src/server/` | Settings, payloads, scope tags, plan options |
| Transaction usage | 6 services use `db.transaction`: `task.service.ts:397,600`, `settings.service.ts:233`, `rbac-token.service.ts:108`, `terraform-registry.service.ts:237`, `agent/agent-execution.service.ts:437` | Most multi-step delete chains still non-transactional |

## What's working

- **Migration parity check** (`scripts/check-migration-parity.ts`) blocks new SQLite drizzle-kit migrations without a matching PG migration; the integration test exercises it (`tests/integration/migration-parity.test.ts`).
- **Schema-drift suite** auto-generates 49 cases from `src/db/schema/sqlite/index.ts`, including 10 dedicated high-churn cases (`schema-drift-all-tables.test.ts:123-134`).
- **PG migration-safety test** (`tests/integration/pg-migration-safety.test.ts`) — gated by `POSTGRES_INTEGRATION=true`, runs the full PG migration chain and asserts every Drizzle column exists. Surfaced and fixed 7 missing columns (PG migrations 0010, 0011).
- **PG pool config** for the primary bootstrap path: `src/server/bootstrap/phases/database.ts:79-92` reads `POSTGRES_MAX`, `POSTGRES_IDLE_TIMEOUT`, `POSTGRES_MAX_LIFETIME`, `POSTGRES_CONNECT_TIMEOUT`, `POSTGRES_APPLICATION_NAME`, `POSTGRES_SSL` via a typed schema.
- **FK-safe rebuilds**: v29/v30 still null orphaned FK references before rebuild (`src/lib/bootstrap/migrations/index.ts:295-296,328-329`).
- **Trigger-based enum validation** retained for `tasks.column`, `agents.status`, `worktrees.status`, `agents.type`, `tasks.priority`.
- **Outbox pattern** (`event_outbox`) introduced (v32 / PG 0012) for transactional durable-stream publishes — addresses dual-write race.
- **Atomic offset insert** in `session_events` (`session-stream.service.ts:244-252`) — eliminates the prior read-then-write race.
- **Pre-commit drift check** runs `bun run scripts/check-schema-drift.ts` which now compares onDelete and index definitions across both dialects (passes at HEAD).

## Findings

### F02-15: Services issue SQLite-specific SQL on the dual-dialect `Database` type — PG mode is broken
- **Priority**: P0
- **Observation**: The `Database` type alias is `BetterSQLite3Database<typeof sqliteSchema>` regardless of mode (`src/types/database.ts:14-18`), and 61 service/route files import directly from `src/db/schema/sqlite/*` (`grep -c` confirms). Several services issue **SQLite-only SQL** that PostgreSQL does not support:
  - `src/services/scheduler.service.ts:153` — `sql\`json_extract(${eventSources.config}, '$.nextRunAt') <= ${now}\``
  - `src/services/scheduler.service.ts:240-248` — `UPDATE event_sources SET config = json_set(json_set(config, '$.nextRunAt', ${...}), '$.lastRunAt', ${...}), updated_at = datetime('now')`
  - `src/services/scheduler.service.ts:390-399, 656-661, 711-716, 738-740, 808-815, 848-859` — same pattern (12 sites)
  - `src/services/event-cleanup.service.ts:236` — `this.db.run(sql\`PRAGMA wal_checkpoint(TRUNCATE)\`)` (SQLite-only PRAGMA)
  - `src/services/session/session-stream.service.ts:244-252` — `datetime('now')` literal inside an `INSERT...SELECT`
  - `src/server/routes/memory.ts:326` — `sql\`json_extract(${sessionEvents.data}, '$.insightIds') LIKE ${...}\``
- **Risk**: With `DB_MODE=postgres`, every cron tick raises `function json_set(jsonb, text, text) does not exist` (or similar). The `event-cleanup` background job throws on every wakeup. Memory route returns 500. The F02-13 PG safety test exercises **migrations only** — it never executes any service code, so this regression is invisible to CI.
- **Recommendation**:
  1. Replace `json_set`/`json_extract` with Drizzle's portable JSON helpers — for `eventSources.config`, denormalise `nextRunAt`, `lastRunAt`, `consecutiveErrors`, `pausedAt` into top-level columns (most are scalars and indexable). The current JSON-stuffing of scheduling state was an anti-pattern.
  2. Replace `datetime('now')` literals with `new Date().toISOString()` from JS or use Drizzle's `sql\`CURRENT_TIMESTAMP\`` (portable).
  3. Gate `PRAGMA wal_checkpoint` and the SQLite backup logic behind a `dbMode === 'sqlite'` check; have the PG path emit `pg_dump` or skip with a no-op.
  4. Add a CI job that runs the existing test suite under `DB_MODE=postgres` against a Docker Postgres so service-layer queries are actually executed against PG. The current PG safety test is necessary but not sufficient.
- **Effort**: L (scheduler refactor is the bulk; fixing date/PRAGMA is XS each)
- **Links**: prior F02-13 closed the migration test gap, but query-compat gap was never enumerated.

### F02-16: SQLite ↔ Postgres column-type drift goes undetected by `check-schema-drift.ts`
- **Priority**: P1
- **Observation**: `scripts/check-schema-drift.ts:201-204` only inspects column **names** via the regex `(?:text|integer|real|blob|jsonb|timestamp|boolean|...)\s*\(\s*['"]([^'"]+)['"]`. The first capture group is the DB column name (e.g. `'col_name'`); the type token itself (`text` vs `jsonb`, `integer` vs `boolean`, `text` vs `timestamp`) is matched but never compared. The script reports "passed" at HEAD despite the following type mismatches being live in `src/db/schema/`:
  - `event_outbox.payload`: SQLite `text({ mode: 'json' })` vs PG `jsonb` (`src/db/schema/sqlite/event-outbox.ts:30` vs `postgres/event-outbox.ts:26`)
  - `event_outbox.next_attempt_at`, `created_at`, `published_at`: SQLite `text` (with default `datetime('now')`) vs PG `timestamp({ withTimezone: true })` (`sqlite/event-outbox.ts:38,41,42` vs `postgres/event-outbox.ts:31-36`)
  - `cli_sessions` JSON-as-text columns: SQLite uses plain `text(...)` for `pendingToolUse`, `tokenUsage`, `performanceMetrics`, `topology`, `queueOperations`, `toolInvocations` (`sqlite/cli-sessions.ts:23-25,39-41`) — no `{ mode: 'json' }` annotation, so Drizzle does NOT auto-marshal; the calling code must `JSON.stringify`/`JSON.parse` manually. PG uses the same `text` (not `jsonb`) for these so reads round-trip OK, but the mismatch with the `mode: 'json'` convention used elsewhere is a footgun.
  - `session_events.timestamp`: SQLite `integer` vs PG `bigint({ mode: 'number' })` — runtime values fit in JS number, but PG's bigint can hold 2^63 while SQLite's integer is 2^63 too, so functionally OK but the type tokens differ.
- **Risk**: Future PRs adding new columns can introduce silent type mismatches that the parity script blesses. JSON columns marked `text` without `{ mode: 'json' }` create a footgun where one dialect transparently parses while the other returns string — bugs surface only on backend switch.
- **Recommendation**: Extend `check-schema-drift.ts` to extract the type token and assert per-column type compatibility against an allowed-pair map, e.g.:
  ```ts
  const COMPAT: Record<string, string[]> = {
    'text': ['text'],
    'text-json': ['jsonb'],          // sqlite text({ mode: 'json' }) ≡ pg jsonb
    'integer-boolean': ['boolean'],   // sqlite integer({ mode: 'boolean' }) ≡ pg boolean
    'text-timestamp': ['timestamp'],  // sqlite text iso8601 ≡ pg timestamp
    'integer': ['integer', 'bigint'],
    'real': ['doublePrecision', 'numeric'],
  };
  ```
  Audit the existing schema against this matrix and remediate the `event_outbox` divergences specifically — either align SQLite to use a `text({ mode: 'json' })` payload that Drizzle marshals, or align PG to keep `text` for `next_attempt_at` (less elegant; first option is preferred).
- **Effort**: M
- **Links**: extends F02-10 from prior review.

### F02-17: Two of the three Postgres clients still use unconfigured `postgres(connectionString)`
- **Priority**: P1
- **Observation**: F02-05 was scoped only to `src/server/bootstrap/phases/database.ts:80-92`. Two other PG client constructors lag:
  - `src/db/client.ts:94` — `pgClientInstance = postgres(connectionString)` (no options)
  - `src/lib/bootstrap/phases/postgres.ts:21` — `client = postgres(connectionString)` (no options)
  Both are real runtime paths: `db/client.ts` is consumed by the tanstack-start route loaders (browser-stub fallback in `src/lib/vite-stubs/browser-stubs.ts:292`); `lib/bootstrap/phases/postgres.ts` is the legacy bootstrap path used by some test helpers and the older `BootstrapContext` flow. Defaults: `max: 10`, `idle_timeout: 0` (no idle close), no `application_name`, no SSL toggle.
- **Risk**: Production deployments that route through either path get the unconfigured client — pool depth pinned to 10, no idle reaping, no SSL enforcement, no observability via `application_name` in `pg_stat_activity`.
- **Recommendation**: Either:
  - Centralise PG client creation in a single helper `createPgClient(config: ServerConfig['postgres'])` and have all three callers use it, **or**
  - Remove the legacy paths if they're truly unused (`db/client.ts` looks like dead code on the server — confirm via knip or grep, then delete).
- **Effort**: S
- **Links**: extends F02-05 (now-closed) — fix landed but only at one of three sites.

### F02-18: `event_outbox` JSON/timestamp drift between SQLite and PG produces brittle reads/writes
- **Priority**: P1
- **Observation**: Per F02-16, the schema for `event_outbox` diverges:
  - `payload`: `text({ mode: 'json' })` vs `jsonb` — Drizzle auto-marshals on both, so functionally OK
  - `nextAttemptAt`, `createdAt`, `publishedAt`: `text` (ISO string) vs `timestamp({ withTimezone: true })` — Drizzle `lte(eventOutbox.nextAttemptAt, now)` with `now = new Date().toISOString()` works on SQLite (string lex compare) but on PG postgres-js will coerce the JS string to `timestamptz`; cross-DB latency / DST behavior diverges.
  - `EventOutboxRelayService` imports `eventOutbox` only from `src/db/schema/sqlite/event-outbox.js` (`event-outbox-relay.service.ts:23`). When `DB_MODE=postgres`, the runtime `db` is the PG client but Drizzle is using the SQLite table object. Drizzle's runtime mostly tolerates this because the table name + column names match, but the `$inferSelect` row type's `payload` is `Record<string, unknown>` for PG and `Record<string, unknown>` for SQLite (both via `$type`) — same. Risk surfaces if a future migration changes one but not the other.
- **Risk**: Time comparisons (`lte(nextAttemptAt, now)`) are not provably equivalent across dialects; ISO-string lex sort works for UTC but breaks for any timezone-stamped string. The relay's polling correctness depends on this.
- **Recommendation**: Convert SQLite `event_outbox.next_attempt_at` / `created_at` / `published_at` to `integer({ mode: 'timestamp_ms' })` (epoch ms). Drizzle round-trips this as `Date`. Then change PG to also use `bigint({ mode: 'number' })` epoch ms (matches the existing `session_events.timestamp` precedent — established in PG 0002). This makes the relay `lte()` comparison numeric on both sides. Drop the `withTimezone` PG column entirely. Will require a data migration on existing rows (epoch ms can be derived from the current ISO/timestamp values).
- **Effort**: M

### F02-19: `codespace_tags.assigned_at` declared `notNull()` but never created in SQLite
- **Priority**: P1
- **Observation**: `src/db/schema/sqlite/codespace-tags.ts:15` declares `assignedAt: text('assigned_at').default(sql\`(datetime('now'))\`).notNull()`. The v19 inline migration creates the table without this column (`v19-project-folders.ts:84-88`):
  ```sql
  CREATE TABLE IF NOT EXISTS codespace_tags (
    codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (codespace_id, tag_id)
  );
  ```
  No subsequent migration adds `assigned_at`. The drift test acknowledges this with `EXPECTED_MISSING_COLUMNS.codespace_tags = new Set(['assigned_at'])` (`schema-drift-all-tables.test.ts:79`). On a real SQLite DB, `INSERT` succeeds because the application never sets the column explicitly (Drizzle generates a value via the JS-side default), but `SELECT` returns the column as `undefined` from the DB even though Drizzle's type system says `string`. Postgres has the column (created in 0004 catchup), so the row shape diverges by backend.
- **Risk**: Tests assume both backends return the same shape; type system is lying. The "TODO" comment in the test file is at risk of becoming permanent. Future code that filters by `assignedAt` works on PG but returns no results on SQLite.
- **Recommendation**: Add migration v33: `ALTER TABLE codespace_tags ADD COLUMN assigned_at TEXT NOT NULL DEFAULT (datetime('now'))` and a parity PG migration `0013_add_codespace_tags_assigned_at.sql` (no-op on PG since column already exists, `ADD COLUMN IF NOT EXISTS` keeps the parity check happy). Then remove the `EXPECTED_MISSING_COLUMNS` entry.
- **Effort**: XS

### F02-20: SQLite `api_tokens.scope_codespace_id` has `ON DELETE CASCADE`, Drizzle and PG have `SET NULL`
- **Priority**: P1
- **Observation**: SQLite migration v19 line 149: `ALTER TABLE api_tokens ADD COLUMN scope_codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`. PG `0004_schema_catchup.sql:328`: `"scope_codespace_id" text REFERENCES "codespaces"("id") ON DELETE SET NULL`. Drizzle schema declares `onDelete: 'set null'` in both `sqlite/api-tokens.ts:25` and `postgres/api-tokens.ts:23`. So on a real SQLite DB, deleting a codespace **CASCADE deletes** the scoped API token (revoking access entirely); on PG, it nulls the scope (token becomes a global-scope token). The drift script doesn't compare FK behavior of inline ALTER TABLE migrations — it only reads the Drizzle TypeScript declarations.
- **Risk**: Operationally surprising and silently divergent. Deleting a codespace in production SQLite revokes API tokens that the user expected to survive.
- **Recommendation**: SQLite cannot rewrite FK behavior in place. Add migration v34 that rebuilds `api_tokens` with the correct `ON DELETE SET NULL` (full table-rebuild pattern, parity with v29/v30). Use `INSERT INTO api_tokens_new SELECT ...` (drop `OR IGNORE` per F02-08). Verify the FK behavior matches the Drizzle declaration.
- **Effort**: M

### F02-21: Migration runner still swallows "duplicate column" errors via fragile string matching
- **Priority**: P2
- **Observation**: `src/lib/bootstrap/migrations/runner.ts:41-47, 53-60` — unchanged from prior review. The `try { ... } catch (e) { if (!msg.includes('duplicate column')) throw e }` pattern remains. Bun:sqlite and better-sqlite3 both happen to produce error messages with `duplicate column` substring today, but a binding upgrade could break this (e.g., `column already exists`, `SQLITE_ERROR_DUPLICATE`). If the substring stops matching, real "duplicate column" errors propagate instead of being silently absorbed; conversely, a different idempotent error could be masked.
- **Risk**: Migration idempotency is contractual; relying on error-message substring is fragile.
- **Recommendation**: For each `statements`-style migration, pre-check column existence: `SELECT 1 FROM pragma_table_info('table') WHERE name = ?` and skip if present. Drop the catch entirely. For multi-statement `sql` blocks, decompose into the same pre-check pattern. Net code increase is small.
- **Effort**: M
- **Links**: F02-07 from prior review — confirmed unfixed.

### F02-22: `INSERT OR IGNORE` still in v29/v30 table rebuilds without row-count parity check
- **Priority**: P2
- **Observation**: `src/lib/bootstrap/migrations/index.ts:311, 344` — `INSERT OR IGNORE INTO agents_new SELECT ... FROM agents`. The `OR IGNORE` clause swallows PRIMARY KEY collisions, NOT NULL violations, and CHECK failures silently. There is no `SELECT COUNT(*)` parity assertion before/after.
- **Risk**: If v29 or v30 are ever rerun against a corrupted shape (or a future Drizzle change introduces a new NOT NULL), rows get silently dropped. Users see "agents missing" only at query time.
- **Recommendation**: Drop `OR IGNORE`. The preceding `UPDATE ... SET col = NULL WHERE col NOT IN (SELECT id FROM parent_table)` lines already handle the orphaned-FK case. Add explicit `SELECT COUNT(*) FROM agents` before the rebuild, then assert `agents_new` has the same count after `INSERT INTO`. Throw if mismatch.
- **Effort**: S
- **Links**: F02-08 from prior review — confirmed unfixed.

### F02-23: 47 raw `JSON.parse(row.value)` calls bypass Zod validation; settings table values still untyped
- **Priority**: P2
- **Observation**: `grep` finds 47 raw `JSON.parse` calls in `src/services/` and `src/server/`. Hot offenders:
  - `settings.service.ts:43,70,289` (`getValue<T>`, `getGlobalDefaultModel`, `getAgentMaxRuntimeMs`)
  - `settings.service.ts:146,169` (bulk read in `getMany` / `list`)
  - `terraform-registry.service.ts:292` (token decryption fallback)
  - `github-app.service.ts:63`
  - `event-cleanup.service.ts:88,141` (retention settings)
  - `task.service.ts:701` (codespace sandbox config)
  - `server/routes/sandbox-status.ts:75` (sandbox defaults)
  - `server/bootstrap/sandbox/sandbox-init.ts:47,64` (more sandbox defaults)
  - `services/memory/dream*.service.ts:51,62,130,151,1060` (dreaming knobs)
  - `container-agent/agent-review.service.ts:123,383`

  The `settings.value` column is plain `text` (not `text({ mode: 'json' })`), so Drizzle doesn't auto-parse. Each call is a hand-rolled `JSON.parse(row.value) as T` with no schema validation; on a corrupted row, the cast lies and the consumer crashes deep in business logic.
- **Risk**: A single tampered settings row → opaque stack trace far from the read site. No telemetry about malformed settings. Same problem extends to `terraform-registries.tokenEncrypted` and a few JSON-as-text fields.
- **Recommendation**: Build a typed settings facade:
  ```ts
  // src/services/settings/typed-settings.ts
  const SETTING_SCHEMAS = {
    'sandbox.defaults': z.object({ image: z.string(), memoryMb: z.number(), ... }),
    'agent.maxRuntimeMs': z.number().int().positive(),
    'taskCreation.model': z.string(),
    // ...one entry per setting key
  } as const satisfies Record<string, z.ZodType>;

  async getTyped<K extends keyof typeof SETTING_SCHEMAS>(
    key: K
  ): Promise<z.infer<typeof SETTING_SCHEMAS[K]> | null> { ... }
  ```
  Replace the 47 raw call sites. On parse failure, log via `metricsService` and return null (caller's default applies). Optionally migrate `settings.value` to `text({ mode: 'json' })` so Drizzle handles parsing.
- **Effort**: M
- **Links**: F02-09 from prior review — confirmed unfixed.

### F02-24: `codespace.delete` and `task.delete` still execute multi-step flows without transactions
- **Priority**: P2
- **Observation**:
  - `src/services/codespace.service.ts:412-451` — `worktreeService.prune(id)` (filesystem ops) → 3 selects (sessions, plans, sandboxes) → `db.delete(sessionEvents)` → `db.delete(codespaces)`. None of this is wrapped in `db.transaction`. If any DB step after `prune()` fails, worktree directories are gone but the codespace row survives.
  - `src/services/task.service.ts:530-546` — `db.query.tasks.findFirst()` → `stopAgent(id)` (kills container, possibly publishes events) → `db.delete(tasks)`. Not in a transaction. Container could be killed and DB delete fails — leaves a "task in DB with no agent" stuck-state.
- **Risk**: Partial-failure leaks: orphaned worktree directories, orphaned containers, orphaned `session_events` rows. Codespace.delete already has the orphan-cleanup logic upstream of the codespace deletion — but if THAT step fails, you're worse off than before because cascade DELETE never triggers.
- **Recommendation**: For `codespace.delete`: wrap the four DB operations (3 selects + sessionEvents.delete + codespaces.delete) in `db.transaction`. The `prune()` call is a filesystem op; record it in an outbox row inside the transaction (`event_outbox` already exists for this pattern, F05-05) and have a worker reconcile filesystem deletion. For `task.delete`: same pattern — record agent-stop intent in outbox, then delete task in tx, then async worker drives container shutdown.
- **Effort**: M
- **Links**: F02-11 from prior review — confirmed unfixed.

### F02-25: `as unknown as TaskPlanRow` casts persist (4 sites) despite F02-04 recommendation
- **Priority**: P2
- **Observation**: F02-04 recommended replacing the hand-rolled `TaskPlanRow` interface with `Pick<typeof tasks.$inferSelect, ...>`. Status:
  - `src/services/container-agent/plan-approval.service.ts:223` — `})) as unknown as TaskPlanRow | undefined`
  - `src/services/container-agent/plan-approval.service.ts:500` — same pattern
  - `src/services/container-agent/plan-approval.service.ts:511` — `as unknown as { worktreeId?: string | null } | undefined` (different shape, same anti-pattern)
  - `src/services/container-agent/container-exec.service.ts:1219` — same `TaskPlanRow` cast
- **Risk**: A renamed `tasks` column won't fail the type-check at any of these sites. The plan-approval service is the highest-stakes flow in the app (plan/execute transition).
- **Recommendation**:
  ```ts
  // src/services/container-agent/types.ts
  import type { tasks } from '@/db/schema/sqlite/tasks';
  export type TaskPlanRow = Pick<typeof tasks.$inferSelect,
    'id' | 'codespaceId' | 'agentId' | 'sessionId' | 'worktreeId' |
    'plan' | 'planOptions' | 'lastAgentStatus' | 'column'
  >;
  ```
  Then drop the casts: `const task = await db.query.tasks.findFirst({ columns: { id: true, codespaceId: true, ... }, where: eq(tasks.id, taskId) });` returns the correct narrow type without any cast.
- **Effort**: S
- **Links**: F02-04 from prior review — confirmed unfixed; new site discovered at line 511.

### F02-26: Vestigial Drizzle-kit SQLite migrations (`src/db/migrations/`) still present and serve as parity-check fodder
- **Priority**: P2
- **Observation**: `src/db/migrations/` has 16 SQL files (0000 + 0004–0018) using the OLD pre-rename schema (e.g., `0000_clever_red_skull.sql:5,15,21,31,51` all reference `project_id` instead of `codespace_id`). Runtime never applies them — `db/client.ts:48-49` and `server/bootstrap/phases/database.ts:124` both call `runMigrations(sqlite, MIGRATIONS)` from the inline runner. The folder's only purpose is to feed `scripts/check-migration-parity.ts`. The drizzle-kit config (`drizzle.config.ts`) presumably still targets it — running `drizzle-kit migrate` against a real SQLite DB would corrupt the version tracker (`__drizzle_migrations` vs `schema_migrations`).
- **Risk**: Operator confusion; a developer can `bun run drizzle-kit migrate` thinking it's the live path and brick a DB. The 16 stale files diverge further from the live schema with every change.
- **Recommendation**: Decide one way:
  1. **Delete the folder** and rewrite `check-migration-parity.ts` to walk `MIGRATIONS` from `src/lib/bootstrap/migrations/index.ts` instead. (Preferred — eliminates the trap.)
  2. **Make it the source of truth** — port the inline runner to drizzle-kit, regenerate from current schema, and have runtime apply via `migrate()` like PG does. Larger lift.
- **Effort**: M (option 1) / L (option 2)
- **Links**: F02-12 from prior review — confirmed unfixed.

### F02-27: `EventOutboxRelay` processes 100 rows sequentially per tick (`for-of` + `await processRow`)
- **Priority**: P2
- **Observation**: `src/services/event-outbox-relay.service.ts:110-112`:
  ```ts
  for (const row of rows) {
    await this.processRow(row);
  }
  ```
  With `BATCH_SIZE = 100` and `POLL_INTERVAL_MS = 50`, the relay can process at most ~2000 events/sec on a happy path. `processRow` performs a network call to the Caddy durable-streams server; serial awaits stack the latency.
- **Risk**: Throughput cap on agent-event-heavy workloads; backpressure builds in the outbox. A single slow stream-publish stalls the entire batch.
- **Recommendation**: `await Promise.allSettled(rows.map(r => this.processRow(r)))` — independent rows can publish in parallel (Caddy is concurrency-safe). Cap concurrency with `p-limit` or a semaphore (e.g., 16 concurrent publishes) to avoid overwhelming the stream server.
- **Effort**: S

### F02-28: `agent-execution.service.start()` issues 4 sequential `findFirst` queries after a successful start
- **Priority**: P3
- **Observation**: `src/services/agent/agent-execution.service.ts:608-622`:
  ```ts
  const updatedAgent = await this.db.query.agents.findFirst({...});
  const updatedTask = await this.db.query.tasks.findFirst({...});
  const updatedSession = await this.db.query.sessions.findFirst({...});
  const updatedWorktree = await this.db.query.worktrees.findFirst({...});
  ```
  4 round-trips that don't depend on each other.
- **Risk**: Latency tax on the hot agent-start path. Not catastrophic for SQLite (in-process) but every PG round-trip is ~1ms over the wire.
- **Recommendation**: Either `Promise.all([...])` to parallelise (cheapest fix), or use `db.query.agents.findFirst({ with: { tasks: true, sessions: true, worktrees: true } })` if the relations are configured (they are — see `src/db/schema/sqlite/relations.ts:48-60`). Even better: have the caller of `start()` already hold these objects and avoid the re-fetch entirely.
- **Effort**: XS

### F02-29: `health` route still uses `as unknown as` casts and per-request raw SQL for DB version
- **Priority**: P3
- **Observation**: `src/server/routes/health.ts:130-145` — unchanged from the prior review.
  ```ts
  const rows = await (db as unknown as PostgresDatabase).execute(sql`SELECT version() as v`);
  // ...
  const rows = (db as SqliteDatabase).all<{ v: string }>(sql`SELECT sqlite_version() as v`);
  ```
- **Risk**: Same as before — sets the precedent for raw SQL in routes; `DB_MODE` env read in a route file (line 129) leaks bootstrap config into HTTP handlers.
- **Recommendation**: Probe DB version once in `initializePostgres` / `initializeSqlite` (`src/server/bootstrap/phases/database.ts`), store on `DatabaseResult`, and expose via a typed accessor. Health route consumes the cached value.
- **Effort**: S
- **Links**: F02-03 from prior review — confirmed unfixed.

### F02-30: SQLite pragmas `synchronous`, `cache_size`, `mmap_size`, `temp_store` still unset
- **Priority**: P3
- **Observation**: `src/server/bootstrap/phases/database.ts:118-120` and `src/db/client.ts:76-78` set only `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`. No `synchronous=NORMAL`, no `cache_size`, no `mmap_size`, no `temp_store=MEMORY`.
- **Risk**: Default `synchronous=FULL` (under WAL) is conservative and 2–3x slower than `NORMAL` on write-heavy paths like `session_events` and `event_outbox` polling. Default `cache_size=-2000` (2 MB) is tiny for a multi-MB working set.
- **Recommendation**: Add (configurable via env, with safe defaults):
  ```ts
  sqlite.exec('PRAGMA synchronous=NORMAL');     // WAL-safe; only risks last-commit on crash
  sqlite.exec('PRAGMA cache_size=-65536');      // 64 MB
  sqlite.exec('PRAGMA temp_store=MEMORY');
  sqlite.exec('PRAGMA mmap_size=268435456');    // 256 MB
  ```
  Mirror in `db/client.ts` and `server/bootstrap/phases/database.ts`.
- **Effort**: S
- **Links**: F02-06 from prior review — confirmed unfixed.

## Out of scope

- **Soft delete pattern (`deletedAt`)** — explicitly deferred per `src/db/schema/index.ts:10-17`. Out of scope until audit-trail requirements are formalised.
- **Multi-writer / leader-election for outbox relay** — the F02-27 change to parallelise within a single relay is sufficient short-term; multi-process HA is a separate roadmap item (F05-17).
- **Schema-migration ordering tests** — already exist (`src/lib/bootstrap/__tests__/migration-ordering.test.ts`); not flagged.
- **Index review for query-performance** — covered in theme 07 (performance), not data-layer correctness.
- **Postgres-specific tuning (autovacuum, fillfactor, jsonb indexes)** — out of scope at current PG-as-second-class maturity; revisit when PG reaches operational parity.

## Resolution log preview (theme-02-data, April 29 review)

> Filled in once the listed P0/P1 fixes land; mirrors the April 21 log style. Initial P0 = F02-15. Suggested order:
> 1. **F02-15** (P0): port scheduler + memory route + event-cleanup + session-stream raw SQL to portable equivalents; gate WAL ops; introduce `DB_MODE=postgres` CI run.
> 2. **F02-19** (P1): add `codespace_tags.assigned_at` migration v33.
> 3. **F02-20** (P1): rebuild `api_tokens` to fix FK behavior (migration v34).
> 4. **F02-17** (P1): centralise PG client creation; remove unconfigured callers.
> 5. **F02-18** (P1): convert `event_outbox` timestamps to epoch-ms (data migration).
> 6. **F02-16** (P1): extend drift script with type-token comparison.
> 7. **F02-21–F02-30** (P2/P3): standard remediation cycle.
