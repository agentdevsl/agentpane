# Production Gaps — Known Issues & Future Work

Tracking known gaps, hardening backlog, and future features.

---

## Completed (Rounds 1-3)

The following gaps have been addressed across three rounds of hardening:

- Zod validation on all POST endpoints
- Body size limit (5MB) on all POST endpoints
- SSE connection limit (50 max with 429 response)
- Session pagination (`?limit=100&offset=0`)
- Circuit breaker in daemon HTTP client (5 failures → 60s open)
- Daemon session store bounded to 1,000 sessions with LRU eviction
- Structured JSON logger with `LOG_LEVEL` env control
- File descriptor leak fix (try/finally in processFile)
- File truncation detection (offset reset when stat.size < offset)
- Async shutdown race fix (signal handlers await shutdown, 5s forced exit)
- PKG_VERSION build injection
- Symlink resolution (realpath) before path containment check
- Partial UTF-8 handling (skip continuation bytes at buffer start)
- Registration retry with exponential backoff (1s → 30s cap)
- JSONL types expansion (thinking blocks, progress events, ephemeral cache tokens — `RawTokenUsage`, `RawProgressData`, exported constants)
- React error boundary with recovery UI
- Session list virtualization (50 initial, intersection observer for more)
- Stale session auto-close in detail panel
- Browser offline/online detection with banner
- Keyboard navigation (Arrow keys + Enter) with ARIA roles
- Focus management for detail panel
- Responsive detail panel (full-screen overlay on mobile)
- Heartbeat timeout auto-deregistration (30s)
- Server lifecycle cleanup (destroy on shutdown)

---

## Open Gaps

### Critical

None currently identified.

### High Priority

| Gap | Component | Description |
|-----|-----------|-------------|
| Bidirectional actions | Daemon + Frontend | Approve/Input buttons are disabled. Need daemon-side stdin injection or Claude Code API for approving tool use |
| npm publish | Daemon | Package configured but not published. Needs npm auth + CI workflow |
| Homebrew tap | Daemon | Formula drafted, no tap repository created |

### Medium Priority

| Gap | Component | Description |
|-----|-----------|-------------|
| Session persistence | Server | Sessions are in-memory only. Server restart loses all state. Consider optional SQLite persistence |
| Daemon auto-start | Daemon | No launchd/systemd integration. Users must manually start daemon after reboot |
| Multi-daemon support | Server | Server accepts only one daemon at a time (latest wins). Could support multiple daemons watching different directories |
| Subagent visualization | Frontend | Subagents are filtered from the list. Could show parent→child relationship tree |
| Session search/filter | Frontend | No search or filter UI. Could filter by project, status, branch, or keyword in goal |
| Token cost accuracy | Frontend | Cost estimate uses flat $5/1M average. Should differentiate input/output/cache rates by model |
| Audio notifications | Frontend | Alert toasts are visual only. Could add optional audio cues for approval-needed state |

### Low Priority

| Gap | Component | Description |
|-----|-----------|-------------|
| Dark/light theme sync | Frontend | Uses Tailwind dark classes but doesn't sync with system theme toggle |
| Session export | Frontend | No way to export session data (CSV, JSON) for analysis |
| Historical view | Frontend | No persistence means no historical trends or session replay |
| Rate limiting per daemon | Server | Global rate limiter applies. Could have daemon-specific limits |
| Metrics endpoint | Server | No Prometheus/OpenTelemetry metrics for session counts, ingest rates |
| WebSocket upgrade | Server | SSE is one-directional. WebSocket would enable bidirectional actions |

---

## Test Coverage Status

| Area | Status | Location |
|------|--------|----------|
| JSONL parser | 130+ tests | `packages/cli-monitor/src/__tests__/parser.test.ts` |
| Session store | Complete | `packages/cli-monitor/src/__tests__/session-store.test.ts` |
| AgentPane client + circuit breaker | Complete | `packages/cli-monitor/src/__tests__/agentpane-client.test.ts` |
| Daemon lifecycle | Complete | `packages/cli-monitor/src/__tests__/daemon.test.ts` |
| File watcher | Complete | `packages/cli-monitor/src/__tests__/watcher.test.ts` |
| Server service | Complete | `src/services/cli-monitor/__tests__/cli-monitor.service.test.ts` |
| Server routes | Complete | `src/server/routes/__tests__/cli-monitor.test.ts` |
| Frontend components | Not started | — |
| E2E (daemon → server → frontend) | Not started | — |

---

## Future Features

### Phase 2: Bidirectional Actions

Enable the Approve/Input buttons in the detail panel to interact with running CLI sessions.

**Options:**
1. **File-based protocol**: Write approval/input to a sentinel file the daemon watches
2. **Claude Code API**: Use Claude Code's programmatic API (if/when available) to inject approvals
3. **stdin proxy**: Daemon maintains stdin handle to CLI process (requires daemon to launch Claude Code)

### Phase 3: Multi-Machine Support

Support monitoring CLI sessions across multiple machines from a single dashboard.

**Requirements:**
- Daemon-to-server communication over network (not just localhost)
- Authentication between daemon and server
- Machine identification in session metadata
- Network-aware circuit breaker and retry

### Phase 4: Session Analytics

Historical analysis of CLI usage patterns.

**Requirements:**
- SQLite persistence for completed sessions
- Aggregate dashboards (tokens/day, sessions/project, model usage)
- Session timeline replay
- Cost tracking and budgets
