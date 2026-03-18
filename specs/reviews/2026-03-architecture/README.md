# Architecture Review -- March 2026

## Executive Summary

The AgentPane codebase is a 163K-line TypeScript application spanning a Hono-based REST API (170 endpoints across 32 route modules), a React frontend (299 TSX/TS files with TanStack Router), a Claude Agent SDK integration for AI coding agents, and a multi-provider sandbox architecture (Docker, Kubernetes, Nomad, AgentCore). The codebase demonstrates strong engineering fundamentals: strict TypeScript configuration with `noUncheckedIndexedAccess`, a consistent `Result<T, E>` error-handling monad adopted across 63 files, a well-designed provider abstraction for sandbox execution, and a mature facade decomposition pattern in service layer design.

However, several systemic concerns have emerged across the review. The most critical are: missing database transactions in multi-step agent operations (risking data inconsistency), a massive PostgreSQL schema drift (17 tables missing), an oversized `ContainerAgentService` at 3,076 lines, and a monolithic `api.ts` bootstrap file at 1,848 lines with no dependency injection. On the frontend, the absence of TanStack Router loaders and route-level code splitting represents the highest-impact performance opportunity. The real-time streaming layer has a presence store that never cleans up stale users, and the agent execution pipeline has an AbortController that is created but never wired to the SDK session -- meaning agent stop commands do not actually terminate SDK processes.

The overall architecture is sound and well-organized. The primary risks are operational (data consistency, resource leaks, dead code accumulation) rather than structural. Addressing the top 10-15 findings would significantly improve reliability, maintainability, and performance.

## Review Scope

- **Date**: 2026-03-18
- **Methodology**: 10 concurrent Opus agents, each assigned a focused review area, performed full source-code reads of all files within scope. Findings were independently identified with severity ratings, then aggregated into this summary.
- **Codebase**: commit `ca3ca8b` on `main` branch
- **Coverage**: All source code under `src/`, `agent-runner/`, `docker/`, `scripts/`, `specs/`, and configuration files. 691 files totalling 163,177 lines of code.

## Severity Summary

| Severity | Count |
|----------|-------|
| Critical | 8 |
| High | 24 |
| Medium | 77 |
| Low | 60 |
| Info | 68 |
| **Total** | **237** |

*Note: Info findings include 34 "Strength" findings from the Sandbox review (07) which document positive architectural patterns, plus positive findings from other reviews.*

## Top Priority Findings

These are the ~15 most impactful findings across all 10 reviews, ordered by severity and cross-cutting impact:

1. **DB-003 / SL-004** (Critical) -- Missing database transactions in agent start flow. Six sequential writes without atomicity risk leaving tasks in inconsistent states.
2. **DB-004** (Critical) -- PostgreSQL schema is missing 17 entire tables. PG mode would fail at runtime for RBAC, teams, events, and tagging operations.
3. **DB-001** (Critical) -- N+1 query pattern in `ProjectService.listWithSummaries` fetches all tasks per project in a loop.
4. **CB-001** (Critical) -- Monolithic `api.ts` at 1,848 lines with procedural initialization, no DI container, and circular stub-then-patch patterns.
5. **CB-002** (Critical) -- Duplicated migration logic between client and server bootstrap paths with divergent coverage.
6. **AE-001** (High) -- AbortController created for agent stop but never wired to SDK session; stop commands do not terminate agent processes.
7. **AE-002** (High) -- Host-mode execution phase is never triggered after plan approval; only container mode supports the full plan-then-execute flow.
8. **SL-001 / CQ-007** (High) -- `ContainerAgentService` at 3,076 lines is an oversized god class managing Docker, K8s, Nomad, AgentCore, plans, worktrees, and event bridging.
9. **AR-014** (High) -- Git routes construct shell commands via `sh -c` string interpolation; should use argument arrays.
10. **FC-022** (High) -- No TanStack Router loaders used across 49 route files; every navigation shows a loading flash.
11. **FC-013** (High) -- No route-level code splitting despite TanStack Router support; entire app in one bundle.
12. **RS-007** (High) -- Presence store never cleans up stale users; no TTL-based eviction or heartbeat validation.
13. **EH-009** (High) -- Multiple route handlers use `as` type casts on request bodies instead of Zod validation.
14. **CQ-019** (High) -- 25 failing tests in `client.test.ts` drifted from implementation.
15. **CQ-021** (High) -- 25 services lack test files, including the 3,076-line `ContainerAgentService`.

## Key Themes

**1. Missing Transaction Boundaries**: Multiple reviews (01, 02, 04) independently identified that multi-step database operations in the agent execution flow lack transaction wrapping. This is the highest-risk data integrity issue.

**2. Oversized Modules**: Three files exceed 2,500 lines (`ContainerAgentService` 3,076, `TaskCreationService` 2,567, `sandbox.tsx` 2,878). The `api.ts` bootstrap and `stream-handler.ts` are also oversized. These need decomposition.

**3. Dead Code and Unused Infrastructure**: The state machine module is not integrated with execution. The `TurnLimiter` class, `executeToolWithHooks` function, hook system, and config hot-reload watcher are all defined but never used. This creates maintenance burden and confusion.

**4. Inconsistent Patterns**: Validation uses three approaches (centralized Zod, local Zod, manual casts). Logging uses both `console.error` (855 calls in 120 files) and the structured logger (38 files). Error handling mixes `Result<T,E>` with raw throws. Event naming mixes colons, hyphens, and underscores.

**5. Frontend Performance Gaps**: No route loaders, no code splitting, minimal lazy loading (3 of 231 components), and unmemoized list items in the Kanban board represent significant performance opportunities.

**6. Security Hardening Opportunities**: Git routes use shell interpolation, webhook signature verification is optional, Caddy SSE endpoints lack authentication, Docker containers use bridge networking with no restrictions, and the encryption key is stored as a plain file alongside the database.

**7. Test Coverage Gaps**: Coverage thresholds are set at 42-48%. Twenty-five services and 12 route modules have no tests. The largest and most critical service file has zero test coverage.

## Review Documents

| # | Document | Findings | Critical | High | Medium | Low | Info |
|---|----------|----------|----------|------|--------|-----|------|
| 01 | [Service Layer Deep Dive](01-service-layer-deep-dive.md) | 20 | 1 | 2 | 10 | 5 | 2 |
| 02 | [Agent Execution Pipeline](02-agent-execution-pipeline.md) | 12 | 0 | 2 | 5 | 5 | 0 |
| 03 | [API Routes & Middleware](03-api-routes-middleware.md) | 33 | 0 | 1 | 9 | 14 | 9 |
| 04 | [Database Schema & Queries](04-database-schema-queries.md) | 20 | 3 | 4 | 8 | 4 | 1 |
| 05 | [Frontend Component Architecture](05-frontend-component-architecture.md) | 22 | 0 | 4 | 8 | 5 | 5 |
| 06 | [Real-Time Streaming & Events](06-realtime-streaming-events.md) | 19 | 0 | 1 | 8 | 8 | 2 |
| 07 | [Sandbox & Container Architecture](07-sandbox-container-architecture.md) | 41 | 0 | 0 | 5 | 2 | 34 |
| 08 | [Error Handling & Type Safety](08-error-handling-type-safety.md) | 26 | 0 | 1 | 9 | 6 | 10 |
| 09 | [Config, Bootstrap & Lifecycle](09-config-bootstrap-lifecycle.md) | 16 | 2 | 4 | 6 | 4 | 0 |
| 10 | [Code Quality & Technical Debt](10-code-quality-technical-debt.md) | 28 | 2 | 5 | 9 | 7 | 5 |

**Note on severity mapping for Review 07 (Sandbox)**: Findings labeled "Strength" are mapped to Info severity. Findings labeled "Concern" are mapped to Medium. "Gap" and "Minor" are mapped to Low. "Note" and "Design Decision" are mapped to Info.

## Comparison with February 2026 Review

### Resolved Since February

- **Agent/Session facade decomposition**: Both `AgentService` and `SessionService` now use a mature facade + sub-service pattern (resolved, noted in Review 01).
- **Route module structure**: Routes now use a consistent factory pattern with typed dependency injection.

### Persisting from February

| Feb Finding | March Equivalent | Status |
|-------------|-----------------|--------|
| No transaction boundaries for multi-step DB operations | SL-004, DB-003, DB-011 | **Still open** -- only 2 of ~8 multi-step operations use transactions |
| AbortController not wired to SDK session | AE-001 | **Still open** -- agent stop does not terminate SDK processes |
| Recovery system never retries | AE-003 | **Still open** -- `withRetry()` defined but never called |
| State machine spec/impl divergence | AE-004 | **Still open** -- machine not integrated, spec drift widened |
| Concurrency check race window | AE-009 | **Still open** -- only counts `running` status, not `starting`/`planning` |

### New Since February

- **6 new services added**: EventProcessingService, EventSourceService, EventSubscriptionService, SchedulerService, RbacService, RbacTokenService
- **ContainerAgentService grew** from ~2,000 to 3,076 LOC (AgentCore support added)
- **TaskCreationService added** at 2,567 LOC
- **Host-mode execution gap identified** (AE-002): planning works but execution phase never triggers in host mode
- **PostgreSQL schema drift worsened** (DB-004): 17 tables now missing from PG schema
- **Frontend performance gaps identified**: No route loaders, no code splitting, minimal lazy loading
- **855 bare console calls** identified in production code (CQ-017)
- **25 services without tests** including the largest service file (CQ-021)

## Recommendations

### Immediate -- High Impact, Moderate Effort

| Priority | Finding(s) | Action | Effort |
|----------|-----------|--------|--------|
| 1 | DB-003, SL-004, DB-011 | Add database transactions to multi-step operations (agent start, task move, task approve) | 2-3 days |
| 2 | AE-001 | Wire AbortController.signal through to SDK session and stream handler | 1 day |
| 3 | AR-014 | Refactor `commandRunner.exec()` to use argument arrays instead of `sh -c` | 1-2 days |
| 4 | EH-009 | Add Zod validation to github, task-creation, and agents routes | 1-2 days |
| 5 | CQ-019 | Fix or update the 25 failing tests in `client.test.ts` | 1 day |

### Short-Term -- High Impact, Higher Effort

| Priority | Finding(s) | Action | Effort |
|----------|-----------|--------|--------|
| 6 | FC-022, FC-013 | Add TanStack Router loaders and route-level code splitting | 3-5 days |
| 7 | SL-001, CQ-007 | Decompose ContainerAgentService into 4 focused sub-services | 3-5 days |
| 8 | CB-001, CQ-008 | Extract api.ts into structured bootstrap phases with DI container | 3-5 days |
| 9 | RS-007 | Implement server-side presence cleanup with TTL-based eviction | 1 day |
| 10 | DB-004 | Decide PostgreSQL fate: bring to parity or officially deprecate | 1-2 days (decision) |

### Medium-Term -- Moderate Impact, Variable Effort

| Priority | Finding(s) | Action | Effort |
|----------|-----------|--------|--------|
| 11 | CQ-017 | Replace 855 bare console calls with structured logger | 2-3 days |
| 12 | CQ-021 | Add tests for critical untested services (container-agent, durable-streams, scheduler, RBAC) | 5-10 days |
| 13 | AE-002 | Implement host-mode execution phase or document planning-only limitation | 2-3 days |
| 14 | FC-012, FC-009 | Lazy-load heavy components; memoize KanbanCard | 2-3 days |
| 15 | EH-008, AR-011 | Consolidate dual validation schema files | 2-3 days |
| 16 | SL-005, SL-006 | Adopt Result pattern in DurableStreamsService and CliMonitorService | 1-2 days |
| 17 | DB-006, DB-007 | Standardize timestamp formats; add updatedAt triggers | 2-3 days |
| 18 | CB-006 | Complete graceful shutdown handler with all service cleanup | 1-2 days |

### Long-Term -- Lower Urgency

| Priority | Finding(s) | Action | Effort |
|----------|-----------|--------|--------|
| 19 | AE-004 | Integrate or remove the unused state machine module | 2-3 days |
| 20 | AE-005, AE-006 | Remove dead code (TurnLimiter, executeToolWithHooks, hook system) | 1 day |
| 21 | SC-023 | Extract shared logic between agent-runner index.ts and agentcore-handler.ts | 2-3 days |
| 22 | CQ-024 | Add build step, E2E tests, and security audit to CI pipeline | 2-3 days |
| 23 | FC-015, FC-016 | Improve ARIA coverage and keyboard navigation in custom components | 3-5 days |
| 24 | CB-002 | Consolidate SQLite migrations into a single reusable pipeline | 2-3 days |
| 25 | CQ-020 | Raise coverage thresholds incrementally toward 70% | Ongoing |
