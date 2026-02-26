# AgentPane

**Multi-agent AI development platform with real-time task orchestration, sandboxed execution, and Terraform no-code composition**

[![Build](https://img.shields.io/badge/build-passing-brightgreen)](/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Overview

AgentPane is a multi-agent AI development platform built on the Claude Agent SDK. It enables concurrent AI agents to work on tasks with full project isolation via git worktrees and sandboxed containers. Agents follow a plan-then-execute workflow with optional swarm mode for parallel execution.

The platform includes a visual Kanban board for task management, real-time streaming of agent progress, integrated code review workflows, and a Terraform no-code composer that generates HCL configurations from natural language.

## Features

### Agent Orchestration

- **Multi-Agent Concurrency** — Multiple AI agents working simultaneously on different tasks
- **Plan → Execute Workflow** — Agents plan first, then execute after user approval
- **Swarm Mode** — Agents can request parallel execution with multiple sub-agents
- **Git Worktree Isolation** — Each agent works in an isolated git worktree
- **Session Replay** — Full session history with timeline and event filtering

### Task Management

- **Kanban Board** — Drag-and-drop workflow: Backlog → In Progress → Waiting Approval → Verified
- **Auto-Start** — Moving a task to "In Progress" automatically assigns and starts an agent
- **Code Review** — Approve or reject agent changes with diff visualization before merge

### Sandboxed Execution

- **Docker Containers** — Run agents in isolated Docker containers with project bind-mounts
- **Agent Sandbox SDK** — Kubernetes CRD-based sandbox provider (`@agentpane/agent-sandbox-sdk`)
- **Per-Project or Shared** — Choose between a shared container or per-project isolation

### Terraform No-Code Composer

- **Natural Language → HCL** — Generate Terraform configurations from plain English via Claude
- **Module Browser** — Browse and search Terraform providers and modules from the registry
- **Dependency Diagrams** — Visual resource dependency graphs
- **Composition History** — Track and revisit previous compositions
- **Variable Forms** — Interactive variable input for generated configurations

### Integrations

- **GitHub OAuth** — Repository sync, webhook support, and branch/PR operations
- **Workflow Designer** — Visual AI-powered workflow editor with drag-and-drop (React Flow + ELK)
- **CLI Monitor** — Real-time monitoring of Claude CLI sessions (`@agentpane/cli-monitor`)
- **Durable Streams** — Real-time event streaming via Caddy front door (LMDB-backed SSE + long-poll)

## Tech Stack

| Layer | Technology | Package | Version |
|-------|------------|---------|---------|
| Runtime | Bun | [bun.sh](https://bun.sh) | 1.3.10 |
| Front Door | Caddy (durable-streams-server) | [durable-streams](https://github.com/anthropics/durable-streams) | 0.2.1 |
| Framework | TanStack Start | @tanstack/react-start | 1.161.3 |
| API Router | Hono | hono | 4.11.9 |
| Database | SQLite + PostgreSQL | better-sqlite3 / postgres | 12.6.2 / 3.4.8 |
| ORM | Drizzle | drizzle-orm + drizzle-kit | 0.45.1 / 0.31.8 |
| Client State | TanStack DB | @tanstack/db + @tanstack/react-db | 0.5.28 / 0.1.73 |
| Real-time | Durable Streams | @durable-streams/* | 0.2.1 |
| AI / Agents | Claude Agent SDK | @anthropic-ai/claude-agent-sdk | 0.2.55 |
| AI / API | Anthropic SDK | @anthropic-ai/sdk | 0.72.1 |
| UI | Radix + Tailwind | @radix-ui/* + tailwindcss | 1.2.4 / 4.1.18 |
| Flow Editor | React Flow | @xyflow/react | 12.10.1 |
| Graph Layout | ELK | elkjs | 0.11.0 |
| Drag & Drop | dnd-kit | @dnd-kit/core + @dnd-kit/sortable | 6.3.1 / 10.0.0 |
| Icons | Phosphor | @phosphor-icons/react | 2.1.10 |
| Syntax | Shiki | shiki | 3.22.0 |
| Testing | Vitest | vitest | 4.0.16 |
| E2E Testing | Playwright | @playwright/test | 1.58.1 |
| Linting | Biome | @biomejs/biome | 2.4.4 |
| Containers | Dockerode | dockerode | 4.0.9 |
| Kubernetes | K8s Client | @kubernetes/client-node | 1.4.0 |
| GitHub | Octokit | octokit | 5.0.5 |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.3.10+
- [Node.js](https://nodejs.org) 24.0.0+
- [Docker](https://docker.com) (optional, for sandboxed agent execution)

### Installation

```bash
# Clone the repository
git clone https://github.com/agentdevsl/agentpane.git
cd agentpane

# Install dependencies
bun install

# Set up the database (SQLite by default)
bun run db:push
```

### Configuration

Set the following environment variables (or configure via the Settings UI):

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | API key for Claude Agent SDK |
| `GITHUB_TOKEN` | No | GitHub personal access token |
| `GITHUB_APP_ID` | No | GitHub App ID for OAuth |
| `GITHUB_PRIVATE_KEY` | No | GitHub App private key |

### Development

```bash
# Start frontend, API, and streams servers
bun run dev
```

This starts:

- **Frontend**: Vite dev server on port 3000
- **API**: Hono backend on port 3001
- **Streams**: DurableStreamTestServer on port 3002

### PostgreSQL (Optional)

For production or multi-user setups, switch to PostgreSQL:

```bash
# Start PostgreSQL via Docker
bun run docker:pg

# Push schema to PostgreSQL
bun run db:push:pg

# Open Drizzle Studio (PostgreSQL)
bun run db:studio:pg
```

### Build

```bash
# Production build (frontend + agent-runner)
bun run build
```

## Project Structure

```
├── src/
│   ├── app/
│   │   ├── routes/              # TanStack Start file-based routes (39 routes)
│   │   └── components/
│   │       ├── ui/              # Radix-based primitives (Button, Dialog, etc.)
│   │       └── features/        # Feature modules
│   │           ├── kanban-board/         # Drag-drop task board
│   │           ├── terraform/            # No-code HCL composer (15 files)
│   │           ├── agent-session-view/   # Real-time agent execution
│   │           ├── approval-dialog/      # Code review modal
│   │           ├── container-agent-panel/ # Container execution UI
│   │           ├── workflow-designer/    # Visual workflow editor
│   │           ├── cli-monitor/          # CLI event streaming
│   │           ├── session-history/      # Session list with filters
│   │           └── ...                   # 17 feature modules total
│   ├── db/
│   │   └── schema/              # Drizzle schemas (SQLite + PostgreSQL)
│   │       ├── sqlite/          # SQLite schema (27 tables)
│   │       ├── postgres/        # PostgreSQL schema (27 tables)
│   │       └── shared/          # Shared enums and types
│   ├── lib/
│   │   ├── agents/              # Claude Agent SDK integration
│   │   ├── sandbox/             # Sandbox providers (Docker, Agent SDK, K8s)
│   │   ├── state-machines/      # 4 state machines (agent, task, session, worktree)
│   │   ├── terraform/           # Terraform compose prompts
│   │   ├── prompts/             # Prompt registry and templates
│   │   ├── bootstrap/           # 6-phase app initialization
│   │   └── ...
│   ├── server/
│   │   └── routes/              # Hono API routes (24 endpoints)
│   └── services/                # Business logic (28 service files)
│       ├── agent/               # Agent CRUD, execution, queueing
│       ├── session/             # Session CRUD, streaming, presence
│       ├── cli-monitor/         # CLI monitoring infrastructure
│       ├── terraform-compose.service.ts
│       ├── container-agent.service.ts
│       ├── sandbox.service.ts
│       └── ...
├── agent-runner/                # Claude Agent SDK runner for containers
├── packages/
│   ├── agent-sandbox-sdk/       # @agentpane/agent-sandbox-sdk (K8s CRD provider)
│   └── cli-monitor/             # @agentpane/cli-monitor (npm package)
├── Caddyfile                    # Caddy front door config (streams, proxy, static)
├── docker/
│   ├── Dockerfile               # Multi-stage build (deps → build → caddy → runtime)
│   ├── Dockerfile.agent-sandbox # Agent sandbox environment
│   ├── start.sh                 # Entrypoint: starts Caddy + Bun
│   ├── docker-compose.yml       # Development (SQLite)
│   └── docker-compose.postgres.yml # Production (PostgreSQL)
├── k8s/                         # Kubernetes manifests
├── specs/
│   └── application/             # Complete application specifications
│       ├── api/                 # REST API (28 endpoints)
│       ├── components/          # UI component specs (19 specs)
│       ├── database/            # Database schema
│       ├── services/            # Service layer (5 services)
│       ├── state-machines/      # State machine specs (4 machines)
│       ├── testing/             # Test infrastructure (164+ test cases)
│       ├── wireframes/          # Visual designs (28 HTML wireframes)
│       └── ...
├── scripts/                     # Dev, testing, migration, and K8s scripts
└── tests/                       # Unit, integration, and E2E test suites
```

## Architecture

![AgentPane Architecture](docs/architecture.png)

### Agent Execution Flow

```
Task moved to "In Progress"
  → Auto-assign idle agent (or create new)
  → Create git worktree for isolation
  → Planning phase (Claude SDK, plan mode)
  → User reviews and approves plan
  → Execution phase (optional swarm mode)
  → Task moves to "Waiting Approval"
  → User reviews diffs and approves/rejects
```

### Sandbox Providers

| Provider | Description | Status |
|----------|-------------|--------|
| Docker | Container-based isolation with project bind-mounts | Active |
| Agent Sandbox SDK | Kubernetes CRD-based pod provisioning | Active |
| Kubernetes (direct) | Direct K8s pod management with RBAC | Archived |

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start frontend (3000) + API (3001) + streams (3002) |
| `bun run dev:api` | Start API server only |
| `bun run dev:vite` | Start Vite frontend only |
| `bun run build` | Production build (frontend + agent-runner) |
| `bun run test` | Run unit tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run test:coverage` | Run tests with coverage |
| `bun run test:e2e` | Run Playwright E2E tests |
| `bun run test:ui` | Run AI-powered UI tests |
| `bun run test:integration` | Run integration tests |
| `bun run test:k8s` | Run Kubernetes integration tests |
| `bun run lint` | Lint with Biome |
| `bun run lint:fix` | Lint and auto-fix |
| `bun run format` | Format with Biome |
| `bun run check` | Lint + format check |
| `bun run check:fix` | Lint + format auto-fix |
| `bun run typecheck` | TypeScript type check |
| `bun run db:generate` | Generate Drizzle migrations |
| `bun run db:push` | Push schema to SQLite |
| `bun run db:push:pg` | Push schema to PostgreSQL |
| `bun run db:studio` | Open Drizzle Studio (SQLite) |
| `bun run db:studio:pg` | Open Drizzle Studio (PostgreSQL) |
| `bun run docker:pg` | Start PostgreSQL via Docker Compose |
| `bun run docker:pg:down` | Stop PostgreSQL Docker Compose |

## Packages

| Package | Description |
|---------|-------------|
| [`@agentpane/agent-sandbox-sdk`](packages/agent-sandbox-sdk) | Kubernetes CRD sandbox provider for agent execution |
| [`@agentpane/cli-monitor`](packages/cli-monitor) | CLI monitoring and event streaming package |

## Documentation

- **Specifications** — [`/specs/application/README.md`](specs/application/README.md) — Complete application specs (23 user stories, 28 API endpoints, 19 component specs, 4 state machines, 164+ test cases)
- **Development Guide** — [`AGENTS.md`](AGENTS.md) — Development guidelines, architecture, and coding conventions
- **AI Assistant Guide** — [`CLAUDE.md`](CLAUDE.md) — AI-assisted development instructions
- **Component Guides** — `AGENTS.md` files in subdirectories for module-specific guidance

## License

[MIT](LICENSE)
