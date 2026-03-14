# AgentPane Task Breakdown

Complete task breakdown with dependencies, priorities, and phase assignments.

---

## Task Legend

- **Priority**: P0 (Critical), P1 (High), P2 (Medium)
- **Status**: `[ ]` Not Started, `[~]` In Progress, `[x]` Complete
- **Dependencies**: Tasks that must complete before this task

---

## Phase 1: Foundation Layer (Weeks 1-3)

### 1.1 Core Utilities

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-001 | Implement Result<T,E> type with ok/err constructors | P0 | - | 1.1 |
| F-002 | Implement isOk/isErr type guards | P0 | F-001 | 1.1 |
| F-003 | Implement map/mapErr transformers | P0 | F-001 | 1.1 |
| F-004 | Implement unwrap/unwrapOr helpers | P0 | F-001 | 1.1 |
| F-005 | Write Result type tests (8 tests) | P0 | F-001 | 1.1 |
| F-006 | Implement deepMerge utility | P1 | - | 1.1 |
| F-007 | Write deepMerge tests (6 tests) | P1 | F-006 | 1.1 |

### 1.2 Error System

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-008 | Create AppError interface and createError function | P0 | F-001 | 1.2 |
| F-009 | Implement ProjectErrors (5 codes) | P0 | F-008 | 1.2 |
| F-010 | Implement TaskErrors (8 codes) | P0 | F-008 | 1.2 |
| F-011 | Implement AgentErrors (7 codes) | P0 | F-008 | 1.2 |
| F-012 | Implement ConcurrencyErrors (3 codes) | P0 | F-008 | 1.2 |
| F-013 | Implement WorktreeErrors (8 codes) | P0 | F-008 | 1.2 |
| F-014 | Implement SessionErrors (4 codes) | P0 | F-008 | 1.2 |
| F-015 | Implement GitHubErrors (8 codes) | P1 | F-008 | 1.2 |
| F-016 | Implement ValidationErrors (4 codes) | P0 | F-008 | 1.2 |
| F-017 | Write error catalog tests (44 tests) | P0 | F-009 to F-016 | 1.2 |

### 1.3 Database Schema

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-018 | Create database enums (6 enums) | P0 | - | 1.3 |
| F-019 | Create projects table schema | P0 | F-018 | 1.3 |
| F-020 | Create tasks table schema | P0 | F-018, F-019 | 1.3 |
| F-021 | Create agents table schema | P0 | F-018, F-019 | 1.3 |
| F-022 | Create agent_runs table schema | P0 | F-020, F-021 | 1.3 |
| F-023 | Create sessions table schema | P0 | F-018, F-019 | 1.3 |
| F-024 | Create worktrees table schema | P0 | F-018, F-019, F-020 | 1.3 |
| F-025 | Create audit_logs table schema | P1 | F-021, F-022, F-020 | 1.3 |
| F-026 | Create github_installations table schema | P1 | F-018 | 1.3 |
| F-027 | Create repository_configs table schema | P1 | F-026 | 1.3 |
| F-028 | Define all Drizzle relations | P0 | F-019 to F-027 | 1.3 |
| F-029 | Create PGlite client initialization | P0 | F-019 to F-028 | 1.3 |
| F-030 | Create database migrations | P0 | F-029 | 1.3 |
| F-031 | Write schema validation tests (15 tests) | P0 | F-030 | 1.3 |

### 1.4 Bootstrap Service

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-032 | Create BootstrapState and BootstrapContext types | P0 | F-008 | 1.4 |
| F-033 | Implement Phase 1: PGlite initialization | P0 | F-029, F-032 | 1.4 |
| F-034 | Implement Phase 2: Schema validation | P0 | F-030, F-033 | 1.4 |
| F-035 | Implement Phase 3: Collections initialization | P0 | F-034 | 1.4 |
| F-036 | Implement Phase 4: Durable Streams connection | P0 | F-035 | 1.4 |
| F-037 | Implement Phase 5: GitHub validation (optional) | P1 | F-015, F-036 | 1.4 |
| F-038 | Implement Phase 6: Default seeding | P1 | F-037 | 1.4 |
| F-039 | Create BootstrapService orchestrator | P0 | F-033 to F-038 | 1.4 |
| F-040 | Create useBootstrap React hook | P0 | F-039 | 1.4 |
| F-041 | Create BootstrapProvider component | P0 | F-040 | 1.4 |
| F-042 | Create BootstrapLoadingUI component | P1 | F-041 | 1.4 |
| F-043 | Create BootstrapErrorUI component | P1 | F-041 | 1.4 |
| F-044 | Write bootstrap tests (12 tests) | P0 | F-039 | 1.4 |

### 1.5 State Machines

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-045 | Define Agent lifecycle states and events | P0 | F-018 | 1.5 |
| F-046 | Implement Agent lifecycle guards | P0 | F-045 | 1.5 |
| F-047 | Implement Agent lifecycle actions | P0 | F-045 | 1.5 |
| F-048 | Create Agent lifecycle machine | P0 | F-045 to F-047 | 1.5 |
| F-049 | Define Task workflow states and events | P0 | F-018 | 1.5 |
| F-050 | Implement Task workflow guards | P0 | F-049 | 1.5 |
| F-051 | Implement Task workflow transitions | P0 | F-049 | 1.5 |
| F-052 | Create Task workflow machine | P0 | F-049 to F-051 | 1.5 |
| F-053 | Define Session lifecycle states and events | P0 | F-018 | 1.5 |
| F-054 | Implement Session lifecycle guards | P0 | F-053 | 1.5 |
| F-055 | Create Session lifecycle machine | P0 | F-053, F-054 | 1.5 |
| F-056 | Define Worktree lifecycle states and events | P0 | F-018 | 1.5 |
| F-057 | Implement Worktree lifecycle guards | P0 | F-056 | 1.5 |
| F-058 | Create Worktree lifecycle machine | P0 | F-056, F-057 | 1.5 |
| F-059 | Write state machine tests (20 tests) | P0 | F-048, F-052, F-055, F-058 | 1.5 |

### 1.6 Configuration

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| F-060 | Define ProjectConfig and GlobalConfig types | P0 | - | 1.6 |
| F-061 | Implement config hierarchy loading | P0 | F-060 | 1.6 |
| F-062 | Implement secret detection validation | P0 | F-060 | 1.6 |
| F-063 | Implement config hot-reload with file watching | P1 | F-061 | 1.6 |
| F-064 | Write configuration tests (8 tests) | P0 | F-060 to F-063 | 1.6 |

---

## Phase 2: Services Layer (Weeks 3-5)

### 2.1 WorktreeService

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| S-001 | Define IWorktreeService interface | P0 | F-029, F-058 | 2.1 |
| S-002 | Implement worktree create (git worktree add) | P0 | S-001 | 2.1 |
| S-003 | Implement worktree remove (git worktree remove) | P0 | S-001 | 2.1 |
| S-004 | Implement worktree prune | P1 | S-001 | 2.1 |
| S-005 | Implement copyEnv helper | P0 | S-001 | 2.1 |
| S-006 | Implement installDeps helper | P0 | S-001 | 2.1 |
| S-007 | Implement runInitScript helper | P1 | S-001 | 2.1 |
| S-008 | Implement commit (stage and commit) | P0 | S-001 | 2.1 |
| S-009 | Implement merge (to target branch) | P0 | S-001 | 2.1 |
| S-010 | Implement getDiff | P0 | S-001 | 2.1 |
| S-011 | Implement getStatus | P0 | S-001 | 2.1 |
| S-012 | Write WorktreeService tests (22 tests) | P0 | S-002 to S-011 | 2.1 |

### 2.2 ProjectService

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| S-013 | Define IProjectService interface | P0 | F-029 | 2.2 |
| S-014 | Implement project create | P0 | S-013 | 2.2 |
| S-015 | Implement project getById | P0 | S-013 | 2.2 |
| S-016 | Implement project list (paginated) | P0 | S-013 | 2.2 |
| S-017 | Implement project update | P0 | S-013 | 2.2 |
| S-018 | Implement project delete | P0 | S-013, S-001 | 2.2 |
| S-019 | Implement updateConfig | P0 | S-013 | 2.2 |
| S-020 | Implement syncFromGitHub | P1 | S-013 | 2.2 |
| S-021 | Implement validatePath | P0 | S-013 | 2.2 |
| S-022 | Implement validateConfig | P0 | S-013 | 2.2 |
| S-023 | Write ProjectService tests (18 tests) | P0 | S-014 to S-022 | 2.2 |

### 2.3 TaskService

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| S-024 | Define ITaskService interface | P0 | F-029, F-052 | 2.3 |
| S-025 | Implement task create | P0 | S-024 | 2.3 |
| S-026 | Implement task getById | P0 | S-024 | 2.3 |
| S-027 | Implement task list (filtered, paginated) | P0 | S-024 | 2.3 |
| S-028 | Implement task update | P0 | S-024 | 2.3 |
| S-029 | Implement task delete | P0 | S-024 | 2.3 |
| S-030 | Implement moveColumn with transition validation | P0 | S-024, F-052 | 2.3 |
| S-031 | Implement reorder (position update) | P0 | S-024 | 2.3 |
| S-032 | Implement getByColumn | P0 | S-024 | 2.3 |
| S-033 | Implement approve (merge worktree) | P0 | S-024, S-009 | 2.3 |
| S-034 | Implement reject (increment count, update reason) | P0 | S-024 | 2.3 |
| S-035 | Implement getDiff | P0 | S-024, S-010 | 2.3 |
| S-036 | Write TaskService tests (24 tests) | P0 | S-025 to S-035 | 2.3 |

### 2.4 SessionService

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| S-037 | Define ISessionService interface | P0 | F-029, F-055 | 2.4 |
| S-038 | Define Durable Streams schema | P0 | S-037 | 2.4 |
| S-039 | Implement session create | P0 | S-037 | 2.4 |
| S-040 | Implement session getById | P0 | S-037 | 2.4 |
| S-041 | Implement session list | P0 | S-037 | 2.4 |
| S-042 | Implement session close | P0 | S-037 | 2.4 |
| S-043 | Implement join (add presence) | P0 | S-037 | 2.4 |
| S-044 | Implement leave (remove presence) | P0 | S-037 | 2.4 |
| S-045 | Implement updatePresence | P0 | S-037 | 2.4 |
| S-046 | Implement getActiveUsers | P0 | S-037 | 2.4 |
| S-047 | Implement publish (to Durable Streams) | P0 | S-037, S-038 | 2.4 |
| S-048 | Implement subscribe (async iterable) | P0 | S-037, S-038 | 2.4 |
| S-049 | Implement getHistory | P0 | S-037 | 2.4 |
| S-050 | Implement generateUrl/parseUrl | P0 | S-037 | 2.4 |
| S-051 | Write SessionService tests (15 tests) | P0 | S-039 to S-050 | 2.4 |

### 2.5 AgentService

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| S-052 | Define IAgentService interface | P0 | F-029, F-048 | 2.5 |
| S-053 | Implement agent create | P0 | S-052 | 2.5 |
| S-054 | Implement agent getById | P0 | S-052 | 2.5 |
| S-055 | Implement agent list (filtered) | P0 | S-052 | 2.5 |
| S-056 | Implement agent update | P0 | S-052 | 2.5 |
| S-057 | Implement agent delete | P0 | S-052 | 2.5 |
| S-058 | Implement start (full execution flow) | P0 | S-052, S-001, S-024, S-037 | 2.5 |
| S-059 | Implement stop (abort execution) | P0 | S-052 | 2.5 |
| S-060 | Implement pause | P0 | S-052 | 2.5 |
| S-061 | Implement resume (with feedback) | P0 | S-052 | 2.5 |
| S-062 | Implement checkAvailability | P0 | S-052 | 2.5 |
| S-063 | Implement queueTask | P1 | S-052 | 2.5 |
| S-064 | Implement getRunningCount | P0 | S-052 | 2.5 |
| S-065 | Implement getQueuedTasks | P1 | S-052 | 2.5 |
| S-066 | Implement pre/post tool use hooks | P0 | S-052 | 2.5 |
| S-067 | Integrate Claude Agent SDK | P0 | S-058 | 2.5 |
| S-068 | Create audit logging for tool calls | P1 | S-067 | 2.5 |
| S-069 | Write AgentService tests (27 tests) | P0 | S-053 to S-068 | 2.5 |

---

## Phase 3: API Layer (Weeks 5-6)

### 3.1 API Infrastructure

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-001 | Create API response wrapper functions | P0 | F-008 | 3.2 |
| A-002 | Create API middleware (error handling, logging) | P0 | A-001 | 3.3 |
| A-003 | Implement cursor-based pagination helpers | P0 | - | 3.4 |
| A-004 | Create Zod validation schemas | P0 | F-016 | 3.5 |
| A-005 | Create validation helper functions | P0 | A-004 | 3.5 |
| A-006 | Implement rate limiting | P1 | - | 3.11 |

### 3.2 Project Endpoints

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-007 | GET /api/projects (list) | P0 | S-016, A-003 | 3.6 |
| A-008 | POST /api/projects (create) | P0 | S-014, A-004 | 3.6 |
| A-009 | GET /api/projects/:id | P0 | S-015 | 3.6 |
| A-010 | PATCH /api/projects/:id | P0 | S-017, A-004 | 3.6 |
| A-011 | DELETE /api/projects/:id | P0 | S-018 | 3.6 |
| A-012 | POST /api/projects/:id/sync | P1 | S-020 | 3.6 |
| A-013 | Write project endpoint tests (8 tests) | P0 | A-007 to A-012 | 3.6 |

### 3.3 Task Endpoints

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-014 | GET /api/tasks (list, filtered) | P0 | S-027, A-003 | 3.7 |
| A-015 | POST /api/tasks (create) | P0 | S-025, A-004 | 3.7 |
| A-016 | GET /api/tasks/:id | P0 | S-026 | 3.7 |
| A-017 | PATCH /api/tasks/:id | P0 | S-028, A-004 | 3.7 |
| A-018 | DELETE /api/tasks/:id | P0 | S-029 | 3.7 |
| A-019 | POST /api/tasks/:id/move | P0 | S-030, A-004 | 3.7 |
| A-020 | POST /api/tasks/:id/approve | P0 | S-033, A-004 | 3.7 |
| A-021 | POST /api/tasks/:id/reject | P0 | S-034, A-004 | 3.7 |
| A-022 | Write task endpoint tests (12 tests) | P0 | A-014 to A-021 | 3.7 |

### 3.4 Agent Endpoints

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-023 | GET /api/agents (list, filtered) | P0 | S-055 | 3.8 |
| A-024 | POST /api/agents (create) | P0 | S-053, A-004 | 3.8 |
| A-025 | GET /api/agents/:id | P0 | S-054 | 3.8 |
| A-026 | PATCH /api/agents/:id | P0 | S-056, A-004 | 3.8 |
| A-027 | DELETE /api/agents/:id | P0 | S-057 | 3.8 |
| A-028 | POST /api/agents/:id/start | P0 | S-058, A-004 | 3.8 |
| A-029 | POST /api/agents/:id/stop | P0 | S-059 | 3.8 |
| A-030 | GET /api/agents/:id/status | P0 | S-054, S-064 | 3.8 |
| A-031 | Write agent endpoint tests (10 tests) | P0 | A-023 to A-030 | 3.8 |

### 3.5 Session Endpoints

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-032 | GET /api/sessions (list) | P0 | S-041 | 3.9 |
| A-033 | POST /api/sessions (create) | P0 | S-039, A-004 | 3.9 |
| A-034 | GET /api/sessions/:id | P0 | S-040 | 3.9 |
| A-035 | GET /api/sessions/:id/stream (SSE) | P0 | S-048 | 3.9 |
| A-036 | GET /api/sessions/:id/history | P0 | S-049 | 3.9 |
| A-037 | POST /api/sessions/:id/close | P0 | S-042 | 3.9 |
| A-038 | GET/POST /api/sessions/:id/presence | P0 | S-045, S-046, A-004 | 3.9 |
| A-039 | Write session endpoint tests (8 tests) | P0 | A-032 to A-038 | 3.9 |

### 3.6 Webhook Endpoints

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| A-040 | POST /api/webhooks/github | P1 | S-020 | 3.10 |
| A-041 | Implement webhook signature verification | P1 | A-040 | 3.10 |
| A-042 | Handle push event (config sync) | P1 | A-040, S-020 | 3.10 |
| A-043 | Handle installation events | P2 | A-040 | 3.10 |
| A-044 | Write webhook tests (5 tests) | P1 | A-040 to A-043 | 3.10 |

---

## Phase 4: UI Layer (Weeks 6-8)

### 4.1 Design System

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-001 | Configure Tailwind with design tokens | P0 | - | 4.1 |
| U-002 | Create CSS variables (light/dark themes) | P0 | U-001 | 4.1 |
| U-003 | Create cn() utility function | P0 | - | 4.1 |

### 4.2 Primitive Components

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-004 | Implement Button component with CVA | P0 | U-003 | 4.2 |
| U-005 | Implement Dialog component (Radix) | P0 | U-003 | 4.2 |
| U-006 | Implement Tabs component (Radix) | P0 | U-003 | 4.2 |
| U-007 | Implement DropdownMenu component (Radix) | P0 | U-003 | 4.2 |
| U-008 | Implement Tooltip component (Radix) | P1 | U-003 | 4.2 |
| U-009 | Implement Checkbox component (Radix) | P1 | U-003 | 4.2 |
| U-010 | Implement Select component (Radix) | P0 | U-003 | 4.2 |
| U-011 | Implement TextInput component | P0 | U-003 | 4.2 |
| U-012 | Implement Textarea component | P0 | U-003 | 4.2 |
| U-013 | Implement Skeleton component | P0 | U-003 | 4.3 |
| U-014 | Write primitive component tests (12 tests) | P0 | U-004 to U-013 | 4.2 |

### 4.3 Kanban Components

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-015 | Implement KanbanBoard with dnd-kit | P0 | U-004, U-013 | 4.4 |
| U-016 | Implement KanbanColumn | P0 | U-015 | 4.4 |
| U-017 | Implement KanbanCard with CVA variants | P0 | U-015 | 4.4 |
| U-018 | Implement drag-drop handling | P0 | U-015 | 4.4 |
| U-019 | Write KanbanBoard tests (8 tests) | P0 | U-015 to U-018 | 4.4 |

### 4.4 Feature Components

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-020 | Implement ApprovalDialog | P0 | U-005, U-006 | 4.4 |
| U-021 | Implement diff view tab | P0 | U-020 | 4.4 |
| U-022 | Implement files changed tab | P0 | U-020 | 4.4 |
| U-023 | Implement approve/reject actions | P0 | U-020 | 4.4 |
| U-024 | Write ApprovalDialog tests (6 tests) | P0 | U-020 to U-023 | 4.4 |
| U-025 | Implement AgentSessionView | P0 | U-006 | 4.4 |
| U-026 | Implement stream output display | P0 | U-025 | 4.4 |
| U-027 | Implement tool calls tab | P0 | U-025 | 4.4 |
| U-028 | Implement terminal tab | P0 | U-025 | 4.4 |
| U-029 | Implement pause/resume/stop controls | P0 | U-025 | 4.4 |
| U-030 | Write AgentSessionView tests (5 tests) | P0 | U-025 to U-029 | 4.4 |
| U-031 | Implement TaskDetailDialog | P0 | U-005, U-011, U-012 | 4.4 |
| U-032 | Implement NewProjectDialog | P0 | U-005, U-011 | 4.4 |
| U-033 | Implement path validation UI | P0 | U-032 | 4.4 |
| U-034 | Implement ProjectPicker | P0 | U-007 | 4.4 |
| U-035 | Implement ToastNotifications | P1 | U-003 | 4.4 |
| U-036 | Implement Breadcrumbs | P1 | U-003 | 4.4 |

### 4.5 Real-Time Hooks

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-037 | Implement useSession hook | P0 | A-035 | 4.5 |
| U-038 | Implement useAgentStream hook | P0 | A-035 | 4.5 |
| U-039 | Implement usePresence hook | P0 | A-038 | 4.5 |
| U-040 | Write real-time hooks tests (8 tests) | P0 | U-037 to U-039 | 4.5 |

### 4.6 Page Routes

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| U-041 | Create root layout with providers | P0 | F-041 | 4.6 |
| U-042 | Implement Dashboard page (/) | P0 | U-041 | 4.6 |
| U-043 | Implement Projects list page (/projects) | P0 | U-041 | 4.6 |
| U-044 | Implement Project kanban page (/projects/:id) | P0 | U-015, U-031 | 4.6 |
| U-045 | Implement Task detail page (/projects/:id/tasks/:id) | P1 | U-044 | 4.6 |
| U-046 | Implement Agents list page (/agents) | P0 | U-041 | 4.6 |
| U-047 | Implement Agent detail page (/agents/:id) | P1 | U-046 | 4.6 |
| U-048 | Implement Session view page (/sessions/:id) | P0 | U-025 | 4.6 |
| U-049 | Create route loaders for data fetching | P0 | U-042 to U-048 | 4.6 |
| U-050 | Write page route tests (10 tests) | P0 | U-042 to U-049 | 4.6 |

---

## Phase 5: Testing (Parallel)

### 5.1 Test Infrastructure

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| T-001 | Configure Vitest for unit tests | P0 | - | 5.1 |
| T-002 | Configure Vitest for E2E tests | P0 | - | 5.1 |
| T-003 | Create test database helpers | P0 | F-029 | 5.2 |
| T-004 | Create test factories (6 factories) | P0 | T-003 | 5.3 |
| T-005 | Create service mocks | P0 | - | 5.4 |
| T-006 | Create external API mocks (Claude SDK, GitHub) | P0 | - | 5.4 |
| T-007 | Create git command mocks | P0 | - | 5.4 |

### 5.2 Integration Tests

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| T-008 | Write worktree integration tests | P1 | S-012 | 5.7 |
| T-009 | Write full workflow integration test | P0 | S-069, S-036 | 5.7 |
| T-010 | Write rejection/retry integration test | P0 | T-009 | 5.7 |

### 5.3 E2E Tests

| ID | Task | Priority | Dependencies | Phase Doc |
|----|------|----------|--------------|-----------|
| T-011 | Set up Playwright for E2E | P0 | - | 5.8 |
| T-012 | E2E-001: Create project from local path | P0 | U-032 | 5.8 |
| T-013 | E2E-002: Create task in backlog | P0 | U-015 | 5.8 |
| T-014 | E2E-003: Drag task starts agent | P0 | U-018, S-058 | 5.8 |
| T-015 | E2E-004: Agent completes moves task | P0 | T-014 | 5.8 |
| T-016 | E2E-005: Approval dialog shows diff | P0 | U-020 | 5.8 |
| T-017 | E2E-006: Approve merges changes | P0 | U-023 | 5.8 |
| T-018 | E2E-007: Task moves to verified | P0 | T-017 | 5.8 |
| T-019 | E2E: Agent session real-time output | P0 | U-025 | 5.8 |
| T-020 | E2E: Pause/resume/stop controls | P0 | U-029 | 5.8 |

---

## Task Count Summary

| Phase | Tasks | Priority P0 | Priority P1 | Priority P2 |
|-------|-------|-------------|-------------|-------------|
| Phase 1: Foundation | 64 | 52 | 11 | 1 |
| Phase 2: Services | 69 | 63 | 6 | 0 |
| Phase 3: API | 44 | 38 | 5 | 1 |
| Phase 4: UI | 50 | 44 | 6 | 0 |
| Phase 5: Testing | 20 | 17 | 3 | 0 |
| **Total** | **247** | **214** | **31** | **2** |

---

## Critical Path

The following tasks form the critical path and should not be delayed:

```
F-001 (Result) → F-008 (Errors) → F-029 (PGlite) → F-039 (Bootstrap)
                                         ↓
                              S-001 (WorktreeService)
                                         ↓
                   S-024 (TaskService) ←→ S-052 (AgentService)
                                         ↓
                              A-028 (POST /agents/:id/start)
                                         ↓
                              U-015 (KanbanBoard)
                                         ↓
                              U-044 (Project Kanban Page)
                                         ↓
                              T-014 (E2E: Drag task starts agent)
```

---

## Dependency Graph (Key Paths)

```
┌─────────────────────────────────────────────────────────────────┐
│                      FOUNDATION LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  F-001 Result ──┬──► F-008 Errors ──► F-009-F-016 Error Codes   │
│                 │                                                │
│                 └──► F-018 Enums ──► F-019-F-028 Schema         │
│                                            │                     │
│                                            ▼                     │
│                                      F-029 PGlite                │
│                                            │                     │
│                      F-032 Types ──► F-033-F-038 Phases         │
│                                            │                     │
│                                            ▼                     │
│                                      F-039 Bootstrap             │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SERVICES LAYER                              │
├─────────────────────────────────────────────────────────────────┤
│  S-001 WorktreeService ◄────────────────────────────────────┐   │
│            │                                                 │   │
│            ▼                                                 │   │
│  S-013 ProjectService                                        │   │
│            │                                                 │   │
│            ▼                                                 │   │
│  S-024 TaskService ◄──────────────────────────────────────┐ │   │
│            │                                               │ │   │
│            ▼                                               │ │   │
│  S-037 SessionService                                      │ │   │
│            │                                               │ │   │
│            ▼                                               │ │   │
│  S-052 AgentService ──────────────────────────────────────┼─┘   │
│            │                                               │     │
│            └───────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API LAYER                                   │
├─────────────────────────────────────────────────────────────────┤
│  A-001-A-006 Infrastructure                                      │
│            │                                                     │
│            ▼                                                     │
│  A-007-A-044 Endpoints (29 total)                               │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      UI LAYER                                    │
├─────────────────────────────────────────────────────────────────┤
│  U-001-U-003 Design System                                       │
│            │                                                     │
│            ▼                                                     │
│  U-004-U-014 Primitives                                         │
│            │                                                     │
│            ▼                                                     │
│  U-015-U-036 Feature Components                                 │
│            │                                                     │
│            ▼                                                     │
│  U-041-U-050 Page Routes                                        │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      TESTING                                     │
├─────────────────────────────────────────────────────────────────┤
│  T-001-T-007 Infrastructure (parallel with all phases)          │
│  T-008-T-010 Integration Tests (after services)                 │
│  T-011-T-020 E2E Tests (after UI)                               │
└─────────────────────────────────────────────────────────────────┘
```
