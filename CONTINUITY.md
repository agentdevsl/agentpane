## Goal (incl. success criteria)

- Debug the current UI freeze, identify the root cause, and fix the affected project UI and topology view without regressing existing behavior.
- Success criteria: the freeze is reproducible before the fix, the root cause is addressed in code, targeted regression coverage exists, and relevant validation passes.

## Constraints/Assumptions

- Use Bun for commands.
- Follow TDD: add regression tests before implementation changes.
- Do not revert unrelated user changes in the dirty worktree.
- Root cause is currently UNCONFIRMED; investigate first and keep the fix scoped to the freezing UI path.

## Key decisions

- Preserve prior fixes unless the freeze investigation proves they are causal.
- Start by reproducing the freeze and inspecting likely render/subscription hot paths before changing behavior.
- Treat shared stream consumers as the primary investigation path because topology and container-agent views freeze during live updates.

## State

- In progress; current live regressions are (1) container-agent log streaming not visible and (2) topology tabs showing the empty-state message (`No subagent topology yet`), which suggests topology events are not reaching the UI in the active execution path.

## Done

- Read the continuity ledger and spec updates.
- Captured the new task to investigate the UI freeze.
- Inspected the projects routes, shared layout, project context, sidebar, project picker, and globally mounted shortcut/dialog wiring.
- Brought up the local dev stack successfully.
- Identified the leading freeze suspect: app-wide dialog open/close state churn caused by overlapping `Escape` handlers and wrapper `onOpenChange` flows in the global project picker/new-project path.
- Added a regression assertion proving duplicate project-picker close callbacks on `Escape` before the fix.
- Removed duplicate `Escape` close handlers from `GlobalShortcutsWithPicker`, `ProjectPicker`, and `NewProjectDialog`, leaving Radix dialog state as the single close authority.
- Re-ran targeted component tests; project picker and new-project dialog tests now pass.
- Re-ran `bun run typecheck` and `bun run check`; typecheck passes and Biome still reports only existing info-level `noLeakedRender` diagnostics.
- Ran broader UI/E2E coverage for project-facing flows via `bun run test:ui tests/e2e/project-workflow.test.ts tests/e2e/components/dialogs.test.ts tests/e2e/components/navigation.test.ts tests/e2e/components/shortcuts.test.ts`; all 51 tests across 4 files passed.
- Created commit `c82a99f` for the dialog close-handling fix.
- User confirmed the issue also affects the topology view, indicating the freeze is broader than the projects dialog flow.
- Inspected shared stream consumers and current dirty performance diffs.
- Confirmed `useTopologyStream` already batches topology progress updates with `requestAnimationFrame`, while `useContainerAgent` still calls `setState` on every streamed token and `ContainerAgentPanel` keeps that hook mounted even when the topology tab is active.
- Confirmed the Durable Streams SDK packages are already installed locally (`@durable-streams/client@0.2.1`, `@durable-streams/server@0.2.2`, `@durable-streams/state@0.2.0`); no extra download is needed.
- Confirmed dev mode proxies `/v1/stream/*` through Vite to the local `DurableStreamTestServer` on `:3002`, so dev-only stream availability/reconnect behavior is relevant to the freeze investigation.
- Verified both proxied `http://localhost:3000/v1/stream` and direct `http://localhost:3002/v1/stream` return durable-streams 404 headers in dev, so stream availability detection is working as designed.
- Added `tests/components/container-agent-panel.test.tsx` proving token-only stream updates were rerendering the topology tab.
- Fixed the regression by memoizing the topology tab shell inside `src/app/components/features/container-agent-panel/container-agent-panel.tsx`, preventing token-driven parent rerenders from remounting or rerendering the topology subtree.
- Re-ran targeted regression tests and `bun run typecheck`; they pass.
- User reported the same problem also affects the sessions topology tab, so investigation expanded to `src/app/components/features/agent-session-view/index.tsx` and related session stream consumers.
- User later confirmed session topology is fixed, narrowing the remaining issue back to the projects page / project summaries path.
- User reported a new regression: container-agent log streaming is not visible.
- User reported the topology panel is showing the empty state instead of live subagent topology.

## Now

- Trace the active container-agent execution path for missing token/topology events, add regression coverage, and fix event delivery before resuming project-list performance work.

## Next

- After restoring visible log streaming and topology events, return to the project summaries/polling performance validation.

## Open questions (UNCONFIRMED if needed)

- UNCONFIRMED: whether the remaining projects-page freeze is fully explained by project-summary polling/API pressure, or whether there is still an additional render hotspot in the projects UI.

## Working set (files/ids/commands)

- `CONTINUITY.md`
- `SPEC_UPDATES.md`
- `git status --short`
- `/tmp/agentpane-dev.log`
- `scripts/start-dev.ts`
- `src/app/routes/__root.tsx`
- `src/app/components/features/global-shortcuts.tsx`
- `src/app/components/features/project-picker/index.tsx`
- `src/app/components/features/project-picker/use-project-picker.ts`
- `src/app/components/features/new-project-dialog.tsx`
- `src/app/providers/project-context.tsx`
- `src/app/hooks/use-keyboard-shortcuts.ts`
- `tests/components/project-picker.test.tsx`
- `tests/components/new-project-dialog.test.tsx`
- `src/app/components/features/project-picker/use-project-picker.ts`
- `bun run test tests/components/project-picker.test.tsx tests/components/new-project-dialog.test.tsx`
- `bun run typecheck`
- `bun run check`
- `scripts/run-ui-tests.ts`
- `bun run test:ui tests/e2e/project-workflow.test.ts tests/e2e/components/dialogs.test.ts tests/e2e/components/navigation.test.ts tests/e2e/components/shortcuts.test.ts`
- `src/app/components/features/project-card.tsx`
- `src/app/routes/index.tsx`
- `src/app/routes/projects/index.tsx`
- `src/lib/streams/client.ts`
- `src/lib/bootstrap/phases/streams.ts`
- `scripts/start-streams-server.ts`
- `vite.config.ts`
- `src/app/hooks/use-container-agent.ts`
- `src/app/components/features/container-agent-panel/container-agent-panel.tsx`
- `src/app/components/features/container-agent-panel/container-agent-stream.tsx`
- `tests/components/container-agent-panel.test.tsx`
- `src/app/hooks/use-topology-stream.ts`
- `tests/components/project-card.test.tsx`
- `tests/api/projects.test.ts`
- `tests/server/api-handlers.test.ts`
- `src/app/hooks/use-container-agent.ts`
- `src/app/components/features/container-agent-panel/container-agent-stream.tsx`
- `src/app/components/features/container-agent-panel/container-agent-panel.tsx`
- `agent-runner/src/index.ts`
- `agent-runner/src/event-emitter.ts`
- `agent-runner/src/agentcore-handler.ts`
- `src/lib/agents/container-bridge.ts`
- `src/lib/agents/agentcore-bridge.ts`
- `src/server/routes/projects.ts`
- `git status --short`
