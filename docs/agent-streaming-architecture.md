# Agent Streaming Architecture

This document describes how agent events flow from the Claude Agent SDK running inside Docker containers to the UI in real-time.

## Overview

AgentPane runs Claude agents inside isolated Docker containers for security. The streaming architecture bridges events from the containerized agent to the browser UI through several layers:

1. **Agent Runner** - Node.js process inside container running Claude Agent SDK
2. **Container Bridge** - Host-side process parsing stdout/stderr from container
3. **Durable Streams** - Event persistence and real-time pub/sub system
4. **SSE Connection** - Browser EventSource connection for real-time updates

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DOCKER CONTAINER                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         Agent Runner Process                                 ││
│  │  ┌─────────────────────────────────────────────────────────────────────────┐││
│  │  │  Claude Agent SDK (unstable_v2_createSession)                           │││
│  │  │   • Sends prompts to Claude API                                         │││
│  │  │   • Receives streaming responses                                        │││
│  │  │   • Handles tool calls (Read, Write, Bash, etc.)                        │││
│  │  └────────────────────────────────┬────────────────────────────────────────┘││
│  │                                   │                                          ││
│  │                                   ▼                                          ││
│  │  ┌─────────────────────────────────────────────────────────────────────────┐││
│  │  │  EventEmitter (event-emitter.ts)                                        │││
│  │  │   • Formats events as JSON lines                                        │││
│  │  │   • Critical events use writeSync() for immediate delivery              │││
│  │  │   • High-frequency events (tokens) use async writes                     │││
│  │  │   • Outputs to stdout (primary) and stderr (error fallback)             │││
│  │  └────────────────────────────────┬────────────────────────────────────────┘││
│  └───────────────────────────────────┼────────────────────────────────────────┘│
│                                      │                                          │
│                               stdout │ stderr                                   │
│                                      ▼                                          │
└──────────────────────────────────────┼──────────────────────────────────────────┘
                                       │
                            Docker exec streams
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              HOST PROCESS                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                    ContainerAgentService                                     ││
│  │  ┌─────────────────────────────────────────────────────────────────────────┐││
│  │  │  • Starts agent-runner via docker exec                                  │││
│  │  │  • Creates ContainerBridge for stream processing                        │││
│  │  │  • Handles agent lifecycle (start, stop, error)                         │││
│  │  │  • Updates task status on completion                                    │││
│  │  └────────────────────────────────┬────────────────────────────────────────┘││
│  │                                   │                                          ││
│  │                                   ▼                                          ││
│  │  ┌─────────────────────────────────────────────────────────────────────────┐││
│  │  │  ContainerBridge (container-bridge.ts)                                  │││
│  │  │   • Parses JSON lines from stdout via readline                          │││
│  │  │   • Parses stderr for error events (fallback for EPIPE)                 │││
│  │  │   • Validates event structure (type, timestamp, taskId, sessionId)      │││
│  │  │   • Maps container events to DurableStreams event types                 │││
│  │  │   • Calls onComplete/onError callbacks for terminal events              │││
│  │  └────────────────────────────────┬────────────────────────────────────────┘││
│  └───────────────────────────────────┼────────────────────────────────────────┘│
│                                      │                                          │
│                               publish()                                         │
│                                      ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                      DurableStreamsService                                   ││
│  │  ┌─────────────────────────────────────────────────────────────────────────┐││
│  │  │  • Persists events to SQLite (session_events table)                     │││
│  │  │  • Assigns sequential offsets for resumability                          │││
│  │  │  • Broadcasts to active SSE subscribers                                 │││
│  │  │  • Supports replay from any offset                                      │││
│  │  └────────────────────────────────┬────────────────────────────────────────┘││
│  └───────────────────────────────────┼────────────────────────────────────────┘│
│                                      │                                          │
│                               SSE events                                        │
│                                      ▼                                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                  HTTP/SSE
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER CLIENT                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                      DurableStreamsClient                                    ││
│  │   • EventSource connection to /api/streams/:id/subscribe                     ││
│  │   • Automatic reconnection with exponential backoff                          ││
│  │   • Offset tracking for resume on reconnect                                  ││
│  │   • Routes events to typed callbacks                                         ││
│  └────────────────────────────────────┬────────────────────────────────────────┘│
│                                       │                                          │
│                                       ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         React Components                                     ││
│  │   • ContainerAgentPanel - displays agent status and progress                 ││
│  │   • StreamView - renders token stream                                        ││
│  │   • ToolCallsPanel - shows tool invocations                                  ││
│  │   • StatusBreadcrumbs - shows startup stages                                 ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Event Flow

### 1. Agent Startup

When a task is moved to `in_progress`:

```
Task Move API
    │
    ▼
ContainerAgentService.startAgent()
    │
    ├── Create session record in database
    ├── Create durable stream for events
    ├── Publish 'container-agent:status' (stage: initializing)
    ├── Get OAuth token from ApiKeyService
    ├── Create ContainerBridge
    ├── Execute agent-runner via docker exec
    │       │
    │       ▼
    │   Agent Runner starts inside container
    │       │
    │       ├── Write credentials to ~/.claude/.credentials.json
    │       ├── Validate configuration
    │       ├── Create SDK session
    │       └── Emit 'agent:started' event
    │
    └── Process stdout/stderr through bridge
```

### 2. During Execution

```
Claude Agent SDK (in container)
    │
    ├── stream_event (message_start) ──► agent:turn
    ├── stream_event (content_block_delta) ──► agent:token
    ├── tool_progress ──► agent:tool:start
    ├── assistant message ──► agent:message
    │
    ▼
EventEmitter.emit()
    │
    ▼
stdout (JSON line)
    │
    ▼
ContainerBridge.processStream()
    │
    ├── Parse JSON
    ├── Validate task/session match
    └── Publish to DurableStreams
            │
            ▼
        Browser UI updates in real-time
```

### 3. Completion or Error

```
Agent completes task
    │
    ▼
EventEmitter.complete() or .error()
    │
    ▼
stdout (sync write for immediate delivery)
    │
    ▼
ContainerBridge handles terminal event
    │
    ├── Publish to DurableStreams
    └── Call onComplete/onError callback
            │
            ▼
ContainerAgentService.handleAgentComplete()
    │
    ├── Update task status (waiting_approval, error, etc.)
    ├── Clear agent references
    └── Cleanup sentinel file
```

## Event Types

### Container Events (stdout from agent-runner)

| Event Type | Sync | Description |
|------------|------|-------------|
| `agent:started` | Yes | Agent initialized, includes model and maxTurns |
| `agent:token` | No | Streaming text delta from Claude response |
| `agent:turn` | Yes | New turn started, includes turn count |
| `agent:tool:start` | No | Tool invocation beginning |
| `agent:tool:result` | No | Tool execution completed |
| `agent:message` | Yes | Complete assistant message |
| `agent:complete` | Yes | Agent finished (completed, turn_limit, cancelled) |
| `agent:error` | Yes | Agent encountered error |
| `agent:cancelled` | Yes | Agent was cancelled via stop file |

### DurableStreams Events (published to clients)

Container events are mapped with `container-agent:` prefix:

| Container Event | DurableStreams Event |
|-----------------|---------------------|
| `agent:started` | `container-agent:started` |
| `agent:token` | `container-agent:token` |
| `agent:turn` | `container-agent:turn` |
| `agent:complete` | `container-agent:complete` |
| `agent:error` | `container-agent:error` |

### Status Events (startup progress)

The service publishes status events during startup:

| Stage | Message |
|-------|---------|
| `initializing` | Starting... |
| `validating` | Validating configuration... |
| `credentials` | Authenticating... |
| `creating_sandbox` | Creating sandbox... |
| `executing` | Executing... |
| `running` | Running |

## Event Format

### JSON Line Format (stdout)

```json
{
  "type": "agent:token",
  "timestamp": 1706400000000,
  "taskId": "task_abc123",
  "sessionId": "sess_xyz789",
  "data": {
    "delta": "Hello",
    "accumulated": "Hello, I'll help you with that task."
  }
}
```

### DurableStreams Format (SSE)

```
event: container-agent:token
data: {"taskId":"task_abc123","sessionId":"sess_xyz789","delta":"Hello","accumulated":"Hello, I'll help you with that task."}
```

## Error Handling

### EPIPE and stdout failures

When stdout fails (e.g., EPIPE error), the agent-runner writes error events to stderr as a fallback:

1. **EventEmitter** uses `writeSync()` for critical events to bypass buffering
2. **ContainerBridge** processes stderr for JSON error events
3. Error events in stderr are published to DurableStreams like stdout events

### Global Error Handlers

The agent-runner registers global handlers for uncaught exceptions:

```typescript
process.on('uncaughtException', (error) => {
  events.error({ error: error.message, code: error.code });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  events.error({ error: String(reason), code: 'UNHANDLED_REJECTION' });
  process.exit(1);
});
```

### Flush Before Exit

The `flushAndExit()` helper ensures stdout is flushed before `process.exit()`:

```typescript
async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(code);
}
```

## Key Files

| File | Purpose |
|------|---------|
| `agent-runner/src/index.ts` | Entry point for Claude SDK inside container |
| `agent-runner/src/event-emitter.ts` | JSON event output to stdout |
| `src/lib/agents/container-bridge.ts` | Parses container stdout/stderr |
| `src/services/container-agent/container-exec.service.ts` | Orchestrates container agent execution lifecycle |
| `src/services/durable-streams.service.ts` | Event persistence and pub/sub |
| `src/app/hooks/use-session.ts` | React hook for session subscription and SSE connection |

## Authentication

The Claude Agent SDK requires OAuth tokens in a credentials file:

1. OAuth token passed via `CLAUDE_OAUTH_TOKEN` environment variable
2. Agent-runner writes to `~/.claude/.credentials.json`:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": null,
    "expiresAt": 1706486400000,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max"
  }
}
```

## Cancellation

Agents support graceful cancellation via sentinel files:

1. User requests stop via UI
2. `ContainerAgentService.stopAgent()` writes sentinel file: `/tmp/.agent-stop-{taskId}`
3. Agent-runner checks `shouldStop()` between turns
4. If sentinel exists, emits `agent:cancelled` and exits
5. Service cleans up sentinel file after completion

## Debugging

Enable debug logging with environment variables:

```bash
# Full debug logging
DEBUG=true npm run dev

# Container bridge only
DEBUG_CONTAINER_BRIDGE=true npm run dev

# Container agent service only
DEBUG_CONTAINER_AGENT=true npm run dev
```

Debug logs show:

- Event parsing and validation
- Stream processing progress
- Event publishing to DurableStreams
- Terminal event handling
- Process exit codes

## Performance Considerations

### Sync vs Async Writes

- **Sync writes** (`writeSync`) for critical events ensure immediate delivery
- **Async writes** for high-frequency events (tokens) provide better throughput
- Token events can tolerate slight buffering; completion events cannot

### Stream Processing

- Readline interface with `crlfDelay: Infinity` handles cross-platform line endings
- Events processed sequentially to maintain order
- Non-JSON output lines are logged at debug level and skipped

### Reconnection

- SSE connections use exponential backoff (1s → 30s)
- Offset tracking enables resume from last received event
- No event loss during brief disconnections
