# Streaming Protocols, Transport, Compression & Observability Research

**Date:** March 2026
**Current Stack:** SSE via Durable Streams | Caddy (durable_streams plugin + LMDB) | IdempotentProducer with batching | ChunkBatcher | EventSource API | 3 separate SSE systems

---

## 1. SSE vs WebSocket vs WebTransport vs gRPC-Web

### Protocol Comparison

| Dimension | SSE | WebSocket | WebTransport | gRPC-Web |
|---|---|---|---|---|
| Direction | Server-to-client | Full-duplex | Full-duplex + unidirectional | Client/server streaming |
| Transport | HTTP/1.1 or HTTP/2 | TCP (upgraded from HTTP) | HTTP/3 / QUIC (UDP) | HTTP/1.1 or HTTP/2 |
| Reconnection | Built-in (`Last-Event-ID`) | Manual | Manual (0-RTT resumes fast) | Manual |
| HTTP/2 multiplexing | Yes — 100 concurrent streams | No — escapes HTTP/2 | Native — per-stream flow control | Yes |
| Proxy compat | Excellent | Good (needs upgrade support) | Poor (requires HTTP/3 end-to-end) | Requires envoy proxy |
| Browser limits | HTTP/1.1: 6/domain. HTTP/2: ~100 streams | 6/domain (separate TCP) | No per-domain limits | Same as HTTP |
| Backpressure | None native | TCP flow control | Per-stream QUIC flow control | HTTP/2 flow control |
| Safari support | Universal | Universal | **NOT SUPPORTED** | Via library |

### Recommendation: Stay with SSE

1. **Directionality match** — Agent execution is server-to-client. Client-to-server is discrete HTTP actions (approve, cancel)
2. **HTTP/2 eliminates connection limits** — Caddy provides HTTP/2; each SSE stream shares one TCP connection (100 stream limit covers team mode's 5 agents easily)
3. **Built-in reconnection** — `Last-Event-ID` + Durable Streams offset tracking provides reliable delivery. WebSocket would require building this from scratch
4. **Proxy compatibility** — Caddy, Cloudflare, enterprise proxies all handle SSE transparently

**Where WebSocket adds value:** Interactive terminal I/O, collaborative editing. Hono supports `upgradeWebSocket()` — add alongside SSE when needed.

---

## 2. WebTransport Assessment

### Browser Support (March 2026)

| Browser | Status |
|---------|--------|
| Chrome/Edge | Stable since Chrome 97 |
| Firefox | Stable since Firefox 115 |
| **Safari** | **NOT SUPPORTED** (behind flag in iOS 18 only) |

### Server Support

| Runtime | WebTransport Status |
|---------|-------------------|
| **Bun** | NOT supported (open issue #13656) |
| **Caddy** | NOT available (Go stdlib limitations) |
| **Node.js** | Community lib only, not production-ready |
| **Deno** | NOT supported |

### Verdict: NOT production-ready

Neither Bun nor Caddy support it. Safari absence means ~20% of users need a fallback. IETF spec still a draft. HTTP/2 SSE multiplexing already provides the key benefits.

**Revisit:** Late 2027 when Safari, Bun HTTP/3, and IETF ratification may land.

---

## 3. Streaming Multiplexing

### Current Architecture

Two levels already implemented:

1. **Client-side fan-out**: `sharedSubscriptions` Map — one SSE connection per session ID, fan-out to React component subscribers
2. **HTTP/2 stream-level**: Caddy on port 3000 multiplexes SSE connections over single TCP

### Team Mode Connection Analysis

| Strategy | HTTP/2 streams | Verdict |
|---|---|---|
| 1 SSE per agent (current) | 5 out of 100 | Acceptable |
| 1 multiplexed codespace stream | 1 | Optimal if scaling to 10+ agents |

### Recommendation

- **Now:** Current architecture is adequate under HTTP/2
- **10+ agents:** Consolidate to codespace-scoped stream (`/v1/stream/codespaces/{codespaceId}`). Events already carry `agentId`/`taskId`/`sessionId`. Client fan-out routes to correct UI components

---

## 4. Backpressure and Flow Control

### Current: No Backpressure

- Server: `ChunkBatcher.addDelta()` immediately publishes to Caddy SSE, then buffers for SQLite
- Caddy/LMDB: Accepts writes until disk full
- Client: `EventSource` buffers in memory silently

### Recommended Strategies

**Event coalescing (low complexity, recommended):**

- `topology:agent_progress`: Only send latest per agent, not every intermediate
- `chunk` events: If Caddy write queue full, merge consecutive chunks
- Tool call pairs: Batch rapid `tool:start`/`tool:result` pairs

**Send buffer monitoring (medium complexity):**

- Track IdempotentProducer in-flight count (already configured as `maxInFlight: 5`)
- Warn log when sustained at capacity

**Client acknowledgment (high complexity, not recommended now):**

- Periodic client POST reporting last-processed offset
- Unnecessary at current event volumes (hundreds/sec max)

---

## 5. Binary Serialization

### For Agent Events: Stay with JSON

Agent events are text-dominant:

- `chunk` events: 100-2000 chars of code/prose
- `tool:result` events: 1-10KB of file contents, diffs
- JSON overhead for 500-byte text chunk: ~2-3% (field names + delimiters)

Binary format savings (9-34%) don't justify:

- Schema management (Protobuf .proto files)
- Build pipeline changes (code generation)
- Debugging difficulty (not human-readable in DevTools)
- Reworking existing Zod validation

**Where binary matters:** File transfer or large binary artifacts. Not event metadata.

---

## 6. Streaming Compression

### Algorithm Comparison

| Algorithm | Ratio vs gzip | Speed | Browser Support |
|---|---|---|---|
| **gzip** | Baseline | Moderate | Universal |
| **Brotli** | 2-3x better | Slower (tunable via quality) | Universal |
| **zstd** | 11% better than gzip | 42% faster than Brotli | **No Safari** |

### Why Brotli Excels for SSE

Brotli was designed for streaming. A continuous SSE stream condenses many events into one large data set — Brotli references patterns from events sent minutes ago. Quality 4 is the sweet spot: near-gzip speed with 2x better compression.

### Expected Ratios for Agent Events

| Content type | Uncompressed avg | gzip | Brotli (q=4) |
|---|---|---|---|
| Text chunks | 500B/event | 3:1 | 4-5:1 |
| Tool call events | 200B/event | 2.5:1 | 3.5:1 |
| Large diffs | 5KB/event | 4:1 | 6:1 |
| 30-min session total | ~2MB | ~500KB | ~350KB |

### Recommendation: Enable Brotli on Caddy SSE

**Zero code change.** Add to Caddyfile:

```caddyfile
/v1/stream/* {
    encode {
        br { quality 4 }
        gzip
    }
}
```

Browser transparently decompresses. **Do NOT use zstd** — Safari doesn't support `Content-Encoding: zstd`.

---

## 7. Edge Streaming

### Platform Assessment

| Platform | SSE Duration | Limitation | Recommendation |
|---|---|---|---|
| Cloudflare Workers | Unlimited | Buffering issues reported | Possible for relay |
| Cloudflare Durable Objects | Unlimited | $0.15/million requests | Better fit for long sessions |
| **Vercel Edge** | **300 seconds max** | **Too short for 30+ min agent sessions** | Not viable |
| Deno Deploy | 5-min idle timeout | Limited regions | Marginal |

### Verdict: Not Recommended Now

AgentPane is a developer tool where users are co-located with the server. ~100-200ms latency improvement doesn't justify architectural complexity.

**When to revisit:** Multi-tenant SaaS with globally distributed users, or cloud-hosted agent execution (not local Docker).

---

## 8. Reliable Delivery Guarantees

### Current: At-Least-Once with Offset Resume

- Persist-first: SQLite INSERT before Caddy publish
- Offset tracking: Both SQLite and client maintain monotonic offsets
- Offset collision retry: Up to 5 retries on UNIQUE violation
- IdempotentProducer: Deduplicates by (producerId, epoch, seq)

### Gap Analysis

| Scenario | Current Behavior | Risk |
|---|---|---|
| Caddy unavailable | Event in SQLite; Caddy publish silently fails | Client misses real-time event |
| SQLite write fails | Error propagated; Caddy not attempted | **Event lost entirely (critical)** |
| Client disconnects mid-stream | Reconnects with last offset | Duplicate events possible |

### Recommendation: Idempotent Consumer for Chunks

The `syncSessionToCollections` function's `chunksCollection.insert` does NOT deduplicate — repeated chunks appear as duplicate text. Add event ID deduplication:

```typescript
const processedIds = new Set<string>();
function processEvent(event: StreamEvent) {
  if (processedIds.has(event.id)) return;
  processedIds.add(event.id);
  // process...
}
```

Other event types (tool calls, presence) already use upsert patterns that handle duplicates naturally.

---

## 9. Streaming Observability

### Current Gaps

- `MAX_SSE_CONNECTIONS` counter in `event-bus.ts` only — no Durable Streams metrics
- No event throughput tracking
- No delivery latency measurement
- No keepalive heartbeats

### Recommended Metrics

**Connection (Gauge):**

- `sse_active_connections` — total across all 3 SSE systems
- `durable_stream_producers_active` — producer pool size

**Throughput (Counter):**

- `stream_events_published_total` (by event type)
- `stream_events_caddy_failed_total` — currently silently swallowed

**Latency (Histogram):**

- `stream_event_persist_duration_ms`
- `stream_event_publish_duration_ms`
- `stream_event_e2e_latency_ms` — event creation to client receipt

### SSE Keepalive

**Problem:** Proxies close idle connections after 60-120 seconds. No heartbeats means stale connections go undetected.

**Solution:** Send SSE comment heartbeats every 30 seconds from Caddy:

```
: keepalive\n\n
```

Transparent to EventSource (comments ignored). Keeps connections alive through proxies. Client should force reconnect if no data for >90 seconds.

---

## Priority Summary

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| **High** | Enable Brotli compression on Caddy SSE | Minimal (config change) | 50-70% bandwidth reduction |
| **High** | Add SSE keepalive heartbeats (30s) | Low | Prevents stale connections through proxies |
| **High** | Add chunk event deduplication (idempotent consumer) | Low | Prevents duplicate text on reconnection |
| **Medium** | Add streaming observability metrics | Medium | Connection counts, throughput, latency visibility |
| **Medium** | Implement event coalescing for progress events | Low | Reduces bandwidth for slow clients |
| **Low** | Codespace-scoped multiplexed streams | Medium | Only needed at 10+ concurrent agents |
| **Hold** | WebTransport | N/A | Not production-ready (no Safari, no Bun, no Caddy) |
| **Hold** | Binary serialization | N/A | Text-dominant payloads see minimal benefit |
| **Hold** | Edge streaming relay | N/A | Not needed at current scale |
