## Goal (incl. success criteria)

- Fix high-severity code review findings in stream subscription lifecycle and Terraform registry settings.
- Success criteria: connection state is correct for shared late subscribers, reconnect ownership is not duplicated, Terraform settings hydrate correctly on first render, Terraform token persistence is atomic and encrypted, and targeted regression tests pass.

## Constraints/Assumptions

- Use Bun for commands.
- Follow TDD: add regression tests before implementation changes.
- Do not revert unrelated user changes in the dirty worktree.
- Keep Terraform UI scope minimal-risk for this pass; do not expand to full multi-registry UX unless required for correctness.

## Key decisions

- Fix stream lifecycle centrally in `src/lib/streams/client.ts` and keep hooks as consumers of explicit connection-state updates.
- Move Terraform token persistence into Terraform-specific server routes/service instead of `/api/settings`.
- Use per-registry encrypted token settings and keep registry read responses token-free, exposing `hasToken` metadata only.
- Enforce admin-only access for Terraform mutating routes within the route module.

## State

- In progress; core fixes and targeted regressions are implemented.

## Done

- Reviewed modified files with subagents.
- Identified high-severity issues in stream lifecycle and Terraform settings/persistence.
- Collected relevant implementation context from client, hooks, service, routes, schema, auth, and tests.
- Added targeted regression tests for stream subscriptions, Terraform settings UI, Terraform route auth/response shape, and Terraform registry encrypted token persistence.
- Implemented explicit stream connection-state callbacks with late-subscriber hydration in `src/lib/streams/client.ts` and updated consuming hooks.
- Implemented Terraform token persistence via Terraform domain APIs, added `hasToken` response metadata, and enforced admin-only mutating Terraform routes.
- Fixed Terraform settings panel initial hydration and token replacement UX.
- Verified targeted tests pass and `bun run typecheck` passes.

## Now

- Record outcomes and note remaining validation constraint from repo-wide Biome config/findings.

## Next

- Update `SPEC_UPDATES.md` with the Terraform settings/API corrections.
- Optionally run broader test coverage if requested.

## Open questions (UNCONFIRMED if needed)

- UNCONFIRMED: whether a broader Terraform multi-registry UI refactor is desired later; current pass keeps UI scope narrow.

## Working set (files/ids/commands)

- `src/lib/streams/client.ts`
- `src/app/hooks/use-session.ts`
- `src/app/hooks/use-agent-stream.ts`
- `src/app/hooks/use-container-agent.ts`
- `src/app/hooks/use-topology-stream.ts`
- `src/app/components/features/terraform/terraform-settings-panel.tsx`
- `src/services/terraform-registry.service.ts`
- `src/server/routes/terraform.ts`
- `src/lib/terraform/schema.ts`
- `src/lib/terraform/types.ts`
- `src/lib/api/client.ts`
- `tests/lib/streams/client.test.ts`
- `tests/services/terraform-registry.service.test.ts`
- `tests/routes/terraform.test.ts`
- `tests/components/terraform-settings-panel.test.tsx`
- `tests/helpers/database.ts`
- `bun run test tests/lib/streams/client.test.ts tests/services/terraform-registry.service.test.ts tests/routes/terraform.test.ts tests/components/terraform-settings-panel.test.tsx`
- `bun run typecheck`
- `bun run check` (blocked by pre-existing Biome schema mismatch and unrelated nursery diagnostics)
