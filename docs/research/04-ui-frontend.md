# UI Framework, Components, Styling, Terminal, Graphs, Animation & State Research

**Date:** March 2026
**Current Stack:** React 19.2.4 | TanStack Start/Router | Radix UI 1.2.4 | Tailwind CSS 4.1.18 + CVA 0.7.1 | Phosphor Icons | React Flow 12.10.1 | ELK 0.11.0 | dnd-kit 6.3/10.0 | react-markdown 10.1.0

---

## 1. React 19 vs Alternatives

### Current State

React 19.2.4 with TanStack Start/Router. 124+ component files, 726 useState/useReducer/useContext occurrences. No Server Components or React Compiler usage — runs as traditional SPA with SSE streaming.

### Assessment

| Framework | Recommendation | Rationale |
|---|---|---|
| **React 19** (current) | **ADOPT (keep)** | Ecosystem lock-in through React Flow (25 files), dnd-kit (8 files), Radix UI (36 files), TanStack DB (10 files) makes migration cost prohibitive |
| **Solid.js** | **HOLD** | Fine-grained reactivity ideal for streaming panels. Dealbreaker: no equivalents for React Flow, dnd-kit, Radix, TanStack DB |
| **Svelte 5** | **HOLD** | Runes + compiler optimization. Same ecosystem dealbreaker |
| **Vue 3.5** | **HOLD** | VueFlow exists (same @xyflow team). But TanStack DB lacks Vue support |

### React 19 Features to Adopt

- **React Compiler (Forget):** Would eliminate manual `useMemo`/`useCallback` in 124 component files. Expected stable mid-2026
- **`use()` hook:** Could simplify async data fetching in route loaders
- **Server Components:** Not applicable — SSE-based architecture, not RSC-compatible

---

## 2. Component Libraries

### Current State

Individual Radix UI primitives with custom Tailwind+CVA wrappers in `src/app/components/ui/`. The pattern is structurally identical to shadcn/ui conventions.

### Comparison

| Library | Recommendation | Rationale |
|---|---|---|
| **shadcn/ui** | **ADOPT (selectively)** | Not a library but code generation. Existing components already follow shadcn conventions. Use for new components: command palette, sheet/drawer, data table, scroll-area. Near-zero migration risk |
| **React Aria (Adobe)** | **HOLD** | More comprehensive a11y. Heavier API, more verbose. Would require rewriting 36 Radix files |
| **Ark UI** | **HOLD** | Younger ecosystem. No advantage over Radix for React |
| **Park UI** | **HOLD** | Less mature than shadcn/ui |

### shadcn/ui Components Worth Adding

- **Command palette** — keyboard shortcuts (Cmd+K)
- **Sheet/Drawer** — mobile-friendly panels
- **Data table** — event lists
- **Scroll-area** — customized scrollbars

---

## 3. Tailwind CSS 4 Assessment

### Current State

Tailwind 4.1.18 with CSS-first config. `globals.css` has 994 lines of theme tokens with CSS custom properties (dark/light/system). CVA used in 47 files. Well-architected setup.

### Alternatives

| Technology | Recommendation | Rationale |
|---|---|---|
| **Tailwind v4 + CVA** (current) | **ADOPT (keep)** | Correct choice. Theme system well-designed. CVA remains the right tool (no Tailwind v4 built-in equivalent) |
| **Vanilla Extract** | **HOLD** | Would require rewriting all component styling. Incompatible with CSS custom property theme |
| **Panda CSS** | **HOLD** | Adds ~8KB runtime. Migration moderate |
| **StyleX (Meta)** | **HOLD** | Very young ecosystem |
| **UnoCSS** | **ASSESS** | Faster build, Tailwind-compatible preset. Worth watching but ecosystem risk |

**Minor cleanup:** Migrate `tailwind.config.ts` into CSS `@theme` blocks for full Tailwind v4 idiom (low priority).

---

## 4. Terminal/Code Display

### Current State

Agent output rendered with plain `<div>` elements + `font-mono` text. CSS `content-visibility: auto` for render optimization. No terminal emulation library. No ANSI escape parsing. No syntax highlighting in stream output. Shiki v3.22.0 installed but **not imported in source files**.

### Comparison

| Technology | Recommendation | Rationale |
|---|---|---|
| **Custom div rendering** (current) | **HOLD (keep)** | Architecturally correct for structured agent output with semantic line types. Adding xterm would be a regression |
| **Shiki** (already installed) | **ADOPT** | Activate the dependency! Integrate into `markdown-content.tsx` for code fence highlighting and `stream-line.tsx` for command/output highlighting. Highest value, lowest effort |
| **@xterm/xterm** | **ASSESS** | Only if interactive container terminal access becomes a feature. Load lazily. ~300KB bundle |
| **CodeMirror 6** | **TRIAL** | For `diff-viewer.tsx`/`diff-hunk.tsx`/`diff-line.tsx` where line-level features (selection, search, folding) matter. ~150KB |
| **Monaco Editor** | **HOLD** | ~2MB+. Only justified for full code editor feature |

---

## 5. React Flow & Graph Layout

### Current State

React Flow (`@xyflow/react 12.10.1`) in 25 files across three features:

1. **Workflow Designer** (13 files) — 7 node types, 3 edge types, compact variants
2. **Agent Topology** (6 files) — read-only execution graph visualization
3. **Terraform Dependency Diagram** (3 files) — module deps with ELK auto-layout

ELK (`elkjs 0.11.0`) in 3 files for auto-layout.

### Assessment

| Technology | Recommendation | Rationale |
|---|---|---|
| **React Flow 12** (current) | **HOLD (keep)** | Most mature React graph library (18k+ stars). Deep integration across 25 files. No compelling alternative |
| **ELK** (current) | **HOLD (keep)** | Best for complex hierarchical layouts in workflow designer. ~145KB justified by layout quality |
| **Reaflow** | **HOLD** | Fewer features, less maintained |
| **dagre** | **HOLD** | Simpler but no compound nodes. Could replace ELK for Terraform deps only |
| **d3-dag** | **HOLD** | Lightweight DAG layout. Not enough for workflow designer |

**Action item:** Verify React Flow Pro license situation given `proOptions: { hideAttribution: true }` usage.

---

## 6. Animation & Transitions

### Current State

CSS-only animations extensively. `globals.css` defines 20+ keyframe animations (fadeIn, slideUp, bounce, pulse, spin, shimmer, agent-dash-flow, running-pulse, etc.). No JavaScript animation library installed.

### Assessment

| Technology | Recommendation | Rationale |
|---|---|---|
| **CSS keyframes** (current) | **HOLD (keep)** | Zero bundle cost. Full control via custom properties. 20+ animations cover current needs |
| **View Transitions API** | **TRIAL** | Zero-bundle-cost route transitions. Chrome 111+, Safari 18+. Use with TanStack Router via `startViewTransition` |
| **Motion (Framer Motion)** | **HOLD** | 32KB for nice-to-have features (AnimatePresence for exit animations, layout animations for Kanban). Not must-have |
| **React Spring** | **HOLD** | Physics-based. Overkill for subtle UI transitions |

---

## 7. Virtual Scrolling & Performance

### Current State

CSS `content-visibility: auto` with `contain-intrinsic-size` in stream panels. `useAutoScroll` hook. No virtual scrolling library. All lines rendered in DOM.

### Assessment

| Technology | Recommendation | Rationale |
|---|---|---|
| **content-visibility** (current) | Sufficient for 100-500 lines | Degrades at 1,000+ lines (DOM node count causes memory pressure) |
| **react-virtuoso** | **TRIAL** | `followOutput` feature matches agent streaming exactly. Variable-height items, scroll-to-bottom button. Replaces custom `useAutoScroll`. ~16KB |
| **TanStack Virtual** | **ASSESS** | Same ecosystem, lighter (~5KB). But requires manual implementation of streaming-specific features |
| **react-window** | **HOLD** | Superseded by TanStack Virtual |

### Recommendation

Start with `stream-panel.tsx` and `container-agent-stream.tsx`. react-virtuoso's `followOutput` is a direct match for the auto-scrolling agent output use case.

---

## 8. State Management for Complex UIs

### Current State

Multi-layered approach:

- TanStack DB collections (10 files) for server state sync
- TanStack Router loaders for data fetching
- `useState`/`useReducer` (726 occurrences, 124 files)
- Multiple React contexts (CodespaceContext, CliMonitorContext, TopologyContext, TerraformContext, FolderContext)

No external state management library.

### Friction Points

- Multiple context providers create nesting and verbose state sharing
- Custom `useBoardState` hook is essentially a mini state manager
- CliMonitorContext has substantial state (pane assignments, session mappings)

### Assessment

| Technology | Recommendation | Rationale |
|---|---|---|
| **Zustand** | **TRIAL** | 1.5KB. Replaces verbose Context+Reducer with simpler stores. No architecture change — adopt incrementally. 40k+ stars. Start with `useBoardState` and `CliMonitorContext` |
| **Jotai** | **ASSESS** | Atomic primitives. Good for fine-grained stream panel updates. Better for "many small independent pieces of state" |
| **Valtio** | **HOLD** | Proxy-based. Subtle bugs with non-primitive values |
| **Signals (@preact/signals-react)** | **HOLD** | React team has reservations. Monkey-patching approach. Risky for production |

---

## Priority Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **Integrate Shiki** into `markdown-content.tsx` for code fence highlighting | Low | Already installed, just needs wiring |
| 2 | **Add shadcn/ui** components selectively (command palette, scroll-area, data table) | Low | New components without building from scratch |
| 3 | **Trial Zustand** for Kanban board state and CLI monitor context | Low | Reduces context nesting, simpler stores |
| 4 | **Trial react-virtuoso** for `stream-panel.tsx` | Low-Medium | Improves long-session performance with built-in auto-scroll |
| 5 | **Trial View Transitions API** via TanStack Router for route transitions | Low | Zero bundle cost |
