# 01 - Service Architecture and Data Layer

## Verdict

The service layer is more structured than in April: facade services exist, the outbox relay and plan-mode service are now wired, and background jobs have a registry. The remaining architectural risk is readiness and source-of-truth drift. The server can start accepting execution-triggering requests before sandbox/provider reconciliation completes, while the data layer presents a dual-database story but still types and imports many runtime paths as SQLite.

## Findings

### MAY-04 - P1 - Execution readiness is not a real API gate

`Bun.serve` starts before sandbox initialization runs in the background (`src/server/bootstrap/server-bootstrap.ts:153`, `src/server/bootstrap/server-bootstrap.ts:275`). The `/api/health` path knows about `isSandboxReady`, but task operations can still reach `TaskService` while `containerAgentService` is not ready. Moving a task to `in_progress` can return success while no container agent/session starts (`src/services/task.service.ts:593`, `src/services/task.service.ts:655`, `src/services/task.service.ts:689`).

Impact: the UI/API can acknowledge work that is never actually picked up until manual intervention or a later reconciliation.

Recommendation: introduce a required execution orchestrator/readiness dependency for `TaskService`. `moveColumn(..., 'in_progress')` should return a typed 503 or queue the start explicitly until execution infrastructure is ready.

### MAY-16 - P1 - Readiness endpoints disagree

`/api/health` uses sandbox readiness (`src/server/routes/health.ts:68`), but `/api/readyz` only checks the DB (`src/server/router.ts:569`) and `/api/health/readiness` also checks only DB (`src/server/routes/health.ts:295`).

Impact: orchestrators can route traffic to a pod that is DB-ready but not execution-ready.

Recommendation: split liveness from readiness cleanly. All readiness endpoints should include DB, provider init, and reconciliation status; only liveness should be minimal.

### MAY-17 - P1 - Recovery failures cannot drive bootstrap policy

`BootstrapPhaseResult` exists, but recovery is outside that phase-result flow (`src/server/bootstrap/server-bootstrap.ts:75`). Recovery helpers catch and log internally (`src/server/bootstrap/phases/recovery.ts:36`, `src/server/bootstrap/phases/recovery.ts:88`), which makes higher-level failure aggregation weak.

Impact: startup can proceed after failed recovery with stale `in_progress` or sandbox state, and the operator only sees logs.

Recommendation: make recovery return `BootstrapPhaseResult` and make each recovery sub-step return a typed result instead of swallowing errors.

### MAY-18 - P1 - Sandbox reconciliation adopts rows, not execution ownership

Sandbox reconciliation documents that live provider orphans are inserted into DB, while running-agent maps remain empty (`src/server/bootstrap/phases/sandbox-reconciliation.ts:8`). Runtime ownership still lives in memory maps (`src/services/container-agent/sandbox-state.ts:18`). Provider `list()` failure can return an empty report and still lead to readiness being flipped later (`src/server/bootstrap/phases/sandbox-reconciliation.ts:140`, `src/server/bootstrap/sandbox/sandbox-init.ts:201`).

Impact: after restart, the database may know a sandbox exists but no process owns its live execution state.

Recommendation: choose an explicit policy. Either adopt live executions into a durable owner registry, or kill/recreate sandboxes before readiness.

### MAY-07 - P1 - Dual-database runtime is still SQLite-shaped

The canonical `Database` type is SQLite (`src/types/database.ts:13`) and `src/db/schema/index.ts` re-exports SQLite by default (`src/db/schema/index.ts:1`). Runtime modules import SQLite tables directly, including `event-outbox-relay.service.ts`, `rate-limiter.ts`, `router.ts`, RBAC middleware, and many routes.

Impact: schema parity can pass while runtime behavior still depends on SQLite table objects and SQLite typing. This hides JSON, boolean, timestamp, and return-shape differences in Postgres mode.

Recommendation: add a dialect-aware schema/table provider or repository layer. Stop importing `db/schema/sqlite/*` from code that is intended to work with `DB_MODE=postgres`.

### MAY-14 - P1 - Legacy SQLite `plan_sessions` drift is explicitly skipped

The SQLite `plan_sessions` schema declares richer columns (`src/db/schema/sqlite/plan-sessions.ts:52`), but the legacy v19 creation path can create a stub table (`src/lib/bootstrap/migrations/v19-project-folders.ts:135`). The all-table drift test exempts the missing columns (`tests/integration/schema-drift-all-tables.test.ts:70`).

Impact: upgraded SQLite installs can keep a shape that new code assumes is impossible.

Recommendation: add a runtime SQLite migration for missing `plan_sessions` columns, backfill defaults, and remove the drift-test exception.

### MAY-19 - P1 - Migration parity guards the wrong SQLite source of truth

Runtime SQLite migrations use the inline `MIGRATIONS` list through bootstrap/client paths, while the parity script compares files under `src/db/migrations/`. That improves generated migration hygiene but does not prove runtime SQLite migrations match Postgres migrations.

Impact: a migration can be present in the generated folder and absent from runtime startup, or vice versa.

Recommendation: make the parity checker inspect `MIGRATIONS`, or retire the vestigial SQLite Drizzle-kit migration folder.

### MAY-20 - P2 - Background job lifecycle is not fully centralized

`BackgroundJobRegistry` covers event cleanup, outbox relay, rate-limit cleanup, and scheduler startup, but other timers remain outside it: auth cleanup, sandbox plan cleanup, and task-creation cleanup/delayed cleanup.

Impact: shutdown, health, and job observability remain partial; timer leaks are easy to reintroduce.

Recommendation: migrate all long-lived timers to `BackgroundJob`, keep the registry in the service container, and expose registry snapshots in admin metrics.

### MAY-21 - P2 - CommandRunner remains hardwired in the service container

`createServiceContainer()` constructs its own Bun command runner (`src/server/bootstrap/service-container.ts:148`) and passes it into worktree/git/codespace services. Tests that need a fake runner have to instantiate lower-level services directly.

Impact: command execution is harder to isolate in integration tests, and the deprecated shell path remains centralized but not easily replaced.

Recommendation: accept an optional `commandRunner` in `createServiceContainer`, defaulting to Bun.

### MAY-22 - P2 - Runtime SQLite migration idempotency still matches error strings

The migration runner treats errors containing `duplicate column` as ignorable. This is brittle and can hide unrelated migration failures that happen to include that phrase.

Recommendation: precheck columns via `PRAGMA table_info` before `ALTER TABLE ADD COLUMN`, and make idempotency explicit per migration.

### MAY-23 - P2 - Rebuild migrations still use `INSERT OR IGNORE`

Several rebuild migrations use `INSERT OR IGNORE` when copying rows into replacement tables. That can silently drop data when constraints fail.

Recommendation: use plain `INSERT`, clean known-bad foreign keys before rebuild, and assert source/destination row-count parity.

### MAY-24 - P2 - Settings remain untyped JSON strings

`settings.value` is text and callers parse/cast at use sites. This is workable for small settings but risky for security-sensitive settings such as sandbox mode, sandbox defaults, and credentials flags.

Recommendation: add keyed Zod schemas and a shared `getTypedSetting(key)` API.

### MAY-25 - P2 - Multi-step deletes mix DB and external side effects

Codespace delete and task approval include database writes plus filesystem/worktree cleanup without a transaction or deletion intent record.

Recommendation: wrap DB-only changes in transactions, and use deletion-intent/outbox rows for external cleanup.

### MAY-26 - P3 - SQLite pragmas are still minimal

SQLite startup sets WAL, foreign keys, and busy timeout, but not configurable `synchronous`, `cache_size`, `temp_store`, or optional `mmap_size`.

Recommendation: add explicit, documented SQLite tuning settings for production SQLite deployments.
