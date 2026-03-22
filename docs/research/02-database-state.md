# Database, ORM, Client State, Streaming, Validation & ID Generation Research

**Date:** March 2026
**Current Stack:** SQLite (better-sqlite3 12.8.0) | Drizzle ORM 0.45.1 | TanStack DB 0.5.33 | Durable Streams 0.2.x | Zod 4.3.6 | cuid2 3.3.0

---

## 1. SQLite Improvements

### Current Implementation

better-sqlite3 with WAL mode and foreign keys enabled. Parallel PostgreSQL schema exists (`src/db/schema/postgres/`). `DB_MODE` env var switches between SQLite and Postgres at runtime. 36 database tables.

### Technology Comparison

| Technology | Recommendation | Key Consideration |
|---|---|---|
| **better-sqlite3** (current) | **ADOPT (keep)** | Perfectly adequate for single-node. Synchronous API is fast. Scaling ceiling is real but not yet reached |
| **Bun built-in SQLite** (`bun:sqlite`) | **ASSESS** | Claims 3-6x faster reads. API nearly identical. Drizzle `bun-sqlite` driver less battle-tested. Benchmark before adopting |
| **libSQL / Turso** | **TRIAL** | Most compelling scaling path. Embedded replicas give microsecond reads while syncing from remote primary. Drizzle supports via `drizzle-orm/libsql`. Migration: Low (1-2 days) |
| **SQLite WAL2** | **HOLD** | Experimental, not in mainline SQLite. Not production-safe |
| **CR-SQLite** | **HOLD** | Research-grade. CRDTs not needed for append-only agent events |
| **Electric SQL** | **ASSESS** | GA since March 2025. Postgres-first. Parent of Durable Streams. If AgentPane moves to Postgres, Electric could replace SSE streaming with integrated sync. Strategic importance due to Durable Streams relationship |

### libSQL Deep Dive

libSQL is a production-grade SQLite fork by Turso with embedded replicas (GA). The primary writes to a Turso-hosted instance; read replicas run embedded in each app node. This eliminates the single-writer bottleneck for reads without requiring PostgreSQL migration.

**For AgentPane's `session_events` table** (highest write volume): writes go to primary, reads from embedded replicas. The atomic `INSERT...SELECT` offset pattern works with libSQL.

**Migration:** Replace `better-sqlite3` with `@libsql/client`. Drizzle supports via `drizzle-orm/libsql`. Schema files unchanged.

---

## 2. Drizzle ORM Alternatives

### Current Implementation

Drizzle ORM 0.45.1 deeply integrated. Parallel schema directories (`src/db/schema/sqlite/` with 38 files, `src/db/schema/postgres/`). `drizzle-zod` integration. Drizzle Kit 0.31.10 for migrations.

| ORM | Recommendation | Rationale |
|---|---|---|
| **Drizzle ORM** (current) | **ADOPT (keep)** | ~12% overhead vs raw SQL (negligible). First-class SQLite support. Dual-dialect schema works well. Stable API |
| **Prisma 6.x/7.x** | **HOLD** | ~29% overhead. 40KB+ client bundle. 1-3 second cold starts. Migration prohibitive (rewrite all 36+ table definitions) |
| **Kysely** | **HOLD** | ~8% overhead (fastest query builder). No ORM features — manual JOIN management. Only assess if specific Drizzle bottlenecks found |
| **Raw SQL** | **HOLD** | Drizzle's `sql` template tag already covers rare raw SQL needs |

---

## 3. TanStack DB Assessment

### Current Implementation

TanStack DB 0.5.33 used for **local-only reactive collections** (7 collections: chunks, toolCalls, presence, terminal, workflow, agentState, messages). No server sync — acts as reactive in-memory store. Data flows: SSE -> collection inserts -> reactive queries -> React re-renders.

### Stability Status

- Still in beta (0.x). Targeted 1.0 has not shipped
- Type regression between versions required a `useCollectionQuery` wrapper workaround
- Local-only pattern is isolated to ~9 files

### Alternatives

| Technology | Recommendation | Rationale |
|---|---|---|
| **TanStack DB** (current) | **TRIAL (continue)** | Local-only pattern is sound and isolated. Monitor for 1.0 |
| **Plain React + useSyncExternalStore** | **ASSESS (fallback)** | ~200 lines of utility code to replicate. Lowest-risk replacement if TanStack DB abandoned |
| **PowerSync** | **ASSESS** | Production-grade. Has `@tanstack/powersync-db-collection` integration. Overkill unless offline support needed |
| **Zero (Rocicorp)** | **ASSESS (6-12 months)** | Alpha/early beta. Would replace TanStack DB + Durable Streams with end-to-end sync. Requires Postgres |
| **Replicache** | **HOLD** | Maintenance mode. Zero is the successor |

---

## 4. Event Streaming Architecture

### Current Implementation

Well-designed layered architecture:

1. Agent SDK generates streaming events
2. ChunkBatcher immediately publishes deltas via SSE, then batches for SQLite persistence (100ms interval)
3. SessionStreamService persists to `session_events` with atomic offset calculation, publishes to Durable Streams
4. Caddy serves SSE endpoint (`/v1/stream/sessions/:id`)
5. DurableStreamsClient on frontend connects via EventSource with offset-based resume

### Assessment

| Technology | Recommendation | Rationale |
|---|---|---|
| **SSE + Durable Streams** (current) | **ADOPT (keep)** | Correct choice for unidirectional agent output. HTTP/2 multiplexing, auto reconnect, offset-based resume, browser-native EventSource |
| **WebSocket (Hono)** | **HOLD for streaming, ASSESS for terminals** | SSE is simpler and sufficient. WebSocket only needed for interactive terminal sessions |
| **Socket.IO** | **HOLD** | ~50KB bundle. Solves problems AgentPane doesn't have |
| **PartyKit** | **HOLD** | Designed for multiplayer collaborative apps. Wrong paradigm |
| **Liveblocks** | **HOLD** | SaaS dependency for unneeded features |
| **SQLite change notifications** | **ASSESS** | Could eliminate dual-write pattern if migrating to libSQL (which exposes `update_hook()`) |

---

## 5. Zod 4 vs Alternatives

### Current Implementation

Zod 4.3.6 used in 35 source files: stream event validation, Durable Streams state schemas, API route validation, config validation, integration with Drizzle.

| Technology | Recommendation | Rationale |
|---|---|---|
| **Zod 4** (current) | **ADOPT (keep)** | JIT compilation 7-14x faster than Zod 3 for reused schemas. Best ecosystem: `drizzle-zod`, Hono validator, TanStack Router |
| **Zod Mini** | **ASSESS** | ~3.9KB (vs ~58KB Classic). Drop-in subset. Use if client bundle size matters |
| **Valibot** | **ASSESS (client-side only)** | ~1.4KB. Has `drizzle-valibot` and `@hono/valibot-validator`. Not worth full migration |
| **ArkType** | **HOLD** | 3-4x faster but no Drizzle or Hono support. Dealbreaker |
| **TypeBox** | **HOLD** | JSON Schema compat not needed. No Hono middleware |
| **Effect Schema** | **HOLD** | Wrong ecosystem (Effect not used) |

---

## 6. ID Generation

### Current Implementation

`@paralleldrive/cuid2` in **96 files**. Every table PK uses `$defaultFn(() => createId())`. 24-character lowercase alphanumeric, **not time-sortable**, SHA3-based (~50K IDs/sec).

### Impact of Non-Sortability

- **B-tree fragmentation:** Random IDs cause page splits. Every insert writes to a random leaf page instead of appending
- **`session_events` table** (highest write volume): Random PK position on every insert vs always-append with sorted IDs
- **Performance:** `createdAt` index partially compensates but PK fragmentation still affects write throughput

### Comparison

| Generator | Format | Sortable | Performance | Collision Resistance |
|---|---|---|---|---|
| **cuid2** (current) | 24-char alphanumeric | No | ~50K/sec (SHA3) | Very high |
| **ULID** | 26-char Crockford Base32 | Yes (ms precision) | ~3M/sec (`ulidx`) | 80 bits/ms |
| **UUID v7** | 36-char standard UUID | Yes (ms precision) | ~2M/sec | 62 bits/ms |
| **NanoID** | 21-char URL-safe | No | ~7M/sec | High |

### Recommendation

| Generator | Recommendation | Rationale |
|---|---|---|
| **ULID** | **TRIAL** | 60x faster than cuid2. Time-sortable = append-only B-tree inserts. Shorter than UUID v7. Migration is mechanical: change `$defaultFn` in schema files |
| **UUID v7** | **ASSESS** | Standards-based (RFC 9562) but longer string, slower than ULID |
| **NanoID** | **HOLD** | Fastest but no sortability. Same B-tree fragmentation as cuid2 |
| **cuid2** | **HOLD (deprecate)** | Slowest. No sortability. SHA3 overhead is a net negative |

---

## Priority Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **ULID migration** — replace cuid2 across 96 files | Low (mechanical) | B-tree performance for write-heavy tables |
| 2 | **libSQL proof-of-concept** — test embedded replicas with `session_events` | Medium | Most promising scaling path preserving SQLite simplicity |
| 3 | **TanStack DB contingency plan** — document fallback to `useSyncExternalStore` | Low | Risk mitigation for 0.x dependency |
