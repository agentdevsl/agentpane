# Security, Sandboxing, Scaling & Infrastructure Research

**Date:** March 2026
**Current Stack:** Docker containers | Custom GitHub OAuth + RBAC | Hono 4.12.7 | SQLite (single-node) | Caddy reverse proxy | In-memory rate limiter | AES-256-GCM file-based secrets | SSE via Durable Streams

---

## 1. Container Sandbox Security

### Current State

Well-architected `SandboxProvider` interface with Docker, Kubernetes (gVisor/Kata `RuntimeClassName`), Nomad, and AgentCore providers. Non-root `node` user, bind-mounted workspaces.

### Security Assessment

Docker with default `runc` is **not sufficient** for untrusted AI-generated code. Shared kernel attack surface is too large. The codebase already supports gVisor and Kata — the question is which to default to.

### Comparison

| Technology | Isolation | Startup | Memory | Escape CVEs | Recommendation |
|---|---|---|---|---|---|
| **Docker (runc)** | Namespace/cgroup | <100ms | ~10MB | Multiple | **HOLD** for untrusted code. Dev/fallback only |
| **gVisor (runsc)** | User-space kernel | 50-100ms | ~50MB | None known | **ADOPT** as default. Already supported in codebase |
| **Firecracker** | Hardware VM (KVM) | 100-200ms | ~5MB | None known | **TRIAL** via E2B/Fly.io (managed) |
| **Kata Containers** | Hardware VM (KVM) | 150-300ms | ~50-100MB | None known | **ASSESS**. Already in `RuntimeClassName` type |
| **Podman** | Rootless containers | <100ms | ~10MB | Fewer than Docker | **HOLD**. Same isolation model as Docker |

### Managed Sandbox Platforms

| Platform | Isolation | Startup | Cost | Recommendation |
|---|---|---|---|---|
| **E2B** | Firecracker microVM | ~150ms | ~$0.05/hr | **TRIAL** — purpose-built for AI. Build `E2BSandboxProvider` |
| **Cloudflare Sandboxes** | Container on edge | Fast | $0.072/hr | **HOLD** — no BYOC (can't install agent-runner) |
| **Daytona** | Docker | 27-90ms | $0.067/hr | **ASSESS** — fastest but Docker-level isolation |
| **Fly.io Sprites** | Firecracker | ~300ms | Usage-based | **ASSESS** — good for globally distributed execution |
| **Modal** | gVisor | Sub-second | $0.14/hr | **HOLD** — Python-centric |

---

## 2. Authentication & Authorization

### Current State

GitHub OAuth with custom session management. Sessions in SQLite with hashed tokens. 30-day expiry. Custom RBAC middleware with team membership/roles. API keys via `ApiKeyService` with AES-256-GCM.

### Comparison

| Solution | Hono Integration | Multi-Tenant RBAC | Self-Host | Recommendation |
|---|---|---|---|---|
| **Custom** (current) | Native | Full control | Yes | **ADOPT (keep)** |
| **BetterAuth** | First-class plugin | Organizations plugin | Yes (MIT) | **TRIAL** — Lucia's successor, Drizzle-compatible |
| **Clerk** | Official middleware | Organizations | No (SaaS) | **ASSESS** — best DX but no self-host |
| **WorkOS** | REST API | Full RBAC + FGA | No (SaaS) | **ASSESS** — for enterprise SSO (SAML/SCIM) |
| **Auth.js** | Community adapter | Manual | Yes | **HOLD** — Next.js-centric |
| **Ory** | REST API | Full policy engine | Yes (OSS) | **HOLD** — high operational complexity |

---

## 3. API Framework

### Current State

Hono 4.12.7 on Bun 1.3.10. 33+ route modules. SSE streaming. Custom rate limiter.

### Performance Benchmarks (Bun, 2026)

| Framework | Ops/sec (no validation) | Ops/sec (with validation) |
|---|---|---|
| **Bun native** | 82,617 | 35,124 |
| **Elysia** | 71,202 | 33,150 |
| **Hono** | 62,207 | 48,397 |
| **Fastify 5** | 15,707 | 11,878 |

Hono has the **highest ops/sec with validation** (48,397 vs Elysia's 33,150).

### Recommendation

| Framework | Recommendation | Rationale |
|---|---|---|
| **Hono** | **ADOPT (keep)** | Best runtime portability + highest validated performance. 33+ routes built. Add `@hono/zod-openapi` for OpenAPI spec |
| **Elysia** | **HOLD** | Bun-only. Single-maintainer risk. Slower with validation |
| **Fastify 5** | **HOLD** | Node-only. 4x slower |
| **Express 5** | **HOLD** | Legacy. 8x slower |

---

## 4. Scaling SQLite

### Current State

SQLite via better-sqlite3. PostgreSQL docker-compose exists (Postgres 18). Drizzle schema has both `sqlite/` and `postgres/` directories.

### Comparison

| Solution | Read Replicas | Multi-Writer | Self-Host | Recommendation |
|---|---|---|---|---|
| **SQLite** (current) | No | No | Yes | **ADOPT** for single-node |
| **Turso (libSQL)** | Yes (embedded) | No | Yes (OSS) | **ADOPT** — best scaling path preserving SQLite simplicity |
| **Litestream** | Backup only | No | Yes | **TRIAL** — WAL backup to S3 |
| **LiteFS** | Yes | No | Yes | **HOLD** — Fly.io deprioritized. Pre-1.0 |
| **PostgreSQL + Neon** | Yes | No (branching) | SaaS | **TRIAL** — for write scaling. Docker-compose already exists |
| **rqlite** | Yes (Raft) | Yes | Yes | **HOLD** — higher latency, not Drizzle-compatible |
| **Cloudflare D1** | Yes (auto) | No | No | **ASSESS** — only if deploying on Cloudflare |

### Migration Effort

- **Turso:** Low (1-2 days). Swap driver. Drizzle has `drizzle-orm/libsql` adapter
- **PostgreSQL:** Medium (1-2 weeks). Schema exists. Verify queries, handle SQLite-specific functions

---

## 5. Rate Limiting & Abuse Prevention

### Current State

In-memory fixed-window counter per IP or API token. Code documents limitation: "In multi-instance deployment, each instance maintains counters independently." TODO for Redis-backed limiting.

### Comparison

| Solution | Storage | Multi-Instance | Recommendation |
|---|---|---|---|
| **In-memory** (current) | Process memory | No | **HOLD** — fails in multi-instance |
| **Upstash Ratelimit** | Serverless Redis | Yes (global) | **ADOPT** — drop-in replacement, sliding window + token bucket, ~$0.20/100K commands |
| **Redis INCR/EXPIRE** | Self-hosted Redis | Yes | **ASSESS** — if already running Redis |
| **Cloudflare Rate Limiting** | Edge | Yes | **ASSESS** — requires Cloudflare |

### AI Agent-Specific Abuse Prevention (Build)

| Control | Status | Recommendation |
|---|---|---|
| **Execution time limits** | Implemented (AGENT_MAX_TURNS, timeoutHandle) | Keep |
| **Resource quotas** | Implemented (SandboxConfig) | Keep |
| **Concurrent agent limits** | SandboxStateManager tracks but doesn't enforce | **ADOPT** — add per-team limits |
| **Cost accounting** | Partial (agent:metrics event) | **ADOPT** — track per team/user |
| **Infinite loop detection** | Not implemented | **ADOPT** — monitor for repetitive patterns |
| **Network egress controls** | Not implemented | **TRIAL** — NetworkPolicy for K8s, `--network` for Docker |
| **Filesystem quotas** | Not implemented | **TRIAL** — limit disk usage per sandbox |

---

## 6. Secrets Management

### Current State

API keys encrypted with AES-256-GCM in SQLite. Encryption key is a 32-byte file at `{SQLITE_DATA_DIR}/encryption.key` (0o600 permissions). OAuth tokens as env vars. Claude credentials written to `~/.claude/.credentials.json` inside containers.

### Security Concerns

1. Encryption key on disk alongside DB — both compromised together
2. No audit trail for secret access
3. No dynamic secrets or rotation
4. `CLAUDE_OAUTH_TOKEN` as container env var visible via `docker inspect`

### Comparison

| Solution | Self-Host | Dynamic Secrets | Rotation | Audit | Recommendation |
|---|---|---|---|---|---|
| **AES file** (current) | Yes | No | Manual | No | **HOLD** — improve |
| **Infisical** | Yes (MIT) | Yes | Yes | Yes | **ADOPT** — best fit. Self-host, great DX, Drizzle-compatible, K8s operator |
| **SOPS** | Yes (OSS) | No | No | No | **TRIAL** — complement for encrypting secrets in git |
| **HashiCorp Vault** | Yes (BSL) | Yes (best) | Yes | Yes | **ASSESS** — most feature-complete but high operational complexity |
| **Doppler** | No | Beta | Yes | Yes | **HOLD** — SaaS-only |

### Critical Immediate Fix

**Stop passing `CLAUDE_OAUTH_TOKEN` as container env var.** Use mounted secret files or Infisical agent to inject at runtime. Env vars visible via `docker inspect` and process listings.

---

## 7. Edge/CDN for Static Assets

### Current State

Caddy serves everything — static assets and API. Production Dockerfile uses `durable-streams-server` (custom Caddy build) on port 3000.

### Recommendation

| Technology | Recommendation | Rationale |
|---|---|---|
| **Cloudflare CDN** | **ADOPT** | Free tier: unlimited bandwidth, DDoS protection, automatic static caching. Transparent proxy in front of Caddy. Zero code changes. 1 hour setup |
| **Cloudflare Workers** | **TRIAL** | Edge auth validation, rate limiting. Hono runs natively on Workers |
| **Vercel Edge** | **HOLD** | Requires deploying frontend to Vercel |
| **Fastly** | **HOLD** | No free tier |

---

## 8. WebSocket Infrastructure

### Current State

SSE via Durable Streams. No WebSocket usage. Agent events flow server-to-client. Client commands go through REST.

### When WebSocket Would Help

1. Reduced latency for agent commands (direct WS vs HTTP roundtrips)
2. Interactive terminal sessions (bidirectional)
3. Collaborative editing (multi-user agent watching)

### Recommendation

| Technology | Recommendation | Rationale |
|---|---|---|
| **SSE + Durable Streams** (current) | **ADOPT (keep)** | Working well. Do not migrate |
| **Hono WebSocket** | **TRIAL** | Add alongside SSE for interactive terminals. Hono supports via `upgradeWebSocket()`. 2-3 days |
| **Soketi** | **ASSESS** | Self-hosted Pusher drop-in. 8.5x faster than Fastify. For collaborative features |
| **Ably** | **HOLD** | Expensive. Unnecessary when Soketi exists |
| **Pusher** | **HOLD** | 10x cost of Soketi |

---

## 9. Orchestration: Kubernetes vs Simpler Alternatives

### Current State

Multi-provider architecture: Docker (default fallback), Kubernetes (gVisor/Kata), Nomad, AgentCore (AWS Bedrock). Provider selection cascades with configurable fallback.

### Recommendation

| Technology | Recommendation | Rationale |
|---|---|---|
| **Docker** | **ADOPT (keep for dev/fallback)** | Simple, reliable, zero-ops |
| **K3s** | **ADOPT (for production)** | CNCF-certified K8s in single binary. SQLite backend aligns with AgentPane. Full API including RuntimeClass for gVisor/Kata |
| **Nomad** | **ADOPT (keep as alternative)** | Already implemented. Good for HashiCorp teams |
| **Full Kubernetes** | **ASSESS** | Only for 50+ concurrent agents |
| **AgentCore** | **TRIAL (keep)** | Already implemented. Good for AWS-native teams |
| **Kamal** | **HOLD** | Designed for web deploys, not sandbox orchestration |

---

## Top 5 Immediate Actions (by risk reduction)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | **Default to gVisor for sandbox pods** — make `RuntimeClassName: 'gvisor'` the default | Low | Highest security risk mitigation |
| 2 | **Adopt Upstash Ratelimit** — replace in-memory limiter | Low (1 day) | Fixes multi-instance rate limiting |
| 3 | **Stop passing OAuth tokens as container env vars** — use mounted secret files | Low | Eliminates credential exposure via `docker inspect` |
| 4 | **Add Turso/libSQL** — drop-in replacement enabling read replicas | Low (1-2 days) | Scaling path preserving SQLite simplicity |
| 5 | **Add Cloudflare CDN** — point DNS to Cloudflare | Minimal (1 hour) | DDoS protection + static asset performance |
