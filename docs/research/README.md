# AgentPane Architecture Technology Research

**Date:** March 2026
**Scope:** Comprehensive evaluation of technology alternatives across 11 architectural domains

## Supplemental UX-First Set

The reports below are the broad architecture survey. There is also a narrower,
more execution-focused supplement under [`opencode/README.md`](opencode/README.md).
That set focuses on trust, recovery, deployment honesty, reconnect behavior,
and implementation sequencing.

Recommended entry points:

- [`opencode/00-executive-brief.md`](opencode/00-executive-brief.md)
- [`opencode/04-implementation-backlog.md`](opencode/04-implementation-backlog.md)
- [`opencode/06-execution-briefs.md`](opencode/06-execution-briefs.md)
- [`opencode/07-phase-plan.md`](opencode/07-phase-plan.md)
- [`opencode/08-kickoff-checklist.md`](opencode/08-kickoff-checklist.md)
- [`opencode/09-validation-matrix.md`](opencode/09-validation-matrix.md)
- [`opencode/10-risk-register.md`](opencode/10-risk-register.md)
- [`opencode/11-rollout-plan.md`](opencode/11-rollout-plan.md)
- [`opencode/12-handoff-checklist.md`](opencode/12-handoff-checklist.md)
- [`opencode/13-stream-envelope-proposal.md`](opencode/13-stream-envelope-proposal.md)
- [`opencode/14-cursor-migration-plan.md`](opencode/14-cursor-migration-plan.md)

## Reports

| Report | Domain | Key Findings |
|--------|--------|-------------|
| [01-runtime-build.md](01-runtime-build.md) | Runtime, Build Tools, Linting, Monorepo | Stay Bun + Vite 8; adopt Bun Workspaces; trial esbuild for server bundles |
| [02-database-state.md](02-database-state.md) | Database, ORM, Client State, Streaming, Validation, IDs | Trial libSQL/Turso for scaling; migrate cuid2 to ULID; keep Drizzle + Durable Streams |
| [03-agent-orchestration.md](03-agent-orchestration.md) | Agent SDKs, Multi-agent, Memory, Sandboxing, Observability, MCP | Adopt Langfuse; trial gVisor + E2B; trial Mem0; keep Claude Agent SDK |
| [04-ui-frontend.md](04-ui-frontend.md) | React, Components, Styling, Terminal, Graphs, Animation, State | Adopt shadcn/ui selectively; activate Shiki; trial Zustand + react-virtuoso |
| [05-testing-devops.md](05-testing-devops.md) | Testing, CI/CD, Deployment, Monitoring, Security Scanning | Adopt Sentry + Socket.dev; trial Promptfoo + Coolify; stay Vitest + Playwright |
| [06-security-scaling.md](06-security-scaling.md) | Sandboxing, Auth, API, Scaling, Rate Limiting, Secrets, CDN, WebSocket, Orchestration | Default gVisor; adopt Upstash rate limiting + Infisical + Cloudflare CDN |
| [07-realtime-sync-reactive-data.md](07-realtime-sync-reactive-data.md) | Real-Time Sync, Reactive Data, Event Processing, Persistence, Streaming Performance | Adopt rAF buffering + virtual scrolling; trial Dexie.js cache + SharedWorker; assess Electric SQL + LiveStore |
| [08-event-sourcing-cqrs.md](08-event-sourcing-cqrs.md) | Event Sourcing, CQRS, Schema Evolution, Outbox, Sagas | Unify event types into single Zod source; partial event sourcing for sessions; team saga pattern |
| [09-streaming-protocols.md](09-streaming-protocols.md) | SSE vs WebSocket vs WebTransport, Compression, Edge, Reliability | Stay SSE; enable Brotli compression; add keepalive heartbeats; WebTransport not ready |
| [10-event-bus-pubsub.md](10-event-bus-pubsub.md) | Event Bus, Message Brokers, NATS, Redis Streams, DLQ, Ordering | Keep Durable Streams; NATS JetStream for future multi-node; add Caddy retry + circuit breaker |
| [11-platform-patterns.md](11-platform-patterns.md) | Cursor/Linear/Figma/Vercel/Temporal/Replit patterns | Structured stream parts; optimistic Kanban; separate presence from persistence; AsyncAPI spec |

## Consolidated Priority Actions

Note: the consolidated actions below are the broad cross-report synthesis. The
`opencode` supplement further narrows the near-term active queue to `OC-005`,
`OC-006`, `OC-001`, `OC-004`, `OC-008`, and `OC-007`, with `OC-002` and
`OC-003` intentionally deferred for now.

### Critical (Security)

| # | Action | Effort | Report |
|---|--------|--------|--------|
| 1 | Default to gVisor (`runsc`) for sandbox pods | Low | [06](06-security-scaling.md) |
| 2 | Stop passing OAuth tokens as container env vars | Low | [06](06-security-scaling.md) |
| 3 | Adopt Upstash Ratelimit (replace in-memory limiter) | Low | [06](06-security-scaling.md) |
| 4 | Adopt Infisical for secrets management | Medium | [06](06-security-scaling.md) |

### High Priority (Performance + Scalability)

| # | Action | Effort | Report |
|---|--------|--------|--------|
| 5 | Migrate cuid2 to ULID for time-sorted B-tree inserts | Low | [02](02-database-state.md) |
| 6 | **rAF event buffering** -- buffer SSE events, flush per animation frame | Low | [07](07-realtime-sync-reactive-data.md) |
| 7 | **Append-only timeline** -- replace useStreamParser re-sort with incremental append | Low | [07](07-realtime-sync-reactive-data.md) |
| 8 | **Virtual scrolling** -- @tanstack/react-virtual for stream panels | Low | [07](07-realtime-sync-reactive-data.md) |
| 9 | **Enable Brotli compression** on Caddy SSE endpoints (config-only change) | Minimal | [09](09-streaming-protocols.md) |
| 10 | **Unify event type definitions** into single Zod source of truth | Medium | [08](08-event-sourcing-cqrs.md) |
| 11 | Trial libSQL/Turso for read replicas | Medium | [02](02-database-state.md) |
| 12 | Adopt Langfuse (self-hosted) for agent observability | Medium | [03](03-agent-orchestration.md) |
| 13 | Set up Bun Workspaces (fix dual lockfiles) | Low | [01](01-runtime-build.md) |

### Medium Priority (DX + Quality)

| # | Action | Effort | Report |
|---|--------|--------|--------|
| 14 | Adopt Sentry for error tracking + performance | Low | [05](05-testing-devops.md) |
| 15 | Adopt Socket.dev for supply chain security | Low | [05](05-testing-devops.md) |
| 16 | **Add SSE keepalive heartbeats** (30s) and chunk event deduplication | Low | [09](09-streaming-protocols.md) |
| 17 | **Add bounded Caddy publish retry** + circuit breaker | Low | [10](10-event-bus-pubsub.md) |
| 18 | **Separate presence from SQLite persistence** (bypass DB, SSE only) | Low | [11](11-platform-patterns.md) |
| 19 | **Tab visibility pause** -- pause SSE when tab is hidden | Low | [07](07-realtime-sync-reactive-data.md) |
| 20 | **useOptimistic** -- optimistic plan approval/rejection/cancel | Low | [07](07-realtime-sync-reactive-data.md) |
| 21 | Activate Shiki (already installed) for syntax highlighting | Low | [04](04-ui-frontend.md) |
| 22 | Add shadcn/ui components selectively | Low | [04](04-ui-frontend.md) |
| 23 | Add Cloudflare CDN in front of Caddy | Minimal | [06](06-security-scaling.md) |
| 24 | Trial E2B as managed sandbox provider | Medium | [03](03-agent-orchestration.md) |

### Lower Priority (Assess / Trial)

| # | Action | Effort | Report |
|---|--------|--------|--------|
| 25 | Trial Zustand for shared UI state | Low | [04](04-ui-frontend.md) |
| 26 | **Structured stream parts** (start/delta/end with block IDs) | Medium | [11](11-platform-patterns.md) |
| 27 | **Formalize session as event-sourced aggregate** | Medium | [08](08-event-sourcing-cqrs.md) |
| 28 | **Phase-boundary snapshots** for fast session replay | Low | [08](08-event-sourcing-cqrs.md) |
| 29 | **AsyncAPI spec** for StreamEventMap (third-party integration readiness) | Low | [11](11-platform-patterns.md) |
| 30 | **Team saga state machine** for multi-agent compensation/recovery | Medium | [08](08-event-sourcing-cqrs.md) |
| 31 | **Trial Dexie.js** -- persist events to IndexedDB for page reload resilience | Medium | [07](07-realtime-sync-reactive-data.md) |
| 32 | **Trial SharedWorker** -- share SSE connections across browser tabs | Medium | [07](07-realtime-sync-reactive-data.md) |
| 33 | **Trial Yjs awareness** -- replace presence heartbeat polling | Medium | [07](07-realtime-sync-reactive-data.md) |
| 34 | Trial Promptfoo for AI prompt regression testing | Low | [05](05-testing-devops.md) |
| 35 | Trial esbuild for API server bundling | Low | [01](01-runtime-build.md) |
| 36 | Add type-aware ESLint rules for critical paths | Medium | [01](01-runtime-build.md) |
| 37 | Trial Mem0 graph memory vs Honcho | Medium | [03](03-agent-orchestration.md) |
| 38 | Trial Coolify for self-hosted deployment | Low | [05](05-testing-devops.md) |
| 39 | Assess BetterAuth as auth alternative | Medium | [06](06-security-scaling.md) |
| 40 | **Assess LiveStore** -- proof-of-concept with one collection | High | [07](07-realtime-sync-reactive-data.md) |
| 41 | **Assess Electric SQL** -- automatic DB-to-client sync (post-Postgres) | High | [07](07-realtime-sync-reactive-data.md) |
| 42 | **Assess NATS JetStream** for future multi-node event routing | High | [10](10-event-bus-pubsub.md) |
| 43 | **Event classification** (domain/integration/operational routing) | Low | [08](08-event-sourcing-cqrs.md) |
| 44 | **Webhook delivery** for key agent lifecycle events | Medium | [11](11-platform-patterns.md) |

## Technology Radar

### Adopt

- Bun 1.3.x, Vite 8/Rolldown, Biome 2.x, Hono, Drizzle ORM, React 19, Tailwind v4 + CVA, React Flow, Playwright, Vitest 4, Claude Agent SDK, Durable Streams/SSE, Docker (dev), K3s (production), rAF event buffering, append-only timeline, `startTransition` for metadata, `React.memo` for streaming, backoff jitter, tab visibility pause, `useOptimistic`, Brotli SSE compression, SSE keepalive heartbeats

### Trial

- libSQL/Turso, ULID, Langfuse, gVisor, E2B, Sentry, Promptfoo, shadcn/ui, Zustand, @tanstack/react-virtual (stream panels), Shiki, Socket.dev, Coolify, Upstash Ratelimit, Infisical, Cloudflare CDN, Hono WebSocket, MCP server hosting, OpenTelemetry GenAI, Dexie.js (event cache), SharedWorker multi-tab, Yjs awareness, Comlink + Worker, priority queue rendering, unified Zod event schema, structured stream parts (start/delta/end), session event sourcing, phase-boundary snapshots, Caddy publish retry + circuit breaker, chunk event deduplication, AsyncAPI spec

### Assess

- Mastra, Vercel AI SDK streaming, Mem0, BetterAuth, Braintrust evals, CodeMirror 6 (diffs), View Transitions API, Turborepo, PostgreSQL + Neon, Semgrep, CodeQL, LiveStore, Electric SQL (post-Postgres), Jotai (atomic streaming), Loro (collaborative editing), NATS JetStream (multi-node), team saga state machine, event classification (domain/integration/operational), webhook delivery, Bunqueue (job scheduling), codespace-scoped stream multiplexing

### Hold

- Deno 2.x, Turbopack, Rspack, Farm, Nx, Jest 30, Cypress, Elysia, Fastify, Express 5, Prisma, Solid.js, Svelte, Vue, LangGraph, CrewAI, AutoGen, Letta, Socket.IO, PartyKit, Framer Motion, CR-SQLite, LiteFS, ArkType, Podman, Kamal (for sandboxes), RxJS, Nanostores, @streamparser/json, SharedArrayBuffer, wa-sqlite/OPFS, CRDT agent output sync, WebTransport (no Safari/Bun/Caddy), binary serialization (text-dominant payloads), edge streaming relay, EventStoreDB/Marten, Avro/Protobuf schema registry, Cloudflare Durable Objects (vendor lock-in), Redis Streams (unless Redis already in stack), Kafka/Redpanda/Pulsar (overkill), vector clocks (no cross-agent causality)
