# 03 - Frontend Architecture Review

**Reviewer:** reviewer-3 (Opus Agent)
**Date:** 2026-02-17
**Scope:** Component architecture, state management, routing, real-time updates, design system, accessibility
**Severity Scale:** Critical / High / Medium / Low / Info

---

## 1. Overview

AgentPane's frontend is a React 19 single-page application built with TanStack Start (v1.150.0) and served by Vite 7. The UI layer combines Radix UI primitives with Tailwind CSS v4 and class-variance-authority (CVA) for component styling. Real-time agent streaming is handled through a custom DurableStreamsClient wrapping native EventSource, with TanStack DB collections used for local-first state in the CLI Monitor module.

The frontend is well-structured with a clear separation between UI primitives (`src/app/components/ui/`), feature components (`src/app/components/features/`), hooks (`src/app/hooks/`), and route definitions (`src/app/routes/`). The codebase demonstrates consistent patterns for component composition, context-based state sharing, and SSE-driven real-time updates.

**Overall Assessment:** The frontend architecture is solid for a mid-stage application. The component hierarchy is logical, the design token system is comprehensive, and real-time streaming patterns are well-implemented. Key areas for improvement include consolidating duplicated state patterns, strengthening accessibility coverage, eliminating deprecated API usage, and replacing native browser dialogs with the existing design system.

---

## 2. Component Architecture

### 2.1 Hierarchy and Organization

Components follow a two-tier structure:

```
src/app/components/
  ui/           # 20 primitive/design-system components (Button, Dialog, Tabs, etc.)
  features/     # 95+ feature components organized by domain
```

**UI Primitives** (`src/app/components/ui/`) are thin wrappers around Radix UI with CVA-based variants:
- `button.tsx` -- CVA variants (default, destructive, outline, ghost) with size tokens
- `dialog.tsx` -- Radix Dialog with styled overlay, content, header, footer
- `tabs.tsx`, `tooltip.tsx`, `select.tsx`, `dropdown-menu.tsx` -- Standard Radix wrappers
- `skeleton.tsx` -- Loading placeholder component
- `toast.tsx` / `toaster.tsx` -- Toast notification system

**Feature Components** are organized by domain:
- `kanban-board/` -- Drag-and-drop task board (dnd-kit)
- `agent-session-view/` -- Real-time agent streaming UI (7 sub-components)
- `approval-dialog/` -- Code/plan review with diff viewer (6 sub-components)
- `cli-monitor/` -- CLI session monitoring dashboard (16 sub-components)
- `terraform/` -- Terraform compose chat and module management
- `workflow-designer/` -- React Flow node/edge editor (7 nodes, 3 edges)
- `worktree-management/` -- Git worktree UI (6 sub-components + 3 dialogs)
- `project-picker/` -- Command-palette project switcher (4 sub-components)

### 2.2 Composition Patterns

Components use standard React patterns:
- **Radix + Slot:** Button supports `asChild` via `@radix-ui/react-slot` (`src/app/components/ui/button.tsx:38`)
- **forwardRef:** Used consistently in UI primitives for ref forwarding
- **CVA Variants:** Button, Skeleton, and activity icons use `class-variance-authority` for variant styling
- **Re-export Pattern:** Feature indexes re-export sub-components and types (e.g., `agent-session-view/index.tsx:403-424`)
- **Layout Shell:** `LayoutShell` component provides consistent sidebar + header + main layout (`src/app/components/features/layout-shell.tsx`)

### 2.3 Layout Structure

The root layout (`src/app/routes/__root.tsx:66-82`) wraps the app in:
```
ShortcutsProvider > ProjectContextProvider > TooltipProvider > [Outlet + Toaster + GlobalShortcuts]
```

Page layouts use `LayoutShell` (`src/app/components/features/layout-shell.tsx:19-76`) which provides:
- Collapsible sidebar (hidden on mobile via `md:flex`)
- Header with breadcrumbs or custom header slot
- Main content area with overflow handling

---

## 3. State Management

### 3.1 Context-Based State

The application uses four React Contexts:

| Context | File | Purpose |
|---------|------|---------|
| `ProjectContext` | `src/app/providers/project-context.tsx` | Current project, picker state, project list |
| `ServiceContext` | `src/app/services/service-context.tsx` | Server-side service injection (null on client) |
| `TerraformContext` | `src/app/components/features/terraform/terraform-context.tsx` | Compose chat state, SSE streaming |
| `CliMonitorContext` | `src/app/components/features/cli-monitor/cli-monitor-context.tsx` | Daemon state, sessions, alerts |

**ProjectContext** (`src/app/providers/project-context.tsx:66-206`) manages:
- Project list fetching and caching
- Current project selection (derived from URL params)
- Recent projects (persisted to localStorage)
- Picker and new-project dialog modal states
- Context value is memoized with full dependency tracking (`useMemo` at line 171)

**TerraformContext** (`src/app/components/features/terraform/terraform-context.tsx:188-599`) is the most complex context, managing:
- Chat message state with streaming updates
- SSE event processing for compose pipeline
- Module matching, code generation, and file extraction
- Client-side fallback extraction for HCL and Stacks files
- Abort controller for cancelling in-flight streams

### 3.2 TanStack DB Collections

TanStack DB (`@tanstack/db`) is used for local-first reactive state in specific features:

| Collection | File | Usage |
|------------|------|-------|
| `cliSessionsCollection` | `src/lib/cli-monitor/collections.ts` | CLI session state from daemon SSE |
| `sessionsCollection` | `src/lib/sessions/collections.ts` | Session history data |
| `taskCreationCollection` | `src/lib/task-creation/collections.ts` | Task creation state |
| `sandboxStatusCollection` | `src/lib/sandbox-status/collections.ts` | Sandbox health status |

Collections use `localOnlyCollectionOptions` with Zod schemas for validation and provide `upsert`, `delete`, and `bulkSync` operations. The CLI Monitor collection (`src/lib/cli-monitor/collections.ts:20-26`) demonstrates a clean pattern with `getKey` for primary key extraction and typed mutation helpers.

### 3.3 Custom Hooks

12 custom hooks in `src/app/hooks/`:

| Hook | File | Purpose |
|------|------|---------|
| `useAgentStream` | `use-agent-stream.ts` | Session stream subscription with typed events |
| `useSession` | `use-session.ts` | Full session state with presence, join/leave, heartbeat |
| `usePresence` | `use-presence.ts` | User presence tracking for collaborative sessions |
| `useContainerAgent` | `use-container-agent.ts` | Container agent lifecycle events |
| `useContainerAgentStatuses` | `use-container-agent-statuses.ts` | Multi-session agent status tracking |
| `useTerminal` | `use-terminal.ts` | Terminal emulator state |
| `useToast` | `use-toast.ts` | Toast notification dispatch |
| `useKeyboardShortcuts` | `use-keyboard-shortcuts.ts` | Shortcut registration and matching |
| `useQueuePosition` | `use-queue-position.ts` | Agent queue position polling |
| `useListFilters` | `use-list-filters.ts` | URL-synced list filtering |
| `useSandboxStatus` | `use-sandbox-status.ts` | Sandbox health subscription |
| `useServices` | `use-services.ts` | Service context accessor |

### 3.4 Data Fetching Pattern

Data fetching is done via an `apiClient` singleton (`src/lib/api/client.ts`) that wraps `fetch` with typed `ApiResponse<T>` return types. The client supports:
- Error code classification (network, parse, abort)
- Hardcoded base URL `http://localhost:3001` for API server
- Typed method namespaces (`apiClient.projects.*`, `apiClient.terraform.*`, etc.)

Most data fetching is done in `useEffect` hooks within route components (e.g., `src/app/routes/index.tsx:150-207`) rather than using TanStack Router loaders, resulting in client-side fetch waterfalls.

---

## 4. Routing

### 4.1 Route Structure

The application uses TanStack Router with file-based routing (43 route files in `src/app/routes/`):

```
/                           -- Dashboard (project list)
/projects                   -- Project list
/projects/$projectId        -- Project detail (Kanban board)
/projects/$projectId/tasks/$taskId -- Task detail
/projects/$projectId/settings -- Project settings
/projects/$projectId/git    -- Git view
/projects/$projectId/worktrees -- Worktree management
/agents                     -- Agent list
/agents/$agentId            -- Agent detail
/sessions                   -- Session history
/sessions/$sessionId        -- Session detail
/settings                   -- Layout route (sidebar tabs)
/settings/[subpage]         -- 10+ settings pages
/terraform                  -- Layout route
/terraform/[subpage]        -- Compose, modules, history, settings
/cli-monitor                -- Layout route
/cli-monitor/[subview]      -- Terminal, timeline views
/designer                   -- Workflow designer
/catalog                    -- Workflow catalog
/marketplace                -- Agent marketplace
/templates/org              -- Organization templates
/templates/project          -- Project templates
```

### 4.2 Route Configuration

Routes use `createFileRoute` and `createRootRouteWithContext<RouterContext>`:
- Root route provides error and not-found components (`src/app/routes/__root.tsx:14-82`)
- Typed router context provides service injection capability
- Layout routes (`/settings`, `/terraform`, `/cli-monitor`) use nested `Outlet`
- Dynamic segments use `$paramName` convention

### 4.3 Code Splitting

TanStack Start with Vite provides automatic route-level code splitting via `createFileRoute`. Each route file becomes a separate chunk. However, the heavy use of barrel exports in feature component indexes (e.g., `approval-dialog/index.tsx` re-exports 6 sub-components) may limit tree-shaking effectiveness for shared components.

---

## 5. Real-Time Updates

### 5.1 DurableStreamsClient

The core real-time system is the `DurableStreamsClient` class (`src/lib/streams/client.ts:500-648`):

- Wraps native `EventSource` with automatic reconnection
- Exponential backoff: initial 1s, max 30s, 2x multiplier
- Offset-based resume for missed events during disconnections
- Singleton instance via `getDurableStreamsClient()` (line 1076-1084)

**Event routing:** Raw SSE events are validated with Zod schemas and routed to typed callback channels:
- 5 core channels: `chunks`, `toolCalls`, `presence`, `terminal`, `agentState`
- 13 container-agent channels: `status`, `started`, `token`, `turn`, `toolStart`, `toolResult`, `message`, `complete`, `error`, `cancelled`, `planReady`, `worktree`, `fileChanged`

**Zod validation** is applied to every incoming event before routing (`src/lib/streams/client.ts:653-1005`). Invalid events are logged with `console.warn` and silently dropped -- a reasonable defensive strategy.

### 5.2 Session Hook Architecture

Two hooks provide session-level real-time state:

**`useSession`** (`src/app/hooks/use-session.ts:69-241`):
- Subscribes to DurableStreamsClient on mount
- Maintains `SessionState` with chunks, toolCalls, terminal, presence, agentState
- Auto-joins presence on mount, auto-leaves on cleanup
- 10-second presence heartbeat interval (line 232)
- Calls `join()` on mount but does not await the result before connecting to SSE (line 123)

**`useAgentStream`** (`src/app/hooks/use-agent-stream.ts:24-126`):
- Simpler hook for stream-only data (chunks, tools, agent state)
- Derives `fullText` from chunks via `useMemo` (line 111)
- Sets `connectionState` to `'connected'` immediately after calling `subscribeToSession` (line 102), before the `EventSource.onopen` fires

### 5.3 Terraform SSE Streaming

The Terraform compose uses a different SSE pattern (`src/app/components/features/terraform/terraform-context.tsx:292-525`):
- Two-step flow: POST to start job -> GET SSE event stream
- Manual `ReadableStream` reader with line-by-line SSE parsing
- Client-side fallback HCL extraction (`extractHclFromText` at line 100)
- Abort controller for cancellation
- This does NOT use the DurableStreamsClient -- it implements its own SSE parsing

---

## 6. Design System

### 6.1 Design Token System

A comprehensive CSS custom property system is defined in `src/app/styles/globals.css`:

**Theme-agnostic tokens** (lines 10-127):
- Border radius scale (4px - 9999px)
- Typography (Mona Sans, Fira Code fonts; 12px-32px size scale)
- Spacing (4px grid: 0-48px)
- Animation (50ms-300ms durations with named easings)
- Component tokens (buttons, inputs, cards, modals, icons)
- Layout constants (sidebar 240px, header 64px)

**Dark theme** (default, lines 129-228):
- GitHub-inspired dark palette
- 6-tier background scale (canvas through overlay)
- 3-tier border scale (default, muted, subtle)
- 3-tier foreground scale (default, muted, subtle)
- 7 semantic color groups (accent, success, danger, attention, done, secondary, claude)
- Syntax highlighting tokens

**Light theme** (lines 230+):
- Warm premium aesthetic with creamy whites
- Full semantic color mapping mirroring dark theme

### 6.2 Tailwind Integration

Tailwind v4 is used via `@tailwindcss/vite` plugin with a custom config (`tailwind.config.ts`). The CSS imports Tailwind via `@import "tailwindcss"` and references the config via `@config`. Semantic token classes map to CSS variables (e.g., `bg-canvas` -> `var(--bg-canvas)`, `text-fg` -> `var(--fg-default)`).

### 6.3 CVA Usage

`class-variance-authority` is used for component variant definitions:
- **Button** (`src/app/components/ui/button.tsx:6-28`): 4 variants x 4 sizes
- Pattern is consistent: `cva(base, { variants, defaultVariants })` exported alongside the component

### 6.4 Custom `cn` Utility

Instead of the common `clsx` + `tailwind-merge` pattern, the project uses a custom `cn()` utility (`src/lib/utils/cn.ts:1-27`):
- Handles strings, arrays, and conditional objects
- Does NOT use `tailwind-merge` -- class conflicts are not resolved
- Simpler and faster than `twMerge`, but may produce conflicting classes in edge cases

### 6.5 Theming

Theme toggle (`src/app/components/features/theme-toggle.tsx`) provides light/dark/system modes:
- Persisted to `localStorage` key `'theme'`
- Sets `data-theme` attribute and `dark` class on `<html>`
- System mode reads `prefers-color-scheme` via `matchMedia`
- Does NOT listen for system theme changes -- a media query listener is missing

---

## 7. Accessibility

### 7.1 Positive Patterns

- **Radix primitives** provide built-in a11y (Dialog, Tabs, DropdownMenu, Tooltip, Checkbox, Select)
- **`sr-only`** used for screen reader text (e.g., sidebar toggle at `layout-shell.tsx:47`, dialog close at `dialog.tsx:40`)
- **`role="application"`** on Kanban board (`kanban-board/index.tsx:265`)
- **`aria-label`** on Kanban board (`kanban-board/index.tsx:266`)
- **`data-testid`** attributes throughout for test automation
- **Keyboard sensor** in dnd-kit for keyboard-accessible drag-and-drop (`kanban-board/index.tsx:123-125`)
- **Keyboard shortcut system** with `useKeyboardShortcuts` and help modal

### 7.2 Gaps

- **ThemeToggle dropdown** (`src/app/components/features/theme-toggle.tsx:73-97`) is a custom dropdown without `role="menu"`, `aria-expanded`, `role="menuitem"`, or focus trapping -- should use Radix DropdownMenu
- **File tabs in approval dialog** (`src/app/components/features/approval-dialog/file-tabs.tsx`) use `role="tabpanel"` on diff panels but the tab list implementation should be verified for complete WAI-ARIA tab pattern
- **Search input on dashboard** (`src/app/routes/index.tsx:467-472`) lacks `aria-label` or associated `<label>`
- **Keyboard navigation** not implemented for Kanban card actions beyond drag-and-drop

---

## 8. Findings

### FE-001: Hardcoded API Base URL
**Severity:** High
**Description:** The API client hardcodes `http://localhost:3001` as the base URL, preventing deployment to any environment without code changes.
**File:** `src/lib/api/client.ts:12`
```typescript
const API_BASE = 'http://localhost:3001';
```
**Recommendation:** Read the API base URL from an environment variable (`import.meta.env.VITE_API_URL`) or derive it from `window.location.origin` for same-origin deployments. Provide a default for local development.

---

### FE-002: Deprecated `navigator.platform` Usage
**Severity:** Medium
**Description:** `navigator.platform` is deprecated and will be removed from browsers. Used in two files for platform detection.
**Files:**
- `src/app/hooks/use-keyboard-shortcuts.ts:63`
- `src/app/components/features/project-picker/search-input.tsx:18`
```typescript
return navigator.platform.toLowerCase().includes('mac');
```
**Recommendation:** Replace with `navigator.userAgentData?.platform` (with fallback to `navigator.userAgent` parsing) or use the `ua-parser-js` approach for robust cross-browser detection.

---

### FE-003: `window.confirm` Used Instead of Design System Dialogs
**Severity:** Medium
**Description:** Native `window.confirm()` dialogs are used for destructive actions in 7 locations, breaking the visual design and preventing customization.
**Files:**
- `src/app/routes/templates/project.tsx:179`
- `src/app/routes/templates/org.tsx:107`
- `src/app/routes/marketplace/index.tsx:201`
- `src/app/routes/catalog/$workflowId.tsx:72`
- `src/app/routes/catalog/index.tsx:488`
- `src/app/components/features/terraform/terraform-settings-panel.tsx:136`
- `src/app/components/features/agent-session-view/index.tsx:282`
**Recommendation:** Replace with a reusable confirmation dialog component using the existing `Dialog` primitive from `src/app/components/ui/dialog.tsx`. This would support theming, keyboard navigation, and consistent styling.

---

### FE-004: ThemeToggle Does Not Listen for System Theme Changes
**Severity:** Medium
**Description:** When "System" theme is selected, the theme is set once on mount but does not react to OS-level theme changes (e.g., switching from light to dark mode).
**File:** `src/app/components/features/theme-toggle.tsx:35-47`
**Recommendation:** Add a `matchMedia` change listener in the theme effect:
```typescript
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const handler = (e: MediaQueryListEvent) => { /* update theme */ };
mq.addEventListener('change', handler);
return () => mq.removeEventListener('change', handler);
```

---

### FE-005: ThemeToggle Custom Dropdown Lacks Accessibility
**Severity:** Medium
**Description:** The theme toggle uses a custom `<div>` dropdown that lacks ARIA attributes (`role="menu"`, `aria-expanded`, `role="menuitem"`), focus trapping, and keyboard navigation (arrow keys). Click-outside-to-close is also not implemented.
**File:** `src/app/components/features/theme-toggle.tsx:56-98`
**Recommendation:** Replace the custom dropdown with the existing Radix `DropdownMenu` primitive already used elsewhere in the app, which provides all necessary accessibility features out of the box.

---

### FE-006: Dashboard Data Fetching Waterfall
**Severity:** Medium
**Description:** The dashboard route (`index.tsx`) fires 4 independent API calls sequentially in a `useEffect` (Anthropic key check, GitHub token check, repo discovery, sandbox config fetch) without parallelization. Each call is an independent `async` function invoked sequentially.
**File:** `src/app/routes/index.tsx:150-207`
**Recommendation:** Use `Promise.all` or `Promise.allSettled` to parallelize these independent requests. Alternatively, use TanStack Router's `loader` function for server-side prefetching.

---

### FE-007: Connection State Set Before EventSource Opens
**Severity:** Low
**Description:** In `useAgentStream` and `useSession`, `connectionState` is set to `'connected'` immediately after creating the subscription, before the `EventSource.onopen` fires.
**Files:**
- `src/app/hooks/use-agent-stream.ts:102` -- `setConnectionState('connected')` after `subscribeToSession`
- `src/app/hooks/use-session.ts:209` -- `setConnectionState('connected')` after `subscribeToSession`
**Recommendation:** Remove the immediate `setConnectionState('connected')` call. The `DurableStreamsClient` already sets `state = 'connected'` in the `onopen` handler (line 537), and the `onReconnect` callback updates state on reconnection.

---

### FE-008: DurableStreamsClient Has 1100+ Lines with Repetitive Switch Cases
**Severity:** Low
**Description:** The `mapRawEventToTyped` function (`src/lib/streams/client.ts:653-1005`) contains 18 near-identical switch cases, each parsing with a Zod schema and returning a typed event. The `routeEventToCallback` function (lines 1010-1067) mirrors this with 18 routing cases.
**File:** `src/lib/streams/client.ts` (1106 lines total)
**Recommendation:** Create a registry/map pattern:
```typescript
const eventHandlers = {
  'chunk': { schema: rawChunkDataSchema, channel: 'chunks' },
  'container-agent:status': { schema: rawContainerAgentStatusSchema, channel: 'containerAgent:status' },
  // ...
} as const;
```
This would reduce the file by ~400 lines while maintaining type safety.

---

### FE-009: Duplicate Theme Application Logic in Three Files
**Severity:** Low
**Description:** The theme application logic (reading `matchMedia('prefers-color-scheme: dark')`, setting `data-theme`, toggling `dark` class) is duplicated in three separate files.
**Files:**
- `src/app/components/features/theme-toggle.tsx:35-47`
- `src/app/routes/settings/appearance.tsx:294`
- `src/app/components/features/global-settings.tsx:337`
**Recommendation:** Extract theme application into a shared utility (e.g., `src/lib/utils/theme.ts`) or a `useTheme` hook that centralizes the logic and provides a single source of truth.

---

### FE-010: Custom `cn` Utility Does Not Resolve Tailwind Class Conflicts
**Severity:** Low
**Description:** The custom `cn()` utility (`src/lib/utils/cn.ts`) concatenates class names but does not use `tailwind-merge` to resolve conflicting Tailwind classes. When a component passes both `bg-accent` and `bg-danger` via `className` prop, both classes will be emitted.
**File:** `src/lib/utils/cn.ts:24-26`
**Recommendation:** Consider adding `tailwind-merge` for cases where components accept `className` overrides. The current approach is simpler and faster, so this is a tradeoff -- only add it if class conflicts become a practical issue.

---

### FE-011: TerraformContext Uses Separate SSE Implementation
**Severity:** Low
**Description:** The Terraform compose feature implements its own SSE parsing (`ReadableStream` reader with manual line splitting) rather than using the shared `DurableStreamsClient`. This creates two parallel SSE implementations to maintain.
**File:** `src/app/components/features/terraform/terraform-context.tsx:292-465`
**Recommendation:** This is architecturally intentional (the compose pipeline uses a POST+GET pattern vs. pure EventSource), but consider abstracting the SSE line parsing into a shared utility to avoid duplicating the `buffer.split('\n')` / `data: ` prefix stripping logic.

---

### FE-012: Dashboard Polling at 15s Idle May Be Excessive
**Severity:** Info
**Description:** The dashboard polls the project list every 15 seconds even when no agents are running (5s when agents are active). This creates continuous API load even when the page is idle.
**File:** `src/app/routes/index.tsx:239`
**Recommendation:** Consider using `document.hidden` / `visibilitychange` to pause polling when the tab is not visible. The 15s idle interval could also be increased to 30-60s since project list changes are infrequent.

---

### FE-013: Kanban Board Multi-Select Without Batch Move
**Severity:** Info
**Description:** The Kanban board supports multi-select (Shift/Ctrl+click via `useBoardState`), but drag-and-drop only moves the single dragged card. Selected cards are visually highlighted but not moved together.
**File:** `src/app/components/features/kanban-board/index.tsx:158-194`
**Recommendation:** Either implement batch move for multi-selected cards during drag, or remove the multi-select visual affordance to avoid user confusion.

---

### FE-014: `useSession` Join Race Condition
**Severity:** Info
**Description:** The `useSession` hook calls `void join()` (fire-and-forget) at line 123, then immediately subscribes to the SSE stream. If the join POST fails or is slow, the stream subscription may miss initial events or fail to establish presence.
**File:** `src/app/hooks/use-session.ts:123`
**Recommendation:** Await the join before subscribing, or accept the race condition as acceptable (since the SSE `connected` handshake serves as an implicit join acknowledgment).

---

### FE-015: Search Input on Dashboard Missing Label
**Severity:** Low
**Description:** The project search input on the dashboard uses a placeholder but has no `<label>` element or `aria-label` attribute for screen reader users.
**File:** `src/app/routes/index.tsx:467-472`
```html
<input type="text" placeholder="Search projects..." />
```
**Recommendation:** Add `aria-label="Search projects"` to the input element.

---

## 9. Summary

### Strengths
- Clean component hierarchy with clear UI/feature separation
- Comprehensive design token system with dark and light themes
- Well-typed real-time streaming with Zod validation on all SSE events
- Good use of Radix primitives for accessible UI components
- TanStack DB collections for reactive local-first state
- Keyboard shortcut system with configurable registration and help modal

### Areas for Improvement
- Replace hardcoded API URL with environment-based configuration (FE-001)
- Replace `window.confirm` with design system dialog component (FE-003)
- Improve theme toggle accessibility and system change detection (FE-004, FE-005)
- Consolidate duplicated patterns (theme logic, SSE parsing) (FE-009, FE-011)
- Leverage TanStack Router loaders instead of client-side fetch waterfalls (FE-006)
- Address deprecated `navigator.platform` usage (FE-002)

### Risk Assessment
- **Deployment Risk:** Hardcoded localhost URL (FE-001) blocks production deployment
- **UX Risk:** Native dialogs break design consistency (FE-003)
- **Accessibility Risk:** ThemeToggle dropdown and unlabeled inputs (FE-005, FE-015)
- **Maintenance Risk:** Large monolithic streams client and duplicated patterns (FE-008, FE-009)
