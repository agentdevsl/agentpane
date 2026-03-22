# Agent Orchestration, Memory, Sandboxing, Observability & MCP Research

**Date:** March 2026
**Current Stack:** Claude Agent SDK 0.2.76 | Anthropic SDK 0.78.0 | Honcho 2.0.1 | Docker containers | Custom SSE streaming | No observability platform

---

## 1. Agent Orchestration Frameworks

### Current State: Claude Agent SDK

Deep integration: `unstable_v2_createSession`/`unstable_v2_resumeSession`, plan mode (`permissionMode: 'plan'`), execution mode (`permissionMode: 'acceptEdits'`), `canUseTool` callbacks, topology tracking, team mode with parallel sub-agents, agent-runner inside Docker.

### Key Finding

**No framework replaces the Claude Agent SDK for this use case.** LangGraph, CrewAI, and AutoGen are designed for general-purpose orchestration; none understand Claude's built-in coding tools (Bash/Read/Write/Edit), plan mode, or team mode. The correct strategy is to layer complementary technologies around the existing SDK core.

### Framework Comparison

| Framework | Recommendation | Rationale |
|---|---|---|
| **Claude Agent SDK** (current) | **ADOPT (keep)** | Core differentiator. Deep integration with Claude's coding tools, plan/execute flow, team mode. No alternative provides this |
| **LangGraph** | **HOLD** | Model-agnostic graph orchestration. Would require reimplementing all Claude SDK features. Only assess for multi-LLM orchestration |
| **CrewAI** | **HOLD** | Python-only. Role-based metaphor is less flexible than state-machine lifecycle. Solves different problem (business workflows) |
| **AutoGen / MS Agent Framework** | **HOLD** | Python/.NET only. Conversational pattern not natural for coding agents. Ecosystem instability (AutoGen -> Agent Framework migration) |
| **Mastra** | **ASSESS** | TypeScript-first, graph-based workflows, MCP support. Could complement Claude SDK by providing workflow orchestration around SDK sessions. Worth a spike |
| **Vercel AI SDK** | **TRIAL (streaming only)** | `useChat` hook and SSE data stream protocol could simplify frontend streaming. But lacks Durable Streams' persistence/replay. Evaluate as UI layer complement |
| **Instructor** | **HOLD** | Structured output only. Claude's native tool-use already covers this |

---

## 2. Multi-Agent Coordination

### Current Implementation

- Team mode via Claude SDK's native task system
- `ExitPlanMode` with `launchSwarm: true` and `teammateCount`
- Sub-agents tracked via topology events
- Each sub-agent gets its own git worktree
- `TopologyTracker` maps SDK `task_id` to topology node IDs
- Hard limit: 10 concurrent sub-agents, sweet spot 3-5

### Assessment

AgentPane's multi-agent coordination is **already at the state of the art** for coding agents:

- Claude SDK's native team mode with `SendMessage` between teammates
- Git worktree isolation per agent
- Topology tracking with real-time UI visualization
- Orchestrator/worker pattern with plan approval

### Recommendation: **HOLD on alternatives**

Focus on monitoring Claude Agent SDK updates for improved team coordination features.

---

## 3. Agent Memory and Context

### Current Implementation

Honcho (`@honcho-ai/sdk` 2.0.1) with layered service architecture:

- `MemoryClientService` — SDK client wrapper
- `MemoryQueryService` — assembles context from conclusions for prompt injection
- `MemoryCaptureService` — captures messages during sessions
- `MemoryAdminService` — CRUD operations
- Returns `ok(EMPTY_CONTEXT)` on failure (never blocks agent execution)

### Comparison

| Technology | Recommendation | Rationale |
|---|---|---|
| **Honcho** (current) | **ADOPT (keep, evaluate)** | Working. Smaller ecosystem than alternatives |
| **Mem0** | **TRIAL** | Graph memory (knowledge graph) added Jan 2026. 50k+ devs, ~half Fortune 500. 67% LLM-as-Judge score on LOCOMO benchmark. p95 search 0.200s. 91% latency reduction vs full-context. TypeScript SDK available. Migration: replace `MemoryClientService` |
| **Zep** | **ASSESS** | Temporal knowledge graph — tracks how facts change over time. More sophisticated for codebase evolution. More complex than Mem0 |
| **Letta (MemGPT)** | **HOLD** | Memory as part of agent state, not external service. Requires deep architectural changes to stream-handler |
| **LangMem** | **HOLD** | p95 search latency 59.82 seconds. Disqualifier. LangGraph dependency |

### Recommended Path

Run side-by-side comparison of Mem0 graph memory vs Honcho for coding agent context retrieval. If Mem0 shows meaningfully better results, migrate `MemoryClientService`.

---

## 4. Code Execution Sandboxing

### Current Implementation

Well-abstracted `SandboxProvider` interface with implementations for Docker, Kubernetes (gVisor/Kata runtime classes), Nomad, and AgentCore. Non-root execution, bind-mounted workspaces.

### Comparison

| Technology | Isolation | Startup | Recommendation | Rationale |
|---|---|---|---|---|
| **Docker (runc)** | Namespace/cgroup | <100ms | **HOLD for untrusted code** | Multiple escape CVEs. Keep for dev/fallback only |
| **gVisor (runsc)** | User-space kernel | 50-100ms | **TRIAL** | Already supported in codebase (`RuntimeClassName`). Lowest-effort security upgrade. No known escapes. Google-scale production |
| **E2B** | Firecracker microVM | ~150ms | **TRIAL** | Purpose-built for AI sandboxes. Hardware isolation. TypeScript SDK. Build as `SandboxProvider` implementation (~200-400 lines) |
| **Firecracker (direct)** | Hardware VM (KVM) | 100-200ms | **HOLD** | Use E2B instead (managed Firecracker) |
| **Cloudflare Sandboxes** | Container on edge | Fast | **HOLD** | No BYOC — can't install custom agent-runner. Blocker |
| **Fly.io Sprites** | Firecracker (KVM) | ~300ms | **ASSESS** | Strong for globally distributed execution. Less turnkey than E2B |
| **Modal** | gVisor | Sub-second | **HOLD** | Python-centric. Better for ML workloads |
| **Daytona** | Docker containers | 27-90ms | **ASSESS** | Fastest startup but Docker-level isolation (no improvement over current) |

### Two Recommended Actions

1. **TRIAL gVisor** (`--runtime=runsc`) — immediate security upgrade to existing Docker provider. Low effort.
2. **TRIAL E2B** — managed Firecracker alternative. Build `E2BSandboxProvider` implementing existing interface.

---

## 5. Streaming and Real-Time Agent Updates

### Current Architecture

- Durable Streams for persistent event storage with replay
- ChunkBatcher splits real-time delivery (immediate SSE) from batched DB persistence
- 15+ event types specific to agent lifecycle
- Custom SSE for Terraform compose

### Vercel AI SDK Comparison

Vercel AI SDK provides `streamText`/`generateText`, `useChat`/`useCompletion` hooks, SSE data stream protocol. Would simplify frontend streaming **but lacks:**

- Persistent event storage (Durable Streams' key feature)
- Event replay for reconnecting clients
- Custom event types (topology, metrics, plan_ready)
- Multi-session event routing

### Recommendation: **ASSESS selective adoption**

Consider `useChat` patterns as inspiration for frontend consumption layer. Keep Durable Streams as backend transport. The ChunkBatcher pattern is more sophisticated than anything in Vercel AI SDK.

---

## 6. Tool/MCP Integration

### MCP Landscape (March 2026)

- OpenAI adopted MCP (March 2025)
- Nov 2025 spec: streamable HTTP transport, OAuth, JSON-RPC batching
- 2026 roadmap: server-side agent loops, parallel tool calls, agent-to-agent communication

### Recommendation: **TRIAL MCP server hosting**

Build an MCP server exposing AgentPane operations (task CRUD, codespace management, memory queries) as MCP tools. Complementary to current architecture. Positions for ecosystem growth.

---

## 7. Agent Observability

### Current State

Custom logging via `createLogger()`. Session events capture lifecycle data. `agent:metrics` event captures costs/duration/turns/model usage. **No dedicated observability platform.**

### Comparison

| Platform | Recommendation | Key Strength |
|---|---|---|
| **Langfuse** | **ADOPT** | Open-source (MIT), self-hosted. Multi-agent tracing with parallel execution support. Agent graphs. Prompt management. Cost attribution. 19k+ GitHub stars |
| **OpenTelemetry GenAI** | **TRIAL** | Standard semantics for AI observability. Vendor-agnostic. Exports to Langfuse. Instrument agent execution service |
| **LangSmith** | **HOLD** | LangChain ecosystem coupling provides no benefit |
| **Braintrust** | **ASSESS** | CI/CD-integrated evals. Consider for automated quality regression testing |
| **Helicone** | **ASSESS** | Proxy-based LLM cost monitoring and caching. Complement to Langfuse |

### Langfuse Provides

- Multi-agent trace visualization with parallel execution support
- Agent graphs complementing existing topology UI
- Cost attribution per agent/session/task
- Prompt management and versioning
- Self-hosted deployment with no vendor lock-in

---

## Priority Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **Adopt Langfuse** (self-hosted) | Medium | Fills observability gap for multi-agent debugging and cost tracking |
| 2 | **Trial gVisor** (`--runtime=runsc`) | Low | Immediate security upgrade for Docker sandboxes |
| 3 | **Trial OpenTelemetry GenAI conventions** | Medium | Standardized tracing, feeds into Langfuse |
| 4 | **Trial E2B** as managed sandbox provider | Medium | VM-level isolation, managed infrastructure |
| 5 | **Trial MCP server** for AgentPane operations | Medium | Positions for MCP ecosystem, extensible tooling |
| 6 | **Trial Mem0** graph memory | Medium | Potentially better memory retrieval than Honcho |
| 7 | **Assess Mastra** workflow engine | High | Could simplify orchestration code |
