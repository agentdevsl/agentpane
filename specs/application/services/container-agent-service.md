# ContainerAgentService Specification

## Overview

The ContainerAgentService orchestrates Claude Agent SDK execution inside isolated sandbox containers (Docker, Kubernetes, Nomad) and AWS Bedrock AgentCore runtimes. It manages the full lifecycle of containerized agent processes, including two-phase execution (planning then execution), plan approval workflows, real-time event streaming via stdout bridging, and graceful cancellation via sentinel files.

The service supports two distinct execution paths:

- **Container exec path** (Docker / K8s / Nomad): Runs the `agent-runner` Node.js process inside a sandbox container, captures JSON-line events from stdout, and bridges them to DurableStreams.
- **AgentCore invoke path** (AWS Bedrock): Invokes an AgentCore runtime via HTTP, consumes SSE events, and bridges them to DurableStreams using `AgentCoreBridge`.

**Implementation:** `src/services/container-agent.service.ts`

---

## Related Wireframes

- [Agent Session View](../wireframes/agent-session-view.html) - Real-time agent output
- [Error State Expanded](../wireframes/error-state-expanded.html) - Error handling and retry UI

---

## Container Execution Flow

When a task is started, the service progresses through six stages. Each stage publishes a `container-agent:status` event so the UI can display progress breadcrumbs.

```
initializing -> validating -> credentials -> creating_sandbox -> executing -> running
```

### Stages

| Stage | Description |
|-------|-------------|
| `initializing` | Validate configuration, check for existing running agent |
| `validating` | Verify project exists, resolve agent config (model, maxTurns) |
| `credentials` | Retrieve OAuth token from database or environment |
| `creating_sandbox` | Ensure sandbox container is running, create worktree |
| `executing` | Start agent-runner process inside container |
| `running` | Agent is actively working, streaming events |

```typescript
type ContainerAgentStage =
  | 'initializing'
  | 'validating'
  | 'credentials'
  | 'creating_sandbox'
  | 'executing'
  | 'running';
```

---

## Two-Phase Execution

The service implements a plan-then-execute workflow:

### Planning Phase (`phase: 'plan'`)

1. Agent runs with `permissionMode: 'plan'` in the Claude Agent SDK
2. Agent explores the codebase and creates an implementation plan
3. Agent calls `ExitPlanMode` tool when the plan is ready
4. Agent-runner emits `agent:plan_ready` event via stdout
5. ContainerBridge fires `onPlanReady` callback
6. Plan is stored in-memory (`pendingPlans` map) and persisted to the `tasks` table (`plan`, `planOptions` columns)
7. Task moves to `waiting_approval` on the Kanban board
8. Agent status set to `planning`

### Plan Approval

- `approvePlan(taskId)`: Validates plan exists, detects sandbox changes since planning, moves task to `in_progress`, starts execution phase
- `rejectPlan(taskId, reason?)`: Clears plan data, moves task to `backlog`, cleans up worktree

### Execution Phase (`phase: 'execute'`)

1. Agent runs with `permissionMode: 'bypassPermissions'`
2. If the sandbox container has not changed since planning, the SDK session is resumed via `sdkSessionId` (conversation history preserved)
3. If the sandbox was replaced, a fresh session is created with the full plan text as prompt
4. On completion, task moves to `waiting_approval`

---

## Interface Definition

```typescript
export type AgentPhase = 'plan' | 'execute';

export interface StartAgentInput {
  projectId: string;
  taskId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  phase?: AgentPhase;        // Default: 'plan'
  sdkSessionId?: string;     // For resuming after plan approval
}

export interface AgentConfig {
  model: string;
  maxTurns: number;
  allowedTools?: string[];
}

export interface PlanData {
  taskId: string;
  sessionId: string;
  projectId: string;
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  sandboxId?: string;        // Sandbox ID at plan time (for change detection)
  createdAt: Date;
}
```

---

## Constructor

```typescript
constructor(
  db: Database,
  provider: SandboxProvider,
  streams: DurableStreamsService,
  apiKeyService: ApiKeyService,
  worktreeService?: WorktreeService,
  githubTokenService?: GitHubTokenService
)
```

- `provider` - Sandbox provider (Docker, K8s, Nomad)
- `streams` - DurableStreamsService for real-time event publishing
- `apiKeyService` - Retrieves OAuth tokens from the database
- `worktreeService` - Optional; if not injected, agents share the main workspace
- `githubTokenService` - Optional; used for remote workspace initialization (K8s/Nomad)

The service also accepts an optional AgentCore provider configured at runtime:

```typescript
setAgentCoreProvider(config: AgentCoreProviderConfig): void
clearAgentCoreProvider(): void
```

Factory function:

```typescript
function createContainerAgentService(
  db: Database,
  provider: SandboxProvider,
  streams: DurableStreamsService,
  apiKeyService: ApiKeyService,
  worktreeService?: WorktreeService,
  githubTokenService?: GitHubTokenService
): ContainerAgentService
```

---

## Public Methods

### startAgent

Starts an agent for a task inside a sandbox container or AgentCore runtime.

```typescript
async startAgent(input: StartAgentInput): Promise<Result<void, SandboxError>>
```

**Container Exec Flow:**

1. Check if agent is already running for this task (in-memory guard)
2. Prevent concurrent starts for the same task via `startingAgents` set
3. Parallel fetch: project record and sandbox lookup
4. If AgentCore provider is active, delegate to `startAgentCoreAgent()`
5. Handle sandbox recovery (recreate if in terminal state)
6. Auto-create sandbox if missing (2048 MB memory, 2 CPU cores, 30-minute idle timeout)
7. Wait for sandbox to reach `running` status (exponential backoff, max 30s)
8. Verify sandbox supports `execStream`
9. Create agent record (`agents` table) with `status: 'starting'`
10. Create session record (`sessions` table) with `sandboxProvider` and `sandboxContainerId`
11. Link agent and session to task
12. Create durable stream for real-time events
13. Publish status events through all stages
14. Resolve agent config (model cascade: explicit param -> project config -> global default -> hardcoded)
15. Retrieve OAuth token (database via ApiKeyService, fallback to env vars)
16. Create sentinel file path for cancellation (`/tmp/.agent-stop-{taskId}`)
17. Clear any stale stop file from a previous run
18. Create or recover worktree (planning: create new; execution: recover existing)
19. For remote providers (K8s, Nomad): initialize workspace by cloning repo inside pod
20. Build environment variables and create ContainerBridge
21. TOCTOU guard: re-validate sandbox is still running before exec
22. Execute `node /opt/agent-runner/dist/index.js` inside container via `sandbox.execStream()`
23. Track running agent in `runningAgents` map
24. Set maximum runtime timeout (default: 2 hours, configurable via `AGENT_MAX_RUNTIME_MS`)
25. Start processing stdout stream asynchronously via `processAgentOutput()`
26. Also process stderr through the bridge to capture fallback error events
27. Update agent status to `planning` or `running`

### stopAgent

Stops a running agent by writing a sentinel file and killing the exec process.

```typescript
async stopAgent(taskId: string): Promise<Result<void, SandboxError>>
```

**Container exec path:**
1. Write sentinel file via `sandbox.exec('touch', [stopFilePath])`
2. Kill the exec process via `execResult.kill()`
3. Set `stopRequested` flag
4. Safety-net worktree cleanup (idempotent)
5. Publish `container-agent:cancelled` event

**AgentCore path:**
1. Call `bridge.stop()` to break out of processStream loop
2. Call `instance.stop()` on the AgentCore sandbox instance
3. Remove runtime session from provider
4. Publish `container-agent:cancelled` event

### approvePlan

Approves a pending plan and starts execution phase.

```typescript
async approvePlan(taskId: string): Promise<Result<void, SandboxError>>
```

**Flow:**

1. Retrieve pending plan (in-memory or database recovery)
2. For AgentCore: skip sandbox change detection (microVM sessions persist up to 8 hours)
3. For containers: detect sandbox change by comparing current sandbox ID with planning-time sandbox ID
4. If sandbox changed: clear `sdkSessionId` (forces fresh session), notify user
5. Move task to `in_progress`
6. Remove from `pendingPlans` (only after DB write succeeds)
7. Call `startAgent()` with `phase: 'execute'`

### rejectPlan

Rejects a plan and moves the task back to backlog.

```typescript
async rejectPlan(taskId: string, reason?: string): Promise<Result<void, SandboxError>>
```

**Flow:**

1. Verify plan exists (in-memory or database)
2. Look up worktreeId from task before clearing fields
3. Update task: move to `backlog`, clear `plan`, `planOptions`, `lastAgentStatus`, `worktreeId`, `branch`
4. Store rejection reason on task
5. Clear in-memory cache (only after DB write succeeds)
6. Clean up worktree (async, best-effort)

### isAgentRunning

```typescript
isAgentRunning(taskId: string): boolean
```

Checks both `runningAgents` and `runningAgentCoreAgents` maps.

### getRunningAgent

```typescript
getRunningAgent(taskId: string): { projectId: string; sessionId: string; startedAt: Date } | null
```

### getRunningAgents

```typescript
getRunningAgents(): Array<{
  taskId: string;
  projectId: string;
  sessionId: string;
  startedAt: Date;
}>
```

Returns agents from both container and AgentCore maps.

### getPendingPlan

```typescript
async getPendingPlan(taskId: string): Promise<PlanData | undefined>
```

Checks in-memory cache first, falls back to database recovery (plan survives server restarts via the `tasks` table). Re-caches recovered plans for subsequent calls.

### dispose

```typescript
dispose(): void
```

Stops the plan cleanup interval and cleans up AgentCore provider resources.

### providerName (getter)

```typescript
get providerName(): string  // 'agentcore' or provider.name
```

---

## Container Creation and Management

### Sandbox Provider Abstraction

The service uses the `SandboxProvider` interface (`src/lib/sandbox/providers/sandbox-provider.ts`) to abstract over different container runtimes:

| Provider | Implementation |
|----------|---------------|
| Docker | `docker-provider.ts` |
| Kubernetes | `agent-sandbox-provider.ts` |
| Nomad | `nomad-sandbox-provider.ts` |
| AgentCore | `agentcore-sandbox-provider.ts` |

### Sandbox Lifecycle

- **Auto-create**: If no sandbox exists for a project, one is created with default settings (2048 MB memory, 2 CPU cores, 30-minute idle timeout)
- **Recovery**: If sandbox is in `error` or `stopped` state, it is torn down and recreated
- **Ready wait**: Polls sandbox status with exponential backoff (1s initial, 5s max, 30s total timeout)
- **TOCTOU guard**: Re-validates sandbox is still running immediately before exec (uses `refreshStatus()` when available)

### Remote Workspace Initialization (K8s / Nomad)

Remote provider pods start with an empty `/workspace`. The service initializes the workspace by:

1. Deriving GitHub owner/repo from project config or git remote (auto-backfills to DB)
2. Resolving a git token (GitHub App installation token or personal access token)
3. Cloning the repository inside the pod via `initializeK8sWorkspace()`
4. Creating a git worktree for branch isolation
5. Saving the branch name to the task record for recovery on pod recycle
6. For execution phase: checks if the planning worktree still exists in the pod before re-cloning

---

## Authentication Configuration

The Claude Agent SDK requires OAuth authentication via a credentials file, not environment variables.

### Token Resolution

1. Retrieve encrypted token from database via `ApiKeyService.getDecryptedKey('anthropic')`
2. Fall back to `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` environment variables
3. Token is passed to the container via `CLAUDE_OAUTH_TOKEN` environment variable

### Credentials File

The agent-runner writes OAuth credentials to `~/.claude/.credentials.json` before starting the SDK session:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": null,
    "expiresAt": 1737417600000,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max"
  }
}
```

The credentials file is written with restricted permissions (`0o600`) in a directory with restricted permissions (`0o700`). The agent-runner verifies the file is readable and valid JSON after writing.

---

## Agent Runner

The agent-runner (`agent-runner/src/index.ts`) is a Node.js process that runs inside the Docker container. It creates a Claude Agent SDK session and processes the stream, emitting structured JSON-line events to stdout.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_OAUTH_TOKEN` | Yes | OAuth token for Claude authentication |
| `AGENT_TASK_ID` | Yes | Task ID being worked on |
| `AGENT_SESSION_ID` | Yes | Session ID for event streaming |
| `AGENT_PROMPT` | Yes | The task prompt or plan text |
| `AGENT_PHASE` | No | `plan` or `execute` (default: `execute`) |
| `AGENT_SDK_SESSION_ID` | No | SDK session ID to resume (for execution after plan approval) |
| `AGENT_MAX_TURNS` | No | Maximum turns (default: 50) |
| `AGENT_MODEL` | No | Model to use (default: `claude-opus-4-5-20251101`) |
| `AGENT_CWD` | No | Working directory (default: `/workspace`) |
| `AGENT_STOP_FILE` | No | Sentinel file path for cancellation |

### Execution Phases

- **Planning**: Creates session with `permissionMode: 'plan'`. Intercepts `ExitPlanMode` tool via `canUseTool` callback. Emits `agent:plan_ready` when plan is complete. Includes a 60-second timeout for ExitPlanMode detection in case the stream hangs.
- **Execution**: Creates session with `permissionMode: 'bypassPermissions'`. Can resume a previous session via `unstable_v2_resumeSession()`. If resume fails, falls back to a fresh session with the full plan as prompt. When resumed, sends a minimal approval prompt ("The plan has been approved. Please proceed with the implementation.") instead of the full plan text.

### Path Security

- `AGENT_CWD` must resolve to a path within `/workspace`
- `AGENT_STOP_FILE` must resolve to a path within `/workspace` or `/tmp`

### Global Error Handlers

The agent-runner registers `uncaughtException` and `unhandledRejection` handlers early in startup. These emit structured error events via the event emitter and call `process.exit(1)` to ensure clean shutdown. Fatal errors before the agent starts are written to stderr as JSON for the container bridge to capture.

### File Change Detection

The agent-runner detects file-modifying tool calls (`Write`, `Edit`, `NotebookEdit`) via the `canUseTool` callback and emits `agent:file_changed` events with the file path, action (`create`/`modify`), and tool name.

---

## Event Emitter

The event emitter (`agent-runner/src/event-emitter.ts`) outputs structured JSON-line events to stdout. The host process reads these lines via the ContainerBridge.

### Event Types

| Event Type | Sync | Description |
|------------|------|-------------|
| `agent:started` | Yes | Agent began execution |
| `agent:token` | No | Streaming text delta (high frequency) |
| `agent:turn` | Yes | Turn completed |
| `agent:tool:start` | No | Tool invocation began |
| `agent:tool:result` | Yes | Tool returned result |
| `agent:message` | Yes | Assistant message |
| `agent:complete` | Yes | Agent finished |
| `agent:error` | Yes | Agent encountered error |
| `agent:cancelled` | Yes | Agent was cancelled |
| `agent:plan_ready` | Yes | Plan ready for approval |
| `agent:file_changed` | No | File modified by agent |

Critical events use synchronous writes (`writeSync` to file descriptor 1) to ensure immediate delivery even when the process is about to exit. High-frequency events (tokens, tool starts) use buffered async writes for performance.

### Event Structure

```typescript
interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  taskId: string;
  sessionId: string;
  data: Record<string, unknown>;
}
```

---

## Container Bridge

The ContainerBridge (`src/lib/agents/container-bridge.ts`) parses JSON-line events from the agent-runner's stdout and bridges them to DurableStreams.

```typescript
interface ContainerBridge {
  processStream(stream: Readable): Promise<void>;
  processStderr(stream: Readable): void;
  stop(): void;
}
```

- `processStream()`: Reads stdout line-by-line via `readline`, parses JSON events, publishes to DurableStreams with mapped event types (e.g., `agent:started` -> `container-agent:started`)
- `processStderr()`: Captures JSON error events from stderr as a fallback when stdout fails (e.g., EPIPE)
- Callbacks: `onComplete`, `onError`, `onPlanReady` trigger state transitions in the service

The AgentCoreBridge follows the same callback interface but processes SSE events from an AgentCore invocation instead of container stdout.

---

## Sandbox Mode Settings

The sandbox mode is controlled by the `SandboxConfigService` (`src/services/sandbox-config.service.ts`) and determines how containers are provisioned:

| Mode | Behavior |
|------|----------|
| Shared Container | Use a single Docker container for all projects (fastest path) |
| Per-Project Container | Create a unique container per project with project path mounted |

### Configuration Schema

```typescript
interface CreateSandboxConfigInput {
  name: string;
  type?: SandboxType;         // 'docker' | 'kubernetes' | 'nomad'
  baseImage?: string;
  memoryMb?: number;
  cpuCores?: number;
  maxProcesses?: number;
  timeoutMinutes?: number;
  volumeMountPath?: string;
  // Kubernetes-specific
  kubeConfigPath?: string;
  kubeContext?: string;
  kubeNamespace?: string;
  networkPolicyEnabled?: boolean;
  allowedEgressHosts?: string[];
  // Nomad-specific
  nomadAddress?: string;
  nomadToken?: string;
  nomadNamespace?: string;
  nomadDatacenter?: string;
  nomadRegion?: string;
}
```

Default sandbox image: defined in `SANDBOX_DEFAULTS.image` from `src/lib/sandbox/types.ts`.

### SandboxService

The `SandboxService` (`src/services/sandbox.service.ts`) manages sandbox container lifecycle:

- `getOrCreateForProject()`: Get or create a sandbox for a project
- Idle sandbox checker: Runs every 5 minutes, disables after 5 consecutive failures
- Tmux session management for interactive terminal access
- Credentials injection for OAuth tokens

---

## Container Security

### Docker Image (`docker/Dockerfile.agent-sandbox`)

- **Base image**: `srlynch1/terraform-ai-tools:latest` (Node.js 22, Terraform, Git, jq)
- **Additional tools**: ripgrep, fd-find, tree
- **Claude CLI**: Installed globally via `npm install -g @anthropic-ai/claude-code` (required by the SDK which spawns the CLI process)
- **Non-root user**: Runs as `node` user
- **Limited sudo**: Only `chown` is allowed passwordless via sudoers (`/etc/sudoers.d/node-chown`)
- **Git safe directory**: `git config --system --add safe.directory '*'` for mounted volumes
- **SDK directories**: `/home/node/.claude/plans` pre-created with correct ownership
- **Workspace**: `/workspace` directory created and owned by `node` user
- **Build optimization**: Source files and devDependencies removed after build to reduce image size

### Entrypoint (`docker/entrypoint.sh`)

- Fixes `/workspace` permissions for bind-mounted volumes (tries `sudo chown`, falls back to `chown`, warns on failure)
- Ensures `.claude` directories exist for SDK credentials and plans
- Delegates to the specified command via `exec "$@"`

### Runtime Security

- Project directories bind-mounted at `/workspace`
- Agent working directory constrained to `/workspace` subtree
- Sentinel file constrained to `/workspace` or `/tmp`
- OAuth token passed via environment variable (not persisted to image)
- Credentials file written with `0o600` permissions inside container

---

## Worktree Management

### Docker Provider (Local)

- **Planning phase**: Creates a new worktree via `WorktreeService.create()` with `skipEnvCopy`, `skipDepsInstall`, and `skipInitScript` options
- **Execution phase**: Recovers existing worktree from task record via `WorktreeService.getStatus()`
- Host worktree paths are translated to container paths via `translatePathForContainer()` (e.g., `/Users/foo/project/.worktrees/branch` -> `/workspace/.worktrees/branch`)
- Links worktree ID and branch to the task record
- Publishes `container-agent:worktree` event with worktree ID, branch, and container path
- **On completion**: worktree changes are auto-committed via `WorktreeService.commit()` with a descriptive message
- **On error/cancellation**: worktree is cleaned up via `WorktreeService.remove(worktreeId, true)` (force remove)
- Cleanup is idempotent and treats `WORKTREE_NOT_FOUND` as success

### K8s / Nomad Provider (Remote)

- Workspace initialized inside pod by cloning the repository
- Worktrees created via shell commands inside the pod (not tracked by WorktreeService)
- Branch saved to task record for recovery on pod recycle
- Execution phase checks if the planning worktree still exists in the pod before re-cloning

---

## Pending Plans

Plans are stored in two locations for reliability:

1. **In-memory**: `pendingPlans` Map (fast access, lost on restart)
2. **Database**: `tasks.plan` and `tasks.planOptions` columns (survives restarts)

### Plan Lifecycle

- Created by `handlePlanReady()` on `agent:plan_ready` event
- Retrieved by `getPendingPlan()` (in-memory first, database fallback with re-caching)
- Consumed by `approvePlan()` (deleted only after DB write succeeds)
- Cleared by `rejectPlan()` (DB write first, in-memory cleanup after)
- Expired plans cleaned up every 5 minutes (TTL: 1 hour)

### StoredPlanOptions

```typescript
interface StoredPlanOptions {
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  planningSandboxId?: string;
}
```

### Sandbox Change Detection

When approving a plan, the service compares the current sandbox ID with the `planningSandboxId` stored at planning time. If the sandbox was replaced (e.g., container restart, idle timeout), the `sdkSessionId` is cleared and a fresh session is created with the full plan text as prompt. The user is notified via a system message.

---

## Completion and Error Handling

### handleAgentComplete

When a container agent completes:

1. Auto-commit worktree changes (for Docker agents with worktreeId, on `completed` or `turn_limit`)
2. Update task column and `lastAgentStatus`:
   - `completed` -> `waiting_approval`, clear agentId/sessionId
   - `turn_limit` -> `waiting_approval`, clear agentId/sessionId
   - `cancelled` -> leave in current column, clear agentId/sessionId, clean up worktree
3. Update agent status to `completed`
4. Clean up sentinel file from sandbox
5. Clear runtime timeout
6. Remove from `runningAgents` map

### handleAgentError

When a container agent errors:

1. Check for orphaned agents (not in running map) and handle gracefully
2. Suppress expected post-plan errors (Operation aborted, session closed, EPIPE, stream ended) when plan was already captured
3. Clear agentId/sessionId on task, set `lastAgentStatus: 'error'`
4. Clean up worktree
5. Update agent status to `error`
6. Clear runtime timeout
7. Remove from `runningAgents` map
8. Publish `container-agent:task-update-failed` if DB update fails

### handlePlanReady

When a plan is ready:

1. Capture sandbox ID from running agent
2. Store plan in `pendingPlans` map and persist to `tasks` table
3. Move task to `waiting_approval`
4. If DB write fails: remove from `pendingPlans`, publish error, clean up worktree
5. Remove from running agents maps

---

## Status Breadcrumbs (UI)

The UI displays startup progress using the `ContainerAgentStatusBreadcrumbs` component (`src/app/components/features/container-agent-panel/container-agent-status-breadcrumbs.tsx`).

Each stage is rendered as a step with three visual states:

| State | Appearance |
|-------|------------|
| `pending` | Muted background, muted text |
| `active` | Accent background with pulse animation |
| `complete` | Success (green) background with check icon |

The component receives `currentStage`, `statusMessage`, and `statusHistory` from the `useContainerAgent` hook (`src/app/hooks/use-container-agent.ts`).

---

## AgentCore Integration

When an AgentCore provider is configured via `setAgentCoreProvider()`, `startAgent()` delegates to the `startAgentCoreAgent()` method:

1. Follows the same DB setup pattern (agent record, session record, task linking, durable stream)
2. Resolves agent config and OAuth token identically
3. Creates an `AgentCoreSandboxInstance` via `provider.create()`
4. Gets or creates a runtime session via `provider.getOrCreateSession()`
5. Invokes the runtime with a payload containing prompt, taskId, model, phase, etc.
6. Creates an `AgentCoreBridge` with the same callbacks as ContainerBridge
7. Tracks in `runningAgentCoreAgents` map
8. Processes SSE stream asynchronously via `processAgentCoreOutput()`
9. On stop: calls `bridge.stop()`, `instance.stop()`, and `provider.removeSession()`

---

## In-Memory State

The service maintains several in-memory structures:

| Structure | Type | Purpose |
|-----------|------|---------|
| `runningAgents` | `Map<string, RunningAgent>` | Tracked container exec agents (keyed by taskId) |
| `runningAgentCoreAgents` | `Map<string, RunningAgentCoreAgent>` | Tracked AgentCore agents (keyed by taskId) |
| `pendingPlans` | `Map<string, PlanData>` | Plans awaiting approval (keyed by taskId) |
| `startingAgents` | `Set<string>` | Prevents concurrent `startAgent` races (keyed by taskId) |
| `planCleanupInterval` | `Interval` | Periodic cleanup of expired plans (every 5 minutes) |
| `agentCoreProvider` | `AgentCoreSandboxProvider?` | Lazily initialized when AgentCore config is set |

---

## Model Resolution

The agent model is resolved using a cascade priority:

```
explicit model param -> project.config.model -> global default_model setting -> DEFAULT_AGENT_MODEL
```

All values are expanded to full API model IDs via `getFullModelId()` from `src/lib/constants/models.ts`.

---

## Maximum Runtime

Agents have a maximum runtime timeout to prevent runaway processes:

- Default: 2 hours (7,200,000 ms)
- Configurable via `AGENT_MAX_RUNTIME_MS` environment variable
- On timeout: `stopAgent()` is called automatically
- Timeout handle is `unref()`'d so it doesn't prevent process exit

---

## Side Effects

### Database Operations

| Operation | Tables Affected |
|-----------|-----------------|
| `startAgent` | `agents` (insert/upsert), `sessions` (insert/upsert), `tasks` (update agentId, sessionId, worktreeId, branch) |
| `handleAgentComplete` | `tasks` (update column, clear agentId/sessionId, set lastAgentStatus, completedAt), `agents` (update status to completed) |
| `handleAgentError` | `tasks` (clear agentId/sessionId, set lastAgentStatus to error), `agents` (update status to error) |
| `handlePlanReady` | `tasks` (update plan, planOptions, lastAgentStatus to planning, column to waiting_approval) |
| `approvePlan` | `tasks` (update column to in_progress) |
| `rejectPlan` | `tasks` (update column to backlog, clear plan/planOptions/worktreeId/branch, set rejectionReason) |

### Event Publishing

Events published via `streams.publish()`:

| Event Type | When |
|------------|------|
| `container-agent:status` | Each stage transition during startup |
| `container-agent:message` | System messages during startup and execution |
| `container-agent:started` | Agent process started successfully |
| `container-agent:worktree` | Worktree created (with branch and path info) |
| `container-agent:error` | Agent error occurred |
| `container-agent:cancelled` | Agent was cancelled |
| `container-agent:task-update-failed` | Failed to update task status in DB |

Additionally, the ContainerBridge republishes all agent-runner events with the `container-agent:` prefix (e.g., `agent:token` -> `container-agent:token`, `agent:plan_ready` -> `container-agent:plan_ready`).

---

## Error Conditions

| Error Code | Condition |
|------------|-----------|
| `AGENT_ALREADY_RUNNING` | Agent is already running for this task |
| `PROJECT_NOT_FOUND` | Project ID does not exist |
| `CONTAINER_NOT_FOUND` | No sandbox could be found or created |
| `CONTAINER_NOT_RUNNING` | Sandbox did not reach running status in time |
| `STREAMING_EXEC_NOT_SUPPORTED` | Sandbox does not support streaming exec |
| `TASK_NOT_FOUND` | Task ID does not exist |
| `AGENT_RECORD_FAILED` | Failed to create agent DB record |
| `SESSION_CREATE_FAILED` | Failed to create session DB record |
| `STREAM_CREATE_FAILED` | Failed to create durable stream |
| `STREAM_PUBLISH_FAILED` | Failed to publish initial status event |
| `API_KEY_NOT_CONFIGURED` | No OAuth token available |
| `AGENT_START_FAILED` | Failed to execute agent-runner in container |
| `AGENT_NOT_RUNNING` | Attempting to stop agent that is not running |
| `AGENT_STOP_FAILED` | Failed to stop agent |
| `PLAN_NOT_FOUND` | No pending plan for this task |
| `PLAN_REJECTION_FAILED` | Failed to update task on plan rejection |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/container-agent.service.ts` | Main service: orchestration, lifecycle, state management |
| `agent-runner/src/index.ts` | Agent-runner entry point (runs inside container) |
| `agent-runner/src/event-emitter.ts` | JSON-line event emitter for stdout communication |
| `docker/Dockerfile.agent-sandbox` | Docker image definition |
| `docker/entrypoint.sh` | Container entrypoint script |
| `src/lib/agents/container-bridge.ts` | Stdout JSON-line parser and DurableStreams bridge |
| `src/lib/agents/agentcore-bridge.ts` | AgentCore SSE event bridge |
| `src/lib/agents/event-type-map.ts` | Maps agent-runner event types to DurableStreams event types |
| `src/lib/sandbox/providers/sandbox-provider.ts` | SandboxProvider and Sandbox interfaces |
| `src/lib/sandbox/providers/docker-provider.ts` | Docker sandbox provider |
| `src/lib/sandbox/providers/agent-sandbox-provider.ts` | Kubernetes sandbox provider |
| `src/lib/sandbox/providers/nomad-sandbox-provider.ts` | Nomad sandbox provider |
| `src/lib/sandbox/providers/agentcore-sandbox-provider.ts` | AgentCore sandbox provider |
| `src/lib/sandbox/k8s-workspace-initializer.ts` | Remote workspace clone and worktree setup |
| `src/lib/sandbox/git-token-resolver.ts` | GitHub token resolution for remote clones |
| `src/services/sandbox.service.ts` | SandboxService: container lifecycle (idle checks, tmux, credentials) |
| `src/services/sandbox-config.service.ts` | SandboxConfigService: sandbox configuration CRUD |
| `src/app/hooks/use-container-agent.ts` | React hook for container agent state |
| `src/app/components/features/container-agent-panel/container-agent-status-breadcrumbs.tsx` | UI breadcrumbs component |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | `agents`, `sessions`, `tasks` tables |
| [Error Catalog](../errors/error-catalog.md) | `SANDBOX_*` error codes |
| [AgentService](./agent-service.md) | In-process agent execution (alternative path) |
| [TaskService](./task-service.md) | Triggers container agents on task move |
| [SessionService](./session-service.md) | Session creation and event types |
| [WorktreeService](./worktree-service.md) | Worktree creation and lifecycle |
| [Security: Sandbox](../security/sandbox.md) | Container isolation model |
| [Claude Agent SDK](../integrations/claude-agent-sdk.md) | SDK session management |
| [Durable Sessions](../integrations/durable-sessions.md) | Real-time event streaming |
