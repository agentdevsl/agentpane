# AgentPane Architecture Diagrams

Visual architecture diagrams for AgentPane. Each diagram is authored as an SVG-embedded HTML file with a matching PNG export.

## Diagrams

### System Architecture

![Architecture Diagram](_architecture-diagram.png)

Static overview of the AgentPane system showing the browser client, TanStack DB collections, Caddy durable streams server, Bun API, SQLite database, and sandbox infrastructure. Covers the core request/response and real-time streaming data paths.

- **HTML**: [`_architecture-diagram.html`](_architecture-diagram.html)
- **PNG**: [`_architecture-diagram.png`](_architecture-diagram.png)

---

### Architecture Explorer (Interactive)

Interactive pan-and-zoom architecture explorer with preset views for different subsystems (agents, streaming, sandbox, API). Built as a full HTML application rather than a static SVG.

- **HTML**: [`agentpane-architecture.html`](agentpane-architecture.html)
- **PNG**: [`architecture.png`](architecture.png)

---

### Tenancy Model

![Tenancy Model](tenancy-model.png)

Authentication, ownership hierarchy, and role-based access control. Shows the GitHub OAuth flow, organization/project/task ownership chain, and how RBAC policies are enforced across the application.

- **HTML**: [`_tenancy-model.html`](_tenancy-model.html)
- **PNG**: [`tenancy-model.png`](tenancy-model.png)

---

### OpenShift Deployment (Cloudflare Tunnel)

![OpenShift Deployment](_openshift-deployment.png)

Private network deployment on OpenShift with Cloudflare Tunnel for inbound webhook delivery. GitHub webhooks are received at `agentpane.teams` via Cloudflare Edge, forwarded through an outbound-only tunnel to a `cloudflared` pod inside the cluster — no inbound firewall rules needed. Also shows the egress proxy for outbound API calls (GitHub, Anthropic), sandbox namespace with NetworkPolicy isolation, and the GitHub OAuth browser flow.

- **HTML**: [`_openshift-deployment.html`](_openshift-deployment.html)
- **PNG**: [`_openshift-deployment.png`](_openshift-deployment.png)

---

### Durable Streams Architecture

![Durable Streams](_durable-streams-architecture.png)

End-to-end event streaming pipeline from service-side event emission to reactive UI updates. Shows the five-stage flow: event sources (Container Agent, Agent Execution, Terraform Compose, Task Creation) publish through the type-safe `DurableStreamsService` with dual-write persistence (SQLite first, Caddy best-effort), streamed to the browser via SSE with Zod validation, synced into TanStack DB collections, and consumed by React hooks for live UI updates. Includes durability guarantees, offset-based resume, and exponential backoff reconnection.

- **HTML**: [`_durable-streams-architecture.html`](_durable-streams-architecture.html)
- **PNG**: [`_durable-streams-architecture.png`](_durable-streams-architecture.png)

---

### Events System

![Events System](_events-system-architecture.png)

Webhook ingestion, plugin-based normalization, subscription matching, and automated task creation. Shows the full event pipeline from external sources (GitHub, Linear, Jira, generic webhooks, cron scheduler) through HMAC verification, plugin-based parsing into `NormalizedEvent`, deduplication via unique constraints, subscription matching with field filters, `{{variable}}` template interpolation, and task creation with optional agent auto-start. Includes the database schema (4 tables), scheduler detail (CAS locking, budget enforcement, timezone-aware cron), real-time SSE broadcasting, and event log audit trail.

- **HTML**: [`_events-system-architecture.html`](_events-system-architecture.html)
- **PNG**: [`_events-system-architecture.png`](_events-system-architecture.png)

---

## Written Documentation

| Document | Description |
|----------|-------------|
| [`agent-streaming-architecture.md`](agent-streaming-architecture.md) | Detailed write-up of the agent event streaming architecture |
| [`durable-streams-architecture.md`](durable-streams-architecture.md) | Detailed write-up of the durable streams system design |

## Regenerating PNGs

PNGs are captured from the HTML source files using Playwright:

```bash
npx playwright screenshot --viewport-size="1920,1200" "file://$(pwd)/docs/<file>.html" docs/<file>.png
```
