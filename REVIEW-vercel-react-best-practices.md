# Vercel React Best Practices Review - Consolidated Report

**Date:** 2026-03-16 | **Branch:** `react-review` | **Reviewers:** 6 OPUS Agents

## Executive Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| CRITICAL | 13 | Barrel file re-exports, missing dynamic imports, sequential async |
| HIGH | 21 | Missing request dedup, unstable context values, no content-visibility, localStorage safety, inline components |
| MEDIUM | 43 | Drag hooks in state, derived state via effects, unmemoized computations, callback churn, regex in hot loops |
| LOW | 37 | Hoisted constants, inline styles, duplicated utilities, toggle setState |
| **TOTAL** | **114** | |

---

## CRITICAL Findings (13)

### Bundle: Barrel File Re-exports (7 instances)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| C-1.1 | `src/lib/errors/index.ts` | 14 `export *` re-exports (mitigated: no current consumers) | 1 |
| C-1.2 | `src/lib/sessions/index.ts` | 7 `export *` re-exports (mitigated: no current consumers) | 1 |
| C-6.1 | `src/app/components/features/index.ts` | 20+ feature component re-exports - **highest impact** | 6 |
| C-6.2 | `src/app/components/features/plan-session-view/index.tsx:361` | `export * from './types'` wildcard | 6 |
| C-6.3 | `src/app/components/features/workflow-designer/nodes/index.ts:85` | `export * from './styles'` pulls all CVA styles | 6 |
| C-5.1 | `src/app/components/features/worktree-management/index.ts` | 67 re-exports spanning dialogs, hooks, utilities | 5 |
| C-2.1 | All component files | `@phosphor-icons/react` barrel imports across 30+ files (200-800ms per site) | 2,5 |

### Bundle: Missing Dynamic Imports (3 instances)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| C-2.2 | `kanban-board.tsx` | `@dnd-kit/core` + `@dnd-kit/sortable` statically imported | 2 |
| C-3.2 | `agent-session-view/index.tsx:2` | `AgentTopology` (React Flow + ELK.js) eagerly loaded | 3 |
| C-4.1 | `terraform-right-panel.tsx:142` | `shiki` (~300KB) re-imported on every code change instead of preloaded | 4 |

### Async: Sequential Calls (1 instance)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| C-4.2 | `terraform-context.tsx:254-257` | `refreshModules` calls `loadModules()` then `loadRegistries()` sequentially | 4 |

### Content Visibility (2 instances)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| C-3.1 | `stream-panel.tsx`, `container-agent-stream.tsx`, `container-agent-tool-list.tsx` | No `content-visibility:auto` on high-frequency streaming lists (100s of items) | 3 |
| H-2.3 | `kanban-board.tsx` | No `content-visibility` on kanban card lists | 2 |

---

## HIGH Findings (21)

### Data Fetching & Dedup (3)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-1.1 | `use-settings.ts:44-85` | No request deduplication in `fetchSettings()` - thundering herd | 1 |
| H-1.2 | `use-settings.ts:176-261` | Manual useEffect+useState cache instead of SWR/dedup hook | 1 |
| H-1.3 | `sandbox-status/sync.ts:18-49` | Raw `fetch()` bypasses `apiClient`, no dedup | 1 |

### Re-render: Unstable References (6)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-3.1 | `use-session.ts:216` | Effect depends on `join`/`leave` callbacks, causing SSE reconnection loops | 3 |
| H-3.3 | `agent-session-view/index.tsx:181-188` | `useEffect` with `[state]` triggers on every SSE event | 3 |
| H-4.2 | `terraform-context.tsx:647` | Inline `clearError: () => setError(null)` breaks useMemo for entire context | 4 |
| H-4.3 | `terraform-chat-panel.tsx:618-633` | `handleSubmit` depends on `input` state, recreated every keystroke | 4 |
| H-5.3 | `worktree-management.tsx:336` | `allWorktrees = [...active, ...stale]` recreated every render | 5 |
| H-5.4 | `cli-monitor/summary-strip.tsx:49-59` | 6 separate unmemoized array iterations | 5 |

### Duplicate Subscriptions (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-3.2 | `agent-session-view/index.tsx:143-144` | `useSession` + `useAgentStream` both open SSE to same session | 3 |
| H-3.L4 | `use-presence.ts` + `use-session.ts` | Both send presence heartbeats (15s + 10s intervals) | 3 |

### Inline Components (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-4.1 | `terraform-module-detail.tsx:322-356` | ReactMarkdown `components` prop with inline arrow functions | 4 |
| H-6.2 | `plan-stream-panel.tsx:39-46,65-70` | Inline `<style>` tags with @keyframes re-injected every render | 6 |

### Dynamic Import Opportunities (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-6.3 | `workflow-designer/index.tsx:9` | `AIGenerateDialog` (720+ lines) loaded eagerly | 6 |
| H-6.4 | `workflow-designer/SaveWorkflowDialog.tsx` | Save dialog loaded eagerly, only shown on user action | 6 |

### Client: localStorage Safety (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-5.1 | `settings/appearance.tsx:99-112` | No try-catch, no version prefix on `localStorage.getItem('theme')` | 5 |
| H-5.2 | `settings/github.tsx:58-68` | GitHub PAT stored in plaintext localStorage | 5 |

### Unmemoized Derived Arrays (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-2.1 | `kanban-board.tsx:128-131` | `getTasksByColumn` creates new arrays per column per render | 2 |
| H-2.2 | `routes/index.tsx:544-550` | `activeAgents` mapped inline in `.map()` loop | 2 |

---

## MEDIUM Findings (43)

### Re-render: Drag/Resize Hooks Using State (3)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-2.2 | `task-detail-dialog/index.tsx:17-65` | `useDraggable` stores position in state (60+ re-renders/sec) | 2 |
| M-2.3 | `new-task-dialog.tsx:52-168` | `useDraggableDialog` + `useResizableDialog` same pattern | 2 |
| M-3.4 | `stream-panel.tsx`, `container-agent-stream.tsx` | `autoScroll`/`userScrolled` in state triggers re-renders on scroll | 3 |

### Re-render: Derived State via Effects (5)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-2.1 | `new-task-dialog.tsx:981-989` | `editableSuggestion` synced from `suggestion` via effect | 2 |
| M-2.9 | `new-task-dialog.tsx:1045-1050` | `createdTaskId` effect should be in event handler | 2 |
| M-4.6 | `terraform-right-panel.tsx:36-53` | 3 useEffects manage tab/file state transitions | 4 |
| M-3.6 | `use-session-data.ts:186` | `fullText` recomputed every render (should be useMemo) | 3 |
| M-3.7 | `use-session-data.ts:183-185` | `pendingToolCalls` filter not memoized | 3 |

### Re-render: Callback Dependency Churn (8)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-2.4 | `routes/index.tsx:268-345` | `handleCreateProject` etc. not wrapped in useCallback | 2 |
| M-2.5 | `new-task-dialog.tsx:58-66` | `handleMouseDown` recreated on every size change | 2 |
| M-2.6 | `new-task-dialog.tsx:116-135` | `handleDragStart` recreated on every position change | 2 |
| M-2.8 | `task-detail-dialog/index.tsx:225-265` | `handleKeyDown` effect re-registers on every keystroke | 2 |
| M-3.3 | `use-container-agent.ts:393-408` | Effect has 14 callback dependencies | 3 |
| M-3.8 | `sessions/$sessionId.tsx:229-258` | `onPause`/`onResume`/`onStop` inline async closures | 3 |
| M-4.4 | `terraform-settings-panel.tsx:60-69` | `handleSync` depends on `isSyncing` state | 4 |
| M-5.6 | Settings pages (4 files) | `handleSave` not wrapped in useCallback | 5 |

### Re-render: Timer / Interval (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-3.9 | `header-bar.tsx:84-96`, `container-agent-header.tsx:111-123` | `setElapsedTime` causes re-render every second | 3 |
| M-3.5 | `use-session-data.ts:69` | `useSessionPresence` cutoff computed at render time, stale | 3 |

### Re-render: Context Value (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-5.3 | `cli-monitor-context.tsx:161-174` | Context value object recreated every render | 5 |
| M-5.4 | `cli-monitor-context.tsx:159` | `aggregateStatus` computed inline without memoization | 5 |

### Re-render: No-op / Trivial Memo (1)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-3.1 | `use-session.ts:237` | `useMemo(() => state, [state])` is a no-op | 3 |

### JS Performance: Unmemoized Computations (6)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-3.2 | `agent-session-view/index.tsx:347-355` | `viewerColors` computed in render body | 3 |
| M-4.1 | `terraform-chat-panel.tsx:182-183` | `answeredCount` filter not memoized | 4 |
| M-4.2 | `terraform-chat-panel.tsx:139-145` | `getCategoryColor` iterates Object.entries on every call | 4 |
| M-5.5 | `cli-monitor/index.tsx:246,278-288` | `flatSessions` and `projectGroups` duplicate subagent filtering | 5 |
| M-5.9 | `cli-monitor/summary-strip.tsx:108-157` | `CompactionSummaryCard` nested loops not memoized | 5 |
| M-6.6 | `workflow-designer/index.tsx:291-296` | `JSON.stringify({nodes, edges})` on every change (5-50ms) | 6 |

### JS Performance: Combined Iterations (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| H-3.4 | `container-agent-tool-list.tsx:130-132` | 3 `.filter()` calls on same tools array | 3 |
| M-6.5 | `TemplatePicker.tsx:163-164` | 2 `.filter()` calls on templates | 6 |

### JS Performance: Regex Hoisting (2)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-5.7 | `cli-monitor/cards-right-panel.tsx:145-206` | Regex objects recreated in hot `StreamLine` component | 5 |
| L-4.4 | `terraform-chat-panel.tsx:154` | Regex in `stripAssistantContent` | 4 |

### Async: Unbatched API Calls (1)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-2.7 | `routes/index.tsx:150-207` | 4 separate async setState calls on mount (4 renders) | 2 |

### Async: Overlapping Polls (1)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-1.3 | `sandbox-status/sync.ts:73-78` | `setInterval` fires regardless of previous fetch completion | 1 |

### Miscellaneous (3)

| ID | File | Issue | Agent |
|----|------|-------|-------|
| M-4.3 | `terraform-chat-panel.tsx:277-284` | IIFE inside setState (readability) | 4 |
| M-4.7 | `terraform-context.tsx:207-209` | Manual ref sync for composeMode | 4 |
| M-6.7 | `plan-session-view/index.tsx:172-179` | `handleAnswerInteraction` depends on `state.pendingInteraction` | 6 |

---

## Priority Implementation Order

### Phase 1: Quick Wins (High Impact, Easy Fix)

1. **C-4.2**: `Promise.all([loadModules(), loadRegistries()])` - 1 line change
2. **C-4.1**: Preload shiki at module scope - move `import('shiki')` outside useEffect
3. **H-4.2**: Hoist `clearError` to `useCallback(() => setError(null), [])`
4. **H-4.1**: Hoist ReactMarkdown `components` to module scope
5. **H-3.3**: Narrow `[state]` dependency to `[hasData]` boolean
6. **M-3.1**: Remove no-op `useMemo(() => state, [state])`
7. **H-3.4/M-6.5**: Combine `.filter()` calls into single loops
8. **H-5.3**: Memoize `allWorktrees` with useMemo
9. **H-5.4**: Memoize `SummaryStrip` aggregations into single pass
10. **M-5.3**: Memoize CLI monitor context value
11. **M-5.4**: Memoize `aggregateStatus`

### Phase 2: Medium Effort (High Impact)

12. **C-3.1/H-2.3**: Add `content-visibility:auto` to streaming lists and kanban cards
13. **H-3.2**: Eliminate duplicate SSE subscription (derive `isStreaming` from `state.agentState`)
14. **H-3.1**: Use refs for `join`/`leave` callbacks in useSession effect
15. **C-3.2**: Lazy-load `AgentTopology` with React.lazy()
16. **H-6.3/H-6.4**: Lazy-load `AIGenerateDialog` and `SaveWorkflowDialog`
17. **C-2.2**: Lazy-load KanbanBoard (wraps @dnd-kit)
18. **H-2.1**: Memoize `getTasksByColumn` with useMemo
19. **M-2.2/M-2.3**: Convert drag/resize hooks to use refs + direct DOM manipulation
20. **M-2.7**: Batch mount API calls with Promise.all + single state update
21. **H-4.3**: Use ref for `input` in `handleSubmit` to avoid keystroke recreation
22. **H-6.2**: Move @keyframes to CSS file, hoist style elements

### Phase 3: Architectural (Highest Impact, Most Effort)

23. **C-6.1**: Remove `src/app/components/features/index.ts` barrel, convert to direct imports
24. **C-5.1**: Deprecate worktree-management barrel, use direct imports
25. **C-6.3**: Remove `export * from './styles'` in nodes barrel
26. **C-2.1**: Configure Vite plugin or convert all `@phosphor-icons/react` to direct imports
27. **H-1.1**: Add request deduplication to `fetchSettings()`
28. **H-1.3**: Replace raw `fetch()` in sandbox-status with `apiClient`
29. **M-6.6**: Replace `JSON.stringify` change detection with counter approach

### Phase 4: Polish (Lower Impact)

30. **H-5.1/H-5.2**: Add try-catch and versioning to localStorage access
31. **M-3.3**: Consolidate `useContainerAgent` effect callbacks via refs
32. **M-3.8**: Extract inline async closures to useCallback
33. **M-3.9**: Use ref + direct DOM update for elapsed time display
34. **M-5.7**: Hoist regex constants in StreamLine
35. All remaining LOW findings

---

## Findings by Rule Category

| Category | Count | Key Rules |
|----------|-------|-----------|
| **Bundle** | 16 | `barrel-imports` (10), `dynamic-imports` (6) |
| **Re-render** | 47 | `memo` (8), `derived-state` (7), `functional-setState` (10), `dependencies` (8), `use-ref-transient` (5), `no-inline-components` (4), `transitions` (2), `simple-expression-in-memo` (1), `defer-reads` (1), `lazy-state-init` (1) |
| **Async** | 6 | `parallel` (2), `suspense-boundaries` (1), unbatched (2), overlapping polls (1) |
| **JS Perf** | 16 | `cache-function-results` (6), `combine-iterations` (4), `hoist-regexp` (3), `set-map-lookups` (1), `index-maps` (1), `cache-property-access` (1) |
| **Rendering** | 7 | `content-visibility` (3), `hoist-jsx` (2), `conditional-render` (2) |
| **Client** | 5 | `localStorage-schema` (2), `event-listeners` (2), `swr-dedup` (1) |
| **Advanced** | 2 | `event-handler-refs` (2) |

---

## Agent Reports

Individual detailed reports with before/after code for each finding are available in the agent output files:

- Agent 1 (Core Infrastructure): 12 findings
- Agent 2 (Dashboard/Kanban): 22 findings
- Agent 3 (Sessions/Containers): 21 findings
- Agent 4 (Terraform Composer): 19 findings
- Agent 5 (Settings/CLI/Worktrees): 19 findings
- Agent 6 (Workflows/Templates/UI): 21 findings
