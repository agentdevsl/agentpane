# Deployment Architecture

Production deployment uses a single Docker container running Caddy (with the durable-streams plugin) as the front door on port 3000. Caddy reverse-proxies API requests to the Bun server on port 3001, serves static frontend assets directly, and handles durable stream SSE endpoints backed by LMDB.

```mermaid
flowchart TB
    INET["Internet / Client Browser"]
    GOCLI["Go CLI<br/><small>agentpane binary</small>"]

    subgraph COMPOSE ["Docker Compose"]
        subgraph MAIN ["agentpane container"]
            direction TB
            TINI["tini (PID 1)<br/><i>signal forwarding</i>"]
            START["start.sh<br/><i>process supervisor</i>"]

            subgraph CADDY ["Caddy :3000 (durable-streams-server)"]
                direction LR
                HEALTH_C["/healthz"]
                STREAMS["/v1/stream/*<br/><i>SSE + long-poll</i>"]
                PROXY["/api/*<br/><i>reverse_proxy</i>"]
                STATIC["/*<br/><i>file_server + SPA fallback</i>"]
            end

            subgraph BUN ["Bun API :3001"]
                direction LR
                HONO["Hono Router<br/><i>33 route modules</i>"]
                SERVICES["Services Layer<br/><i>agent, task, session,<br/>sandbox, worktree...</i>"]
            end

            TINI --> START
            START --> CADDY
            START --> BUN
        end

        subgraph STORAGE ["Persistent Volumes"]
            SQLITE[(agentpane-data<br/><i>SQLite DB</i><br/>/app/data/agentpane.db)]
            LMDB[(agentpane-streams<br/><i>LMDB</i><br/>/app/streams)]
        end

        subgraph SANDBOX ["Agent Sandbox Containers"]
            direction LR
            S1["agent-sandbox:latest<br/><i>per-codespace container</i>"]
            S2["agent-sandbox:latest<br/><i>per-codespace container</i>"]
        end

        subgraph HONCHO ["Honcho Memory (optional)"]
            direction LR
            HONCHO_API["honcho:2.0.1<br/><i>Memory API :8000</i>"]
            HONCHO_PG["pgvector/pgvector:pg16<br/><i>PostgreSQL :5433</i>"]
            HONCHO_REDIS["redis:7-alpine<br/><i>Redis :6380</i>"]
            HONCHO_API --> HONCHO_PG
            HONCHO_API --> HONCHO_REDIS
        end
    end

    INET -- "HTTPS" --> CADDY
    GOCLI -- "REST /api/*" --> CADDY
    PROXY -- "flush_interval -1<br/>(streaming)" --> HONO
    HONO --> SERVICES
    SERVICES --> SQLITE
    CADDY --> LMDB
    SERVICES -- "DurableStreamsService<br/>publish()" --> STREAMS
    SERVICES -- "ContainerAgentService<br/>exec / execStream" --> SANDBOX
    SERVICES -. "MemoryService<br/>(optional)" .-> HONCHO_API
    S1 -. "/workspace<br/>bind mount" .-> SQLITE
    S2 -. "/workspace<br/>bind mount" .-> SQLITE

    STATIC -. "/app/dist<br/>(Vite build)" .-> CADDY

    style COMPOSE fill:#0f172a,color:#e2e8f0
    style MAIN fill:#1e293b,color:#e2e8f0
    style CADDY fill:#1e3a5f,color:#e2e8f0
    style BUN fill:#14532d,color:#e2e8f0
    style STORAGE fill:#713f12,color:#e2e8f0
    style SANDBOX fill:#581c87,color:#e2e8f0
    style HONCHO fill:#4a1d6e,color:#e2e8f0,stroke:#bc8cff,stroke-width:2px
    style GOCLI fill:#1a3a2a,color:#3fb950,stroke:#3fb950,stroke-width:2px
```

## Docker Images

| Image | Dockerfile | Purpose |
|-------|-----------|---------|
| `agentpane:latest` | `docker/Dockerfile` | Main application (Caddy + Bun) |
| `srlynch1/agent-sandbox:latest` | `docker/Dockerfile.agent-sandbox` | Sandboxed agent execution (Claude CLI + agent-runner) |
| `agentpane-agentcore:latest` | `docker/Dockerfile.agentcore` | AWS Bedrock AgentCore runtime (ARM64) |
| `ghcr.io/plastic-labs/honcho:2.0.1` | `docker/docker-compose.memory.yml` | Persistent agent memory (Honcho API + pgvector + Redis) |

## Build Stages (Main Dockerfile)

1. **deps** -- `oven/bun:1.3.10-alpine`, install dependencies with frozen lockfile
2. **build** -- compile frontend (Vite) + typecheck + agent-runner
3. **caddy** -- download `durable-streams-server` binary for target architecture
4. **runtime** -- `oven/bun:1.3.10-alpine` with git, tini, wget, bash; runs as non-root `bun` user

## Caddy Configuration

| Path | Handler | Target |
|------|---------|--------|
| `/healthz` | respond 200 | Health check |
| `/v1/stream/*` | `durable_streams` plugin | LMDB-backed SSE + long-poll (30s timeout, 120s reconnect) |
| `/api/*` | `reverse_proxy` | `localhost:3001` (streaming enabled) |
| `/*` | `file_server` | `/app/dist` with SPA fallback + gzip/brotli + immutable cache for `/assets/*` |

## Process Lifecycle (start.sh)

1. Start Caddy (`durable-streams-server run`) in background
2. Wait up to 15s for Caddy to be ready on `:3000/healthz`
3. Start Bun API (`bun src/server/api.ts`) in background
4. Wait for either process to exit; if one dies, kill the other
5. `tini` handles SIGTERM/SIGINT forwarding to both processes

## Volumes

| Volume | Mount | Contents |
|--------|-------|----------|
| `agentpane-data` | `/app/data` | SQLite database |
| `agentpane-streams` | `/app/streams` | LMDB durable stream data |
| `honcho_pgdata` | Honcho PostgreSQL | Honcho memory data (optional) |
| `honcho_redis` | Honcho Redis | Honcho cache data (optional) |

## Alternative Configurations

- **PostgreSQL**: `docker/docker-compose.postgres.yml` provides a PostgreSQL 18 instance for environments requiring a relational database instead of SQLite
- **Agent sandbox containers**: created dynamically by `ContainerAgentService` with project directories bind-mounted to `/workspace`
- **Honcho Memory**: `docker/docker-compose.memory.yml` provides Honcho (memory API), pgvector PostgreSQL, and Redis as an optional sidecar for persistent agent memory
