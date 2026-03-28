# Test Suite Health Assessment

**Date:** 2026-03-28
**Branch:** main (commit c19b8c6d)
**Runner:** Vitest 4.0.16

## Current State

| Metric | Value |
|--------|-------|
| **Test Files (vitest)** | 330 passed, 1 skipped (331 total) |
| **Individual Tests** | 7,328 passed, 21 skipped, 0 failed (7,349 total) |
| **Total Test Files on Disk** | 352 (includes 19 e2e files + 2 excluded from vitest) |
| **Suite Duration** | ~67 seconds |
| **Failures** | **0** |

### Status: ALL TESTS GREEN

The 193 failures across 31 files documented in CONTINUITY.md have been fully resolved. The suite is clean on the current `main` branch.

### Breakdown by Test Project

| Project | Files | Tests | Passed | Skipped | Failed | Duration |
|---------|-------|-------|--------|---------|--------|----------|
| **unit** | 140 | 4,024 | 4,023 | 1 | 0 | 30.5s |
| **jsdom** | 40 (39 + 1 skipped file) | 476 | 458 | 18 | 0 | 18.5s |
| **db** | 55 | 2,182 | 2,180 | 2 | 0 | 8.4s |
| **integration** | 90 | 587 | 587 | 0 | 0 | 12.1s |
| **functional** | 6 | 80 | 80 | 0 | 0 | 1.4s |
| **TOTAL** | 331 | 7,349 | 7,328 | 21 | 0 | ~67s |

### Tests Not Included in Vitest Projects

These test files exist on disk but are excluded from the vitest configuration and run separately:

| Category | Files | Tests (approx) | Notes |
|----------|-------|-----------------|-------|
| **E2E (agent-browser)** | 19 | ~261 | Require running dev server; skipped via `describe.skip` when server not detected |
| **K8s E2E** | 1 | ~41 | Requires K8s cluster; `describe.skipIf(!ENABLED)` |
| **diagram-overlap.spec.ts** | 1 | ~3 | Explicitly excluded in `sharedExclude` |

## Skipped Tests Analysis

### Intentionally Skipped (21 tests across 4 locations)

| Location | Count | Reason | Fix Complexity |
|----------|-------|--------|----------------|
| `tests/hooks/use-task-creation.test.tsx` | 18 | Entire `describe.skip` block; complex hook test requiring extensive mocking of TanStack DB collections, SSE, and task creation SDK orchestration | Moderate |
| `tests/api/sessions.test.ts` | 2 | `it.skip` on presence update/query tests; presence service methods exist but tests need mock wiring | Trivial |
| `src/services/__tests__/worktree.service.test.ts` | 1 | `it.skip` on list test; `existsSync` check filters out mock paths (documented with TODO) | Trivial |

### Conditionally Skipped (E2E / environment-dependent)

| Location | Condition | Notes |
|----------|-----------|-------|
| 18 E2E test files | `serverRunning` check | Auto-skip when dev server is not running; this is by design |
| K8s sandbox E2E | `!ENABLED` flag | Requires live K8s cluster; infrastructure-dependent |
| `tests/lib/remaining.test.ts` | `isCI` flag | Crypto tests skipped in CI (platform-specific key derivation) |

## Priority Fixes

Since all tests are currently green, the priorities are about hardening rather than fixing:

### Priority 1: Re-enable Skipped Tests (21 tests)
1. **`use-task-creation.test.tsx`** (18 tests) - The largest skip block. This hook is a critical user-facing feature. Re-enabling requires:
   - Proper mock setup for TanStack DB collections
   - SSE EventSource mocking
   - Task creation SDK service mocking
   - Estimated effort: 0.5 developer-days

2. **`sessions.test.ts`** presence tests (2 tests) - Trivial mock wiring fix
   - Estimated effort: 1 hour

3. **`worktree.service.test.ts`** list test (1 test) - Fix `existsSync` mock path issue
   - Estimated effort: 1 hour

### Priority 2: Fix Coverage Tooling
- `npx vitest run --coverage` fails with `SyntaxError: The requested module 'vitest/node' does not provide an export named 'BaseCoverageProvider'`
- This is a version incompatibility between `@vitest/coverage-v8` and `vitest@4.0.16`
- Coverage thresholds (50%) cannot be verified until this is fixed
- Estimated effort: 0.5 developer-days (dependency update + threshold verification)

### Priority 3: E2E Test Automation
- 19 E2E test files (~261 tests) only run when dev server is up
- These are not part of CI and could silently break
- Consider adding a CI job that starts the dev server and runs E2E tests
- Estimated effort: 1 developer-day

### Priority 4: Increase Test Coverage for Critical Paths
Services without dedicated test coverage (assessed by missing corresponding test files):
- `src/services/container-agent/agentcore-bridge.service.ts` - Agent-to-container communication
- `src/services/container-agent/container-exec.service.ts` - Container execution orchestration
- `src/services/container-agent/worktree-init.service.ts` - Worktree initialization in containers
- `src/services/session/session-presence.service.ts` - Real-time presence tracking
- `src/services/session/session-stream.service.ts` - SSE stream management
- `src/services/git.service.ts` - Git operations
- `src/services/memory/dream-scheduler.service.ts` - Background memory processing

Routes without dedicated test files:
- `src/server/routes/codespaces.ts` (tested via `tests/api/projects.test.ts` but naming is legacy)
- `src/server/routes/github-app.ts` - GitHub App installation flow
- `src/server/routes/github-app-webhooks.ts` - Webhook processing
- `src/server/routes/sandbox-k8s.ts` - K8s sandbox management
- `src/server/routes/sandbox-nomad.ts` - Nomad sandbox management
- `src/server/routes/team-project-folders.ts` - Team folder management

## Effort Estimate

| Task | Effort | Priority |
|------|--------|----------|
| Re-enable 21 skipped tests | 1 developer-day | P1 |
| Fix coverage tooling | 0.5 developer-days | P2 |
| E2E CI integration | 1 developer-day | P3 |
| Add tests for uncovered services | 3-4 developer-days | P4 |
| Add tests for uncovered routes | 2-3 developer-days | P4 |
| **Total to production-ready** | **~8 developer-days** | |

### Recommended Approach

1. **Immediate (before release):** Re-enable the 21 skipped tests and fix coverage tooling. This is ~1.5 developer-days and closes the known gaps.

2. **Short-term (release week):** Add E2E tests to CI. This catches UI regressions that unit tests miss.

3. **Post-release hardening:** Add service/route tests for uncovered modules, prioritizing:
   - Container execution path (security-critical)
   - Session streaming (user-facing, real-time)
   - GitHub App webhooks (external integration)

## Coverage Gaps

### Areas with No Test Coverage That Need It for Production

| Area | Risk Level | Reason |
|------|------------|--------|
| Container agent execution pipeline | HIGH | Security boundary - agents run user code in containers |
| Session streaming (SSE) | HIGH | User-facing real-time feature, reconnection logic |
| GitHub App webhooks | MEDIUM | External integration, webhook signature verification |
| Git operations service | MEDIUM | File system operations, worktree management |
| Nomad/K8s sandbox routes | LOW | Infrastructure-specific, partially covered by E2E |
| Dream scheduler | LOW | Background processing, non-critical path |

### Coverage Threshold Recommendation

The current threshold of 50% is appropriate for the current stage:
- **Current recommendation:** Keep at 50% but fix the tooling so it is actually enforced
- **Production target (90 days):** Raise to 60% overall, with 80% for `src/services/` and `src/server/routes/`
- **Long-term target:** 70% overall, never lower than 50% for any individual module

### Test Architecture Strengths

The test suite has several notable strengths:
1. **5-tier project separation** (unit/jsdom/db/integration/functional) provides clear isolation
2. **Process isolation for DB tests** (`pool: 'forks'`) prevents SQLite state leaks
3. **Functional tests exercise real service code** through state transitions, not just mocks
4. **Property-based tests** exist for state machines (`state-machines.property.test.ts`)
5. **Comprehensive integration coverage** with 90 integration test files covering cross-service workflows
6. **Security-focused tests** including RBAC, path traversal, SSRF validation, and encryption

### Test Architecture Weaknesses

1. **No coverage enforcement** - the `--coverage` flag is broken due to dependency mismatch
2. **E2E tests not in CI** - 261 browser-level tests only run manually
3. **Skipped tests accumulate** - the 21 skipped tests represent real gaps that could hide regressions
4. **Slow unit test** - `github.test.ts` has a 30-second test (`repo not ready after max attempts`) that dominates unit test runtime
