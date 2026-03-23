# Open Questions

Date: March 2026

This document captures the remaining implementation decisions that still matter
after the executive brief, roadmap, and backlog are in place. Each item names a
recommended default so future implementation work can move without reopening the
entire architecture discussion.

## 1. Canonical Production Front Door

- Question: should the official production story remain Caddy on `:3000`, or should the docs move to a Bun-first topology that exposes `:3001` directly?
- Why it matters: this changes how `/v1/stream/*`, `/api/*`, health checks, static assets, and Helm routing should behave.
- Recommended default: keep Caddy as the canonical public front door and make Helm plus docs match it.
- Why this default: durable streams, static asset serving, and the documented architecture already assume one front door.

## 2. Live Health State Contract

- Question: which live states are truly authoritative, and which are only inferred from client behavior?
- Why it matters: the UI should not claim more certainty than the system has.
- Recommended default: standardize on `starting`, `live`, `reconnecting`, `catching_up`, `degraded`, `startup_failed`, and `disconnected`.
- Why this default: it is expressive enough to explain the common failure modes already visible in the codebase without inventing unsupported nuance.

## 3. Structured Stream Schema Ownership

- Question: where should the structured stream envelope live so both emitters and consumers use the same contract?
- Why it matters: split ownership will recreate the same drift the current stream stack already has.
- Recommended default: define one shared, versioned schema module used by both server emission and client parsing.
- Why this default: the stream contract is now important enough to deserve a single source of truth.

## 4. Durable Versus Transient Output Semantics

- Question: which stream events can honestly be called durable?
- Why it matters: users already see hot output before it is safely persisted.
- Recommended default: only mark an event `durable` once it has been persisted; hot chunk deltas should remain `transient` until a persisted block exists.
- Why this default: it aligns the protocol with the real behavior of `src/lib/agents/chunk-batcher.ts`.

## 5. Resume Cursor Contract

- Question: should reconnect and replay use opaque string cursors end-to-end, or should the app translate them to local numeric forms?
- Why it matters: lossy conversions are a direct cause of duplicate and missing event risk.
- Recommended default: keep durable stream cursors opaque end-to-end and only translate at explicit compatibility boundaries if absolutely necessary.
- Why this default: correctness matters more than convenience here.

## 6. Local Cache Granularity

- Question: what should Dexie persist locally once hydration work begins?
- Why it matters: persisting too little weakens reload UX, while persisting too much creates storage churn and merge bugs.
- Recommended default: persist durable blocks, tool events, summaries, and last-read position; do not persist every transient micro-delta.
- Why this default: it captures the valuable durable state without turning the browser cache into a token log.

## 7. Transcript Virtualization Choice

- Question: should transcript panes use `react-virtuoso` or a lower-level virtualizer?
- Why it matters: pinned-bottom log behavior and mixed row heights are the hard parts of this UI.
- Recommended default: use `react-virtuoso` for transcript-style surfaces and reserve lower-level virtualizers for non-log layouts.
- Why this default: it best matches the current stream UX needs with less custom follow-output behavior.

## 8. Deferred Security And Isolation Revisit Triggers

- Question: when should `OC-002` and `OC-003` move out of deferred status?
- Why it matters: deferring them is acceptable only if the revisit condition is explicit.
- Recommended default:
  - Revisit `OC-002` before any public beta or hosted-security review.
  - Revisit `OC-003` immediately after `OC-001` lands and the hosted cluster expectations are documented.
- Why this default: both items still matter, but they should come back at a deliberate checkpoint instead of by accident.

## Decision Rule

- If a future implementation branch needs to pick among these options quickly, use the recommended default unless the repository has materially changed since this research pass.
- If the repository changes enough to invalidate a default, update this file and `docs/research/opencode/04-implementation-backlog.md` together.
