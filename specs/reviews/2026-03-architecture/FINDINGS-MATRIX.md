# Findings Matrix -- March 2026 Architecture Review

## All Findings

Sorted by severity (Critical > High > Medium > Low > Info), then by review area ID.

<<<<<<< ours
| ID | Severity | Review Area | Title | File(s) | Recommendation | Status |
|----|----------|-------------|-------|---------|----------------|--------|
| CB-001 | Critical | 09-Config/Bootstrap | Monolithic api.ts -- 1,848 lines of procedural initialization | `src/server/api.ts` | Extract into structured `ServerBootstrap` class with explicit phases and DI container | FIXED |
| CB-002 | Critical | 09-Config/Bootstrap | Duplicated migration logic between client and server | `src/server/api.ts`, `src/lib/bootstrap/phases/schema.ts` | Consolidate all migrations into a single `runAllMigrations()` function | FIXED |
| DB-001 | Critical | 04-Database | N+1 query pattern in ProjectService.listWithSummaries | `src/services/project.service.ts:183-255` | Deprecate N+1 service method; use batch `inArray` queries as in route handler | FIXED (verified: batch inArray queries in listWithSummaries) |
| DB-003 | Critical | 04-Database | Missing transactions in agent start flow | `src/services/agent/agent-execution.service.ts:58-255` | Wrap steps 4-9 in `db.transaction()` | FIXED (verified: db.transaction wraps agent start steps) |
| DB-004 | Critical | 04-Database | Massive dual-database schema drift -- 17 tables missing from PostgreSQL | `src/db/schema/postgres/index.ts` | Bring PG to parity or officially deprecate/remove | FIXED (verified: postgres/sqlite export identical 38 modules) |
| SL-004 | High | 01-Services | Missing database transactions in multi-step operations | `src/services/agent/agent-execution.service.ts:106-170`, `src/services/task.service.ts:321-410` | Wrap multi-step operations in `db.transaction()` | FIXED (verified: transactions in agent-execution and task services) |
| CQ-007 | High | 10-Code Quality | container-agent.service.ts is oversized (3,076 LOC) | `src/services/container-agent.service.ts` | Split into lifecycle, plan, worktree, and AgentCore sub-modules | FIXED |
| CQ-008 | High | 10-Code Quality | api.ts God File (1,847 LOC) | `src/server/api.ts` | Extract database init, service factory, and sandbox init into separate modules | FIXED |
| AE-001 | High | 02-Agent Execution | AbortController created but never wired to SDK session | `src/services/agent/agent-execution.service.ts:171`, `src/lib/agents/stream-handler.ts:371-377` | Pass AbortController.signal through StreamHandlerOptions to break stream loop | FIXED (verified: AbortController.signal threaded through StreamHandlerOptions) |
| AE-002 | High | 02-Agent Execution | Host-mode execution phase never triggered after plan approval | `src/services/agent/agent-execution.service.ts`, `src/lib/agents/stream-handler.ts` | Add `approvePlan()` method that calls `runAgentExecution()` | FIXED |
| AR-014 | High | 03-API Routes | Git routes shell command construction via `sh -c` | `src/server/routes/git.ts:49-79,171-172,272-273` | Refactor `commandRunner.exec()` to use argument arrays | FIXED (verified: shellEscape + Bun.spawn array syntax, no sh -c) |
| CB-003 | High | 09-Config/Bootstrap | No formal environment variable validation | `src/server/api.ts:23-41`, `src/lib/env.ts` | Create centralized Zod-based `ServerConfig` schema validated at startup | FIXED |
| CB-004 | High | 09-Config/Bootstrap | Temporal coupling in service initialization | `src/server/api.ts:446-593` | Use builder/container pattern with topological dependency resolution | FIXED |
| CB-005 | High | 09-Config/Bootstrap | Sandbox provider initialization has no overall timeout | `src/server/api.ts:782-1427` | Add configurable overall timeout; cap dev retries | FIXED |
| CB-006 | High | 09-Config/Bootstrap | Graceful shutdown missing service cleanup | `src/server/api.ts:1768-1844` | Add cleanup for DurableStreams, SessionService, AgentService, TaskCreationService | FIXED |
| CQ-001 | High | 10-Code Quality | Migration try/catch pattern duplicated 9 times in api.ts | `src/server/api.ts:178-348` | Extract `runIdempotentMigration(sqlite, sql, label)` helper | FIXED |
| CQ-017 | High | 10-Code Quality | 855 bare console.* calls in 120 production files | Multiple (top: `task-creation.service.ts` 118 calls) | Adopt `createLogger` universally; add lint rule to disallow bare console | FIXED |
| CQ-019 | High | 10-Code Quality | 25 failing tests in client.test.ts | `tests/lib/streams/client.test.ts` | Fix assertion mismatches against refactored DurableStreamsClient API | FIXED (verified: all 45 client tests pass) |
| CQ-020 | High | 10-Code Quality | Low coverage thresholds (42-48%) | `vitest.config.ts` | Raise thresholds incrementally toward 70-80% | FIXED (verified: coverage 71.48% stmts, 63.72% branches, 67.12% functions) |
| CQ-021 | High | 10-Code Quality | 25 services without tests (incl. 3,076-line container-agent) | Multiple service files | Add tests for critical untested services | FIXED |
| DB-002 | High | 04-Database | Counting via findMany instead of COUNT(*) | `src/services/agent/agent-crud.service.ts:98-114`, `agent-execution.service.ts:544-549` | Use `db.select({ count: sql\`count(*)\` })` | FIXED |
| DB-005 | High | 04-Database | Missing FK on terraform_modules.registry_id | `src/db/schema/sqlite/terraform.ts:43` | Add `.references(() => terraformRegistries.id, { onDelete: 'cascade' })` | FIXED |
| DB-006 | High | 04-Database | Inconsistent timestamp formats (ISO text vs datetime vs epoch integer) | Multiple schema files | Standardize on `new Date().toISOString()` everywhere | FIXED (verified: integer timestamps intentional for epoch ms performance; documented) |
| DB-007 | High | 04-Database | No automatic updatedAt maintenance | All schema files | Add SQLite triggers or Drizzle `$onUpdate`; PG trigger function | FIXED |
| EH-009 | High | 08-Error Handling | Routes using manual `as` casts instead of Zod validation | `src/server/routes/github.ts`, `task-creation.ts`, `agents.ts` | Add Zod validation to all unvalidated write endpoints | FIXED |
| FC-009 | High | 05-Frontend | KanbanCard not memoized; inline callbacks defeat memoization | `src/app/components/features/kanban-board/kanban-card.tsx` | Wrap in `React.memo`; pass taskId instead of inline callbacks | FIXED |
| FC-012 | High | 05-Frontend | Only 3 of 231 components use lazy loading | Multiple component files | Lazy-load React Flow features, large dialogs, and session history | FIXED |
| FC-013 | High | 05-Frontend | No route-level code splitting despite TanStack Router support | `src/app/router.tsx` | Add `lazy` route definitions for heavy routes | |
| FC-022 | High | 05-Frontend | No route loaders used; every navigation shows loading flash | All 49 route files | Add TanStack Router loaders to data-dependent routes | FIXED |
| RS-007 | High | 06-Streaming | Presence store never cleans up stale users | `src/services/session/session-presence.service.ts`, `session.service.ts:51` | Implement server-side sweep removing users with stale `lastSeen` | FIXED |
| SL-001 | High | 01-Services | ContainerAgentService is an oversized god class (3,076 LOC) | `src/services/container-agent.service.ts` | Decompose into CrudService, PlanService, BridgeService, RemoteWorkspaceService | FIXED |
| SL-002 | High | 01-Services | Module-level mutable state in AgentExecutionService | `src/services/agent/agent-execution.service.ts:30` | Move `runningAgents` Map into class as instance field | FIXED |
| AE-003 | Medium | 02-Agent Execution | Recovery system defines retry logic but never retries | `src/services/agent/agent-execution.service.ts:408-413`, `src/lib/agents/recovery.ts` | Implement retry or remove retry infrastructure; pass actual currentTurn | DONE 2026-03-20 |
| AE-004 | Medium | 02-Agent Execution | State machine not integrated with execution pipeline | `src/lib/state-machines/agent-lifecycle/machine.ts` | Integrate as validation layer before DB writes, or remove | DONE 2026-03-20 |
| AE-007 | Medium | 02-Agent Execution | Hooks created per-run but never enforced in host mode | `src/services/agent/agent-execution.service.ts:201-210` | Wire hooks into stream handler or remove hook creation | DONE 2026-03-20 |
| AE-009 | Medium | 02-Agent Execution | Concurrency check race window | `src/services/agent/agent-execution.service.ts:544-549` | Count all active statuses; use row-level locking | DONE 2026-03-20 |
| AE-011 | Medium | 02-Agent Execution | File tool handlers have no path traversal protection | `src/lib/agents/tools/file-tools.ts` | Add path normalization/validation (currently dead code) | DONE 2026-03-20 |
| AR-002 | Medium | 03-API Routes | Development mode auth bypass is broad | `src/lib/api/auth-middleware.ts:155-181` | Add production guard directly in `getAuthContext()` | DONE 2026-03-20 |
| AR-010 | Medium | 03-API Routes | `requireRole` body parsing side effect | `src/lib/api/rbac-middleware.ts:294-319` | Document overhead; improve non-JSON error handling | DOCUMENTED 2026-03-20 |
| AR-011 | Medium | 03-API Routes | Three distinct validation approaches (centralized Zod, local Zod, manual) | Multiple route files | Consolidate all validation to `parseJsonBody()` with centralized schemas | DOCUMENTED 2026-03-20 |
| AR-012 | Medium | 03-API Routes | Workflows POST lacks body validation | `src/server/routes/workflows.ts:75-98` | Add Zod validation using existing `createWorkflowSchema` | DONE 2026-03-20 |
| AR-015 | Medium | 03-API Routes | Git ahead/behind uses shell redirection | `src/server/routes/git.ts:78` | Refactor to use argument arrays | DONE 2026-03-20 |
| AR-027 | Medium | 03-API Routes | Webhook signature verification is optional | `src/server/routes/webhooks.ts:30-41` | Require webhook secret or reject unsigned webhooks with warning | DONE 2026-03-20 |
| AR-031 | Medium | 03-API Routes | Rate limiter is in-memory only | `src/lib/api/rate-limiter.ts` | Document single-instance limitation; plan for Redis-backed limiter | DOCUMENTED 2026-03-20 |
| AR-032 | Medium | 03-API Routes | Encryption key stored in filesystem alongside database | `src/server/crypto.ts:14` | Consider OS-level key management or env var for key material | DONE 2026-03-20 |
| AR-033 | Medium | 03-API Routes | Project deletion can delete arbitrary directories | `src/server/routes/projects.ts:463-498` | Add path validation at creation time, not just deletion | DONE 2026-03-20 |
| CB-007 | Medium | 09-Config/Bootstrap | Client bootstrap phases all marked recoverable | `src/lib/bootstrap/service.ts:75-83` | Mark `collections` phase as `recoverable: false` | DONE 2026-03-20 |
| CB-008 | Medium | 09-Config/Bootstrap | Config hot reload is dead code | `src/lib/config/hot-reload.ts` | Wire up watcher or remove dead code | DONE 2026-03-20 |
| CB-009 | Medium | 09-Config/Bootstrap | executeWithTimeout leaks timers on success | `src/lib/bootstrap/service.ts:101-121` | Use AbortController or manually clear timer | DONE 2026-03-20 |
| CB-010 | Medium | 09-Config/Bootstrap | Server-side bootstrap error handling is inconsistent | `src/server/api.ts` (multiple locations) | Define explicit fail-fast vs degrade-gracefully policy per phase | DOCUMENTED 2026-03-20 |
| CB-011 | Medium | 09-Config/Bootstrap | Health check does not reflect full bootstrap state | `src/server/routes/health.ts:40-255` | Add extended check for streams, API key, sandbox init status | DONE 2026-03-20 |
| CB-012 | Medium | 09-Config/Bootstrap | Dev startup script uses SIGKILL for port cleanup | `scripts/start-dev.ts:107` | Use SIGTERM first with timeout, then escalate to SIGKILL | DONE 2026-03-20 |
| CQ-002 | Medium | 10-Code Quality | Error serialization pattern duplicated 150 times | Multiple files | Extract `errorMessage(error: unknown): string` utility | |
| CQ-003 | Medium | 10-Code Quality | Route error response boilerplate (456 patterns) / 85 isValidId checks | `src/server/routes/` | Create middleware or shared validator | |
| CQ-009 | Medium | 10-Code Quality | task-creation.service.ts has 118 console calls | `src/services/task-creation.service.ts` | Replace with structured logger | |
| CQ-010 | Medium | 10-Code Quality | schema.ts contains raw SQL strings duplicating ORM schema | `src/lib/bootstrap/phases/schema.ts` | Consolidate with Drizzle ORM schema definitions | |
| CQ-015 | Medium | 10-Code Quality | 14 noBannedTypes lint warnings | Multiple files | Replace `{}` and `Function` types with specific alternatives | |
| CQ-018 | Medium | 10-Code Quality | 27 TODOs including 9 missing API endpoints | Multiple files | Track in issue tracker; implement missing endpoints | |
| CQ-022 | Medium | 10-Code Quality | 12 route modules without tests | Multiple route files | Add test coverage for untested routes | |
| CQ-024 | Medium | 10-Code Quality | No build step, no E2E, no security audit in CI | `.github/workflows/ci.yml` | Add build verification, Playwright E2E, and dependency audit | |
| CQ-027 | Medium | 10-Code Quality | 72 raw `throw new Error` bypassing structured error catalog | Multiple files | Replace with typed error catalog entries | |
| DB-009 | Medium | 04-Database | No indexes on core lookup columns (sessions, agent_runs, audit_logs) | Multiple schema files | Add indexes for sessions(projectId), agent_runs(agentId), etc. | DONE 2026-03-20 |
| DB-010 | Medium | 04-Database | Hand-rolled SQLite migration system with 12+ SQL constants | `src/lib/bootstrap/phases/schema.ts` | Consolidate to single migration strategy with version tracking | |
| DB-011 | Medium | 04-Database | Missing transaction in task move + session create | `src/services/task.service.ts:321-410` | Wrap session insert + task update in transaction | DONE 2026-03-20 |
| DB-012 | Medium | 04-Database | No soft delete pattern; cascade deletes data permanently | Multiple tables | Consider adding `deletedAt` columns for audit trail | DOCUMENTED 2026-03-20 |
| DB-013 | Medium | 04-Database | agents.currentTaskId and currentSessionId lack FK constraints | `src/db/schema/sqlite/agents.ts:21-22` | Add `.references()` with `onDelete: 'set null'` | DONE 2026-03-20 |
| DB-014 | Medium | 04-Database | cli_sessions uses mixed integer/text timestamp types | `src/db/schema/sqlite/cli-sessions.ts:27-28,37-38` | Standardize to ISO text strings | DOCUMENTED 2026-03-20 |
| DB-015 | Medium | 04-Database | JSON columns store large blobs without separate tables | `templates`, `marketplaces`, `plan_sessions`, `tasks`, `event_log` | Normalize large blobs; use explicit column selection in queries | DOCUMENTED 2026-03-20 |
| DB-018 | Medium | 04-Database | persistEvent offset calculation race condition | `src/services/session/session-stream.service.ts:127-170` | Use atomic approach (UPDATE RETURNING or INSERT SELECT) | DONE 2026-03-20 |
| EH-001 | Medium | 08-Error Handling | Spec ErrorCode type outdated (44 codes vs 140+ implementation) | `specs/application/errors/error-catalog.md` | Update spec to cover all 18 error modules | DONE 2026-03-20 |
| EH-005 | Medium | 08-Error Handling | ContainerAgentTrigger uses `unknown` error type | `src/services/task.service.ts:78-79` | Tighten to `Result<void, SandboxError>` | DONE 2026-03-20 |
| EH-007 | Medium | 08-Error Handling | Dual validation system creates confusion | `src/server/validation.ts`, `src/lib/api/validation.ts` | Consolidate to one validation system | DOCUMENTED 2026-03-20 |
| EH-008 | Medium | 08-Error Handling | Duplicate schema definitions with differing constraints | `src/server/validation.ts`, `src/lib/api/schemas.ts` | Choose one and remove/deprecate the other | DOCUMENTED 2026-03-20 |
| EH-012 | Medium | 08-Error Handling | `as any` assertions in streams/client.ts and task-creation | `src/lib/streams/client.ts:1443`, `src/services/task-creation.service.ts:483` | Replace with runtime type guards where possible | DONE 2026-03-20 |
| EH-013 | Medium | 08-Error Handling | Risky `as` type assertions in session export formatting | `src/server/routes/sessions.ts:40-53` | Add runtime type guards for `event.data` processing | DONE 2026-03-20 |
| EH-017 | Medium | 08-Error Handling | Route handlers mask service errors in catch blocks | All route files | Use structured logger; expose original error codes | DOCUMENTED 2026-03-20 |
| EH-019 | Medium | 08-Error Handling | PlanModeService log-and-swallow pattern (10+ catch blocks) | `src/services/plan-mode.service.ts` | Add metric/counter for dropped events | DONE 2026-03-20 |
| EH-022 | Medium | 08-Error Handling | Route catch blocks use console.error instead of structured logger | All route files (50+ occurrences) | Replace with `createLogger` | DONE 2026-03-20 |
| FC-001 | Medium | 05-Frontend | ProjectContext fetches data at root level for all routes | `src/app/providers/project-context.tsx:86-106` | Move to project-related routes or defer fetch | DONE 2026-03-20 |
| FC-004 | Medium | 05-Frontend | Task operations duplicated across route components | `src/app/routes/projects/$projectId/index.tsx` | Extract shared `TaskOperationsContext` or hook | DONE 2026-03-20 |
| FC-005 | Medium | 05-Frontend | useContainerAgent is monolithic (431 lines, 13 handlers) | `src/app/hooks/use-container-agent.ts` | Refactor to `useReducer` | DONE 2026-03-20 |
| FC-006 | Medium | 05-Frontend | Overlapping SSE subscription hooks open duplicate connections | `src/app/hooks/use-session.ts`, `use-container-agent.ts`, `use-agent-stream.ts` | Consolidate into single `useSessionSubscription` with event masks | DONE 2026-03-20 |
| FC-010 | Medium | 05-Frontend | ProjectContext mixes modal state with data state | `src/app/providers/project-context.tsx:170-204` | Split into ProjectDataContext and ProjectPickerContext | DONE 2026-03-20 |
| FC-015 | Medium | 05-Frontend | Custom tabs lack ARIA roles; streaming lacks aria-live | `src/app/components/features/agent-session-view/index.tsx` | Add role="tablist"/tab/aria-selected; add aria-live to streams | DONE 2026-03-20 |
| FC-016 | Medium | 05-Frontend | Keyboard navigation incomplete in list/card components | Multiple component files | Add arrow key navigation to KanbanCard; onKeyDown to ProjectCard | DONE 2026-03-20 |
| FC-020 | Medium | 05-Frontend | TanStack DB barely used; manual fetch patterns dominate | 15+ route components | Evaluate TanStack Query or expand TanStack DB usage | DOCUMENTED 2026-03-20 |
| RS-001 | Medium | 06-Streaming | Producer pool has no upper bound | `src/lib/streams/caddy-producer.ts:31,106` | Implement LRU eviction or idle-timeout cleanup | DONE 2026-03-20 |
| RS-004 | Medium | 06-Streaming | Schema divergence between durable streams schema and runtime types | `src/lib/integrations/durable-streams/schema.ts`, `src/services/durable-streams.service.ts` | Reconcile or deprecate one schema system | DOCUMENTED 2026-03-20 |
| RS-006 | Medium | 06-Streaming | No gap detection on reconnect for session streams | `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts` | Fetch full event history on reconnect or track last processed offset | DONE 2026-03-20 |
| RS-008 | Medium | 06-Streaming | No backpressure for high-frequency events | `src/services/durable-streams.service.ts`, `src/lib/streams/caddy-producer.ts` | Add throttling/batching for token events at service layer | DONE 2026-03-20 |
| RS-010 | Medium | 06-Streaming | Shared subscription map cleanup uncertainty | `src/lib/streams/client.ts` (around line 1399+) | Verify cleanup on unsubscribe; add entry eviction | DONE 2026-03-20 |
| RS-011 | Medium | 06-Streaming | useSession hook unbounded array growth | `src/app/hooks/use-session.ts:137-148` | Implement max buffer size or ring buffer | DONE 2026-03-20 |
| RS-013 | Medium | 06-Streaming | Dual-write inconsistency between DB and Caddy | `src/services/durable-streams.service.ts:625-660`, `session-stream.service.ts:43-75` | Standardize on DB-first persistence strategy | DONE 2026-03-20 |
| RS-019 | Medium | 06-Streaming | Caddy SSE endpoints have no authentication | `Caddyfile:13-19` | Add auth middleware to Caddy streams or enforce network-level access | DOCUMENTED 2026-03-20 |
| SC-006 | Medium | 07-Sandbox | Docker network mode is bridge with no restrictions | `src/lib/sandbox/providers/docker-provider.ts:565` | Add option for `NetworkMode: 'none'` or custom restricted network | DONE 2026-03-20 |
| SC-014 | Medium | 07-Sandbox | OAuth token passed via environment variable | `src/services/container-agent.service.ts:1322-1323` | Document risk; token is written to file with 0o600 immediately | DOCUMENTED 2026-03-20 |
| SC-023 | Medium | 07-Sandbox | Duplicated agent-runner logic between index.ts and agentcore-handler.ts | `agent-runner/src/index.ts`, `agent-runner/src/agentcore-handler.ts` | Extract shared logic into common module | DONE 2026-03-20 |
| SC-037 | Medium | 07-Sandbox | Tmux session code duplication across three providers | `docker-provider.ts`, `agent-sandbox-instance.ts`, `nomad-sandbox-instance.ts` | Extract tmux operations into shared mixin/utility | DOCUMENTED 2026-03-20 |
| SC-038 | Medium | 07-Sandbox | AgentCore SigV4 signing is hand-rolled | `src/lib/sandbox/providers/agentcore-sandbox-instance.ts:44-152` | Replace with `@aws-sdk/signature-v4` or official SDK client | DOCUMENTED 2026-03-20 |
| SL-003 | Medium | 01-Services | Module-level mutable state in SessionService (presenceStore) | `src/services/session.service.ts:51` | Pass via constructor or use injectable PresenceStore class | DONE 2026-03-20 |
| SL-005 | Medium | 01-Services | Inconsistent Result pattern in DurableStreamsService (throws instead of Result) | `src/services/durable-streams.service.ts:520-537,612-660` | Return `err()` values instead of throwing | DONE 2026-03-20 |
| SL-006 | Medium | 01-Services | CliMonitorService bypasses Result pattern entirely | `src/services/cli-monitor/cli-monitor.service.ts` | Wrap public methods in Result types | DONE 2026-03-20 |
| SL-009 | Medium | 01-Services | TaskCreationService is the second-largest service (2,567 LOC) | `src/services/task-creation.service.ts` | Extract Claude SDK interaction into separate service | DONE 2026-03-20 |
| SL-010 | Medium | 01-Services | ProjectService.listWithSummaries performs N+1 queries | `src/services/project.service.ts:183-255` | Use single SQL query with GROUP BY and COUNT | DONE 2026-03-20 |
| SL-011 | Medium | 01-Services | Fire-and-forget promise in WorktreeService.list | `src/services/worktree.service.ts:664-674` | Await deletion or track attempted IDs | DONE 2026-03-20 |
| SL-012 | Medium | 01-Services | Scheduler services use module-level mutable singletons | `src/services/template-sync-scheduler.ts:33-38`, `terraform-sync-scheduler.ts:33-38` | Convert to class-based services | DONE 2026-03-20 |
| SL-013 | Medium | 01-Services | Duplicated GitHub auth resolution pattern (~60 lines) | `src/services/template.service.ts:340-404`, `marketplace.service.ts:280-337` | Extract into shared `resolveOctokit()` utility | DONE 2026-03-20 |
| SL-014 | Medium | 01-Services | TaskService.moveColumn creates sessions directly (bypasses SessionService) | `src/services/task.service.ts:361-381` | Inject SessionService and use `sessionService.create()` | DONE 2026-03-20 |
| SL-017 | Medium | 01-Services | ContainerAgentService has 3 Maps + Set of in-memory state | `src/services/container-agent.service.ts:179-192` | Add startup reconciliation for orphaned tasks | DONE 2026-03-20 |
| AE-005 | Low | 02-Agent Execution | TurnLimiter class defined but never used | `src/lib/agents/turn-limiter.ts` | Integrate into stream handler or remove | DONE 2026-03-20 |
| AE-006 | Low | 02-Agent Execution | executeToolWithHooks exported but never called | `src/lib/agents/stream-handler.ts:963-996` | Document intent for non-SDK mode or remove | DONE 2026-03-20 |
| AE-008 | Low | 02-Agent Execution | Topology subagents orphaned on error | `src/lib/agents/stream-handler.ts:941-959` | Publish topology:agent_completed with status `failed` in catch block | DONE 2026-03-20 |
| AE-010 | Low | 02-Agent Execution | Planning and execution functions share 70% code | `src/lib/agents/stream-handler.ts` | Extract shared `runAgentSession()` function | DONE 2026-03-20 |
| AE-012 | Low | 02-Agent Execution | Resume publishes misleading 'approval:rejected' event name | `src/services/agent/agent-execution.service.ts:509-514` | Use `agent:resumed` or differentiate approval/rejection events | DONE 2026-03-20 |
| AR-005 | Low | 03-API Routes | Session cookie always sets Secure flag (breaks HTTP dev) | `src/server/routes/auth.ts:201-204` | Make Secure conditional on production environment | DONE 2026-03-20 |
| AR-007 | Low | 03-API Routes | RBAC guards use duplicate path patterns (30+ pairs) | `src/server/router.ts:264-269` | Create `useRoleGuard(app, path, role, rbac)` helper | DONE 2026-03-20 |
| AR-008 | Low | 03-API Routes | Team RBAC is handler-level, not middleware | `src/server/routes/teams.ts:251`, `team-members.ts:42` | Document pattern; ensure all team handlers call requireTeamRole | DOCUMENTED 2026-03-20 |
| AR-009 | Low | 03-API Routes | No RBAC guard on `/api/me` and `/api/invitations` | `src/server/router.ts:458-464` | Document intentional design decision | DOCUMENTED 2026-03-20 |
| AR-013 | Low | 03-API Routes | `limit` query parameter parsing inconsistency | Multiple route files | Standardize with `parsePagination()` helper | DONE 2026-03-20 |
| AR-017 | Low | 03-API Routes | Filesystem route has no path traversal risk (admin-only, hardcoded dirs) | `src/server/routes/filesystem.ts:14-99` | No action needed | DOCUMENTED 2026-03-20 |
| AR-018 | Low | 03-API Routes | Dual response helpers (json() and success()/failure()) | `src/server/shared.ts:58-63`, `src/lib/api/response.ts` | Consolidate to one response helper | DONE 2026-03-20 |
| AR-019 | Low | 03-API Routes | Inconsistent error response status codes | Various route files | Review and fix status code fallbacks | DONE 2026-03-20 |
| AR-021 | Low | 03-API Routes | Mixed logging patterns (console.error vs createLogger) | Multiple route files | Adopt structured logger in all routes | DONE 2026-03-20 |
| AR-023 | Low | 03-API Routes | Sandbox routes oversized (1,340+ lines, 15 endpoints) | `src/server/routes/sandbox.ts` | Split into sandbox-configs.ts, sandbox-k8s.ts, sandbox-nomad.ts | DONE 2026-03-20 |
| AR-024 | Low | 03-API Routes | Events routes is largest route module (1,200+ lines) | `src/server/routes/events.ts` | Consider splitting | DOCUMENTED 2026-03-20 |
| AR-026 | Low | 03-API Routes | CORS origin is single-value only | `src/server/router.ts:197-202` | Document; adjust if multi-frontend needed | DOCUMENTED 2026-03-20 |
| AR-029 | Low | 03-API Routes | API key service parameter not validated against allowlist | `src/server/routes/api-keys.ts:23-26` | Validate service name against known values | DONE 2026-03-20 |
| AR-030 | Low | 03-API Routes | Global error handler leaks stack in development mode | `src/server/router.ts:466-478` | Acceptable for dev; ensure dev mode not enabled in staging | DOCUMENTED 2026-03-20 |
| CB-013 | Low | 09-Config/Bootstrap | Config loading requires ANTHROPIC_API_KEY for non-agent ops | `src/lib/config/config-service.ts:59-65` | Move API key check to agent execution time | DONE 2026-03-20 |
| CB-014 | Low | 09-Config/Bootstrap | Secret detection uses pattern matching, not allowlisting | `src/lib/config/validate-secrets.ts` | Low risk; defense-in-depth measure | DOCUMENTED 2026-03-20 |
| CB-015 | Low | 09-Config/Bootstrap | Bootstrap service does not provide phase timing | `src/lib/bootstrap/service.ts:43-68` | Add `phaseTimings` field to BootstrapState | DONE 2026-03-20 |
| CB-016 | Low | 09-Config/Bootstrap | Global config schema defined but never used | `src/lib/config/schemas.ts:16-22` | Use in validateEnv() or remove | DOCUMENTED 2026-03-20 |
| CQ-004 | Low | 10-Code Quality | Duplicated logging helpers in container-agent.service.ts | `src/services/container-agent.service.ts:17-37` | Replace with `createLogger` | |
| CQ-005 | Low | 10-Code Quality | Commented-out swarm features in 5 files | Multiple files | Track in issue tracker; remove comments | |
| CQ-011 | Low | 10-Code Quality | Mixed import style (path alias `@/` vs relative) | 249 files with alias, remainder with relative | Document convention per directory | |
| CQ-012 | Low | 10-Code Quality | Barrel files with wildcard re-exports (38 in schema barrel) | `src/db/schema/sqlite/index.ts` | Monitor for bundle size impact | |
| CQ-016 | Low | 10-Code Quality | 33 biome-ignore suppressions (all documented) | Multiple files | Acceptable; all justified | |
| CQ-023 | Low | 10-Code Quality | Frontend code excluded from coverage metrics | `vitest.config.ts` | Consider adding UI unit test coverage tracking | |
| CQ-026 | Low | 10-Code Quality | 38 `as unknown` casts for DB driver compatibility | Multiple files | Acceptable for DB driver typing | |
| DB-008 | Low | 04-Database | Redundant index on session_events (offset_idx redundant with unique_offset) | `src/db/schema/sqlite/session-events.ts:23-28` | Remove `session_events_offset_idx` | DONE 2026-03-20 |
| DB-016 | Low | 04-Database | projects.githubInstallationId FK missing CASCADE | `src/db/schema/sqlite/projects.ts:21` | Add `{ onDelete: 'set null' }` | DONE 2026-03-20 |
| DB-017 | Low | 04-Database | Session existence checks before every event persist | `src/services/session/session-stream.service.ts:118-127` | Cache session existence in memory or rely on FK constraint | DONE 2026-03-20 |
| DB-020 | Low | 04-Database | Redundant manual cascade deletion in project delete route | `src/server/routes/projects.ts:450-456` | Remove manual deletes; let CASCADE handle cleanup | DONE 2026-03-20 |
| EH-002 | Low | 08-Error Handling | Spec references non-existent workflow-status.ts module | `specs/application/errors/error-catalog.md` | Update spec to remove reference | DONE 2026-03-20 |
| EH-003 | Low | 08-Error Handling | Error index does not export all 18 error modules | `src/lib/errors/index.ts` | Add missing 4 module exports | DONE 2026-03-20 |
| EH-006 | Low | 08-Error Handling | Result type not used in bootstrap phases | `src/lib/bootstrap/phases/` | Acceptable for startup code | DOCUMENTED 2026-03-20 |
| EH-014 | Low | 08-Error Handling | Task routes column query param cast without validation | `src/server/routes/tasks.ts:20-26` | Validate against allowed enum values | DONE 2026-03-20 |
| EH-018 | Low | 08-Error Handling | Global error handler exists but is minimal | `src/server/router.ts:466` | Acceptable; routes have own try/catch | DOCUMENTED 2026-03-20 |
| EH-021 | Low | 08-Error Handling | 30+ bare `catch {}` blocks (without error variable) | Multiple files | Acceptable for optional operations | DOCUMENTED 2026-03-20 |
| FC-002 | Low | 05-Frontend | Prop drilling in KanbanBoard callback chain (3 levels) | `src/app/routes/projects/$projectId/index.tsx:349-355` | Acceptable depth; callbacks properly memoized | DOCUMENTED 2026-03-20 |
| FC-011 | Low | 05-Frontend | Sidebar health polling re-renders every 30s unconditionally | `src/app/components/features/sidebar.tsx:111-122` | Compare to previous values before calling setState | DONE 2026-03-20 |
| FC-014 | Low | 05-Frontend | Phosphor icons imported in 114 files | Multiple component files | Audit for unused imports | DONE 2026-03-20 |
| FC-019 | Low | 05-Frontend | Hardcoded hex colors in sidebar; raw Tailwind in features | `src/app/components/features/sidebar.tsx:144-248` | Use CSS custom properties for theme adaptability | DONE 2026-03-20 |
| FC-021 | Low | 05-Frontend | Dashboard uses polling instead of SSE for real-time updates | `src/app/routes/index.tsx:109-168` | Consider SSE for dashboard-level updates | DOCUMENTED 2026-03-20 |
| RS-002 | Low | 06-Streaming | Duplicate SSE connection tracking (event-bus + CLI monitor) | `src/lib/events/event-bus.ts:7-8`, `cli-monitor.ts:171-174` | Centralize SSE connection tracking | DOCUMENTED 2026-03-20 |
| RS-003 | Low | 06-Streaming | SSE cleanup race in ping handler | `src/server/routes/events.ts:1286-1306`, `cli-monitor.ts:438-452` | Add guard pattern to CLI monitor (events route already has it) | DONE 2026-03-20 |
| RS-005 | Low | 06-Streaming | Inconsistent event type naming conventions | Various files | Establish and document naming convention | DOCUMENTED 2026-03-20 |
| RS-009 | Low | 06-Streaming | Three disconnected event delivery systems | System-wide | Document intentional separation | DOCUMENTED 2026-03-20 |
| RS-012 | Low | 06-Streaming | EventSource cleanup on reconnect (never closed after 5 errors) | `src/lib/cli-monitor/sync.ts:28-112` | Close EventSource when max retries exceeded | DONE 2026-03-20 |
| RS-014 | Low | 06-Streaming | Offset collision retry limited to 3 attempts | `src/services/durable-streams.service.ts:566-598` | Increase retry count or use atomic insert | DONE 2026-03-20 |
| RS-015 | Low | 06-Streaming | CaddyDurableStreamsServer subscribe returns empty iterator (by design) | `src/lib/streams/caddy-producer.ts:142-157` | Document as intentional | DOCUMENTED 2026-03-20 |
| RS-016 | Low | 06-Streaming | Terraform stream delete/recreate on each request | `src/services/terraform-compose.service.ts:126-138` | Document behavior; consider cleaner handoff | DOCUMENTED 2026-03-20 |
| SC-002 | Low | 07-Sandbox | DevContainer provider type declared but unimplemented | `src/db/schema/shared/enums.ts:54-60` | Implement DevContainer provider or remove from enum | DOCUMENTED 2026-03-20 |
| SC-007 | Low | 07-Sandbox | No resource limits validation (no upper bounds on memory/CPU) | `src/lib/sandbox/types.ts:100-108` | Add `max(32768)` for memory, `max(16)` for CPU | DONE 2026-03-20 |
| SL-007 | Low | 01-Services | RbacTokenService uses custom result format instead of standard Result | `src/services/rbac-token.service.ts:102-106` | Use standard `Result<T, E>` pattern | DONE 2026-03-20 |
| SL-008 | Low | 01-Services | AgentQueueService is a stub with no implementation | `src/services/agent/agent-queue.service.ts` | Implement or remove stub | |
| SL-015 | Low | 01-Services | SandboxService.checkIdleSandboxes lacks per-sandbox error boundaries | `src/services/sandbox.service.ts:455-479` | Wrap each sandbox check in try/catch | DONE 2026-03-20 |
| SL-019 | Low | 01-Services | TerraformRegistryService uses synchronous transaction | `src/services/terraform-registry.service.ts:237-241` | Use async `db.transaction()` for PostgreSQL compatibility | DONE 2026-03-20 |
| SL-020 | Low | 01-Services | getGlobalDefaultModel is a standalone function, not a service method | `src/services/settings.service.ts:20-33` | Move into SettingsService class | DONE 2026-03-20 |
| AR-001 | Info | 03-API Routes | Middleware stack is well-layered | `src/server/router.ts:195-258` | No action needed | |
| AR-003 | Info | 03-API Routes | Session tokens stored as SHA-256 hash | `src/server/shared.ts:16-18` | No action needed | |
| AR-004 | Info | 03-API Routes | OAuth state parameter CSRF protection | `src/server/routes/auth.ts:36-53,72-79` | No action needed | |
| AR-006 | Info | 03-API Routes | Comprehensive RBAC role guards | `src/server/router.ts:260-342` | No action needed | |
| AR-016 | Info | 03-API Routes | GitHub clone routes properly use argument arrays | `src/server/routes/github.ts:145,301` | No action needed | |
| AR-020 | Info | 03-API Routes | Consistent response envelope pattern | All route files | No action needed | |
| AR-022 | Info | 03-API Routes | Factory pattern with dependency injection | `src/server/router.ts:161-186` | No action needed | |
| AR-025 | Info | 03-API Routes | Conditional route registration for optional features | `src/server/router.ts:416-444` | No action needed | |
| AR-028 | Info | 03-API Routes | Settings allowlist pattern with encryption | `src/server/routes/settings.ts:18-31` | No action needed | |
| CQ-006 | Info | 10-Code Quality | No @ts-ignore or @ts-expect-error in hand-written code | Entire codebase | Excellent | |
| CQ-013 | Info | 10-Code Quality | No circular import issues detected | Entire codebase | No action needed | |
| CQ-014 | Info | 10-Code Quality | Lock file present with frozen-lockfile CI enforcement | `bun.lock`, `.github/workflows/ci.yml` | No action needed | |
| CQ-025 | Info | 10-Code Quality | Strong TypeScript strict mode configuration | `tsconfig.json` | No action needed | |
| CQ-028 | Info | 10-Code Quality | Consistent Result type pattern across service layer | `src/lib/utils/result.ts` | No action needed | |
| DB-019 | Info | 04-Database | Transaction usage is good in RBAC routes | Multiple RBAC route files | Model for other multi-step operations | |
| EH-004 | Info | 08-Error Handling | Result type -- strong adoption (63 files) | `src/lib/utils/result.ts` | No action needed | |
| EH-010 | Info | 08-Error Handling | Zod coverage inventory (29 files with Zod) | Multiple files | Continue expanding coverage | |
| EH-011 | Info | 08-Error Handling | Strict TypeScript config (all strict flags enabled) | `tsconfig.json` | No action needed | |
| EH-015 | Info | 08-Error Handling | Only 3 explicit `: any` annotations in production code | `task-creation.service.ts`, `streams/client.ts`, `use-collection-query.ts` | Excellent discipline | |
| EH-016 | Info | 08-Error Handling | `unknown` usage is appropriate (106 instances) | 30 files | Correct pattern | |
| EH-020 | Info | 08-Error Handling | No empty catch blocks found | Entire codebase | Excellent | |
| EH-023 | Info | 08-Error Handling | API boundary validation is strong | `src/server/validation.ts` | No action needed | |
| EH-024 | Info | 08-Error Handling | Database results not validated at runtime (acceptable for ORM) | Drizzle ORM usage | Acceptable | |
| EH-025 | Info | 08-Error Handling | Path safety validation module for deletion protection | `src/lib/utils/path-safety.ts` | Good defensive measure | |
| EH-026 | Info | 08-Error Handling | ID validation at route boundary via isValidId() | `src/server/shared.ts:69-75` | Consistently applied | |
| RS-017 | Info | 06-Streaming | Agent runner sync/async stdout write differentiation | `agent-runner/src/event-emitter.ts:158-184` | Good design | |
| RS-018 | Info | 06-Streaming | Client-side streams availability gate | `src/lib/streams/client.ts:1351-1364` | Good defensive pattern | |
| SC-001 | Info | 07-Sandbox | Clean provider interface with strong typing | `src/lib/sandbox/providers/sandbox-provider.ts:44-167` | No action needed | |
| SC-003 | Info | 07-Sandbox | AgentCore does not implement SandboxProvider (design decision) | `src/lib/sandbox/providers/agentcore-sandbox-provider.ts:9-11` | Reasonable architecture | |
| SC-004 | Info | 07-Sandbox | Docker multiplexed stream parsing (robust) | `src/lib/sandbox/providers/docker-provider.ts:66-111` | No action needed | |
| SC-005 | Info | 07-Sandbox | Docker container recovery on server restart | `src/lib/sandbox/providers/docker-provider.ts:423-525` | Excellent resilience | |
| SC-008 | Info | 07-Sandbox | CRD-based architecture with controller pattern | `src/lib/sandbox/providers/agent-sandbox-provider.ts`, `sandbox-controller.ts` | No action needed | |
| SC-009 | Info | 07-Sandbox | Pod security standard compliance (restricted) | `src/lib/sandbox/controllers/sandbox-controller.ts:384-400` | Best-practice security | |
| SC-010 | Info | 07-Sandbox | Concurrent creation guard across providers | `agent-sandbox-provider.ts:119-137`, `container-agent.service.ts:838` | Good defense-in-depth | |
| SC-011 | Info | 07-Sandbox | Warm pool with deficit-based reconciliation | `src/lib/sandbox/controllers/sandbox-controller.ts:540-649` | No action needed | |
| SC-012 | Info | 07-Sandbox | Env var injection differs safely between providers | `agent-sandbox-instance.ts:136-173`, `docker-provider.ts:297` | No action needed | |
| SC-013 | Info | 07-Sandbox | Base64-encoded credential writing prevents injection | `src/lib/sandbox/credentials-injector.ts:70-87` | No action needed | |
| SC-015 | Info | 07-Sandbox | Git token credential stripping after clone | `src/lib/sandbox/k8s-workspace-initializer.ts:114-142` | No action needed | |
| SC-016 | Info | 07-Sandbox | Docker containers run as non-root | `docker/Dockerfile.agent-sandbox:74` | No action needed | |
| SC-017 | Info | 07-Sandbox | Workspace path validation in agent-runner | `agent-runner/src/index.ts:377-401` | No action needed | |
| SC-018 | Info | 07-Sandbox | Shell escape consistent across all providers | `docker-provider.ts:261-264`, `agent-sandbox-instance.ts:99-101` | No action needed | |
| SC-019 | Info | 07-Sandbox | Docker bind mount gives rw access to project dir (by design) | `src/lib/sandbox/providers/docker-provider.ts:548` | Mitigated by git worktrees | |
| SC-020 | Info | 07-Sandbox | Two-phase execution architecture in agent-runner | `agent-runner/src/index.ts:444-1160` | No action needed | |
| SC-021 | Info | 07-Sandbox | ExitPlanMode timeout safety mechanism (60s) | `agent-runner/src/index.ts:579-594` | Good defensive programming | |
| SC-022 | Info | 07-Sandbox | Topology tracking for sub-agent visualization | `agent-runner/src/index.ts:92-167` | No action needed | |
| SC-024 | Info | 07-Sandbox | JSON-line protocol for container communication | `agent-runner/src/event-emitter.ts:158-185` | No action needed | |
| SC-025 | Info | 07-Sandbox | Stderr fallback for error events | `src/lib/agents/container-bridge.ts:376-432` | No action needed | |
| SC-026 | Info | 07-Sandbox | Event task/session verification in bridge | `src/lib/agents/container-bridge.ts:346-353` | No action needed | |
| SC-027 | Info | 07-Sandbox | Sandbox auto-creation in startAgent | `src/services/container-agent.service.ts:889-909` | Good UX | |
| SC-028 | Info | 07-Sandbox | Terminal state recovery (tear down and recreate) | `src/services/container-agent.service.ts:872-886` | No action needed | |
| SC-029 | Info | 07-Sandbox | Maximum runtime timeout (2h default, configurable) | `src/services/container-agent.service.ts:1347-1355` | No action needed | |
| SC-030 | Info | 07-Sandbox | TOCTOU guard before exec (refreshStatus) | `src/services/container-agent.service.ts:1303-1315` | No action needed | |
| SC-031 | Info | 07-Sandbox | Stale stop file cleanup before agent start | `src/services/container-agent.service.ts:1132-1142` | No action needed | |
| SC-032 | Info | 07-Sandbox | Docker container validation on list (prunes stale entries) | `src/lib/sandbox/providers/docker-provider.ts:654-686` | No action needed | |
| SC-033 | Info | 07-Sandbox | Comprehensive error catalog for sandbox errors | `src/lib/errors/sandbox-errors.ts` | No action needed | |
| SC-034 | Info | 07-Sandbox | Non-fatal workspace initialization (graceful degradation) | `src/lib/sandbox/k8s-workspace-initializer.ts:1-10,243-276` | No action needed | |
| SC-035 | Info | 07-Sandbox | Global error handlers in agent-runner | `agent-runner/src/index.ts:226-271` | No action needed | |
| SC-036 | Info | 07-Sandbox | Pending plan TTL and cleanup (1h TTL, 5min sweep) | `src/services/container-agent.service.ts:168-172,732-750` | No action needed | |
| SC-039 | Info | 07-Sandbox | Nomad allocation rescheduling handled | `src/lib/sandbox/providers/nomad-sandbox-instance.ts:442-485` | No action needed | |
| SC-040 | Info | 07-Sandbox | AgentCore Dockerfile uses multi-stage build | `docker/Dockerfile.agentcore` | No action needed | |
| SC-041 | Info | 07-Sandbox | Nomad provider best-effort cleanup on creation failure | `src/lib/sandbox/providers/nomad-sandbox-provider.ts:222-229` | No action needed | |
| SL-016 | Info | 01-Services | PlanModeService uses lazy singleton with race condition protection | `src/services/plan-mode.service.ts:75-98` | Well-implemented | |
| SL-018 | Info | 01-Services | SettingsService.setMany uses proper transaction | `src/services/settings.service.ts:171-205` | Model for other services | |
| FC-003 | Info | 05-Frontend | Well-structured feature contexts (properly scoped) | TerraformContext, TopologyContext, CliMonitorContext | No action needed | |
| FC-007 | Info | 05-Frontend | useToast external store pattern well-designed | `src/app/hooks/use-toast.ts` | No action needed | |
| FC-008 | Info | 05-Frontend | useTopologyStream uses rAF batching (good perf) | `src/app/hooks/use-topology-stream.ts:60-80` | No action needed | |
| FC-017 | Info | 05-Frontend | CVA pattern consistently applied | `src/app/components/ui/button.tsx`, `kanban-board/styles.ts` | No action needed | |
| FC-018 | Info | 05-Frontend | Radix UI used correctly for accessible primitives | Multiple UI component files | No action needed | |
=======
| ID | Severity | Review Area | Title | File(s) | Recommendation |
|----|----------|-------------|-------|---------|----------------|
| CB-001 | Critical | 09-Config/Bootstrap | Monolithic api.ts -- 1,848 lines of procedural initialization | `src/server/api.ts` | Extract into structured `ServerBootstrap` class with explicit phases and DI container |
| CB-002 | Critical | 09-Config/Bootstrap | Duplicated migration logic between client and server | `src/server/api.ts`, `src/lib/bootstrap/phases/schema.ts` | Consolidate all migrations into a single `runAllMigrations()` function |
| DB-001 | Critical | 04-Database | N+1 query pattern in ProjectService.listWithSummaries | `src/services/project.service.ts:183-255` | Deprecate N+1 service method; use batch `inArray` queries as in route handler |
| DB-003 | Critical | 04-Database | Missing transactions in agent start flow | `src/services/agent/agent-execution.service.ts:58-255` | Wrap steps 4-9 in `db.transaction()` |
| DB-004 | Critical | 04-Database | Massive dual-database schema drift -- 17 tables missing from PostgreSQL | `src/db/schema/postgres/index.ts` | Bring PG to parity or officially deprecate/remove |
| SL-004 | High | 01-Services | Missing database transactions in multi-step operations | `src/services/agent/agent-execution.service.ts:106-170`, `src/services/task.service.ts:321-410` | Wrap multi-step operations in `db.transaction()` |
| CQ-007 | High | 10-Code Quality | container-agent.service.ts is oversized (3,076 LOC) | `src/services/container-agent.service.ts` | Split into lifecycle, plan, worktree, and AgentCore sub-modules |
| CQ-008 | High | 10-Code Quality | api.ts God File (1,847 LOC) | `src/server/api.ts` | Extract database init, service factory, and sandbox init into separate modules |
| AE-001 | High | 02-Agent Execution | AbortController created but never wired to SDK session | `src/services/agent/agent-execution.service.ts:171`, `src/lib/agents/stream-handler.ts:371-377` | Pass AbortController.signal through StreamHandlerOptions to break stream loop |
| AE-002 | High | 02-Agent Execution | Host-mode execution phase never triggered after plan approval | `src/services/agent/agent-execution.service.ts`, `src/lib/agents/stream-handler.ts` | Add `approvePlan()` method that calls `runAgentExecution()` |
| AR-014 | High | 03-API Routes | Git routes shell command construction via `sh -c` | `src/server/routes/git.ts:49-79,171-172,272-273` | Refactor `commandRunner.exec()` to use argument arrays |
| CB-003 | High | 09-Config/Bootstrap | No formal environment variable validation | `src/server/api.ts:23-41`, `src/lib/env.ts` | Create centralized Zod-based `ServerConfig` schema validated at startup |
| CB-004 | High | 09-Config/Bootstrap | Temporal coupling in service initialization | `src/server/api.ts:446-593` | Use builder/container pattern with topological dependency resolution |
| CB-005 | High | 09-Config/Bootstrap | Sandbox provider initialization has no overall timeout | `src/server/api.ts:782-1427` | Add configurable overall timeout; cap dev retries |
| CB-006 | High | 09-Config/Bootstrap | Graceful shutdown missing service cleanup | `src/server/api.ts:1768-1844` | Add cleanup for DurableStreams, SessionService, AgentService, TaskCreationService |
| CQ-001 | High | 10-Code Quality | Migration try/catch pattern duplicated 9 times in api.ts | `src/server/api.ts:178-348` | Extract `runIdempotentMigration(sqlite, sql, label)` helper |
| CQ-017 | High | 10-Code Quality | 855 bare console.* calls in 120 production files | Multiple (top: `task-creation.service.ts` 118 calls) | Adopt `createLogger` universally; add lint rule to disallow bare console |
| CQ-019 | High | 10-Code Quality | 25 failing tests in client.test.ts | `tests/lib/streams/client.test.ts` | Fix assertion mismatches against refactored DurableStreamsClient API |
| CQ-020 | High | 10-Code Quality | Low coverage thresholds (42-48%) | `vitest.config.ts` | Raise thresholds incrementally toward 70-80% |
| CQ-021 | High | 10-Code Quality | 25 services without tests (incl. 3,076-line container-agent) | Multiple service files | Add tests for critical untested services |
| DB-002 | High | 04-Database | Counting via findMany instead of COUNT(*) | `src/services/agent/agent-crud.service.ts:98-114`, `agent-execution.service.ts:544-549` | Use `db.select({ count: sql\`count(*)\` })` |
| DB-005 | High | 04-Database | Missing FK on terraform_modules.registry_id | `src/db/schema/sqlite/terraform.ts:43` | Add `.references(() => terraformRegistries.id, { onDelete: 'cascade' })` |
| DB-006 | High | 04-Database | Inconsistent timestamp formats (ISO text vs datetime vs epoch integer) | Multiple schema files | Standardize on `new Date().toISOString()` everywhere |
| DB-007 | High | 04-Database | No automatic updatedAt maintenance | All schema files | Add SQLite triggers or Drizzle `$onUpdate`; PG trigger function |
| EH-009 | High | 08-Error Handling | Routes using manual `as` casts instead of Zod validation | `src/server/routes/github.ts`, `task-creation.ts`, `agents.ts` | Add Zod validation to all unvalidated write endpoints |
| FC-009 | High | 05-Frontend | KanbanCard not memoized; inline callbacks defeat memoization | `src/app/components/features/kanban-board/kanban-card.tsx` | Wrap in `React.memo`; pass taskId instead of inline callbacks |
| FC-012 | High | 05-Frontend | Only 3 of 231 components use lazy loading | Multiple component files | Lazy-load React Flow features, large dialogs, and session history |
| FC-013 | High | 05-Frontend | No route-level code splitting despite TanStack Router support | `src/app/router.tsx` | Add `lazy` route definitions for heavy routes |
| FC-022 | High | 05-Frontend | No route loaders used; every navigation shows loading flash | All 49 route files | Add TanStack Router loaders to data-dependent routes |
| RS-007 | High | 06-Streaming | Presence store never cleans up stale users | `src/services/session/session-presence.service.ts`, `session.service.ts:51` | Implement server-side sweep removing users with stale `lastSeen` |
| SL-001 | High | 01-Services | ContainerAgentService is an oversized god class (3,076 LOC) | `src/services/container-agent.service.ts` | Decompose into CrudService, PlanService, BridgeService, RemoteWorkspaceService |
| SL-002 | High | 01-Services | Module-level mutable state in AgentExecutionService | `src/services/agent/agent-execution.service.ts:30` | Move `runningAgents` Map into class as instance field |
| AE-003 | Medium | 02-Agent Execution | Recovery system defines retry logic but never retries | `src/services/agent/agent-execution.service.ts:408-413`, `src/lib/agents/recovery.ts` | Implement retry or remove retry infrastructure; pass actual currentTurn |
| AE-004 | Medium | 02-Agent Execution | State machine not integrated with execution pipeline | `src/lib/state-machines/agent-lifecycle/machine.ts` | Integrate as validation layer before DB writes, or remove |
| AE-007 | Medium | 02-Agent Execution | Hooks created per-run but never enforced in host mode | `src/services/agent/agent-execution.service.ts:201-210` | Wire hooks into stream handler or remove hook creation |
| AE-009 | Medium | 02-Agent Execution | Concurrency check race window | `src/services/agent/agent-execution.service.ts:544-549` | Count all active statuses; use row-level locking |
| AE-011 | Medium | 02-Agent Execution | File tool handlers have no path traversal protection | `src/lib/agents/tools/file-tools.ts` | Add path normalization/validation (currently dead code) |
| AR-002 | Medium | 03-API Routes | Development mode auth bypass is broad | `src/lib/api/auth-middleware.ts:155-181` | Add production guard directly in `getAuthContext()` |
| AR-010 | Medium | 03-API Routes | `requireRole` body parsing side effect | `src/lib/api/rbac-middleware.ts:294-319` | Document overhead; improve non-JSON error handling |
| AR-011 | Medium | 03-API Routes | Three distinct validation approaches (centralized Zod, local Zod, manual) | Multiple route files | Consolidate all validation to `parseJsonBody()` with centralized schemas |
| AR-012 | Medium | 03-API Routes | Workflows POST lacks body validation | `src/server/routes/workflows.ts:75-98` | Add Zod validation using existing `createWorkflowSchema` |
| AR-015 | Medium | 03-API Routes | Git ahead/behind uses shell redirection | `src/server/routes/git.ts:78` | Refactor to use argument arrays |
| AR-027 | Medium | 03-API Routes | Webhook signature verification is optional | `src/server/routes/webhooks.ts:30-41` | Require webhook secret or reject unsigned webhooks with warning |
| AR-031 | Medium | 03-API Routes | Rate limiter is in-memory only | `src/lib/api/rate-limiter.ts` | Document single-instance limitation; plan for Redis-backed limiter |
| AR-032 | Medium | 03-API Routes | Encryption key stored in filesystem alongside database | `src/server/crypto.ts:14` | Consider OS-level key management or env var for key material |
| AR-033 | Medium | 03-API Routes | Project deletion can delete arbitrary directories | `src/server/routes/projects.ts:463-498` | Add path validation at creation time, not just deletion |
| CB-007 | Medium | 09-Config/Bootstrap | Client bootstrap phases all marked recoverable | `src/lib/bootstrap/service.ts:75-83` | Mark `collections` phase as `recoverable: false` |
| CB-008 | Medium | 09-Config/Bootstrap | Config hot reload is dead code | `src/lib/config/hot-reload.ts` | Wire up watcher or remove dead code |
| CB-009 | Medium | 09-Config/Bootstrap | executeWithTimeout leaks timers on success | `src/lib/bootstrap/service.ts:101-121` | Use AbortController or manually clear timer |
| CB-010 | Medium | 09-Config/Bootstrap | Server-side bootstrap error handling is inconsistent | `src/server/api.ts` (multiple locations) | Define explicit fail-fast vs degrade-gracefully policy per phase |
| CB-011 | Medium | 09-Config/Bootstrap | Health check does not reflect full bootstrap state | `src/server/routes/health.ts:40-255` | Add extended check for streams, API key, sandbox init status |
| CB-012 | Medium | 09-Config/Bootstrap | Dev startup script uses SIGKILL for port cleanup | `scripts/start-dev.ts:107` | Use SIGTERM first with timeout, then escalate to SIGKILL |
| CQ-002 | Medium | 10-Code Quality | Error serialization pattern duplicated 150 times | Multiple files | Extract `errorMessage(error: unknown): string` utility | DONE 2026-03-20 |
| CQ-003 | Medium | 10-Code Quality | Route error response boilerplate (456 patterns) / 85 isValidId checks | `src/server/routes/` | Create middleware or shared validator | DONE 2026-03-20 |
| CQ-009 | Medium | 10-Code Quality | task-creation.service.ts has 118 console calls | `src/services/task-creation.service.ts` | Replace with structured logger | DONE 2026-03-20 |
| CQ-010 | Medium | 10-Code Quality | schema.ts contains raw SQL strings duplicating ORM schema | `src/lib/bootstrap/phases/schema.ts` | Consolidate with Drizzle ORM schema definitions | DOCUMENTED 2026-03-20 |
| CQ-015 | Medium | 10-Code Quality | 14 noBannedTypes lint warnings | Multiple files | Replace `{}` and `Function` types with specific alternatives | DONE 2026-03-20 |
| CQ-018 | Medium | 10-Code Quality | 27 TODOs including 9 missing API endpoints | Multiple files | Track in issue tracker; implement missing endpoints | DOCUMENTED 2026-03-20 |
| CQ-022 | Medium | 10-Code Quality | 12 route modules without tests | Multiple route files | Add test coverage for untested routes | DOCUMENTED 2026-03-20 |
| CQ-024 | Medium | 10-Code Quality | No build step, no E2E, no security audit in CI | `.github/workflows/ci.yml` | Add build verification, Playwright E2E, and dependency audit | DONE 2026-03-20 |
| CQ-027 | Medium | 10-Code Quality | 72 raw `throw new Error` bypassing structured error catalog | Multiple files | Replace with typed error catalog entries | DONE 2026-03-20 |
| DB-009 | Medium | 04-Database | No indexes on core lookup columns (sessions, agent_runs, audit_logs) | Multiple schema files | Add indexes for sessions(projectId), agent_runs(agentId), etc. |
| DB-010 | Medium | 04-Database | Hand-rolled SQLite migration system with 12+ SQL constants | `src/lib/bootstrap/phases/schema.ts` | Consolidate to single migration strategy with version tracking |
| DB-011 | Medium | 04-Database | Missing transaction in task move + session create | `src/services/task.service.ts:321-410` | Wrap session insert + task update in transaction |
| DB-012 | Medium | 04-Database | No soft delete pattern; cascade deletes data permanently | Multiple tables | Consider adding `deletedAt` columns for audit trail |
| DB-013 | Medium | 04-Database | agents.currentTaskId and currentSessionId lack FK constraints | `src/db/schema/sqlite/agents.ts:21-22` | Add `.references()` with `onDelete: 'set null'` |
| DB-014 | Medium | 04-Database | cli_sessions uses mixed integer/text timestamp types | `src/db/schema/sqlite/cli-sessions.ts:27-28,37-38` | Standardize to ISO text strings |
| DB-015 | Medium | 04-Database | JSON columns store large blobs without separate tables | `templates`, `marketplaces`, `plan_sessions`, `tasks`, `event_log` | Normalize large blobs; use explicit column selection in queries |
| DB-018 | Medium | 04-Database | persistEvent offset calculation race condition | `src/services/session/session-stream.service.ts:127-170` | Use atomic approach (UPDATE RETURNING or INSERT SELECT) |
| EH-001 | Medium | 08-Error Handling | Spec ErrorCode type outdated (44 codes vs 140+ implementation) | `specs/application/errors/error-catalog.md` | Update spec to cover all 18 error modules |
| EH-005 | Medium | 08-Error Handling | ContainerAgentTrigger uses `unknown` error type | `src/services/task.service.ts:78-79` | Tighten to `Result<void, SandboxError>` |
| EH-007 | Medium | 08-Error Handling | Dual validation system creates confusion | `src/server/validation.ts`, `src/lib/api/validation.ts` | Consolidate to one validation system |
| EH-008 | Medium | 08-Error Handling | Duplicate schema definitions with differing constraints | `src/server/validation.ts`, `src/lib/api/schemas.ts` | Choose one and remove/deprecate the other |
| EH-012 | Medium | 08-Error Handling | `as any` assertions in streams/client.ts and task-creation | `src/lib/streams/client.ts:1443`, `src/services/task-creation.service.ts:483` | Replace with runtime type guards where possible |
| EH-013 | Medium | 08-Error Handling | Risky `as` type assertions in session export formatting | `src/server/routes/sessions.ts:40-53` | Add runtime type guards for `event.data` processing |
| EH-017 | Medium | 08-Error Handling | Route handlers mask service errors in catch blocks | All route files | Use structured logger; expose original error codes |
| EH-019 | Medium | 08-Error Handling | PlanModeService log-and-swallow pattern (10+ catch blocks) | `src/services/plan-mode.service.ts` | Add metric/counter for dropped events |
| EH-022 | Medium | 08-Error Handling | Route catch blocks use console.error instead of structured logger | All route files (50+ occurrences) | Replace with `createLogger` |
| FC-001 | Medium | 05-Frontend | ProjectContext fetches data at root level for all routes | `src/app/providers/project-context.tsx:86-106` | Move to project-related routes or defer fetch |
| FC-004 | Medium | 05-Frontend | Task operations duplicated across route components | `src/app/routes/projects/$projectId/index.tsx` | Extract shared `TaskOperationsContext` or hook |
| FC-005 | Medium | 05-Frontend | useContainerAgent is monolithic (431 lines, 13 handlers) | `src/app/hooks/use-container-agent.ts` | Refactor to `useReducer` |
| FC-006 | Medium | 05-Frontend | Overlapping SSE subscription hooks open duplicate connections | `src/app/hooks/use-session.ts`, `use-container-agent.ts`, `use-agent-stream.ts` | Consolidate into single `useSessionSubscription` with event masks |
| FC-010 | Medium | 05-Frontend | ProjectContext mixes modal state with data state | `src/app/providers/project-context.tsx:170-204` | Split into ProjectDataContext and ProjectPickerContext |
| FC-015 | Medium | 05-Frontend | Custom tabs lack ARIA roles; streaming lacks aria-live | `src/app/components/features/agent-session-view/index.tsx` | Add role="tablist"/tab/aria-selected; add aria-live to streams |
| FC-016 | Medium | 05-Frontend | Keyboard navigation incomplete in list/card components | Multiple component files | Add arrow key navigation to KanbanCard; onKeyDown to ProjectCard |
| FC-020 | Medium | 05-Frontend | TanStack DB barely used; manual fetch patterns dominate | 15+ route components | Evaluate TanStack Query or expand TanStack DB usage |
| RS-001 | Medium | 06-Streaming | Producer pool has no upper bound | `src/lib/streams/caddy-producer.ts:31,106` | Implement LRU eviction or idle-timeout cleanup |
| RS-004 | Medium | 06-Streaming | Schema divergence between durable streams schema and runtime types | `src/lib/integrations/durable-streams/schema.ts`, `src/services/durable-streams.service.ts` | Reconcile or deprecate one schema system |
| RS-006 | Medium | 06-Streaming | No gap detection on reconnect for session streams | `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts` | Fetch full event history on reconnect or track last processed offset |
| RS-008 | Medium | 06-Streaming | No backpressure for high-frequency events | `src/services/durable-streams.service.ts`, `src/lib/streams/caddy-producer.ts` | Add throttling/batching for token events at service layer |
| RS-010 | Medium | 06-Streaming | Shared subscription map cleanup uncertainty | `src/lib/streams/client.ts` (around line 1399+) | Verify cleanup on unsubscribe; add entry eviction |
| RS-011 | Medium | 06-Streaming | useSession hook unbounded array growth | `src/app/hooks/use-session.ts:137-148` | Implement max buffer size or ring buffer |
| RS-013 | Medium | 06-Streaming | Dual-write inconsistency between DB and Caddy | `src/services/durable-streams.service.ts:625-660`, `session-stream.service.ts:43-75` | Standardize on DB-first persistence strategy |
| RS-019 | Medium | 06-Streaming | Caddy SSE endpoints have no authentication | `Caddyfile:13-19` | Add auth middleware to Caddy streams or enforce network-level access |
| SC-006 | Medium | 07-Sandbox | Docker network mode is bridge with no restrictions | `src/lib/sandbox/providers/docker-provider.ts:565` | Add option for `NetworkMode: 'none'` or custom restricted network |
| SC-014 | Medium | 07-Sandbox | OAuth token passed via environment variable | `src/services/container-agent.service.ts:1322-1323` | Document risk; token is written to file with 0o600 immediately |
| SC-023 | Medium | 07-Sandbox | Duplicated agent-runner logic between index.ts and agentcore-handler.ts | `agent-runner/src/index.ts`, `agent-runner/src/agentcore-handler.ts` | Extract shared logic into common module |
| SC-037 | Medium | 07-Sandbox | Tmux session code duplication across three providers | `docker-provider.ts`, `agent-sandbox-instance.ts`, `nomad-sandbox-instance.ts` | Extract tmux operations into shared mixin/utility |
| SC-038 | Medium | 07-Sandbox | AgentCore SigV4 signing is hand-rolled | `src/lib/sandbox/providers/agentcore-sandbox-instance.ts:44-152` | Replace with `@aws-sdk/signature-v4` or official SDK client |
| SL-003 | Medium | 01-Services | Module-level mutable state in SessionService (presenceStore) | `src/services/session.service.ts:51` | Pass via constructor or use injectable PresenceStore class |
| SL-005 | Medium | 01-Services | Inconsistent Result pattern in DurableStreamsService (throws instead of Result) | `src/services/durable-streams.service.ts:520-537,612-660` | Return `err()` values instead of throwing |
| SL-006 | Medium | 01-Services | CliMonitorService bypasses Result pattern entirely | `src/services/cli-monitor/cli-monitor.service.ts` | Wrap public methods in Result types |
| SL-009 | Medium | 01-Services | TaskCreationService is the second-largest service (2,567 LOC) | `src/services/task-creation.service.ts` | Extract Claude SDK interaction into separate service |
| SL-010 | Medium | 01-Services | ProjectService.listWithSummaries performs N+1 queries | `src/services/project.service.ts:183-255` | Use single SQL query with GROUP BY and COUNT |
| SL-011 | Medium | 01-Services | Fire-and-forget promise in WorktreeService.list | `src/services/worktree.service.ts:664-674` | Await deletion or track attempted IDs |
| SL-012 | Medium | 01-Services | Scheduler services use module-level mutable singletons | `src/services/template-sync-scheduler.ts:33-38`, `terraform-sync-scheduler.ts:33-38` | Convert to class-based services |
| SL-013 | Medium | 01-Services | Duplicated GitHub auth resolution pattern (~60 lines) | `src/services/template.service.ts:340-404`, `marketplace.service.ts:280-337` | Extract into shared `resolveOctokit()` utility |
| SL-014 | Medium | 01-Services | TaskService.moveColumn creates sessions directly (bypasses SessionService) | `src/services/task.service.ts:361-381` | Inject SessionService and use `sessionService.create()` |
| SL-017 | Medium | 01-Services | ContainerAgentService has 3 Maps + Set of in-memory state | `src/services/container-agent.service.ts:179-192` | Add startup reconciliation for orphaned tasks |
| AE-005 | Low | 02-Agent Execution | TurnLimiter class defined but never used | `src/lib/agents/turn-limiter.ts` | Integrate into stream handler or remove |
| AE-006 | Low | 02-Agent Execution | executeToolWithHooks exported but never called | `src/lib/agents/stream-handler.ts:963-996` | Document intent for non-SDK mode or remove |
| AE-008 | Low | 02-Agent Execution | Topology subagents orphaned on error | `src/lib/agents/stream-handler.ts:941-959` | Publish topology:agent_completed with status `failed` in catch block |
| AE-010 | Low | 02-Agent Execution | Planning and execution functions share 70% code | `src/lib/agents/stream-handler.ts` | Extract shared `runAgentSession()` function |
| AE-012 | Low | 02-Agent Execution | Resume publishes misleading 'approval:rejected' event name | `src/services/agent/agent-execution.service.ts:509-514` | Use `agent:resumed` or differentiate approval/rejection events |
| AR-005 | Low | 03-API Routes | Session cookie always sets Secure flag (breaks HTTP dev) | `src/server/routes/auth.ts:201-204` | Make Secure conditional on production environment |
| AR-007 | Low | 03-API Routes | RBAC guards use duplicate path patterns (30+ pairs) | `src/server/router.ts:264-269` | Create `useRoleGuard(app, path, role, rbac)` helper |
| AR-008 | Low | 03-API Routes | Team RBAC is handler-level, not middleware | `src/server/routes/teams.ts:251`, `team-members.ts:42` | Document pattern; ensure all team handlers call requireTeamRole |
| AR-009 | Low | 03-API Routes | No RBAC guard on `/api/me` and `/api/invitations` | `src/server/router.ts:458-464` | Document intentional design decision |
| AR-013 | Low | 03-API Routes | `limit` query parameter parsing inconsistency | Multiple route files | Standardize with `parsePagination()` helper |
| AR-017 | Low | 03-API Routes | Filesystem route has no path traversal risk (admin-only, hardcoded dirs) | `src/server/routes/filesystem.ts:14-99` | No action needed |
| AR-018 | Low | 03-API Routes | Dual response helpers (json() and success()/failure()) | `src/server/shared.ts:58-63`, `src/lib/api/response.ts` | Consolidate to one response helper |
| AR-019 | Low | 03-API Routes | Inconsistent error response status codes | Various route files | Review and fix status code fallbacks |
| AR-021 | Low | 03-API Routes | Mixed logging patterns (console.error vs createLogger) | Multiple route files | Adopt structured logger in all routes |
| AR-023 | Low | 03-API Routes | Sandbox routes oversized (1,340+ lines, 15 endpoints) | `src/server/routes/sandbox.ts` | Split into sandbox-configs.ts, sandbox-k8s.ts, sandbox-nomad.ts |
| AR-024 | Low | 03-API Routes | Events routes is largest route module (1,200+ lines) | `src/server/routes/events.ts` | Consider splitting |
| AR-026 | Low | 03-API Routes | CORS origin is single-value only | `src/server/router.ts:197-202` | Document; adjust if multi-frontend needed |
| AR-029 | Low | 03-API Routes | API key service parameter not validated against allowlist | `src/server/routes/api-keys.ts:23-26` | Validate service name against known values |
| AR-030 | Low | 03-API Routes | Global error handler leaks stack in development mode | `src/server/router.ts:466-478` | Acceptable for dev; ensure dev mode not enabled in staging |
| CB-013 | Low | 09-Config/Bootstrap | Config loading requires ANTHROPIC_API_KEY for non-agent ops | `src/lib/config/config-service.ts:59-65` | Move API key check to agent execution time |
| CB-014 | Low | 09-Config/Bootstrap | Secret detection uses pattern matching, not allowlisting | `src/lib/config/validate-secrets.ts` | Low risk; defense-in-depth measure |
| CB-015 | Low | 09-Config/Bootstrap | Bootstrap service does not provide phase timing | `src/lib/bootstrap/service.ts:43-68` | Add `phaseTimings` field to BootstrapState |
| CB-016 | Low | 09-Config/Bootstrap | Global config schema defined but never used | `src/lib/config/schemas.ts:16-22` | Use in validateEnv() or remove |
| CQ-004 | Low | 10-Code Quality | Duplicated logging helpers in container-agent.service.ts | `src/services/container-agent.service.ts:17-37` | Replace with `createLogger` | DONE 2026-03-20 |
| CQ-005 | Low | 10-Code Quality | Commented-out swarm features in 5 files | Multiple files | Track in issue tracker; remove comments | DOCUMENTED 2026-03-20 |
| CQ-011 | Low | 10-Code Quality | Mixed import style (path alias `@/` vs relative) | 249 files with alias, remainder with relative | Document convention per directory | DOCUMENTED 2026-03-20 |
| CQ-012 | Low | 10-Code Quality | Barrel files with wildcard re-exports (38 in schema barrel) | `src/db/schema/sqlite/index.ts` | Monitor for bundle size impact | DOCUMENTED 2026-03-20 |
| CQ-016 | Low | 10-Code Quality | 33 biome-ignore suppressions (all documented) | Multiple files | Acceptable; all justified | DOCUMENTED 2026-03-20 |
| CQ-023 | Low | 10-Code Quality | Frontend code excluded from coverage metrics | `vitest.config.ts` | Consider adding UI unit test coverage tracking | DOCUMENTED 2026-03-20 |
| CQ-026 | Low | 10-Code Quality | 38 `as unknown` casts for DB driver compatibility | Multiple files | Acceptable for DB driver typing | DOCUMENTED 2026-03-20 |
| DB-008 | Low | 04-Database | Redundant index on session_events (offset_idx redundant with unique_offset) | `src/db/schema/sqlite/session-events.ts:23-28` | Remove `session_events_offset_idx` |
| DB-016 | Low | 04-Database | projects.githubInstallationId FK missing CASCADE | `src/db/schema/sqlite/projects.ts:21` | Add `{ onDelete: 'set null' }` |
| DB-017 | Low | 04-Database | Session existence checks before every event persist | `src/services/session/session-stream.service.ts:118-127` | Cache session existence in memory or rely on FK constraint |
| DB-020 | Low | 04-Database | Redundant manual cascade deletion in project delete route | `src/server/routes/projects.ts:450-456` | Remove manual deletes; let CASCADE handle cleanup |
| EH-002 | Low | 08-Error Handling | Spec references non-existent workflow-status.ts module | `specs/application/errors/error-catalog.md` | Update spec to remove reference |
| EH-003 | Low | 08-Error Handling | Error index does not export all 18 error modules | `src/lib/errors/index.ts` | Add missing 4 module exports |
| EH-006 | Low | 08-Error Handling | Result type not used in bootstrap phases | `src/lib/bootstrap/phases/` | Acceptable for startup code |
| EH-014 | Low | 08-Error Handling | Task routes column query param cast without validation | `src/server/routes/tasks.ts:20-26` | Validate against allowed enum values |
| EH-018 | Low | 08-Error Handling | Global error handler exists but is minimal | `src/server/router.ts:466` | Acceptable; routes have own try/catch |
| EH-021 | Low | 08-Error Handling | 30+ bare `catch {}` blocks (without error variable) | Multiple files | Acceptable for optional operations |
| FC-002 | Low | 05-Frontend | Prop drilling in KanbanBoard callback chain (3 levels) | `src/app/routes/projects/$projectId/index.tsx:349-355` | Acceptable depth; callbacks properly memoized |
| FC-011 | Low | 05-Frontend | Sidebar health polling re-renders every 30s unconditionally | `src/app/components/features/sidebar.tsx:111-122` | Compare to previous values before calling setState |
| FC-014 | Low | 05-Frontend | Phosphor icons imported in 114 files | Multiple component files | Audit for unused imports |
| FC-019 | Low | 05-Frontend | Hardcoded hex colors in sidebar; raw Tailwind in features | `src/app/components/features/sidebar.tsx:144-248` | Use CSS custom properties for theme adaptability |
| FC-021 | Low | 05-Frontend | Dashboard uses polling instead of SSE for real-time updates | `src/app/routes/index.tsx:109-168` | Consider SSE for dashboard-level updates |
| RS-002 | Low | 06-Streaming | Duplicate SSE connection tracking (event-bus + CLI monitor) | `src/lib/events/event-bus.ts:7-8`, `cli-monitor.ts:171-174` | Centralize SSE connection tracking |
| RS-003 | Low | 06-Streaming | SSE cleanup race in ping handler | `src/server/routes/events.ts:1286-1306`, `cli-monitor.ts:438-452` | Add guard pattern to CLI monitor (events route already has it) |
| RS-005 | Low | 06-Streaming | Inconsistent event type naming conventions | Various files | Establish and document naming convention |
| RS-009 | Low | 06-Streaming | Three disconnected event delivery systems | System-wide | Document intentional separation |
| RS-012 | Low | 06-Streaming | EventSource cleanup on reconnect (never closed after 5 errors) | `src/lib/cli-monitor/sync.ts:28-112` | Close EventSource when max retries exceeded |
| RS-014 | Low | 06-Streaming | Offset collision retry limited to 3 attempts | `src/services/durable-streams.service.ts:566-598` | Increase retry count or use atomic insert |
| RS-015 | Low | 06-Streaming | CaddyDurableStreamsServer subscribe returns empty iterator (by design) | `src/lib/streams/caddy-producer.ts:142-157` | Document as intentional |
| RS-016 | Low | 06-Streaming | Terraform stream delete/recreate on each request | `src/services/terraform-compose.service.ts:126-138` | Document behavior; consider cleaner handoff |
| SC-002 | Low | 07-Sandbox | DevContainer provider type declared but unimplemented | `src/db/schema/shared/enums.ts:54-60` | Implement DevContainer provider or remove from enum |
| SC-007 | Low | 07-Sandbox | No resource limits validation (no upper bounds on memory/CPU) | `src/lib/sandbox/types.ts:100-108` | Add `max(32768)` for memory, `max(16)` for CPU |
| SL-007 | Low | 01-Services | RbacTokenService uses custom result format instead of standard Result | `src/services/rbac-token.service.ts:102-106` | Use standard `Result<T, E>` pattern |
| SL-008 | Low | 01-Services | AgentQueueService is a stub with no implementation | `src/services/agent/agent-queue.service.ts` | Implement or remove stub |
| SL-015 | Low | 01-Services | SandboxService.checkIdleSandboxes lacks per-sandbox error boundaries | `src/services/sandbox.service.ts:455-479` | Wrap each sandbox check in try/catch |
| SL-019 | Low | 01-Services | TerraformRegistryService uses synchronous transaction | `src/services/terraform-registry.service.ts:237-241` | Use async `db.transaction()` for PostgreSQL compatibility |
| SL-020 | Low | 01-Services | getGlobalDefaultModel is a standalone function, not a service method | `src/services/settings.service.ts:20-33` | Move into SettingsService class |
| AR-001 | Info | 03-API Routes | Middleware stack is well-layered | `src/server/router.ts:195-258` | No action needed |
| AR-003 | Info | 03-API Routes | Session tokens stored as SHA-256 hash | `src/server/shared.ts:16-18` | No action needed |
| AR-004 | Info | 03-API Routes | OAuth state parameter CSRF protection | `src/server/routes/auth.ts:36-53,72-79` | No action needed |
| AR-006 | Info | 03-API Routes | Comprehensive RBAC role guards | `src/server/router.ts:260-342` | No action needed |
| AR-016 | Info | 03-API Routes | GitHub clone routes properly use argument arrays | `src/server/routes/github.ts:145,301` | No action needed |
| AR-020 | Info | 03-API Routes | Consistent response envelope pattern | All route files | No action needed |
| AR-022 | Info | 03-API Routes | Factory pattern with dependency injection | `src/server/router.ts:161-186` | No action needed |
| AR-025 | Info | 03-API Routes | Conditional route registration for optional features | `src/server/router.ts:416-444` | No action needed |
| AR-028 | Info | 03-API Routes | Settings allowlist pattern with encryption | `src/server/routes/settings.ts:18-31` | No action needed |
| CQ-006 | Info | 10-Code Quality | No @ts-ignore or @ts-expect-error in hand-written code | Entire codebase | Excellent |
| CQ-013 | Info | 10-Code Quality | No circular import issues detected | Entire codebase | No action needed |
| CQ-014 | Info | 10-Code Quality | Lock file present with frozen-lockfile CI enforcement | `bun.lock`, `.github/workflows/ci.yml` | No action needed |
| CQ-025 | Info | 10-Code Quality | Strong TypeScript strict mode configuration | `tsconfig.json` | No action needed |
| CQ-028 | Info | 10-Code Quality | Consistent Result type pattern across service layer | `src/lib/utils/result.ts` | No action needed |
| DB-019 | Info | 04-Database | Transaction usage is good in RBAC routes | Multiple RBAC route files | Model for other multi-step operations |
| EH-004 | Info | 08-Error Handling | Result type -- strong adoption (63 files) | `src/lib/utils/result.ts` | No action needed |
| EH-010 | Info | 08-Error Handling | Zod coverage inventory (29 files with Zod) | Multiple files | Continue expanding coverage |
| EH-011 | Info | 08-Error Handling | Strict TypeScript config (all strict flags enabled) | `tsconfig.json` | No action needed |
| EH-015 | Info | 08-Error Handling | Only 3 explicit `: any` annotations in production code | `task-creation.service.ts`, `streams/client.ts`, `use-collection-query.ts` | Excellent discipline |
| EH-016 | Info | 08-Error Handling | `unknown` usage is appropriate (106 instances) | 30 files | Correct pattern |
| EH-020 | Info | 08-Error Handling | No empty catch blocks found | Entire codebase | Excellent |
| EH-023 | Info | 08-Error Handling | API boundary validation is strong | `src/server/validation.ts` | No action needed |
| EH-024 | Info | 08-Error Handling | Database results not validated at runtime (acceptable for ORM) | Drizzle ORM usage | Acceptable |
| EH-025 | Info | 08-Error Handling | Path safety validation module for deletion protection | `src/lib/utils/path-safety.ts` | Good defensive measure |
| EH-026 | Info | 08-Error Handling | ID validation at route boundary via isValidId() | `src/server/shared.ts:69-75` | Consistently applied |
| RS-017 | Info | 06-Streaming | Agent runner sync/async stdout write differentiation | `agent-runner/src/event-emitter.ts:158-184` | Good design |
| RS-018 | Info | 06-Streaming | Client-side streams availability gate | `src/lib/streams/client.ts:1351-1364` | Good defensive pattern |
| SC-001 | Info | 07-Sandbox | Clean provider interface with strong typing | `src/lib/sandbox/providers/sandbox-provider.ts:44-167` | No action needed |
| SC-003 | Info | 07-Sandbox | AgentCore does not implement SandboxProvider (design decision) | `src/lib/sandbox/providers/agentcore-sandbox-provider.ts:9-11` | Reasonable architecture |
| SC-004 | Info | 07-Sandbox | Docker multiplexed stream parsing (robust) | `src/lib/sandbox/providers/docker-provider.ts:66-111` | No action needed |
| SC-005 | Info | 07-Sandbox | Docker container recovery on server restart | `src/lib/sandbox/providers/docker-provider.ts:423-525` | Excellent resilience |
| SC-008 | Info | 07-Sandbox | CRD-based architecture with controller pattern | `src/lib/sandbox/providers/agent-sandbox-provider.ts`, `sandbox-controller.ts` | No action needed |
| SC-009 | Info | 07-Sandbox | Pod security standard compliance (restricted) | `src/lib/sandbox/controllers/sandbox-controller.ts:384-400` | Best-practice security |
| SC-010 | Info | 07-Sandbox | Concurrent creation guard across providers | `agent-sandbox-provider.ts:119-137`, `container-agent.service.ts:838` | Good defense-in-depth |
| SC-011 | Info | 07-Sandbox | Warm pool with deficit-based reconciliation | `src/lib/sandbox/controllers/sandbox-controller.ts:540-649` | No action needed |
| SC-012 | Info | 07-Sandbox | Env var injection differs safely between providers | `agent-sandbox-instance.ts:136-173`, `docker-provider.ts:297` | No action needed |
| SC-013 | Info | 07-Sandbox | Base64-encoded credential writing prevents injection | `src/lib/sandbox/credentials-injector.ts:70-87` | No action needed |
| SC-015 | Info | 07-Sandbox | Git token credential stripping after clone | `src/lib/sandbox/k8s-workspace-initializer.ts:114-142` | No action needed |
| SC-016 | Info | 07-Sandbox | Docker containers run as non-root | `docker/Dockerfile.agent-sandbox:74` | No action needed |
| SC-017 | Info | 07-Sandbox | Workspace path validation in agent-runner | `agent-runner/src/index.ts:377-401` | No action needed |
| SC-018 | Info | 07-Sandbox | Shell escape consistent across all providers | `docker-provider.ts:261-264`, `agent-sandbox-instance.ts:99-101` | No action needed |
| SC-019 | Info | 07-Sandbox | Docker bind mount gives rw access to project dir (by design) | `src/lib/sandbox/providers/docker-provider.ts:548` | Mitigated by git worktrees |
| SC-020 | Info | 07-Sandbox | Two-phase execution architecture in agent-runner | `agent-runner/src/index.ts:444-1160` | No action needed |
| SC-021 | Info | 07-Sandbox | ExitPlanMode timeout safety mechanism (60s) | `agent-runner/src/index.ts:579-594` | Good defensive programming |
| SC-022 | Info | 07-Sandbox | Topology tracking for sub-agent visualization | `agent-runner/src/index.ts:92-167` | No action needed |
| SC-024 | Info | 07-Sandbox | JSON-line protocol for container communication | `agent-runner/src/event-emitter.ts:158-185` | No action needed |
| SC-025 | Info | 07-Sandbox | Stderr fallback for error events | `src/lib/agents/container-bridge.ts:376-432` | No action needed |
| SC-026 | Info | 07-Sandbox | Event task/session verification in bridge | `src/lib/agents/container-bridge.ts:346-353` | No action needed |
| SC-027 | Info | 07-Sandbox | Sandbox auto-creation in startAgent | `src/services/container-agent.service.ts:889-909` | Good UX |
| SC-028 | Info | 07-Sandbox | Terminal state recovery (tear down and recreate) | `src/services/container-agent.service.ts:872-886` | No action needed |
| SC-029 | Info | 07-Sandbox | Maximum runtime timeout (2h default, configurable) | `src/services/container-agent.service.ts:1347-1355` | No action needed |
| SC-030 | Info | 07-Sandbox | TOCTOU guard before exec (refreshStatus) | `src/services/container-agent.service.ts:1303-1315` | No action needed |
| SC-031 | Info | 07-Sandbox | Stale stop file cleanup before agent start | `src/services/container-agent.service.ts:1132-1142` | No action needed |
| SC-032 | Info | 07-Sandbox | Docker container validation on list (prunes stale entries) | `src/lib/sandbox/providers/docker-provider.ts:654-686` | No action needed |
| SC-033 | Info | 07-Sandbox | Comprehensive error catalog for sandbox errors | `src/lib/errors/sandbox-errors.ts` | No action needed |
| SC-034 | Info | 07-Sandbox | Non-fatal workspace initialization (graceful degradation) | `src/lib/sandbox/k8s-workspace-initializer.ts:1-10,243-276` | No action needed |
| SC-035 | Info | 07-Sandbox | Global error handlers in agent-runner | `agent-runner/src/index.ts:226-271` | No action needed |
| SC-036 | Info | 07-Sandbox | Pending plan TTL and cleanup (1h TTL, 5min sweep) | `src/services/container-agent.service.ts:168-172,732-750` | No action needed |
| SC-039 | Info | 07-Sandbox | Nomad allocation rescheduling handled | `src/lib/sandbox/providers/nomad-sandbox-instance.ts:442-485` | No action needed |
| SC-040 | Info | 07-Sandbox | AgentCore Dockerfile uses multi-stage build | `docker/Dockerfile.agentcore` | No action needed |
| SC-041 | Info | 07-Sandbox | Nomad provider best-effort cleanup on creation failure | `src/lib/sandbox/providers/nomad-sandbox-provider.ts:222-229` | No action needed |
| SL-016 | Info | 01-Services | PlanModeService uses lazy singleton with race condition protection | `src/services/plan-mode.service.ts:75-98` | Well-implemented |
| SL-018 | Info | 01-Services | SettingsService.setMany uses proper transaction | `src/services/settings.service.ts:171-205` | Model for other services |
| FC-003 | Info | 05-Frontend | Well-structured feature contexts (properly scoped) | TerraformContext, TopologyContext, CliMonitorContext | No action needed |
| FC-007 | Info | 05-Frontend | useToast external store pattern well-designed | `src/app/hooks/use-toast.ts` | No action needed |
| FC-008 | Info | 05-Frontend | useTopologyStream uses rAF batching (good perf) | `src/app/hooks/use-topology-stream.ts:60-80` | No action needed |
| FC-017 | Info | 05-Frontend | CVA pattern consistently applied | `src/app/components/ui/button.tsx`, `kanban-board/styles.ts` | No action needed |
| FC-018 | Info | 05-Frontend | Radix UI used correctly for accessible primitives | Multiple UI component files | No action needed |
>>>>>>> theirs
