# Frontend

## Summary
Stack: TanStack Start 1.167 + Router with `autoCodeSplitting`, TanStack DB, React 19 (`useEffectEvent`), Radix + Tailwind v4, Durable Streams. Shell wiring is good: root `errorComponent`, disciplined effect hooks, rAF-batched stream ingest, offset-based SSE resume, ref-counted shared EventSources. The prior readiness review (`specs/release_plan/08-frontend-readiness.md`) flagged 14 MB/484-chunk build, missing error boundaries on Kanban/designer/session-history, six `fallback={null}` sites, ~120 stray `console.*` calls, no global connectivity banner — **none shipped**; all five reproduce at HEAD. Design-token drift (`warning` classes as no-ops), hardcoded SVG hex, and an empty frontend test directory are new findings. No P0: the two `dangerouslySetInnerHTML` sites both consume Shiki-escaped output.

## Map
| Layer | Files | Purpose |
|-------|-------|---------|
| Router root | `src/app/routes/__root.tsx`, `src/app/router.tsx` | `createRootRouteWithContext`, `defaultPendingMs: 200`, `defaultPreload: 'intent'`, `RootErrorComponent` |
| Routes | `src/app/routes/*.tsx` (21 files) + nested codespaces/settings/sessions/events/folders/templates/terraform/catalog | File-based, auto code-split |
| UI primitives | `src/app/components/ui/*.tsx` (23 files) | Radix wrappers + CVA variants |
| Feature modules | `src/app/components/features/*` (~19) | Kanban, workflow designer, topology, session views, terraform, CLI monitor, memory |
| Hooks | `src/app/hooks/*.ts` (23 files) | `use-session`, `use-session-subscription` (ref-counted SSE), `use-topology-stream`, effect factories |
| Stream client | `src/lib/streams/{client,caddy-producer,envelope}.ts` | Exponential backoff, fatal-error classification, Zod validation, offset resume |
| Styling | `src/app/styles/globals.css` + `@tailwindcss/vite` | Light/dark CSS vars; tokens: accent/success/danger/attention/done/secondary/claude |
| Build | `vite.config.ts` | TanStack Router plugin + custom `serverOnlyStubs()` to keep Node modules out of the browser bundle |
| Markdown / code | `ui/markdown-content.tsx`, `terraform/terraform-right-panel.tsx` | `react-markdown` + Shiki (dynamic import), both feed `dangerouslySetInnerHTML` |

## What's working
- Root `errorComponent` + `notFoundComponent` catch what the three component boundaries (`TopologyErrorBoundary`, `CliMonitorErrorBoundary`, `MemoryTabErrorBoundary`) miss.
- `DurableStreamsClient` fatal/non-fatal classification: NOT_FOUND pre-connect non-fatal; `ALREADY_CONSUMED` stops retries; Zod validates events.
- `useSessionSubscription` ref-counts shared EventSources (FC-006). `useSession` rAF-batches flushes, caps `chunks` at `MAX_CHUNKS=5000`, and `seenEventIdsRef` dedupes on reconnect.
- `useEffectEvent` (React 19) stabilises callbacks without the classic "empty deps + ref" hack.
- `serverOnlyStubs()` cleanly keeps `better-sqlite3` and Claude Agent SDK out of the browser build.
- `use-session.ts` FC-020 comment documents the explicit choice to skip TanStack Query.
- Radix primitives deliver accessibility for free on dialogs / toasts / selects.

## Findings

### F08-01: Every prior readiness critical is still open
- **Priority**: P1
- **Observation**: `specs/release_plan/08-frontend-readiness.md` C1-C5 all reproduce at HEAD. `fallback={null}` in six sites (`routes/index.tsx:511`, `codespaces/index.tsx:477`, `codespaces/$codespaceId/index.tsx:467`, `workflow-designer/index.tsx:599`, `live-task-view/index.tsx:249`, `global-shortcuts.tsx:387`). 229 `console.*` calls across 62 `src/app` files. Only three component error boundaries. `ui/connection-status-banner.tsx` exists but is never mounted.
- **Risk**: Kanban render crash still wipes the route tree; blank panels on lazy-load; API outages produce inconsistent per-view errors.
- **Recommendation**: One PR: wrap Kanban / WorkflowDesigner / SessionHistory in boundaries, replace `fallback={null}` with skeletons, mount `ConnectionStatusBanner` at `__root.tsx`, strip `console.debug/log` via Vite define. Close the readiness doc.

### F08-02: Frontend test directory is empty
- **Priority**: P1
- **Observation**: `find src/app -name "*.test.*"` returns zero results. No component, hook, or route-loader tests. The `apiServerFetch<T>` double-wrap bug has a server-side test but 40+ frontend consumers have none. `use-session` rAF batching, seen-event dedupe, SSE reconnect state, Kanban DnD reorder, plan-approval transitions are all UI-untested.
- **Risk**: Regressions land silently. Refactors to `use-session.ts` or `DurableStreamsClient` can break streaming without a CI signal.
- **Recommendation**: Stand up Vitest + `@testing-library/react` + `jsdom`. Seed three tests: (a) `use-session` dedupe across reconnect, (b) flat-array shape of `apiClient.sessions.listEvents()`, (c) `TopologyErrorBoundary` recovers. Add `src/app` to the 3-way Vitest shard split.

### F08-03: `warning` Tailwind classes are silent no-ops
- **Priority**: P2
- **Observation**: `globals.css` defines `--attention-*` but no `--warning-*`. Yet `bg-warning`, `text-warning`, `border-warning`, `bg-warning-muted`, `text-warning-fg` are used in 11+ files on hot paths: `container-agent-panel/container-agent-stream.tsx`, `container-agent-header.tsx` (status badge + reconnecting icon), `agent-session-view/{header-bar,stream-line,activity-sidebar,stream-panel}.tsx`, `folder-rail/index.tsx:207`, `new-project-dialog.tsx:1450-1454`, `project-settings.tsx:424-427`. CLAUDE.md explicitly says "design system uses `attention` not `warning`".
- **Risk**: Paused / cancelled / reconnecting states render invisibly — users can't see that an agent is paused or a connection degraded.
- **Recommendation**: Codemod `warning` -> `attention`; add a Biome rule forbidding `\b(bg|text|border)-warning\b`. Visually QA `agent-session-view/*`.

### F08-04: Hardcoded SVG hex colours violate the theme contract
- **Priority**: P2
- **Observation**: CLAUDE.md bans hex in SVG. 40+ violations: `settings-sidebar.tsx:159-207`, `sidebar.tsx:289`, `folder-rail/index.tsx:104-150`, `terraform/terraform-dependency-edge.tsx`, `agent-topology/edges/agent-edge-markers.tsx`, `ai-action-button.tsx:64-83`. Most are GitHub dark-palette literals that look right in dark mode, wrong in light.
- **Risk**: Sidebar / folder rail / topology edges jar in light theme; palette changes need grep-and-replace instead of token edits.
- **Recommendation**: Replace with `var(--{accent,done,success,secondary,attention}-emphasis)`. Extend the Biome rule from F08-03 to flag hex inside `.tsx` under `src/app/components/**`.

### F08-05: Shiki v4 language loading strategy needs runtime verification
- **Priority**: P2
- **Observation**: PR #160 upgraded Shiki v3 -> v4. `markdown-content.tsx:13` and `terraform-right-panel.tsx:131` both call `import('shiki')` at module scope — triggers on module evaluation, not first use. Readiness doc saw `emacs-lisp` (780 KB), `cpp` (626 KB), `wasm` (622 KB) chunks in `dist/`; whether they are eager-preloaded or lazy on `codeToHtml` depends on v4 internals and needs confirming.
- **Risk**: If preloaded, 1.4 MB+ of unused grammars on first code-block render.
- **Recommendation**: Check Network tab on a cold markdown render. If eager, switch to `createHighlighter({ langs: [...] })` with an allowlist (typescript, javascript, json, yaml, hcl, markdown, python, bash). Move the `import('shiki')` inside `MarkdownCodeBlock`'s effect so markdown-without-code doesn't touch Shiki.

### F08-06: `elk.bundled` (1.45 MB) lazy only for topology; check workflow designer
- **Priority**: P2
- **Observation**: `AgentTopologyInner` is `React.lazy()` — correct. Workflow designer (`features/workflow-designer/index.tsx`) is not lazy and uses React Flow; if it transitively imports `elkjs`, the 1.45 MB chunk becomes eager on that route. `vite.config.ts` also lists `elkjs/lib/elk.bundled.js` in `optimizeDeps.include`.
- **Risk**: 1.45 MB mandatory download on first visit to the designer route.
- **Recommendation**: Run `rollup-plugin-visualizer` to confirm import edges. If designer imports `elkjs`, wrap its graph in `React.lazy`. Drop `elkjs/lib/elk.bundled.js` from `optimizeDeps.include` unless dev cold-start regresses.

### F08-07: Stream event contract is stringly-typed on the client
- **Priority**: P2
- **Observation**: `DurableStreamsClient` returns Zod-validated events, but `use-session.ts` / `use-topology-stream.ts` / `use-container-agent.ts` branch on `event.type === 'agent:completed'` with no exhaustive union check. If the server renames an event type (has happened with task columns), the client silently no-ops. No shared `StreamEvent` discriminated union covers both sides.
- **Risk**: Event-schema drift between `stream-handler.ts` and client hooks — silent-drop.
- **Recommendation**: Define the event union once in a shared module; backend uses `satisfies StreamEvent`, clients use a `switch` with `never` exhaustive check.

### F08-08: Two `dangerouslySetInnerHTML` sites — Shiki, safe today but no defence in depth
- **Priority**: P2
- **Observation**: Audit returned exactly two: `ui/markdown-content.tsx:82` and `terraform/terraform-right-panel.tsx:242`. Both pass Shiki `codeToHtml` output with biome-ignore comments citing Shiki's escape guarantee — which is why P2 not P0. But both sinks carry user-derived content (agent markdown, generated HCL, task descriptions). A Shiki CVE, transformer plugin change, or highlighter migration reopens the risk silently.
- **Risk**: Zero-day XSS if Shiki escaping regresses; invisible foot-gun for future refactors.
- **Recommendation**: Add a `sanitizeShikiHtml(html)` helper (DOMPurify with an allowlist of `pre`/`code`/`span`) and call at both sites. Redundant today, defensive forever.

### F08-09: No per-route `errorComponent` — route crash unmounts the shell
- **Priority**: P2
- **Observation**: `__root.tsx` has `errorComponent: RootErrorComponent`. No per-route `errorComponent` anywhere in `src/app/routes/`. TanStack Router supports them; today a thrown error in e.g. `codespaces/$codespaceId/git.tsx` unmounts the whole shell.
- **Risk**: Users lose nav context on a single failed fetch.
- **Recommendation**: Add `errorComponent` to the top routes (codespaces detail/list, sessions detail, terraform, designer, memory) via a shared `RouteErrorBoundary`.

### F08-10: State-management stack is three layers with no documented boundary
- **Priority**: P3
- **Observation**: TanStack DB is a core dep, but grep finds **one** consumer: `use-sandbox-status.ts`. Everything else is `useState`/`useReducer` (835 uses across 144 files) + manual `apiClient.*` fetches. `use-session.ts` FC-020 documents skipping TanStack Query, but no guidance exists for when to pick which of the three effective tiers.
- **Risk**: Future features pick different stacks; consolidation later is expensive.
- **Recommendation**: Either commit to TanStack DB for reactive lists (tasks, codespaces, agents) or drop it. Document the tiers in `specs/application/implementation/state-management.md`.

### F08-11: `apiServerFetch<T>` double-wrap has a test server-side but nothing on the client
- **Priority**: P3
- **Observation**: CLAUDE.md documents the trap ("`T` must match the `data` field value, NOT the full response"). A future caller writing `apiServerFetch<{ ok: true; data: Task[] }>` compiles, runs, and returns `undefined.data` at runtime. No lint rule catches it and the client has no test.
- **Risk**: Re-introduction of the exact bug the CLAUDE.md lesson exists to prevent.
- **Recommendation**: Rename the wrapper to `apiServerFetchData<T>` (codemod) so `T` is unambiguous; or add a Biome / ts-morph check that rejects `{ ok: ...; data: ... }` as the type argument to `apiServerFetch`.

### F08-12: Provider ordering in `__root.tsx` is load-bearing but undocumented
- **Priority**: P3
- **Observation**: `RootComponent` nests `ShortcutsProvider -> FolderContextProvider -> CodespaceContextProvider -> TooltipProvider`. `GlobalShortcutsWithPicker` renders outside `CodespaceContextProvider`. No comment or test explains the ordering constraints; future additions will be inserted at the wrong level.
- **Risk**: "undefined is not a function" on provider hooks when new context is added out of order.
- **Recommendation**: Collapse into a single `AppProviders` component with a block comment describing ordering, covered by a lightweight render-without-throwing smoke test.

### F08-13: HMR cold-start of 235+ modules is developer-hours friction
- **Priority**: P3
- **Observation**: CLAUDE.md calls the `[Violation] 'message' handler took Nms` noise dev-only; root cause is heavy named imports (dnd-kit, React Flow, Shiki, Phosphor, Radix, react-markdown) combined with `optimizeDeps.include` pre-bundling only three packages.
- **Risk**: Not user-facing, but significant productivity drag.
- **Recommendation**: Add top frontend deps (Phosphor, Radix, react-markdown, dnd-kit) to `optimizeDeps.include`; measure with `DEBUG=vite:deps`.

## Cross-refs
- Remediation status should roll back into `specs/release_plan/08-frontend-readiness.md`.
- Token findings (F08-03/F08-04) overlap `specs/application/implementation/component-patterns.md`.
- Event drift (F08-07) connects to `specs/arch_review_april/05-events.md`; tests (F08-02) to `09-testing.md`.
