# Event Inventory

Date: March 2026

This document inventories the current event landscape for `OC-005` and maps it
to the proposed structured stream envelope.

## Purpose

- Show where event sprawl exists today.
- Highlight the difference between current event typing and the proposed shared envelope.
- Give implementation work a migration checklist for event families.

## Current Typed Event Families

From `src/services/durable-streams.service.ts:410`, the current typed event map includes:

- Plan events
  - `plan:started`
  - `plan:turn`
  - `plan:token`
  - `plan:interaction`
  - `plan:completed`
  - `plan:error`
  - `plan:cancelled`
- Sandbox events
  - `sandbox:creating`
  - `sandbox:ready`
  - `sandbox:idle`
  - `sandbox:stopping`
  - `sandbox:stopped`
  - `sandbox:error`
  - `sandbox:tmux:created`
  - `sandbox:tmux:destroyed`
- Task creation events
  - `task-creation:started`
  - `task-creation:message`
  - `task-creation:token`
  - `task-creation:suggestion`
  - `task-creation:questions`
  - `task-creation:processing`
  - `task-creation:completed`
  - `task-creation:cancelled`
  - `task-creation:error`
- Container agent events
  - `container-agent:status`
  - `container-agent:started`
  - `container-agent:token`
  - `container-agent:turn`
  - `container-agent:tool:start`
  - `container-agent:tool:result`
  - `container-agent:message`
  - `container-agent:complete`
  - `container-agent:error`
  - `container-agent:cancelled`
  - `container-agent:task-update-failed`
  - `container-agent:plan_ready`
  - `container-agent:worktree`
  - `container-agent:file_changed`
- Topology events
  - `topology:agent_spawned`
  - `topology:agent_progress`
  - `topology:agent_completed`
- Terraform events
  - `terraform:status`
  - `terraform:text`
  - `terraform:modules`
  - `terraform:questions`
  - `terraform:code`
  - `terraform:done`
  - `terraform:error`

## Current Generic Event Shape

From `src/services/durable-streams.service.ts:485`:

```ts
interface StreamEvent<T = unknown> {
  id: string
  type: StreamEventType
  timestamp: number
  data: T
  offset?: number
}
```

Current gaps relative to `OC-005`:

- no explicit `schemaVersion`
- no explicit `blockId`
- no explicit `partType`
- no explicit `durability`
- no explicit per-block `sequence`
- `offset` is present as numeric-ish metadata while durable stream transport itself uses opaque string cursors elsewhere

## Proposed Mapping To Envelope Concepts

| Current event family | Likely `partType` direction | Likely `blockId` usage | Durability note |
| --- | --- | --- | --- |
| `plan:token` | `chunk_delta` | group within a plan-output block | usually starts `transient` |
| `container-agent:token` | `chunk_delta` | group within an agent-output block | usually starts `transient` |
| `task-creation:token` | `chunk_delta` | group within task-creation assistant output | usually starts `transient` |
| `container-agent:tool:start` | `tool_start` | tool-call block | likely durable only after persistence |
| `container-agent:tool:result` | `tool_result` | tool-call block | durable only when replay-safe |
| `terraform:text` | `chunk_delta` or `system` depending on semantics | terraform output block | likely mixed |
| `container-agent:error` | `lifecycle` or `system` | optional block | should not imply durability automatically |
| `container-agent:file_changed` | `diff` | file-change block | likely durable if persisted |
| `plan:started` / `completed` | `lifecycle` | usually standalone | often durable after persistence |

## Current Hotspots That Still Synthesize Identity

- `src/app/components/features/agent-session-view/use-stream-parser.ts:159`
  - chunk line identity is synthesized from timestamp, agent, and index
- `src/app/components/features/agent-session-view/use-stream-parser.ts:164`
  - tool identity uses tool ID plus index
- `src/app/components/features/agent-session-view/use-stream-parser.ts:169`
  - terminal identity uses timestamp, type, and index
- `src/app/components/features/live-task-view/audit-trail-panel.tsx`
  - several stream item IDs fall back to offset or timestamp-based composition

These are exactly the places the new envelope should simplify.

## Migration Inventory For `OC-005`

### Must migrate first

- `container-agent:token`
- `container-agent:tool:start`
- `container-agent:tool:result`
- `container-agent:message`
- any core session chunk or tool stream path consumed by `useSession()`

### Should migrate early

- `plan:*`
- `task-creation:*`
- `terraform:*`

### Can follow after the first pass if needed

- topology status/progress events that are not on the main transcript-critical path
- lower-frequency sandbox lifecycle events, as long as the compatibility boundary stays explicit

## Inventory Questions To Answer In Implementation

- Which current event families are true transcript blocks versus standalone lifecycle markers?
- Which event families need `sequence` and which can safely use `null`?
- Which currently separate event names should become one `partType` family with different payloads?
- Which surfaces can continue to consume adapted legacy shapes during migration, and where is that adaptation allowed?

## Related Docs

- `docs/research/opencode/13-stream-envelope-proposal.md`
- `docs/research/opencode/15-implementation-map.md`
