# User Stories & Specifications

## User Stories

### Project Management

- As a developer, I want to manage multiple projects so I can switch context between codebases
- As a developer, I want each project to have isolated agents so work doesn't conflict
- As a developer, I want to see all my projects at a glance with their current status
- As a developer, I want to quickly switch projects with a keyboard shortcut (⌘P)

### Task Workflow

- As a developer, I want to add tasks to a backlog and have agents pick them up automatically
- As a developer, I want to review agent work before it's merged so I maintain code quality
- As a developer, I want to approve or reject agent changes with feedback for revisions
- As a developer, I want to drag tasks between columns to control workflow

### Concurrent Agents

- As a developer, I want multiple agents working on different features simultaneously
- As a developer, I want to configure the max concurrent agents per project based on my machine capacity
- As a developer, I want each agent to work in isolation so changes don't conflict (git worktrees)

### Real-time Visibility

- As a developer, I want to see agent progress in real-time as they work
- As a developer, I want to see the git diff before approving changes
- As a developer, I want to see tool output from agent commands (Bash, Read, Edit, etc.)

### Collaborative Sessions

- As a developer, I want to join an agent session from any device/tab
- As a developer, I want to see session history when I rejoin a session
- As a developer, I want presence indicators showing who's watching a session
- As a developer, I want to send interactive input to agents (terminal commands) - use durable sessions dont' introduce additional complexity
- As a developer, I want sessions to be addressable via URL for sharing

### Project Isolation

- As a developer, I want each project to have completely separate task queues so work doesn't mix
- As a developer, I want project-specific environment variables copied to each agent worktree
- As a developer, I want to configure per-project initialization scripts (bun install, db migrate, etc.)
- As a developer, I want to set different concurrency limits per project based on complexity

### Agent Sandboxing

- As a developer, I want each agent to work in an isolated git worktree so changes don't conflict
- As a developer, I want agents to have their own dependencies installed in their worktree
- As a developer, I want to restrict which tools agents can use (Read, Edit, Bash whitelist)
- As a developer, I want agent execution to have turn limits to prevent runaway processes
- As a developer, I want all agent tool calls captured for audit trails

### Resource Management

- As a developer, I want agents to queue when concurrency limits are reached
- As a developer, I want worktrees automatically cleaned up after task completion
- As a developer, I want to see which agents are consuming resources per project
- As a developer, I want stale worktrees pruned automatically

### Security Boundaries

- As a developer, I want session data segregated by project (no cross-project leakage)
- As a developer, I want approval required before agent changes merge to main
- As a developer, I want full diff visibility before approving any agent work
- As a developer, I want agent events tagged with agentId for traceability

### Agent Configuration

- As a developer, I want to sync agent configuration from a git repository so git is the source of truth
- As a developer, I want to specify a subfolder path within the repo for configuration files (e.g., `.claude/` or `.claude/`)
- As a developer, I want configuration changes in git to automatically propagate to running agents
- As a developer, I want to version control agent prompts, tool whitelists, and execution settings alongside my code
- As a developer, I want to override global defaults with repo-specific configuration when present

---

## Kanban Workflow

### 4-Stage Approval Process

```text
┌──────────┐    ┌─────────────┐    ┌──────────────────┐    ┌──────────┐
│ Backlog  │ →  │ In Progress │ →  │ Waiting Approval │ →  │ Verified │
└──────────┘    └─────────────┘    └──────────────────┘    └──────────┘
     ↓                ↓                     ↓                    ↓
 Task queue      Agent assigned       Review git diff      Merged & done
                 Worktree created     Approve/reject
```

### Column Transitions

| From             | To               | Trigger            | Action                          |
| ---------------- | ---------------- | ------------------ | ------------------------------- |
| Backlog          | In Progress      | Drag or auto-assign| Create worktree, start agent    |
| In Progress      | Waiting Approval | Agent completes    | Generate diff, pause agent      |
| Waiting Approval | Verified         | User approves      | Merge branch, cleanup worktree  |
| Waiting Approval | In Progress      | User rejects       | Resume agent with feedback      |

---

## Data Models

### Project

```typescript
interface Project {
  id: string;
  name: string;
  path: string;                    // ~/git/my-project
  description?: string;
  config: ProjectConfig;
  maxConcurrentAgents: number;     // Default: 3
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectConfig {
  worktreeRoot: string;            // .worktrees/
  initScript?: string;             // Post-worktree setup
  envFile?: string;                // .env to copy
  defaultBranch: string;           // main
}
```

### Task

```typescript
interface Task {
  id: string;
  projectId: string;
  agentId?: string;

  title: string;
  description?: string;

  // Kanban state
  column: 'backlog' | 'in_progress' | 'waiting_approval' | 'verified';
  position: number;                // Order within column

  // Git integration
  branch?: string;
  worktreePath?: string;

  // Approval workflow
  diffSummary?: string;
  approvedAt?: Date;
  approvedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Durable Sessions

Pattern from [Electric SQL Durable Sessions](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai).

### Session Model

```typescript
interface Session {
  id: string;
  projectId: string;
  taskId?: string;
  agentId?: string;
  url: string;                        // Addressable session URL
  createdAt: Date;
  updatedAt: Date;
}
```

### Session Schema (Standard Schema)

```typescript
// Multiplexed message types for sessions
const sessionSchema = createStateSchema({
  chunks: { schema: chunkSchema, type: 'chunk' },       // Token streams
  toolCalls: { schema: toolSchema, type: 'tool' },     // Agent tool events
  presence: { schema: presenceSchema, type: 'presence' }, // Who's watching
  terminal: { schema: terminalSchema, type: 'terminal' }, // Interactive I/O
  workflow: { schema: workflowSchema, type: 'workflow' }, // Approval events
});
```

### Agent Events

```typescript
type AgentEvent =
  | { type: 'state:update'; payload: AgentState }
  | { type: 'agent:step'; payload: AgentStep }
  | { type: 'tool:start'; tool: string; input: unknown }
  | { type: 'tool:result'; tool: string; output: string }
  | { type: 'stream:token'; text: string }
```

### Workflow Events

```typescript
type WorkflowEvent =
  // Approval workflow
  | { type: 'approval:requested'; taskId: string; diff: string }
  | { type: 'approval:approved'; taskId: string; approver: string }
  | { type: 'approval:rejected'; taskId: string; reason: string }
  // Worktree lifecycle
  | { type: 'worktree:created'; branch: string; path: string }
  | { type: 'worktree:merged'; branch: string }
  | { type: 'worktree:removed'; branch: string }
  // Project events
  | { type: 'project:switched'; projectId: string }
```

### Presence Events

```typescript
type PresenceEvent =
  | { type: 'presence:joined'; userId: string; timestamp: number }
  | { type: 'presence:left'; userId: string; timestamp: number }
  | { type: 'presence:cursor'; userId: string; x: number; y: number }
```

### Terminal Events (Bidirectional)

```typescript
type TerminalEvent =
  | { type: 'terminal:input'; data: string; timestamp: number }
  | { type: 'terminal:output'; data: string; timestamp: number }
```

### Extended Agent State

```typescript
interface AgentState {
  status: 'idle' | 'starting' | 'running' | 'paused' | 'error' | 'completed';
  sessionId?: string;
  taskId?: string;
  turn?: number;
  progress?: number;
  currentTool?: string;
  diff?: string;
  feedback?: string;
}
```

### Session Capabilities

| Feature      | Description                                      |
| ------------ | ------------------------------------------------ |
| Multi-user   | Real-time collaboration with presence indicators |
| Multi-agent  | Concurrent agent execution in same session       |
| Multi-device | Synchronization across tabs/devices              |
| Persistent   | Sessions addressable via URL, join anytime       |
| Replay       | Historical session access, audit trails          |
| Bidirectional| Interactive terminal I/O via optimistic writes   |

---

## Keyboard Shortcuts

| Shortcut | Action                 |
| -------- | ---------------------- |
| `⌘P`     | Open project picker    |
| `⌘⇧N`    | New project            |
| `⌘1`     | Go to Agents view      |
| `⌘2`     | Go to Tasks/Kanban view|
| `⌘R`     | Run selected agent     |
| `⌘.`     | Stop agent             |
| `⌘T`     | New task               |
| `⌘↵`     | Approve task           |

---

## UI Views

### Project Picker (Modal)

- Search/filter projects
- Show recent projects
- Display project status (running agents, task counts)
- Keyboard navigation (↑↓ to select, ↵ to open)

### Multi-Project Dashboard

- Grid of project cards
- Mini Kanban bars showing task distribution
- Active agent indicators
- Quick actions (open, run agent)

### Task Board (Kanban)

- 4 columns: Backlog, In Progress, Waiting Approval, Verified
- Drag-and-drop with dnd-kit
- Task cards with priority, labels, assignee
- Real-time updates via Durable Sessions

### Agent Session View

- Split pane: stream on left, file preview on right
- Stream entries showing tool calls and output
- Syntax-highlighted code diffs
- Task queue at bottom
- Presence indicators (who's watching)
- Interactive terminal input (bidirectional)
- Session URL for sharing/rejoining

---

## Component Organization

When a view grows beyond ~500 lines, extract to subfolder:

```text
app/components/views/
├── kanban-board/
│   ├── index.tsx
│   ├── components/
│   │   ├── column.tsx
│   │   ├── task-card.tsx
│   │   └── drag-overlay.tsx
│   ├── dialogs/
│   │   └── approval-dialog.tsx
│   ├── hooks/
│   │   └── use-board-actions.ts
│   └── constants.ts
├── agent-session/
│   ├── index.tsx
│   ├── components/
│   │   ├── stream-entry.tsx
│   │   ├── file-preview.tsx
│   │   ├── presence-indicator.tsx
│   │   └── terminal-input.tsx
│   └── hooks/
│       └── use-agent-session.ts
└── project-picker/
    ├── index.tsx
    └── components/
        └── project-item.tsx
```

---

## Concurrency Management

### Default Configuration

- Max 6 concurrent agents per project
- Configurable via project settings
- Queue system for tasks awaiting agent assignment

### Agent Lifecycle

1. Task moves to "In Progress"
2. System checks `canStartAgent(projectId)`
3. If under limit: create worktree, start agent
4. If at limit: task waits in queue
5. When agent completes: next queued task starts

---

## Worktree Lifecycle

### Creation

```bash
1. git worktree add .worktrees/{branch} -b {branch} {baseBranch}
2. cp .env .worktrees/{branch}/.env
3. cd .worktrees/{branch} && bun install
4. Set agent cwd to worktree path
```

### Completion

```text
1. Agent finishes task
2. Generate git diff for review
3. Move task to "Waiting Approval"
4. Pause agent
```

### Merge (on approval)

```bash
1. git add -A && git commit
2. git merge {branch} --no-ff
3. git worktree remove .worktrees/{branch}
4. git worktree prune
```

---

## Isolation Architecture

### Multi-Layer Isolation

| Layer          | Mechanism                        | Scope              |
| -------------- | -------------------------------- | ------------------ |
| Filesystem     | Git worktrees + `cwd` scoping    | Per-agent task     |
| Configuration  | Per-worktree `.env` files        | Per-agent env      |
| Process        | Isolated spawn with `maxTurns`   | Per-agent exec     |
| Data           | `projectId` + `sessionId` filter | Per-project        |
| Concurrency    | `maxConcurrentAgents` quota      | Per-project limit  |
| Git State      | Separate branches per feature    | Per-task           |
| Dependencies   | Worktree-local `node_modules/`   | Per-worktree       |
| Events         | Durable Sessions by `agentId`    | Per-agent pub/sub  |
| Security       | Tool whitelist + audit trails    | Per-agent perms    |

### Worktree Directory Structure

```text
project/
├── .git/                     # Shared git state
├── main/                     # Primary worktree
└── .worktrees/               # Agent-specific working directories
    ├── feature-auth/         # Agent 1 isolated workspace
    ├── feature-dashboard/    # Agent 2 isolated workspace
    └── feature-api/          # Agent 3 isolated workspace
```

### Agent Execution Context

```typescript
interface AgentExecutionContext {
  agentId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  cwd: string;                    // Worktree path
  allowedTools: string[];         // Tool whitelist
  maxTurns: number;               // Execution limit
  env: Record<string, string>;    // Isolated environment
}
```

### Tool Access Control

```typescript
// Per-agent tool whitelist
const agentOptions = {
  allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
  model: 'claude-sonnet-4-6',
};

// All tool calls captured for audit
publishAgentStep(agentId, {
  type: 'tool:start',
  tool: input.tool_name,
  input: input.tool_input,
  timestamp: Date.now(),
});
```

### Session Data Boundaries

```typescript
// All queries filtered by project context
useQuery(collection, (q) =>
  q.where('projectId', '==', projectId)
   .where('sessionId', '==', sessionId)
);

// Events published to agent-specific stream
streams.publish(`agent:${agentId}`, event);

// Subscribers receive only their subscribed agent's events
client.subscribe(`agent:${agentId}`, callback);
```
