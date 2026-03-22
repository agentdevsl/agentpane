# Implementation Map

Date: March 2026

This document maps the first implementation tranche to likely repo touchpoints.
It is not a promise that every file must change, but it gives the team a
practical starting map for `OC-005` and `OC-006`.

## Scope

- `OC-005` structured stream envelope
- `OC-006` opaque resume cursors

## File Map For `OC-005`

### `OC-005a` Shared schema definition

- Likely primary files:
  - `src/services/durable-streams.service.ts`
  - `src/lib/integrations/durable-streams/schema.ts`
- Likely new file(s):
  - a shared stream envelope schema module under `src/lib/streams/` or a nearby shared type location
- Why these files:
  - current event typing is concentrated in `durable-streams.service.ts`
  - durable-stream schema ownership is already called out in `src/lib/integrations/durable-streams/schema.ts`

### `OC-005b` Server emitter migration

- Likely primary files:
  - `src/lib/agents/chunk-batcher.ts`
  - `src/lib/agents/stream-handler.ts`
  - `src/services/session/session-stream.service.ts`
  - `src/services/durable-streams.service.ts`
  - `src/services/agent/agent-execution.service.ts`
- Possible adjacent files:
  - `src/services/plan-mode.service.ts`
  - `src/services/task-creation.service.ts`
- Why these files:
  - they appear to own or route chunk, lifecycle, and stream publication behavior

### `OC-005c` Client parser and identity migration

- Likely primary files:
  - `src/lib/streams/client.ts`
  - `src/app/hooks/use-session.ts`
  - `src/app/components/features/agent-session-view/use-stream-parser.ts`
  - `src/app/components/features/live-task-view/audit-trail-panel.tsx`
  - `src/app/components/features/plan-session-view/use-plan-session.ts`
- Why these files:
  - they appear to parse, adapt, or render streamed session events

### `OC-005d` Migration gate or compatibility boundary

- Likely primary files:
  - `src/lib/streams/client.ts`
  - `src/services/durable-streams.service.ts`
  - any new shared schema adapter module introduced during `OC-005a`
- Possible adjacent files:
  - `src/lib/task-creation/sync.ts`
  - `src/server/routes/task-creation.ts`
- Why these files:
  - they are likely candidates for central compatibility handling rather than scattered per-surface fallbacks

## File Map For `OC-006`

### `OC-006a` Preserve opaque cursor identity in the client stream layer

- Likely primary files:
  - `src/lib/streams/client.ts`
  - `src/app/hooks/use-session-subscription.ts`
  - `src/app/components/features/plan-session-view/use-plan-session.ts`
- Why these files:
  - these appear closest to raw durable stream subscription and resume handling

### `OC-006b` Remove reconnect-from-zero behavior

- Likely primary files:
  - `src/app/hooks/use-session.ts`
  - `src/lib/streams/client.ts`
- Why these files:
  - `useSession()` is already called out in the research as the main reconnect problem area

### `OC-006c` Catch-up compatibility and translation boundary

- Likely primary files:
  - `src/server/routes/sessions.ts`
  - `src/lib/streams/client.ts`
  - any catch-up helper or adapter introduced during implementation
- Why these files:
  - the compatibility boundary should exist in one place only, ideally near transport or route adaptation

### `OC-006d` Regression coverage

- Likely primary files:
  - `src/lib/agents/__tests__/chunk-batcher.test.ts`
  - tests near `src/lib/streams/client.ts`
  - tests near `src/app/hooks/use-session.ts`
- Likely new tests:
  - reconnect duplicate/gap regression tests
  - replay-with-opaque-cursor tests
- Why these files:
  - the highest-risk regression paths are emitter semantics and client reconnect behavior

## Recommended First Code Touches

If implementation starts tomorrow, these are the most likely first places to change:

1. `src/services/durable-streams.service.ts`
2. `src/lib/streams/client.ts`
3. `src/lib/agents/chunk-batcher.ts`
4. `src/app/hooks/use-session.ts`
5. `src/app/components/features/agent-session-view/use-stream-parser.ts`

## Things To Avoid

- Do not spread compatibility logic across every consumer.
- Do not let transcript rendering become the place where protocol migration is solved.
- Do not fix reconnect correctness only in `useSession()` if the raw client still drops cursor identity earlier.
- Do not treat task-creation event types as proof that the same migration logic already works for session streams.

## Suggested Work Breakdown

- Backend/schema owner:
  - `src/services/durable-streams.service.ts`
  - `src/lib/agents/chunk-batcher.ts`
  - shared schema module
- Client stream owner:
  - `src/lib/streams/client.ts`
  - `src/app/hooks/use-session.ts`
  - `src/app/hooks/use-session-subscription.ts`
- Transcript/rendering owner:
  - `src/app/components/features/agent-session-view/use-stream-parser.ts`
  - related session or audit rendering surfaces
- Validation owner:
  - reconnect, replay, duplicate, and gap regression coverage

## Related Docs

- `docs/research/opencode/06-execution-briefs.md`
- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/13-stream-envelope-proposal.md`
- `docs/research/opencode/14-cursor-migration-plan.md`
