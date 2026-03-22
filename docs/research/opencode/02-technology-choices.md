# Technology Choices

Date: March 2026

This document evaluates concrete technology choices that could improve
AgentPane's architecture, with one filter above all others: do they make the
product feel more trustworthy, resilient, and understandable to end users?

## Decision Filters

Every option in this document is judged against five questions:

1. Does it improve user trust, not just developer taste?
2. Does it help recovery, reload, or reconnect semantics?
3. Does it reduce visible latency or UI jank?
4. Does it fit the repository as it exists today?
5. Can it be adopted incrementally without a rewrite?

## Summary Matrix

| Area | Technology | UX upside | Main pitfall | Recommendation |
| --- | --- | --- | --- | --- |
| Realtime transport | SSE + Durable Streams | Correct fit for one-way agent output | Current semantics are weaker than the docs | Adopt |
| Realtime protocol | Structured stream parts with stable IDs | Best reconnect and transcript win | Coordinated client/server migration | Adopt |
| Client persistence | Dexie.js | Reload resilience, instant hydration | Cache pruning and Safari quirks | Trial now |
| Multi-tab | BroadcastChannel | Shared state across tabs with low complexity | No persistence by itself | Adopt |
| Multi-tab | SharedWorker | One connection across tabs | Browser/lifecycle complexity | Assess |
| Selective interactivity | WebSocket for terminals/presence | Better full-duplex flows | Easy to overuse and overcomplicate | Trial selectively |
| Local stream store | `useSyncExternalStore` | Minimal hot-path primitive | You own the store semantics | Adopt as fallback |
| Shared UI state | Zustand | Simpler panel/layout state | Does not fix stream hot path alone | Trial |
| Fine-grained UI state | Jotai | Better atomic subscriptions | Higher conceptual cost | Assess |
| Sync engine | Electric SQL | Strong long-term durable sync model | Requires real Postgres migration | Assess later |
| Local-first data layer | LiveStore | Interesting persistent client model | Rewrite cost and beta churn | Hold |
| Transcript rendering | `react-virtuoso` | Best streaming list UX | Requires list refactor | Trial now |
| Readability | Shiki | Immediate code/diff clarity | Expensive if used on every token delta | Adopt |
| Rich file/diff views | CodeMirror 6 | Search, selection, folding | Too heavy for generic transcript UI | Trial selectively |
| Design primitives | shadcn/ui Sheet/Drawer/ScrollArea | Fixes mobile shell gaps | Does not solve performance by itself | Adopt selectively |
| Observability | OpenTelemetry + Langfuse | Makes runs explainable | Privacy and span discipline required | Adopt |
| Product reliability | Sentry | Better error visibility for users and operators | Not enough on its own | Adopt |
| Memory | Keep Honcho, but harden the UX around it | Lowest migration risk | Still limited and opaque today | Adopt short-term |
| Memory | Mem0 | Potentially better retrieval | More impressive and more wrong is dangerous | Trial |
| Memory | Zep | Better temporal semantics | More complexity than Mem0 | Assess |
| Isolation | gVisor | Strongest immediate safety gain | Syscall incompatibilities need surfacing | Adopt |
| Hosted sandboxing | E2B | Better hosted isolation story | Vendor and cost tradeoffs | Trial |
| Runtime | Node 24 for hosted API | Lower-surprise production ops | Migration cost from Bun runtime assumptions | Assess |
| Database posture | Honest SQLite + off-node backup | Best near-term simplicity | No horizontal scale-out | Adopt |
| Strategic data path | PostgreSQL + Electric | Best long-term synced state | Requires parity project first | Assess |
| Event backplane | NATS JetStream | Good future service bus | Premature before topology is honest | Hold |
| Rate limiting | Upstash or Redis-backed limiter | Consistent hosted behavior | Extra infra dependency | Adopt |
| Secrets | Infisical + file injection | Better operator trust | More moving parts if self-hosted | Adopt |
| CDN | Cloudflare for assets and edge shielding | Faster assets, easier public edge | Stream path needs explicit bypass rules | Adopt carefully |

## 1. Realtime Transport And Client Data

### Keep SSE + Durable Streams as the primary output transport

Architectural fit:

- Very high. Agent output is mostly server-to-client text, tool updates, and state transitions.
- Browser-native EventSource behavior is still the simplest mental model.
- The repository already depends on this path in `src/lib/streams/client.ts:620` and through Caddy in `Caddyfile:31`.

UX upside:

- Native reconnect behavior.
- Easy proxy compatibility.
- Low conceptual overhead for users and developers.

Pitfalls:

- The current implementation is only as trustworthy as its semantics.
- Right now the protocol is weaker than the transport: opaque offsets are mishandled, chunk durability is mixed, and error states are under-surfaced.

Recommendation:

- Adopt.
- Do not rewrite the primary transport first.
- Fix protocol semantics, replay behavior, and UX around the existing transport before exploring replacements.

### Adopt a structured stream protocol with stable IDs and explicit durability

This is the highest-value architecture change in the entire stack.

Suggested shape:

- Stable `eventId` on every emitted event.
- Stable `blockId` for multi-part output.
- `partType` such as `start`, `delta`, `end`, `replace`, `summary`.
- `durability` flag such as `transient` or `durable`.
- Explicit `schemaVersion` at the event envelope level.

Architectural fit:

- Extremely high.
- It directly addresses the current mismatch between `ChunkBatcher`, `session_events`, and client rendering.
- It also aligns with the earlier recommendation to unify event definitions into one source of truth.

UX upside:

- Reconnect dedupe becomes practical.
- The UI can say "live output still buffering" versus "persisted output" honestly.
- Text, tools, file edits, and system messages can be rendered as separate blocks instead of one blurred transcript.
- Approval and replay views become easier to interpret.

Pitfalls:

- Requires client and server rollout coordination.
- Easy to create two overlapping protocols if migration is sloppy.
- Needs a decision on what is truly durable and what is only realtime.

Recommendation:

- Adopt first.
- This is a better near-term investment than any transport rewrite.

### Add Dexie.js for IndexedDB-backed session hydration

Architectural fit:

- Very high.
- AgentPane already models session output as append-only event streams and derived views.
- Dexie is a good fit for caching durable stream blocks, tool calls, session summaries, and last-read position.

UX upside:

- Refresh no longer feels punitive.
- Reload can be near-instant for long sessions.
- Background tabs can reopen with context already in place.
- Users stop equating page refresh with losing their place.

Pitfalls:

- Requires eviction strategy.
- Safari private mode and low-storage environments need fallback behavior.
- Do not persist every transient micro-delta forever; persist durable blocks and useful summaries.

Recommendation:

- Trial now, likely adopt.

### Use BroadcastChannel as the first multi-tab coordination primitive

Architectural fit:

- High.
- Works well with a Dexie-backed local cache and visible connection states.

UX upside:

- Tabs can share "current connection state", last seen durable cursor, and basic leader election.
- The product feels less random in multi-tab usage.
- Reduces duplicate work without introducing a new server dependency.

Pitfalls:

- Same-origin only.
- No persistence.
- Needs careful ownership semantics if one tab is considered the active connection leader.

Recommendation:

- Adopt.

### SharedWorker is useful, but later

Architectural fit:

- Reasonable for consolidating one browser-side stream connection across tabs.

UX upside:

- Lower duplicate network load.
- Cleaner one-connection-per-browser model.

Pitfalls:

- Debugging and lifecycle behavior are much harder than BroadcastChannel.
- Browser support and bundler ergonomics are still not as effortless as standard page code.

Recommendation:

- Assess.
- Do BroadcastChannel plus Dexie first.

### Use WebSocket only for selective bidirectional channels

Best-fit use cases:

- Interactive terminal I/O.
- Connection-scoped presence or cursor awareness if needed.
- Future collaborative editing.

Architectural fit:

- Good as an additive transport.
- Poor as a replacement for the main agent output stream.

UX upside:

- Better for truly interactive tools.
- Cleaner semantics where the user is actively sending input to a live process.

Pitfalls:

- Easy to over-apply.
- If used for primary agent output, AgentPane would need to rebuild replay, ordering, and resume guarantees that SSE already provides.

Recommendation:

- Trial selectively.
- Hold as the default stream transport.

### `useSyncExternalStore` is the best minimal fallback for the hot path

Architectural fit:

- High.
- AgentPane's hottest path is a local append-only event store with multiple subscribers.

UX upside:

- Much simpler than a full state-library rewrite.
- Lets the team own exactly how batching, append-only behavior, and selectors work.
- Fits React's concurrency model cleanly.

Pitfalls:

- More custom code.
- No persistence or derived-state system by itself.

Recommendation:

- Adopt as the fallback or replacement for the current most expensive stream-state code.

### Zustand is a good UI-state layer, not a stream-ingest solution

Architectural fit:

- Best for panel layout, selected entities, modal state, drawer state, and cross-panel coordination.

UX upside:

- Reduces provider sprawl.
- Makes layout and selection behavior more consistent.

Pitfalls:

- If used naively for chunks and transcripts, it still creates array-copy churn.
- It does not solve durability, replay, or protocol correctness.

Recommendation:

- Trial for shared UI state only.

### Jotai is worth assessing only if the stream view-model becomes atom-heavy

Architectural fit:

- Good for fine-grained derived state in a complex live UI.

UX upside:

- Better selective re-render behavior than a coarse store.

Pitfalls:

- Adds conceptual cost.
- Does not address the biggest current problems by itself.

Recommendation:

- Assess, not urgent.

### Electric SQL is the best strategic sync path after a real Postgres migration

Architectural fit:

- Strong for durable relational state after PostgreSQL becomes first-class.
- Especially good for tasks, approvals, summaries, session metadata, and multi-user sync.

UX upside:

- Cleaner multi-client consistency.
- Less custom catch-up and sync code for durable state.
- Better future path for multi-device and collaborative views.

Pitfalls:

- Requires a real Postgres migration first.
- It is not the first thing to use for hot token-by-token output.
- Shape design and long-term schema choices matter.

Recommendation:

- Assess later, gated on a real Postgres decision.

### LiveStore is interesting but wrong-timed

Architectural fit:

- Conceptually attractive for a richer local-first client model.

UX upside:

- Persistent local SQLite.
- Reactive SQL queries.
- Strong future ergonomics for more durable client-side state.

Pitfalls:

- Real rewrite cost.
- Beta churn.
- Too much complexity before the product fixes current stream semantics.

Recommendation:

- Hold.

### libSQL / Turso helps durability and read scaling, but not the core UX problem

Architectural fit:

- Reasonable if AgentPane wants SQLite ergonomics with a stronger hosted durability story.

UX upside:

- Can improve read latency for distributed or managed deployments.
- Can reduce operator burden around backups and durability.

Pitfalls:

- Does not fix transcript correctness, reconnect behavior, or rendering lag.
- Adds new network and credential failure modes.

Recommendation:

- Assess, but do not treat it as a UX-first fix.

### Event workers are second-order optimizations

Comlink plus a Web Worker can move parse/validation work off the main thread.

Architectural fit:

- Fine as a later optimization.

UX upside:

- Helps once render costs are under control.

Pitfalls:

- If the real bottleneck is re-render churn, a worker just hides the wrong layer.

Recommendation:

- Trial after append-only timelines and virtualization are in place.

### Presence should become connection-scoped, not user-scoped

Whether implemented with a lightweight awareness channel, a narrow WebSocket path,
or a Yjs-style presence model, the architectural principle is the same.

Architectural fit:

- High.
- Presence should be ephemeral and connection-scoped, not persisted in the durable session event log.

UX upside:

- Faster and more honest viewer state.
- Better multi-tab correctness.
- Fewer stale ghosts.

Pitfalls:

- Another channel to manage.
- Easy to overbuild if the only need is "who is watching".

Recommendation:

- Trial a simpler connection-scoped presence channel first.

## 2. Frontend Rendering And Interaction

### `react-virtuoso` is the best transcript virtualization choice

Architectural fit:

- High for agent transcripts, audit trails, and terminal-like panels.
- Better fit than lower-level virtualizers for follow-output behavior.

UX upside:

- Stable long-session performance.
- Built-in support for pinned-bottom log behavior.
- Easier "new messages" affordance when the user scrolls upward.

Pitfalls:

- Requires transcript rendering to become more list-oriented and less ad hoc.

Recommendation:

- Trial now for transcript and audit views.

### `@tanstack/react-virtual` still makes sense for tables and custom grids

Architectural fit:

- Good for lower-level layouts where AgentPane already wants manual control.

UX upside:

- Lightweight and flexible.

Pitfalls:

- More engineering work for log-like follow-output behavior.

Recommendation:

- Use it for tables and custom grid views.
- Prefer `react-virtuoso` for transcript surfaces.

### Shiki is the easiest readability win in the repo

Architectural fit:

- Extremely high.
- The dependency is already installed, but `MarkdownContent` still renders plain code blocks in `src/app/components/ui/markdown-content.tsx:22`.

UX upside:

- Code, diffs, and tool output become far easier to scan.
- Review surfaces feel more trustworthy and intentional.

Pitfalls:

- Highlight completed blocks or buffered blocks, not every live token delta.
- Avoid moving large highlight work into the hottest render path.

Recommendation:

- Adopt now.

### CodeMirror 6 should be used only where file-like interaction matters

Architectural fit:

- Good for file previews, diffs, search, and structured output inspection.

UX upside:

- Better copy/select/search behavior.
- Better file review ergonomics.

Pitfalls:

- Too heavy for normal chat/transcript bubbles.
- Easy to accidentally turn every output pane into a mini editor.

Recommendation:

- Trial selectively for diff and file detail views.

### Add shadcn/ui sheet and drawer patterns to fix mobile shell gaps

Architectural fit:

- High.
- Existing Radix-based UI already matches the same design approach.

UX upside:

- A real mobile nav for `LayoutShell`.
- Better mobile handling for side panels, detail drawers, and inspection views.
- Better fallback for the current desktop-first layouts.

Pitfalls:

- This is a shell improvement, not a transcript-performance fix.

Recommendation:

- Adopt selectively.

### View Transitions are polish, not a priority

Architectural fit:

- Fine for route and mode transitions.

UX upside:

- Better continuity between board, live task view, and session detail.

Pitfalls:

- Can make a still-slow UI feel cosmetically smoother without fixing the actual pain.

Recommendation:

- Assess later.

### Accessibility tooling is underused and should be added to the workflow

Architectural fit:

- High.
- AgentPane has many complex dialogs, tabs, graphs, and live regions.

UX upside:

- Better keyboard behavior.
- Better screen-reader support.
- Fewer regressions in the flows users rely on during stress.

Pitfalls:

- Needs real triage discipline to avoid alert fatigue.

Recommendation:

- Adopt `@axe-core/playwright` or equivalent E2E accessibility checks for core workflows.

### Use a shared optimistic action helper instead of one-off optimistic logic

Architectural fit:

- High.
- AgentPane already has optimistic behavior in some places and synchronous waiting in others.

UX upside:

- Consistent pending, confirmed, failed, and reverted states.
- Better mental model for stop, approve, reject, run now, and move actions.

Pitfalls:

- Must reconcile with server-authoritative stream events.

Recommendation:

- Adopt a small shared helper, not a large mutation framework.

## 3. Orchestration, Trust, And Safety

### OpenTelemetry + Langfuse is the right observability stack

Architectural fit:

- High.
- AgentPane already emits rich lifecycle information; it just does not stitch it into an operator-grade trace.

UX upside:

- Support and operators can answer "what is it doing?" without guessing.
- Users get better explanations for stalled runs.
- Multi-agent execution becomes debuggable instead of theatrical.

Pitfalls:

- Needs privacy discipline around prompts, code, and secret-bearing metadata.
- Partial instrumentation is worse than full instrumentation because it creates false precision.

Recommendation:

- Adopt.

### Sentry should complement, not replace, traceability

Architectural fit:

- High for frontend and backend exception visibility.

UX upside:

- Faster detection of user-facing regressions.
- Better release confidence.

Pitfalls:

- Exceptions are not execution truth. Sentry cannot explain a run by itself.

Recommendation:

- Adopt alongside OpenTelemetry and Langfuse.

### Keep Honcho for now, but make memory visible

Architectural fit:

- Highest near-term fit because the seam already exists.

UX upside:

- Lower migration risk.
- Lets the team fix the real user problem first: memory opacity.

What to add before considering replacement:

- Per-run memory status.
- Source counts and citations.
- Ability to inspect or suppress remembered context.
- Explicit "memory unavailable" or "memory skipped" signals.

Pitfalls:

- Keeping the provider does not solve quality by itself.

Recommendation:

- Adopt short-term, harden the UX around it.

### Mem0 is worth trialing only behind an evaluation harness

Architectural fit:

- Reasonable because `MemoryClientService` is already a seam.

UX upside:

- Potentially stronger retrieval and better long-lived context.

Pitfalls:

- A more confident but less transparent memory system is worse than the current conservative one.
- Quality must be judged with citations and human review, not just vendor benchmarks.

Recommendation:

- Trial with dual-read evaluation, not as a silent swap.

### Zep is the better long-term memory assessment if temporal knowledge matters

Architectural fit:

- Better than Mem0 if AgentPane wants to model how knowledge changes over time.

UX upside:

- More credible long-lived memory for evolving codebases and workflows.

Pitfalls:

- Heavier operational and conceptual cost.

Recommendation:

- Assess after Honcho hardening and Mem0 evaluation.

### gVisor should become the default sandbox isolation mode

Architectural fit:

- Very high.
- The repository already supports runtime classes and recommends stronger isolation.

UX upside:

- Better safety story for running untrusted agent code.
- Higher operator confidence.

Pitfalls:

- Some workloads may hit syscall compatibility issues.
- Those failures need to surface clearly instead of looking like random sandbox flakiness.

Recommendation:

- Adopt.

### E2B is the most credible managed sandbox trial

Architectural fit:

- Reasonable because the provider abstraction is already in place.

UX upside:

- Stronger hosted isolation story.
- Potentially more predictable hosted startup and cleanup behavior.

Pitfalls:

- Vendor, latency, and cost tradeoffs.
- Weaker story for fully local-first deployments.

Recommendation:

- Trial for hosted mode only.

### Checkpoint/resume is more important than a new orchestration framework

Architectural fit:

- Extremely high.
- AgentPane already has the right aggregate boundary in sessions and plans.

UX upside:

- Server restarts stop feeling like erased work.
- Plan-to-execute transitions become more trustworthy.
- Users can recover or reattach instead of restarting from scratch.

Pitfalls:

- Needs disciplined definition of what is checkpointed: session ID, sandbox identity, plan artifact, durable cursor, current phase, and review status.

Recommendation:

- Adopt.

### A team saga state machine is more useful than a generic multi-agent framework

Architectural fit:

- High.
- AgentPane's issue is not lack of multi-agent capability; it is lack of explicit recovery semantics.

UX upside:

- Users can see spawn, merge, compensation, and failure states clearly.
- Team mode becomes explainable instead of mysterious.

Pitfalls:

- Requires crisp domain states and event definitions.

Recommendation:

- Adopt.

### Structured diff events will improve review more than more transcript volume

Architectural fit:

- High.
- Review is where users decide whether to trust the system.

UX upside:

- File-level and phase-level review becomes easier.
- Users can reason about impact instead of replaying raw output.

Pitfalls:

- Needs stronger event schema discipline.

Recommendation:

- Adopt.

### MCP exposure is valuable later, but only after cleanup

Architectural fit:

- Good for ecosystem integrations and operator tooling.

UX upside:

- Better automation and better external inspection tooling.

Pitfalls:

- It will expose existing state ambiguities if added too early.

Recommendation:

- Assess after stream and state cleanup.

### Hold on generic orchestration frameworks

LangGraph, CrewAI, AutoGen, and similar frameworks do not solve AgentPane's current product problem.

- They do not replace the Claude coding tool experience.
- They do not improve transcript trust by themselves.
- They do not solve sandbox safety, replay, or run-state honesty.

Recommendation:

- Hold.

## 4. Platform, Runtime, And Deployment

### Assess Node 24 as the hosted production runtime, keep Bun for development speed

Architectural fit:

- Good.
- The repo already mixes Bun and Node-world assumptions.

UX upside:

- Lower operational surprise for hosted deployments.
- Better familiarity for debugging long-lived control-plane behavior.

Pitfalls:

- Migration work.
- Not a prerequisite for the most urgent UX fixes.

Recommendation:

- Assess, not block the rest of the roadmap on it.

### Adopt an honest single-node SQLite posture for the near term

Architectural fit:

- Very high for the product as implemented today.

UX upside:

- Lower latency.
- Easier local reproduction.
- Fewer deployment surprises.

Pitfalls:

- No honest horizontal scale story.
- Requires real backup and restore discipline.

Recommendation:

- Adopt as the near-term production posture.

### PostgreSQL should be a strategic migration, not a toggle

Architectural fit:

- High for long-term scale and multi-user durability.

UX upside:

- Better future concurrency and managed ops story.

Pitfalls:

- The current repository is not in parity.
- Pretending it is a live runtime choice hurts trust.

Recommendation:

- Assess as a real project with parity work, not as a casual runtime option.

### PostgreSQL + Electric is the cleanest long-term synced-state path

Architectural fit:

- Strong once PostgreSQL is first-class.

UX upside:

- Better durable multi-client sync.
- Less custom read-model plumbing over time.

Pitfalls:

- Large migration cost.
- Still not the first fix for hot token streaming.

Recommendation:

- Assess after PostgreSQL parity.

### NATS JetStream is premature for the current product shape

Architectural fit:

- Strong only after AgentPane actually becomes multi-node or multi-service.

UX upside:

- Better service backplane and cross-node event routing in the future.

Pitfalls:

- Operational tax before the product has even fixed its front-door topology and single-node semantics.

Recommendation:

- Hold.

### Upstash or Redis-backed rate limiting should replace in-memory production limits

Architectural fit:

- High.
- The current limiter openly documents its multi-instance limitation in `src/lib/api/rate-limiter.ts:6`.

UX upside:

- More consistent operator and user behavior in hosted deployments.
- Better abuse control for public endpoints.

Pitfalls:

- Adds infra dependency.
- Self-hosted installs need an alternative path.

Recommendation:

- Adopt a pluggable backend with managed and self-hosted options.

### Infisical plus file-based secret injection is the right direction

Architectural fit:

- High.
- Current env-var injection is especially problematic because `CLAUDE_OAUTH_TOKEN` is passed directly into sandbox exec in `src/services/container-agent/container-exec.service.ts:657`.

UX upside:

- Better operator trust.
- Cleaner audit and rotation story.

Pitfalls:

- Another system to operate if self-hosted.
- Secret manager adoption alone is not enough if runtime injection stays sloppy.

Recommendation:

- Adopt together with file-based or short-lived credential injection.

### Cloudflare is good for assets and edge shielding, but stream paths need care

Architectural fit:

- High for static delivery, DNS, and public ingress hardening.

UX upside:

- Faster assets.
- Better public-edge reliability.

Pitfalls:

- SSE paths need explicit config to avoid buffering or accidental caching behavior.

Recommendation:

- Adopt carefully, with stream-path-specific rules.

## Good Technology, Wrong Timing

These options may be useful later, but they are not the right next move for the current user experience problems.

- LiveStore
- Electric before PostgreSQL parity
- SharedWorker before BroadcastChannel and Dexie
- NATS before a real scale-out decision
- Generic agent orchestration frameworks
- Full WebSocket replacement for primary agent streaming

## Bottom Line

The right technology decisions for AgentPane are the ones that make the product
more honest first:

- stable stream identity,
- durable reload behavior,
- fast long-session rendering,
- explainable execution traces,
- safer sandboxing,
- and a production story that matches the docs.

Anything that does not improve one of those outcomes should be treated as later,
no matter how attractive the technology looks on paper.
