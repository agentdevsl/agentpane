# CLAUDE.md

where possible use concurrent OPUS subagents with max effort

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
- **biome `--max-diagnostics`**: By default `biome check` truncates output at ~20 diagnostics. Use `--max-diagnostics=500` to see all errors/warnings. Without this, you may think you've fixed all issues when truncated errors remain. Always use `--diagnostic-level=error` to filter noise from warnings.
- **`gh pr edit` fails with `read:org` scope error**: The GitHub token lacks `read:org` scope needed by `gh pr edit` (GraphQL). Use the REST API instead: `gh api repos/OWNER/REPO/pulls/NUMBER --method PATCH -f body="..." -f title="..."`
- **`/v1/stream` 404 in dev**: Expected — Caddy durable streams proxy is not running locally. The DurableStreamTestServer on port 3002 handles streams in dev. The bootstrap phase handles this gracefully (non-fatal).
- **Chrome console `[Violation]` warnings in dev**: Two sources, both dev-only:
  - `'message' handler took Nms` — Vite HMR cold-starting 235+ modules synchronously via WebSocket. Not actionable.
  - `'setInterval' handler took Nms` — Polling intervals (sandbox status 30s, connection health 15s, session presence 30s, system health 30s) firing during heavy React renders.

### Naming: Project → Codespace

The codebase was renamed from "project" to "codespace". Always use `codespace`/`codespaceId` in code, API params, routes, and tests — never `project`/`projectId`. Key mappings:

| Old | New |
|-----|-----|
| `project` | `codespace` |
| `projectId` | `codespaceId` |
| `/api/projects/` | `/api/codespaces/` |
| `project.service.ts` | `codespace.service.ts` |
| `team-projects` | `team-project-folders` |
| `project-members` | `codespace-members` |
| `ProjectContext` | `CodespaceContext` |

### API Response Shapes

The `apiServerFetch<T>` wrapper returns `{ ok: true, data: T }`. The `T` type parameter must match the actual `data` field in the JSON response — NOT the full response shape. Example:

```typescript
// Server returns: { ok: true, data: [...events...], pagination: {...} }
// T is the type of the `data` field, NOT the full response:
apiServerFetch<Array<{ id: string; type: string }>>('/api/sessions/x/events')
// result.data = [...events...] (the array directly)
// WRONG: apiServerFetch<{ data: Array<...>, pagination: {...} }>  ← result.data.data would be undefined
```

### SVG and Theme Colors

Never hardcode hex colors in SVG elements. Use CSS custom properties that adapt to light/dark themes:

| Instead of | Use |
|-----------|-----|
| `fill="#e6edf3"` | `fill="var(--fg-default)"` |
| `fill="#8b949e"` | `fill="var(--fg-muted)"` |
| `fill="#6e7681"` | `fill="var(--fg-subtle)"` |
| `stroke="#21262d"` | `stroke="var(--border-default)"` |
| `fill="#0d1117"` | `fill="var(--bg-canvas)"` |

### Tailwind Color Token Names

The design system uses `attention` not `warning` for yellow/amber colors. Available semantic colors:
- `accent` (blue), `success` (green), `danger` (red), `attention` (amber/yellow), `done` (purple), `secondary` (pink), `claude` (orange)
- Each has: `DEFAULT`, `-muted`, `-subtle`, `-emphasis` variants

### React Flow / Topology Layout

When rendering React Flow inside a flex/absolute layout, the container must have an explicit height. `flex-1` does NOT work inside `position: absolute` containers — use `h-full` instead. The `TopologyInner` wrapper must use `h-full` not `flex-1`.

### Tests: Keep in Sync with Renames

When renaming entities (tables, fields, API params), always update ALL test files. Search with: `grep -r "oldName" src/services/__tests__/ tests/ src/server/routes/__tests__/`. Tests reference field names, API endpoints, and service methods directly — they won't fail at compile time but will fail at runtime in CI.

### Functional Tests: Real Service Transitions

Functional tests in `tests/functional/` must exercise **real service code** at every state transition — never simulate transitions with raw DB updates. The goal is to test the actual orchestration logic, not just data shapes.

**Rules:**
- Every state transition (task column change, plan approval, agent completion) must flow through the real service method (`TaskService.moveColumn()`, `PlanApprovalService.handlePlanReady()`, `PlanApprovalService.approvePlan()`, `updateTaskOnAgentComplete()`, `TaskService.approve()`)
- Only mock external I/O boundaries: Claude Agent SDK, sandbox providers (Docker/K8s), git operations (CommandRunner), DurableStreams
- Use real `SandboxStateManager` for in-memory state tracking — verify both DB and memory state
- Verify the plan approval → execution transition passes `phase: 'execute'`, the plan text as prompt, and `sdkSessionId` for session resume
- Verify skill/label/priority fields are preserved through the entire lifecycle (backlog → verified)
- Run separately: `npx vitest run --project functional`

**Key transitions that must use real services:**
1. `TaskService.create()` — task with skill in backlog
2. `TaskService.moveColumn()` — backlog → in_progress (triggers agent with skill in prompt)
3. `PlanApprovalService.handlePlanReady()` — stores plan in DB + memory, moves to waiting_approval
4. `PlanApprovalService.approvePlan()` — starts execution with phase:execute + sdkSessionId
5. `PlanApprovalService.rejectPlan()` — clears all plan state, moves to backlog
6. `updateTaskOnAgentComplete()` — moves to waiting_approval with completion status
7. `TaskService.approve()` — getDiff → merge → verified with diffSummary

### agent-runner Lockfile

After modifying `agent-runner/package.json` or its dependencies, regenerate the lockfile: `cd agent-runner && bun install && cd ..`. CI uses `--frozen-lockfile` and will fail if the lockfile is stale. The lockfile is `agent-runner/bun.lock` (not `bun.lockb`).

### CI/CD and PR Process

#### Pre-commit hooks (automatic)

Pre-commit hooks run on every `git commit`:
- **Biome Check** — lint + format. Auto-fixes files; if files are modified, the commit fails and you must re-stage and retry.
- **TypeScript Type Check** — `tsc --noEmit`
- **Detect secrets** — blocks commits with API keys, tokens, etc.
- **Fix end of files / trim trailing whitespace** — auto-fix

Pre-push hooks run on `git push`:
- **Biome Fix** — final format pass
- **Detect secrets** — re-check before push

#### Before creating a PR

1. Run `npx @biomejs/biome check --write --max-diagnostics=500 --diagnostic-level=error src/` to fix all lint issues upfront
2. Run `npx tsc --noEmit` to verify type checking passes
3. Run `npx vitest run` to verify tests pass — CI runs tests in 3 shards, failures that pass locally often indicate stale names/imports
4. Stage specific files (not `git add -A`) and commit — if Biome auto-fixes files, re-stage and commit again
5. Push to remote with `git push -u origin <branch>`

#### Creating the PR

Use `gh pr create` with a structured body:
```bash
gh pr create --title "feat: short title" --body "$(cat <<'EOF'
## Summary
- Bullet points of what changed

## Test plan
- [ ] Manual verification steps
- [ ] Edge cases to check

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

#### Multi-agent code review (before committing or before PR)

Run `/pr-review-toolkit:review-pr` to launch parallel review agents. Use up to 4 Opus agents for comprehensive coverage:

**Review agent types:**
- **code-reviewer** — bugs, CLAUDE.md compliance, import patterns, logic errors
- **silent-failure-hunter** — swallowed errors, empty catches, fake success responses, path traversal
- **pr-test-analyzer** — test coverage gaps, missing fixtures, priority test list
- **type-design-analyzer** — type safety, invariant enforcement, encapsulation
- **code-simplifier** — duplication, unnecessary complexity, dead code

**Review workflow:**

1. **Launch agents in parallel** — each agent gets the `git diff` and focuses on its specialty
2. **Compile findings** — aggregate into Critical / Important / Suggestion categories
3. **Fix critical + important** — edit files directly, verify with `npx tsc --noEmit`
4. **Re-run review** — launch agents again to verify fixes and catch regressions
5. **Repeat** until no critical/important issues remain (typically 2-3 rounds)

**What each round catches:**
- Round 1: Security issues (path traversal, injection), logic bugs, type mismatches
- Round 2: Fix verification + new issues introduced by fixes
- Round 3: Final verification — should be clean

**Key patterns found in reviews:**
- Shell commands: use positional args (`$1`, `$2` with `--` separator), never string interpolation
- Skill/resource IDs in paths: validate with `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` regex
- YAML values from user input: escape `"`, `\n`, `\r`, `\` before interpolation
- API error responses: never return `{ ok: true, data: [] }` to mask a real error
- Try/catch scope: narrow to the specific operation, don't wrap unrelated code

#### After PR creation — CI and review comments

1. **Poll CI**: `gh run watch <run-id> --exit-status` or `gh pr checks <pr-number> --watch`
2. **Check for review comments** (bot reviews like Gemini, human reviewers):
   ```bash
   gh api repos/agentdevsl/agentpane/pulls/<number>/comments  # inline review comments
   gh api repos/agentdevsl/agentpane/issues/<number>/comments  # general PR comments
   ```
3. **Evaluate each comment**:
   - If valid: fix in code, commit, push
   - If incorrect (e.g., bot misunderstands context): decline with explanation in PR comment
   - If spec-only: update the spec doc, not the code
4. **Commit fixes**: use a descriptive commit message referencing what was addressed
5. **Comment on PR** explaining what was fixed and what was declined:
   ```bash
   gh pr comment <number> --body "Addressed review comments in <commit>:
   1. Fixed X — <explanation>
   2. Fixed Y — <explanation>
   3. Declined Z — <reason>"
   ```
6. **Re-poll CI** to verify fixes pass: `gh pr checks <number> --watch`

#### CI pipeline (GitHub Actions)

The CI pipeline runs these jobs:
- **install** — `bun install --frozen-lockfile`
- **build** — `bun run build`
- **lint-and-typecheck** — Biome + TypeScript
- **test (1/3, 2/3, 3/3)** — Vitest sharded across 3 runners

All jobs must pass before merge. The `--frozen-lockfile` flag means CI fails if `bun.lock` is stale — always run `bun install` after modifying dependencies.

#### Worktree workflow

For feature branches, use git worktrees to work in isolation:
```bash
git worktree add .worktrees/<name> -b <branch> main
cd .worktrees/<name>
# ... work, commit, push, create PR
```

All file paths in commits and PRs should be relative to the worktree root. The worktree shares `.git` with the main repo but has its own working tree.

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
   - Captures plan content and options
   - Publishes `agent:plan_ready` event
   - Task stays in `in_progress`, agent status is `planning`

5. **Plan Approval** (user action)
   - User reviews the plan in the UI
   - On approval: execution phase begins
   - On rejection: agent can be asked to revise

6. **Execution Phase** (`src/lib/agents/stream-handler.ts:runAgentExecution`)
   - Creates session with `permissionMode: 'acceptEdits'`
   - Executes the approved plan
   - On completion: task moves to `waiting_approval`

### Team Mode

Team mode enables parallel agent execution for complex tasks. When the planning agent calls `ExitPlanMode` with `launchSwarm: true`, the execution phase spawns multiple sub-agents that work concurrently on different parts of the plan. Each sub-agent gets its own worktree for isolated work.

```typescript
interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;      // Enable team mode
  teammateCount?: number;     // Number of parallel agents
  pushToRemote?: boolean;     // Remote session support
}
```

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
| Build              | Vite             | vite (https://github.com/vitejs/vite)                                                               | 8.0.1            |
| Framework          | TanStack Start   | @tanstack/react-start (https://github.com/TanStack/router)                                          | 1.166.1          |
| API Router         | Hono             | hono (https://github.com/honojs/hono)                                                               | 4.12.7           |
| Database           | SQLite           | better-sqlite3 (https://github.com/WiseLibs/better-sqlite3)                                         | 12.8.0           |
| ORM                | Drizzle          | drizzle-orm + drizzle-kit (https://github.com/drizzle-team/drizzle-orm)                             | 0.45.1 / 0.31.10 |
| Client State       | TanStack DB      | @tanstack/db + @tanstack/react-db (https://github.com/TanStack/db)                                  | 0.5.33 / 0.1.77  |
| Agent Events       | Durable Streams  | @durable-streams/* (https://github.com/durable-streams/durable-streams)                              | 0.2.x            |
| AI / Agents        | Claude Agent SDK | @anthropic-ai/claude-agent-sdk (https://github.com/anthropics/claude-agent-sdk-typescript)          | 0.2.76           |
| AI / API           | Anthropic SDK    | @anthropic-ai/sdk (https://github.com/anthropics/anthropic-sdk-typescript)                          | 0.78.0           |
| Memory             | Honcho           | @honcho-ai/sdk (https://github.com/plastic-labs/honcho)                                             | 2.0.1            |
| UI                 | Radix + Tailwind | @radix-ui/* + tailwindcss (https://github.com/radix-ui/primitives)                                  | 1.2.4 / 4.1.18   |
| Workflow Designer  | React Flow       | @xyflow/react (https://github.com/xyflow/xyflow)                                                    | 12.10.1          |
| Graph Layout       | ELK              | elkjs (https://github.com/kieler/elkjs)                                                             | 0.11.0           |
| Drag & Drop        | dnd-kit          | @dnd-kit/core + @dnd-kit/sortable (https://github.com/clauderic/dnd-kit)                            | 6.3.1 / 10.0.0   |
| Icons              | Phosphor         | @phosphor-icons/react (https://github.com/phosphor-icons/react)                                     | 2.1.10           |
| Testing            | Vitest           | vitest (https://github.com/vitest-dev/vitest)                                                       | 4.0.16           |
| UI Testing         | Agent Browser    | agent-browser (https://github.com/anthropics/agent-browser)                                         | 0.7.6            |
| E2E Testing        | Playwright       | playwright + @playwright/test (https://github.com/microsoft/playwright)                             | 1.58.1           |
| Linting/Formatting | Biome            | @biomejs/biome (https://github.com/biomejs/biome)                                                   | 2.4.4            |
| CI/CD              | GitHub Actions   | https://github.com/features/actions                                                                 | -                |

### Utility Libraries

| Package                  | Version | Purpose                                |
| ------------------------ | ------- | -------------------------------------- |
| class-variance-authority | 0.7.1   | Component variant styling (cva)        |
| @paralleldrive/cuid2     | 3.3.0   | Secure collision-resistant IDs         |
| zod                      | 4.3.6   | Schema validation                      |
| @radix-ui/react-slot     | 1.2.4   | asChild prop support                   |
| @tailwindcss/vite        | 4.2.2   | Tailwind v4 Vite plugin                |
| octokit                  | 5.0.5   | GitHub API client (REST + GraphQL)     |
| react-markdown           | 10.1.0  | Markdown rendering                     |
| dockerode                | 4.0.10  | Docker API client                      |
| @kubernetes/client-node  | 1.4.0   | Kubernetes API client                  |
| vite                     | 8.0.1   | Build tool                             |
| react                    | 19.2.4  | UI framework                           |