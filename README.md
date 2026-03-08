# AgentPane

**Multi-agent AI development platform with real-time task orchestration, sandboxed execution, and Terraform no-code composition**

[![Build](https://img.shields.io/badge/build-passing-brightgreen)](/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Architecture

System-level view of the AgentPane platform showing the browser client, TanStack DB, Caddy durable streams, Bun API server, SQLite database, and sandbox infrastructure.

![AgentPane Architecture](docs/_architecture-diagram.png)

### Tenancy Model

Authentication, ownership hierarchy, and role-based access control — from GitHub OAuth through the organization/project/task ownership chain.

![Tenancy Model](docs/tenancy-model.png)

### OpenShift Deployment

Private network deployment on OpenShift with Cloudflare Tunnel for inbound webhook delivery via `agentpane.teams`. No inbound firewall rules needed — the `cloudflared` pod initiates an outbound-only tunnel to Cloudflare Edge.

![OpenShift Deployment](docs/_openshift-deployment.png)

### Durable Streams

End-to-end event streaming pipeline: service-side emission through the type-safe `DurableStreamsService` (dual-write to SQLite + Caddy), SSE delivery to the browser, Zod validation, TanStack DB collection sync, and reactive UI updates.

![Durable Streams](docs/_durable-streams-architecture.png)

## Overview

AgentPane is a multi-agent AI development platform built on the Claude Agent SDK. It enables concurrent AI agents to work on tasks with full project isolation via git worktrees and sandboxed containers. Agents follow a plan-then-execute workflow with teams mode (planned) for parallel execution.

The platform includes a visual Kanban board for task management, real-time streaming of agent progress, integrated code review workflows, a Terraform no-code composer, plugin marketplace, and workflow designer.

## Features

### Agent Orchestration

- **Multi-Agent Concurrency** — Multiple AI agents working simultaneously on different tasks
- **Plan → Execute Workflow** — Agents plan first, then execute after user approval
- **Teams Mode** *(planned)* — During planning, an agent can request parallel execution by spawning multiple sub-agents to work on different parts of the plan concurrently
- **Git Worktree Isolation** — Each agent works in an isolated git worktree
- **Session Replay** — Full session history with timeline, event filtering, and play/pause/seek controls
- **Agent Topology** — Real-time React Flow graph showing live agent activity with ELK auto-layout
- **AI-Assisted Planning** — Interactive planning sessions where Claude asks clarifying questions before execution

### Task Management

- **Kanban Board** — Drag-and-drop workflow: Backlog → Queued → In Progress → Waiting Approval → Verified
- **Auto-Start** — Moving a task to "In Progress" automatically assigns and starts an agent
- **AI Task Creation** — Claude asks multi-round clarifying questions to refine task requirements before submission
- **Code Review** — Approve or reject agent changes with diff visualization before merge

### Sandboxed Execution

- **Docker Containers** — Run agents in isolated Docker containers with project bind-mounts
- **Kubernetes CRD** — Agent Sandbox SDK for Kubernetes pod provisioning via `agents.x-k8s.io/v1alpha1`
- **Nomad Jobs** — HashiCorp Nomad sandbox provider for job-based agent isolation
- **AWS Bedrock AgentCore** — Managed AWS runtimes with STS auth, ECR image validation, and orphan cleanup
- **Per-Project or Shared** — Choose between a shared container or per-project isolation

### Terraform No-Code Composer

- **Natural Language → HCL** — Generate Terraform configurations from plain English via Claude
- **Private Module Browser** — Browse and search modules from your connected private Terraform registry
- **Dependency Diagrams** — Visual resource dependency graphs (React Flow + ELK)
- **Composition History** — Track and revisit previous compositions
- **Variable Forms** — Interactive variable input with smart widget inference and `.tfvars` generation
- **Registry Sync** — Background scheduler auto-syncs registry data on configurable intervals

### Plugin Marketplace

- **GitHub-Synced Plugins** — Browse Claude plugins synced from GitHub repos
- **Multiple Sources** — Add internal and external marketplace sources
- **Category Browse** — Filter and explore plugins by category

### Templates

- **GitHub-Synced Templates** — Add GitHub repos as template sources for skills, commands, and agents
- **Org & Project Scoping** — Templates can be scoped to an organization or individual project
- **Auto-Sync** — Background scheduler syncs template changes from GitHub on configurable intervals

### Integrations

- **GitHub App** — Repository sync via PAT or GitHub App installation tokens, webhook-triggered template sync
- **Workflow Designer** — Visual AI-powered workflow editor with drag-and-drop (React Flow + ELK)
- **Workflow Catalog** — Browse saved workflows with SVG previews, search, filter, and pagination
- **Git View** — 5-column dashboard: PRs, worktrees, commits, local branches, remote branches
- **CLI Monitor** — Real-time monitoring of Claude CLI sessions (`@agentpane/cli-monitor`)
- **Durable Streams** — Real-time event streaming via Caddy front door (LMDB-backed SSE + long-poll)
- **Encrypted API Keys** — UI-managed per-service API key storage with masked display

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
| UI | React + Radix + Tailwind | react + @radix-ui/* + tailwindcss | 19.2.4 / 4.1.18 |
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
| AWS | AWS SDK | @aws-sdk/client-sts | 3.1004.0 |
| GitHub | Octokit | octokit | 5.0.5 |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.3.10+
- [Node.js](https://nodejs.org) 24.0.0+
- [Docker](https://docker.com) (optional, for sandboxed agent execution)
- [AWS Account](https://aws.amazon.com) (optional, for AWS Bedrock AgentCore sandbox execution)

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
| `DB_MODE` | No | `sqlite` (default) or `postgres` |
| `DATABASE_URL` | If postgres | PostgreSQL connection string |
| `CADDY_STREAMS_URL` | No | Override streams server URL (default: `http://localhost:3002`) |
| `GITHUB_TOKEN` | No | GitHub personal access token |
| `GITHUB_APP_ID` | No | GitHub App ID for installation tokens |
| `GITHUB_PRIVATE_KEY` | No | GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for verifying GitHub webhooks |
| `CORS_ORIGIN` | Production | Allowed CORS origin |

> **AWS Bedrock AgentCore** credentials (access key, secret key, region, runtime ARN) are configured via the **Settings UI** under `sandbox.agentcore`, not environment variables.

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

Then set `DB_MODE=postgres` and `DATABASE_URL` to use PostgreSQL at runtime.

### Build

```bash
# Production build (frontend + typecheck + agent-runner)
bun run build
```

## Project Structure

```
├── src/
│   ├── app/
│   │   ├── routes/              # TanStack Start file-based routes (44 routes)
│   │   └── components/
│   │       ├── ui/              # Radix-based primitives (Button, Dialog, etc.)
│   │       └── features/        # Feature modules (17 modules)
│   │           ├── kanban-board/         # Drag-drop task board
│   │           ├── terraform/            # No-code HCL composer
│   │           ├── agent-session-view/   # Real-time agent execution
│   │           ├── agent-topology/       # Live agent graph (React Flow + ELK)
│   │           ├── plan-session-view/    # Interactive planning with Claude
│   │           ├── approval-dialog/      # Code review modal
│   │           ├── container-agent-panel/ # Container execution UI
│   │           ├── workflow-designer/    # Visual workflow editor
│   │           ├── workflow-catalog/     # Workflow browser with SVG previews
│   │           ├── git-view/            # Git dashboard (PRs, branches, worktrees)
│   │           ├── cli-monitor/         # CLI event streaming
│   │           ├── session-history/     # Session list with filters
│   │           └── ...
│   ├── db/
│   │   └── schema/              # Drizzle schemas (SQLite + PostgreSQL)
│   │       ├── sqlite/          # SQLite schema (21 tables)
│   │       ├── postgres/        # PostgreSQL schema (21 tables)
│   │       └── shared/          # Shared enums and types
│   ├── lib/
│   │   ├── agents/              # Claude Agent SDK integration
│   │   ├── sandbox/             # Sandbox providers (Docker, K8s CRD, Nomad, AgentCore)
│   │   ├── streams/             # Durable Streams / Caddy producer
│   │   ├── state-machines/      # 4 state machines (agent, task, session, worktree)
│   │   ├── terraform/           # Terraform compose prompts
│   │   ├── prompts/             # Prompt registry and templates
│   │   ├── bootstrap/           # 6-phase app initialization
│   │   └── ...
│   ├── server/
│   │   └── routes/              # Hono API routes (21 route files)
│   └── services/                # Business logic (34 service files)
│       ├── agent/               # Agent CRUD, execution, queueing
│       ├── session/             # Session CRUD, streaming, presence
│       ├── cli-monitor/         # CLI monitoring infrastructure
│       ├── terraform-compose.service.ts
│       ├── container-agent.service.ts
│       ├── marketplace.service.ts
│       ├── template.service.ts
│       ├── sandbox.service.ts
│       └── ...
├── agent-runner/                # Claude Agent SDK runner for containers
├── packages/
│   ├── agent-sandbox-sdk/       # @agentpane/agent-sandbox-sdk (K8s CRD client)
│   ├── cli-monitor/             # @agentpane/cli-monitor (npm package)
│   └── nomad-sandbox-sdk/       # @agentpane/nomad-sandbox-sdk (Nomad HTTP client)
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
│       ├── api/                 # REST API (29 endpoints)
│       ├── components/          # UI component specs (19 specs)
│       ├── database/            # Database schema
│       ├── services/            # Service layer
│       ├── state-machines/      # State machine specs (4 machines)
│       ├── testing/             # Test infrastructure (193 test cases)
│       ├── wireframes/          # Visual designs (41 HTML wireframes)
│       └── ...
├── scripts/                     # Dev, testing, migration, and K8s scripts
└── tests/                       # Unit, integration, and E2E test suites
```

### Agent Execution Flow

```
Task moved to "In Progress"
  → Auto-assign idle agent (or create new)
  → Create git worktree for isolation
  → Planning phase (Claude SDK, plan mode)
  → User reviews and approves plan
  → Execution phase (teams mode planned)
  → Task moves to "Waiting Approval"
  → User reviews diffs and approves/rejects
```

### Sandbox Providers

| Provider | Description | Status |
|----------|-------------|--------|
| Docker | Container-based isolation with project bind-mounts | Active |
| Agent Sandbox SDK | Kubernetes CRD-based pod provisioning (`agents.x-k8s.io/v1alpha1`) | Active |
| Nomad | HashiCorp Nomad job-based isolation via `@agentpane/nomad-sandbox-sdk` | Active |
| AWS Bedrock AgentCore | Managed AWS runtimes via Bedrock Agent Runtime API with STS/ECR integration | Active |
| Kubernetes (direct) | Direct K8s pod management with RBAC | Archived |

### Events System

![Events System](docs/_events-system-architecture.png)

AgentPane includes a pluggable event system that converts external signals — GitHub webhooks, scheduled cron jobs, or custom HTTP webhooks — into tasks that agents can automatically pick up and execute.

```
External Event (GitHub, Linear, Jira, Cron)
  → /hooks/events/:slug (public, HMAC-verified)
  → Plugin normalizes to NormalizedEvent
  → Deduplicate via deliveryId (idempotent)
  → Match subscriptions (event type + field filters)
  → Interpolate prompt template with event data
  → Create task (optionally auto-start agent)
```

**Event Sources** — Team-scoped webhook endpoints. Each source gets a unique slug and encrypted HMAC secret. Supported types:

| Source | Signature Header | Events |
|--------|-----------------|--------|
| GitHub | `X-Hub-Signature-256` | `issues`, `pull_request`, `push`, `ping` |
| Linear | `Linear-Signature` | Issue and project events |
| Jira | `X-Hub-Signature` | Issue and sprint events |
| Generic Webhook | `X-Webhook-Signature` | Any JSON payload |
| Cron | N/A (internal) | `schedule.tick`, `schedule.manual_trigger` |

**Event Subscriptions** — Route events from a source to a project. Each subscription defines which event types to match, optional field filters (repo, branch, labels, author, action), a prompt template with `{{variable}}` interpolation, and which Kanban column to place the created task in. If the target column is "In Progress", the task auto-starts an agent.

**GitHub Issue Events** — When a GitHub issue is opened (or labeled, assigned, etc.), the webhook delivers the event, the GitHub plugin normalizes it, matching subscriptions render their prompt templates with issue data (`{{issue.title}}`, `{{issue.body}}`, `{{repo.full_name}}`, etc.), and a task is created in the target project. This enables fully automated issue-to-agent pipelines.

**Webhookd** — The webhook delivery infrastructure. Public endpoint at `/hooks/events/:slug` sits outside the `/api/*` auth boundary (rate-limited at 60 req/min per IP). Webhook secrets are AES-256 encrypted at rest with rotation via `POST /api/events/sources/:id/rotate-secret`. Deduplication uses a unique constraint on `(eventSourceId, deliveryId)` so retried deliveries from external systems are silently accepted without creating duplicate tasks. The full event audit trail is stored in the `event_log` table with status tracking (`received` → `matched` → `task_created` | `ignored`).

**Scheduler** — A lightweight polling-based scheduler for cron event sources. Ticks every 30 seconds (configurable via `SCHEDULER_TICK_INTERVAL_MS`), evaluates cron expressions and simple intervals, and feeds synthetic events through the same processing pipeline as webhooks. Features include:

- **Budget enforcement** — Max executions per hour/day/week/month to prevent runaway costs
- **Timezone-aware** — Cron expressions respect configured IANA timezones
- **Auto-pause** — Sources auto-pause after 5 consecutive errors
- **CAS locking** — Compare-and-swap on `nextRunAt` prevents duplicate execution
- **Recovery** — On restart, missed executions are skipped (clock is not rewound)
- **Manual trigger** — `POST /api/events/sources/:id/trigger` for on-demand execution

Additional schedulers handle template sync and Terraform registry sync on configurable intervals (minimum 5 minutes).

**Real-Time Streaming** — All event processing outcomes are broadcast to connected SSE clients via the in-process event bus, enabling live updates in the Events UI. Agent execution events flow through a separate path: `DurableStreamsService` dual-writes to SQLite and Caddy, with offset-based replay on reconnect (see [Durable Streams](#durable-streams) diagram above).

**Plugin Architecture** — New event sources are added by implementing `EventSourcePlugin` (signature verification, event parsing, filter matching, template variables) and registering in the `PluginRegistry`. The registry is dependency-injected for test isolation.

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start frontend (3000) + API (3001) + streams (3002) |
| `bun run dev:api` | Start API server only |
| `bun run dev:vite` | Start Vite frontend only |
| `bun run build` | Production build (frontend + typecheck + agent-runner) |
| `bun run test` | Run unit tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run test:coverage` | Run tests with coverage |
| `bun run test:e2e` | Run E2E tests (Vitest + Playwright config) |
| `bun run test:ui` | Run AI-powered UI tests |
| `bun run test:integration` | Run integration tests |
| `bun run test:k8s` | Run Kubernetes integration tests |
| `bun run lint` | Lint with Biome |
| `bun run lint:fix` | Lint and auto-fix |
| `bun run format` | Format with Biome |
| `bun run check` | Lint + format check |
| `bun run check:fix` | Lint + format auto-fix |
| `bun run typecheck` | TypeScript type check |
| `bun run db:generate` | Generate Drizzle migrations (SQLite) |
| `bun run db:push` | Push schema to SQLite |
| `bun run db:migrate` | Run SQLite migrations |
| `bun run db:studio` | Open Drizzle Studio (SQLite) |
| `bun run db:generate:pg` | Generate Drizzle migrations (PostgreSQL) |
| `bun run db:push:pg` | Push schema to PostgreSQL |
| `bun run db:migrate:pg` | Run PostgreSQL migrations |
| `bun run db:studio:pg` | Open Drizzle Studio (PostgreSQL) |
| `bun run db:migrate:sqlite-to-pg` | Migrate data from SQLite to PostgreSQL |
| `bun run docker:pg` | Start PostgreSQL via Docker Compose |
| `bun run docker:pg:down` | Stop PostgreSQL Docker Compose |

## Packages

| Package | Description |
|---------|-------------|
| [`@agentpane/agent-sandbox-sdk`](packages/agent-sandbox-sdk) | TypeScript SDK for the kubernetes-sigs Agent Sandbox CRD (`agents.x-k8s.io/v1alpha1`) |
| [`@agentpane/cli-monitor`](packages/cli-monitor) | CLI monitor daemon — watches Claude Code sessions in real-time |
| [`@agentpane/nomad-sandbox-sdk`](packages/nomad-sandbox-sdk) | TypeScript SDK for HashiCorp Nomad sandbox management via HTTP API |

## Documentation

- **Specifications** — [`/specs/application/README.md`](specs/application/README.md) — Complete application specs (41 user stories, 29 API endpoints, 19 component specs, 4 state machines, 193 test cases)
- **Development Guide** — [`AGENTS.md`](AGENTS.md) — Development guidelines, architecture, and coding conventions
- **AI Assistant Guide** — [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — AI-assisted development instructions

## License

[MIT](LICENSE)
