# Reality Check

Date: March 2026

This document tests AgentPane's current architecture against the codebase as it
exists today. The goal is not to dismiss the existing research. The goal is to
pressure-test it through the lens of user experience, trust, and failure modes.

## What AgentPane Already Gets Right

- Worktree isolation is a strong trust primitive. It limits blast radius and makes review legible in `src/services/worktree.service.ts:168`.
- The sandbox seam is well designed. `SandboxProvider` in `src/lib/sandbox/providers/sandbox-provider.ts:124` is the right abstraction for trying stronger isolation without rewriting orchestration.
- Session events already look like the right aggregate boundary. `session_events` plus monotonic offsets in `src/services/session/session-stream.service.ts:133` are a good base for replay, audit, and stream healing.
- The plan/execute split is product-correct. `runAgentPlanning()` in `src/lib/agents/stream-handler.ts:346` gives AgentPane a meaningful approval boundary instead of a fake "agent is thinking" pause.
- The topology model is richer than most agent tools. There is already enough structure to build useful operator visibility if the product stops hiding failure semantics.

None of those strengths require a framework rewrite. They require tighter semantics and more honest user feedback.

## Where The Docs And The Code Disagree

### 1. Stream durability is weaker than the docs imply

The documentation repeatedly frames the stream path as persist-first and durable. That is true for normal event publishing in `src/services/session/session-stream.service.ts:76` and `src/services/durable-streams.service.ts:619`.

It is not true for hot chunk delivery.

- `ChunkBatcher.addDelta()` publishes each delta to SSE first in `src/lib/agents/chunk-batcher.ts:50`.
- It only buffers the text for later persistence in `src/lib/agents/chunk-batcher.ts:64`.
- Batched persistence happens later in `src/lib/agents/chunk-batcher.ts:97`.

User impact:

- A user can watch text appear in real time.
- The process can die before flush.
- The user refreshes and sees less transcript than they saw a moment ago.

That feels like data loss even if the system did exactly what the code says.

### 2. Reconnect healing is effectively broken in the main session hook

The current reconnect story is much weaker than the docs suggest.

- `useSession()` explicitly sets `lastOff = 0` in `src/app/hooks/use-session.ts:163`.
- The public `lastOffset` returned by the hook is hardcoded to `0` in `src/app/hooks/use-session.ts:290`.
- The durable stream client tracks opaque offsets internally in `src/lib/streams/client.ts:724`.
- It then drops those opaque offsets when mapping events in `src/lib/streams/client.ts:743`.
- It exposes only a lossy `parseInt()` approximation in `src/lib/streams/client.ts:824`.
- The REST catch-up route still expects a numeric pagination offset in `src/server/routes/sessions.ts:246`.

User impact:

- Resume is not trustworthy.
- Duplicate chunks are plausible.
- Missing chunks are plausible.
- The UI has no honest way to say whether it is fully caught up.

### 3. Presence is split across persistence, streaming, and polling

Presence is currently handled in three different ways at once.

- Presence join/leave/cursor events are published into the normal session event pipeline in `src/services/session/session-presence.service.ts:76`, `src/services/session/session-presence.service.ts:102`, and `src/services/session/session-presence.service.ts:134`.
- `useSession()` sends a 10-second heartbeat in `src/app/hooks/use-session.ts:271`.
- `usePresence()` still polls `/presence` every 8 seconds in `src/app/hooks/use-presence.ts:25`.

The in-memory presence store is also keyed only by `userId` per session in `src/services/session/session-presence.service.ts:72`.

User impact:

- Two browser tabs from the same user can fight each other.
- One tab leaving can remove a still-active viewer.
- Presence can be stale for up to 30 minutes because the timeout threshold is `30 * 60 * 1000` in `src/services/session/session-presence.service.ts:26`.
- The UI can show contradictory presence depending on whether the poll or the stream updated first.

### 4. There are multiple streaming stacks, not one coherent one

AgentPane behaves like several products glued together at the streaming layer.

- Main session streaming uses `DurableStreamsClient` in `src/lib/streams/client.ts:620`.
- Plan sessions use a direct `durableStream()` call in `src/app/components/features/plan-session-view/use-plan-session.ts:181`.
- Task creation uses raw `EventSource` in `src/lib/task-creation/sync.ts:88`.
- CLI monitor has its own stream behavior and rendering model in `src/app/components/features/cli-monitor/terminal-pane.tsx:137`.

User impact:

- Different parts of the product reconnect differently.
- Different parts of the product buffer differently.
- Different parts of the product surface errors differently.
- Users experience inconsistency even when the backend is healthy.

### 5. Task creation has a latest-tab-wins SSE bug

Task creation keeps one SSE controller per session in `src/server/routes/task-creation.ts:48`.

- Opening `/stream?sessionId=...` stores a single controller in `src/server/routes/task-creation.ts:411`.
- A second tab for the same session replaces the first.

User impact:

- One tab silently steals the stream from another.
- The user sees a stuck conversation in the first tab without a clear explanation.

### 6. Long-session rendering is expensive by construction

The current stream UI does too much work per event.

- `useSession()` copies full arrays on every new chunk in `src/app/hooks/use-session.ts:192`.
- `useAgentStream()` rebuilds `fullText` by joining all chunks in `src/app/hooks/use-agent-stream.ts:105`.
- `useStreamParser()` merges and sorts every chunk, tool call, and terminal event on each change in `src/app/components/features/agent-session-view/use-stream-parser.ts:149`.
- `useStreamParser()` also generates random line IDs in `src/app/components/features/agent-session-view/use-stream-parser.ts:27`, which defeats stable reconciliation.
- `StreamPanel` renders every line in the DOM in `src/app/components/features/agent-session-view/stream-panel.tsx:66`.

User impact:

- Long sessions feel heavier the longer they run.
- Scroll position becomes harder to manage.
- Input latency and click latency increase.
- "Live" feels slower exactly when the user most needs confidence.

### 7. Live topology leans on heuristics and partial history

The live task view is visually strong but semantically weaker than it looks.

- Initial topology hydration loads only 500 events in `src/app/components/features/live-task-view/index.tsx:113`.
- If topology events are missing, the view infers progress from tool count and token heuristics in `src/app/components/features/live-task-view/index.tsx:199`, `src/app/components/features/live-task-view/index.tsx:230`, and `src/app/components/features/live-task-view/index.tsx:280`.
- `useTopologyStream()` already uses `requestAnimationFrame` buffering in `src/app/hooks/use-topology-stream.ts:62`, which shows the right optimization pattern, but the main transcript path does not.

User impact:

- The graph can look authoritative while being partially synthetic.
- Users may trust the visual more than the data deserves.
- The product risks looking impressive instead of reliable.

### 8. Task and approval states are too optimistic

Task state currently overstates certainty.

- `moveColumn()` updates a task to `in_progress` before agent startup has been proven in `src/services/task.service.ts:422`.
- The UI only shows a warning if agent startup fails later in `src/app/routes/codespaces/$codespaceId/index.tsx:173`.
- `waiting_approval` covers multiple meanings in `src/services/agent/agent-execution.service.ts:497` and `src/services/agent/agent-execution.service.ts:514`.
- Non-plan approvals are still TODO in `src/app/routes/codespaces/$codespaceId/index.tsx:291` and `src/app/routes/codespaces/$codespaceId/index.tsx:306`.
- On restart, orphaned `in_progress` tasks are moved back to backlog in `src/services/container-agent/container-agent.service.ts:158`.

User impact:

- A task can look active before anything real is running.
- A task can quietly jump backward after restart.
- Approval UI can feel inconsistent because the underlying state semantics are inconsistent.

### 9. Memory is operationally safe but experientially opaque

The memory layer is intentionally non-blocking, which is good for uptime.

- `getContext()` returns `EMPTY_CONTEXT` on failure in `src/services/memory/memory.service.ts:93`.
- `captureMessage()` skips short turns and truncates long ones in `src/services/memory/memory-capture.service.ts:107`.
- Query assembly uses simple token-budget heuristics in `src/services/memory/memory-query.service.ts:27`.

User impact:

- Memory can influence the run without the user understanding how.
- Memory can also silently fail and disappear without clear signals.
- Users cannot tell whether a surprising agent decision came from remembered context, fresh repo evidence, or a hallucination.

### 10. The production topology is internally contradictory

The documented production shape and the shipped Helm shape are not the same.

- The docs and `Caddyfile` describe Caddy on `:3000` serving `/v1/stream/*`, `/api/*`, and static assets in one front door in `Caddyfile:6` and `Caddyfile:31`.
- The container entrypoint starts both Caddy and Bun in one container in `docker/start.sh:7` and `docker/start.sh:24`.
- The Helm deployment exposes only port `3001` in `charts/agentpane/templates/deployment.yaml:42`.
- The service and HTTPRoute point all traffic at that app port in `charts/agentpane/templates/service.yaml:10` and `charts/agentpane/templates/httproute.yaml:20`.
- The chart also exposes HPA support in `charts/agentpane/templates/hpa.yaml:1` even though streams, rate limiting, and presence semantics are still effectively single-node.

User and operator impact:

- Stream bugs become harder to reason about because the deployed topology may not match the docs.
- Scale-out looks more supported than it really is.
- Production failures feel arbitrary because different install paths exercise different assumptions.

### 11. PostgreSQL exists as an option, but not yet as an honest one

- The canonical `Database` type is still hardcoded to SQLite in `src/types/database.ts:18`.
- The architecture review identifies major schema drift and 17 missing tables in `specs/reviews/2026-03-architecture/04-database-schema-queries.md:210`.

User and operator impact:

- The product appears more portable than it is.
- Cross-environment bugs become easy to create.
- Scale discussions get distorted because the repo suggests two first-class databases when only one is coherent today.

## Highest-Risk UX Failure Modes

| User symptom | Likely root cause | Evidence | Why it hurts |
| --- | --- | --- | --- |
| Transcript shrinks after refresh | Realtime-first chunk delivery before persistence | `src/lib/agents/chunk-batcher.ts:50` | Feels like the product lost data |
| Duplicate or missing text after reconnect | Broken offset semantics and no stable client-visible IDs | `src/app/hooks/use-session.ts:163`, `src/lib/streams/client.ts:743` | Undermines trust in live execution |
| Viewer list is wrong | User-scoped presence plus poll/stream split | `src/services/session/session-presence.service.ts:72`, `src/app/hooks/use-presence.ts:25` | Collaboration feels flaky |
| Long sessions get laggy | Array copies, full re-sorts, no virtualization | `src/app/hooks/use-session.ts:192`, `src/app/components/features/agent-session-view/use-stream-parser.ts:149`, `src/app/components/features/agent-session-view/stream-panel.tsx:66` | Users stop trusting "Live" |
| Task looks active but nothing is happening | Task column change happens before real startup certainty | `src/services/task.service.ts:422`, `src/app/routes/codespaces/$codespaceId/index.tsx:173` | Product feels deceptive |
| One task-creation tab freezes when another opens | One SSE controller per task-creation session | `src/server/routes/task-creation.ts:48` | Confusing multi-tab behavior |
| Graph looks smarter than the system really is | 500-event bootstrap plus synthetic progress | `src/app/components/features/live-task-view/index.tsx:113` | Insight theater beats signal |
| Mobile task creation feels broken | Desktop-first shell and fixed dialog minimums | `src/app/components/features/layout-shell.tsx:66`, `src/app/components/features/new-task-dialog.tsx:41` | Core workflow feels unfinished |

## What The Existing Research Gets Right

- `docs/research/07-realtime-sync-reactive-data.md` is strongest on near-term stream mechanics. Its recommendations around `requestAnimationFrame` buffering, append-only timelines, and local persistence are the best immediate UX path.
- `docs/research/09-streaming-protocols.md` is right to keep SSE as the primary transport for agent output.
- `docs/research/06-security-scaling.md` is right to push gVisor, pluggable rate limiting, and secret-management improvements.
- `docs/research/11-platform-patterns.md` has the right product instinct about structured stream parts, optimistic updates, and diff-first review.
- `docs/research/08-event-sourcing-cqrs.md` is right that sessions are the natural event-sourced aggregate and that event type definitions need a single source of truth.

## What The Existing Research Underweights

- It is still slightly too optimistic about current stream correctness. The repo is closer to "best-effort durable" than "trustworthy resumable" for the hottest path.
- It treats some future technologies as more urgent than they are. LiveStore, Electric, SharedWorker, and generalized agent workflow frameworks are less important than fixing current semantics.
- It does not push hard enough on state honesty. The biggest UX problem is not missing charts or missing protocol options; it is that task state, reconnect state, and review state over-promise certainty.
- It underweights mobile and accessibility friction in key workflows.
- It treats multi-node and PostgreSQL readiness more generously than the repository evidence supports.

## Core Thesis

AgentPane does not need a new identity. It needs to become more honest.

The most important architecture work is the work that makes the product feel
trustworthy when something goes wrong:

- a clear distinction between live and durable output,
- real resume semantics,
- transcripts that stay fast after thousands of events,
- run states that tell the truth,
- and deployment stories that match the code that actually ships.

Everything in the next document is filtered through that lens.
