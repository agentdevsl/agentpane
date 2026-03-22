# Production Platform Streaming Patterns & Architectural Lessons

**Date:** March 2026
**Scope:** How Cursor, Linear, Figma, Vercel, Copilot Workspace, Temporal/Inngest/Trigger.dev, Replit, Liveblocks/Ably/Pusher, Cloudflare Durable Objects, and Event Mesh patterns apply to AgentPane

---

## 1. Cursor / Windsurf / Cline

### Key Patterns

- **Diff streaming**: Cursor streams partial diffs in real time as the model generates edits — not post-hoc. UI renders red/green inline diff previews as tokens arrive
- **Multi-file Composer**: Changes staged and previewed before applying; accept/reject per-file. Cursor 2.0 added consolidated cross-file diff view
- **Plan/Execute split**: Plans created with one model, executed with another. Background execution supported
- **Transport**: WebSocket to backend servers for primary AI interaction

### Lessons for AgentPane

1. **Streaming structured diffs** — Add `file_edit` event type carrying structured diff data (file path, line range, old/new content) instead of raw text chunks. Enables richer UI with per-file modification tracking
2. **Consolidated multi-file diff view** — For team mode, show which agent edits which files simultaneously
3. **Background execution indicators** — Persistent progress even when user navigates away
4. **Terminal as first-class data stream** — Windsurf's approach of treating terminal output as AI input validates AgentPane's `terminal:input`/`terminal:output` events

---

## 2. Linear

### Sync Engine Architecture

- **Delta packets**: All mutations as transactions with monotonic `syncId`. Server generates delta packets broadcast via WebSocket
- **SyncClient**: Listens to WebSocket `SyncMessage` channel, invokes `applyDelta` with Object Pool for efficient model retrieval
- **Conflict resolution**: Last-Writer-Wins for `UpdateTransaction`
- **Optimistic updates**: All writes update UI immediately. Transaction queue persisted to IndexedDB for refresh resilience
- **Bootstrap**: Determines "local" (IndexedDB + deltas) vs "partial" (server subset) bootstrap type

### Lessons for AgentPane

1. **Optimistic Kanban updates** — Apply drag-drop changes immediately, reconcile with server response. Linear proves this at scale
2. **IndexedDB for offline resilience** — Cache session events for page reload survival. Especially valuable for long-running agent sessions
3. **Transaction queue persistence** — Pending mutations survive network blips and refreshes
4. **Delta-based sync** — Extend `fromOffset` pattern: store `lastSyncId` client-side, only fetch new events on load

---

## 3. Figma

### Multiplayer Architecture

- **Rust multiplayer service** (rewritten from TypeScript for 10x perf): Authoritative source, validates changes, resolves conflicts, broadcasts via WebSocket
- **Checkpointing**: S3 writes every 30-60 seconds (durability). Journal (WAL) for replay between checkpoints
- **CRDTs**: Used for design canvas. Newer Code Layers use Eg-walker algorithm (CRDT merge speed with OT memory efficiency)
- **Presence**: Separate lightweight channel from document mutations

### Lessons for AgentPane

1. **Separate presence from persistence** — Presence events (`presence:joined`/`left`/`cursor`) should bypass SQLite entirely, only flow through Caddy SSE. Reduces DB write load significantly
2. **In-memory state with periodic checkpointing** — Hold active session state in memory, checkpoint to SQLite periodically. ChunkBatcher already does this for chunks; extend to other event types
3. **Journal for replay efficiency** — Lightweight WAL for fast session switching instead of always querying full `session_events` table
4. **Rust for hot-path processing** — If event fan-out becomes bottleneck, extract to Rust service

---

## 4. Vercel AI SDK 5

### Structured Stream Parts Protocol

- `message-start`/`text-start`/`text-delta`/`text-end` with unique IDs per block
- `tool-input-start`/`tool-input-delta`/`tool-input-available` for streaming tool calls
- Transient parts: sent to client but not persisted to message history
- `x-vercel-ai-ui-message-stream: v1` header for protocol versioning

### Lessons for AgentPane

1. **Structured stream parts** — Adopt `chunk:start`/`chunk:delta`/`chunk:end` subtypes with block IDs. Enables client-side deduplication on reconnect, associating text blocks with tool calls, distinguishing reasoning from output
2. **Transient vs persistent events** — Formalize: some events always persisted (tool calls, state changes), others transient (individual text deltas, cursor movements). ChunkBatcher already does this implicitly
3. **Last-Event-ID for resumption** — Ensure Caddy supports `Last-Event-ID` for automatic SSE reconnection
4. **Protocol versioning** — Add stream protocol version header for forward compatibility

---

## 5. GitHub Copilot Workspace

### Architecture

- **Plan-Execute pipeline**: Spec -> plan (3-10 phases) -> user review -> implementation
- **Async execution**: Runs in GitHub Actions CI environment. Progress via PR comments/status checks
- **Two modes**: `agent_mode` (local, real-time streaming) and `coding_agent` (remote, async status updates)

### Lessons for AgentPane

1. **Phase-based progress** — Each plan phase as a topology node with per-phase progress tracking. More meaningful than raw turn counts
2. **PR-as-output model** — Emphasize resulting PR/diff over raw agent transcript in the UI
3. **Two execution modes** — Support "attended" (real-time streaming) and "unattended" (background with periodic Kanban updates) explicitly

---

## 6. Temporal.io / Inngest / Trigger.dev

### Key Patterns

**Temporal**: ~40 event types in strict-order history. Full workflow trace visualization. Update feature for low-latency workflow interaction. Visibility API for search/filter.

**Inngest AgentKit**: `useAgent` React hook streams durable AI workflow updates as composable parts (text, tools, data, reasoning) updating independently. Step functions with `step.ai.infer()` for durable AI calls.

**Trigger.dev**: OpenTelemetry-powered dashboard with hierarchical span/log/subtask visualization. Checkpoint-resume for serverless. Stream forwarding from AI SDK to frontend.

### Lessons for AgentPane

1. **OpenTelemetry for agent traces** — Instrument agent execution with OTel spans. Each tool call, file edit, planning step as a span. Hierarchical visualization for free
2. **Composable streaming parts (Inngest)** — Render text, tools, data channels independently rather than interleaving into single stream. Validates AgentPane's channel-based model
3. **Checkpoint-resume** — If container crashes, resume from last checkpoint rather than restart. Improves container agent resilience

---

## 7. Replit Agent

### Architecture

- **Multi-agent**: Manager agent oversees, editor agents handle specific tasks. Parallel progress visible to user
- **OT-based file sync**: Real-time code sync via Operational Transformation over WebSocket
- **DSL for tool invocation**: Generates Python DSL code instead of structured tool calls
- **200-minute continuous execution**: Robust reconnection and memory management required

### Lessons for AgentPane

1. **Manager/worker event levels** — Manager emits high-level progress, workers emit detailed execution. UI shows different detail levels based on focused agent
2. **Long-session support** — Ensure event storage and replay handles thousands of events efficiently. Session snapshots become critical

---

## 8. Liveblocks / Ably / Pusher

### Key Patterns

- **Room = Session**: Liveblocks rooms map directly to AgentPane sessions. Validates current per-session stream architecture
- **Ephemeral presence**: All three treat presence as connection-scoped, never persisted. AgentPane's in-memory `SessionPresenceService` is correct
- **Fan-out backplane**: Pusher uses Redis/Kafka/NATS between WebSocket servers for horizontal scaling
- **Connection state machine**: Formal lifecycle (connecting, connected, disconnecting, reconnecting) with exponential backoff

### Lessons for AgentPane

1. **Presence bypasses persistence** — Confirmed: presence events should never hit SQLite
2. **Formal connection state machine** — Client should display connection status to user
3. **Event batching for persistence** — Extend ChunkBatcher pattern to other high-frequency events (e.g., `topology:agent_progress`)
4. **Pub/sub backplane for multi-node** — When scaling, Caddy instances per server with shared backplane

---

## 9. Cloudflare Durable Objects

### Architecture

Each Durable Object = stateful micro-server with SQLite, WebSocket connections, scheduling. Hibernation keeps WebSocket alive while DO is evicted from memory (zero cost during hibernation).

### Assessment for AgentPane

**Pros:** Natural session-per-DO mapping, hibernation for idle sessions, global routing, Agents SDK building blocks.

**Cons:** Vendor lock-in, single-threaded per DO, storage limits, significant migration from Caddy + SQLite.

### Verdict

Not worth migrating to from current architecture. But **adopt the hibernation concept**: release resources for idle sessions. CaddyDurableStreamsServer already does this with LRU eviction (5-min idle, max 200 producers).

---

## 10. Event Mesh / Event Gateway

### Should AgentPane Expose Events as First-Class API?

**Yes, with these additions:**

1. **AsyncAPI spec** — Document `StreamEventMap` as AsyncAPI specification. Enables external tools to subscribe programmatically
2. **Event gateway** — Caddy already serves as one. Expose select streams (`container-agent:complete`, `topology:agent_completed`) as authenticated SSE endpoints
3. **Topic-based filtering** — Channel-based model (`plan:*`, `sandbox:*`) maps to topic hierarchies. Allow subscribing to specific prefixes
4. **Webhook delivery** — POST key events (task completed, agent error, PR created) for async integrations. Standard pattern (Stripe, GitHub, Linear)
5. **Rate limiting + access control** — API keys/OAuth + per-client rate limits for event API consumers

---

## Consolidated Priority Actions

| Priority | Action | Source Platform | Effort | Impact |
|----------|--------|----------------|--------|--------|
| 1 | **Structured stream parts** (start/delta/end with block IDs) | Vercel AI SDK 5 | Medium | Client dedup, text-tool association |
| 2 | **Optimistic Kanban updates** with IndexedDB persistence | Linear | Medium | Instant UI response |
| 3 | **Separate presence from SQLite persistence** | Figma, Liveblocks | Low | Reduce DB write load |
| 4 | **File-level diff events** for real-time multi-file view | Cursor | Medium | Richer agent output visualization |
| 5 | **OpenTelemetry instrumentation** for agent traces | Trigger.dev | Medium | Hierarchical execution visualization |
| 6 | **Last-Event-ID SSE reconnection** | SSE spec, Vercel | Low | Automatic resume |
| 7 | **AsyncAPI spec** for StreamEventMap | Event Mesh | Low | Third-party integration readiness |
| 8 | **Phase-based progress** in topology view | Copilot Workspace | Medium | More meaningful progress tracking |
| 9 | **Webhook delivery** for key lifecycle events | Event Gateway | Medium | CI/CD and external integrations |
| 10 | **Protocol versioning header** | Vercel | Low | Forward compatibility |
| 11 | **Connection state machine** | Ably, Pusher | Low | User-visible connection status |
| 12 | **Checkpoint-resume** for container agents | Trigger.dev, Temporal | High | Container crash resilience |
| 13 | **Topic-based subscription filtering** | Event Mesh, Pusher | Medium | Bandwidth optimization |
