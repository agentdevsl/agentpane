# CLAUDE.md

where possible use concurrent OPUS subagents

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Note**: This project uses AGENTS.md files for detailed guidance and has comprehensive specifications in `/specs/application`.

## Primary References

1. **AGENTS.md** - Development guidelines and tech stack: `./AGENTS.md`
2. **Specifications** - Complete application specs: `/specs/application/README.md`

## Application Specifications

The `/specs/` directory contains all specifications. See `/specs/README.md` for the full master index.

### Specification Structure

```
specs/
├── README.md                          # Master index with status dashboard
├── application/                       # Core specs (source of truth)
│   ├── api/                           # REST API (33 route modules, 60+ endpoints)
│   │   ├── endpoints.md               # All endpoints (Hono-based)
│   │   └── pagination.md              # Pagination patterns
│   ├── architecture/                  # System Architecture
│   ├── components/                    # UI Components (19 specs)
│   ├── configuration/                 # Project config, env vars
│   ├── database/
│   │   └── schema.md                  # Drizzle schema (36 tables, SQLite + PostgreSQL)
│   ├── errors/                        # 44 error codes
│   ├── implementation/                # CVA, animation, responsive patterns
│   ├── integrations/                  # Claude SDK, GitHub, Caddy, Terraform, Durable Streams
│   ├── operations/                    # Docker, CI/CD, monitoring
│   ├── routing/                       # TanStack Router (all frontend routes)
│   ├── security/                      # Auth, RBAC, sandbox, security model
│   ├── services/                      # 9 service specs (agent, task, session, etc.)
│   ├── state-machines/                # 4 machines (agent, task, session, worktree)
│   ├── testing/                       # 164+ test cases
│   └── wireframes/                    # 20 HTML visual designs
├── sandbox/                           # Deep sandbox architecture (18 files)
├── diagrams/                          # 9 Mermaid architecture diagrams
├── reviews/                           # Architecture reviews
├── roadmap/                           # Future plans (NOT for implementation)
└── archive/                           # Historical/superseded specs
```

### Using Specifications

| Task | Start With |
|------|------------|
| **New feature** | `user-stories.md` → `wireframes/` → component spec |
| **API work** | `api/endpoints.md` → service spec |
| **UI component** | `components/*.md` → `implementation/component-patterns.md` |
| **State logic** | `state-machines/*.md` → service spec |
| **Database** | `database/schema.md` |
| **Architecture** | `specs/diagrams/01-system-architecture.md` |
| **Agent execution** | `specs/diagrams/02-agent-execution-flow.md` → `services/agent-service.md` |
| **Testing** | `testing/test-infrastructure.md` → `test-cases.md` |
| **Deployment** | `operations/deployment.md` |
| **Debugging** | `errors/error-catalog.md` → `operations/monitoring.md` |

## Additional Component-Specific Guidance

For detailed module-specific implementation guides, also check for AGENTS.md files in subdirectories throughout the project. These component-specific AGENTS.md files contain targeted guidance for working with those particular areas of the codebase.

If you need to ask the user a question use the tool AskUserQuestion - this is useful during speckit.clarify

## Updating Documentation

When you discover new information that would be helpful for future development work:

- **Update existing AGENTS.md files** when you learn implementation details, debugging insights, or architectural patterns specific to that component
- **Create new AGENTS.md files** in relevant directories when working with areas that don't yet have documentation
- **Update specs** when implementation reveals gaps or corrections needed
- **Add valuable insights** such as common pitfalls, debugging techniques, dependency relationships, or implementation patterns

## Development

### Starting the Server

```bash
npm run dev
```

This starts both servers concurrently:
- **Frontend**: Vite dev server on port 3000
- **API**: Backend server on port 3001

The startup script includes health checks to ensure both servers are ready before development begins.

### Common Issues

- **API offline**: If API requests fail, check that port 3001 is running. Restart with `npm run dev`.
- **Frontend not loading**: Ensure port 3000 is available and Vite started successfully.
- **linting errors**: Fix errors do not workaround

### Publishing `@agentpane/cli-monitor` to npm

The CLI monitor package lives at `packages/cli-monitor`. To publish:

```bash
cd packages/cli-monitor
npm version patch --no-git-tag-version   # bump version
npm publish --//registry.npmjs.org/:_authToken=<token>
```

- The `prepublishOnly` script runs tests and builds automatically.
- **npm access token** is stored in `/specs/CLI_monitor/.env` (`npm_access_token`). Use this token for the `--//registry.npmjs.org/:_authToken=` flag.
- The package is published with `"access": "public"` under the `@agentpane` scope.
- Build output: `dist/index.js` (single Bun-bundled file, ~75 KB).

## Agent Execution Architecture

### Task → Agent Flow

When a task is moved to `in_progress` (via drag-drop on the Kanban board):

1. **Task Move API** (`PATCH /api/tasks/:id/move`)
   - Updates task column in database
   - If moving to `in_progress`, triggers agent auto-start

2. **Agent Auto-Start** (`src/server/routes/tasks.ts`)
   - Finds an idle agent or creates a new one for the project
   - Calls `agentService.start(agentId, taskId)`

3. **Agent Execution Service** (`src/services/agent/agent-execution.service.ts`)
   - Creates a git worktree for isolated work
   - Creates a session to track events
   - Updates task with `agentId`, `sessionId`, `worktreeId`
   - Sets agent status to `planning` (not running)
   - Starts planning via `runAgentPlanning()`

4. **Planning Phase** (`src/lib/agents/stream-handler.ts:runAgentPlanning`)
   - Creates Claude Agent SDK session with `permissionMode: 'plan'`
   - Agent explores codebase and creates implementation plan
   - Agent calls `ExitPlanMode` tool when plan is ready
   - Captures plan content and options (including swarm settings)
   - Publishes `agent:plan_ready` event
   - Task stays in `in_progress`, agent status is `planning`

5. **Plan Approval** (user action)
   - User reviews the plan in the UI
   - On approval: execution phase begins
   - On rejection: agent can be asked to revise

6. **Execution Phase** (`src/lib/agents/stream-handler.ts:runAgentExecution`)
   - Creates session with `permissionMode: 'acceptEdits'`
   - If `launchSwarm: true` in planOptions, spawns multiple agents
   - Executes the approved plan
   - On completion: task moves to `waiting_approval`

### Swarm Mode

When the agent calls `ExitPlanMode`, it can request swarm execution:

```typescript
interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;      // Enable swarm mode
  teammateCount?: number;     // Number of parallel agents
  pushToRemote?: boolean;     // Remote session support
}
```

If `launchSwarm: true`, the execution phase will spawn multiple agents to work on different parts of the plan in parallel.

### Key Files

| File | Purpose |
|------|---------|
| `src/server/routes/tasks.ts` | Task move API with agent auto-start |
| `src/services/agent/agent-execution.service.ts` | Agent lifecycle management |
| `src/lib/agents/stream-handler.ts` | Claude SDK integration |
| `src/lib/agents/agent-sdk-utils.ts` | SDK helper utilities |
| `src/services/worktree.service.ts` | Git worktree management |

### Environment Requirements

- **ANTHROPIC_API_KEY**: Required for Claude SDK. Set globally or in the admin settings UI.
- The API key is automatically passed to the SDK via `process.env`.

### Session Events

The stream handler publishes these events during execution:

| Event Type | When |
|------------|------|
| `agent:started` | Agent begins execution |
| `agent:turn` | Each turn completed |
| `chunk` | Streaming text output |
| `tool:start` | Tool invocation begins |
| `tool:result` | Tool returns result |
| `agent:turn_limit` | Max turns reached |
| `agent:completed` | Agent finished successfully |
| `agent:error` | Agent encountered error |

### Real-Time Streaming

- **Backend**: SSE endpoint at `GET /api/sessions/:id/stream`
- **Frontend**: `DurableStreamsClient` connects via EventSource
- Events are published through `sessionService.publish()`

## Terraform Compose Architecture

The Terraform No-Code Composer uses the Claude Agent SDK to generate HCL configurations from natural language.

### Key Files

| File | Purpose |
|------|---------|
| `src/services/terraform-compose.service.ts` | Compose pipeline: Agent SDK session, streaming, code extraction |
| `src/app/components/features/terraform/terraform-context.tsx` | Client-side state, SSE processing, fallback code extraction |
| `src/app/components/features/terraform/terraform-chat-panel.tsx` | Chat UI with clarifying questions |
| `src/app/components/features/terraform/terraform-right-panel.tsx` | Code/Dependencies/Variables panel |
| `src/lib/terraform/compose-prompt.ts` | System prompt builder with settings override |
| `src/lib/prompts/prompt-registry.ts` | Default prompt texts (terraform-compose) |

### Critical: Do NOT use `permissionMode: 'plan'` for Compose

The compose service creates an Agent SDK session via `unstable_v2_createSession()`. **Never set `permissionMode: 'plan'`** — this injects Claude Code's planning system instructions, causing the model to ask for approval ("The plan is ready for your review") instead of generating HCL code. The session should be created without a `permissionMode` so the model follows the compose system prompt directly.

### Code Extraction Flow

1. Agent SDK streams text deltas → accumulated into `fullResponse`
2. After streaming, `extractHclCode(fullResponse)` extracts `` ```hcl ``, `` ```terraform ``, or `` ```tf `` fenced blocks
3. If found, a `code` SSE event is sent to the client
4. The `done` event also carries `generatedCode` as a redundant delivery path
5. Client-side fallback (`extractHclFromText`) runs in the `finally` block if no server-side extraction succeeded

### Common Pitfalls

- **`fullResponse` overwrite**: The `assistant` message handler must only set `fullResponse` when stream deltas weren't available (`!streamedTextToClient`), otherwise it overwrites incrementally accumulated content containing HCL code
- **HCL fence variants**: Server and client regex must both handle `hcl`, `terraform`, and `tf` fence types
- **SSE event buffering**: `code` events must be buffered in `sendEvent()` alongside `error` and `done` to survive temporary controller disconnects

## Docker Container Agent Architecture

AgentPane can run Claude agents inside isolated Docker containers for sandboxed execution. This provides security isolation and prevents agents from affecting the host system.

### Container Execution Flow

1. **Task Move to In Progress** → Container agent service triggered
2. **Status: Initializing** → Validate configuration
3. **Status: Validating** → Check project and sandbox settings
4. **Status: Credentials** → Configure authentication
5. **Status: Creating Sandbox** → Create project-specific Docker container
6. **Status: Executing** → Start agent-runner inside container
7. **Status: Running** → Agent actively working on task

### Authentication Configuration

The Claude Agent SDK requires OAuth authentication. Write the OAuth credentials to `~/.claude/.credentials.json` instead of using environment variables. The SDK reads this file automatically (same as `claude login` would create).

**Credentials File Format:**
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "",
    "expiresAt": 1737417600000,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max"
  }
}
```

OAuth tokens passed via `ANTHROPIC_API_KEY` env var are blocked by the API, which is why the credentials file approach is required.

### Key Container Files

| File | Purpose |
|------|---------|
| `agent-runner/src/index.ts` | Entry point for Claude Agent SDK inside container |
| `agent-runner/src/event-emitter.ts` | Emits structured events for real-time UI updates |
| `docker/Dockerfile.agent-sandbox` | Docker image with Claude CLI and agent runner |
| `docker/entrypoint.sh` | Fixes permissions for bind-mounted volumes |
| `src/services/container-agent.service.ts` | Orchestrates container creation and agent execution |

### Agent Runner Configuration

The agent runner accepts these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_OAUTH_TOKEN` | Yes | OAuth token for Claude authentication |
| `AGENT_TASK_ID` | Yes | Task ID being worked on |
| `AGENT_SESSION_ID` | Yes | Session ID for event streaming |
| `AGENT_PROMPT` | Yes | The task prompt |
| `AGENT_MAX_TURNS` | No | Maximum turns (default: 50) |
| `AGENT_MODEL` | No | Model to use (default: claude-sonnet-4-6) |
| `AGENT_CWD` | No | Working directory (default: /workspace) |
| `AGENT_STOP_FILE` | No | Sentinel file path for cancellation |

### Sandbox Mode Setting

The app supports two sandbox modes, controlled by the `sandbox.mode` setting in **Settings → Defaults → Sandbox Mode**:

| Mode | Behavior |
|------|----------|
| `Shared Container` (default) | Use a single Docker container for all projects |
| `Per-Project Container` | Create a unique container per project with project path mounted |

### Container Security

- Runs as non-root `node` user
- Project directories bind-mounted to `/workspace`
- Git configured with `safe.directory '*'` for mounted volumes
- Limited sudo access for permission fixes only
- Claude CLI installed globally for SDK compatibility

### Status Breadcrumbs

The UI displays startup progress through these stages:

```typescript
type ContainerAgentStage =
  | 'initializing'    // Validating configuration
  | 'validating'      // Checking project settings
  | 'credentials'     // Configuring authentication
  | 'creating_sandbox' // Creating Docker container
  | 'executing'       // Starting agent runner
  | 'running';        // Agent actively working
```

See `src/app/components/features/container-agent-panel/container-agent-status-breadcrumbs.tsx` for the UI implementation.

## Important: Use Subagents Liberally

When performing any research, concurrent subagents can be used for performance and isolation. Use parallel tool calls and tasks where possible.

## Use this tech stack

| Layer              | Technology       | Package                                                                                             | Version          |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| Runtime            | Bun              | https://bun.sh                                                                                      | 1.3.10           |
| Framework          | TanStack Start   | @tanstack/react-start (https://github.com/TanStack/router)                                          | 1.150.0          |
| API Router         | Hono             | hono (https://github.com/honojs/hono)                                                               | 4.11.5           |
| Database           | SQLite           | better-sqlite3 (https://github.com/WiseLibs/better-sqlite3)                                         | 12.6.2           |
| ORM                | Drizzle          | drizzle-orm + drizzle-kit (https://github.com/drizzle-team/drizzle-orm)                             | 0.45.1 / 0.31.8  |
| Client State       | TanStack DB      | @tanstack/db + @tanstack/react-db (https://github.com/TanStack/db)                                  | 0.5.20 / 0.1.64  |
| Agent Events       | Durable Streams  | @durable-streams/* (https://github.com/durable-streams/durable-streams)                              | 0.2.0            |
| AI / Agents        | Claude Agent SDK | @anthropic-ai/claude-agent-sdk (https://github.com/anthropics/claude-agent-sdk-typescript)          | 0.2.19           |
| AI / API           | Anthropic SDK    | @anthropic-ai/sdk (https://github.com/anthropics/anthropic-sdk-typescript)                          | 0.71.2           |
| UI                 | Radix + Tailwind | @radix-ui/* + tailwindcss (https://github.com/radix-ui/primitives)                                  | 1.2.4 / 4.1.18   |
| Workflow Designer  | React Flow       | @xyflow/react (https://github.com/xyflow/xyflow)                                                    | 12.10.0          |
| Graph Layout       | ELK              | elkjs (https://github.com/kieler/elkjs)                                                             | 0.11.0           |
| Drag & Drop        | dnd-kit          | @dnd-kit/core + @dnd-kit/sortable (https://github.com/clauderic/dnd-kit)                            | 6.3.1 / 10.0.0   |
| Icons              | Phosphor         | @phosphor-icons/react (https://github.com/phosphor-icons/react)                                     | 2.1.10           |
| Testing            | Vitest           | vitest (https://github.com/vitest-dev/vitest)                                                       | 4.0.16           |
| UI Testing         | Agent Browser    | agent-browser (https://github.com/anthropics/agent-browser)                                         | 0.7.6            |
| E2E Testing        | Playwright       | playwright + @playwright/test (https://github.com/microsoft/playwright)                             | 1.57.0           |
| Linting/Formatting | Biome            | @biomejs/biome (https://github.com/biomejs/biome)                                                   | 2.3.11           |
| CI/CD              | GitHub Actions   | https://github.com/features/actions                                                                 | -                |

### Utility Libraries

| Package                  | Version | Purpose                                |
| ------------------------ | ------- | -------------------------------------- |
| class-variance-authority | 0.7.1   | Component variant styling (cva)        |
| @paralleldrive/cuid2     | 3.0.6   | Secure collision-resistant IDs         |
| zod                      | 4.3.6   | Schema validation                      |
| @radix-ui/react-slot     | 1.2.4   | asChild prop support                   |
| @tailwindcss/vite        | 4.1.18  | Tailwind v4 Vite plugin                |
| octokit                  | 5.0.5   | GitHub API client (REST + GraphQL)     |
| react-markdown           | 10.1.0  | Markdown rendering                     |
| dockerode                | 4.0.9   | Docker API client                      |
| @kubernetes/client-node  | 1.4.0   | Kubernetes API client                  |
| vite                     | 7.3.1   | Build tool                             |
| react                    | 19.2.3  | UI framework                           |