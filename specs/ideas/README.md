# AgentPane Product Roadmap

**Last Updated:** 2026-03-18
**Based On:** Feb 2026 Architecture Review (148 findings), Codebase Analysis (5 dimensions), Specification Gap Analysis

---

## Executive Summary

AgentPane is a multi-agent task management platform at **~65% overall maturity**. The core agent execution engine (planning, approval, execution), database schema (43 tables, Drizzle ORM), container sandbox (Docker/K8s/Nomad/AgentCore — 4 providers), and real-time streaming (Durable Streams + SSE) are strong foundations. However, significant gaps in **task transition enforcement**, **observability**, **queue management**, and **accessibility** prevent it from being production-grade.

This roadmap organizes ~25 initiatives across 4 priority tiers following the principle: **Safety > Correctness > Features > Polish**.

### Current State Scorecard

| Dimension | Score | Assessment |
|-----------|-------|------------|
| Agent Execution Engine | 7/10 | Strong lifecycle with enforced state machines, but abort signal disconnected, resume broken, race conditions |
| Database & Data Layer | 6/10 | Well-normalized 43-table schema, but missing transactions, dual-schema drift, no migrations strategy |
| Frontend & UX | 6/10 | Solid Kanban/streaming UI, 191 components, but accessibility concentrated in few components, hardcoded URLs |
| Security & Auth | 6/10 | GitHub OAuth + 4-role RBAC in place, but auth middleware bypassed in dev, tokens unvalidated |
| Container Sandbox | 8/10 | 4 providers (Docker/K8s/Nomad/AgentCore) all working, but OAuth token exposed in env, no network policy |
| Observability | 3/10 | Structured logger exists, health checks exist, CLI monitor has cost/token dashboard. No infrastructure metrics, no tracing, 720 raw console.* calls |
| Testing | 4/10 | Vitest setup with 74% coverage threshold, but no tests for critical paths (stream-handler, agent-execution), frontend excluded |
| API Quality | 6/10 | 187 Hono endpoints across 33 route modules, but N+1 queries, route handlers bypass service layer |
| Real-Time Streaming | 8/10 | Durable Streams + SSE well-integrated, client handles reconnection and replay |
| Terraform Composer | 9/10 | Fully functional compose pipeline with code extraction, multi-turn chat, registry integration |

**Overall: ~6.5/10** — Strong foundations, significant gaps before production readiness.

---

## Priority Tiers

### Tier Legend

| Tier | Philosophy | Timeframe |
|------|-----------|-----------|
| **P0 — Safety & Correctness** | Fix things that can cause data loss, security holes, or silent failures | Weeks 1-4 |
| **P1 — Core Completions** | Finish what's started; fill gaps that block real usage | Weeks 3-8 |
| **P2 — Competitive Differentiators** | Build what no competitor has; enterprise requirements | Weeks 6-14 |
| **P3 — Polish & Scale** | Accessibility, performance, DX improvements | Weeks 10-18 |

---

## P0 — Safety & Correctness

These initiatives address bugs and gaps that can cause data loss, security vulnerabilities, or silent failures in the current codebase.

---

### P0-1: Wire AbortController Signal to Agent SDK

**Problem:** `stop()` calls `controller.abort()` but the signal is never passed to the Claude Agent SDK session. Agents continue running after being "stopped", consuming API credits and potentially making unwanted changes.

**Evidence:** `src/services/agent/agent-execution.service.ts:171-172,455` — AbortController created but signal not passed to `runAgentPlanning()` or `runAgentExecution()`. `src/lib/agents/stream-handler.ts:122-128` — SDK session created without signal parameter. (Finding AE-001, High)

**Solution:** Pass `AbortController.signal` to both planning and execution stream functions. Wire into the SDK session creation or use to break the stream processing loop. Add abort acknowledgment event to session stream.

**Effort:** Small (1-2 days)
**Impact:** Critical — prevents runaway agent execution and credit burn
**Dependencies:** None

---

### P0-2: Fix Agent Resume / Plan Approval Execution Gap

**Problem:** `resume()` sets agent status to `running` but does not actually restart SDK session execution. After planning completes and user approves the plan, there is no code path that starts the execution phase for host-mode agents. The agent appears to be running but is doing nothing.

**Evidence:** `src/services/agent/agent-execution.service.ts:494-522` — `resume()` only updates DB status. `src/server/routes/tasks.ts:259-281` — `approvePlan` endpoint has no host-mode execution path. (Finding AE-007, High)

**Solution:** In `resume()`, create a new SDK session via `runAgentExecution()` with the approved plan. Add a host-mode execution path in the `approvePlan` endpoint that mirrors the container-mode flow. Publish `agent:execution_started` event.

**Effort:** Medium (3-5 days)
**Impact:** Critical — without this, the entire planning → approval → execution flow is broken for host-mode agents
**Dependencies:** P0-1 (abort signal should be wired before adding new execution paths)

---

### P0-3: Eliminate Race Condition in Agent Start

**Problem:** Task is moved to `in_progress` before worktree and session are created. Concurrent `start()` calls can both pass the concurrency check (TOCTOU race). If worktree creation fails after task move, the task is orphaned in `in_progress` with no agent.

**Evidence:** `src/services/agent/agent-execution.service.ts:96-106,108-127` — task moved at line 106, worktree created at 108, session at 118. No transaction wrapping. (Finding AE-002, High)

**Solution:** Wrap the entire start sequence in a database transaction. Move task to `in_progress` only after all resources (worktree, session, agent_run) are created. Use optimistic locking on the concurrency count check.

**Effort:** Medium (2-3 days)
**Impact:** Critical — prevents orphaned tasks and concurrency limit bypass
**Dependencies:** P0-8 (transaction infrastructure)

---

### P0-4: Validate Authentication Tokens Against Database

**Problem:** Auth middleware in dev mode always succeeds with `local-dev` user. Even with tokens, no database validation is performed — any string is accepted as a valid Bearer token or session cookie. The `X-Dev-User` header allows arbitrary impersonation.

**Evidence:** `src/lib/api/auth-middleware.ts:108-135` — dev mode bypass. `src/lib/api/auth-middleware.ts:77-81,101-105` — token accepted without verification. `src/server/router.ts:81-97` — middleware wiring. (Findings BA-002 High, CC-004 Medium, CC-010 Medium)

**Solution:** Pass real validator callbacks to `getAuthContext()` that check Bearer tokens against the `api_keys` table and session cookies against `user_sessions`. Require explicit `SKIP_AUTH=true` env var for dev bypass. Log a startup warning when auth is bypassed. Add per-request audit logging.

**Effort:** Medium (3-4 days)
**Impact:** Critical — current state means any request is authenticated in production
**Dependencies:** None

---

### P0-5: Add Transaction Boundaries to Multi-Step Operations

**Problem:** Multi-step database operations run without transactions. `moveColumn()` creates a session then updates the task without a transaction. Project deletion can leave orphaned data on partial failure. Only `SettingsService.setMany()` uses transactions.

**Evidence:** `src/services/task.service.ts:321-410,584-643` — moveColumn without transaction. `src/server/routes/projects.ts:417-424` — project deletion without transaction. (Findings DB-003 High, BA-013 Medium)

**Solution:** Wrap all multi-step DB operations in `db.transaction()`. Priority targets: task column moves, agent start sequence, project deletion, session creation with events. Use outbox pattern for operations mixing DB writes with external side effects.

**Effort:** Medium (3-5 days)
**Impact:** High — prevents data corruption from partial failures
**Dependencies:** None

---

### P0-6: Fix Concurrency Count to Include Starting/Planning Agents

**Problem:** `getRunningCount()` only queries agents with status `running`, missing `starting` and `planning` agents. This means the concurrency limit can be exceeded — if 3 agents are in `planning` state, a 4th can start because none are technically `running`.

**Evidence:** `src/services/agent/agent-execution.service.ts:544-550` — `inArray` filter only includes `running`. (Finding AE-008, Medium)

**Solution:** Include `starting`, `planning`, and `running` in the `inArray` filter for running count. Consider also including `paused` if those agents hold worktree resources.

**Effort:** Small (1 hour)
**Impact:** High — prevents resource exhaustion and API credit burn
**Dependencies:** None

---

### P0-7: Secure Container OAuth Token Exposure

**Problem:** OAuth tokens are passed via environment variables to Docker containers, making them visible via `docker inspect` or Kubernetes pod specs. The agent-runner also logs token presence to stderr.

**Evidence:** `src/services/container-agent.service.ts:1239` — token in env var. `agent-runner/src/index.ts:79,203-204` — token read from env, logged. (Findings CS-001 Medium, CS-013 Low)

**Solution:** Use Docker secrets (or K8s Secrets mounted as file volumes) instead of environment variables. Mount credentials file to a tmpfs volume. Remove token logging from agent-runner. Add file permissions check on credentials file.

**Effort:** Medium (2-3 days)
**Impact:** High — prevents credential exposure in multi-tenant environments
**Dependencies:** None

---

## P1 — Core Completions

These initiatives complete partially-built systems and fill gaps that block real-world usage.

---

### P1-1: Implement Agent Queue Service

**Problem:** The agent queue service is a complete stub — `queueTask()` always returns `QUEUE_FULL`, `getQueuePosition()` returns `null`, `getQueueStats()` returns empty stats. When concurrency limits are hit, tasks cannot be queued for later execution.

**Evidence:** `src/services/agent/agent-queue.service.ts` — all methods return stub values. Spec at `specs/application/services/agent-service.md:319-328` documents the stub status. Queue UI component spec exists at `specs/application/components/queue-waiting-state.md`.

**Solution:** Implement a priority queue backed by the database (not in-memory, for crash recovery). When a task moves to `in_progress` but no agent is available, move it to the `queued` column. When an agent completes, dequeue the next task. Track queue position, estimated wait time (based on recent agent completion times), and provide real-time updates via SSE.

**Effort:** Large (5-8 days)
**Impact:** High — without queuing, users must manually retry when agents are busy
**Dependencies:** P0-3 (race condition fix), P0-6 (accurate concurrency count)

---

### P1-2: Fix Permissive Task Column Transitions

**Problem:** The formal state machines (agent lifecycle, session lifecycle, worktree lifecycle) ARE properly enforced with guard validation in `src/lib/state-machines/*/machine.ts`. However, **task column transitions** are completely permissive — `task-transitions.ts` allows movement from any column to any other column (except self). This means tasks can jump from `verified` back to `backlog` or from `backlog` directly to `verified`, bypassing the intended workflow. Additionally, the error catalog defines a conflicting stricter transition map.

**Evidence:** `src/services/task-transitions.ts:13-19` — `VALID_TRANSITIONS` maps every column to all other columns. `src/lib/errors/task-errors.ts:5-9` — defines a different, stricter set of transitions. `src/lib/state-machines/task-workflow/machine.ts` — proper machine exists but `task-transitions.ts` is what `taskService.moveColumn()` actually uses. (Finding BA-006, Medium)

**Solution:** Replace the permissive `VALID_TRANSITIONS` map in `task-transitions.ts` with the strict transitions from the task workflow state machine (backlog → in_progress → waiting_approval → verified, with reject paths). Remove the duplicate transition map from the error catalog. Route all task column changes through the state machine's `transition()` function. Add transition audit logging.

**Effort:** Medium (3-5 days)
**Impact:** High — prevents illegal state transitions that cause UI confusion and data corruption
**Dependencies:** None

---

### P1-3: Build Observability Foundation (Metrics + Tracing)

**Problem:** No metrics collection, no distributed tracing, no alerting. The monitoring spec is comprehensive (planned) but nothing is implemented beyond structured logging (25 usages) and health checks. Meanwhile, 720 raw `console.*` calls across 89 files bypass the structured logger.

**Evidence:** `specs/application/operations/monitoring.md` — Implementation Status table shows Metrics Collection, Distributed Tracing, Alerting, and Dashboards all "Planned". No `lib/observability/` directory exists. 720 `console.*` calls vs 25 structured logger usages. (Finding CC-001, High)

**Solution:**
Phase A (Weeks 1-2): Adopt `no-console` lint rule via Biome. Migrate high-traffic files (api.ts with 34 calls, task-creation.service.ts with 117 lines) to `createLogger()`. Propagate request IDs to service layer via AsyncLocalStorage.
Phase B (Weeks 3-4): Add OpenTelemetry for request tracing. Instrument agent execution with spans (start → plan → approve → execute → complete). Add basic Prometheus-compatible metrics: agent starts, completions, errors, turn counts, queue depth, API latency histograms.

**Effort:** Large (8-12 days across two phases)
**Impact:** High — without observability, production incidents are black boxes
**Dependencies:** None (but P1-5 cost dashboard builds on this)

---

### P1-4: Test Critical Agent Execution Paths

**Problem:** The two most complex and critical files in the codebase — `stream-handler.ts` (Claude SDK integration) and `agent-execution.service.ts` (agent lifecycle management) — have zero dedicated test coverage. Frontend code is entirely excluded from coverage. Integration tests test local helpers, not the actual Hono server.

**Evidence:** `vitest.config.ts:40-41` — `src/app/` excluded from coverage. No test files for stream-handler or agent-execution-service. `tests/server/api-integration.test.ts` — 1500 lines testing helpers, not server. Coverage thresholds at 74/64/80/74, below spec target of 80/80/80/80. (Findings TI-002 High, TI-005 High, TI-004 Medium, TI-001 Medium)

**Solution:**
1. Create integration tests for `stream-handler.ts` using existing `createPlanningStream()`/`createExecutionStream()` helpers — test the full planning → plan_ready → approval → execution flow
2. Create integration tests for `agent-execution.service.ts` — test start, stop, pause, resume, error recovery, concurrency checks
3. Remove `src/app/` coverage exclusion; create separate coverage profile for frontend
4. Refactor `api-integration.test.ts` to use Hono's `app.request()` for real server testing
5. Add E2E tests to CI pipeline

**Effort:** Large (8-10 days)
**Impact:** High — these paths handle the core business logic and have the most failure modes
**Dependencies:** P0-2 (resume must work before it can be tested)

---

### P1-5: Build Cost Attribution Dashboard

**Problem:** Cost tracking exists in the CLI monitor with a hardcoded Sonnet pricing model ($3/$15 per MTok applied to all models regardless of actual model used — Opus is 5x more expensive). The `session_summaries` table tracks `tokensUsed` and `costUsd`, and the CLI monitor dashboard shows cost/token breakdowns per session. However, there's no per-project or per-task cost attribution, no budget alerts, and no model-aware pricing. Enterprise requirement #1 for multi-agent platforms.

**Evidence:** `src/app/components/features/cli-monitor/cli-monitor-utils.ts:30-35` — hardcoded Sonnet pricing for all models. `session_summaries` table has `tokensUsed`, `costUsd`, `cacheReadTokens`, `cacheCreationTokens` columns. CLI monitor summary strip shows total cost. No project-level or task-level cost aggregation. (Findings CM-001 Medium, CM-004 Medium)

**Solution:**
1. Create a model pricing registry (`src/lib/pricing/model-pricing.ts`) with per-model input/output/cache token rates
2. Add cost calculation to session summary aggregation — compute cost after each agent turn
3. Add `estimatedCost` column to `agent_runs` table
4. Build cost dashboard component showing: cost by project (bar chart), cost by agent (table), cost trend over time (line chart), budget alerts (configurable thresholds)
5. Add cost data to project summary API endpoint

**Effort:** Large (6-8 days)
**Impact:** High — required for enterprise adoption and cost governance
**Dependencies:** P1-3 (metrics foundation for tracking)

---

### P1-6: Consolidate Migration Strategy

**Problem:** Migrations are fragmented across three systems: Drizzle Kit (partial), hand-written SQL in bootstrap phases (427 lines), and embedded SQL constants. No rollback capability. No version tracking. Indexes defined in bootstrap SQL aren't in Drizzle schema, so Drizzle Kit doesn't know about them.

**Evidence:** `src/lib/bootstrap/phases/schema.ts:7-427` — 420+ lines of hand-written migrations. `src/db/migrations/meta/_journal.json:1-13` — Drizzle Kit journal. Bootstrap has 5 repeated try/catch blocks checking for duplicate columns by string matching. (Findings DB-002 High, CC-006 Low, DB-008 Medium)

**Solution:** Consolidate on Drizzle Kit as the single migration strategy. Move all hand-written migrations into numbered Drizzle migration files. Move index definitions into Drizzle schema files. Implement a version tracking table (`schema_migrations`) that records applied migrations. Add rollback support for the last N migrations.

**Effort:** Large (5-7 days)
**Impact:** Medium — prevents migration failures and makes schema changes predictable
**Dependencies:** None

---

### P1-7: Fix Dual Schema Drift (SQLite ↔ PostgreSQL)

**Problem:** SQLite and PostgreSQL schemas are maintained as separate file trees with no synchronization mechanism. Several columns have already drifted: `sandbox_provider`, `sandbox_container_id`, and session summary metrics exist in one but not the other.

**Evidence:** `src/db/schema/sqlite/sessions.ts:22-23` vs `src/db/schema/postgres/sessions.ts:1-27` — differing column sets. (Finding DB-001, High)

**Solution:** Either (a) generate the PostgreSQL schema from the SQLite schema as a single source of truth using a codegen step, or (b) drop PostgreSQL support if it's untested and add it back properly later. If keeping dual support, add a CI check that compares column sets between the two schema directories. The dual-database spec at `specs/roadmap/dual-database.md` outlines the target architecture.

**Effort:** Medium (3-5 days)
**Impact:** Medium — prevents production failures when switching DB modes
**Dependencies:** P1-6 (migration consolidation)

---

### P1-8: Move Route Handler Logic to Service Layer

**Problem:** Multiple route handlers bypass the service layer, executing direct DB queries and shell commands. This makes the business logic untestable (routes are harder to unit test than services), duplicates concerns, and creates inconsistency.

**Evidence:** `src/server/routes/projects.ts:1-489` — direct DB queries. `src/server/routes/settings.ts:1-127` — direct DB access. `src/server/routes/git.ts:1-453` — shell commands via string interpolation. N+1 query in `/api/projects/summaries` producing 70 queries for 10 projects. (Findings BA-007 Medium, BA-003 Medium, BA-014 Medium)

**Solution:** Move all DB access and shell commands to the service layer. Route handlers should only: validate input, call service method, format response. Replace string-interpolated shell commands in git routes with array-based `Bun.spawn()` execution. Replace N+1 query patterns with single aggregation queries using `GROUP BY` and `JOIN`.

**Effort:** Large (6-8 days)
**Impact:** Medium — enables proper testing and eliminates command injection vectors
**Dependencies:** None

---

## P2 — Competitive Differentiators

These initiatives build capabilities that differentiate AgentPane from competitors and address enterprise requirements.

---

### P2-1: Team Mode — Parallel Sub-Agent Execution

**Problem:** Team mode (parallel sub-agents working concurrently on different parts of a plan) is documented in CLAUDE.md and has significant infrastructure already built: `parentAgentId` on agents table, topology tracking for subagent visualization (`TopologyTracker` handling `task_started`, `task_progress`, `task_notification` SDK events), and full agent topology UI components. However, the swarm orchestration fields in `ExitPlanModeOptions` are commented out with `TODO: Pending GA` — no logic exists to actually spawn subagents from the `launchSwarm` option.

**Evidence:** `src/lib/agents/stream-handler.ts:21-30` — swarm fields commented out. Lines 136-261 — `TopologyTracker` and subagent event handling fully implemented. `src/app/components/features/agent-topology/` — 11 files for topology visualization. `parentAgentId` column exists. (Finding AE-005, Medium)

**Solution:**
1. When planning agent calls `ExitPlanMode` with `launchSwarm: true`, create N sub-agent records with `parentAgentId` set to the planning agent
2. Create isolated worktrees for each sub-agent (branch from the planning worktree)
3. Start each sub-agent with its portion of the plan as the prompt
4. Stream events from all sub-agents to a unified parent session view
5. When all sub-agents complete, merge their worktree branches and move parent task to `waiting_approval`
6. UI: show sub-agent progress cards in the session view, with individual streaming and status

**Effort:** Very Large (12-18 days)
**Impact:** Very High — unique differentiator, enables tackling complex tasks 3-5x faster
**Dependencies:** P0-1 (abort signal), P0-2 (resume/execution flow), P0-3 (race condition fix), P1-2 (state machine enforcement)

---

### P2-2: GitHub PR Automation — Agent to Deployment

**Problem:** GitHub integration is extensive — token management with encryption (`GitHubTokenService`, 606 lines), issue creation (`issue-creator.ts`, 263 lines), repo operations (list, clone, create from template), webhook handling, and event pipeline integration all exist. However, the critical loop from agent completion to pull request is not closed. No `createPullRequest()` method exists. After an agent finishes work in a worktree, the user must manually create the PR.

**Evidence:** `src/services/github-token.service.ts` — full token management with encryption, team-aware resolution, Octokit client. `src/lib/github/issue-creator.ts` — issue creation/update. No PR creation service. Worktree service creates branches but doesn't push them.

**Solution:**
1. Add `pushBranch(worktreeId)` to worktree service — push the agent's branch to the remote
2. Create `GitHubPRService` with `createPR(taskId)` — uses Octokit to create a PR with: title from task, body from agent's plan + summary, branch from worktree, labels from task tags
3. Add `prUrl` and `prNumber` columns to tasks table
4. Add "Create PR" button to task detail dialog (waiting_approval state)
5. Optionally: auto-create PR when agent completes (configurable per project)
6. Webhook handler for PR merge → auto-move task to `verified` column

**Effort:** Large (6-10 days)
**Impact:** Very High — closes the agent → code → review → deploy loop
**Dependencies:** None (GitHub infra already exists)

---

### P2-3: Interactive Terminal — Bidirectional I/O During Execution

**Problem:** When agents encounter `AskUserQuestion` calls, there's no mechanism for the user to respond through the UI. The interactive sessions roadmap (`specs/roadmap/interactive-sessions.md`) proposes a file-based input mechanism, but no terminal-like interaction exists for real-time agent communication.

**Evidence:** `specs/roadmap/interactive-sessions.md` — architecture spec exists but not implemented. Container agents can emit `waiting_input` events but cannot receive responses. No xterm.js or PTY integration.

**Solution:**
Phase A: Implement file-based AskUserQuestion flow (per roadmap spec) — agent emits `waiting_input` event, UI displays question with options, user selects answer, API writes response file, agent reads and continues.
Phase B: Add xterm.js-based terminal component for real-time agent interaction. Use WebSocket for bidirectional communication. Allow users to type follow-up instructions while agent is running.

**Effort:** Very Large (10-14 days across two phases)
**Impact:** High — enables human-in-the-loop workflows and complex agent tasks
**Dependencies:** P0-2 (resume flow must work)

---

### P2-4: Audit Logging for Compliance

**Problem:** Tool call audit logging IS implemented — `src/lib/agents/hooks/audit.ts` creates post-tool-use hooks that write to the `audit_logs` table with agent/task/project context, tool name, input/output JSON, duration, and turn number. However, there's no audit trail for **user actions** (login, project create/delete, task move, agent start/stop, settings changes, permission changes). No route-level audit middleware. No compliance reporting or export.

**Evidence:** `src/lib/agents/hooks/audit.ts` — tool call audit hook implemented. `src/db/schema/sqlite/audit-logs.ts` — table with full schema. No middleware-level user action logging. No audit log viewer UI. No export capability.

**Solution:**
1. Create `AuditService` with `log(action, resource, details, userId)` method for user actions (tool call auditing already works)
2. Add audit middleware to Hono that logs all mutating API calls (POST, PUT, PATCH, DELETE) with authenticated user context
3. Add audit log viewer UI in project settings (filterable by action type, user, date range)
4. Add audit log export (CSV/JSON) for compliance teams
5. Implement retention policy (configurable, default 90 days)
6. Add audit event types: `user.login`, `project.create/delete`, `task.move`, `agent.start/stop`, `settings.change`, `member.add/remove`

**Effort:** Large (6-8 days)
**Impact:** High — required for enterprise compliance (SOC 2, ISO 27001)
**Dependencies:** P1-3 (structured logging foundation)

---

### P2-5: Scheduled Task Execution (Cron Agents)

**Problem:** The scheduler service spec exists (`specs/application/services/scheduler-service.md`), event sources and schedule execution tables exist in the schema, and cron configuration types are defined, but the scheduler is not implemented. Users cannot schedule recurring agent tasks (e.g., nightly code reviews, weekly dependency updates).

**Evidence:** `src/db/schema/sqlite/event-sources.ts`, `src/db/schema/sqlite/schedule-executions.ts` — tables defined. `src/db/schema/shared/cron-config.ts` — CronBudgetConfig, CronEventSourceConfig interfaces defined. No `scheduler.service.ts` implementation file.

**Solution:**
1. Implement `SchedulerService` with cron expression parsing (use `cron-parser` or similar)
2. Create scheduler loop that checks for due tasks every 60 seconds
3. When a schedule fires: create a task from the schedule template, move to `in_progress`, trigger agent start
4. Budget limits: max cost per schedule per day/week/month (uses cost tracking from P1-5)
5. UI: schedule management in project settings with cron expression builder
6. Execution history view showing past runs with status and cost

**Effort:** Large (8-10 days)
**Impact:** High — enables autonomous agent operations without human trigger
**Dependencies:** P1-1 (queue service for when agents are busy), P1-5 (cost tracking for budget limits)

---

### P2-6: Plugin Marketplace Foundation

**Problem:** A `marketplaces` table exists in the schema and a plugin system is referenced in the sandbox phase 2 roadmap (`specs/roadmap/phase2-sandbox-plugins.md`), but no plugin infrastructure exists. Custom tools, custom prompts, and workflow templates are all hardcoded.

**Evidence:** `src/db/schema/sqlite/marketplaces.ts` — table defined. `specs/roadmap/phase2-sandbox-plugins.md` — architecture spec exists. Agent-runner has unused tool registry (`agent-runner/src/tools/index.ts`). (Finding CS-004, Low)

**Solution:**
1. Define plugin interface: `AgentPanePlugin { name, version, tools?, prompts?, workflows?, hooks? }`
2. Create plugin loader that reads from `~/.agentpane/plugins/` directory
3. Allow plugins to register custom tools (exposed to agents via tool whitelist)
4. Allow plugins to register custom prompt templates (shown in prompt registry)
5. Plugin marketplace UI for discovering and installing community plugins
6. Security: plugins run in sandboxed context, no direct DB access

**Effort:** Very Large (12-16 days)
**Impact:** Medium — extends platform capabilities without core changes
**Dependencies:** P1-2 (state machine enforcement for plugin lifecycle)

---

## P3 — Polish & Scale

These initiatives improve accessibility, performance, developer experience, and prepare for horizontal scaling.

---

### P3-1: Accessibility Overhaul

**Problem:** Accessibility is inconsistent across the frontend. There are ~177 ARIA attributes and ~42 role attributes, but they're concentrated in a few well-implemented components (session-detail-view, replay-controls, new-task-dialog) while 70%+ of components have zero ARIA attributes. The ThemeToggle lacks ARIA attributes, focus trapping, and keyboard navigation. `window.confirm()` is used in 7 locations for destructive actions. No dedicated accessibility utilities or hooks exist. No `aria-describedby`, `aria-labelledby`, or `aria-controls` attributes found anywhere.

**Evidence:** Theme toggle: `src/app/components/features/theme-toggle.tsx:56-98` — no ARIA. 7 `window.confirm()` usages across routes. `src/app/routes/index.tsx:467-472` — missing aria-label. (Findings FE-003 Medium, FE-005 Medium, FE-015 Low)

**Solution:**
1. Replace all `window.confirm()` with a reusable `ConfirmDialog` component using existing Radix `AlertDialog`
2. Replace ThemeToggle custom dropdown with Radix `DropdownMenu`
3. Add `aria-label`, `aria-describedby`, `role` attributes to all interactive elements
4. Add skip navigation link to main layout
5. Add focus management for dialog open/close, route transitions, and dynamic content
6. Add keyboard navigation for Kanban board (arrow keys to move between cards/columns)
7. Run axe-core automated accessibility audit, fix all violations

**Effort:** Large (6-8 days)
**Impact:** Medium — required for government/enterprise customers, ethical obligation
**Dependencies:** None

---

### P3-2: Frontend Performance Optimization

**Problem:** Dashboard fires 4 API calls sequentially in `useEffect` (waterfall). Polling at 15s even when tab is hidden. `DurableStreamsClient` is 1100+ lines with 18 near-identical switch cases. Hardcoded API base URL prevents deployment.

**Evidence:** `src/app/routes/index.tsx:150-207` — sequential API calls. `src/app/routes/index.tsx:239` — no visibility-based pause. `src/lib/streams/client.ts` — 1106 lines. `src/lib/api/client.ts:12` — hardcoded `http://localhost:3001`. (Findings FE-006 Medium, FE-001 High, FE-008 Low, FE-012 Info)

**Solution:**
1. **Fix hardcoded API URL** (P0-adjacent priority): Read from `import.meta.env.VITE_API_URL` or derive from `window.location.origin`
2. Parallelize dashboard API calls with `Promise.all` or TanStack Router's `loader` for prefetching
3. Pause polling when tab is hidden using `visibilitychange` event listener
4. Refactor DurableStreamsClient to use a registry/map pattern instead of switch cases (~400 lines reduction)
5. Add `tailwind-merge` to `cn()` utility for proper class conflict resolution

**Effort:** Medium (4-6 days)
**Impact:** Medium — better UX, enables deployment to non-localhost environments
**Dependencies:** None

---

### P3-3: Decompose God Modules

**Problem:** Several files are oversized monoliths that are hard to navigate, test, and maintain. `api.ts` is 1,419 lines mixing DB init, migrations, service wiring, sandbox init, and shutdown. `task-creation.service.ts` is 2,544 lines. `container-agent.service.ts` is 2,244 lines.

**Evidence:** `src/server/api.ts:1-1418` — god module. `src/services/task-creation.service.ts` — 2,544 lines. `src/services/container-agent.service.ts` — 2,244 lines. (Findings PS-010 Medium, PS-011 Medium, CC-009 Medium, BA-001 Medium)

**Solution:**
1. Extract `api.ts` into: `bootstrap/database.ts`, `bootstrap/services.ts`, `bootstrap/sandbox-provider.ts`, `bootstrap/shutdown.ts`
2. Extract `InMemoryDurableStreamsServer` (120 lines) from `api.ts` into own file
3. Decompose `task-creation.service.ts` into: validation, AI interaction, persistence, notification sub-modules
4. Decompose `container-agent.service.ts` into: lifecycle, sandbox-management, event-bridge, plan-management sub-modules

**Effort:** Large (5-7 days)
**Impact:** Medium — improves maintainability and testability
**Dependencies:** P1-4 (add tests first, then refactor with confidence)

---

### P3-4: Centralize Environment & Configuration Validation

**Problem:** 82 raw `process.env.*` accesses across 28 files with no validation. Settings stored as JSON without schema validation — corrupt settings cause runtime crashes. No `.env.example` file documenting required variables. Environment variable filter for agent SDK uses denylist-by-exclusion pattern.

**Evidence:** `src/server/api.ts:22-52`, `src/lib/env.ts`, 25 more files — raw env access. No `.env.example` file. `src/services/terraform-compose.service.ts:401-408` — denylist env filter. (Findings CC-002 Medium, CC-005 Low, PS-013 Medium, PT-008 Medium)

**Solution:**
1. Create `src/lib/config/server-env.ts` with Zod schema validating all env vars at startup
2. Create `.env.example` documenting all env vars with descriptions, defaults, and required/optional status
3. Add Zod schemas for each settings key; validate on read and write
4. Invert agent SDK env filter to allowlist: only pass `ANTHROPIC_API_KEY`, `PATH`, `HOME`, `LANG`

**Effort:** Medium (3-4 days)
**Impact:** Medium — prevents runtime crashes from missing/corrupt config
**Dependencies:** None

---

### P3-5: Clean Up Project Hygiene

**Problem:** Multiple housekeeping issues that individually are low-priority but collectively create friction: stale build artifacts committed, package name mismatch, dual lock files, `.DS_Store` files tracked, stale Dependabot patterns, irrelevant MCP config, empty directories, stale root-level files.

**Evidence:** Findings PS-001 (stale timestamps), PS-002 (empty dirs), PS-004 (wrong package name), PS-007 (stale dependabot), PS-009 (irrelevant .mcp.json), PS-012 (.DS_Store), PS-014 (stale worktree), BA-015 (unused SSETokenService), CM-003 (wrong repo URLs). All Low severity.

**Solution:** Single cleanup PR addressing all items:
1. Add `*.timestamp_*.js` to `.gitignore`, remove from repo
2. Update package name to `@agentpane/app`
3. Remove `package-lock.json`, keep only `bun.lock`
4. Remove tracked `.DS_Store` files with `git rm --cached`
5. Update Dependabot patterns for Biome
6. Remove/update `.mcp.json`
7. Remove empty `bob/` dir, stale `CONTINUITY.md`, `SPEC_UPDATES.md`, root HTML prototypes
8. Remove unused `SSETokenService` (431 lines)
9. Fix CLI monitor package.json repository URLs

**Effort:** Small (1-2 days)
**Impact:** Low — reduces noise, improves onboarding experience
**Dependencies:** None

---

### P3-6: Container Network Security

**Problem:** Docker containers have unrestricted network access — agents can make arbitrary network requests to any destination. No egress filtering, no network policy.

**Evidence:** `docker/docker-compose.yml` and `src/lib/sandbox/providers/docker-provider.ts` — no network restrictions. (Finding CS-007, Medium)

**Solution:**
1. Create dedicated Docker network with restricted egress
2. Allow only: Anthropic API (api.anthropic.com), GitHub API (api.github.com), configured registries
3. For K8s: define NetworkPolicy restricting pod egress
4. Make egress allowlist configurable per project (some agents need npm registry access, etc.)

**Effort:** Medium (3-4 days)
**Impact:** Medium — critical for multi-tenant and enterprise deployments
**Dependencies:** None

---

### P3-7: Eliminate Code Duplication

**Problem:** Several pieces of logic are duplicated between server and client, leading to bug-fix-in-two-places problems. HCL extraction logic duplicated. Clarifying question parsers duplicated with divergent behavior. Theme application logic in 3 files. `mapToCompactNodeType` in 2 locations.

**Evidence:** `src/services/terraform-compose.service.ts:713-767` vs `src/app/components/features/terraform/terraform-context.tsx:100-153` — HCL extraction. Two divergent clarifying question parsers. Three theme application locations. (Findings PT-004 Medium, PT-005 Medium, PT-006 Medium, FE-009 Low)

**Solution:**
1. Extract HCL/Stacks extraction to `src/lib/terraform/extract-code.ts` (shared)
2. Extract clarifying question parser to `src/lib/terraform/parse-questions.ts` (shared, use client version as canonical)
3. Extract theme application to `src/app/hooks/use-theme.ts`
4. Extract `mapToCompactNodeType` to `src/lib/workflow-dsl/node-types.ts`

**Effort:** Medium (2-3 days)
**Impact:** Low-Medium — prevents divergent behavior and reduces maintenance burden
**Dependencies:** None

---

### P3-8: Workspace Configuration & Build Pipeline

**Problem:** Three independent packages (root, agent-runner, cli-monitor) with no formal workspace configuration. No `"workspaces"` in root `package.json`, causing inconsistent installs. CI pipeline runs lint/typecheck/tests but never runs `bun run build` — build breaks can ship.

**Evidence:** `package.json:1-120` — no workspaces. `agent-runner/package.json:1-26` — independent. `.github/workflows/ci.yml:1-75` — no build step. (Findings PS-003 High, PS-006 High)

**Solution:**
1. Add `"workspaces": ["packages/*", "agent-runner"]` to root `package.json`
2. Consolidate to single lock file
3. Add `build` job to CI that runs full build pipeline
4. Add Docker build verification and smoke test to CI
5. Add E2E test job to CI (start dev server, run Playwright)

**Effort:** Medium (3-5 days)
**Impact:** Medium — prevents broken builds shipping and simplifies dependency management
**Dependencies:** None

---

## Phase Timeline

```
Week  1-2:  P0-1 (abort signal), P0-4 (auth validation), P0-6 (concurrency count)
Week  2-4:  P0-2 (resume flow), P0-3 (race condition), P0-5 (transactions), P0-7 (token security)
Week  3-6:  P1-2 (state machine enforcement), P1-3 Phase A (logging migration)
Week  5-8:  P1-1 (queue service), P1-4 (test critical paths), P1-3 Phase B (metrics + tracing)
Week  6-10: P1-5 (cost dashboard), P1-6 (migration consolidation), P1-8 (service layer refactor)
Week  8-12: P2-1 (team mode), P2-2 (GitHub PR automation)
Week 10-14: P2-3 (interactive terminal), P2-4 (audit logging), P2-5 (scheduled tasks)
Week 12-18: P3-1 (accessibility), P3-2 (frontend perf), P3-3 (decompose god modules)
Week 14-18: P3-4 (env validation), P3-5 (hygiene), P3-6 (network security), P3-7 (deduplication), P3-8 (workspaces)
```

Note: Timelines assume 1-2 engineers. Many P3 items can be parallelized or tackled opportunistically.

---

## Success Metrics

| Metric | Current | Target (Post-P0) | Target (Post-P1) | Target (Post-P2) |
|--------|---------|-------------------|-------------------|-------------------|
| Agent stop actually stops execution | No | Yes | Yes | Yes |
| Plan approval triggers execution | No (host-mode) | Yes | Yes | Yes |
| Illegal state transitions rejected | 0% | 100% | 100% | 100% |
| Auth tokens validated against DB | No | Yes | Yes | Yes |
| Multi-step operations transactional | 1 of ~15 | ~15 of 15 | All | All |
| Agent queue functional | No | No | Yes | Yes |
| Structured logger adoption | 3% (25/720) | 50%+ | 90%+ | 95%+ |
| Test coverage (lines) | 74% | 74% | 80%+ | 85%+ |
| Test coverage (branches) | 64% | 64% | 75%+ | 80%+ |
| Critical path test coverage | 0% | 0% | 80%+ | 90%+ |
| Cost tracking accuracy | Partial (Sonnet-only pricing) | Partial | Per-model accurate | Per-model + budgets |
| ARIA attributes | ~177 (concentrated) | ~177 | ~177 | 400+ (distributed) |
| Console.* calls | 720 | 400 | 50 | 0 |
| N+1 query patterns | 2+ known | 2 | 0 | 0 |
| Team mode (parallel agents) | Stub | Stub | Stub | Working |
| PR automation | None | None | None | Working |
| Scheduled agents | None | None | None | Working |

---

## Dependency Graph

```
P0-1 (abort) ──────────┐
P0-2 (resume) ─────────┤
P0-3 (race condition) ──┼──> P2-1 (team mode)
P0-6 (concurrency) ────┘        │
        │                        v
        └──> P1-1 (queue) ──> P2-5 (scheduled tasks)
                                 │
P1-3 (observability) ──> P1-5 (cost dashboard) ──> P2-5
                    │
                    └──> P2-4 (audit logging)

P1-6 (migrations) ──> P1-7 (dual schema)

P1-4 (tests) ──> P3-3 (decompose modules)

P0-2 (resume) ──> P2-3 (interactive terminal)

(All other initiatives have no blocking dependencies)
```

---

## Cross-References

| Document | Relationship |
|----------|--------------|
| [Architecture Review Findings Matrix](../reviews/2026-02-architecture/FINDINGS-MATRIX.md) | Source of 148 findings driving prioritization |
| [Agent Service Spec](../application/services/agent-service.md) | Queue stub status, execution flow |
| [Agent Lifecycle State Machine](../application/state-machines/agent-lifecycle.md) | Transition table and guards |
| [Monitoring Spec](../application/operations/monitoring.md) | Planned observability architecture |
| [Interactive Sessions Roadmap](../roadmap/interactive-sessions.md) | P2-3 architecture reference |
| [Dual Database Roadmap](../roadmap/dual-database.md) | P1-7 target architecture |
| [Sandbox Plugins Roadmap](../roadmap/phase2-sandbox-plugins.md) | P2-6 reference |
| [Database Schema](../application/database/schema.md) | 43-table schema reference |
| [Error Catalog](../application/errors/error-catalog.md) | 44 error codes |
| [Test Cases](../application/testing/test-cases.md) | 164+ test case definitions |
