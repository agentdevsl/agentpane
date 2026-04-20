# Data Layer

## Summary

AgentPane runs a dual-backend Drizzle ORM stack: SQLite (default, via `bun:sqlite`) and PostgreSQL (via `postgres-js`), with 42 tables defined twice under `src/db/schema/sqlite/` and `src/db/schema/postgres/`. The SQLite path is the primary data source and is well-hardened (WAL, `busy_timeout=5000`, `foreign_keys=ON`, trigger-based enum validation, FK-safe rebuild migrations). The PostgreSQL path is a second-class citizen — a single mega catch-up migration (`0004_schema_catchup.sql`) closes the gap with the 31 SQLite inline migrations, but operational maturity (connection pool config, drift tests, backup, health-check raw SQL, transaction usage) trails the SQLite side. The custom SQLite migration runner is pragmatic (idempotent ALTER TABLE, per-migration transactions) but sits outside Drizzle Kit, meaning two parallel, divergent migration chains must be maintained. JSON columns are well-typed via Drizzle's `$type<>()` generics, but rely on application discipline — several services `JSON.parse(setting.value) as X` without validation. Schema-drift tests cover only 2 of 42 tables.

## Map
| Area | Files | Purpose |
| --- | --- | --- |
| Schema definitions (dual) | `src/db/schema/sqlite/*.ts` (44 modules) · `src/db/schema/postgres/*.ts` (44 modules) · `src/db/schema/shared/` | Drizzle tables, one-per-entity, kept in parallel |
| Database bootstrap | `src/server/bootstrap/phases/database.ts` · `src/lib/bootstrap/phases/sqlite.ts` · `src/db/client.ts` | WAL/pragmas, drizzle wiring, PG client init |
| SQLite migrations (inline) | `src/lib/bootstrap/migrations/index.ts` (31 versions) · `runner.ts` · `v19-project-folders.ts` · `src/lib/bootstrap/phases/schema.ts` | Ordered SQL migrations with `schema_migrations` tracking |
| Drizzle-kit migrations | `src/db/migrations/` (14 SQL + meta) · `src/db/migrations-pg/` (6 SQL + `0004_schema_catchup.sql` 590 lines) | Generator output; PG uses these at runtime |
| Drizzle configs | `drizzle.config.ts` (SQLite) · `drizzle.config.pg.ts` (Postgres) | Kit generator targets |
| Drift tests | `tests/integration/agents-schema-drift.test.ts` · `session-schema-drift.test.ts` (2 files) | Runtime column comparison |
| Raw SQL hotspots | `src/server/routes/health.ts:99-114` · `src/lib/bootstrap/migrations/runner.ts:40-60` · `schema.ts:326,873` | `db.execute(sql…)`, `db.exec`, `INSERT OR IGNORE` |
| Unsafe casts | `src/services/container-agent/plan-approval.service.ts:197,474,485` · `container-exec.service.ts:1186` | `as unknown as TaskPlanRow` |
| Transactions | 16 usages across services (task, codespace, teams, RBAC, settings, terraform) | Multi-step atomic mutations |

## What's working
- SQLite pragmas are consistent across every entrypoint: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON` (`src/db/client.ts:76-78`, `src/lib/bootstrap/phases/sqlite.ts:42-44`, `src/server/bootstrap/phases/database.ts:62-64`).
- Migration runner wraps each migration in BEGIN/COMMIT with rollback on failure (`runner.ts:89-102`).
- FK-safe rebuild pattern: migrations 29 and 30 `UPDATE ... SET col = NULL WHERE col NOT IN (SELECT id FROM parent)` before table rebuild, matching CLAUDE.md guidance.
- Trigger-based enum validation (v25) covers `tasks.column`, `agents.status`, `worktrees.status`, `agents.type`, `tasks.priority` for INSERT + UPDATE.
- JSON columns use Drizzle's `$type<>()` generic (~35 call sites under `src/db/schema/sqlite/`) — types flow cleanly to services.
- Transaction discipline: 16 services/routes use `db.transaction()` for multi-step mutations (tasks, teams, RBAC, settings, invitations, terraform).
- PostgreSQL JSON columns use `jsonb` (35 occurrences across 20 files) for indexable JSON, not `json`.

## Findings

### F02-01: PostgreSQL migration chain lives in one 590-line mega-migration
- **Priority**: P1
- **Observation**: `src/db/migrations-pg/` contains just 6 files; `0004_schema_catchup.sql` (590 lines, `BEGIN; ... COMMIT;`) fuses the equivalent of SQLite migrations v4–v25. SQLite has 31 inline migrations (`src/lib/bootstrap/migrations/index.ts:46-364`). `0001_overconfident_raza.sql` and `0002_amused_talon.sql` are 1–2 lines; `0003_nomad_columns.sql` is 5 lines. There is no per-change migration for PG post-v25.
- **Risk**: Incremental PG schema evolution is effectively impossible; any new column must be appended to a growing catch-up file or create a new top-level file, inviting drift with the SQLite-first workflow.
- **Recommendation**: Adopt a one-migration-per-change Postgres policy going forward. Split `0004_schema_catchup.sql` into logical sections if future changes need to reference intermediate states. Add a CI check that every SQLite `MIGRATIONS` entry added since the baseline has a corresponding PG migration.
- **Effort**: M
- **Links**: prior finding in `specs/release_plan/06-database-integrity.md` §"Critical: PostgreSQL Migration Gap" — largely addressed by `0004_schema_catchup`, but operational process gap remains.

### F02-02: Schema-drift tests cover 2 of 42 tables
- **Priority**: P1
- **Observation**: Only `tests/integration/agents-schema-drift.test.ts` and `tests/integration/session-schema-drift.test.ts` exist. CLAUDE.md promotes drift tests as the regression barrier: "Run `npx vitest run tests/integration/*schema-drift*` before pushing." 40 tables have no runtime column-comparison guard, including high-churn ones (`tasks`, `codespaces`, `sandboxInstances`, `sandboxConfigs`, `planSessions`, `memoryInsights`, `skillExecutions`, `eventLog`, `templates`).
- **Risk**: Silent drift between Drizzle schema and the actual SQLite/Postgres columns causes runtime NULL-column reads and mysterious Drizzle query failures only under specific code paths.
- **Recommendation**: Auto-generate a drift test per table from the schema index (`src/db/schema/sqlite/index.ts`). Prioritize the 10 highest-churn tables first. Fold the generator into `tests/integration/` so new tables get coverage automatically.
- **Effort**: M
- **Links**: `release_plan/06-database-integrity.md` §"Schema Drift Detection" — the existing `scripts/check-schema-drift.ts` only compares filenames, not columns.

### F02-03: Raw SQL in `/api/health` violates "Never bypass Drizzle" rule
- **Priority**: P2
- **Observation**: `src/server/routes/health.ts:99-114` executes `db.execute(sql`SELECT version() as v`)` with `as unknown as PostgresDatabase` and `(db as SqliteDatabase).all<{ v: string }>(sql`SELECT sqlite_version() as v`)`. This is a read-only version probe, but the pattern normalises bypassing the typed ORM in request paths.
- **Risk**: Low data-integrity risk (read-only), but the cast pattern and raw tagged-template SQL leak dialect assumptions into a route that should be dialect-agnostic. It also sets precedent for future raw SQL.
- **Recommendation**: Move dialect detection to `src/server/bootstrap/phases/database.ts` — probe version once at startup, store on the returned `DatabaseResult`, and consume via typed accessor. Remove the casts and the `DB_MODE` env read from the route.
- **Effort**: S
- **Links**: CLAUDE.md memory: "Never bypass Drizzle with raw SQL for database operations."

### F02-04: `as unknown as TaskPlanRow` indicates schema/query shape mismatch
- **Priority**: P2
- **Observation**: Four sites force-cast Drizzle query results: `src/services/container-agent/plan-approval.service.ts:197,474,485` and `src/services/container-agent/container-exec.service.ts:1186`. `TaskPlanRow` is defined in `src/services/container-agent/types.ts:101-108` as a hand-rolled subset of `tasks` columns. The casts exist because `db.query.tasks.findFirst()` returns the full Drizzle-inferred type, and the service wants a narrower row.
- **Risk**: Casts defeat type safety when schema changes — a renamed column won't surface as a compile error in plan-approval logic. Two of the four casts are the same query issued back-to-back (lines 474 and 485 both hit `tasks` where `id = taskId`).
- **Recommendation**: Replace `TaskPlanRow` with `typeof tasks.$inferSelect` (or a `Pick<>` of it). Merge the duplicate queries in `rejectPlan` into one. Drop the casts.
- **Effort**: S

### F02-05: PostgreSQL client has no pool/timeout tuning
- **Priority**: P1
- **Observation**: `src/server/bootstrap/phases/database.ts:46` calls `postgres(connectionString)` with zero options. `postgres-js` defaults are `max: 10`, `idle_timeout: 0` (no idle close), `connect_timeout: 30s`, `max_lifetime: null`. No prepared-statement cap, no application_name, no SSL enforcement.
- **Risk**: Under production load the 10-connection default caps throughput; `idle_timeout: 0` keeps handles open indefinitely across PG restart failovers; no `connection.application_name` makes `pg_stat_activity` triage blind; no SSL toggle means a misconfigured `DATABASE_URL` can silently talk cleartext.
- **Recommendation**: Pass `{ max, idle_timeout, max_lifetime, connect_timeout, connection: { application_name: 'agentpane' }, ssl: config.pgSsl }` from `ServerConfig`. Surface pool-depth as an env var. Mirror in the K8s Helm chart defaults.
- **Effort**: S
- **Links**: `release_plan/07-performance-scalability.md` §"Connection Management".

### F02-06: SQLite `synchronous` and `cache_size` pragmas never set
- **Priority**: P2
- **Observation**: Grep for `synchronous`, `cache_size`, `mmap_size` in `src/db/` returns nothing. Only `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON` are applied (`src/db/client.ts:76-78`). With WAL, `synchronous` defaults to `FULL` which is conservative; for server workloads `NORMAL` is typical and 2–3x faster on write-heavy paths like `session_events`.
- **Risk**: Write throughput on event insertion (high-frequency path per Durable Streams architecture) is slower than necessary; no protection against page cache exhaustion under bursty agent output.
- **Recommendation**: Add `synchronous=NORMAL` (WAL-safe on crash, only risks trailing commits), `cache_size=-64000` (64 MB), `temp_store=MEMORY`, `mmap_size=134217728` (128 MB). Make each configurable via env for conservative deployments.
- **Effort**: S
- **Links**: `release_plan/07-performance-scalability.md` §"Current Architecture".

### F02-07: Migration runner swallows every "duplicate column" exception
- **Priority**: P2
- **Observation**: `src/lib/bootstrap/migrations/runner.ts:41-47, 53-60` catches exceptions and ignores anything whose message contains `'duplicate column'`. This runs for both multi-statement blocks (via `db.exec`) and individual ALTER statements. A failing ALTER on a different column would still throw, but the string-match is fragile — if better-sqlite3 or bun:sqlite wording changes, real errors get masked or real errors get raised in the idempotent path.
- **Risk**: Migration idempotency depends on an error-message substring; a quiet upgrade to the SQLite binding could either skip required migrations or break re-runs.
- **Recommendation**: Switch to pre-checks — query `PRAGMA table_info(x)` before ALTER and skip if the column exists. Drop the string-match catch. For `db.exec` blocks, decompose into individual statements where idempotency matters.
- **Effort**: M

### F02-08: `INSERT OR IGNORE` in table-rebuild migrations can mask row loss
- **Priority**: P2
- **Observation**: Migrations v29 (`agents`) and v30 (`sessions`) in `src/lib/bootstrap/migrations/index.ts:311,344` do `INSERT OR IGNORE INTO agents_new SELECT ... FROM agents`. While v29/v30 now correctly NULL orphaned FKs before the rebuild (lines 295-296, 328-329), `INSERT OR IGNORE` can still swallow PRIMARY KEY collisions, NOT NULL violations, and CHECK failures silently. No row-count parity assertion.
- **Risk**: A bug that produces duplicate IDs or violates a new NOT NULL constraint would silently drop rows during rebuild. Users discover missing agents/sessions only at query time.
- **Recommendation**: Drop `OR IGNORE` — the upstream UPDATEs already handle the known FK case. Add a `SELECT COUNT(*)` parity check: rollback if `agents_new` count differs from the pre-drop `agents` count minus known filtered rows.
- **Effort**: S
- **Links**: CLAUDE.md "Migration safety — `INSERT OR IGNORE` does NOT suppress FK violations in SQLite."

### F02-09: JSON settings parsed as `T` without schema validation
- **Priority**: P2
- **Observation**: `src/services/settings.service.ts:43,70,289`, `src/services/task.service.ts:549`, `src/services/terraform-registry.service.ts:292`, `src/services/github-app.service.ts:63`, `src/server/routes/sandbox-status.ts:75`, `src/server/bootstrap/sandbox/sandbox-init.ts:47,64` all do `JSON.parse(row.value) as T`. This is for the `settings` table which stores values as TEXT, not `{ mode: 'json' }`. Parse errors throw uncaught; shape mismatches are silent.
- **Risk**: A tampered or stale settings row causes a runtime type error deep in a service, or silently supplies wrong-shaped config to the sandbox/terraform bootstrap. No audit log of malformed settings.
- **Recommendation**: Introduce a small `parseSetting<T>(key, schema)` helper using Zod. Replace all 10+ raw `JSON.parse` sites. Log+default on validation failure. Consider migrating the `settings.value` column to `text({ mode: 'json' })` so Drizzle handles parse and the schema captures the types centrally.
- **Effort**: M

### F02-10: JSON column conventions diverge between SQLite and Postgres
- **Priority**: P2
- **Observation**: SQLite schemas use `text('col', { mode: 'json' })` (~35 sites); Postgres schemas use `jsonb(...)` (35 occurrences across 20 files). Drizzle handles (un)marshalling differently — SQLite stringifies on write, PG sends native JSON. Mixed reads via `db.query.x.findFirst()` return already-parsed objects in both; but raw `db.execute(sql...)` in health.ts or future raw SQL would return string in SQLite and object in PG. There's no typed helper to guarantee this invariant.
- **Risk**: Any future raw SQL touching JSON columns will silently diverge between backends. PG `jsonb` can't represent `undefined`; SQLite stringify can. Round-trip tests don't exist.
- **Recommendation**: Add a single shared type export per JSON column (`src/db/schema/shared/json-types.ts`) referenced by both backend schemas. Add a dual-backend round-trip test for every JSON column (auto-generated from the schema index).
- **Effort**: M

### F02-11: Task-delete and many multi-step writes skip transactions
- **Priority**: P2
- **Observation**: Grep for `db.transaction` returns 16 files; `src/services/task.service.ts` uses it for `create()` and `moveColumn()`, but `Task.delete` is a single `db.delete(tasks)` (no transaction, relies on cascade). `CodespaceService.delete` does `worktreeService.prune()` then `db.delete(codespaces)` without a transaction — if prune succeeds and delete fails, worktrees are orphaned on disk.
- **Risk**: Partial failures leak external resources (worktree dirs on disk, session records, sandbox containers) that the cascade-delete never sees.
- **Recommendation**: Wrap delete chains in `db.transaction`. For external resources (worktree dirs, containers), adopt an outbox pattern: record deletion intent in a DB row inside the transaction, then reconcile from a sweeper. Prior review already flagged this.
- **Effort**: M
- **Links**: `release_plan/06-database-integrity.md` §"Gap: Non-Transactional Multi-Step Operations".

### F02-12: Two parallel migration chains — inline runner vs Drizzle Kit
- **Priority**: P2
- **Observation**: `src/db/migrations/` contains 14 Drizzle-kit generated SQLite migrations (v0000–v0014); these are never applied at runtime. Runtime uses `src/lib/bootstrap/migrations/index.ts` (31 versions) with a custom runner. The two chains are unrelated — Drizzle-kit output is likely vestigial. Risk of a developer running `drizzle-kit migrate` against a prod SQLite DB and corrupting the version tracker (`schema_migrations` vs Drizzle's `__drizzle_migrations`).
- **Risk**: Confusion; a mis-step in ops could apply the wrong chain and brick a DB. The 14 orphaned files keep diverging from the live schema.
- **Recommendation**: Pick one system. Either (a) delete `src/db/migrations/` and document that SQLite runtime uses `migrations/index.ts`, or (b) migrate the inline runner to Drizzle-kit and regenerate from current schema. Matching the PG approach (Drizzle-kit) would simplify.
- **Effort**: L

### F02-13: PostgreSQL path has no runtime migration-safety tests
- **Priority**: P1
- **Observation**: The PG bootstrap (`src/server/bootstrap/phases/database.ts:49-52`) calls `migratePg(db, { migrationsFolder: './src/db/migrations-pg' })` but `tests/integration/` has zero `*-postgres-*.test.ts` or `*-pg-*.test.ts` files (drift tests are SQLite-only via `bun:sqlite` imports). `0004_schema_catchup.sql` is a 590-line BEGIN/COMMIT block — any SQL error aborts the whole catch-up.
- **Risk**: First real PG production deployment is the first time the chain runs against a non-empty DB. No regression guard.
- **Recommendation**: Add a CI job that spins up Postgres via testcontainers, runs migrations, then runs drift tests against the PG schema. Decompose `0004_schema_catchup.sql` into logical savepoints to scope failures.
- **Effort**: M
- **Links**: `release_plan/06-database-integrity.md` §"Critical: PostgreSQL Migration Gap".

### F02-14: No session-event retention enforcement for non-session stream IDs
- **Priority**: P2
- **Observation**: The `session_events` table stores events for all stream types — bare session IDs, `plan:{id}`, `sandbox:{id}`, `terraform:{jobId}`, `cli-monitor`. CLAUDE.md notes `sessionId` has no FK constraint. `EventCleanupService` prunes by age (30 days) but per prior review is a blunt instrument. Terraform compose events are labelled "ephemeral" in CLAUDE.md but still land in `session_events` when routed through `session.service`.
- **Risk**: Orphan event rows accumulate indefinitely if a stream ID's cleanup owner (e.g., `codespace.service.ts`) misses a branch. The lack of FK means no DB-level integrity — only application discipline.
- **Recommendation**: Add a `streamKind` enum column to `session_events` (`session` | `plan` | `sandbox` | `terraform` | `cli-monitor`). Retention policies per kind. Add a reconcile job that logs rows whose `streamId` has no corresponding owner. Cross-reference with the events-review theme file.
- **Effort**: M

## Open questions
- Is the Drizzle-kit `src/db/migrations/` SQLite output intentional (for reference/docs) or dead code? Safe to delete?
- Has the single PG `0004_schema_catchup.sql` actually been run end-to-end against a production-shaped PG instance, or only against a fresh DB in CI?
- Are there any plans for a multi-writer deployment? WAL helps readers but single-writer lock-contention will be the scaling wall, making the PG path strategically important.
- Who owns writing drift tests for new tables — should this be enforced in PR template / CODEOWNERS?
- What is the policy for casting Drizzle row types? If team prefers hand-rolled row interfaces, the schema-drift tests should also assert the hand-rolled type matches `$inferSelect`.

## Resolution log (theme-02-data, April 2026)

- **F02-01**: Backfilled three per-change PG migrations (0007-0009) to match SQLite 0014/0015/0016. Added `scripts/check-migration-parity.ts` and `tests/integration/migration-parity.test.ts` to enforce going forward. The 590-line `0004_schema_catchup.sql` was left in place (frozen) — new work must use dedicated per-change migrations. Splitting the mega-migration further is deferred.
- **F02-02**: `tests/integration/schema-drift-all-tables.test.ts` auto-generates 49 drift tests from `src/db/schema/sqlite/index.ts`, with dedicated high-churn cases. Surfaced a real `codespace_tags.assigned_at` gap (documented, safe today).
- **F02-05**: `POSTGRES_MAX`, `POSTGRES_IDLE_TIMEOUT`, `POSTGRES_MAX_LIFETIME`, `POSTGRES_CONNECT_TIMEOUT`, `POSTGRES_APPLICATION_NAME`, `POSTGRES_SSL` are now parsed through a zod schema into `ServerConfig.postgres` and passed to `postgres()`. Invalid values raise a typed `PostgresConfigError` at boot.
- **F02-13**: `tests/integration/pg-migration-safety.test.ts` runs the full PG migration chain against a real Postgres (gated by `POSTGRES_INTEGRATION=true` + `POSTGRES_URL`) and asserts every Drizzle column exists. Surfaced and fixed seven missing columns (cli_sessions extended columns + memory_insights.effectiveness_score) via PG migrations 0010 and 0011.
