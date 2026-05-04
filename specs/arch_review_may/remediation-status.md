# May Architecture Review Remediation Status

Date: 2026-05-04

## Status by Finding

| ID | Status | Evidence |
| --- | --- | --- |
| MAY-01 | Addressed | GitHub App routes now require `admin`; router regression covers viewer denial. |
| MAY-02 | Addressed | K8s default-deny NetworkPolicy is created before the Sandbox CRD and rolled back on failure. |
| MAY-03 | Addressed | Shared sandbox credential gates now infer multi-tenant risk from team/user boundaries, not only `MULTI_TENANT=true`. |
| MAY-04 | Addressed | Moving to `in_progress` without an execution service returns `TASK_EXECUTION_NOT_READY` before DB mutation. |
| MAY-05 | Addressed | Session stream publish persists via the outbox path instead of direct best-effort Caddy publish. |
| MAY-06 | Addressed | Durable event persistence and outbox enqueue now happen in one transaction. |
| MAY-07 | Addressed | The default `db/schema` barrel and runtime table adapter now select SQLite/Postgres table objects by `DB_MODE`; live routes/services no longer import SQLite schema directly. Regression verifies `db/schema` exports `PgTable` objects in Postgres mode. |
| MAY-08 | Addressed | GitHub clone/template mutation routes now require `agent_operator`; tests cover role boundaries. |
| MAY-09 | Addressed | Container auto-create routes through `SandboxService`, preserving profile/default/quota/image policy. |
| MAY-10 | Addressed | Agent error handling moves tasks out of `in_progress` to `waiting_approval` while preserving error context. |
| MAY-11 | Addressed | `GitService` uses argv `execArgs`; regression tests guard against shell `exec` calls. |
| MAY-12 | Addressed | Gap detection fetches missed REST ranges, replays callbacks, and exposes recovery state. |
| MAY-13 | Addressed | Sandbox rows are reserved with `creating` status before provider create; K8s/Nomad probe live provider state on cache miss. |
| MAY-14 | Addressed | Runtime SQLite migration v40 adds legacy `plan_sessions` columns and drift skip was removed. |
| MAY-15 | Addressed | Rate limiter fails fast for multi-instance SQLite deployments; Helm supplies replica count. |

## Verification

- `bun run typecheck`
- `bunx biome check src tests charts/agentpane/templates/configmap.yaml`
- `git diff --check -- src tests charts specs`
- Targeted regression bundle: 42 files, 819 tests passed
- MAY-07 dialect regression: `src/db/schema/__tests__/runtime-schema-barrel.test.ts`

## Follow-up Hardening

The MAY-07 runtime risk is closed: Postgres mode no longer receives SQLite table objects from the default schema barrel or live route/service imports. A direct `Database = SqliteDatabase | PostgresDatabase` union was tested and produced broad Drizzle overload incompatibilities, so `Database` now uses the shared runtime schema shape with explicit Postgres-only methods where needed. A future repository abstraction could make that type stricter, but it is no longer required to address the review finding.
