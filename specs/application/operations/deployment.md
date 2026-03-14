# Deployment Specification

## Overview

This specification defines the deployment architecture, environment configuration, build processes, and operational procedures for AgentPane. The primary deployment model is a single-node local installation, with optional Docker containerization and cloud deployment patterns for scaling.

**Tech Stack Reference:**

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Bun | 1.3.10 |
| Framework | Vite + TanStack Router | 7.3.1 / 1.150.0 |
| Database (default) | SQLite via better-sqlite3 | 12.6.2 |
| Database (optional) | PostgreSQL via postgres.js | 3.4.8 |
| ORM | Drizzle | 0.45.1 |
| Agent Events | Durable Streams | 0.2.x |
| AI/Agents | Claude Agent SDK | 0.2.63 |
| Testing | Vitest | 4.0.16 |
| Linting | Biome | 2.4.4 |

**Related Specifications:**

- [App Bootstrap](../architecture/app-bootstrap.md) - Application initialization sequence
- [Database Schema](../database/schema.md) - SQLite/PostgreSQL schema and migrations
- [Configuration Management](../configuration/config-management.md) - Environment and config handling
- [Security Model](../security/security-model.md) - Secrets and credential management
- [Durable Sessions](../integrations/durable-sessions.md) - Real-time event streaming

---

## 1. Deployment Topology

### 1.1 Single-Node Local Deployment (Primary Use Case)

AgentPane is designed as a developer-first local application. The primary deployment model runs all services on a single machine.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Developer Machine                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        AgentPane Processes                              │ │
│  │                                                                         │ │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────────┐   │ │
│  │  │   Vite Dev    │  │   Durable     │  │    Claude Agent SDK       │   │ │
│  │  │   Server      │  │   Streams     │  │    Workers (1-6)          │   │ │
│  │  │   :3000       │  │   Server      │  │                           │   │ │
│  │  │  (frontend)   │  │   :3002       │  │    ┌───┐ ┌───┐ ┌───┐     │   │ │
│  │  │               │  │               │  │    │ A │ │ A │ │ A │     │   │ │
│  │  └───────────────┘  └───────────────┘  │    └───┘ └───┘ └───┘     │   │ │
│  │         │                   │          └───────────────────────────┘   │ │
│  │         │   ┌───────────────┤                      │                   │ │
│  │         │   │ Hono API      │                      │                   │ │
│  │         │   │ Server        │                      │                   │ │
│  │         │   │ :3001         │                      │                   │ │
│  │         │   └───────────────┤                      │                   │ │
│  │         └───────────────────┴──────────────────────┘                   │ │
│  │                             │                                          │ │
│  │  ┌──────────────────────────┴──────────────────────────────────────┐  │ │
│  │  │                      SQLite Database                             │  │ │
│  │  │                    ./data/agentpane.db                           │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         Git Worktrees                                   │ │
│  │  ~/projects/my-repo/.worktrees/                                        │ │
│  │  ├── agent-1-feature-branch/                                           │ │
│  │  ├── agent-2-bugfix-branch/                                            │ │
│  │  └── agent-3-refactor-branch/                                          │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS
                                    ▼
                    ┌───────────────────────────────┐
                    │       Anthropic API           │
                    │     api.anthropic.com         │
                    └───────────────────────────────┘
```

#### Local Installation Steps

```bash
# 1. Clone repository
git clone https://github.com/your-org/agentpane.git
cd agentpane

# 2. Install dependencies
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# 4. Initialize database (auto-migrates on startup, or manual push)
bun run db:push

# 5. Start application (3 processes: Vite :3000, API :3001, Streams :3002)
bun run dev
```

#### Directory Structure (Local)

```
./data/                          # Application data directory (project-local)
└── agentpane.db                 # SQLite database file

~/.claude/                       # Global Claude configuration
├── settings.json               # Global user settings
├── CLAUDE.md                   # Personal instructions
├── skills/                     # Personal skills
├── commands/                   # Personal slash commands
└── agents/                     # Personal subagents
```

---

### 1.2 Docker Containerization

The production Docker image runs a Caddy-based reverse proxy (durable-streams-server) in front of the Bun API server, serving static assets and providing durable streams persistence via LMDB.

#### Production Architecture (Docker)

```
┌──────────────────────────────────────────────────────┐
│  Docker Container (agentpane)                          │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │  durable-streams-server (Caddy)  :3000            │ │
│  │  ┌──────────────┬──────────────┬────────────────┐ │ │
│  │  │ /healthz     │ /v1/stream/* │ /api/*         │ │ │
│  │  │ → "OK" 200   │ → LMDB      │ → reverse_proxy│ │ │
│  │  │              │   streams    │   localhost:3001│ │ │
│  │  │              │              ├────────────────┤ │ │
│  │  │              │              │ /*             │ │ │
│  │  │              │              │ → static files │ │ │
│  │  │              │              │   /app/dist    │ │ │
│  │  └──────────────┴──────────────┴────────────────┘ │ │
│  └──────────────────────────────────────────────────┘ │
│                          │                              │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Bun API Server  :3001                            │ │
│  │  (Hono routes, SQLite, agent orchestration)       │ │
│  └──────────────────────────────────────────────────┘ │
│                          │                              │
│  ┌──────────────────────────────────────────────────┐ │
│  │  /app/data/agentpane.db    (SQLite)               │ │
│  │  /app/streams/             (LMDB durable streams) │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

#### Production Dockerfile

The actual Dockerfile (`docker/Dockerfile`) uses a multi-stage build:

```dockerfile
# docker/Dockerfile
# Stage 1: deps  - Install Bun + agent-runner dependencies
FROM oven/bun:1.3.10-alpine AS deps

# Stage 2: build - Build frontend (vite build), typecheck, agent-runner
FROM oven/bun:1.3.10-alpine AS build

# Stage 3: caddy - Download durable-streams-server binary (Caddy + LMDB plugin)
FROM alpine:3.21 AS caddy
# Downloads platform-specific binary from GitHub releases

# Stage 4: runtime - Production image
FROM oven/bun:1.3.10-alpine AS runtime
# Installs: git, tini, wget, bash
# Copies: durable-streams-server, dist/, agent-runner/dist/, node_modules/
# Copies: Caddyfile, start.sh
# Creates: /app/data (SQLite), /app/streams (LMDB)
# Runs as: bun user (non-root)
# Exposes: 3000 (Caddy front door)
# Entrypoint: tini -- /app/start.sh
# Health: wget http://localhost:3000/healthz
```

**Key differences from a naive Dockerfile:**
- Uses `tini` as PID 1 for proper signal handling
- Runs `durable-streams-server` (Caddy) + `bun src/server/api.ts` via `start.sh`
- Caddy handles static file serving, SSE streams (LMDB-backed), and reverse-proxies `/api/*` to the Bun API
- Environment: `DB_PATH=/app/data/agentpane.db`

#### Caddyfile

The `Caddyfile` in the project root configures the Caddy reverse proxy:

```
{
  admin off
  auto_https off
}

:3000 {
  # Health check for Caddy itself
  handle /healthz {
    respond "OK" 200
  }

  # Durable streams (LMDB persistence, SSE + long-poll)
  @streams path /v1/stream /v1/stream/*
  handle @streams {
    durable_streams {
      data_dir {$STREAMS_DATA_DIR:/app/data/streams}
      long_poll_timeout 30s
      sse_reconnect_interval 120s
    }
  }

  # Reverse proxy to Bun API server
  handle /api/* {
    reverse_proxy localhost:3001 {
      flush_interval -1
    }
  }

  # Static files with SPA fallback
  handle {
    root * /app/dist
    encode gzip br
    try_files {path} /index.html
    file_server {
      precompressed gzip br
    }
    @immutable path /assets/*
    header @immutable Cache-Control "public, max-age=31536000, immutable"
  }
}
```

#### Docker Compose Configuration

```yaml
# docker/docker-compose.yml
services:
  agentpane:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - agentpane-data:/app/data
      - agentpane-streams:/app/streams
    environment:
      - NODE_ENV=production
      - DB_PATH=/app/data/agentpane.db
      - STREAMS_DATA_DIR=/app/streams
      - CADDY_STREAMS_URL=http://localhost:3000/v1/stream
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - CLAUDE_OAUTH_TOKEN=${CLAUDE_OAUTH_TOKEN:-}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped

volumes:
  agentpane-data:
  agentpane-streams:
```

#### Start Script (`docker/start.sh`)

The start script runs both Caddy and the Bun API server as co-processes:

```bash
#!/bin/bash
set -e
trap 'kill $CADDY_PID $BUN_PID 2>/dev/null; wait' SIGTERM SIGINT

# Start Caddy (durable-streams-server) in background
/usr/local/bin/durable-streams-server run --config /app/Caddyfile &
CADDY_PID=$!

# Wait for Caddy to be ready, then start Bun API
bun src/server/api.ts &
BUN_PID=$!

# Wait for either process to exit, then shut down the other
wait -n
kill $CADDY_PID $BUN_PID 2>/dev/null || true
wait || true
```

#### Docker Commands

```bash
# Build image (must specify TARGETARCH for durable-streams-server binary)
docker build -f docker/Dockerfile --build-arg TARGETARCH=amd64 -t agentpane:latest .

# Run container
docker run -d \
  --name agentpane \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v agentpane-data:/app/data \
  -v agentpane-streams:/app/streams \
  agentpane:latest

# Run via docker compose
docker compose -f docker/docker-compose.yml up --build

# View logs
docker logs -f agentpane

# Stop and remove
docker stop agentpane && docker rm agentpane
```

#### Optional: PostgreSQL via Docker Compose

For teams that prefer PostgreSQL over SQLite:

```yaml
# docker/docker-compose.postgres.yml
services:
  postgres:
    image: postgres:18
    container_name: agentpane-postgres
    environment:
      POSTGRES_DB: agentpane
      POSTGRES_USER: agentpane
      POSTGRES_PASSWORD: agentpane_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agentpane -d agentpane"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s

volumes:
  pgdata:
```

```bash
# Start PostgreSQL
npm run docker:pg

# Run with PostgreSQL mode
DB_MODE=postgres DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run dev

# Stop PostgreSQL
npm run docker:pg:down
```

---

### 1.3 Agent Sandbox Containers

AgentPane can run Claude agents inside isolated Docker containers. Two sandbox Dockerfiles exist:

#### Agent Sandbox (`docker/Dockerfile.agent-sandbox`)

Based on `srlynch1/terraform-ai-tools`, adds:
- Claude Code CLI (globally installed)
- Agent runner (`agent-runner/dist/`)
- ripgrep, fd-find, tree
- Git safe directory config
- Non-root `node` user with limited sudo
- Entrypoint script for permission fixes on bind-mounted volumes

```bash
# Build agent sandbox
./docker/build-agent-sandbox.sh
# or
docker build -f docker/Dockerfile.agent-sandbox -t agentpane/agent-sandbox:latest .
```

#### AgentCore (`docker/Dockerfile.agentcore`)

For AWS Bedrock AgentCore deployment (ARM64 only):
- Based on `node:22-bookworm-slim`
- Claude Agent SDK + bedrock-agentcore runtime
- Exposes port 8080 for `/invocations` and `/ping`
- Entry point: `node /opt/agent-runner/dist/agentcore-handler.js`

```bash
docker build --platform linux/arm64 -f docker/Dockerfile.agentcore -t agentpane-agentcore:latest .
```

---

### 1.4 Cloud Deployment Options

For teams requiring multi-user access or higher availability, AgentPane can be deployed to cloud infrastructure.

#### Cloud Architecture (Scaled)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Cloud Provider                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Load Balancer / CDN                              │ │
│  │                    (CloudFront / Cloud CDN)                             │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                          │
│         ┌──────────────────────────┴──────────────────────────┐              │
│         │                                                      │              │
│         ▼                                                      ▼              │
│  ┌─────────────────┐                                   ┌─────────────────┐   │
│  │   Web Server    │                                   │   Web Server    │   │
│  │   Instance 1    │                                   │   Instance 2    │   │
│  │   (ECS/GKE)     │                                   │   (ECS/GKE)     │   │
│  └─────────────────┘                                   └─────────────────┘   │
│         │                                                      │              │
│         └──────────────────────────┬──────────────────────────┘              │
│                                    │                                          │
│                                    ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          Shared Storage                                 │ │
│  │                    (EFS / Cloud Filestore)                              │ │
│  │                                                                         │ │
│  │  ├── /data/agentpane.db         # SQLite database (single-writer)      │ │
│  │  ├── /streams/                  # LMDB durable streams data            │ │
│  │  ├── /projects/                 # Mounted project repositories          │ │
│  │  └── /config/                   # Shared configuration                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Agent Worker Pool                                │ │
│  │                     (Fargate / Cloud Run)                               │ │
│  │                                                                         │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐           │ │
│  │  │  Worker   │  │  Worker   │  │  Worker   │  │  Worker   │           │ │
│  │  │  1-3      │  │  4-6      │  │  7-9      │  │  10-12    │           │ │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘           │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### AWS Deployment (Terraform Example)

```hcl
# terraform/aws/main.tf

module "agentpane" {
  source = "./modules/agentpane"

  environment = "production"

  # ECS Configuration
  ecs_cluster_name = "agentpane-cluster"
  container_image  = "your-ecr-repo/agentpane:latest"
  desired_count    = 2
  cpu              = 1024
  memory           = 2048

  # Networking
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  # Storage
  efs_id = aws_efs_file_system.agentpane.id

  # Secrets
  anthropic_api_key_arn = aws_secretsmanager_secret.anthropic_key.arn
  github_token_arn      = aws_secretsmanager_secret.github_token.arn
}
```

#### Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentpane
  labels:
    app: agentpane
spec:
  replicas: 2
  selector:
    matchLabels:
      app: agentpane
  template:
    metadata:
      labels:
        app: agentpane
    spec:
      securityContext:
        runAsNonRoot: true
      containers:
        - name: agentpane
          image: ghcr.io/your-org/agentpane:latest
          ports:
            - containerPort: 3000
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: agentpane-secrets
                  key: anthropic-api-key
            - name: DB_PATH
              value: "/data/agentpane.db"
            - name: NODE_ENV
              value: "production"
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: streams
              mountPath: /app/streams
            - name: projects
              mountPath: /projects
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: agentpane-data
        - name: streams
          persistentVolumeClaim:
            claimName: agentpane-streams
        - name: projects
          persistentVolumeClaim:
            claimName: agentpane-projects
```

---

## 2. Environment Configuration

### 2.1 Development Environment Setup

#### Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Bun | 1.3.0+ | 1.3.10 |
| Node.js | 24.0+ | 24.x |
| Git | 2.40+ | Latest |
| Disk Space | 1 GB | 5 GB |
| RAM | 4 GB | 8 GB+ |

#### Development Setup

```bash
# Clone and setup
git clone https://github.com/your-org/agentpane.git
cd agentpane

# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Copy environment template
cp .env.example .env.development.local

# Initialize database (auto-migrates on startup)
bun run db:push

# Start development server (3 processes: Vite, API, Streams)
bun run dev
```

#### Development Process Architecture

The `npm run dev` command runs `scripts/start-dev.ts`, which starts three processes:

1. **DurableStreamTestServer** on port 3002 (Durable Streams for dev)
2. **Bun API server** on port 3001 (`bun src/server/api.ts`)
3. **Vite dev server** on port 3000 (with proxy rules to API and streams)

The Vite dev server proxies:
- `/api/*` requests to `http://localhost:3001`
- `/v1/stream/*` requests to `http://localhost:3002`

#### Development Environment File (.env.development.local)

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-api03-...

# Database mode (sqlite or postgres)
DB_MODE=sqlite
# For SQLite: data stored in ./data/agentpane.db by default
# SQLITE_DATA_DIR=./data

# For PostgreSQL (when DB_MODE=postgres):
# DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane

# Application
NODE_ENV=development
LOG_LEVEL=debug

# Optional: GitHub Integration (for config sync)
GITHUB_TOKEN=ghp_...

# Optional: GitHub App (for full integration)
GITHUB_APP_ID=123456
GITHUB_APP_NAME=agentpane-dev
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=whsec_...

# Optional: Skip authentication in dev mode
SKIP_AUTH=true
```

---

### 2.2 Production Environment Requirements

#### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8 GB+ |
| Disk | 10 GB SSD | 50 GB+ SSD |
| Network | 10 Mbps | 100 Mbps+ |

#### Production Environment File

```bash
# Required - API Access
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required - Database
DB_PATH=/app/data/agentpane.db

# Required - Environment
NODE_ENV=production

# Logging
LOG_LEVEL=info

# Durable Streams
STREAMS_DATA_DIR=/app/streams
CADDY_STREAMS_URL=http://localhost:3000/v1/stream

# Optional - Claude OAuth Token (for container agent execution)
CLAUDE_OAUTH_TOKEN=sk-ant-oat01-...

# Optional - GitHub Integration
GITHUB_TOKEN=ghp_...

# Optional - GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_NAME=agentpane-prod
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=<from-secrets-manager>
GITHUB_PRIVATE_KEY=<from-secrets-manager>
GITHUB_WEBHOOK_SECRET=<from-secrets-manager>

# Performance tuning
MAX_CONCURRENT_AGENTS=6
MAX_TURNS_PER_AGENT=100
AGENT_TIMEOUT_MS=600000
```

---

### 2.3 Environment Variable Management

#### Variable Precedence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Process Environment (highest priority)                                    │
│    - Set via shell: ANTHROPIC_API_KEY=sk-... bun run dev                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Environment-Specific File                                                 │
│    - .env.development.local (dev) or .env.production.local (prod)           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Base Environment File                                                     │
│    - .env.local (not committed, machine-specific)                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Default Environment File                                                  │
│    - .env (committed, contains non-sensitive defaults)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Application Defaults (lowest priority)                                    │
│    - Hard-coded in src/db/client.ts and src/server/api.ts                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Claude API key |
| `DB_MODE` | No | `sqlite` | Database mode (`sqlite` or `postgres`) |
| `DB_PATH` | No | `./data/agentpane.db` | SQLite database path (production) |
| `SQLITE_DATA_DIR` | No | `./data` | SQLite data directory (dev) |
| `DATABASE_URL` | No* | - | PostgreSQL connection string (*required when DB_MODE=postgres) |
| `NODE_ENV` | No | `development` | Environment mode |
| `LOG_LEVEL` | No | `info` | Logging verbosity |
| `CORS_ORIGIN` | No | `http://localhost:3000` | CORS origin for API |
| `STREAMS_DATA_DIR` | No | `/app/data/streams` | LMDB streams data directory |
| `CADDY_STREAMS_URL` | No | - | Durable streams Caddy URL |
| `SKIP_AUTH` | No | `false` | Skip authentication in dev mode |
| `CLAUDE_OAUTH_TOKEN` | No | - | OAuth token for container agent execution |
| `GITHUB_TOKEN` | No | - | GitHub PAT for basic integration |
| `GITHUB_APP_ID` | No | - | GitHub App ID |
| `GITHUB_CLIENT_ID` | No | - | OAuth client ID |
| `GITHUB_CLIENT_SECRET` | No | - | OAuth client secret |
| `GITHUB_PRIVATE_KEY` | No | - | App private key (PEM) |
| `GITHUB_WEBHOOK_SECRET` | No | - | Webhook signature secret |
| `MAX_CONCURRENT_AGENTS` | No | `3` | Max parallel agents |
| `MAX_TURNS_PER_AGENT` | No | `50` | Max turns per execution |

---

### 2.4 Secrets Handling

#### Local Development

For local development, secrets are stored in `.env.local` (gitignored):

```bash
# .env.local (never commit)
ANTHROPIC_API_KEY=sk-ant-api03-...
GITHUB_TOKEN=ghp_...
GITHUB_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
```

#### Production Secrets (AWS Secrets Manager)

```typescript
// lib/config/secrets-loader.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface SecretConfig {
  ANTHROPIC_API_KEY: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

export async function loadSecrets(): Promise<SecretConfig> {
  if (process.env.NODE_ENV !== 'production') {
    // Use environment variables directly in development
    return {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    };
  }

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  const command = new GetSecretValueCommand({
    SecretId: process.env.SECRETS_ARN ?? 'agentpane/production',
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error('Failed to load secrets from Secrets Manager');
  }

  return JSON.parse(response.SecretString);
}
```

#### Security Best Practices

| Practice | Implementation |
|----------|----------------|
| No secrets in code | Use environment variables only |
| No secrets in logs | Redact sensitive values in logging |
| Rotate credentials | Implement key rotation procedures |
| Principle of least privilege | Minimal API key permissions |
| Encrypt at rest | Use encrypted secrets manager |
| Encrypt in transit | HTTPS only, TLS 1.3 |

---

## 3. Build Process

### 3.1 Build Commands and Scripts

#### package.json Scripts

```json
{
  "scripts": {
    "dev": "bun scripts/start-dev.ts",
    "dev:simple": "bun run dev:api & vite",
    "dev:vite": "vite",
    "dev:api": "bun src/server/api.ts",
    "build": "vite build && tsc --noEmit && npm run build:agent-runner",
    "build:agent-runner": "cd agent-runner && npm run build",

    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "db:generate:pg": "drizzle-kit generate --config=drizzle.config.pg.ts",
    "db:migrate:pg": "drizzle-kit migrate --config=drizzle.config.pg.ts",
    "db:push:pg": "drizzle-kit push --config=drizzle.config.pg.ts",
    "db:studio:pg": "drizzle-kit studio --config=drizzle.config.pg.ts",
    "db:migrate:sqlite-to-pg": "bun scripts/migrate-sqlite-to-pg.ts",

    "docker:pg": "docker compose -f docker/docker-compose.postgres.yml up -d",
    "docker:pg:down": "docker compose -f docker/docker-compose.postgres.yml down",

    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "vitest --config vitest.e2e.config.ts",
    "test:ui": "bun scripts/run-ui-tests.ts",

    "lint": "biome lint .",
    "lint:fix": "biome lint --write .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "check": "biome check .",
    "check:fix": "biome check --write .",
    "typecheck": "tsc --noEmit"
  }
}
```

#### Build Pipeline

```bash
# Full build pipeline
bun run typecheck
bun run check
bun run test
bun run build
```

---

### 3.2 Asset Optimization

#### Vite Configuration

The actual `vite.config.ts` uses:

```typescript
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 3000,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, timeout: 0 },
      '/v1/stream': { target: 'http://localhost:3002', changeOrigin: true, timeout: 0 },
    },
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths(),
    TanStackRouterVite({ routesDirectory: './src/app/routes' }),
    react(),
    serverOnlyStubs(),  // Replaces server-only agent tools with browser stubs
  ],
  optimizeDeps: {
    exclude: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  },
  build: {
    target: 'esnext',
    rollupOptions: { external: ['better-sqlite3'] },
  },
});
```

#### Build Output Structure

```
dist/                            # Client-side assets (Vite build output)
├── assets/
│   ├── index-[hash].js          # Main bundle
│   ├── [chunk]-[hash].js        # Code-split chunks
│   └── index-[hash].css         # Compiled Tailwind CSS
└── index.html

agent-runner/dist/               # Agent runner (compiled TypeScript)
└── *.js
```

---

### 3.3 Bundle Analysis

#### Size Budgets

| Bundle | Max Size (gzip) | Description |
|--------|-----------------|-------------|
| Main JS | 150 KB | Core application code |
| Vendor React | 50 KB | React and React DOM |
| Vendor TanStack | 80 KB | Router, DB |
| Vendor Radix | 60 KB | UI components |
| CSS | 30 KB | Tailwind styles |
| Total Initial | 300 KB | First load |

---

## 4. Database Management

### 4.1 Database Initialization

The application supports two database backends, controlled by `DB_MODE` environment variable:

- **SQLite** (default): Uses `better-sqlite3`, stores data in `./data/agentpane.db`
- **PostgreSQL** (optional): Uses `postgres.js`, requires `DATABASE_URL`

#### Database Client Setup

```typescript
// src/db/client.ts
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const mode = getDbMode(); // 'sqlite' | 'postgres'

// SQLite: creates ./data/agentpane.db with WAL mode and FK constraints
// PostgreSQL: connects via DATABASE_URL
// Both: run schema migration on startup (CREATE TABLE IF NOT EXISTS)
```

#### Database Health Check

The health check endpoint at `/api/health` verifies database connectivity:

```typescript
// Checks SQLite version or PostgreSQL connectivity
// Returns: { ok: true, data: { status, responseTimeMs } }
```

---

### 4.2 Migration Strategies

#### Drizzle Migrations

The project has two separate migration configs:

- **SQLite**: `drizzle.config.ts` - schema at `src/db/schema/sqlite/`, migrations at `src/db/migrations/`
- **PostgreSQL**: `drizzle.config.pg.ts` - schema at `src/db/schema/postgres/`, migrations at `src/db/migrations-pg/`

#### Migration Commands

```bash
# SQLite (default)
bun run db:generate     # Generate migration from schema changes
bun run db:migrate      # Apply migrations
bun run db:push         # Push schema directly (development only)
bun run db:studio       # Open Drizzle Studio

# PostgreSQL
bun run db:generate:pg
bun run db:migrate:pg
bun run db:push:pg
bun run db:studio:pg

# Migrate data from SQLite to PostgreSQL
bun run db:migrate:sqlite-to-pg
```

#### Migration File Structure

```
src/db/
├── schema/
│   ├── sqlite/                  # SQLite schema definitions
│   │   ├── index.ts
│   │   ├── projects.ts
│   │   ├── tasks.ts
│   │   ├── sessions.ts
│   │   └── ...
│   ├── postgres/                # PostgreSQL schema definitions
│   │   ├── index.ts
│   │   └── ...
│   └── shared/                  # Shared types/enums
├── migrations/                  # SQLite migrations
│   ├── meta/_journal.json
│   ├── 0000_clever_red_skull.sql
│   ├── ...
│   └── 0011_drop_agentcore_columns.sql
├── migrations-pg/               # PostgreSQL migrations
│   ├── meta/_journal.json
│   ├── 0000_little_wrecking_crew.sql
│   └── ...
└── client.ts                    # Database client (SQLite + PostgreSQL)
```

---

### 4.3 Backup and Restore Procedures

#### Backup Script

```bash
#!/bin/bash
# scripts/backup-database.sh

set -euo pipefail

# Configuration
DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_FILE="agentpane.db"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agentpane_${TIMESTAMP}.db"

echo "[Backup] Starting database backup..."

# Checkpoint WAL before backup (ensures consistency)
if [ -f "$DATA_DIR/$DB_FILE" ]; then
  sqlite3 "$DATA_DIR/$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);"
fi

# Copy database file
cp "$DATA_DIR/$DB_FILE" "$BACKUP_FILE"

# Compress backup
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

echo "[Backup] Created: $BACKUP_FILE"

# Calculate size
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[Backup] Size: $SIZE"

# Clean up old backups
echo "[Backup] Cleaning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "agentpane_*.db.gz" -mtime +$RETENTION_DAYS -delete

echo "[Backup] Complete"
```

#### Restore Script

```bash
#!/bin/bash
# scripts/restore-database.sh

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_FILE="agentpane.db"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <backup-file>"
  echo ""
  echo "Available backups:"
  ls -lh "$BACKUP_DIR"/*.gz 2>/dev/null || echo "  No backups found"
  exit 1
fi

BACKUP_FILE="$1"

# Stop AgentPane first
# Remove WAL files
rm -f "$DATA_DIR/$DB_FILE-wal" "$DATA_DIR/$DB_FILE-shm"

# Restore from backup
gunzip -c "$BACKUP_FILE" > "$DATA_DIR/$DB_FILE"

# Verify restored database
sqlite3 "$DATA_DIR/$DB_FILE" "PRAGMA integrity_check;"
```

---

## 5. CI/CD Pipeline

### 5.1 GitHub Actions Workflow

The actual CI workflow (`.github/workflows/ci.yml`) has two jobs:

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  BUN_VERSION: '1.3.10'

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Cache Bun packages
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-packages-${{ runner.os }}-${{ hashFiles('**/bun.lock', '**/package.json') }}
          restore-keys: |
            bun-packages-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun run typecheck

      - name: Lint and Format Check
        run: bun run check

  test:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    steps:
      - uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}

      - name: Cache Bun packages
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-packages-${{ runner.os }}-${{ hashFiles('**/bun.lock', '**/package.json') }}
          restore-keys: |
            bun-packages-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Test
        run: bun run test:coverage

      - name: Upload coverage
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage-report
          path: coverage/
```

---

### 5.2 Build Stages

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CI Pipeline                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌───────────────────────────┐     ┌───────────────────────────────────┐    │
│  │  lint-and-typecheck       │────▶│           test                    │    │
│  │                           │     │                                   │    │
│  │  - bun run typecheck      │     │  - bun run test:coverage          │    │
│  │  - bun run check (Biome)  │     │  - Upload coverage artifact       │    │
│  └───────────────────────────┘     └───────────────────────────────────┘    │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Note:** The CI pipeline does not currently include build, E2E test, or Docker image build/push jobs. These can be added as the project matures.

---

### 5.3 Artifact Management

#### Build Artifacts

| Artifact | Contents | Retention |
|----------|----------|-----------|
| `coverage-report` | Test coverage data (`coverage/`) | Always uploaded |

#### Docker Image Tags

| Tag | Description | When Updated |
|-----|-------------|--------------|
| `latest` | Most recent main build | Every main merge |
| `<sha>` | Specific commit | Every build |
| `v<version>` | Release version | On release |

---

### 5.4 Rollback Procedures

#### Quick Rollback (Docker)

```bash
# List available image tags
docker images agentpane --format "{{.Tag}}"

# Rollback to previous version
docker stop agentpane
docker rm agentpane
docker run -d \
  --name agentpane \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v agentpane-data:/app/data \
  -v agentpane-streams:/app/streams \
  agentpane:<previous-tag>
```

#### Kubernetes Rollback

```bash
# View rollout history
kubectl rollout history deployment/agentpane

# Rollback to previous revision
kubectl rollout undo deployment/agentpane

# Rollback to specific revision
kubectl rollout undo deployment/agentpane --to-revision=2

# Check rollback status
kubectl rollout status deployment/agentpane
```

#### Database Rollback

```bash
# If a migration caused issues:
# 1. Stop the application
docker stop agentpane

# 2. Restore from pre-migration backup
./scripts/restore-database.sh ./backups/agentpane_pre_migrate.db.gz

# 3. Deploy previous application version
docker run ... agentpane:<previous-version>
```

---

## 6. Infrastructure Requirements

### 6.1 Hardware Requirements

#### Local Development

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| CPU | 2 cores | 4+ cores | More cores = more concurrent agents |
| RAM | 4 GB | 8 GB+ | Each agent uses ~200-500 MB |
| Disk | 2 GB | 10 GB+ SSD | Database + worktrees |
| Network | 5 Mbps | 50 Mbps+ | API calls to Anthropic |

#### Production Server

| Resource | Small | Medium | Large |
|----------|-------|--------|-------|
| CPU | 2 vCPU | 4 vCPU | 8+ vCPU |
| RAM | 4 GB | 8 GB | 16+ GB |
| Disk | 20 GB SSD | 50 GB SSD | 100+ GB SSD |
| Max Agents | 3 | 6 | 10+ |

### 6.2 Network Requirements

#### Outbound Connections

| Destination | Port | Protocol | Purpose |
|-------------|------|----------|---------|
| api.anthropic.com | 443 | HTTPS | Claude API |
| api.github.com | 443 | HTTPS | GitHub API |
| registry.npmjs.org | 443 | HTTPS | Package registry |
| ghcr.io | 443 | HTTPS | Container registry |

#### Firewall Rules (Inbound)

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 3000 | TCP | localhost / LAN | Application (Caddy front door) |
| 443 | TCP | GitHub IPs | Webhooks (if enabled) |

#### Proxy Configuration

```bash
# If behind corporate proxy
export HTTP_PROXY=http://proxy.company.com:8080
export HTTPS_PROXY=http://proxy.company.com:8080
export NO_PROXY=localhost,127.0.0.1,.company.com
```

### 6.3 Browser Compatibility

| Browser | Minimum Version | Recommended |
|---------|-----------------|-------------|
| Chrome | 120+ | Latest |
| Firefox | 120+ | Latest |
| Safari | 17+ | Latest |
| Edge | 120+ | Latest |

#### Required Browser Features

- Server-Sent Events (SSE)
- ES2022+ JavaScript
- CSS Grid and Flexbox

---

## 7. Startup Sequence

### 7.1 Development Startup (`scripts/start-dev.ts`)

The development startup script orchestrates three processes:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Development Startup Sequence                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. Kill existing processes on ports 3000, 3001, 3002                         │
│  2. Check agent-sandbox Docker image (optional)                               │
│  3. Start DurableStreamTestServer on :3002                                    │
│  4. Wait for streams server ready                                             │
│  5. Start Bun API server on :3001 (bun src/server/api.ts)                    │
│  6. Wait for API health check (/api/health)                                  │
│  7. Start Vite dev server on :3000 (bunx vite)                               │
│  8. All three processes run concurrently                                      │
│                                                                               │
│  Shutdown: SIGINT/SIGTERM kills all three processes                           │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Production Startup (`docker/start.sh`)

In production (Docker), two processes run via `tini`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Production Startup Sequence                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. tini (PID 1) starts start.sh                                             │
│  2. Start durable-streams-server (Caddy) on :3000                            │
│  3. Wait for Caddy to be ready (/healthz)                                    │
│  4. Start Bun API server on :3001 (bun src/server/api.ts)                    │
│  5. Wait for either process to exit                                          │
│  6. If one exits, kill the other and propagate exit code                      │
│                                                                               │
│  Signal handling: SIGTERM/SIGINT forwarded to both processes                 │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.3 Health Check Endpoints

| Endpoint | Purpose | Implementation |
|----------|---------|----------------|
| `/healthz` | Caddy liveness | Responds "OK" 200 (Caddy built-in) |
| `/api/health` | Application health | Checks DB connectivity, returns status + response time |

### 7.4 Graceful Shutdown

On receiving SIGINT or SIGTERM:

1. **Development**: `start-dev.ts` kills API, Streams, and Vite processes
2. **Production**: `start.sh` forwards signal to Caddy and Bun API, waits for exit

---

## 8. Troubleshooting Guide

### 8.1 Common Issues and Solutions

#### Database Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| Database locked | "database is locked" error | Ensure single writer; check for stale processes |
| Corrupted database | Application crashes on start | Restore from backup |
| Migration failed | "migration failed" error | Check migration logs; fix and re-run |
| Out of disk space | Write operations fail | Clean cache, old backups |

```bash
# Check for stale processes
pgrep -f "bun.*api.ts"

# Verify database integrity
sqlite3 ./data/agentpane.db "PRAGMA integrity_check;"

# Vacuum database to reclaim space
sqlite3 ./data/agentpane.db "VACUUM;"
```

#### Agent Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| Agent stuck | Status shows "running" indefinitely | Check for API errors; restart agent |
| Rate limiting | 429 errors from Anthropic | Reduce concurrent agents; add delays |
| Tool failures | Agent can't execute tools | Check permissions; verify paths |
| Worktree conflicts | Git errors during agent execution | Clean up stale worktrees |

```bash
# List all worktrees
git worktree list

# Remove stale worktrees
git worktree prune

# Force remove specific worktree
git worktree remove --force .worktrees/stale-branch
```

#### Connection Issues

| Issue | Symptoms | Solution |
|-------|----------|----------|
| SSE disconnects | Real-time updates stop | Check network; refresh browser |
| API timeouts | Slow responses from Anthropic | Check network latency; retry |
| Port conflicts | Startup fails | Kill processes on ports 3000, 3001, 3002 |

---

### 8.2 Debug Mode Configuration

#### Enable Debug Logging

```bash
# Development
LOG_LEVEL=debug bun run dev

# Production (temporary)
LOG_LEVEL=debug docker restart agentpane
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [App Bootstrap](../architecture/app-bootstrap.md) | Detailed initialization sequence |
| [Database Schema](../database/schema.md) | Schema definitions and relationships |
| [Configuration Management](../configuration/config-management.md) | Environment and config loading |
| [Security Model](../security/security-model.md) | Secrets and authentication |
| [Error Catalog](../errors/error-catalog.md) | Error codes for troubleshooting |
| [Durable Sessions](../integrations/durable-sessions.md) | Real-time event streaming setup |
| [Claude Agent SDK](../integrations/claude-agent-sdk.md) | Agent pool configuration |
