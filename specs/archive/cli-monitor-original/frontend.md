# Frontend — CLI Monitor Page

Single-page component at `/cli-monitor` with three states. SSE subscription for live updates.

**Location**: `src/app/routes/cli-monitor/index.tsx` (~1,078 lines)

---

## Page States

```
                    daemon registers
    INSTALL --------------------------> WAITING
       ^                                   |
       |   daemon disconnects              | first session arrives
       |                                   v
       +------------------------------- ACTIVE
                                           |
                                           | all sessions removed
                                           v
                                        WAITING
```

| State | Trigger | UI |
|-------|---------|-----|
| `install` | No daemon connected | Install CTA with terminal command |
| `waiting` | Daemon connected, no sessions | Radar animation, "try running claude" prompt |
| `active` | Sessions present | Summary strip, session list, detail panel |

---

## `useCliMonitorState` Hook

Core state management hook. Handles SSE subscription, status polling, alerts, and offline detection.

### State

```typescript
{
  pageState: PageState;           // 'install' | 'waiting' | 'active'
  sessions: CliSession[];         // All tracked sessions
  daemonConnected: boolean;
  aggregateStatus: AggregateStatus; // 'nominal' | 'attention' | 'idle'
  alerts: AlertToast[];           // Up to 5
  connectionError: boolean;       // After 5 SSE failures
  isOffline: boolean;             // navigator.onLine tracking
}
```

### Behavior

**Install state polling:**
- Polls `GET /api/cli-monitor/status` every 3s
- Transitions to `waiting` or `active` when daemon connects

**SSE subscription (waiting/active states):**
- Opens `EventSource` to `GET /api/cli-monitor/stream`
- Handles: snapshot, daemon-connected, daemon-disconnected, session-update, session-removed
- On 5 consecutive `onerror` events → sets `connectionError = true`
- Reconnect is handled by browser's built-in EventSource reconnection

**Offline detection:**
- Listens to `window.online` / `window.offline` events
- Shows banner when offline

---

## Aggregate Status

Derived from all active sessions:

| Status | Condition | UI |
|--------|-----------|-----|
| `attention` | Any session is `waiting_for_approval` or `waiting_for_input` | Yellow WAITING badge |
| `nominal` | Any session is `working` (none waiting) | Green LIVE badge with pulse |
| `idle` | All sessions idle or no sessions | Gray IDLE badge |

---

## Install State

Full-screen centered layout:

1. **Hero icon** — Phosphor `Terminal` with accent glow
2. **Heading** — "Monitor your Claude Code sessions"
3. **Install command** — `$ npx @agentpane/cli-monitor` in a clickable code block
   - Click copies to clipboard, shows checkmark for 2s
   - Styled with accent border, hover lift effect
4. **Info strip** — Three items: watches path, runs locally, stop command
5. **Alternative install** — `npm i -g` and `brew install` options
6. **Ghost preview** — Faded placeholder bars showing what active state looks like

---

## Waiting State

Full-screen centered layout:

1. **Radar animation** — Three concentric pulsing rings (3s cycle, staggered 1s)
2. **Heading** — "Watching for sessions..."
3. **Prompt** — "Start a Claude Code session in any terminal"
4. **Example command** — `$ claude "fix the auth bug"` with blinking cursor

---

## Active State

### Summary Strip

4-column grid at the top (2-col on mobile):

| Card | Value | Detail |
|------|-------|--------|
| Active Sessions | Count | "X working · Y waiting · Z idle" |
| Total Tokens | Formatted (K/M) | "~$X.XX estimated" |
| Projects | Count | Comma-separated names |
| Active Branches | Count | Comma-separated branch names |

### Session List

- **Grouped by project** with uppercase section headers
- **Virtualized**: first 50 visible, intersection observer loads more
- Each session is a `SessionCard` button with:
  - Status dot (colored, pulsing for working)
  - Goal text (or session ID prefix)
  - Session ID · Project · Branch
  - Status badge
  - Token count

**ARIA:** Container has `role="listbox"`, cards have `role="option"` + `aria-selected`.

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Arrow Down` | Move focus to next session |
| `Arrow Up` | Move focus to previous session |
| `Enter` | Toggle selected session |
| `Escape` | Close detail panel |

Focused sessions scroll into view automatically.

### Session Detail Panel

Bottom panel (280px height), slides in from bottom. Full-screen overlay on mobile.

**Left side — Stream output:**
- Session ID + "Live" indicator + git branch
- Recent output in monospace (or "No output yet..." placeholder)

**Right side — Info (320px width):**
- Token breakdown (Input / Output / Cache / Ephemeral 5m / Ephemeral 1h / Total)
- Session info (Messages / Turns / Duration / Model)
- Action buttons (Approve / Input / Close)
  - Approve and Input are disabled ("Actions not yet connected to daemon")

**Focus management:** Panel receives focus when opened (`tabIndex={-1}`, `ref.focus()`).

---

## Alert Toasts

Positioned above the session list. Max 3 visible, overflow shows "+N more".

| Alert Type | Trigger | Auto-dismiss |
|------------|---------|--------------|
| `approval` | Session transitions to `waiting_for_approval` | No |
| `complete` | Session transitions from `working` to `idle` | Yes (5s) |
| `new-session` | New session detected (no previousStatus) | Yes (3s) |
| `input` | Session needs input | No |
| `error` | Session error | No |

Each toast has:
- Colored left border (attention/success/accent/danger/subtle)
- Title + detail (monospace, truncated)
- Dismiss button (×)

Container uses `<output>` element with `aria-live="polite"` for screen reader announcements.

---

## Error Handling

### Error Boundary

`CliMonitorErrorBoundary` wraps the main content. On error:
- Shows "Something went wrong" message with error text
- "Try again" button resets the boundary state

### Connection Error Banner

Red banner: "Connection lost — retrying..." shown after 5 SSE failures.

### Offline Banner

Yellow banner: "You are offline — updates will resume when connected" via `navigator.onLine`.

### Stale Session

If the selected session disappears from the session list (daemon disconnect or eviction), the detail panel auto-closes.

---

## Utility Functions

| Function | Description |
|----------|-------------|
| `formatTokenCount(n)` | `≥1M` → "X.XM", `≥1K` → "XK", else raw number |
| `estimateCost(tokens)` | Rough estimate at $5/1M tokens (averaged input+output) |
| `getSessionTokenTotal(s)` | Sum of all six token categories (input, output, cacheCreation, cacheRead, ephemeral5m, ephemeral1h) |
| `deriveAggregateStatus(sessions)` | attention > nominal > idle priority |

---

## Dependencies

| Package | Usage |
|---------|-------|
| `@phosphor-icons/react` | Terminal icon in install state |
| `@tanstack/react-router` | `createFileRoute('/cli-monitor/')` |
| `@/lib/api/client` | `apiClient.cliMonitor.status()` and `.getStreamUrl()` |
| `@/app/components/features/layout-shell` | Page layout with breadcrumbs and header actions |

---

## Sidebar Integration

The CLI Monitor page is registered in the sidebar navigation at `src/app/components/features/sidebar.tsx` as a top-level nav item.
