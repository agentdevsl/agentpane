# Architecture Diagrams

Mermaid diagrams reflecting the **actual implementation** of AgentPane. All diagrams are GitHub-renderable.

## Diagram Index

| # | Diagram | Type | File |
|---|---------|------|------|
| 1 | [System Architecture](./01-system-architecture.md) | `flowchart TB` | High-level system overview |
| 2 | [Agent Execution Flow](./02-agent-execution-flow.md) | `sequenceDiagram` | Task drag -> planning -> approval -> execution |
| 3 | [State Machines](./03-state-machines.md) | `stateDiagram-v2` | All 4 state machines |
| 4 | [Database Schema](./04-database-schema.md) | `erDiagram` | ER diagrams (3 sub-diagrams) |
| 5 | [API Route Map](./05-api-route-map.md) | `mindmap` | All 33 route modules by domain |
| 6 | [Event Streaming](./06-event-streaming.md) | `flowchart LR` | Agent -> DurableStreams -> SSE -> Browser |
| 7 | [Sandbox Architecture](./07-sandbox-architecture.md) | `flowchart TB` | Multi-provider: Docker, K8s, Nomad, AgentCore + skill injection |
| 8 | [Authentication Flow](./08-authentication-flow.md) | `sequenceDiagram` | GitHub OAuth -> sessions -> RBAC (codespace + folder resolution) |
| 9 | [Deployment Architecture](./09-deployment-architecture.md) | `flowchart TB` | Docker Compose, Caddy, services, Honcho memory |

## Source of Truth

These diagrams reflect the actual implementation as found in:
- Enums: `src/db/schema/shared/enums.ts`
- Schema: `src/db/schema/sqlite/*.ts`
- Routes: `src/server/routes/*.ts`
- Services: `src/services/*.ts`
- Memory: `src/services/memory/*.ts`
- Sandbox: `src/lib/sandbox/*.ts` (includes skill-injector.ts)
- Frontend routes: `src/app/routes/`

Where spec and implementation diverge, the diagram follows the implementation and notes the discrepancy.
