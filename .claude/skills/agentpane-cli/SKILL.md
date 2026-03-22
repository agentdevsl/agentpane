---
name: agentpane-cli
description: Manage AgentPane codespaces, tasks, agents, sessions, and worktrees from the CLI. Use when the user needs to list/create/manage tasks, start/stop agents, view session events, check git status, or interact with the AgentPane API programmatically.
---

# AgentPane CLI

The AgentPane CLI (`agentpane`) is a Go-based command-line tool for managing codespaces, tasks, agents, sessions, and worktrees through the AgentPane API. It provides full programmatic access to the AgentPane platform for automation, scripting, and interactive use.

## Quick Start

### Build

```bash
cd /Users/simon.lynch/git/agentpane_nocode-cli/cli
make build
```

This produces the `agentpane` binary in the `cli/` directory.

### Verify

```bash
./agentpane health
```

Expected output: `AgentPane API is healthy` or JSON health response with `-json`.

### Minimal Setup

```bash
export AP_API_TOKEN="ap_your_token"
export AP_ADDRESS="http://localhost:3001"
./agentpane health
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AP_API_TOKEN` | API authentication token | (required) |
| `AP_ADDRESS` | AgentPane API base URL | `http://localhost:3001` |
| `AP_CODESPACE` | Default codespace ID (avoids `-codespace` on every command) | (none) |

### Global Flags

These flags override the corresponding environment variables:

| Flag | Description |
|------|-------------|
| `-token <string>` | API token (overrides `AP_API_TOKEN`) |
| `-address <string>` | API base URL (overrides `AP_ADDRESS`) |
| `-codespace <string>` | Codespace ID (overrides `AP_CODESPACE`) |
| `-json` | Output in JSON format instead of human-readable tables |

### Precedence

Flags take precedence over environment variables. For example:

```bash
# Uses AP_ADDRESS from env, but overrides token
AP_ADDRESS="http://localhost:3001" ./agentpane -token "ap_override" health
```

## Commands

### Health Check

Verify the AgentPane API is reachable and healthy.

```bash
agentpane health
```

```bash
agentpane health -json
```

### Codespace Management

Codespaces are the top-level organizational unit (formerly called "projects"). Each codespace maps to a git repository.

#### List all codespaces

```bash
agentpane codespace list
```

```bash
agentpane codespace list -json
```

#### Show codespace details

```bash
agentpane codespace show <codespace-id>
```

```bash
agentpane codespace show <codespace-id> -json
```

#### Create a codespace

```bash
agentpane codespace create -name "My Project" -path "/path/to/repo"
```

With a folder assignment:

```bash
agentpane codespace create -name "My Project" -path "/path/to/repo" -folder-id <folder-id>
```

### Task Management

Tasks represent units of work that agents execute. Tasks move through columns on a Kanban board.

#### Task columns (lifecycle)

| Column | Description |
|--------|-------------|
| `backlog` | Not yet scheduled |
| `queued` | Ready to be picked up |
| `in_progress` | Agent is actively working |
| `waiting_approval` | Agent completed, awaiting human review |
| `verified` | Work approved and complete |

#### Task priorities

| Priority | Description |
|----------|-------------|
| `high` | Urgent work |
| `medium` | Normal priority |
| `low` | Can wait |

#### List tasks

```bash
agentpane task list -codespace <codespace-id>
```

With the `AP_CODESPACE` env var set:

```bash
agentpane task list
```

#### Create a task

```bash
agentpane task create -codespace <codespace-id> -title "Fix login bug" -priority high
```

```bash
agentpane task create -codespace <codespace-id> -title "Refactor auth module" -priority medium
```

#### Show task details

```bash
agentpane task show <task-id>
```

```bash
agentpane task show <task-id> -json
```

#### Move a task to a different column

```bash
agentpane task move <task-id> in_progress
```

```bash
agentpane task move <task-id> queued
```

#### Run a task (shortcut)

This is a convenience command that moves a task to `in_progress`, which automatically triggers agent assignment and execution.

```bash
agentpane task run <task-id>
```

This is equivalent to `agentpane task move <task-id> in_progress`.

#### Approve a task plan

When an agent completes planning and the task is in `waiting_approval`, approve the plan to proceed to execution:

```bash
agentpane task approve <task-id>
```

#### Reject a task plan

Reject a plan with a reason, sending the agent back to revise:

```bash
agentpane task reject <task-id> -reason "needs more detail on error handling"
```

### Agent Management

Agents are Claude-powered workers that execute tasks. Each agent runs in its own git worktree for isolation.

#### Agent statuses

| Status | Description |
|--------|-------------|
| `idle` | Not currently working |
| `starting` | Being initialized |
| `planning` | Exploring codebase and creating a plan |
| `running` | Executing the approved plan |
| `paused` | Temporarily stopped |
| `error` | Encountered an error |
| `completed` | Finished work |

#### List agents

```bash
agentpane agent list -codespace <codespace-id>
```

#### Start an agent on a task

```bash
agentpane agent start <agent-id> -task <task-id>
```

#### Stop an agent

```bash
agentpane agent stop <agent-id>
```

### Session Management

Sessions track the event stream for an agent's execution. Each agent run creates a session with real-time events.

#### List sessions

```bash
agentpane session list -codespace <codespace-id>
```

Filter by status:

```bash
agentpane session list -codespace <codespace-id> -status active
```

#### Show session details

```bash
agentpane session show <session-id>
```

#### View session events

View the event stream for a session (agent turns, tool calls, outputs):

```bash
agentpane session events <session-id>
```

Limit the number of events:

```bash
agentpane session events <session-id> -limit 50
```

With JSON output for parsing:

```bash
agentpane session events <session-id> -limit 100 -json
```

### Worktree Management

Worktrees are isolated git working directories created for each agent. They allow agents to make changes without affecting the main branch.

#### List worktrees

```bash
agentpane worktree list -codespace <codespace-id>
```

#### View worktree diff

See what changes an agent made in its worktree:

```bash
agentpane worktree diff <worktree-id>
```

#### Merge a worktree

Merge the agent's changes back to the target branch:

```bash
agentpane worktree merge <worktree-id>
```

Merge and delete the worktree after:

```bash
agentpane worktree merge <worktree-id> -delete
```

Specify a target branch:

```bash
agentpane worktree merge <worktree-id> -delete -target-branch main
```

### Git Operations

Convenience commands for checking git status of codespaces.

#### Repository status

```bash
agentpane git status -codespace <codespace-id>
```

#### List branches

```bash
agentpane git branches -codespace <codespace-id>
```

## Common Workflows

### 1. Create and Run a Task End-to-End

This is the most common workflow: create a task, run it, monitor progress, approve the plan, review changes, and merge.

```bash
# Set default codespace to avoid repeating -codespace
export AP_CODESPACE="cs_abc123"

# Create the task
agentpane task create -title "Add input validation to signup form" -priority high
# Output: Created task tk_xyz789

# Run the task (assigns an agent and starts planning)
agentpane task run tk_xyz789

# Check agent status
agentpane agent list

# Watch session events to monitor progress
agentpane session list -status active
agentpane session events <session-id> -limit 100

# Once the agent finishes planning, approve the plan
agentpane task approve tk_xyz789

# Monitor execution
agentpane session events <session-id> -limit 200

# When the task moves to waiting_approval, review the diff
agentpane worktree list
agentpane worktree diff <worktree-id>

# If satisfied, merge the changes
agentpane worktree merge <worktree-id> -delete -target-branch main
```

### 2. Batch Create Tasks

```bash
export AP_CODESPACE="cs_abc123"

agentpane task create -title "Fix: null pointer in user service" -priority high
agentpane task create -title "Add unit tests for auth middleware" -priority medium
agentpane task create -title "Update README with API docs" -priority low
agentpane task create -title "Refactor database connection pooling" -priority medium
```

### 3. Monitor Active Agents

```bash
export AP_CODESPACE="cs_abc123"

# See all agents and their current status
agentpane agent list

# See active sessions
agentpane session list -status active

# Get detailed events for a specific session
agentpane session events <session-id> -limit 50
```

### 4. Review and Merge Agent Work

```bash
# List all worktrees for the codespace
agentpane worktree list -codespace cs_abc123

# Review changes from a specific agent
agentpane worktree diff wt_def456

# Merge to main and clean up
agentpane worktree merge wt_def456 -delete -target-branch main
```

### 5. Scripting with JSON Output

All commands support `-json` for machine-readable output, enabling integration with `jq` and other tools.

```bash
# Get all task titles
agentpane task list -json | jq '.[] | .title'

# Get IDs of high-priority tasks
agentpane task list -json | jq '.[] | select(.priority == "high") | .id'

# Get active agent count
agentpane agent list -json | jq '[.[] | select(.status == "running")] | length'

# Get the latest session events as structured data
agentpane session events <session-id> -limit 10 -json | jq '.[] | {type: .type, timestamp: .timestamp}'

# Find worktrees with uncommitted changes
agentpane worktree list -json | jq '.[] | select(.hasChanges == true) | .id'
```

### 6. Quick Health Check Script

```bash
#!/bin/bash
if agentpane health -json | jq -e '.healthy' > /dev/null 2>&1; then
    echo "AgentPane API is up"
else
    echo "AgentPane API is DOWN" >&2
    exit 1
fi
```

## Project Structure

The CLI source code is at `/Users/simon.lynch/git/agentpane_nocode-cli/cli/`:

```
cli/
├── go.mod              # Go module definition
├── go.sum              # Dependency checksums
├── Makefile            # Build, test, lint targets
├── Dockerfile          # Multi-stage container build
├── .gitignore          # Ignore built binary
├── main.go             # Entry point (if exists)
├── sdk/                # API client library
│   ├── client.go       # HTTP client for AgentPane API
│   ├── types.go        # Request/response type definitions
│   ├── errors.go       # Error types and handling
│   └── health.go       # Health check endpoint
├── internal/           # Internal packages
│   ├── command/        # Command implementations
│   ├── logging/        # Structured logging (go-hclog)
│   └── output/         # Table and JSON output formatting
└── version/
    └── version.go      # Version constant (injected at build via ldflags)
```

## Build and Development

### Build the binary

```bash
cd /Users/simon.lynch/git/agentpane_nocode-cli/cli
make build
```

### Run tests

```bash
make test
```

### Format and lint

```bash
make lint
```

### Full pipeline (lint + test + build)

```bash
make all
```

### Docker build

```bash
docker build -t agentpane-cli:latest --build-arg VERSION=1.0.0 .
```

### Clean

```bash
make clean
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/mitchellh/cli` | CLI framework (subcommands, help text, flags) |
| `github.com/hashicorp/go-hclog` | Structured logging |
| `github.com/fatih/color` | Colored terminal output |

## Troubleshooting

### "connection refused" errors

The API server is not running. Start it:

```bash
cd /Users/simon.lynch/git/agentpane_nocode-cli
npm run dev
```

The API runs on port 3001 by default.

### "unauthorized" errors

Check that `AP_API_TOKEN` is set correctly:

```bash
echo $AP_API_TOKEN
```

Or pass it explicitly:

```bash
agentpane -token "ap_your_token" health
```

### "codespace not found" errors

Verify the codespace ID:

```bash
agentpane codespace list
```

### Build failures

Ensure Go 1.24+ is installed:

```bash
go version
```

If dependencies are missing, run:

```bash
cd /Users/simon.lynch/git/agentpane_nocode-cli/cli
go mod tidy
```

### Viewing raw API responses

Use `-json` to see the full API response for debugging:

```bash
agentpane task show <task-id> -json
```
