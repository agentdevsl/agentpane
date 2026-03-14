# Phase 2: Agent Sandbox CRD Integration

> **Status**: Specification Complete
> **Created**: 2026-02-12
> **Depends On**: Phase 1 (Complete) -- Custom Kubernetes Sandbox Provider
> **Spec Documents**: See table below

---

## Context

Phase 1 (complete) built a custom Kubernetes sandbox provider using raw `@kubernetes/client-node` calls -- approximately 4,300 lines of code managing manual pod lifecycle, warm pool, network policy, RBAC, and security across 8 source files:

| File | LOC | Purpose |
|------|-----|---------|
| `k8s-provider.ts` | ~800 | Pod creation, recovery, image pull, cleanup |
| `k8s-sandbox.ts` | ~350 | Exec, tmux sessions, metrics, status |
| `k8s-config.ts` | ~200 | KubeConfig loading, context resolution |
| `k8s-network-policy.ts` | ~400 | Manual NetworkPolicy CRUD |
| `k8s-rbac.ts` | ~500 | ServiceAccount, Role, RoleBinding creation |
| `k8s-security.ts` | ~600 | PodSecurityContext validation, audit |
| `k8s-audit.ts` | ~450 | Audit logging for K8s operations |
| `k8s-warm-pool.ts` | ~1000 | Manual warm pool with polling-based lifecycle |

The [Agent Sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox) (`agents.x-k8s.io/v1alpha1`) from kubernetes-sigs provides all of this natively via Kubernetes controllers: `Sandbox`, `SandboxTemplate`, `SandboxWarmPool`, and `SandboxClaim` resources. The CRD controller handles:

- Pod lifecycle (create, pause/resume via replicas, shutdown with TTL)
- Stable service FQDN per sandbox
- Network policy via SandboxTemplate
- Warm pool with HPA-compatible scaling
- PVC management for persistent workspaces
- gVisor/Kata runtime class support

Phase 2 replaces the custom K8s provider with a CRD-based approach, creates a standalone TypeScript SDK for the Agent Sandbox CRD, integrates with `ContainerAgentService` for end-to-end agent execution in K8s pods, and validates on minikube with gVisor.

---

## Deliverables Overview

| # | Deliverable | Description | Spec Document |
|---|------------|-------------|---------------|
| 1 | `@agentpane/agent-sandbox-sdk` | Standalone npm package -- TypeScript SDK for the Agent Sandbox CRD | [agent-sandbox-sdk-spec.md](./agent-sandbox-sdk-spec.md) |
| 2 | `AgentSandboxProvider` | New `SandboxProvider` implementation using the SDK | [provider-integration-spec.md](./provider-integration-spec.md) |
| 3 | ContainerAgentService integration | Provider-agnostic wiring so agents run in CRD sandboxes | [provider-integration-spec.md](./provider-integration-spec.md) |
| 4 | Settings UI updates | Replace K8s config with CRD-aware settings | [provider-integration-spec.md](./provider-integration-spec.md) |
| 5 | Minikube validation environment | Setup scripts, gVisor runtime, E2E tests | [minikube-setup-guide.md](./minikube-setup-guide.md) |
| 6 | Migration guide | Phase 1 to Phase 2 migration: what to archive, what to replace | [migration-guide.md](./migration-guide.md) |

---

## Implementation Order

| Step | Task | Files | Depends On |
|------|------|-------|------------|
| 1 | Create SDK package scaffold | `packages/agent-sandbox-sdk/` | -- |
| 2 | SDK types and Zod schemas | `src/types/`, `src/schemas/` | Step 1 |
| 3 | SDK KubeConfig loader | `src/kubeconfig.ts` | Step 1 |
| 4 | SDK generic CRUD operations | `src/operations/crud.ts` | Steps 2, 3 |
| 5 | SDK exec and execStream | `src/operations/exec.ts` | Step 4 |
| 6 | SDK watch/informer | `src/operations/watch.ts` | Step 4 |
| 7 | SDK lifecycle helpers | `src/operations/lifecycle.ts` | Step 4 |
| 8 | SDK builders | `src/builders/` | Step 2 |
| 9 | SDK client orchestrator | `src/client.ts` | Steps 4-8 |
| 10 | SDK unit tests | `__tests__/` | Steps 2-9 |
| 11 | `AgentSandboxProvider` | `src/lib/sandbox/providers/agent-sandbox-provider.ts` | Step 9 |
| 12 | `AgentSandboxInstance` | `src/lib/sandbox/providers/agent-sandbox-instance.ts` | Step 5 |
| 13 | Provider unit tests | `__tests__/agent-sandbox-provider.test.ts` | Steps 11, 12 |
| 14 | api.ts provider wiring | `src/server/api.ts` | Step 11 |
| 15 | Settings UI updates | `src/app/routes/settings/sandbox.tsx` | Step 14 |
| 16 | Archive old K8s provider | `src/lib/sandbox/providers/_archived/` | Step 14 |

Steps 1-10 (SDK) and minikube setup (scripts/manifests) can be parallelized.

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `src/server/api.ts:526-652` | Add provider selection logic (Docker vs K8s CRD) |
| `src/app/routes/settings/sandbox.tsx` | CRD-aware K8s settings UI |
| `src/lib/sandbox/types.ts:86` | Add `'agent-sandbox'` to SandboxProvider type |
| `package.json` (root) | Add workspace reference to SDK package |

## Critical Files to Reuse

| File | What to Reuse |
|------|---------------|
| `src/lib/sandbox/providers/k8s-sandbox.ts:89-162` | K8s Exec pattern with Writable streams, V1Status exit code parsing |
| `src/lib/sandbox/providers/k8s-sandbox.ts:164-346` | tmux session methods |
| `src/lib/sandbox/providers/docker-provider.ts:271-400` | ExecStreamResult contract (PassThrough, wait/kill pattern) |
| `src/lib/sandbox/providers/k8s-config.ts` | KubeConfig loading, context resolution |
| `packages/cli-monitor/package.json` | Package scaffold conventions |
| `src/services/container-agent.service.ts:901` | Integration point -- uses `sandbox.execStream()` |

---

## Verification

### Unit Tests

```bash
# SDK tests
cd packages/agent-sandbox-sdk && bun test

# Provider tests
bun run test -- --grep "AgentSandboxProvider"
```

### Integration Tests (minikube required)

```bash
# Setup minikube with gVisor + Agent Sandbox controller
./scripts/k8s-setup-minikube.sh

# Run E2E
K8S_E2E=true bun run test:k8s-e2e
```

### Manual Validation

1. Start AgentPane: `npm run dev`
2. Settings -> Sandbox -> Select "Kubernetes (Agent Sandbox)"
3. Configure: context=minikube, namespace=agentpane-sandboxes, runtime=gVisor
4. Click "Test Connection" -> all indicators green
5. Create a project and a task
6. Move task to "In Progress" -> agent starts in CRD sandbox
7. Verify agent plan -> approve -> execution completes
8. Check: `kubectl get sandboxes -n agentpane-sandboxes` shows lifecycle

---

## Spec Documents

| Document | Description |
|----------|-------------|
| [agent-sandbox-sdk-spec.md](./agent-sandbox-sdk-spec.md) | Full SDK specification: types, CRUD, exec, watch, builders, schemas |
| [provider-integration-spec.md](./provider-integration-spec.md) | Provider, ContainerAgent integration, Settings UI, API endpoints |
| [minikube-setup-guide.md](./minikube-setup-guide.md) | Setup scripts, manifests, testing procedures, troubleshooting |
| [migration-guide.md](./migration-guide.md) | Phase 1 to Phase 2 migration: archives, new files, rollback |
