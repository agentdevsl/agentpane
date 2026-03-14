# Kubernetes Integration Plan

> **Feature**: Kubernetes Sandbox Provider for AgentPane
> **Status**: Phase 5 Complete (All Phases Done)
> **Created**: 2026-01-23
> **Tasks**: See [kubernetes-integration-tasks.md](./kubernetes-integration-tasks.md)

---

## Executive Summary

This plan outlines the implementation of Kubernetes as a sandbox provider for AgentPane, enabling production-like isolation for AI agents using local K8s clusters (minikube/kind). The feature builds upon the existing sandbox provider architecture and the Phase 2 roadmap specifications.

---

## 1. Current State Analysis

### 1.1 Existing Infrastructure

| Component | Status | Location |
|-----------|--------|----------|
| Sandbox Provider Interface | ✅ Complete | `src/lib/sandbox/providers/sandbox-provider.ts` |
| Docker Provider | ✅ Complete | `src/lib/sandbox/providers/docker-provider.ts` |
| Sandbox Service | ✅ Complete | `src/services/sandbox.service.ts` |
| UI Settings Page | ✅ Complete | `src/app/routes/settings/sandbox.tsx` |
| K8s UI Placeholder | ✅ Exists | Lines 285-307 in sandbox.tsx |
| K8s Provider | ✅ Complete | `src/lib/sandbox/providers/k8s-provider.ts` |
| K8s Sandbox | ✅ Complete | `src/lib/sandbox/providers/k8s-sandbox.ts` |
| K8s Config | ✅ Complete | `src/lib/sandbox/providers/k8s-config.ts` |
| K8s Errors | ✅ Complete | `src/lib/errors/k8s-errors.ts` |
| K8s Unit Tests | ✅ Complete | `src/lib/sandbox/providers/__tests__/k8s-provider.test.ts` |
| K8s Integration Tests | ✅ Complete | `src/lib/sandbox/providers/__tests__/k8s-tmux.integration.test.ts` |
| K8s Roadmap Spec | ✅ Complete | `specs/roadmap/phase2-sandbox-plugins.md` |
| K8s Network Policy | ✅ Complete | `src/lib/sandbox/providers/k8s-network-policy.ts` |
| K8s RBAC Manager | ✅ Complete | `src/lib/sandbox/providers/k8s-rbac.ts` |
| K8s Audit Logger | ✅ Complete | `src/lib/sandbox/providers/k8s-audit.ts` |
| K8s Security Validator | ✅ Complete | `src/lib/sandbox/providers/k8s-security.ts` |
| K8s Manifests | ✅ Complete | `k8s/manifests/*.yaml` |
| K8s Security Tests | ✅ Complete | `src/lib/sandbox/providers/__tests__/k8s-security.test.ts` |
| K8s Warm Pool Controller | ✅ Complete | `src/lib/sandbox/providers/k8s-warm-pool.ts` |
| K8s Warm Pool Tests | ✅ Complete | `src/lib/sandbox/providers/__tests__/k8s-warm-pool.test.ts` |

### 1.2 K8s Placeholder Verification

The Kubernetes option is present in the UI as a "Coming Soon" placeholder:

```tsx
{/* Kubernetes Provider - Coming Soon */}
<div className="relative cursor-not-allowed rounded-lg border border-border bg-surface-subtle/50 p-5 opacity-60">
  <div className="absolute right-3 top-3">
    <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning">
      Coming Soon
    </span>
  </div>
  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-2xl">
    ☸️
  </div>
  <h3 className="font-semibold text-fg">Kubernetes</h3>
  <p className="mt-1 text-sm text-fg-muted">
    Local K8s via minikube/kind. Production-like isolation.
  </p>
  <div className="mt-3 flex flex-wrap gap-2">
    <span className="rounded-full bg-success-muted px-2.5 py-1 text-xs text-success">
      Network Policies
    </span>
    <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-fg-muted">
      Warm Pool
    </span>
  </div>
</div>
```

---

## 2. Architecture Overview

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AgentPane Client (Browser)                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Settings Page (/settings/sandbox)                                   ││
│  │  - Provider Selection: [Docker] [Kubernetes]                         ││
│  │  - Resource Profiles                                                 ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  AgentPane Server (Bun)                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Sandbox Service                                                     ││
│  │  - getProvider(type: 'docker' | 'k8s')                              ││
│  │  - Lifecycle management                                              ││
│  └──────────────────────────────────┬──────────────────────────────────┘│
│                                      │                                   │
│    ┌─────────────────────────────────┼─────────────────────────────────┐│
│    │                                 │                                  ││
│    ▼                                 ▼                                  ││
│  ┌────────────────────┐   ┌────────────────────────────────────────┐   ││
│  │  DockerProvider    │   │  K8sProvider (NEW)                      │   ││
│  │  - dockerode       │   │  - @kubernetes/client-node              │   ││
│  │  - Containers      │   │  - Pods                                 │   ││
│  │  - Exec/Attach     │   │  - Exec/Logs                            │   ││
│  │  - tmux sessions   │   │  - tmux sessions                        │   ││
│  └────────────────────┘   └────────────────────────────────────────┘   ││
│                                      │                                   │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster (minikube/kind/k3s/Docker Desktop)                   │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Namespace: agentpane-sandboxes                                      ││
│  │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     ││
│  │  │  Pod: agent-xxx  │ │  Pod: agent-yyy  │ │  Pod: agent-zzz  │     ││
│  │  │  - workspace vol │ │  - workspace vol │ │  - workspace vol │     ││
│  │  │  - resource lim  │ │  - resource lim  │ │  - resource lim  │     ││
│  │  │  - securityCtx   │ │  - securityCtx   │ │  - securityCtx   │     ││
│  │  └──────────────────┘ └──────────────────┘ └──────────────────┘     ││
│  │                                                                      ││
│  │  NetworkPolicy: agent-sandbox-egress-policy                          ││
│  │  - Restrict outbound to allowlisted hosts                           ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| K8s Client | `@kubernetes/client-node` | Official TypeScript client, well-maintained |
| Cluster Discovery | Auto-detect kubeconfig | Support minikube, kind, Docker Desktop, k3s |
| Pod Execution | `Exec` API via WebSocket | Native K8s approach, similar to `kubectl exec` |
| Network Isolation | NetworkPolicies | K8s-native, declarative, auditable |
| Resource Limits | Pod spec resources | K8s-native QoS enforcement |
| Storage | HostPath PV or PVC | Project workspace mounted into pod |

---

## 3. Implementation Phases

### Phase 1: Core K8s Provider (MVP)

**Goal**: Basic pod lifecycle management and command execution

#### 3.1.1 Tasks

| Task | Description | Effort |
|------|-------------|--------|
| T1.1 | Create `K8sProvider` class implementing `SandboxProvider` interface | M |
| T1.2 | Implement cluster auto-detection (kubeconfig parsing) | S |
| T1.3 | Implement `create()` - Pod creation with volume mounts | M |
| T1.4 | Implement `exec()` - Command execution via K8s Exec API | M |
| T1.5 | Implement `stop()` - Pod deletion | S |
| T1.6 | Implement `healthCheck()` - Cluster connectivity check | S |
| T1.7 | Add K8s-specific error types to error catalog | S |
| T1.8 | Unit tests for K8sProvider | M |

**Deliverables**:
- `src/lib/sandbox/providers/k8s-provider.ts`
- `src/lib/errors/k8s-errors.ts`
- `tests/unit/lib/sandbox/k8s-provider.test.ts`

#### 3.1.2 Pod Template

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent-${agentId}-${sandboxId}
  namespace: agentpane-sandboxes
  labels:
    agentpane.io/sandbox: "true"
    agentpane.io/agent-id: ${agentId}
    agentpane.io/project-id: ${projectId}
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: sandbox
      image: ${config.image}
      workingDir: /workspace
      resources:
        limits:
          memory: "${config.memoryMb}Mi"
          cpu: "${config.cpuCores}"
        requests:
          memory: "${config.memoryMb / 2}Mi"
          cpu: "${config.cpuCores / 2}"
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        readOnlyRootFilesystem: false
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      hostPath:
        path: ${config.projectPath}
        type: Directory
```

---

### Phase 2: UI Integration

**Goal**: Enable K8s provider selection in UI

#### 3.2.1 Tasks

| Task | Description | Effort |
|------|-------------|--------|
| T2.1 | Update sandbox settings page to enable K8s provider selection | S |
| T2.2 | Add K8s-specific configuration fields (kubeconfig path, namespace) | M |
| T2.3 | Implement cluster status indicator (connected/disconnected) | S |
| T2.4 | Add provider switching logic with graceful migration | M |
| T2.5 | Update sandbox config schema to support K8s options | S |
| T2.6 | E2E tests for K8s settings UI | M |

**Deliverables**:
- Updated `src/app/routes/settings/sandbox.tsx`
- `src/lib/api/schemas.ts` updates
- `tests/e2e/settings/sandbox-k8s.test.ts`

#### 3.2.2 UI Wireframe Changes

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sandbox Provider                                                        │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  ┌─────────────────────────┐    ┌─────────────────────────┐             │
│  │  🐳                      │    │  ☸️                   ✓  │             │
│  │  Docker                  │    │  Kubernetes              │             │
│  │                          │    │                          │             │
│  │  Local container         │    │  Local K8s cluster       │             │
│  │  isolation               │    │  (minikube/kind)         │             │
│  │                          │    │                          │             │
│  │  [Network Isolation]     │    │  [Network Policies]      │             │
│  │  [Resource Limits]       │    │  [Warm Pool]             │             │
│  └─────────────────────────┘    └─────────────────────────┘             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Kubernetes Configuration                                            ││
│  │  ───────────────────────────────────────────────────────────────────││
│  │                                                                      ││
│  │  Kubeconfig Path:  [~/.kube/config                              ]   ││
│  │  Namespace:        [agentpane-sandboxes                         ]   ││
│  │  Context:          [minikube                              ▾]        ││
│  │                                                                      ││
│  │  Cluster Status: ● Connected (minikube v1.32.0)                     ││
│  │                                                                      ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 3: tmux Session Support

**Goal**: Full parity with Docker provider for terminal sessions

#### 3.3.1 Tasks

| Task | Description | Effort |
|------|-------------|--------|
| T3.1 | Implement `createTmuxSession()` using K8s exec | M |
| T3.2 | Implement `listTmuxSessions()` | S |
| T3.3 | Implement `killTmuxSession()` | S |
| T3.4 | Implement `sendKeysToTmux()` | S |
| T3.5 | Implement `captureTmuxPane()` | S |
| T3.6 | Handle reconnection to existing tmux sessions | M |
| T3.7 | Integration tests for tmux operations | M |

**Deliverables**:
- tmux methods in `K8sProvider`
- `tests/integration/k8s-tmux.test.ts`

---

### Phase 4: Network Policies & Security

**Goal**: Production-grade network isolation

#### 3.4.1 Tasks

| Task | Description | Effort |
|------|-------------|--------|
| T4.1 | Create default NetworkPolicy for sandbox pods | M |
| T4.2 | Implement allowlist configuration for egress rules | M |
| T4.3 | Add RBAC configuration for AgentPane service account | M |
| T4.4 | Implement Pod Security Standards compliance | M |
| T4.5 | Add security audit logging for K8s operations | M |
| T4.6 | Security review and penetration testing | L |

**NetworkPolicy Template**:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-sandbox-policy
  namespace: agentpane-sandboxes
spec:
  podSelector:
    matchLabels:
      agentpane.io/sandbox: "true"
  policyTypes:
    - Egress
    - Ingress
  ingress: []  # No inbound allowed
  egress:
    # Allow DNS resolution
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
    # Allow HTTPS to configured allowlist
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
          protocol: TCP
```

---

### Phase 5: Warm Pool (Stretch Goal)

**Goal**: Fast sandbox startup via pre-warmed pods

#### 3.5.1 Tasks

| Task | Description | Effort |
|------|-------------|--------|
| T5.1 | Implement warm pool controller | L |
| T5.2 | Add `prewarm(count)` method | M |
| T5.3 | Add `getWarm()` method for fast allocation | M |
| T5.4 | Implement pool scaling based on usage patterns | L |
| T5.5 | Add metrics for warm pool utilization | M |

---

## 4. Database Schema Changes

### 4.1 Sandbox Config Table Update

```typescript
// src/db/schema/sandbox-configs.ts

export const sandboxConfigs = sqliteTable('sandbox_configs', {
  // ... existing fields ...

  // Add K8s-specific fields
  kubeConfigPath: text('kube_config_path'),
  kubeContext: text('kube_context'),
  kubeNamespace: text('kube_namespace').default('agentpane-sandboxes'),
  networkPolicyEnabled: integer('network_policy_enabled', { mode: 'boolean' }).default(true),
  allowedEgressHosts: text('allowed_egress_hosts'),  // JSON array
});
```

### 4.2 Sandbox Table Update

```typescript
// src/db/schema/sandboxes.ts

export const sandboxes = sqliteTable('sandboxes', {
  // ... existing fields ...

  // Add provider discrimination
  providerType: text('provider_type', { enum: ['docker', 'k8s'] }).default('docker'),

  // K8s-specific metadata
  podName: text('pod_name'),
  podNamespace: text('pod_namespace'),
  podUid: text('pod_uid'),
});
```

---

## 5. API Changes

### 5.1 New Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sandbox/k8s/status` | GET | K8s cluster connection status |
| `/api/sandbox/k8s/contexts` | GET | List available kubeconfig contexts |
| `/api/sandbox/k8s/namespaces` | GET | List namespaces in current context |

### 5.2 Updated Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/sandbox-configs` | Accept `providerType` field |
| `GET /api/sandbox-configs/:id` | Return K8s-specific fields |
| `POST /api/sandboxes` | Support K8s sandbox creation |

---

## 6. Dependencies

### 6.1 New NPM Packages

```json
{
  "@kubernetes/client-node": "^0.21.0",
  "ws": "^8.18.0"  // For K8s exec WebSocket (if not already present)
}
```

### 6.2 Development Dependencies

```json
{
  "@types/ws": "^8.5.12"
}
```

---

## 7. Testing Strategy

### 7.1 Test Categories

| Category | Approach | Coverage Target |
|----------|----------|-----------------|
| Unit | Mock K8s client | K8sProvider methods |
| Integration | Kind cluster in CI | Pod lifecycle, exec |
| E2E | Full stack with K8s | Settings UI, provider switching |

### 7.2 CI/CD Considerations

```yaml
# .github/workflows/test-k8s.yml
jobs:
  k8s-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup kind cluster
        uses: helm/kind-action@v1
        with:
          cluster_name: agentpane-test

      - name: Run K8s integration tests
        run: bun test:k8s
```

---

## 8. Rollout Plan

### 8.1 Feature Flag

```typescript
// src/lib/feature-flags.ts
export const FEATURE_FLAGS = {
  K8S_SANDBOX_PROVIDER: process.env.ENABLE_K8S_SANDBOX === 'true',
};
```

### 8.2 Rollout Phases

| Phase | Audience | Duration |
|-------|----------|----------|
| Alpha | Internal dev team | 2 weeks |
| Beta | Opt-in users with `ENABLE_K8S_SANDBOX=true` | 4 weeks |
| GA | All users | - |

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| K8s cluster unavailable | Medium | High | Graceful fallback to Docker |
| Pod startup latency | High | Medium | Warm pool (Phase 5) |
| Network policy misconfiguration | Medium | High | Default deny + explicit allow |
| Resource contention | Medium | Medium | Namespace quotas, LimitRanges |
| Kubeconfig permission issues | Medium | Low | Clear error messages, setup wizard |

---

## 10. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| K8s sandbox creation success rate | >95% | Telemetry |
| Sandbox boot time (cold) | <30s | P95 latency |
| Sandbox boot time (warm pool) | <5s | P95 latency |
| Provider adoption rate | 20% of sandboxes using K8s | Weekly analytics |
| User-reported K8s issues | <5/week | Support tickets |

---

## 11. Documentation Requirements

| Document | Purpose |
|----------|---------|
| `docs/sandbox/kubernetes-setup.md` | User guide for K8s setup |
| `docs/sandbox/kubernetes-troubleshooting.md` | Common issues and solutions |
| `specs/application/components/k8s-provider.md` | Component specification |
| `AGENTS.md` updates | K8s-specific developer guidance |

---

## 12. Open Questions

1. **PersistentVolumeClaim vs HostPath**: Should we support PVC for cloud K8s clusters, or is HostPath sufficient for local development?

2. **Multi-context support**: Should users be able to configure multiple K8s contexts for different projects?

3. **Resource quotas**: Should we enforce namespace-level ResourceQuotas to prevent runaway pods?

4. **Pod templates**: Should users be able to provide custom pod templates for advanced use cases?

5. **Operator pattern**: Would a K8s Operator be beneficial for managing sandbox lifecycle at scale?

---

## 13. References

- [Existing Roadmap Spec](../roadmap/phase2-sandbox-plugins.md)
- [Kubernetes Client Node](https://github.com/kubernetes-client/javascript)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Docker Provider Implementation](../../src/lib/sandbox/providers/docker-provider.ts)
- [Sandbox Provider Interface](../../src/lib/sandbox/providers/sandbox-provider.ts)

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-23 | Initial plan created |
| 2026-01-23 | Phase 1 implementation complete (K8sProvider, K8sSandbox, errors, tests) |
| 2026-01-23 | Phase 1 review fixes applied (exports, execAsRoot docs, additional tests) |
| 2026-01-23 | Created kubernetes-integration-tasks.md for detailed tracking |
| 2026-01-23 | Phase 2 complete (UI integration, API endpoints, schema updates) |
| 2026-01-23 | Phase 3 complete (tmux integration tests with real K8s cluster support) |
| 2026-01-23 | Phase 4 complete (NetworkPolicy, RBAC, security audit logging, Pod Security Standards) |
| 2026-01-23 | Phase 5 complete (Warm Pool: WarmPoolController, prewarm(), getWarm(), auto-scaling, metrics) |
