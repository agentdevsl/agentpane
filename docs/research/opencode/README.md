# OpenCode Architecture Research

Date: March 2026

Scope: UX-first architecture research for AgentPane, with emphasis on pitfalls,
trust, recovery, perceived performance, and the gap between documented design
and repository reality.

This folder complements the existing `docs/research/*.md` set. The earlier
research is broad and useful. This pass is intentionally narrower and more
opinionated: it focuses on what users feel when the architecture is stressed,
where the code disagrees with the docs, and which technology choices are good
fits for AgentPane right now.

## Files

| File | Focus | Why it matters |
| --- | --- | --- |
| `00-executive-brief.md` | Fast planning summary | Gives the shortest path through the main findings and current execution queue |
| `01-reality-check.md` | Current architecture through a UX lens | Identifies the biggest trust and usability gaps in the codebase today |
| `02-technology-choices.md` | Concrete technology options | Separates good technology from good fit for AgentPane |
| `03-roadmap.md` | Prioritized implementation path | Orders work by user-visible value and risk reduction |
| `04-implementation-backlog.md` | Actionable implementation backlog | Converts the roadmap into high-priority execution-ready work |
| `05-open-questions.md` | Remaining architecture decisions | Captures unresolved choices with recommended defaults so implementation stays unblocked |
| `06-execution-briefs.md` | Issue-ready and PR-ready drafts | Turns the active backlog into copy-paste execution briefs for implementation |
| `07-phase-plan.md` | Milestone-style shipment plan | Groups the active queue into phases so the team knows what should ship together |
| `08-kickoff-checklist.md` | Immediate implementation startup guide | Turns the first tranche into a practical kickoff checklist for the team |
| `09-validation-matrix.md` | Tranche test and verification guide | Defines what must be validated before the first stream-correctness tranche is done |
| `10-risk-register.md` | First-tranche failure-mode tracker | Captures the main risks and mitigations for the OC-005 and OC-006 tranche |
| `11-rollout-plan.md` | First-tranche rollout and rollback guide | Defines how to ship and back out the stream-contract tranche safely |
| `12-handoff-checklist.md` | Team kickoff handoff guide | Gives the team a short meeting-ready checklist before tranche implementation starts |

## Executive Summary

- AgentPane already has strong primitives: worktree isolation in `src/services/worktree.service.ts:168`, a real sandbox abstraction in `src/lib/sandbox/providers/sandbox-provider.ts:124`, append-only session events in `src/services/session/session-stream.service.ts:133`, and a plan/execute split in `src/lib/agents/stream-handler.ts:346`.
- The biggest problem is not missing frameworks. It is that the product often knows more than it tells the user. Durability, reconnect healing, startup success, memory availability, and stream health are frequently best-effort while the UI still looks confident.
- The most important stream contradiction is that the docs describe a clean persist-first model, but hot chunk delivery is realtime-first in `src/lib/agents/chunk-batcher.ts:43`. Users can see output that is not yet durable.
- The most important reconnect contradiction is that `useSession()` always falls back to `lastOff = 0` on reconnect in `src/app/hooks/use-session.ts:163`, while the durable stream client drops opaque offsets when mapping raw events in `src/lib/streams/client.ts:743`.
- The most important performance issue is long-session rendering: repeated array copies in `src/app/hooks/use-session.ts:192`, full merge-sort in `src/app/components/features/agent-session-view/use-stream-parser.ts:149`, and no virtualization in `src/app/components/features/agent-session-view/stream-panel.tsx:50`.
- The most important deployment contradiction is that production docs describe Caddy on `:3000` as the front door in `Caddyfile:6` and `docs/durable-streams-architecture.md:18`, but the Helm chart exposes only port `3001` in `charts/agentpane/templates/deployment.yaml:42`, `charts/agentpane/templates/service.yaml:10`, and `charts/agentpane/templates/httproute.yaml:20`.
- The biggest scale-out honesty problem is that the repo exposes PostgreSQL and HPA-like shapes while the real stream layer, rate limiter, and deployment assumptions are still single-node in practice.

## Strongest Recommendations

1. Adopt a structured stream protocol with stable event IDs, block IDs, schema versioning, and a clear transient/durable split.
2. Add IndexedDB hydration with Dexie for session replay, last-read position, and reload resilience.
3. Replace full stream re-sorts with append-only timelines and virtualize transcript panes.
4. Make connection health first-class in the UI: `live`, `reconnecting`, `catching up`, `degraded`, `stale`.
5. Instrument the full run lifecycle with OpenTelemetry + Langfuse, and add Sentry for product-visible failures.
6. Make gVisor the default sandbox isolation mode and stop injecting OAuth tokens as container env vars.
7. Fix the documented-vs-deployed front-door mismatch before doing any multi-node or autoscaling work.
8. Treat PostgreSQL + Electric as a long-term scale path, not as a runtime toggle that is already product-ready.

## Recommended Technology Stance

| Technology | Why | Recommendation |
| --- | --- | --- |
| SSE + Durable Streams | Best fit for one-way agent output; already integrated | Adopt, but harden semantics before scaling |
| Structured stream protocol | Biggest correctness and UX win | Adopt |
| Dexie.js | Best near-term fix for refresh pain and reload trust | Trial now |
| BroadcastChannel | Low-risk multi-tab coordination | Adopt |
| SharedWorker | Useful later, but higher lifecycle and browser risk | Assess |
| `react-virtuoso` | Best fit for streaming transcript virtualization | Trial now |
| Shiki | Immediate readability improvement for code and diffs | Adopt |
| OpenTelemetry + Langfuse | Makes runs explainable and debuggable | Adopt |
| Sentry | Product-facing reliability signal | Adopt |
| gVisor | Highest safety gain with low architecture churn | Adopt |
| Upstash or Redis-backed rate limiting | Fixes false multi-instance safety | Adopt as a pluggable backend |
| Infisical + file-based secret injection | Better operator trust and lower leak risk | Adopt |
| Node 24 for production API | Lower-surprise hosted runtime | Assess |
| Honest single-node SQLite + backups | Best near-term operational posture | Adopt |
| PostgreSQL + Electric | Strongest long-term synced-state path | Assess after parity work |
| NATS JetStream | Useful only after real service decomposition | Hold for now |
| LiveStore | Interesting technology, wrong timing | Hold |

## Near-Term Target State

- One honest production story: a single-node control plane with a real Caddy front door, durable SSE, SQLite plus off-node backup, and no pretend multi-node claims.
- One coherent streaming model: stable IDs, explicit durability semantics, local hydration, visible reconnect state, and the same lifecycle rules across session view, plan view, task creation, and CLI monitoring.
- One trustworthy execution story: richer run states, sandbox continuity reporting, traceable startup failures, and review surfaces that emphasize file changes and phases over raw transcript theater.

## Reading Order

1. Start with `docs/research/opencode/00-executive-brief.md`.
2. Then read `docs/research/opencode/01-reality-check.md`.
3. Continue with `docs/research/opencode/02-technology-choices.md`.
4. Then read `docs/research/opencode/03-roadmap.md`.
5. Use `docs/research/opencode/04-implementation-backlog.md` to plan implementation order.
6. Use `docs/research/opencode/05-open-questions.md` for unresolved decisions and defaults.
7. Use `docs/research/opencode/06-execution-briefs.md` to draft issues and the first PRs.
8. Use `docs/research/opencode/07-phase-plan.md` to group the active queue into shippable milestones.
9. Use `docs/research/opencode/08-kickoff-checklist.md` to start the first implementation tranche.
10. Use `docs/research/opencode/09-validation-matrix.md` to verify the first tranche before moving on.
11. Use `docs/research/opencode/10-risk-register.md` to review tranche failure modes before merging major changes.
12. Use `docs/research/opencode/11-rollout-plan.md` to gate rollout and rollback decisions for the first tranche.
13. Use `docs/research/opencode/12-handoff-checklist.md` to hand the tranche to the team cleanly.

## Key Themes

- Fix semantics before scale.
- Improve recovery before adding features.
- Prefer technologies that make the product more honest, not just more modern.
- Separate good technology from good timing.
- Preserve AgentPane's differentiators instead of replacing them with generic agent stacks.
