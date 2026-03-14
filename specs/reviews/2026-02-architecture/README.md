# Architecture Review - February 2026

## Executive Summary

This architecture review evaluates the AgentPane codebase across 10 key areas, producing **148 findings** (0 Critical, 14 High, 60 Medium, 70 Low, and 5 Info-level). The codebase demonstrates strong architectural foundations -- clean separation of concerns between frontend/backend/packages, well-typed TypeScript with strict mode enabled, a comprehensive error catalog with 160+ cataloged error codes, and a functional `Result<T, E>` pattern used consistently throughout the service layer.

The most significant risks center around three themes:

1. **State consistency gaps**: Missing database transactions for multi-step operations (DB-003), race conditions in agent startup (AE-002), and abort signals that never reach the SDK (AE-001) create windows for orphaned or inconsistent data.

2. **Authentication and security posture**: The auth middleware defaults to fully permissive in development mode without adequate guardrails (BA-002, CC-004), token validation accepts any string when validators are not configured (CC-010), and Docker sandbox containers have no network isolation (CS-007).

3. **Operational readiness**: 97% of logging bypasses the structured logger (CC-001), the CI pipeline does not run build verification or E2E tests (PS-006, TI-006), the dual SQLite/PostgreSQL schemas have drifted (DB-001), and the migration strategy lacks version tracking (DB-002).

The agent execution pipeline -- the core value of the application -- has functional gaps: host-mode agents cannot proceed from planning to execution (AE-009), and the recovery system defines retry logic that is never invoked (AE-003). The container sandbox path (Docker/K8s) is more mature, with a clean provider abstraction and a meaningful plan/execute security boundary.

Despite these findings, the codebase is well-organized for its scale (~120+ source files). The component hierarchy, service decomposition, and real-time streaming architecture via Durable Streams are solid. With targeted improvements to transaction boundaries, authentication enforcement, logging adoption, and CI coverage, the application is well-positioned for production readiness.

---

## Review Scope

This review covers 10 areas of the AgentPane codebase, each evaluated by an independent reviewer:

| # | Area | Reviewer | Findings |
|---|------|----------|----------|
| 01 | [Project Structure](./01-project-structure.md) | reviewer-1 | 15 |
| 02 | [Backend API & Services](./02-backend-api-services.md) | reviewer-2 | 15 |
| 03 | [Frontend Architecture](./03-frontend-architecture.md) | reviewer-3 | 15 |
| 04 | [Agent Execution](./04-agent-execution.md) | reviewer-4 | 16 |
| 05 | [Container & Sandbox](./05-container-sandbox.md) | reviewer-5 | 16 |
| 06 | [Database & Data Layer](./06-database-data-layer.md) | reviewer-6 | 13 |
| 07 | [Testing Infrastructure](./07-testing-infrastructure.md) | reviewer-7 | 12 |
| 08 | [Prompts, Templates & Workflows](./08-prompts-templates-workflows.md) | reviewer-8 | 15 |
| 09 | [CLI Monitor](./09-cli-monitor.md) | reviewer-9 | 20 |
| 10 | [Cross-Cutting Concerns](./10-cross-cutting-concerns.md) | reviewer-10 | 11 |

---

## Severity Matrix

| Area | Critical | High | Medium | Low | Info | Total |
|------|----------|------|--------|-----|------|-------|
| 01 - Project Structure | 0 | 2 | 7 | 6 | 0 | 15 |
| 02 - Backend API & Services | 0 | 1 | 8 | 6 | 0 | 15 |
| 03 - Frontend Architecture | 0 | 1 | 5 | 5 | 3 | 14 |
| 04 - Agent Execution | 0 | 3 | 7 | 6 | 0 | 16 |
| 05 - Container & Sandbox | 0 | 0 | 5 | 11 | 0 | 16 |
| 06 - Database & Data Layer | 0 | 3 | 6 | 4 | 0 | 13 |
| 07 - Testing Infrastructure | 0 | 2 | 5 | 5 | 0 | 12 |
| 08 - Prompts, Templates & Workflows | 0 | 0 | 6 | 9 | 0 | 15 |
| 09 - CLI Monitor | 0 | 0 | 5 | 13 | 2 | 20 |
| 10 - Cross-Cutting Concerns | 0 | 1 | 5 | 5 | 0 | 11 |
| **Total** | **0** | **13** | **59** | **70** | **5** | **147** |

---

## Top Priority Findings

### High Severity (14 findings)

| ID | Area | Finding | Impact |
|----|------|---------|--------|
| AE-009 | Agent Execution | `resume()` does not restart agent execution for host-mode agents | Agents that complete planning cannot proceed to execution without the container service |
| AE-001 | Agent Execution | AbortController created but never passed to SDK session | Agent stop is a no-op at the SDK level; agents continue running after "stop" |
| AE-002 | Agent Execution | Race condition between task move and concurrency check | Tasks can be orphaned in `in_progress` with no agent; TOCTOU in concurrency |
| DB-001 | Database | Dual SQLite/PostgreSQL schemas have drifted | PostgreSQL mode will fail on missing columns (`sandbox_provider`, session metrics) |
| DB-002 | Database | Migration strategy lacks version tracking | No rollback capability; risk of data loss on schema changes |
| DB-003 | Database | Missing transactions for multi-step operations | Task moves, project deletes, and approvals can leave inconsistent state |
| BA-002 | Backend API | Authentication middleware ineffective in all modes | Tokens accepted without database validation even in production config |
| PS-003 | Project Structure | Missing formal workspace configuration | Three independent packages with no shared dependency management |
| PS-006 | Project Structure | No build verification in CI | Production build can break without detection; no E2E tests in CI |
| TI-002 | Testing | Frontend code entirely excluded from coverage | Zero coverage metrics for the entire React UI layer |
| TI-005 | Testing | No tests for critical agent execution path | `stream-handler.ts` and `agent-execution.service.ts` have no test coverage |
| FE-001 | Frontend | Hardcoded API base URL (`localhost:3001`) | Blocks deployment to any non-localhost environment |
| CC-001 | Cross-Cutting | 720 raw `console.*` calls bypass structured logger | Production observability severely limited; no request ID correlation |

---

## Key Themes

### 1. State Consistency and Data Integrity

Multiple areas lack transaction boundaries for multi-step database operations. Task column moves create sessions before updating tasks (DB-003), project deletion cascades without atomicity (BA-013), and the agent startup sequence can leave tasks orphaned (AE-002). The in-memory state maps (`runningAgents`, `pendingPlans`) are lost on server restart (CS-002, AE-007).

**Affected areas**: Agent Execution, Backend API, Database, Container Sandbox

### 2. Authentication and Authorization Gaps

The auth middleware defaults to fully open in development mode and even in production, tokens are accepted without database validation when validators are not configured (BA-002, CC-010). The CLI monitor daemon communicates with the server over unauthenticated HTTP (CM-005). Docker containers expose OAuth tokens via environment variables (CS-001).

**Affected areas**: Backend API, Cross-Cutting, CLI Monitor, Container Sandbox

### 3. Operational Observability

97% of logging uses raw `console.*` calls instead of the structured logger (CC-001). Request IDs generated in middleware are not propagated to services (CC-003). Environment variables are accessed directly in 82 locations without centralized validation (CC-002).

**Affected areas**: Cross-Cutting, Backend API

### 4. Code Duplication Across Client and Server

HCL extraction logic (PT-005), clarifying question parsers (PT-006), node type mapping (PT-004), theme application logic (FE-009), and task transition definitions (BA-006) are duplicated between server and client with divergent implementations.

**Affected areas**: Frontend, Prompts/Templates/Workflows, Backend API

### 5. CI/CD Coverage Gaps

The CI pipeline only runs lint, typecheck, and unit tests. It does not verify the production build (PS-006), run E2E tests (TI-006), build Docker images, or verify package builds. Coverage thresholds are below specification targets (TI-001) and exclude all frontend code (TI-002).

**Affected areas**: Project Structure, Testing Infrastructure

### 6. Dual-Database Schema Drift

The SQLite and PostgreSQL schemas are maintained as separate file trees and have already drifted -- several columns exist in SQLite but not PostgreSQL (DB-001). The migration strategy combines Drizzle Kit, hand-written SQL, and embedded bootstrap SQL with no version tracking (DB-002). Performance indexes are defined in bootstrap SQL but not in Drizzle schemas (DB-008).

**Affected areas**: Database

---

## Recommendations

### Immediate (High Impact)

1. **Add database transactions** to multi-step operations: task column moves, project deletion, agent startup, and plan approval (DB-003, BA-013, AE-002)
2. **Wire AbortController to SDK sessions** so agent stop actually terminates execution (AE-001)
3. **Implement host-mode execution continuation** after plan approval (AE-009)
4. **Fix authentication** to validate tokens against the database in production; require explicit `SKIP_AUTH=true` for dev bypass (BA-002, CC-010, CC-004)
5. **Make API base URL configurable** via environment variable for deployment (FE-001)

### Short-Term (Weeks)

6. **Add build verification to CI** -- run `bun run build`, Docker image build, and package builds (PS-006)
7. **Consolidate migration strategy** on Drizzle Kit with proper version tracking (DB-002)
8. **Adopt structured logging** -- migrate high-traffic files first; add `no-console` lint rule (CC-001)
9. **Add workspace configuration** to root `package.json` to unify package management (PS-003)
10. **Add tests for agent execution pipeline** using existing stream simulation helpers (TI-005)
11. **Centralize environment variable validation** with a Zod schema at startup (CC-002)

### Medium-Term (Months)

12. **Resolve dual-schema drift** -- either generate PostgreSQL from a single source or drop PostgreSQL support (DB-001)
13. **Decompose oversized files** -- `api.ts` (1,419 lines), `container-agent.service.ts` (2,244 lines), `task-creation.service.ts` (2,544 lines) (PS-010, PS-011, CC-009)
14. **Include E2E tests in CI** with dev server startup and agent-browser or Playwright (TI-006)
15. **Extract shared utilities** for HCL extraction, question parsing, and node type mapping (PT-005, PT-006, PT-004)
16. **Add Docker network isolation** for sandbox containers (CS-007)
17. **Include frontend code in coverage metrics** and raise thresholds toward 80% (TI-002, TI-001)
18. **Replace `window.confirm` with design system dialogs** across 7 locations (FE-003)
19. **Add N+1 query fixes** for project summaries using SQL aggregation (BA-003, DB-004)

### Long-Term (Ongoing)

20. **Standardize validation patterns** across all API routes using `parseBody()` (BA-005)
21. **Implement request ID propagation** via AsyncLocalStorage for service-layer correlation (CC-003)
22. **Clean up dead code** -- unused SSE token service (BA-015), unused agent-runner tool registry (CS-004), unused recovery retry logic (AE-003)
23. **Add per-event-type schema validation** in container bridge (CS-014)
24. **Implement model-specific cost calculation** in CLI monitor (CM-001)

---

## Document Index

| Document | Description |
|----------|-------------|
| [01-project-structure.md](./01-project-structure.md) | Root layout, directory organization, build system, CI/CD pipeline, configuration management |
| [02-backend-api-services.md](./02-backend-api-services.md) | API routes, service layer, middleware, error handling, data validation, Hono setup |
| [03-frontend-architecture.md](./03-frontend-architecture.md) | Component architecture, state management, routing, real-time updates, design system, accessibility |
| [04-agent-execution.md](./04-agent-execution.md) | Agent lifecycle, planning/execution phases, stream handler, error recovery, swarm mode |
| [05-container-sandbox.md](./05-container-sandbox.md) | Docker sandbox, Kubernetes CRD controller, agent-runner, security isolation |
| [06-database-data-layer.md](./06-database-data-layer.md) | Database schema, Drizzle ORM, migration strategy, data access patterns, dual-DB architecture |
| [07-testing-infrastructure.md](./07-testing-infrastructure.md) | Test setup, factories, mocking strategy, integration tests, E2E tests, coverage analysis |
| [08-prompts-templates-workflows.md](./08-prompts-templates-workflows.md) | Prompt registry, Terraform Compose pipeline, Workflow Designer, template sync |
| [09-cli-monitor.md](./09-cli-monitor.md) | CLI monitor daemon, JSONL parsing, session tracking, cost calculation, publishing pipeline |
| [10-cross-cutting-concerns.md](./10-cross-cutting-concerns.md) | TypeScript configuration, error handling, logging, configuration management, security patterns |
