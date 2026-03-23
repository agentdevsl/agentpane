# Cursor Flow Inventory

Date: March 2026

This document inventories the current resume and reconnect flow for `OC-006`.
It highlights where opaque cursor identity is preserved, where it is dropped,
and where numeric fallback still leaks into the stack.

## Purpose

- Make the current reconnect path visible before migration starts.
- Identify the exact points where opaque cursor correctness is lost.
- Give the team a migration checklist for reconnect behavior.

## Current Resume Path

### 1. Durable stream client tracks a string cursor

From `src/lib/streams/client.ts:633`:

- `lastOffset` is stored as a string.
- Initial value is `'-1'`.
- The durable stream transport is already using opaque string offset semantics.

### 2. Transport chunk metadata updates that string cursor

From `src/lib/streams/client.ts:722`:

- `chunk.offset` updates `lastOffset`.
- This is the closest thing to the authoritative resume token in the client path.

### 3. Raw mapped events drop cursor identity

From `src/lib/streams/client.ts:739` to `src/lib/streams/client.ts:744`:

- the mapped `RawSessionEvent` sets `offset: undefined`
- the comment explicitly notes that durable streams use opaque string offsets
- this is the first major correctness break in the reconnect chain

### 4. Public compatibility API converts the opaque cursor to a number

From `src/lib/streams/client.ts:819` to `src/lib/streams/client.ts:825`:

- `getLastOffset()` returns a numeric approximation
- it uses `parseInt(lastOffset, 10)`
- a non-numeric cursor falls back to `0`

This is the second major correctness break in the reconnect chain.

### 5. Session hook no longer tracks a real offset and returns `0` for compat

From `src/app/hooks/use-session.ts:382` to `src/app/hooks/use-session.ts:386`:

- `lastOffset` is returned as `0`
- the comment says this is for compatibility
- the hook currently exposes no trustworthy cursor value to callers

## What This Means Today

- The transport knows more than the session hook exposes.
- The client already has an opaque resume token, but it is not carried through the mapping and hook layers.
- Any logic depending on numeric `lastOffset` is already weaker than the underlying transport.

## Current Numeric-Offset Surfaces Worth Treating Carefully

- `src/services/session/session-stream.service.ts`
  - persists numeric database offsets for session events
- `src/services/durable-streams.service.ts`
  - exposes numeric `offset?: number` in the generic stream event shape
- `src/app/components/features/live-task-view/audit-trail-panel.tsx`
  - uses offset-based fallbacks in item IDs

These are not necessarily wrong on their own, but they must not be confused with the authoritative durable-stream resume token.

## Recommended Migration Targets

### Highest-priority fixes

- `src/lib/streams/client.ts`
  - preserve the opaque cursor through raw event mapping or adjacent subscription state
  - stop exposing only numeric approximation as the public resume signal
- `src/app/hooks/use-session.ts`
  - replace compatibility `0` with a real resume-aware model

### Secondary compatibility work

- `src/server/routes/sessions.ts`
  - isolate translation only if a numeric boundary still exists there
- transcript and audit surfaces that still treat numeric offset as identity-friendly metadata

## Cursor Inventory Questions To Resolve

- Where should the authoritative resume token live in client state?
- Does every consumer need direct cursor access, or should it stay inside the subscription/session layer?
- If a numeric database offset still matters for server-side history lookup, where is the one allowed translation boundary?
- How will reconnect and refresh-driven replay share the same resume semantics?

## Migration Success Signal

- The team can point to one authoritative client-side cursor field.
- No correctness-critical reconnect path depends on `parseInt()`.
- Main reconnect behavior no longer resets to `0`.

## Related Docs

- `docs/research/opencode/14-cursor-migration-plan.md`
- `docs/research/opencode/15-implementation-map.md`
