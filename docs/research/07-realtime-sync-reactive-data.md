# Real-Time Data Synchronization, Reactive Data Layers & Client-Side Event Consumption

**Date:** March 2026
**Current Stack:** TanStack DB 0.5.33 | Durable Streams 0.2.x (via Caddy SSE) | React 19.2.4 | SQLite (better-sqlite3) | Zod 4.3.6

---

## Current Architecture Summary

AgentPane's real-time data flow follows this pipeline:

1. **Server:** Agent SDK generates streaming events (chunks, tool calls, agent state)
2. **Persistence:** `SessionStreamService` persists to `session_events` table (DB-first), then publishes to Caddy
3. **Transport:** Caddy serves SSE at `/v1/stream/sessions/:id` via Durable Streams protocol
4. **Client:** `DurableStreamsClient` connects via `@durable-streams/client`, parses NDJSON, validates with Zod schemas
5. **Routing:** `mapRawEventToTyped()` converts raw events to typed channel events, `routeEventToCallback()` dispatches to `SessionCallbacks`
6. **State:** `useSession` hook accumulates events into React `useState` arrays (chunks capped at 5,000)
7. **Rendering:** Components subscribe via props/hooks, `useStreamParser` merges and sorts events, `useAutoScroll` handles scroll pinning

**Key files:**

- `src/lib/streams/client.ts` -- DurableStreamsClient, event schemas, reconnection logic
- `src/app/hooks/use-session-subscription.ts` -- Shared SSE with ref-counting
- `src/app/hooks/use-session.ts` -- Event accumulation into useState
- `src/lib/sessions/collections.ts` -- TanStack DB local-only collections (7 collections)
- `src/app/components/features/agent-session-view/use-stream-parser.ts` -- Event merging and line classification

**Identified bottlenecks:**

- Each `onChunk` callback triggers `setState` with full array copy (`[...prev.chunks, newChunk]`)
- `useStreamParser` re-sorts all events on every change via `useMemo` with `[chunks, toolCalls, terminal]` deps
- No virtualization -- all stream lines rendered to DOM
- No Web Worker offloading -- Zod validation runs on main thread
- No multi-tab coordination -- each tab opens its own SSE connection
- No local persistence -- page refresh loses all accumulated state

---

## 1. Electric SQL for Real-Time Sync

### Architecture

Electric SQL is a read-path sync engine that streams Postgres logical replication changes to clients via its Shape API. Shapes define partial replicas: a single table filtered by a WHERE clause with optional column selection. The protocol uses offset-based resumption identical to Durable Streams (Electric is the parent project of Durable Streams).

### Shape API

```typescript
import { ShapeStream, Shape } from '@electric-sql/client'

const stream = new ShapeStream({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: 'session_events',
    where: `session_id = $1`,
    params: { '1': sessionId },
  },
})

const shape = new Shape(stream)
shape.subscribe(({ rows }) => {
  // rows: current state of matching rows
  // Automatically updates on INSERT/UPDATE/DELETE
})
```

### Could Electric Replace SSE + TanStack DB?

**Architecture fit:**

- Electric's store-based model (write to Postgres, subscribe to shapes) aligns with AgentPane's DB-first persistence
- Agent output would INSERT into `session_events`, Electric would automatically fan out to all subscribed clients
- Eliminates the dual-write pattern (DB + Caddy publish) -- one INSERT handles both persistence and real-time delivery
- Multi-tab and multi-user sync would be automatic via shape subscriptions

**Performance characteristics:**

- Optimized WHERE clauses (literal equality like `session_id = $1`) maintain ~5,000 changes/sec regardless of shape count
- Non-optimized WHERE clauses degrade inversely with shape count (~1,400 changes/sec with 10 shapes)
- v1.1 storage engine rewrite achieved 102x faster writes and 73x faster reads
- Long-polling delivery adds ~50-200ms latency vs SSE's sub-50ms -- acceptable for agent output but noticeable for token streaming

**Critical limitation: Postgres only.**
Electric requires Postgres as the source database via logical replication. AgentPane uses SQLite (better-sqlite3). Adopting Electric would require migrating to Postgres -- which is a separate, larger decision. The dual-dialect schema (`src/db/schema/postgres/`) already exists, so migration is architecturally feasible.

### Recommendation

| Aspect | Assessment |
|--------|-----------|
| **Status** | **ASSESS (blocked on Postgres migration)** |
| **Effort** | High (requires Postgres migration first) |
| **Value** | Very high -- eliminates dual-write, automatic multi-client sync, offset-based resume for free |
| **Timeline** | Couple to Postgres migration decision. If Postgres is adopted, Electric becomes the natural sync layer |
| **Interim** | Durable Streams (same protocol, same team) provides the right primitives today |

### Strategic Note

Durable Streams was extracted from Electric as its delivery layer. The protocol is identical. AgentPane's current Durable Streams usage positions it for an eventual Electric upgrade path without client-side changes -- only the server-side publish mechanism would change from explicit `streams.publish()` to implicit Postgres INSERT.

---

## 2. LiveStore

### Architecture

LiveStore is a client-centric state management framework combining reactive SQLite with event sourcing. State is modeled as an immutable event log that materializes into a local SQLite database. UI components subscribe to reactive SQL queries that update automatically when the underlying data changes.

```typescript
// Define events (schema-validated)
export const events = {
  chunkReceived: Events.synced({
    name: 'v1.ChunkReceived',
    schema: Schema.Struct({
      id: Schema.String,
      sessionId: Schema.String,
      text: Schema.String,
      timestamp: Schema.Number,
    }),
  }),
}

// Define materializers (event -> SQL mutation)
const materializers = State.SQLite.materializers(events, {
  'v1.ChunkReceived': ({ id, sessionId, text, timestamp }) =>
    tables.chunks.insert({ id, sessionId, text, timestamp }),
})

// React component subscribes to reactive query
const chunks$ = queryDb((get) =>
  tables.chunks.where({ sessionId }).orderBy('timestamp')
)

export function StreamPanel({ sessionId }: { sessionId: string }) {
  const chunks = useQuery(chunks$)
  return <div>{chunks.map(c => <StreamLine key={c.id} chunk={c} />)}</div>
}
```

### Comparison with TanStack DB

| Feature | TanStack DB (current) | LiveStore |
|---------|----------------------|-----------|
| **Storage** | In-memory collections | SQLite (in-memory or persistent OPFS) |
| **Query language** | Collection filter/sort API | Full SQL via reactive queries |
| **Persistence** | None (lost on refresh) | SQLite persistence across sessions |
| **Sync** | Manual (SSE -> collection.insert) | Built-in event sync (Cloudflare, Electric, S2) |
| **Derived state** | useMemo over collections | SQL materialized views |
| **Maturity** | Beta (0.x), type regressions | Beta (0.3-0.4), API still evolving |
| **Bundle** | ~15KB | ~50-100KB (includes WASM SQLite) |
| **Framework** | React only | React, Solid, Vue |

### Assessment for AgentPane

**Advantages:**

- SQL queries replace manual event merging in `useStreamParser` -- a `SELECT * FROM chunks WHERE sessionId = ? UNION ALL SELECT * FROM tool_calls WHERE sessionId = ? ORDER BY timestamp` replaces 40+ lines of JavaScript sort/merge logic
- Persistent SQLite means page refresh preserves session state -- currently a pain point
- Event sourcing model aligns with AgentPane's append-only event pattern
- Built-in Electric sync provider could eventually replace the SSE layer entirely

**Concerns:**

- Still beta (0.3-0.4) with breaking changes in minor versions
- WASM SQLite adds ~500ms cold start and ~50-100KB to client bundle
- Event sourcing model adds complexity for simple append-only streams where events are immutable
- Would require rewriting all 7 TanStack DB collections + their consumers

### Recommendation

| Aspect | Assessment |
|--------|-----------|
| **Status** | **ASSESS (12-month horizon)** |
| **Effort** | High (full data layer rewrite) |
| **Value** | High -- persistence, SQL queries, built-in sync |
| **Risk** | Beta stability, WASM SQLite cold start |
| **Action** | Build a proof-of-concept with one collection (chunks) to benchmark against TanStack DB |

---

## 3. CRDT-Based Sync for Collaborative Features

### Library Comparison

| Library | Language | Bundle | Performance | Maturity | Best For |
|---------|----------|--------|-------------|----------|----------|
| **Yjs** | JavaScript | ~13KB | Fastest CRDT impl | Production (6+ years) | Text collaboration, awareness protocol |
| **Automerge** | Rust + WASM | ~250KB | Good, improving | Production (v2 stable) | JSON document sync, full history |
| **Loro** | Rust + WASM | ~200KB | Near-Yjs for text | 1.0 released, maturing | Rich text, moveable trees, version control |

### Yjs

Best ecosystem for collaborative editing. Provides awareness protocol (cursor positions, selection) out of the box. Extensive editor integrations (ProseMirror, CodeMirror, Monaco, Quill).

```typescript
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const ydoc = new Y.Doc()
const provider = new WebsocketProvider('ws://localhost:1234', 'session-room', ydoc)

// Shared agent output text
const ytext = ydoc.getText('agent-output')
ytext.observe(event => {
  // Automatically syncs across all connected clients
  renderOutput(ytext.toString())
})

// Awareness (cursor positions, who's viewing)
const awareness = provider.awareness
awareness.setLocalState({ user: { name: 'Alice', cursor: { line: 42 } } })
awareness.on('change', () => {
  const states = Array.from(awareness.getStates().values())
  updatePresenceIndicators(states)
})
```

### Loro

Rust-based, optimized for memory and CPU. Integrates the Fugue algorithm for text editing with minimal interleaving. Supports moveable trees (useful for task hierarchies), version control with shallow snapshots.

```javascript
import { LoroDoc } from 'loro-crdt'

const doc = new LoroDoc()
const list = doc.getList('events')
list.insert(0, { type: 'chunk', text: 'Hello', timestamp: Date.now() })

// Export delta for sync
const bytes = doc.export({ mode: 'update' })

// Apply on another client
const doc2 = new LoroDoc()
doc2.import(bytes)
```

### Applicability to AgentPane

**Presence/awareness (Yjs):** The existing `presenceCollection` tracks `userId`, `lastSeen`, and `cursor`. Yjs awareness protocol would replace the manual heartbeat mechanism in `useSession` (10-second polling) with sub-second updates. This is a strong fit.

**Agent output collaboration:** Agent output is append-only server-generated text. CRDTs are designed for concurrent edits from multiple writers -- this is overkill for unidirectional streaming. The overhead of maintaining CRDT metadata for append-only data is not justified.

**Collaborative code editing in agent output:** If users need to collaboratively edit agent-generated code (e.g., reviewing/modifying a plan), Yjs + CodeMirror integration would be the right choice. This is a future feature, not a current requirement.

### Recommendation

| Use Case | Library | Recommendation |
|----------|---------|---------------|
| **Presence/awareness** | Yjs awareness | **TRIAL** -- replace heartbeat polling with real-time awareness |
| **Agent output sync** | None needed | **HOLD** -- append-only, server-authoritative |
| **Collaborative editing** | Yjs + CodeMirror | **ASSESS** -- only when collaborative plan editing is scoped |
| **Full CRDT document sync** | Loro or Automerge | **HOLD** -- wrong paradigm for current architecture |

---

## 4. Optimistic Updates and Conflict Resolution

### Current State

AgentPane sends commands to agents (approve plan, cancel, send message) via REST API calls. There is no optimistic update pattern -- the UI waits for server confirmation before updating.

### React 19 `useOptimistic`

```typescript
import { useOptimistic } from 'react'

function PlanApproval({ plan, sessionId }: Props) {
  const [optimisticStatus, setOptimisticStatus] = useOptimistic(
    plan.status,
    (_current, newStatus: string) => newStatus
  )

  async function approvePlan() {
    // Immediately show "approved" in UI
    setOptimisticStatus('approved')

    try {
      await fetch(`/api/sessions/${sessionId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ planId: plan.id }),
      })
      // Server confirms -- real state update comes via SSE
    } catch (error) {
      // useOptimistic automatically reverts on action completion
      // Show error toast
      toast.error('Failed to approve plan')
    }
  }

  return (
    <Button
      onClick={approvePlan}
      disabled={optimisticStatus === 'approved'}
    >
      {optimisticStatus === 'approved' ? 'Approving...' : 'Approve Plan'}
    </Button>
  )
}
```

### Conflict Resolution for Streaming Systems

The fundamental challenge: the UI shows an optimistic state, but the server's SSE stream may deliver events that contradict it. For example:

- User clicks "Cancel Agent" -> UI shows "Cancelling..."
- SSE delivers `agent:completed` event before the cancel request reaches the server
- The agent finished before the cancel took effect

**Resolution patterns:**

1. **Version fencing:** Tag optimistic updates with a version counter. Ignore SSE events with versions older than the optimistic update. Accept events with equal or newer versions.

```typescript
type OptimisticState = {
  value: AgentStatus
  version: number
  isOptimistic: boolean
}

function reconcile(
  optimistic: OptimisticState,
  serverEvent: { status: AgentStatus; version: number }
): OptimisticState {
  if (serverEvent.version >= optimistic.version) {
    // Server state is authoritative
    return { value: serverEvent.status, version: serverEvent.version, isOptimistic: false }
  }
  // Server event is stale, keep optimistic state
  return optimistic
}
```

2. **Timeout-based revert:** If the server does not confirm within N seconds, revert the optimistic update and show an error.

3. **SSE confirmation:** The server publishes a confirmation event (e.g., `agent:cancel_confirmed`) that the client uses to transition from optimistic to confirmed state.

### Recommendation

| Pattern | Recommendation | Effort |
|---------|---------------|--------|
| **`useOptimistic` for plan approval/rejection** | **ADOPT** | Low -- 2-3 components |
| **`useOptimistic` for agent cancel** | **ADOPT** | Low -- 1 component |
| **Version-fenced reconciliation** | **TRIAL** | Medium -- needs server-side version tracking |
| **Full optimistic mutation layer** | **HOLD** | High -- not justified for current command count |

---

## 5. Client-Side Event Processing

### Web Workers for Event Processing

Currently, `mapRawEventToTyped()` runs Zod validation on the main thread for every SSE event. For high-throughput agent sessions (100+ events/sec during tool execution), this can cause jank.

**Architecture: Comlink + Worker for event processing**

```typescript
// event-processor.worker.ts
import { expose } from 'comlink'
import { mapRawEventToTyped } from './event-mapping'

const processor = {
  processEvents(rawEvents: string): TypedSessionEvent[] {
    const items = JSON.parse(rawEvents)
    const results: TypedSessionEvent[] = []
    for (const item of Array.isArray(items) ? items : [items]) {
      const typed = mapRawEventToTyped({
        type: item.type,
        data: item.data,
        timestamp: item.timestamp ?? Date.now(),
      })
      if (typed) results.push(typed)
    }
    return results
  },
}

expose(processor)
```

```typescript
// event-processor.client.ts
import { wrap } from 'comlink'
import type { Remote } from 'comlink'

let processor: Remote<typeof import('./event-processor.worker').processor>

export function getEventProcessor() {
  if (!processor) {
    const worker = new Worker(
      new URL('./event-processor.worker.ts', import.meta.url),
      { type: 'module' }
    )
    processor = wrap(worker)
  }
  return processor
}
```

**Comlink characteristics:**

- Bundle: 1.1KB gzipped
- Full TypeScript support via `Remote<T>` type
- Structured cloning for data transfer (small overhead for event objects)
- Works with SharedWorker for multi-tab scenarios

### Streaming JSON Parser

For very large events (e.g., tool results with full file contents), `@streamparser/json` could process incrementally:

```typescript
import { JSONParser } from '@streamparser/json'

const parser = new JSONParser()
parser.onValue = ({ value, key, parent }) => {
  if (key === 'text') {
    // Process text chunk immediately without waiting for full JSON
    dispatchChunk(value as string)
  }
}

// Feed chunks from SSE
eventSource.onmessage = (e) => {
  parser.write(e.data)
}
```

**Performance note:** Built-in `JSON.parse` is faster for complete documents. Streaming parsers provide value only when partial results are needed or documents exceed memory limits. AgentPane events are typically <10KB each -- streaming parse is not justified for individual events. However, for catch-up responses (historical event arrays), streaming parse could avoid blocking the main thread.

### SharedArrayBuffer

SharedArrayBuffer enables zero-copy data sharing between main thread and workers. However, it requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` HTTP headers, which can break third-party embeds. Not recommended unless event throughput exceeds 10,000 events/sec, which is well beyond AgentPane's current ceiling.

### Recommendation

| Technology | Recommendation | Threshold |
|-----------|---------------|-----------|
| **Comlink + Worker** | **TRIAL** | Profile first; adopt if main thread jank >16ms during streaming |
| **@streamparser/json** | **HOLD** | Only needed for multi-MB catch-up responses |
| **SharedArrayBuffer** | **HOLD** | Not justified at current event volumes |

---

## 6. IndexedDB for Event Persistence

### Problem

Page refresh loses all accumulated session state (chunks, tool calls, agent state). Users must wait for the full catch-up response from the server. For long-running sessions with thousands of events, this creates a noticeable delay.

### Storage Technology Comparison

| Technology | Init Time | Write Latency | Bulk Write (200 docs) | Read Latency | Storage Limit | Browser Support |
|-----------|-----------|---------------|----------------------|-------------|---------------|----------------|
| **IndexedDB** | 46ms | 0.17ms | 13.4ms | 0.10ms | ~80% disk | All modern |
| **OPFS Main Thread** | 23ms | 1.46ms | 280ms | 1.28ms | ~80% disk | Chrome 108+, Safari 16.4+, FF 111+ |
| **OPFS WebWorker** | 27ms | 1.54ms | 104ms | 1.41ms | ~80% disk | Same as above |
| **WASM SQLite (memory)** | 504ms | 0.17ms | 19.1ms | 0.45ms | ~80% disk | All modern |
| **WASM SQLite (IndexedDB)** | 535ms | 3.17ms | 37.1ms | 2.93ms | ~80% disk | All modern |

### Library Comparison

| Library | Approach | Bundle | Reactivity | Best For |
|---------|----------|--------|-----------|----------|
| **Dexie.js** | IndexedDB wrapper | ~24KB | `liveQuery()` with cross-tab reactivity | Simple key-value + indexed queries |
| **wa-sqlite (OPFSCoopSyncVFS)** | WASM SQLite + OPFS | ~300KB | None built-in | Large datasets (1GB+), SQL queries |
| **sql.js** | WASM SQLite + memory | ~500KB | None built-in | In-memory SQL, no persistence |
| **PGlite** | WASM Postgres | ~3MB | Live queries | Postgres compatibility |

### Recommended Architecture: Dexie.js

For AgentPane's use case (persisting <100K events per session), Dexie.js provides the best tradeoff:

```typescript
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

class SessionCache extends Dexie {
  chunks!: Dexie.Table<ChunkEvent, string>
  toolCalls!: Dexie.Table<ToolCallEvent, string>
  agentState!: Dexie.Table<AgentStateEvent, string>

  constructor() {
    super('agentpane-sessions')
    this.version(1).stores({
      chunks: 'id, sessionId, timestamp',
      toolCalls: 'id, sessionId, timestamp',
      agentState: '[sessionId+agentId], sessionId',
    })
  }
}

const cache = new SessionCache()

// On SSE event: persist to IndexedDB
async function onChunkEvent(chunk: ChunkEvent) {
  await cache.chunks.put(chunk)
}

// On page load: restore from cache
function useSessionChunks(sessionId: string) {
  return useLiveQuery(
    () => cache.chunks.where('sessionId').equals(sessionId).sortBy('timestamp'),
    [sessionId]
  )
}

// On session cleanup: clear old data
async function clearSessionCache(sessionId: string) {
  await Promise.all([
    cache.chunks.where('sessionId').equals(sessionId).delete(),
    cache.toolCalls.where('sessionId').equals(sessionId).delete(),
    cache.agentState.where('sessionId').equals(sessionId).delete(),
  ])
}
```

**Advantages:**

- 13ms for 200 event writes (fast enough for streaming batches)
- Cross-tab reactivity via `liveQuery()` -- changes in one tab reflected in others
- No WASM cold start (46ms init vs 504ms for SQLite WASM)
- `navigator.storage.persist()` prevents eviction

**Caveats:**

- IndexedDB performance degrades above ~100MB -- prune old sessions
- Not suitable for SQL queries -- stick to indexed lookups
- Safari incognito has restricted storage quotas

### Cache Invalidation Strategy

```typescript
// Hybrid approach: IndexedDB cache + server offset verification
async function hydrateSession(sessionId: string): Promise<ChunkEvent[]> {
  // 1. Load from IndexedDB cache
  const cached = await cache.chunks.where('sessionId').equals(sessionId).sortBy('timestamp')
  const lastOffset = cached.length > 0 ? cached[cached.length - 1].offset : -1

  // 2. Fetch only newer events from server
  const response = await fetch(`/api/sessions/${sessionId}/events?afterOffset=${lastOffset}`)
  const { data: newEvents } = await response.json()

  // 3. Merge into cache
  if (newEvents.length > 0) {
    await cache.chunks.bulkPut(newEvents)
  }

  return [...cached, ...newEvents]
}
```

### Recommendation

| Technology | Recommendation | Rationale |
|-----------|---------------|-----------|
| **Dexie.js** | **TRIAL** | Best fit for indexed event persistence with cross-tab reactivity |
| **wa-sqlite (OPFS)** | **HOLD** | Overkill unless SQL queries needed client-side |
| **OPFS direct** | **HOLD** | Raw file API, no query support |
| **Cache API** | **HOLD** | Designed for HTTP response caching, wrong abstraction |

---

## 7. Reactive Primitives for Streaming Data

### Comparison for "stream of events that multiple components subscribe to with different views"

| Primitive | Bundle | Subscription Model | Derived State | Streaming Fit | Framework |
|-----------|--------|-------------------|---------------|---------------|-----------|
| **TanStack DB collections** (current) | ~15KB | `useLiveQuery` | Collection filter/sort | Good -- designed for reactive collections | React |
| **Zustand** | ~2KB | `useStore` with selectors | Derived selectors | Good -- fine-grained selectors prevent re-renders | React |
| **Jotai** | ~3KB | Atomic `useAtom` | `atom` derivations | Excellent -- atomic updates, no array copying | React |
| **Nanostores** | 0.3KB | `useStore` | Computed stores | Good -- framework agnostic, minimal | Any |
| **RxJS** | ~30KB | `Observable.subscribe` | `pipe` operators | Excellent -- designed for streams | Any |
| **`useSyncExternalStore`** | 0KB (built-in) | `subscribe` + `getSnapshot` | Manual | Good -- zero dependency, React-native | React |
| **Solid.js signals** | N/A | Automatic tracking | `createMemo` | Best (fine-grained) | Solid only |

### Detailed Analysis

**`useSyncExternalStore` (fallback for TanStack DB):**

This is the lowest-cost alternative to TanStack DB. It provides concurrent-mode-safe subscriptions to external stores with zero dependencies:

```typescript
import { useSyncExternalStore } from 'react'

type EventStore<T> = {
  items: T[]
  listeners: Set<() => void>
  push(item: T): void
  subscribe(cb: () => void): () => void
  getSnapshot(): T[]
}

function createEventStore<T>(): EventStore<T> {
  const store: EventStore<T> = {
    items: [],
    listeners: new Set(),
    push(item: T) {
      store.items = [...store.items, item]
      store.listeners.forEach(cb => cb())
    },
    subscribe(cb) {
      store.listeners.add(cb)
      return () => store.listeners.delete(cb)
    },
    getSnapshot() {
      return store.items
    },
  }
  return store
}

// Create stores
const chunkStore = createEventStore<ChunkEvent>()
const toolStore = createEventStore<ToolCallEvent>()

// Use in components
function StreamPanel({ sessionId }: { sessionId: string }) {
  const chunks = useSyncExternalStore(
    chunkStore.subscribe,
    chunkStore.getSnapshot,
    () => [] // server snapshot
  )
  return <div>{chunks.map(c => <StreamLine key={c.id} chunk={c} />)}</div>
}
```

**Jotai (best atomic primitive for streaming):**

Jotai's atomic model avoids the array-copy problem. Each event can be its own atom, and derived atoms compute views without re-rendering unrelated components:

```typescript
import { atom, useAtomValue } from 'jotai'

// Base atoms (written by SSE handler)
const chunksAtom = atom<ChunkEvent[]>([])
const toolCallsAtom = atom<ToolCallEvent[]>([])
const agentStateAtom = atom<AgentStateEvent | null>(null)

// Derived atom: merged timeline (replaces useStreamParser)
const timelineAtom = atom((get) => {
  const chunks = get(chunksAtom)
  const tools = get(toolCallsAtom)
  return [...chunks, ...tools]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(classifyLine)
})

// Derived atom: agent progress percentage
const progressAtom = atom((get) => {
  const state = get(agentStateAtom)
  return state?.progress ?? 0
})

// Components only re-render when their specific atom changes
function ProgressBar() {
  const progress = useAtomValue(progressAtom)
  return <div style={{ width: `${progress}%` }} />
}
```

**Zustand (recommended for shared UI state):**

Already in TRIAL status per existing research. For streaming data specifically, Zustand's selector pattern prevents unnecessary re-renders:

```typescript
import { create } from 'zustand'

interface SessionStore {
  chunks: ChunkEvent[]
  toolCalls: ToolCallEvent[]
  agentState: AgentStateEvent | null
  addChunk: (chunk: ChunkEvent) => void
  updateToolCall: (tool: ToolCallEvent) => void
  setAgentState: (state: AgentStateEvent | null) => void
}

const useSessionStore = create<SessionStore>((set) => ({
  chunks: [],
  toolCalls: [],
  agentState: null,
  addChunk: (chunk) => set((s) => ({ chunks: [...s.chunks, chunk] })),
  updateToolCall: (tool) => set((s) => {
    const idx = s.toolCalls.findIndex(t => t.id === tool.id)
    if (idx >= 0) {
      const updated = [...s.toolCalls]
      updated[idx] = { ...updated[idx], ...tool }
      return { toolCalls: updated }
    }
    return { toolCalls: [...s.toolCalls, tool] }
  }),
  setAgentState: (state) => set({ agentState: state }),
}))

// Selective subscription -- only re-renders when agentState changes
function AgentStatus() {
  const status = useSessionStore(s => s.agentState?.status)
  return <Badge>{status ?? 'idle'}</Badge>
}
```

### Recommendation

| Primitive | Recommendation | Use Case |
|-----------|---------------|----------|
| **TanStack DB** (current) | **KEEP** (short-term) | Already working, isolated to ~9 files |
| **`useSyncExternalStore`** | **ADOPT** (as TanStack DB fallback) | Document as contingency plan per existing research |
| **Jotai** | **ASSESS** | Best atomic model for streaming, but requires full rewrite |
| **Zustand** | **TRIAL** (per existing research) | Good for shared UI state, not optimal for high-frequency streams |
| **RxJS** | **HOLD** | 30KB bundle, operator complexity |
| **Nanostores** | **HOLD** | Too low-level, no React-specific optimizations |

---

## 8. Event Aggregation and Derived State

### Current Problem

The UI needs derived state from raw events:

- **Agent status** -- latest `state:update` event
- **Progress percentage** -- from agent state events
- **File change summary** -- aggregated from `container-agent:file_changed` events
- **Cost running total** -- accumulated from token counts across turns
- **Tool execution timeline** -- merged/sorted chunks + tool calls + terminal events

Currently, `useStreamParser` recomputes a full merge-sort of all events on every change. For 5,000 chunks + 200 tool calls + 100 terminal events, this is ~5,300 items sorted on every new chunk.

### Incremental Computation Patterns

**Pattern 1: Append-only fold (no re-sort needed)**

Agent events are naturally ordered by timestamp (they arrive in order from SSE). The merge-sort in `useStreamParser` is unnecessary if we maintain a single sorted timeline:

```typescript
// Instead of re-sorting on every change, maintain a single ordered list
function useIncrementalTimeline(
  chunks: ChunkEvent[],
  toolCalls: ToolCallEvent[],
  terminal: TerminalEvent[]
) {
  const timelineRef = useRef<StreamLine[]>([])
  const prevLengths = useRef({ chunks: 0, tools: 0, terminal: 0 })

  return useMemo(() => {
    // Only process NEW events since last render
    const newChunks = chunks.slice(prevLengths.current.chunks)
    const newTools = toolCalls.slice(prevLengths.current.tools)
    const newTerminal = terminal.slice(prevLengths.current.terminal)

    // Classify and append (already in timestamp order)
    const newLines: StreamLine[] = [
      ...newChunks.map(classifyChunk),
      ...newTools.map(classifyTool),
      ...newTerminal.map(classifyTerminal),
    ].sort((a, b) => a.timestamp - b.timestamp)

    timelineRef.current = [...timelineRef.current, ...newLines]
    prevLengths.current = {
      chunks: chunks.length,
      tools: toolCalls.length,
      terminal: terminal.length,
    }

    return timelineRef.current
  }, [chunks.length, toolCalls.length, terminal.length])
}
```

**Pattern 2: Running aggregates (reducer pattern)**

For derived state that summarizes events, use a fold/reduce that processes events incrementally:

```typescript
type SessionSummary = {
  totalChunks: number
  totalTokens: number
  fileChanges: Map<string, { action: string; additions: number; deletions: number }>
  toolUsageCounts: Map<string, number>
  lastActivity: number
}

function sessionSummaryReducer(
  summary: SessionSummary,
  event: TypedSessionEvent
): SessionSummary {
  switch (event.channel) {
    case 'chunks':
      return {
        ...summary,
        totalChunks: summary.totalChunks + 1,
        totalTokens: summary.totalTokens + event.data.text.length,
        lastActivity: event.data.timestamp,
      }
    case 'containerAgent:fileChanged':
      const changes = new Map(summary.fileChanges)
      changes.set(event.data.path, {
        action: event.data.action,
        additions: event.data.additions ?? 0,
        deletions: event.data.deletions ?? 0,
      })
      return { ...summary, fileChanges: changes, lastActivity: event.data.timestamp }
    case 'toolCalls':
      const tools = new Map(summary.toolUsageCounts)
      tools.set(event.data.tool, (tools.get(event.data.tool) ?? 0) + 1)
      return { ...summary, toolUsageCounts: tools, lastActivity: event.data.timestamp }
    default:
      return summary
  }
}
```

**Pattern 3: Memoized selectors (Zustand/Jotai pattern)**

Compute derived values lazily with referential equality checks:

```typescript
// Zustand selector with shallow comparison
const fileChangeSummary = useSessionStore(
  (s) => {
    const changes = s.toolCalls
      .filter(t => t.tool === 'Write' || t.tool === 'Edit')
      .map(t => ({ path: (t.input as any)?.file_path, tool: t.tool }))
    return changes
  },
  shallow // only re-render if the array contents change
)
```

### Recommendation

| Pattern | Recommendation | Impact |
|---------|---------------|--------|
| **Append-only timeline** | **ADOPT** | Eliminates O(n log n) re-sort on every event |
| **Running aggregate reducer** | **ADOPT** | O(1) per event for summary stats |
| **Memoized selectors** | **ADOPT** (with Zustand or Jotai) | Prevents cascade re-renders |
| **Client-side materialized views** | **ASSESS** (only with LiveStore) | Full SQL views require SQLite client |

---

## 9. Connection Lifecycle Management

### Current Implementation

`DurableStreamsClient` already implements:

- Exponential backoff: `delay = Math.min(2000 * 2^reconnectCount, 30000)` (line 767)
- Max reconnect attempts: 8 (`MAX_RECONNECT_ATTEMPTS`)
- Fatal error detection: `FATAL_ERROR_CODES` array prevents retrying on NOT_FOUND, UNAUTHORIZED, etc.
- Pre-connection NOT_FOUND tolerance: allows retries when stream hasn't been created yet

### Missing: Tab Visibility API Integration

When a tab is hidden (user switches tabs), SSE connections should pause to save bandwidth and battery. iOS Safari silently kills SSE connections in background tabs without firing error events.

```typescript
// Tab visibility integration for DurableStreamsClient
function createVisibilityAwareSubscription(
  sessionId: string,
  callbacks: SessionCallbacks
): Subscription {
  let subscription: Subscription | null = null
  let wasConnected = false

  function handleVisibilityChange() {
    if (document.hidden) {
      // Tab hidden: pause connection
      wasConnected = subscription?.getState() === 'connected'
      subscription?.unsubscribe()
      subscription = null
    } else if (wasConnected) {
      // Tab visible: reconnect from last offset
      subscription = subscribeToSession(sessionId, callbacks)
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  subscription = subscribeToSession(sessionId, callbacks)

  return {
    unsubscribe() {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      subscription?.unsubscribe()
    },
    getState: () => subscription?.getState() ?? 'disconnected',
    getLastOffset: () => subscription?.getLastOffset() ?? 0,
  }
}
```

### Missing: Multi-Tab Coordination

Currently, each browser tab opens its own SSE connection. With SharedWorker + BroadcastChannel, a single connection can serve all tabs:

```typescript
// shared-stream.worker.ts (SharedWorker)
const connections = new Set<MessagePort>()
const broadcast = new BroadcastChannel('agentpane-stream')
let activeStreams = new Map<string, EventSource>()

self.addEventListener('connect', (e: MessageEvent) => {
  const port = e.ports[0]
  connections.add(port)

  port.addEventListener('message', (msg) => {
    const { action, sessionId } = msg.data

    if (action === 'subscribe' && !activeStreams.has(sessionId)) {
      // Only one SSE connection per session across all tabs
      const source = new EventSource(`/v1/stream/sessions/${sessionId}`)
      source.onmessage = (event) => {
        broadcast.postMessage({ sessionId, data: event.data })
      }
      activeStreams.set(sessionId, source)
    }

    if (action === 'unsubscribe') {
      connections.delete(port)
      if (connections.size === 0) {
        // Last tab closed -- clean up
        activeStreams.get(sessionId)?.close()
        activeStreams.delete(sessionId)
      }
    }
  })

  port.start()
})
```

```typescript
// Client-side consumption
const broadcast = new BroadcastChannel('agentpane-stream')
const worker = new SharedWorker('/shared-stream.worker.js')

worker.port.postMessage({ action: 'subscribe', sessionId })

broadcast.addEventListener('message', (event) => {
  if (event.data.sessionId === sessionId) {
    processEvent(event.data.data)
  }
})
```

### Missing: Jitter in Backoff

The current backoff (`2000 * 2^reconnectCount`) lacks jitter, risking thundering herd when multiple clients reconnect simultaneously:

```typescript
// Add jitter to existing backoff calculation
const baseDelay = Math.min(2000 * 2 ** reconnectCount, 30000)
const jitter = Math.random() * baseDelay * 0.5 // 0-50% jitter
const delay = baseDelay + jitter
```

### Recommendation

| Feature | Recommendation | Effort |
|---------|---------------|--------|
| **Tab visibility pause** | **ADOPT** | Low -- wrap existing subscription |
| **Backoff jitter** | **ADOPT** | Minimal -- one line change |
| **SharedWorker multi-tab** | **TRIAL** | Medium -- requires worker setup, BroadcastChannel |
| **Connection pooling** | **HOLD** | useSessionSubscription already ref-counts within a tab |

---

## 10. Streaming Performance Optimization

### React 18+ Automatic Batching

React 18+ automatically batches state updates inside promises, setTimeout, and native event handlers. However, updates from SSE `onmessage` callbacks may not be batched if they arrive in separate microtasks. The current `useSession` hook calls `setState` for every individual event -- React may batch some of these, but it is not guaranteed for rapid sequential callbacks.

### requestAnimationFrame Throttling Pattern

The most impactful optimization for AgentPane's streaming panels. Buffer events in a mutable ref and flush once per animation frame:

```typescript
function useThrottledEventStream(sessionId: string) {
  const bufferRef = useRef<TypedSessionEvent[]>([])
  const [events, setEvents] = useState<TypedSessionEvent[]>([])
  const rafRef = useRef<number | null>(null)

  // SSE callback: write to buffer (no React state update)
  const onEvent = useCallback((event: TypedSessionEvent) => {
    bufferRef.current.push(event)

    // Schedule flush on next animation frame (deduped)
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        const batch = bufferRef.current
        bufferRef.current = []
        rafRef.current = null

        // Single setState for entire batch
        setEvents(prev => [...prev, ...batch])
      })
    }
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { events, onEvent }
}
```

**Performance impact:**

- 60Hz display: max 60 state updates/sec instead of potentially hundreds
- 120Hz display: max 120 state updates/sec
- Each batch may contain 1-20 events, reducing React reconciliation passes by 10-20x

### Virtual Scrolling for Event Lists

The stream panel renders all `StreamLine` elements to the DOM. For 5,000+ events, this creates thousands of DOM nodes. `@tanstack/react-virtual` keeps DOM node count constant:

```typescript
import { useVirtualizer } from '@tanstack/react-virtual'

function VirtualizedStreamPanel({ lines }: { lines: StreamLine[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24, // estimated line height
    overscan: 20, // render 20 extra items above/below viewport
  })

  // Auto-scroll: when new items added and user is at bottom
  useEffect(() => {
    if (isAtBottom) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end' })
    }
  }, [lines.length])

  return (
    <div ref={parentRef} style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <StreamLine
            key={item.key}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: item.start,
              width: '100%',
            }}
            line={lines[item.index]}
          />
        ))}
      </div>
    </div>
  )
}
```

**DOM reduction:** 5,000 lines -> ~60 DOM nodes (viewport height / line height + overscan)

### `startTransition` for Non-Urgent Updates

Agent state changes (status, turn count, progress) are important but not urgent relative to streaming text. Wrap them in `startTransition` to avoid blocking chunk rendering:

```typescript
import { startTransition } from 'react'

// In SSE event handler:
onAgentState: (event) => {
  startTransition(() => {
    setState(prev => ({ ...prev, agentState: event.data }))
  })
}
```

### Priority Queue Pattern

Separate events into urgent (text chunks -- user is reading) and non-urgent (tool metadata, presence updates, progress):

```typescript
type Priority = 'urgent' | 'normal' | 'low'

function getEventPriority(event: TypedSessionEvent): Priority {
  switch (event.channel) {
    case 'chunks':
    case 'containerAgent:token':
      return 'urgent'       // Text the user is reading
    case 'toolCalls':
    case 'agentState':
      return 'normal'       // Status updates
    case 'presence':
    case 'topology:agentProgress':
      return 'low'          // Background info
    default:
      return 'normal'
  }
}

// Flush urgent events immediately, batch normal/low
function prioritizedFlush(buffer: TypedSessionEvent[]) {
  const urgent = buffer.filter(e => getEventPriority(e) === 'urgent')
  const rest = buffer.filter(e => getEventPriority(e) !== 'urgent')

  // Urgent: immediate setState
  if (urgent.length > 0) {
    dispatchUrgentEvents(urgent)
  }

  // Normal/low: wrap in startTransition
  if (rest.length > 0) {
    startTransition(() => {
      dispatchNonUrgentEvents(rest)
    })
  }
}
```

### `React.memo` with Stable Keys

Each `StreamLine` should be memoized to prevent re-rendering when sibling lines change:

```typescript
const MemoizedStreamLine = React.memo(
  function StreamLine({ line }: { line: StreamLine }) {
    return <div className={lineStyles[line.type]}>{line.content}</div>
  },
  (prev, next) => prev.line.id === next.line.id && prev.line.content === next.line.content
)
```

### CSS `content-visibility: auto`

Already in use. This is the correct CSS-level optimization for off-screen content. Combines well with virtual scrolling (belt-and-suspenders -- virtualization handles DOM node count, content-visibility handles paint cost for edge cases).

### Recommendation Summary

| Optimization | Recommendation | Impact | Effort |
|-------------|---------------|--------|--------|
| **rAF buffering** | **ADOPT** | 10-20x fewer React reconciliations | Low |
| **Virtual scrolling** | **ADOPT** | 100x DOM reduction for long sessions | Low (TanStack Virtual) |
| **`startTransition` for metadata** | **ADOPT** | Prevents chunk rendering jank | Minimal |
| **`React.memo` for StreamLine** | **ADOPT** | Prevents cascade re-renders | Minimal |
| **Priority queue** | **TRIAL** | Further reduces jank for urgent content | Low |
| **Append-only timeline** (from section 8) | **ADOPT** | Eliminates O(n log n) re-sort | Low |

---

## Consolidated Priority Actions

### Immediate (Low Effort, High Impact)

| # | Action | Category | Effort |
|---|--------|----------|--------|
| 1 | **rAF buffering** -- buffer SSE events in mutable ref, flush per frame | Performance | Low |
| 2 | **Append-only timeline** -- replace useStreamParser's full re-sort with incremental append | Derived State | Low |
| 3 | **`startTransition`** -- wrap non-urgent state updates (agent state, presence, progress) | Performance | Minimal |
| 4 | **`React.memo`** -- memoize StreamLine component with stable keys | Performance | Minimal |
| 5 | **Backoff jitter** -- add jitter to DurableStreamsClient reconnection delay | Connection | Minimal |
| 6 | **Tab visibility pause** -- pause SSE when tab is hidden | Connection | Low |
| 7 | **`useOptimistic`** -- optimistic plan approval/rejection/cancel | UX | Low |

### Short-Term (Medium Effort, High Impact)

| # | Action | Category | Effort |
|---|--------|----------|--------|
| 8 | **Virtual scrolling** -- adopt @tanstack/react-virtual for stream panels | Performance | Low-Medium |
| 9 | **Running aggregate reducer** -- incremental session summary computation | Derived State | Low-Medium |
| 10 | **Dexie.js event cache** -- persist events to IndexedDB for page reload resilience | Persistence | Medium |

### Medium-Term (Trial/Assess)

| # | Action | Category | Effort |
|---|--------|----------|--------|
| 11 | **Comlink + Worker** -- offload event processing from main thread | Performance | Medium |
| 12 | **SharedWorker multi-tab** -- share SSE connections across tabs | Connection | Medium |
| 13 | **Yjs awareness** -- replace presence heartbeat polling | Collaboration | Medium |
| 14 | **Priority queue rendering** -- urgent vs non-urgent event separation | Performance | Low |

### Long-Term (Assess/Hold)

| # | Action | Category | Effort |
|---|--------|----------|--------|
| 15 | **LiveStore proof-of-concept** -- benchmark reactive SQLite vs TanStack DB | Data Layer | High |
| 16 | **Electric SQL** -- automatic DB-to-client sync (requires Postgres migration) | Sync | High |
| 17 | **Loro/Yjs CRDT** -- collaborative plan editing | Collaboration | High |
| 18 | **`useSyncExternalStore` fallback** -- document TanStack DB contingency | Risk | Low |

---

## Technology Radar Update

### Adopt

- rAF event buffering, append-only timeline, `startTransition`, `React.memo` for streaming, backoff jitter, tab visibility pause, `useOptimistic`

### Trial

- @tanstack/react-virtual (stream panels), Dexie.js (event cache), SharedWorker multi-tab, Yjs awareness, priority queue rendering, Comlink + Worker

### Assess

- LiveStore, Electric SQL (post-Postgres), Jotai (atomic streaming), Loro (collaborative editing)

### Hold

- RxJS, Nanostores, @streamparser/json, SharedArrayBuffer, wa-sqlite/OPFS, CRDT agent output sync, full optimistic mutation layer

---

## Sources

- [Electric SQL Shapes Guide](https://electric-sql.com/docs/guides/shapes)
- [Electric SQL: Building AI Apps on Sync](https://electric-sql.com/blog/2025/04/09/building-ai-apps-on-sync)
- [Electric SQL v1.1 Release](https://electric-sql.com/blog/2025/08/13/electricsql-v1.1-released)
- [Announcing Durable Streams](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams)
- [LiveStore Documentation](https://docs.livestore.dev/evaluation/how-livestore-works/)
- [LiveStore Homepage](https://livestore.dev/)
- [LiveStore GitHub](https://github.com/livestorejs/livestore)
- [Loro CRDT GitHub](https://github.com/loro-dev/loro)
- [Yjs Documentation](https://docs.yjs.dev)
- [Yjs vs Loro Discussion](https://discuss.yjs.dev/t/yjs-vs-loro-new-crdt-lib/2567)
- [Best CRDT Libraries 2025](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)
- [React useOptimistic Documentation](https://react.dev/reference/react/useOptimistic)
- [Comlink GitHub](https://github.com/GoogleChromeLabs/comlink)
- [@streamparser/json npm](https://www.npmjs.com/package/@streamparser/json)
- [SQLite Persistence on the Web (PowerSync)](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- [Browser Storage Comparison (RxDB)](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)
- [Offline-First Frontend Apps 2025](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)
- [Dexie.js liveQuery](https://dexie.org/docs/dexie-react-hooks/useLiveQuery())
- [React Automatic Batching](https://github.com/reactwg/react-18/discussions/21)
- [Streaming Backends & React: Re-render Chaos](https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/)
- [TanStack Virtual Examples](https://tanstack.com/virtual/latest/docs/framework/react/examples)
- [useSyncExternalStore Documentation](https://react.dev/reference/react/useSyncExternalStore)
- [SharedWorker SSE Pattern](https://dev.to/ayushgp/scaling-websocket-connections-using-shared-workers-14mj)
- [BroadcastChannel API](https://developer.chrome.com/blog/broadcastchannel)
- [SSE Exponential Backoff with Jitter](https://medium.com/andersen-it-community/how-i-stopped-503-spam-in-sse-fetch-event-source-exponential-backoff-jitter-14f36b357e6d)
- [State Management in 2025](https://dev.to/hijazi313/state-management-in-2025-when-to-use-context-redux-zustand-or-jotai-2d2k)
- [Nanostores vs Zustand vs Jotai (npm trends)](https://npmtrends.com/jotai-vs-nanostores-vs-recoil-vs-zustand)
