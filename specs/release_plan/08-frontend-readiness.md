# Frontend Production Readiness Assessment

## Current State

### Framework & Architecture
- **React 19** with **TanStack Router** (file-based routing, 60 route files in `src/app/routes/`)
- **TanStack DB** for local-first reactive collections; manual fetch patterns (useState + useEffect + apiClient) for server data -- no TanStack Query
- **Radix UI** primitives + **Tailwind CSS 4** for styling; component variants via **class-variance-authority (CVA)**
- **Hono** API router on port 3001; Vite dev proxy forwards `/api` and `/v1/stream` from port 3000
- **Durable Streams** (`@durable-streams/client`) for real-time SSE with offset-based resume
- **dnd-kit** for drag-and-drop (Kanban board), **React Flow / ELK** for agent topology graph
- 23 reusable UI components in `src/app/components/ui/`
- Comprehensive skeleton system (`skeleton.tsx`: Skeleton, SkeletonText, SkeletonAvatar, SkeletonCard, SkeletonTable, SkeletonBadge, SkeletonButton, SkeletonImage, SkeletonListItem)

### Build Configuration
- Vite 8 with `autoCodeSplitting: true` via `TanStackRouterVite`
- Server-only modules (better-sqlite3, Claude Agent SDK) excluded from browser bundle via custom `serverOnlyStubs()` Vite plugin
- Build target: `esnext`
- Pre-bundled dependencies: `@xyflow/react`, `elkjs`, `@durable-streams/client`

---

## Error Handling

### Error Boundaries -- GOOD, with gaps

**Root-level error boundary:** The `__root.tsx` route defines both `errorComponent` (RootErrorComponent) and `notFoundComponent` (NotFoundComponent) via TanStack Router's `createRootRouteWithContext`. These catch unhandled rendering errors and invalid routes globally. The root error component provides "Try again" (reset + invalidate) and "Go home" buttons.

**Component-level error boundaries (3 total):**
1. `TopologyErrorBoundary` in `src/app/components/features/agent-topology/index.tsx` -- catches React Flow / ELK crashes with retry button
2. `CliMonitorErrorBoundary` in `src/app/routes/cli-monitor.tsx` -- catches CLI monitor rendering errors
3. `MemoryTabErrorBoundary` in `src/app/components/features/memory-view/memory-view.tsx` -- wraps each memory tab individually

**Gap:** No error boundaries around other heavy components:
- Kanban board (`src/app/components/features/kanban-board/index.tsx`) -- drag-and-drop state corruption could crash the tree
- Workflow designer (`src/app/components/features/workflow-designer/index.tsx`) -- complex React Flow usage
- Session history views (`src/app/components/features/session-history/`)
- Terraform compose panels

### API Error Handling -- SOLID

The `apiClient` (`src/lib/api/client.ts`) properly handles:
- **Network errors** (TypeError from fetch) -> returns `{ ok: false, error: { code: 'NETWORK_ERROR' } }`
- **Aborted requests** -> returns `{ ok: false, error: { code: 'REQUEST_ABORTED' } }`
- **JSON parse failures** -> returns `{ ok: false, error: { code: 'PARSE_ERROR' } }`
- All routes check `result.ok` before accessing data

**Error state component:** `src/app/components/features/error-state.tsx` provides both `simple` and `full` variants with retry options, stack trace display, and activity log. Uses `role="alert"` for accessibility.

**Empty state component:** `src/app/components/features/empty-state.tsx` includes presets for `first-run`, `no-projects`, `no-tasks`, `no-agents`, `empty-session`, `no-results`, `error`, and `offline`.

### Toast Notifications -- SOLID

`src/app/hooks/use-toast.ts` and `src/app/components/ui/toast.tsx` implement a complete toast system:
- Variants: default, success, error, warning, info, loading
- `toast.promise()` for async operations with loading -> success/error transitions
- External store pattern with `useSyncExternalStore` -- works outside React components
- Auto-dismiss with configurable durations
- Radix Toast primitives for accessibility
- `aria-live` regions: `assertive` for errors/warnings, `polite` for info/success

---

## Loading States

### Suspense Boundaries -- ADEQUATE

Suspense is used with `React.lazy()` in 7 locations:
1. `src/app/routes/index.tsx` -- lazy loads `NewProjectDialog`
2. `src/app/routes/codespaces/$codespaceId/index.tsx` -- lazy loads `NewTaskDialog`
3. `src/app/routes/codespaces/$codespaceId/settings.tsx` -- lazy loads `ProjectSettings` with shimmer fallback
4. `src/app/routes/codespaces/index.tsx` -- lazy loads `NewProjectDialog`
5. `src/app/routes/memory/index.tsx` -- lazy loads `MemoryView` with shimmer fallback
6. `src/app/components/features/global-shortcuts.tsx` -- lazy loads `NewProjectDialog`
7. `src/app/components/features/agent-topology/index.tsx` -- lazy loads `AgentTopologyInner` with "Loading topology..." fallback

**Issue:** Several Suspense boundaries use `fallback={null}`, causing content to simply disappear during loading. The settings and memory routes provide proper shimmer/loading fallbacks.

### Router-Level Loading -- GOOD

`src/app/router.tsx` configures:
- `defaultPendingMs: 200` -- waits 200ms before showing pending component (avoids flash)
- `defaultPendingComponent` -- renders "Loading..." with `animate-pulse`
- `defaultPreload: 'intent'` -- preloads routes on hover intent

### Skeleton Screens -- GOOD

Comprehensive skeleton system used in:
- Git view (`src/app/components/features/git-view/git-view.tsx`) -- 8 skeleton elements
- Kanban columns (`src/app/components/features/kanban-column.tsx`) -- task card skeletons
- Memory skills tab (`src/app/components/features/memory-view/memory-skills-tab.tsx`)
- Memory insights tab (`src/app/components/features/memory-view/memory-insights-tab.tsx`)
- Workflow catalog (`src/app/components/features/workflow-catalog/index.tsx`)

### Spinner Usage -- APPROPRIATE

`Spinner` from `@phosphor-icons/react` used as inline loading indicators in:
- Folder members, folder index, templates, designer, marketplace, catalog, sandbox status
- All with `animate-spin` class

---

## Accessibility

### ARIA Attributes -- MODERATE COVERAGE

**Well-implemented areas:**
- CLI monitor: `role="application"`, `role="listbox"`, `aria-selected`, `aria-label`, `aria-live="polite"`, keyboard navigation (arrow keys, Escape)
- Session replay controls: full slider semantics (`role="slider"`, `aria-valuemin/max/now/text`), `role="toolbar"`, `aria-label` on all buttons, `aria-pressed` for speed buttons, `focus-visible` rings
- Workflow designer toolbar: `role="toolbar"`, `aria-label` on undo/redo
- Session detail view: `role="tablist"`, `aria-selected`, `aria-controls`, `aria-labelledby`
- Agent session view: `aria-live="polite"` on streaming container (FC-015)
- Toast system: `aria-live="assertive"` for errors, `aria-live="polite"` for info
- Error state: `role="alert"`
- Dialog close button: `<span className="sr-only">Close</span>`
- Decorative icons: `aria-hidden="true"` on node icons in workflow designer

**Gaps:**
- Kanban board: dnd-kit provides some a11y but no explicit `aria-label` on columns or cards visible in the code
- Most form inputs in settings pages lack `aria-label` or associated `<label>` elements (use visual-only labels)
- No skip-to-content link in the layout shell
- Sidebar toggle has `sr-only` text but uses a `<span>` with `"☰"` character instead of an icon with proper semantics
- Many dropdown menus and selects lack `aria-label`

### Keyboard Navigation -- PARTIAL

- Keyboard shortcuts system: `src/app/hooks/use-keyboard-shortcuts.ts` with proper detection of text inputs (`role="textbox"`, contenteditable, input, textarea, select)
- CLI monitor: arrow key navigation, Escape to close
- Workflow designer SavedWorkflowsPanel: `tabIndex={0}`, `onKeyDown` for Enter/Space
- Replay controls: full keyboard support including progress bar (Arrow keys for seek)
- Memory skills tab: keyboard interaction for expandable rows

**Gap:** No visible focus indicator management beyond browser defaults and `focus-visible` ring styles on form elements. No `FocusTrap` implementation found -- Radix Dialog handles this natively, but custom modal-like UIs may not trap focus.

### Screen Reader Support -- BASIC

- `sr-only` class used for: sidebar toggle text, dialog close buttons, project settings button, playback speed legend
- `aria-live` regions for streaming content and toast notifications
- Most interactive elements lack descriptive `aria-label` attributes

---

## Performance

### Bundle Size -- CONCERN

**Total dist output:** 14 MB across 484 JS chunks + 3 CSS files

**Top JS bundles:**
| File | Size | Contents |
|------|------|----------|
| `elk.bundled-*.js` | 1.4 MB | ELK graph layout engine |
| `emacs-lisp-*.js` | 762 KB | CodeMirror/syntax language |
| `index-*.js` | 616 KB | Main application bundle |
| `cpp-*.js` | 611 KB | CodeMirror C++ grammar |
| `wasm-*.js` | 608 KB | WASM syntax |
| `_projectId-*.js` | 165 KB | Codespace route chunk |
| `use-collection-query-*.js` | 154 KB | TanStack DB |
| `dist-*.js` | 188 KB | Library chunk |

**CSS:** 194 KB (main) + 15 KB (style) + 6.6 KB (workflow designer)

**Issues:**
- **CodeMirror language grammars** are being code-split but all ~450+ language grammar chunks are included in the build (emacs-lisp, cpp, wasm, wolfram, etc.). Only a handful of languages are likely used. These should be filtered or dynamically loaded on demand.
- **ELK layout engine** at 1.4 MB is the single largest chunk. It's already lazy-loaded via the topology component but could benefit from being loaded only when the user visits the topology view.

### Code Splitting -- GOOD

- TanStack Router `autoCodeSplitting: true` automatically splits each route file
- Heavy components lazy-loaded: `AgentTopologyInner`, `NewProjectDialog`, `NewTaskDialog`, `ProjectSettings`, `MemoryView`
- Worker format set to `es` for code-split web workers

### Re-render Optimization -- ADEQUATE

- 228 `useEffect`/`useLayoutEffect` uses across 60 files -- uses purpose-built wrappers (`useWatchEffect`, `useMountEffect`) for disciplined effect management
- `useEffectEvent` (React 19) used extensively to stabilize callbacks without re-subscribing effects
- Session stream batching: `useSession` queues updates via `requestAnimationFrame` flush to prevent excessive re-renders from streaming data (max 5000 chunks in state via `MAX_CHUNKS`)
- Deduplication: `seenEventIdsRef` prevents duplicate events on reconnection
- `useSyncExternalStore` used for toast state (no unnecessary renders)
- `useMemo` / `useCallback` used across the codebase (~18 occurrences observed in sampled files)

---

## Real-time Features

### SSE Reconnection -- SOLID

**Durable Streams Client** (`src/lib/streams/client.ts`):
- Exponential backoff: configurable initial delay (1s), max delay (30s), backoff multiplier (2x)
- Maximum 8 reconnect attempts on clean stream closure
- Fatal error detection: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `ALREADY_CONSUMED`, `ALREADY_CLOSED` stop retries
- Special handling: `NOT_FOUND` before first connection is NOT treated as fatal (stream may not exist yet)
- Offset-based resume: `lastCursor` persisted and sent on reconnect for missed event recovery
- Zod schemas validate all incoming event data

**Session Subscription** (`src/app/hooks/use-session-subscription.ts`):
- Ref-counted shared connections: multiple hooks subscribing to the same sessionId share one underlying SSE connection (FC-006)
- Connection state tracking: `disconnected | connecting | connected | reconnecting`
- Browser online/offline detection: `navigator.onLine` + `online`/`offline` event listeners
- Effective connection state degrades to `disconnected` when browser is offline

**Event Stream** (`src/app/hooks/use-event-stream.ts`):
- Independent SSE for event system (separate from session streams)
- Exponential backoff (max 30s, max 10 retries)
- Proper cleanup: clears timeouts and closes EventSource on unmount

### Offline Handling -- PARTIAL

- CLI monitor shows "You are offline" banner when `!navigator.onLine`
- Empty state preset for `offline` available
- Session subscription reports `disconnected` when browser offline
- Terraform context shows "The backend may be offline" error messages

**Gap:** No global offline banner or network status indicator outside the CLI monitor. When the API server is down, individual routes show errors but there is no unified "reconnecting..." or "server unavailable" overlay.

### Stale Data -- PARTIAL

- Dashboard uses polling (5s active, 30s idle -- FC-021) since it has no single session to subscribe to
- Session data is live via SSE
- Task lists are refetched after mutations via `apiClient.tasks.list()` calls
- No cache invalidation layer (TanStack Query not used) -- data freshness depends on manual refetch patterns

---

## Critical Issues

### C1: Missing Error Boundaries Around Complex Components
**Severity:** High
**Impact:** An unhandled render error in the Kanban board, workflow designer, or session history can crash the entire application.
**Files:** `src/app/components/features/kanban-board/index.tsx`, `src/app/components/features/workflow-designer/index.tsx`, `src/app/components/features/session-history/`
**Fix:** Add error boundaries with retry fallbacks around these components, following the pattern in `agent-topology/index.tsx`.

### C2: Suspense Fallbacks Using `null`
**Severity:** Medium
**Impact:** When lazy-loaded dialogs are loading, users see no visual feedback. Content area appears blank or unchanged.
**Files:** `src/app/routes/index.tsx` (line 511), `src/app/routes/codespaces/$codespaceId/index.tsx` (line 459), `src/app/routes/codespaces/index.tsx` (line 477), `src/app/components/features/global-shortcuts.tsx` (line 412)
**Fix:** Replace `fallback={null}` with lightweight loading indicators or shimmer components. For dialogs, a centered spinner overlay is appropriate.

### C3: Excessive CodeMirror Language Grammars in Build
**Severity:** Medium
**Impact:** 484 JS chunks totaling 14 MB. Many are CodeMirror language grammars (emacs-lisp, wolfram, wasm, etc.) that will never be used. Increases CDN costs and complicates cache management.
**Fix:** Configure Vite/Rollup to include only the languages actually used in the application (likely: typescript, javascript, json, yaml, hcl/terraform, markdown, python, bash). Use dynamic imports for rare languages.

### C4: Console Statements in Production Code
**Severity:** Medium
**Impact:** ~120+ `console.log/warn/error/debug/info` calls across frontend code. While `console.error` for real errors is acceptable, `console.log` and `console.debug` statements leak implementation details and clutter the browser console in production.
**Files:** Concentrated in hooks (`use-session.ts`, `use-topology-stream.ts`, `use-container-agent.ts`, `use-agent-stream.ts`), route files, and services.
**Fix:** Introduce a structured logger that is no-op in production, or strip `console.debug/log` via Vite define/replace. Keep `console.error` for genuine error reporting.

### C5: No Global Offline/Connectivity Indicator
**Severity:** Medium
**Impact:** When the API server goes down, users see inconsistent error states across different views. No unified "reconnecting..." banner.
**Fix:** Add a global connectivity provider that listens for `online`/`offline` events and monitors API health. Display a persistent banner when disconnected, similar to the CLI monitor's offline banner but at the root layout level.

---

## Recommendations

Ordered by priority, with effort estimates:

| # | Recommendation | Effort | Priority |
|---|----------------|--------|----------|
| 1 | **Add error boundaries** around Kanban board, workflow designer, and session history | 2-3 hours | Critical |
| 2 | **Replace `fallback={null}`** in Suspense boundaries with loading indicators | 1 hour | High |
| 3 | **Filter CodeMirror language grammars** -- include only used languages, reduce bundle by ~5 MB | 2-4 hours | High |
| 4 | **Add global connectivity banner** at the `__root.tsx` level | 3-4 hours | High |
| 5 | **Strip console.debug/log** from production builds via Vite config or structured logger | 1-2 hours | Medium |
| 6 | **Add `aria-label` to form inputs** in settings pages and Kanban columns/cards | 3-4 hours | Medium |
| 7 | **Add skip-to-content link** in layout shell for screen reader navigation | 30 min | Medium |
| 8 | **Fix sidebar toggle** -- replace `☰` text character with a proper icon component | 15 min | Low |
| 9 | **Add route-level error components** to individual routes (TanStack Router supports per-route `errorComponent`) for more contextual error messages | 3-4 hours | Low |
| 10 | **Consider a global error boundary wrapper** that reports errors to a monitoring service (Sentry, etc.) before production launch | 2-3 hours | Low |
| 11 | **Lazy-load ELK engine** only when topology tab is selected (currently loaded when topology component mounts) | 1 hour | Low |
| 12 | **Add form validation library** (react-hook-form + zod) -- currently most forms use manual `handleSubmit` patterns without schema validation. Sandbox settings already use Zod schemas but not connected to form state. | 1-2 days | Low |
| 13 | **Audit mobile responsiveness** -- layout shell hides sidebar panels with `hidden md:flex` but main content areas (Kanban board, workflow designer) have no explicit mobile layouts. This is acceptable if the app is desktop-only. | Depends on scope | Low |

### Summary

The frontend is in **good shape** for a v1 production deployment. The architecture is sound: TanStack Router with auto code-splitting, proper SSE reconnection with exponential backoff and offset-based resume, a disciplined effect system with purpose-built hooks, and requestAnimationFrame-based render batching for streaming data. The toast and error state systems are well-implemented.

The critical gaps are: (1) missing error boundaries around three complex component trees that could crash the app, (2) a bloated build from unused CodeMirror language grammars, and (3) no global connectivity indicator when the API server is unreachable. All three are fixable within 1-2 days of focused work.
