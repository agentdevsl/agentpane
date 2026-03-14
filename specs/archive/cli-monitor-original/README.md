# CLI Monitor — Consolidated Specification

Bring your own agent, centralised visibility.

Monitor all Claude Code CLI sessions running on your machine from a single dashboard. A standalone daemon watches `~/.claude/projects/` for JSONL session logs, parses them incrementally, and streams session state to AgentPane's frontend via SSE.

---

## Document Tree

```
specs/CLI_monitor/
├── README.md                        # This file — overview and navigation
├── architecture.md                  # System architecture, data flow, component boundaries
├── daemon.md                        # External daemon package (@agentpane/cli-monitor)
├── server.md                        # AgentPane server receiver, API routes, SSE
├── frontend.md                      # UI states, components, interactions
├── jsonl-format.md                  # Claude Code CLI JSONL event format reference
├── wireframes.md                    # Wireframe catalog and design direction
└── production-gaps.md               # Known gaps, hardening backlog, future work
```

---

## Quick Reference

| Question | Document |
|----------|----------|
| How does the system work end-to-end? | [architecture.md](./architecture.md) |
| How do I install the daemon? | [daemon.md](./daemon.md) |
| What API endpoints exist? | [server.md](./server.md) |
| What does the UI look like? | [frontend.md](./frontend.md) |
| What's the JSONL event format? | [jsonl-format.md](./jsonl-format.md) |
| What wireframes exist? | [wireframes.md](./wireframes.md) |
| What's still TODO? | [production-gaps.md](./production-gaps.md) |

---

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| Daemon package | Complete (~1,237 lines) | `packages/cli-monitor/src/` |
| Daemon tests | Complete (130+ tests) | `packages/cli-monitor/src/__tests__/` |
| Server service | Complete (~416 lines) | `src/services/cli-monitor/` |
| Server routes | Complete (323 lines, 7 endpoints) | `src/server/routes/cli-monitor.ts` |
| Frontend page | Complete (1,078 lines) | `src/app/routes/cli-monitor/index.tsx` |
| Sidebar nav | Integrated | `src/app/components/features/sidebar.tsx` |
| API client | Integrated | `src/lib/api/client.ts` |
| Wireframes | 21 HTML designs | `specs/application/wireframes/cli-monitor/` |
| npm publish | Configured, pending auth | `packages/cli-monitor/package.json` |
| Homebrew tap | Formula drafted, no tap repo | `packages/cli-monitor/Formula/` |
| Bidirectional actions | Not started | Approve/Input buttons disabled |

---

## Key Design Decisions

1. **External daemon, not in-process** — The file watcher runs as a separate process (`npx @agentpane/cli-monitor`), not inside AgentPane's server. This means zero coupling, independent lifecycle, and the npx install pattern.

2. **In-memory only** — No SQLite persistence for CLI monitor sessions. The daemon holds state in memory and pushes to the server. If either restarts, sessions are re-scanned from disk.

3. **Terminal-first install** — Users run a single CLI command. The AgentPane UI auto-detects when the daemon connects (polls `/status` every 3s) and transitions from install state to active.

4. **Push model** — The daemon pushes batched session updates to the server every 500ms via `POST /ingest`. The server fans out to browser clients via SSE. This avoids the server needing filesystem access.

5. **Defensive parsing** — The JSONL parser skips unrecognized event types, handles partial lines, and tolerates malformed JSON. File truncation resets the read offset.
