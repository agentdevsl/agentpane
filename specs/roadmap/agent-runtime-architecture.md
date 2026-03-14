# Agent Runtime: Architectural Roadmap

> **STATUS: ROADMAP ONLY - NOT FOR IMPLEMENTATION**
>
> This document defines the architectural vision and priorities for evolving
> the agent runtime from its current per-provider ad-hoc model into a unified,
> secure, observable platform. Do not implement features described here until
> each phase is officially started.

---

## Problem Statement

AgentPane has 4 sandbox providers (Docker, K8s, Nomad, AgentCore) behind a
`SandboxProvider` interface. The abstraction unifies exec-into semantics but
leaks across five cross-cutting concerns:

| Concern | Current State | Risk |
|---------|--------------|------|
| **Identity** | All agents share one static OAuth token | No per-agent attribution, no credential rotation, no mTLS |
| **Discovery** | Agent state scattered across DB, env vars, stdout | No agent-to-agent discovery, no external observability |
| **Scheduling** | Immediate dispatch or reject; queue is a stub | No resource matching, no warm pool, no priority/preemption |
| **Security** | K8s has NetworkPolicy; Docker/Nomad have nothing | Unrestricted egress, no SSRF protection, inconsistent hardening |
| **Budgets** | Turn limiter only; `tokensUsed` recorded but not enforced | No cost control, no hierarchical limits, no distributed tracing |

Each concern is addressed below in dependency order — identity first because
everything else depends on knowing *who* an agent is.

---

## Priority 1: Cryptographic Workload Identity (SVIDs)

### Why

Every other property — credential scoping, policy enforcement, audit
attribution, mTLS — requires per-agent identity. Without it, a compromised
agent inherits the privileges of every agent on the platform.

### What Exists

- Single OAuth token written to `~/.claude/.credentials.json` inside every
  container (via `credentials-injector.ts`)
- No per-agent identity document
- No mutual TLS between agent and control plane
- No credential rotation during long-running tasks

### Target State

**SPIFFE IDs** — one per agent instance:

```
spiffe://agentpane.io/{tenant}/project/{projectId}/agent/{agentId}/task/{taskId}
```

**X.509-SVIDs** issued by a SPIRE Server:

- 1-hour TTL, auto-rotated via the SPIRE Workload API
- SPIRE Agent runs as a DaemonSet (K8s) or system service (Docker/Nomad hosts)
- Workload attestation: K8s → service account; Docker → container label;
  Nomad → task metadata

**Credential derivation** — SVID replaces static secrets:

```
SVID → OIDC Federation → short-lived GitHub token (repo-scoped)
SVID → OIDC Federation → short-lived Anthropic API key
SVID → AWS STS AssumeRoleWithWebIdentity → session credentials
```

No static secrets stored in containers. Tokens expire with the SVID.

**mTLS** — agent ↔ control plane traffic authenticated by SVIDs. The control
plane's SPIRE trust domain validates agent identity on every API call.

### Why SPIFFE/SPIRE

| Alternative | Why not |
|-------------|---------|
| Custom PKI | Operational burden of CA management, rotation, revocation |
| Vault Agent | Adds a heavyweight dependency; SPIRE is purpose-built for workload identity |
| Cloud IAM only | Provider-specific; doesn't cover Docker-on-laptop or cross-cloud |
| Shared secrets + HMAC | No identity hierarchy, no mTLS, no OIDC federation |

### Key Design Decisions

1. **K8s first** — SPIRE's K8s attestor is mature; Docker/Nomad attestors
   follow once the trust domain is established
2. **Sidecar vs library** — use SPIRE Agent as a node-level daemon, not a
   per-pod sidecar, to minimize resource overhead
3. **Graceful fallback** — during migration, agents without SVIDs fall back to
   static token injection (logged as a security warning)

### Affected Areas

- `credentials-injector.ts` — inject SVID mount instead of static token file
- `agent-runner/src/index.ts` — read SVID from Workload API, derive short-lived
  API credentials on startup and on rotation
- `nomad-sandbox-sdk/src/operations/exec.ts` — attach SPIRE Agent socket to
  Nomad task
- Each `SandboxProvider` — mount SPIRE Agent socket into the container/pod/task

---

## Priority 2: Agent Card (`/.well-known/agent.json`)

### Why

Self-describing agents unlock three capabilities that are impossible today:

1. **Swarm discovery** — agents find and negotiate with peers without the
   control plane mediating every interaction
2. **Capability-based scheduling** — the dispatcher reads declared capabilities
   instead of guessing from env vars
3. **External observability** — monitoring, compliance, and third-party tools
   can interrogate agent state via a standard endpoint

### What Exists

- Agent state lives in `agent_runs` DB table, env vars, and stdout SSE events
- No metadata endpoint on the agent-runner process
- No standard schema for agent capabilities
- Swarm mode is hard-coded in `ExitPlanModeOptions`

### Target State

Every agent-runner HTTP server exposes `GET /.well-known/agent.json`:

```jsonc
{
  "schema": "https://agentpane.io/schemas/agent-card/v1",
  "identity": {
    "spiffeId": "spiffe://agentpane.io/acme/project/p1/agent/a1/task/t1",
    "agentId": "a1",
    "projectId": "p1",
    "taskId": "t1",
    "tenantId": "acme"
  },
  "capabilities": {
    "tools": ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    "model": "claude-sonnet-4-6",
    "phases": ["plan", "execute"],
    "streaming": true,
    "swarmCapable": true,
    "maxConcurrentTools": 4
  },
  "lifecycle": {
    "status": "running",          // idle | planning | running | paused | completed | error
    "phase": "execute",
    "currentTurn": 12,
    "startedAt": "2026-03-13T10:00:00Z",
    "idleTimeout": "PT5M",
    "lastActivityAt": "2026-03-13T10:05:23Z"
  },
  "runtime": {
    "provider": "kubernetes",     // docker | kubernetes | nomad | agentcore
    "isolationLevel": "gvisor",   // runc | gvisor | firecracker
    "resources": { "cpu": "2000m", "memory": "4Gi", "gpu": null },
    "workspace": "/workspace",
    "networkPolicy": "restricted-egress"
  },
  "endpoints": {
    "events": "/events",          // SSE stream
    "exec": "/exec",              // POST command execution
    "cancel": "/cancel",          // POST graceful stop
    "health": "/health",          // GET liveness
    "metrics": "/metrics"         // GET Prometheus metrics
  },
  "budget": {
    "turns": { "used": 12, "limit": 50 },
    "inputTokens": { "used": 45000, "limit": 500000 },
    "outputTokens": { "used": 12000, "limit": 100000 },
    "costUsd": { "used": 0.42, "limit": 5.00 }
  }
}
```

### Alignment with Google A2A Protocol

The Agent Card schema is designed to be forward-compatible with the
[Agent2Agent (A2A) protocol](https://github.com/google/A2A). Key mappings:

| A2A Concept | AgentPane Equivalent |
|-------------|---------------------|
| `AgentCard.name` | `identity.agentId` |
| `AgentCard.capabilities` | `capabilities.*` |
| `AgentCard.url` | Derived from service discovery + `endpoints.*` |
| `AgentCard.authentication` | SVID-based mTLS (Priority 1) |

Full A2A compliance is a future goal; the initial implementation prioritizes
internal discovery and observability.

### Key Design Decisions

1. **HTTP endpoint on agent-runner** — the agent-runner already binds a port
   for SSE events; the card is an additional route
2. **Dynamic, not cached** — budget and lifecycle fields change every turn;
   the card is computed on each request
3. **Authenticated** — requires valid SVID (mTLS) or control-plane token;
   never exposed on public networks

### Affected Areas

- `agent-runner/src/index.ts` — add `/.well-known/agent.json` route
- `agent-runner/src/agentcore-handler.ts` — expose card via AgentCore's
  metadata API
- Control plane agent service — read agent cards for scheduling decisions and
  swarm coordination

---

## Priority 3: Declarative Requirements + Smart Dispatch

### Why

Today's dispatch is binary: start immediately or reject with 429. There is no
resource matching (a GPU task gets the same container as a linting task), no
priority system, and no meaningful queue. This blocks multi-tenant operation
and wastes resources.

### What Exists

- `startAgent()` in `container-agent.service.ts` tries immediately, rejects
  at `maxConcurrentAgents`
- `AgentQueueService.queueTask()` always returns `QUEUE_FULL`
- No capability matching between task requirements and provider resources
- No warm pool — every agent pays ~30s cold-start

### Target State

#### Requirements Contract

Tasks declare what they need; the scheduler finds where to run them:

```typescript
interface AgentRequirements {
  // Compute
  cpu: '1000m' | '2000m' | '4000m';
  memory: '2Gi' | '4Gi' | '8Gi' | '16Gi';
  gpu?: 'T4' | 'A10G';

  // Isolation
  isolationLevel: 'standard' | 'hardened' | 'airgapped';
  networkPolicy: 'unrestricted' | 'restricted-egress' | 'deny-all';

  // Workspace
  workspaceSize: '1Gi' | '5Gi' | '10Gi';
  gitCloneDepth?: number;

  // Agent
  model: string;
  maxTurns: number;
  budgetUsd: number;

  // Scheduling
  priority: 'critical' | 'high' | 'normal' | 'low' | 'background';
  preemptible: boolean;
}
```

#### Scheduling Pipeline

```
Task submitted
  │
  ▼
┌─────────────┐
│  Validate    │  Schema validation, budget check
└──────┬──────┘
       ▼
┌─────────────┐
│  Filter      │  Which providers can satisfy requirements?
│  Providers   │  (GPU? isolation level? network policy?)
└──────┬──────┘
       ▼
┌─────────────┐
│  Score &     │  Prefer: warm pool hit > same region > lowest cost
│  Rank        │  Factor: current load, failure rate, latency
└──────┬──────┘
       ▼
┌─────────────┐
│  Capacity    │  Slots available? → place immediately
│  Check       │  No slots? → check preemption eligibility
└──────┬──────┘
       ▼
┌──────┴──────┐
│  Preempt    │  Higher-priority task evicts lower-priority agent
│  or Queue   │  (graceful: finish current turn, save state, yield)
└──────┬──────┘
       ▼
┌─────────────┐
│  Place &     │  Claim warm instance or cold-start new one
│  Launch      │  Inject SVID, mount workspace, apply network policy
└─────────────┘
```

#### Warm Pool Tiers

| Tier | Spec | Use Case | Target Claim Time |
|------|------|----------|-------------------|
| `standard` | 2 CPU, 4Gi RAM | Code review, linting, small features | <1s |
| `compute` | 4 CPU, 8Gi RAM | Large refactors, test suites | <1s |
| `gpu` | 4 CPU, 16Gi RAM, T4 | ML tasks, image processing | <5s |

Warm instances are pre-provisioned per tenant based on usage patterns. The pool
auto-scales with configurable min/max per tier.

#### Priority + Preemption

| Priority | Preempts | Use Case |
|----------|----------|----------|
| `critical` | All below | Production incidents, security fixes |
| `high` | normal, low, background | User-initiated tasks |
| `normal` | low, background | Scheduled/automated tasks |
| `low` | background | Batch processing |
| `background` | Nothing | Speculative pre-computation |

Preemption is graceful: the evicted agent finishes its current turn, persists
state to the workspace, and is rescheduled when capacity frees.

### Key Design Decisions

1. **Requirements on task, not agent** — the task declares *what*, the
   scheduler decides *where*. Agents are fungible runtime instances.
2. **Provider as capability set** — each provider advertises what it supports
   (GPU, gVisor, network policy). The scheduler filters, not the caller.
3. **Queue replaces stub** — `AgentQueueService` becomes a real priority queue
   backed by the database with position tracking and ETAs.

### Affected Areas

- `container-agent.service.ts` — dispatch through scheduling pipeline
- `agent-queue.service.ts` — real priority queue with capacity tracking
- `agent-execution.service.ts` — requirements-aware agent creation
- `agent-sandbox-provider.ts` — providers advertise capabilities
- New: `agent-scheduler.service.ts` — the scheduling pipeline itself
- New: `warm-pool.service.ts` — pool management and auto-scaling

---

## Priority 4: Security Parity Across All Providers

### Why

K8s has NetworkPolicy, gVisor, and Pod Security Standards. Docker agents run
with unrestricted egress on bridge networking. Nomad has no network policy at
all. An agent on Docker can reach any endpoint on the internet, including cloud
metadata services (SSRF vector).

### What Exists

| Control | K8s | Docker | Nomad |
|---------|-----|--------|-------|
| Network policy | NetworkPolicy | None (bridge) | None |
| Metadata blocking | Yes (169.254/16) | No | No |
| Runtime isolation | gVisor optional | runc only | runc only |
| Filesystem | Read-only root | Writable root | Writable root |
| Capabilities | Dropped | Default set | Default set |
| seccomp | RuntimeDefault | None | None |

### Target State

All providers enforce the same security baseline:

#### Network Isolation

| Provider | Mechanism |
|----------|-----------|
| K8s | NetworkPolicy (existing) |
| Docker | `iptables`/`nftables` rules applied per container via a helper script |
| Nomad | Consul Connect sidecar with intentions, or `network` stanza with bridge mode |

**Default policy**: deny all ingress, restricted egress to allowlist only.

#### Egress Allowlist (Default)

```
api.anthropic.com:443
*.github.com:443
registry.npmjs.org:443
```

Configurable per-project. Tenants can add custom entries (e.g., internal
registries, APIs).

#### Cloud Metadata Blocking

```
169.254.0.0/16 → DROP   (AWS, GCP, Azure metadata)
```

Enforced at the network level on all providers. Prevents SSRF attacks that
could leak IAM credentials from the host.

#### Filesystem Constraints

```
/           → read-only
/workspace  → read-write (project files)
/tmp        → read-write (ephemeral)
/home/agent/.claude → read-write (SDK state)
```

Enforced via read-only root filesystem + tmpfs/volume mounts.

#### Process Hardening

| Control | Setting |
|---------|---------|
| seccomp | `RuntimeDefault` profile |
| Capabilities | Drop ALL, add only `NET_BIND_SERVICE` if needed |
| Privilege escalation | `no-new-privileges` |
| User | Non-root (`agent` user, UID 1000) |
| PID namespace | Isolated (can't see host processes) |

### Key Design Decisions

1. **Baseline, not ceiling** — these are minimum requirements. K8s can layer
   gVisor on top; Docker can't, but it still gets the network/fs/seccomp baseline.
2. **Helper script for Docker** — a `sandbox-network-setup.sh` runs before the
   agent container starts, configuring iptables rules. This avoids requiring
   Docker in `--privileged` mode.
3. **Consul Connect for Nomad** — preferred over raw iptables because Nomad
   already integrates with Consul. Falls back to `network` stanza bridge mode
   if Consul is not available.

### Affected Areas

- `docker-provider.ts` — add SecurityOpt, CapDrop, ReadonlyRootfs, network
  setup hook
- `nomad-sandbox-provider.ts` — add Consul Connect sidecar or network stanza
- `Dockerfile.agent-sandbox` — enforce non-root user, minimal capabilities
- New: `sandbox-network-setup.sh` — iptables/nftables rules for Docker
- New: `security-baseline.ts` — shared security config validated by all providers

---

## Priority 5: Budget Enforcement + Observability

### Why

The turn limiter warns at 80% and stops at max turns, but there is no
token-level or cost-level enforcement. A runaway agent can consume unlimited
API tokens. There is no distributed tracing — debugging a failed agent run
means grepping stdout logs. Nomad metrics return zeros.

### What Exists

- `turn-limiter.ts` — turn count tracking with warn/stop thresholds
- `agent_runs.tokensUsed` — recorded but never enforced
- SSE events for real-time streaming, but no structured tracing
- No Prometheus metrics endpoint
- No cost attribution or rollup

### Target State

#### Hierarchical Budget Enforcement

```
Platform budget ($10,000/month)
  └─ Tenant budget ($2,000/month)
      └─ Project budget ($500/month)
          └─ Task budget ($5.00)
```

Each level has configurable actions at thresholds:

| Threshold | Action |
|-----------|--------|
| 50% | Log |
| 80% | Warn (UI notification + SSE event) |
| 95% | Pause (agent stops, user can approve continuation) |
| 100% | Terminate (agent stopped, task marked as budget-exceeded) |

Budget is checked at turn completion. If the parent budget is exhausted, all
children are paused regardless of their individual limits.

#### Cost Attribution

Per-model pricing applied at turn completion:

```typescript
interface TurnCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;  // computed from model pricing table
}
```

Costs roll up: turn → task → project → tenant → platform. Queryable via API
for billing dashboards.

#### Prometheus `/metrics` Endpoint

Exposed on the agent-runner HTTP server:

```
# Token counters
agentpane_tokens_input_total{agent_id, project_id, tenant_id, model}
agentpane_tokens_output_total{agent_id, project_id, tenant_id, model}

# Cost accrual
agentpane_cost_usd_total{agent_id, project_id, tenant_id}

# Turn/tool histograms
agentpane_turn_duration_seconds{agent_id, phase}
agentpane_tool_call_duration_seconds{agent_id, tool}
agentpane_tool_calls_total{agent_id, tool, status}

# Queue depth
agentpane_queue_depth{priority, tenant_id}

# Warm pool
agentpane_warm_pool_available{tier}
agentpane_warm_pool_claimed_total{tier}
```

#### OpenTelemetry Traces

```
Agent Run (root span)
  ├─ Planning Phase (span)
  │   ├─ Turn 1 (span: tokens, cost, duration)
  │   │   ├─ Tool: Read (span)
  │   │   └─ Tool: Grep (span)
  │   └─ Turn 2 (span)
  │       └─ Tool: ExitPlanMode (span)
  └─ Execution Phase (span)
      ├─ Turn 1 (span)
      │   ├─ Tool: Edit (span)
      │   └─ Tool: Bash (span)
      └─ Turn 2 (span)
          └─ Tool: Write (span)
```

Each span carries attributes: `tokens.input`, `tokens.output`, `cost.usd`,
`model`, `tool.name`, `tool.status`.

Traces export via OTLP to any compatible backend (Jaeger, Grafana Tempo,
Datadog).

### Key Design Decisions

1. **Budget at turn boundary** — checking mid-turn would interrupt tool calls;
   turn completion is the natural checkpoint
2. **Pause before terminate** — gives users a chance to approve continuation
   for legitimately expensive tasks
3. **OTel, not custom tracing** — OpenTelemetry is the industry standard;
   avoids vendor lock-in and integrates with existing observability stacks

### Affected Areas

- `turn-limiter.ts` — extend to token/cost limits with hierarchical rollup
- `agent-runner/src/event-emitter.ts` — emit token/cost data per turn
- `durable-streams.service.ts` — propagate budget events to UI
- `agent_runs` schema — add `costUsd`, `inputTokens`, `outputTokens`,
  budget-exceeded status
- New: `budget.service.ts` — hierarchical budget management
- New: `metrics.ts` — Prometheus metrics registry and `/metrics` endpoint
- New: `tracing.ts` — OTel span creation and export configuration

---

## Implementation Phases

### Phase 1: Identity + Agent Card

**Goal**: Every agent has a cryptographic identity and self-describes its
capabilities.

```
 1. Deploy SPIRE Server + Agent (K8s environment first)
 2. Implement SVID acquisition in agent-runner startup
 3. Replace static token injection with SVID → OIDC → short-lived token flow
 4. Add /.well-known/agent.json endpoint to agent-runner
 5. Add /metrics endpoint with basic turn/token counters
 6. Control plane reads agent cards for status (replaces DB polling)
 7. Graceful fallback: agents without SPIRE fall back to static token + warning
```

**Exit criteria**: An agent running on K8s has a SPIFFE ID, rotates credentials
automatically, and exposes a queryable agent card.

### Phase 2: Scheduling + Security Parity

**Goal**: Tasks declare what they need; the scheduler places them optimally.
All providers meet the same security baseline.

```
 1. Define AgentRequirements schema (Zod)
 2. Providers advertise capabilities via a ProviderCapabilities interface
 3. Implement scheduling pipeline (validate → filter → score → place)
 4. Replace AgentQueueService stub with real priority queue
 5. Implement warm pool for standard tier (K8s first)
 6. Apply network isolation to Docker (iptables helper)
 7. Apply network isolation to Nomad (Consul Connect or network stanza)
 8. Enforce filesystem/process hardening across all providers
 9. Implement preemption for critical/high priority tasks
```

**Exit criteria**: A GPU-requiring task routes only to GPU-capable providers.
A Docker agent cannot reach 169.254.0.0/16 or arbitrary internet endpoints.

### Phase 3: Budget + Observability

**Goal**: Runaway agents are stopped before they drain budgets. Every agent run
is fully traceable.

```
 1. Extend turn-limiter to token and cost enforcement
 2. Implement hierarchical budget rollup (task → project → tenant → platform)
 3. Add pause-at-threshold behavior with user approval flow
 4. Instrument agent-runner with OpenTelemetry spans
 5. Expose /metrics with full Prometheus counter/histogram set
 6. Implement warm pool auto-scaling based on usage patterns
 7. Add cost attribution API for billing dashboards
```

**Exit criteria**: An agent that exceeds its $5 task budget is paused. A
complete OTel trace exists for every agent run showing turns, tools, tokens,
and cost.

---

## Dependencies Between Priorities

```
                    ┌──────────────────┐
                    │  1. Identity     │
                    │  (SVIDs)         │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  2. Agent Card   │
                    │  (discovery)     │
                    └───┬──────────┬───┘
                        │          │
              ┌─────────▼──┐  ┌───▼──────────┐
              │ 3. Smart   │  │ 4. Security  │
              │ Dispatch   │  │ Parity       │
              └─────────┬──┘  └───┬──────────┘
                        │         │
                    ┌───▼─────────▼───┐
                    │  5. Budget +    │
                    │  Observability  │
                    └─────────────────┘
```

- **1 → 2**: Agent Card includes SPIFFE ID; card endpoint uses mTLS
- **2 → 3**: Scheduler reads agent cards for capability matching
- **2 → 4**: Security policies reference agent identity
- **3,4 → 5**: Budget enforcement requires scheduling context; security
  baseline must exist before exposing metrics endpoints

---

## Open Questions

1. **SPIRE deployment model for non-K8s** — Docker Desktop and bare-metal Nomad
   need a SPIRE Agent. Sidecar container? Host-level systemd service?
2. **Warm pool cost** — pre-provisioned instances cost money even when idle.
   What's the right min-pool-size per tier per tenant?
3. **Budget granularity** — should budgets be enforced per-turn (current plan)
   or per-tool-call (more granular but higher overhead)?
4. **A2A protocol adoption** — when does full A2A compliance become a priority
   vs internal-only agent cards?
5. **Preemption state persistence** — how much agent state needs to be saved
   for a preempted agent to resume efficiently?
