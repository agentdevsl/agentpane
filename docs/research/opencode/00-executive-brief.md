# Executive Brief

Date: March 2026

This is the shortest planning version of the OpenCode research set.

## Bottom Line

- AgentPane does not need a framework rewrite first. It needs more honest system behavior.
- The biggest current user-trust problems are deployment mismatch, weak stream semantics, fragile reconnect behavior, and long-session transcript slowdown.
- Users can currently see live output that is not yet durable, refresh into weaker truth than they just saw, and lose confidence exactly when sessions get long.

## What Matters Most

1. Production topology is not honest yet.
   - `Caddyfile` and the durable-streams docs describe Caddy as the front door.
   - The Helm deployment currently exposes Bun on `:3001` instead.
2. Stream semantics are not strong enough yet.
   - Hot chunk delivery is realtime-first in `src/lib/agents/chunk-batcher.ts`.
   - Stable event identity and durable/transient distinction are still missing.
3. Reconnect correctness is not trustworthy yet.
   - The stream client drops opaque offset identity and `useSession()` still falls back to reconnect-from-zero behavior.
4. Transcript performance degrades with session length.
   - The current path still does array copies, merge-sorts, and full DOM rendering for long transcripts.

## Active Plan

The current execution queue is:

1. `OC-001` Align production front door topology.
2. `OC-004` Expose honest live health states.
3. `OC-005` Adopt a structured stream envelope.
4. `OC-006` Preserve opaque resume cursors end-to-end.
5. `OC-008` Replace full transcript rebuilds with append-only timelines and virtualization.
6. `OC-007` Add Dexie-backed durable session hydration.

This order is intentional.

- Fix deployment truth first.
- Then make live-state UX honest.
- Then define the stream contract.
- Then make reconnect correct.
- Then improve transcript performance.
- Then add local durable hydration on top of stable semantics.

## Deferred For Now

- `OC-002` Remove sandbox env token injection.
- `OC-003` Default hosted sandboxes to gVisor.

These still matter, but they are not in the active implementation queue right now.

## Best First Three PRs

1. `OC-001a` + `OC-001b`
   - Choose the canonical front door and align Helm plus docs.
2. `OC-004a` + `OC-004b`
   - Define shared live-health states and apply them to the main session view.
3. `OC-005a`
   - Define the structured stream envelope before deeper server/client migration work.

## Success Looks Like

- Docs and deployment describe the same production entrypoint.
- Users can tell whether output is live, reconnecting, catching up, degraded, or broken.
- Reconnect no longer depends on lossy numeric offsets.
- Long transcripts stay responsive.
- Refresh restores useful durable transcript state quickly.

## What Not To Do Next

- Do not mix topology cleanup with protocol redesign in the same PR.
- Do not add Dexie hydration before stable stream identity and resume semantics exist.
- Do not virtualize transcript panes while line identity is still synthetic.
- Do not add surface-level health labels that the backend cannot support honestly.
