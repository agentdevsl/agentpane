# 05 - Remediation Plan

## First cycle: close current P0s

1. Lock down GitHub App administration.
   - Require `admin` for manifest creation, setup callback, credential delete, and global credential save.
   - Require team admin for installation registration/deletion and codespace auto-configuration.
   - Add route tests proving viewer and agent_operator cannot mutate GitHub App state.

2. Fix K8s network isolation ordering.
   - Create default-deny NetworkPolicy before Sandbox CRD, or rollback/delete the CRD if any post-create isolation step fails.
   - Add a provider test where NetworkPolicy creation fails and assert the Sandbox CRD is absent after failure.

3. Make multi-tenant credential isolation fail closed.
   - Stop using `MULTI_TENANT=true` as the only safety trigger.
   - Derive enforcement from actual tenant/team configuration and `sandbox.mode`.
   - In any deployment with more than one tenant boundary, reject shared-mode credential injection by default.

## Second cycle: make execution and streams truthful

4. Add an execution readiness gate.
   - Introduce a `TaskExecutionOrchestrator` or equivalent dependency with explicit readiness and mode.
   - Block or queue `in_progress` moves until provider init and reconciliation have completed.
   - Align `/api/readyz`, `/api/health`, and `/api/health/readiness`.

5. Unify stream publishing through the outbox.
   - Move `SessionStreamService.publish()` to the outbox-backed path.
   - Put `session_events` and `event_outbox` inserts in one transaction.
   - Expose outbox pending/dead counts and oldest pending age in admin metrics.

6. Make gap recovery real.
   - Wire `onGapDetected` to `fetchGapEvents()`.
   - Deduplicate/merge by offset and event ID.
   - Add UI state for recovered, recovering, and unrecoverable gaps.

7. Repair terminal agent error behavior.
   - Move failed tasks out of `in_progress` during terminal error handling.
   - Preserve session/error metadata for the UI.
   - Use a CAS/terminal-state guard so error and completion paths cannot race.

## Third cycle: remove architectural split-brain

8. Replace SQLite-shaped runtime typing.
   - Add a dialect-aware schema/repository layer.
   - Stop importing `db/schema/sqlite/*` in code meant to run in Postgres mode.
   - Make Postgres smoke/integration tests part of scheduled CI at minimum.

9. Fix runtime migration source of truth.
   - Make parity checks inspect runtime `MIGRATIONS`, not only generated SQLite migration files.
   - Add the missing `plan_sessions` runtime migration and remove the drift-test exception.
   - Replace error-string idempotency and `INSERT OR IGNORE` rebuild copies with explicit checks.

10. Centralize sandbox creation.
    - Route container auto-create through the same sandbox config/quota/image validation service as normal sandbox creation.
    - Reserve DB rows before provider provisioning.
    - Probe provider runtime on cache miss.

11. Remove deprecated command execution from ordinary services.
    - Migrate `GitService` to `execArgs`.
    - Keep shell execution only for explicitly operator-authored scripts.
    - Add CI grep/lint protection for new `CommandRunner.exec(command)` uses.

## Fourth cycle: harden contracts and operations

12. Standardize API list responses.
    - Define one `ListResponse<T>` envelope.
    - Update sessions, codespaces, tasks, agents, templates, and frontend client parsing.
    - Generate or export typed contracts from server schemas.

13. Tighten RBAC registration.
    - Add route registration metadata for minimum role and scope type.
    - Test that every `/api/*` route has an explicit policy.

14. Converge frontend data paths.
    - Pick one session source of truth: collection-backed or hook-backed.
    - Implement collection cleanup/retention.
    - Add route-local error boundaries for high-traffic routes.

15. Improve test gates.
    - Promote backend coverage after stabilizing baseline.
    - Add required or scheduled Agent Browser smoke tests for task/session lifecycle.
    - Add P0/P1 regression tests from this review before fixing each item.

16. Finish ops ergonomics.
    - Add `.env.example`.
    - Decide backup policy for production Helm values.
    - Replace `prepare` print-only hook guidance with actionable setup or clear docs.
