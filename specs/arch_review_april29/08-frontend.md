# 08 — Frontend (April 29 Review)

## Summary
HEAD `25c1c4f0` (April 29 2026). Stack: TanStack Start 1.167 + Router with `autoCodeSplitting`, TanStack DB 0.6 (mostly idle), React 19.2 (`useEffectEvent` only — no `useTransition`/`useOptimistic`/`useFormStatus`/`useActionState`/`use()` anywhere), Radix + Tailwind v4, Durable Streams 0.2.3, Phosphor icons. PR #176 (April 21) closed F08-01 (boundaries + connection banner + Suspense skeletons), F08-02 (test infra + 5 frontend test files), F08-08 (DOMPurify on Shiki output). PR #179 (April 21) tightened lint rules but did not touch UI. **Findings F08-03 (warning tokens), F08-04 (SVG hex), F08-05 (eager Shiki), F08-06 (elkjs optimizeDeps), F08-07 (event union), F08-09 (per-route errorComponent), F08-10 (TanStack DB sprawl), F08-12 (provider ordering)** all still reproduce at HEAD with new evidence. This review adds eight new findings: React 19 idiom adoption is stalled; `forwardRef` is legacy in 24 files; the folder context value re-publishes on every drag-frame; `useSessionData`/`session collections` are dead code (~600 lines of TanStack DB scaffolding with one upstream consumer); 10 sites still use `window.confirm`; container-agent-panel tabs lack ARIA roles; `validateSearch` is missing on `/designer`; sandbox-status collection grows unbounded as the user navigates between codespaces. No P0. Two P1s carried over from April 20.

## Map
| Layer | Files | Purpose |
|-------|-------|---------|
| Router root | `src/app/routes/__root.tsx`, `src/app/router.tsx` | `createRootRouteWithContext`, `defaultPendingMs: 200`, root `errorComponent`, root `notFoundComponent`, mounts `ConnectionStatusBanner` |
| Routes | `src/app/routes/*.tsx` (45 files across 11 sub-trees) | File-based, auto code-split, 16 with loaders, 1 with `useSearch`, 0 with `validateSearch` |
| Providers | `src/app/providers/{bootstrap,codespace-context,folder-context,shortcuts-provider}.tsx` | Bootstrap → ServiceProvider → Shortcuts → Folder → Codespace → Tooltip |
| Shell | `src/app/components/features/layout-shell.tsx` | Fixed shell (FolderRail / FolderPanel / NavPanel / main grid) |
| UI primitives | `src/app/components/ui/*.tsx` (30 files) | Radix wrappers + CVA variants; 8 use legacy `forwardRef` |
| Feature modules | `src/app/components/features/*` (~25 directories, 90+ files) | Kanban, workflow designer, topology, session views, terraform, CLI monitor, memory |
| Hooks | `src/app/hooks/*.ts` (24 files) | `use-session` (rAF-batched, `MAX_CHUNKS=5000`, dedupe via `seenEventIdsRef`), `use-session-subscription` (ref-counted SSE), `use-topology-stream`, `use-global-connection-status` (new in #176), `use-task-operations` |
| TanStack DB | `src/lib/{sessions,task-creation,sandbox-status,cli-monitor}/collections.ts` | 12 collections defined; only `sandboxStatusCollection` actively rendered into UI; `sessions/*` collections + `useSessionData` are dead code |
| Stream client | `src/lib/streams/{client,caddy-producer,envelope}.ts` | Backoff, fatal classification, Zod validation, offset resume |
| Tests | `src/app/__tests__/{api-client-shape,connection-status-banner,error-boundary,session-dedupe,suspense-fallbacks}.test.tsx` + `src/app/components/ui/__tests__/highlighted-code.test.tsx` (6 files / ~25 tests) | Seed coverage from #176 |
| Build | `vite.config.ts` | `serverOnlyStubs()` keeps `better-sqlite3`/SDK out of the browser; `optimizeDeps.include: ['@xyflow/react','elkjs/lib/elk.bundled.js','@durable-streams/client']` |

## What's working
- Root `errorComponent` + `notFoundComponent` are wired; `KanbanBoard` / `WorkflowDesigner` / `SessionHistory` are wrapped in the shared `ErrorBoundary` (`error-boundary.tsx:30`). Topology has its own boundary (`agent-topology/index.tsx:25-54`); memory view has `MemoryTabErrorBoundary`.
- `ConnectionStatusBanner` is mounted at the shell (`__root.tsx:79`) driven by `useGlobalConnectionStatus` (5 s timeout, 2-failure debounce, 60 s poll backstop). Three regression tests cover it (`connection-status-banner.test.tsx`).
- `apiServerFetch<T>` shape contract is now tested client-side (`api-client-shape.test.tsx`) with explicit guards against the double-wrap (`{ ok: true; data: T }` as `T`).
- `useSession` rAF-batches stream ingest, caps `chunks` at `MAX_CHUNKS=5000`, dedupes via `seenEventIdsRef`, surfaces `truncated` / `truncatedCount` for "load earlier" UX. Reducer is exported as `applyPendingSessionUpdates` and unit-tested (`session-dedupe.test.tsx`).
- `useSessionSubscription` ref-counts shared `EventSource` connections (FC-006).
- `useEffectEvent` (React 19) is used for stable-callback scenarios in `use-session.ts`, `use-session-subscription.ts`, no classic "ref + empty deps" anti-pattern.
- `serverOnlyStubs()` Vite plugin cleanly substitutes `better-sqlite3` and Claude Agent SDK for browser builds; `BootstrapProviderInner` dynamic-imports server services only on the server (`bootstrap-provider.tsx:54-74`).
- Shiki output is sanitised through DOMPurify in `HighlightedCode` (`highlighted-code.tsx:54-56`) — defence-in-depth landed.
- Per-route Suspense fallbacks (`DialogLoadingFallback`, `PanelLoadingFallback`) replace the prior six `fallback={null}` sites and carry `aria-busy="true"` regions.
- Topology re-renders are split: `structureVersion` triggers ELK relayout, `dataVersion` patches node/edge data without re-layout. Field-by-field equality short-circuits unchanged data (`agent-topology.tsx:84-100`). `AgentTopologyInner` is `React.lazy()`.
- Radix primitives (Dialog, Tabs, Tooltip, Toast, Switch, Select) deliver accessibility for free where they're used.

## Findings

### F08-01: Tailwind `warning` tokens are still silent no-ops
- **Priority**: P1
- **Status**: Carry-over from April 20 F08-03 — *not* resolved.
- **Size**: S
- **Observation**: `globals.css` defines `--attention-fg/-emphasis/-muted/-subtle` (5 hits) and zero `--warning-*` custom properties. Yet `bg-warning`, `text-warning`, `border-warning`, `bg-warning-muted`, `bg-warning-subtle`, `bg-warning/{N}` are used in 15 files / 24+ sites on hot paths. Concrete examples (`path:line` verified):
  - `src/app/components/features/folder-rail/index.tsx:207` — folder rail status pip uses `bg-warning shadow-[0_0_6px_rgba(234,179,8,0.4)]`.
  - `src/app/components/features/sidebar.tsx:451` — health dot `bg-warning` for degraded API.
  - `src/app/components/features/agent-session-view/{header-bar.tsx:26,43, stream-line.tsx:30,68,69,135, activity-sidebar.tsx:55, stream-panel.tsx:39,40}` — paused / thinking states.
  - `src/app/components/features/container-agent-panel/container-agent-header.tsx:49,67,210` — cancelled status badge + reconnecting Wi-Fi icon `text-warning animate-pulse`.
  - `src/app/components/features/container-agent-panel/container-agent-stream.tsx:220,221` — error banner `border-warning/30 bg-warning/10 text-warning`.
  - `src/app/components/features/new-project-dialog.tsx:1450,1453,1454` — submission warning row.
  - `src/app/components/features/project-settings.tsx:425,428` — custom-codespace warning banner.
  - `src/app/components/features/session-history/components/{stream-entry.tsx:141, tool-calls-full-view.tsx:151,153}` — session history badges.
  - `src/app/components/features/live-task-view/audit-trail-panel.tsx:149` — audit trail warning row.
  - CLAUDE.md "Tailwind Color Token Names" section explicitly says: "The design system uses `attention` not `warning`."
- **Risk**: Paused / cancelled / reconnecting / degraded states render without any colour because Tailwind v4 doesn't fail when a token is missing — it emits the literal class with no rule, so `bg-warning` is invisible. Users cannot see that their agent is paused, that the connection is reconnecting, or that the sandbox is in trouble.
- **Recommendation**: Two-line fix per file plus a Biome rule. (a) Codemod `\b(bg|text|border)-warning(\b|-|\/)` → `attention`. (b) Add a Biome `noRestrictedClassnames` (or a Semgrep rule) listing `bg-warning`, `text-warning`, `border-warning`, `bg-warning-(muted|subtle|emphasis)`, `text-warning-(fg|muted)`, `border-warning-(muted|subtle|emphasis)`. (c) Spot-check the agent session view, container-agent header, and folder rail on dark + light themes.
- **Test**: After the codemod, write a snapshot test in `src/app/__tests__/` that imports `globals.css` and asserts `getComputedStyle(...)` on `.bg-attention` returns a non-transparent value, so a future regression that drops the token fails fast.

### F08-02: Hardcoded SVG hex colours violate the theme contract
- **Priority**: P1
- **Status**: Carry-over from April 20 F08-04 — *not* resolved.
- **Size**: M
- **Observation**: CLAUDE.md "SVG and Theme Colors" section bans hex in SVG (`fill="#..."`, `stroke="#..."`). Verified violations at HEAD:
  - `src/app/components/ui/agentpane-logo.tsx:31-101` — 15 hex literals (#fff, #3fb950, #58a6ff, #a371f7, #f778ba, #d29922) in `<defs>`, `<line>`, `<circle>`. Used on the welcome / first-run dashboard.
  - `src/app/components/ui/ai-action-button.tsx:64-83` (lines visible at module review) — Claude orange `#D97757` literals + `#1a1a1a` for eyes; the AI action button is the central CTA on the kanban header.
  - `src/app/components/features/settings-sidebar.tsx:159-207` — same five-colour palette repeated as logo decoration.
  - `src/app/components/features/sidebar.tsx:289` — sidebar logo decoration.
  - `src/app/components/features/folder-rail/index.tsx:104-150` — folder rail icons.
  - `src/app/components/features/terraform/terraform-dependency-edge.tsx` — edge gradient defs (audit pending — same pattern).
  - `src/app/components/features/agent-topology/edges/agent-edge-markers.tsx` — marker fills (audit pending).
  - 30+ total hits with `grep -rE 'fill="#[0-9a-fA-F]+"|stroke="#[0-9a-fA-F]+"' src/app/components`.
- **Risk**: Sidebar / folder rail / topology edges / first-run welcome jar in light theme — all hex values are GitHub-dark-mode literals. Palette refresh requires grep-and-replace instead of editing one CSS variable.
- **Recommendation**: Map the palette to existing tokens: `#3fb950` → `var(--success-emphasis)`, `#58a6ff` → `var(--accent-emphasis)`, `#a371f7` → `var(--done-emphasis)`, `#f778ba` → `var(--secondary-emphasis)`, `#d29922` → `var(--attention-emphasis)`, `#D97757` → `var(--claude-emphasis)`. Then promote the F08-01 Biome rule to also flag `\b(?:fill|stroke)\s*=\s*["']#[0-9a-fA-F]{3,8}["']` inside `.tsx` under `src/app/components/**`. Re-render the welcome screen on light + dark and visual-diff to confirm the design.
- **Test**: Add a one-line unit test that imports each affected component, dumps `outerHTML`, and asserts no `#[0-9a-f]{3,8}` literals remain in the SVG.

### F08-03: React 19 patterns are unused — no `useTransition`, `useOptimistic`, `useDeferredValue`, `useFormStatus`, `useActionState`, or `use()`
- **Priority**: P2
- **Status**: New finding (April 29). Was implicit under April 20 F08-10 ("state-management stack"); now warrants its own line item given April 21's lint-tightening sprint left React-19 idiom adoption at zero.
- **Size**: M
- **Observation**: `grep -rE 'useTransition|useDeferredValue|useFormStatus|useActionState|useOptimistic' src/app` returns **zero** matches. Manual optimistic updates with rollback via re-fetch live in:
  - `src/app/routes/codespaces/$codespaceId/index.tsx:163-188` (`handleTaskMove`) — sets `tasks` optimistically, rolls back via `void fetchData()` on `result.ok === false`.
  - `src/app/routes/codespaces/$codespaceId/index.tsx:190-217` (`handleRunNow`) — same pattern.
  - `src/app/hooks/use-task-operations.ts:64-110` — extracted version of the same optimistic + revert dance.
  - Search inputs (`src/app/routes/index.tsx:423`, `codespaces/index.tsx:365`, `catalog/index.tsx:658`, `folders/$folderId/index.tsx:98`, plus 6 more — 10 sites total) drive an in-memory filter on every keystroke without `useDeferredValue` or debounce. For 24+ codespaces with active agents, the polling cycle (`src/app/routes/index.tsx:140-210`, 5 s active / 30 s idle) plus the keystroke-frequency `setSearchQuery` triggers re-renders during typing.
  - All 24 `forwardRef` declarations (`Button`, `Dialog`, `TabsList`, `TabsTrigger`, `TabsContent`, `Switch`, `Checkbox`, `Textarea`, `TextInput`, `AIActionButton`) are React 19 legacy — refs can be passed as a regular prop in `react@^19.2.5`.
- **Risk**: Mid-tier productivity drag — every optimistic mutation needs hand-rolled revert; rollback via full re-fetch wastes a round-trip and is racy when polling is also running. `forwardRef` will be removed in React 20 (per current React RFC schedule).
- **Recommendation**: (a) For task move / approve / reject paths, replace optimistic-then-revert with `useOptimistic` so React owns the rollback. (b) For search inputs in long lists, wrap the filter in `useDeferredValue` so typing stays responsive even while polling fires. (c) Codemod `forwardRef<X, P>((props, ref) => …)` to `({ ref, ...props }: P & { ref?: Ref<X> }) => …` across the 24 sites — codemod available from `@codemod/react-19-types`. (d) Where mutations interact with route loaders (e.g., creating a new codespace then navigating), wrap the `await apiClient...` in `useTransition` so the pending state is reactive instead of `useState<boolean>`. (e) Keep the doc paragraph in `use-session.ts:4-20` (FC-020) but extend it to mention `useOptimistic` and `useTransition` are now in use for mutations even though TanStack Query is still skipped.
- **Test**: After codemodding `Button`, the existing `error-boundary.test.tsx` and `connection-status-banner.test.tsx` should still pass; add one regression test that asserts a ref forwarded to `Button` is the underlying `<button>` element (catches the codemod accidentally shadowing `ref`).

### F08-04: Eager `import('shiki')` at module scope still preloads grammars
- **Priority**: P2
- **Status**: Carry-over from April 20 F08-05 — *not* resolved.
- **Size**: S
- **Observation**: Shiki is imported at module scope in two places:
  - `src/app/components/ui/markdown-content.tsx:14` — `const shikiPromise = import('shiki');` evaluates as soon as `markdown-content.tsx` is loaded (any agent message, plan, task description, audit trail).
  - `src/app/components/features/terraform/terraform-right-panel.tsx:132` — same pattern, evaluates when the terraform route module is loaded.
- The `import('shiki')` is inside the module factory, so Vite/Rollup will still emit it as a separate chunk — but the chunk download starts the moment the factory runs, regardless of whether the code block ever renders. The April 20 review noted `emacs-lisp` (780 KB), `cpp` (626 KB), `wasm` (622 KB) chunks under `dist/`, which is symptomatic of either eager grammar bundling or `bundledLanguagesFull`. The fix is to (a) make the import lazy on first use *and* (b) construct a `Highlighter` with an explicit allowlist.
- **Risk**: 1.4 MB+ of unused grammars on the dashboard route (markdown-content is reachable from several entry points via task descriptions / suggestions). For users on a kiosk / bandwidth-limited environment this is a noticeable cold-load tax.
- **Recommendation**: Move `shikiPromise` inside `MarkdownCodeBlock`'s effect (`markdown-content.tsx:46-76`) and `useHighlightedCode`'s effect (`terraform-right-panel.tsx:137-160`). Use `createHighlighter({ langs: ['typescript','javascript','tsx','jsx','json','yaml','hcl','terraform','tf','markdown','python','bash','sh','sql'], themes: ['github-light-default','github-dark-default'] })` to guarantee an allowlist. Verify with `dist/` analyser that `wasm`/`cpp`/`emacs-lisp` chunks no longer appear.
- **Test**: A simple Vitest using `vi.spyOn(globalThis, 'fetch')` and rendering `<MarkdownContent content="plain text">` (no fenced code) should show **no** Shiki chunk requested. Then render a fenced typescript block and assert exactly the typescript grammar chunk is requested.

### F08-05: `optimizeDeps.include: ['elkjs/lib/elk.bundled.js']` still pre-bundles 1.45 MB on dev cold-start
- **Priority**: P3
- **Status**: Carry-over from April 20 F08-06 — *not* resolved.
- **Size**: XS
- **Observation**: `vite.config.ts:94` lists `elkjs/lib/elk.bundled.js` in `optimizeDeps.include`. The runtime use is correct (dynamic `import('elkjs/lib/elk.bundled.js')` in `src/lib/workflow-dsl/layout.ts:26`, called from `getElk()` and consumed by `agent-topology/topology-layout.ts` and `terraform/terraform-dependency-diagram.tsx`). In production this is fine — Rollup honours the dynamic import as a separate chunk. In Vite **dev**, however, `optimizeDeps.include` forces eager pre-bundling on cold start. With `elkjs/lib/elk.bundled.js` weighing ~1.45 MB, every dev cold-start pays that cost even if you only visit `/codespaces`.
- **Risk**: Slow Vite cold-start. Production unaffected.
- **Recommendation**: Drop `elkjs/lib/elk.bundled.js` from `optimizeDeps.include`. Replace with `optimizeDeps.exclude: ['elkjs/lib/elk.bundled.js']` to be explicit. Measure with `DEBUG=vite:deps` before/after. If dev cold-start regresses on the workflow-designer route, restore `include` for that one bundle.
- **Test**: None — dev tooling change.

### F08-06: Stream-event union is still stringly-typed at the call site
- **Priority**: P2
- **Status**: Carry-over from April 20 F08-07 — *not* resolved.
- **Size**: M
- **Observation**: `DurableStreamsClient` returns Zod-validated events with discriminated `event.type`. Hooks then string-compare:
  - `src/app/hooks/use-session.ts:386-454` — `callbacks.onChunk/onToolCall/onPresence/onTerminal/onAgentState` map specific types, but the underlying `subscribeToSession` payload types are not constrained by a single `StreamEvent` discriminated union shared with the server.
  - `src/app/hooks/use-topology-stream.ts` — switches on event.type for topology events. If `stream-handler.ts` renames `agent:plan_ready` to `agent:plan-ready` (this happened with task columns), the client silently no-ops.
  - `src/app/hooks/use-container-agent.ts` — same pattern for container-agent events.
- **Risk**: Silent drop on event-name drift. Has happened in this codebase already (column-name rename per CLAUDE.md "Naming: Project → Codespace"). Three independent client hooks must each be updated when event names change on the server.
- **Recommendation**: Define `type StreamEvent = | { type: 'chunk', data: ... } | { type: 'tool', data: ... } | …` in a shared module imported by both `src/lib/streams/envelope.ts` (server-side validator) and the three client hooks. Backend uses `satisfies StreamEvent` when emitting; client hooks switch on `event.type` with a `default: never` exhaustive check that the TS compiler enforces.
- **Test**: Compile-only test — add a server-side test that constructs every `StreamEvent` variant with `satisfies` and asserts no `as` casts remain.

### F08-07: No per-route `errorComponent` — single fetch failure unmounts the shell
- **Priority**: P2
- **Status**: Carry-over from April 20 F08-09 — *not* resolved.
- **Size**: S
- **Observation**: `__root.tsx:93` has `errorComponent: RootErrorComponent`. `grep -rE 'errorComponent\b' src/app/routes` returns **only** that one match. None of the 16 loader-bearing routes (`src/app/routes/{codespaces/$codespaceId/index,sessions/$sessionId,catalog/$workflowId,folders/$folderId/{index,members},memory/index,marketplace/index,settings/{prompts,api-keys},...}.tsx`) define their own `errorComponent`. A throw inside `loader` (e.g., `apiClient.codespaces.get()` rejects with a network error in `codespaces/$codespaceId/index.tsx:52-62`) bubbles past every component boundary and replaces the entire shell with `RootErrorComponent`.
- **Risk**: Users on a flaky network see "Something went wrong → Go home" instead of an in-route retry button — they lose nav context, folder rail, and active session indicators.
- **Recommendation**: Define a shared `RouteErrorBoundary` (subclass of `ErrorBoundary` or wrapper with the same props) in `src/app/components/ui/route-error-boundary.tsx`. Add `errorComponent: RouteErrorBoundary` to:
  - `routes/codespaces/$codespaceId/index.tsx` (kanban)
  - `routes/codespaces/$codespaceId/git.tsx` (git view)
  - `routes/codespaces/$codespaceId/tasks/$taskId.tsx`
  - `routes/sessions/$sessionId.tsx`
  - `routes/sessions/index.tsx`
  - `routes/catalog/$workflowId.tsx`
  - `routes/designer/index.tsx`
  - `routes/folders/$folderId/{index,members}.tsx`
  - `routes/memory/index.tsx`
  - `routes/marketplace/index.tsx`
  - `routes/settings/{api-keys,prompts}.tsx`
- **Test**: Add a Vitest that uses `createMemoryHistory` + `createRouter`, throws inside a loader stub, and asserts the per-route fallback (not the root) is rendered, and that the shell (FolderRail / NavPanel) is still present in the DOM.

### F08-08: TanStack DB session collections are dead code
- **Priority**: P2
- **Status**: New finding (April 29). Sub-issue under April 20 F08-10.
- **Size**: M
- **Observation**:
  - `src/lib/sessions/collections.ts` defines 7 collections (`chunks`, `toolCalls`, `presence`, `terminal`, `workflow`, `agentState`, `messages`).
  - `src/lib/sessions/sync.ts:48-193` syncs them by subscribing to durable streams (parallel path to `useSessionSubscription`).
  - `src/lib/sessions/derived.ts` (160 LOC) and `src/lib/sessions/hooks/use-session-data.ts` (190 LOC) provide hooks: `useSessionChunks`, `useSessionToolCalls`, `useSessionPresence`, `useSessionTerminal`, `useSessionAgentState`, `useSessionMessages`, `useSessionFullText`, `useSessionData`.
  - `grep -rE 'useSessionData|useSessionChunks|useSessionToolCalls|useSessionMessages' src/app` returns **zero** consumers. `useSession` (the *real* hook) is the one wired into `agent-session-view`, container-agent-panel, etc.
  - `clearSessionCollections()` (`collections.ts:137`) is documented as "Clear all data from all session collections" but the body is a TODO comment / no-op.
  - The only TanStack DB consumer in `src/app/` is `useSandboxStatus` (`use-sandbox-status.ts`).
- **Risk**: 600+ LOC of unused infrastructure inviting confusion ("which session hook do I use?"). The dual subscription path means if someone wires `useSessionData` to a component, the user pays for two parallel SSE consumers per session.
- **Recommendation**: Decide. Either (a) delete `src/lib/sessions/{sync,derived}.ts`, the 7 collections, and the 8 hooks (commit message: "remove unused TanStack DB session sync"), or (b) migrate `useSession` to TanStack DB collections and delete `applyPendingSessionUpdates` / pending-batch state machinery. Option (a) is simpler — keep `sandbox-status` as the single live-collection example, and document in `specs/application/implementation/state-management.md` that TanStack DB is reserved for poll-able client collections, not stream-derived state.
- **Test**: After deletion, the test suite must still pass. The `session-dedupe.test.tsx` is for `applyPendingSessionUpdates`, which is the path that *survives* — no test changes needed.

### F08-09: `FolderContext` re-publishes on every drag-frame, re-rendering the entire codespace tree
- **Priority**: P2
- **Status**: New finding (April 29).
- **Size**: S
- **Observation**:
  - `src/app/providers/folder-context.tsx:213-216` defines `setFolderPanelWidth = useCallback((width: number) => setFolderPanelWidthState(width), [])`. The companion comment at line 213 explicitly says *"Width setters (in-memory only — called on every mousemove during drag)"*.
  - The provider's value object includes `folderPanelWidth` and `navPanelWidth` (`folder-context.tsx:247-248`). Every `setFolderPanelWidthState` call mutates the memo dep array.
  - The drag-resize handler in `folder-panel.tsx:205` and `nav-panel.tsx:282` calls `setFolderPanelWidth` / `setNavPanelWidth` on every mousemove (~60 Hz).
  - `useSelectedFolder()` in `codespace-context.tsx:107` consumes the same `FolderDataContext`. So on each drag frame:
    1. Folder context value reference changes.
    2. `CodespaceContextProvider` re-runs (it's a consumer).
    3. `CodespaceContextProvider`'s `useMemo`s re-evaluate (`dataValue`, `pickerValue`, `combinedValue`).
    4. Every consumer of `useCodespaceContext` / `useCodespaceData` / `useCodespacePicker` re-renders.
  - Total: ~60 re-renders per second of every component subscribed to either context, while the user drags a panel divider.
- **Risk**: Visible jank during panel resize; on the kanban board with many cards or the live-task view, 60 Hz re-renders of the codespace data cascade into card-level renders.
- **Recommendation**: Split panel widths into a dedicated `FolderPanelWidthContext` (or hoist them into `useState` in the panel components themselves and pass via prop). The data context (folders, selectedFolderId) already changes infrequently — keep it stable. Alternative: keep widths in `useRef` + force-update only on mouseup (the persist path already does this — match it for the in-memory path).
- **Test**: A React Testing Library test that mounts `<CodespaceContextProvider>` with a child that increments a render counter, then calls `setFolderPanelWidth(100)` 10 times, asserting the child's render count does not change.

### F08-10: Sandbox-status TanStack DB collection grows unbounded across navigations
- **Priority**: P3
- **Status**: New finding (April 29).
- **Size**: XS
- **Observation**: `src/app/hooks/use-sandbox-status.ts:36-44` calls `startSandboxStatusSync(codespaceId)` on watch and `stopSandboxStatusSync(codespaceId)` on cleanup — but neither path calls `clearSandboxStatus(codespaceId)` (defined in `src/lib/sandbox-status/collections.ts:64`, exported from index.ts:9, never invoked). Each codespace visited deposits one row in the collection. Long-lived browser tabs visiting many codespaces accumulate stale rows. `inflightPolls` (`src/lib/sandbox-status/sync.ts:14`) is module-level and never cleaned across HMR or navigation; if a sync is unmounted while a poll is in flight, the entry stays in `inflightPolls` forever and that codespace can never be re-polled until the next page reload (because the overlap guard at line 83 returns early).
- **Risk**: Memory growth + a one-shot dead-poll bug if the browser cancels an in-flight fetch (e.g., user navigates away mid-request). On long-lived dev sessions, the kanban "sandbox indicator" can stop updating until full reload.
- **Recommendation**:
  - In `stopSandboxStatusSync`, also `clearInterval` and clear `inflightPolls.delete(codespaceId)`.
  - Optionally call `clearSandboxStatus(codespaceId)` in the hook's cleanup so stale rows don't accumulate.
  - Track inflight per-codespace as an `AbortController` so the unmount path can abort the fetch.
- **Test**: Vitest mounts the hook for codespace A, advances timers, unmounts, mounts again, asserts a poll fires (i.e., the `inflightPolls` guard does not block the second mount).

### F08-11: Container-agent-panel tabs lack ARIA roles
- **Priority**: P2
- **Status**: New finding (April 29).
- **Size**: XS
- **Observation**: `src/app/components/features/container-agent-panel/container-agent-panel.tsx:199-241` renders three tab buttons (Output / Changes / Topology) using `<button type="button">` without `role="tab"`, no surrounding `role="tablist"`, no `aria-selected`, no `aria-controls`. Compare with `agent-session-view/index.tsx:402-435` which gets it right. Three Radix `Tabs.*` primitives are already imported throughout the codebase (`new-project-dialog.tsx:29`, etc.), so the fix is mechanical.
- **Risk**: Screen readers announce the tab bar as a sequence of plain buttons; users cannot navigate with arrow keys (the WAI-ARIA tab pattern). The Output / Changes / Topology tabs are the primary navigation inside an active agent session — screen-reader users have no signpost.
- **Recommendation**: Replace the three `<button type="button">` blocks with the `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` primitives from `src/app/components/ui/tabs.tsx`, mirroring `agent-session-view/index.tsx:399-470`. Add `aria-selected`, `role="tab"`, `aria-controls`, and `role="tabpanel"` on the content region.
- **Test**: A Testing Library test that renders the panel and asserts `screen.getByRole('tablist')` returns one node, `screen.getAllByRole('tab')` returns three, and that pressing `ArrowRight` on the first tab moves focus to the second.

### F08-12: `validateSearch` schemas are missing — `useSearch` calls use type casts
- **Priority**: P2
- **Status**: New finding (April 29).
- **Size**: XS
- **Observation**: `grep -rE 'useSearch|validateSearch' src/app` returns **two** matches, both in `src/app/routes/designer/index.tsx`:
  ```
  src/app/routes/designer/index.tsx:2:import { createFileRoute, useSearch } from '@tanstack/react-router';
  src/app/routes/designer/index.tsx:22:const search = useSearch({ from: '/designer/' }) as { id?: string };
  ```
  The route definition (`createFileRoute('/designer/')`) does not specify `validateSearch`, so search params are typed as `unknown` and the `as { id?: string }` cast is required. A malicious or stale link `/?id=<script>...` is passed straight to `fetchWorkflow(workflowId)` which then becomes part of a fetch URL (`fetch(\`/api/workflows/${id}\`)` — line 33). `apiClient` does not URL-encode for path params (`encodeURIComponent` is not applied at the call site).
- **Risk**: Path-traversal-shaped IDs (e.g., `?id=../tasks/...`) reach the API; the API may or may not validate, but the client should not rely on that. More immediately: refactoring `id` to a different name silently breaks the route without a TS error.
- **Recommendation**: Add `validateSearch: (search) => z.object({ id: z.string().min(1).max(64).optional() }).parse(search)` to the designer route. Replace the `as` cast with the typed `Route.useSearch()`. Apply the same pattern to the catalog route's search-driven workflow loading (`routes/catalog/index.tsx:516`, `routes/catalog/$workflowId.tsx:80`).
- **Test**: Vitest test that calls `Route.validateSearch({ id: '' })` and expects a Zod error, then `Route.validateSearch({ id: 'abc' })` and expects success.

### F08-13: 10 sites still use `window.confirm` instead of the project's Radix Dialog
- **Priority**: P3
- **Status**: New finding (April 29).
- **Size**: S
- **Observation**: `grep -rE 'window\.confirm' src/app` returns 10 matches:
  - `src/app/components/features/agent-session-view/index.tsx:293` — "Stop this session?"
  - `src/app/components/features/terraform/terraform-settings-panel.tsx:143` — "Remove this registry?"
  - `src/app/routes/catalog/{index.tsx:523, $workflowId.tsx:87}` — workflow delete
  - `src/app/routes/marketplace/index.tsx:220` — marketplace removal
  - `src/app/routes/templates/{project.tsx:213, org.tsx:108}` — template delete
  - `src/app/routes/events/sources.tsx:107,124` — event source delete
  - `src/app/routes/events/subscriptions.tsx:92` — subscription delete
- **Risk**: `window.confirm` is a synchronous blocking modal that ignores the design system, cannot be styled, has poor mobile UX, and clashes with the rest of the Radix-driven UI. It also blocks the React render loop — a `confirm` mid-event-handler stalls every other render until the user dismisses.
- **Recommendation**: Build one `<ConfirmDialog>` component (Radix `AlertDialog` internally, with `title`/`description`/`confirmLabel`/`cancelLabel` props). Codemod the 10 sites. Add a Biome rule banning `window.confirm` and `window.alert` in `src/app/**`.
- **Test**: After the codemod, write one test that mounts each call site, clicks the trigger, and asserts the confirm dialog opens (not a `window.confirm` call).

### F08-14: Provider ordering in `__root.tsx` is load-bearing but undocumented; `LayoutShell` has a non-functional sidebar toggle
- **Priority**: P3
- **Status**: Carry-over from April 20 F08-12 — *not* resolved. New sub-finding on `LayoutShell`.
- **Size**: XS
- **Observation**: `__root.tsx:74-87` nests `ShortcutsProvider → FolderContextProvider → CodespaceContextProvider → TooltipProvider`. The ordering is load-bearing because `CodespaceContextProvider` calls `useSelectedFolder()` (`codespace-context.tsx:107`) — flipping the order to put `Codespace` outside `Folder` throws "must be used within FolderContextProvider" at mount. There's no comment, no test asserting the order, and no `AppProviders` collapsed component. Adjacent issue at `__root.tsx:82`: `<GlobalShortcutsWithPicker />` renders outside `CodespaceContextProvider`, so any shortcut handler that wants `useCodespaceData()` cannot access it. `LayoutShell.tsx:66-73` renders a hamburger button (`md:hidden`, `data-testid="sidebar-toggle"`) with no `onClick` — visible on mobile, does nothing.
- **Risk**: Future provider additions land in the wrong order and a runtime "must be used within" error ships to production. Mobile users see a hamburger that doesn't open the navigation.
- **Recommendation**: (a) Collapse providers into a single `AppProviders` component in `src/app/providers/index.tsx` with a block-comment manifest of dependencies. (b) Add a render-without-throwing smoke test (`src/app/__tests__/providers.test.tsx`) that mounts `<AppProviders><div /></AppProviders>` once with each context's hook called from a child component to assert no throws. (c) Wire the mobile sidebar toggle to `setFolderPanelOpen` / `setNavPanelOpen` from `useFolderData()`, or hide the button until it has a handler.
- **Test**: Provider order change → test fails. Mobile sidebar test: render LayoutShell, click `[data-testid="sidebar-toggle"]`, assert `isFolderPanelOpen` toggles.

### F08-15: Frontend test surface is still thin — UI flows untested
- **Priority**: P3
- **Status**: Carry-over follow-up. April 20 F08-02 was resolved (5 seed tests landed in #176); the gap moved up the stack.
- **Size**: M
- **Observation**: 6 frontend test files / ~25 tests at HEAD. None exercise:
  - Kanban DnD reorder + optimistic update + revert (`KanbanBoard` + `use-task-operations.ts:64-110`).
  - Plan approval / rejection state machine (`approval-dialog/index.tsx` + `task-operations`).
  - Workflow designer save / load round-trip (`workflow-designer/index.tsx:340-509`).
  - Topology event ingestion (`use-topology-stream.ts` + `topology-context.tsx` reducer).
  - The `CodespaceContextProvider` data/picker split (re-render-count assertions to lock F08-09 once fixed).
  - Search input filtering on long codespace lists (`routes/index.tsx:413-509`).
  - `ContainerAgentPanel` plan-approval transitions (`container-agent-panel.tsx:243-281`).
- **Risk**: Coarse-grained refactors of `use-task-operations` or the topology reducer ship without a CI signal. The existing seed suite locks in the *plumbing* (boundaries, banners, dedupe semantics) but not the user flows.
- **Recommendation**: Add four focused tests:
  1. `kanban-task-move.test.tsx` — render `<KanbanBoard>` with a mocked `apiClient.tasks.move` that resolves error; assert the optimistic move is reverted.
  2. `topology-reducer.test.ts` — exercise `topologyReducer` with `ADD_NODE` (existing parent), `UPDATE_NODE`, `COMPLETE_NODE` and assert `structureVersion` / `dataVersion` increment correctly.
  3. `plan-approval.test.tsx` — render `<ApprovalDialog>` in plan-review mode, click approve, assert `apiClient.tasks.approvePlan` is called.
  4. `codespace-context-rerender.test.tsx` — assert that calling `setFolderPanelWidth` (current bug or post-fix) does not trigger consumer re-render. (Marks F08-09 as red until fixed.)
- **Test**: The four tests above are themselves the deliverable.

## Cross-refs
- F08-01 (warning tokens), F08-02 (SVG hex) overlap `specs/application/implementation/component-patterns.md`. Both warrant Biome / Semgrep rules.
- F08-06 (event union) connects to `specs/arch_review_april/05-events.md`; ideally same shared module backs server validators and client consumers.
- F08-08 (TanStack DB sprawl) connects to `specs/arch_review_april/02-data-layer.md` — decision to keep TanStack DB only for sandbox-status should be documented in `specs/application/implementation/state-management.md`.
- F08-15 (test gaps) connects to `specs/arch_review_april/09-testing.md` — proposed tests should be reflected in the testing remediation plan.
- F08-12 (validateSearch) connects to `specs/arch_review_april/06-security.md` — path traversal via search params is a security-shaped gap.
