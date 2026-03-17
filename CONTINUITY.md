## Goal (incl. success criteria)

- Debug the current UI freeze, identify the root cause, and fix the affected project UI without regressing existing behavior.
- Success criteria: the freeze is reproducible before the fix, the root cause is addressed in code, targeted regression coverage exists, and relevant validation passes.

## Constraints/Assumptions

- Use Bun for commands.
- Follow TDD: add regression tests before implementation changes.
- Do not revert unrelated user changes in the dirty worktree.
- Root cause is currently UNCONFIRMED; investigate first and keep the fix scoped to the freezing UI path.

## Key decisions

- Preserve prior fixes unless the freeze investigation proves they are causal.
- Start by reproducing the freeze and inspecting likely render/subscription hot paths before changing behavior.

## State

- In progress; preparing a scoped commit for the UI freeze fix and its regression coverage.

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

## Now

- Stage only the freeze-fix files, excluding unrelated worktree changes and generated screenshots.

## Next

- Create the commit and confirm the remaining worktree state.

## Open questions (UNCONFIRMED if needed)

- UNCONFIRMED: exact user-visible reproduction path, but current evidence indicates the projects UI is disproportionately affected because the problematic dialogs/context are mounted at app root and used from project-facing views.

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
