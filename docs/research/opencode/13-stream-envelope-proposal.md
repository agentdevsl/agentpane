# Stream Envelope Proposal

Date: March 2026

This document is the concrete design proposal for `OC-005`.
It turns the planning work into a proposed shared event shape for the first
implementation tranche.

## Purpose

- Give the team one proposed stream contract to build against.
- Remove ambiguity around stable identity, block grouping, and durability semantics.
- Make later reconnect, transcript, and cache work depend on a concrete shape instead of a loose idea.

## Design Goals

- Every emitted event has stable identity.
- Multi-part output can be grouped into coherent blocks.
- Durable and transient output are explicitly distinct.
- The contract is versioned.
- The same envelope works for chunk, tool, system, diff, and lifecycle events.

## Proposed Envelope

```ts
type StreamDurability = 'transient' | 'durable'

type StreamPartType =
  | 'chunk_start'
  | 'chunk_delta'
  | 'chunk_end'
  | 'tool_start'
  | 'tool_result'
  | 'tool_error'
  | 'system'
  | 'lifecycle'
  | 'diff'

interface StreamEnvelope<TPayload> {
  schemaVersion: 1
  eventId: string
  streamId: string
  blockId: string | null
  partType: StreamPartType
  durability: StreamDurability
  sequence: number | null
  createdAt: string
  payload: TPayload
}
```

## Field Definitions

- `schemaVersion`
  - Starts at `1`.
  - Changes only when the envelope contract itself changes incompatibly.
- `eventId`
  - Unique and stable for every emitted event.
  - Never synthesized on the client from timestamps or array positions.
- `streamId`
  - Logical stream identifier for the session or stream source.
  - Lets consumers reason about event origin without overloading `blockId`.
- `blockId`
  - Stable identifier for a multi-part output unit.
  - Required for chunk sequences and any grouped tool or diff output.
  - `null` only for truly standalone events.
- `partType`
  - Explains what the event represents, not how the client chooses to render it.
- `durability`
  - `transient` means visible live output that is not yet backed by durable persistence.
  - `durable` means the event is safe to treat as persisted truth.
- `sequence`
  - Monotonic within a block when ordering multiple parts matters.
  - `null` for standalone events where block ordering does not apply.
- `createdAt`
  - Server-assigned timestamp for tracing and debugging.
  - Useful metadata, but not a substitute for stable identity.
- `payload`
  - Type-specific event data.

## Proposed Payload Shapes

These are starting points, not final code.

### Chunk payload

```ts
interface ChunkPayload {
  sessionId: string
  content: string
  mimeType?: string
}
```

### Tool payload

```ts
interface ToolPayload {
  sessionId: string
  toolName: string
  callId: string
  status?: 'running' | 'completed' | 'failed'
  input?: unknown
  output?: unknown
  errorMessage?: string
}
```

### Lifecycle payload

```ts
interface LifecyclePayload {
  sessionId: string
  state:
    | 'agent_started'
    | 'agent_finished'
    | 'agent_failed'
    | 'run_cancelled'
    | 'review_requested'
}
```

### Diff payload

```ts
interface DiffPayload {
  sessionId: string
  filePath: string
  changeType: 'added' | 'modified' | 'deleted'
  patch?: string
}
```

## Durability Rules

- `chunk_delta` should usually be `transient` while hot output is still streaming.
- A persisted block representation can later be emitted or replayed as `durable`.
- Tool and lifecycle events should only be marked `durable` when they are actually replay-safe.
- The client should never infer durability from event type alone.

## Identity Rules

- `eventId` is the primary identity key for dedupe.
- `blockId` is the grouping key for multi-part output.
- `sequence` orders parts within a block.
- `createdAt` is never an identity fallback.

## Recommended Client Interpretation

- Dedupe by `eventId`.
- Group chunk and diff output by `blockId`.
- Render ordering within grouped output by `sequence`.
- Surface `durability` as part of transcript trust semantics, not as hidden metadata only.

## Recommended Migration Rule

- Preferred default: explicit migration gate rather than silent mixed compatibility.
- If mixed old/new protocol support is unavoidable, the compatibility boundary should exist in one place only.
- Do not allow multiple client paths to invent their own fallback parsing logic.

## Non-Goals

- This proposal does not define the exact durable storage model.
- This proposal does not solve reconnect by itself.
- This proposal does not cover Dexie hydration or transcript virtualization.

## Open Items To Resolve During Implementation

- Exact `streamId` source for each stream surface.
- Whether `sequence` is global per block or local per part type.
- Whether some tool events need a more specific `partType` taxonomy.
- Whether diff payloads should carry raw patches or structured hunks.

## Recommended Adoption Path

1. Lock the envelope and field semantics.
2. Implement shared schema definitions.
3. Migrate emitters.
4. Migrate client parsing.
5. Explicitly gate or block mixed-protocol behavior.

## Related Docs

- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/05-open-questions.md`
- `docs/research/opencode/06-execution-briefs.md`
- `docs/research/opencode/11-rollout-plan.md`
