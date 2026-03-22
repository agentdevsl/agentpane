# Event Streaming Pipeline

Real-time event delivery from agent execution to browser UI. Events are persisted to SQLite for durability and published to the Caddy durable-streams server for SSE delivery. Clients subscribe directly to Caddy streams via the `@durable-streams/client` library -- the Bun API server is not involved in the SSE connection path.

```mermaid
flowchart LR
    SDK["Claude Agent SDK<br/><i>unstable_v2_createSession</i>"]
    SH["Stream Handler<br/><i>stream-handler.ts</i>"]
    SS["Session Service<br/><i>sessionService.publish()</i>"]
    DS["DurableStreamsService<br/><i>durable-streams.service.ts</i>"]
    DB[(SQLite<br/>session_events)]
    CADDY["Caddy + durable-streams plugin<br/><i>/v1/stream/:id</i><br/>LMDB persistence"]
    CLIENT["@durable-streams/client<br/><i>stream() + subscribeJson()</i>"]
    UI["UI Components<br/><i>React hooks</i>"]

    SDK -- "msg.type: stream_event,<br/>assistant, tool_use_summary,<br/>result" --> SH
    SH -- "SessionEvent<br/>(chunk, agent:turn,<br/>tool:start, tool:result,<br/>agent:completed)" --> SS
    SS --> DS
    DS -- "1. persistToDb()" --> DB
    DS -- "2. server.publish()<br/>(best-effort)" --> CADDY
    CADDY -- "SSE<br/>(auto-reconnect)" --> CLIENT
    CLIENT -- "typed events" --> UI

    subgraph Backend ["Backend (Bun API :3001)"]
        SDK
        SH
        SS
        DS
    end

    subgraph Persistence
        DB
        CADDY
    end

    subgraph Browser
        CLIENT
        UI
    end

    style Backend fill:#1e293b,color:#e2e8f0
    style Persistence fill:#1e3a5f,color:#e2e8f0
    style Browser fill:#14532d,color:#e2e8f0
```

## Event Types

| Category | Events |
|----------|--------|
| Agent lifecycle | `state:update`, `agent:started`, `agent:planning`, `agent:turn`, `agent:plan_ready`, `agent:completed`, `agent:error`, `agent:turn_limit`, `agent:stopped`, `agent:rate_limit` |
| Streaming | `chunk` (text deltas with accumulated content) |
| Tool use | `tool:start`, `tool:result`, `agent:tool_progress` |
| Diagnostics | `agent:metrics`, `agent:compacted` |
| Plan mode | `plan:started`, `plan:turn`, `plan:token`, `plan:interaction`, `plan:completed` |
| Sandbox | `sandbox:creating`, `sandbox:ready`, `sandbox:idle`, `sandbox:stopping`, `sandbox:stopped`, `sandbox:error` |
| Container agent | `container-agent:status`, `container-agent:started`, `container-agent:message`, `container-agent:error`, `container-agent:cancelled`, `container-agent:task-update-failed` |
| Terraform compose | `terraform:status`, `terraform:text`, `terraform:modules`, `terraform:questions`, `terraform:code`, `terraform:done` |
| Topology | `topology:agent_spawned`, `topology:agent_progress`, `topology:agent_completed` |
| Task creation | `task-creation:started`, `task-creation:message`, `task-creation:token`, `task-creation:suggestion`, `task-creation:questions`, `task-creation:completed` |
