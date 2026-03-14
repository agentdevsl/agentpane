# Migration Guide: Phase 1 to Phase 2 (Agent Sandbox CRD)

> **Status**: Ready for implementation
> **Created**: 2026-02-12
> **Audience**: Developers migrating from the custom K8s sandbox provider to the CRD-based approach
> **Prerequisite**: Phase 1 (custom K8s provider) is complete and passing all tests

---

## Overview

Phase 1 built a custom Kubernetes sandbox provider using raw `@kubernetes/client-node` API calls -- approximately 4,300 lines of code across 8 source files and 4 test files. Phase 2 replaces this with a CRD-based approach using the `@agentpane/agent-sandbox-sdk` package, which delegates pod lifecycle, network policy, RBAC, warm pools, and security to the Agent Sandbox CRD controller (`agents.x-k8s.io/v1alpha1`).

The result is a drop from ~4,300 LOC of custom K8s logic to ~600 LOC in two provider files (`agent-sandbox-provider.ts` and `agent-sandbox-instance.ts`) that delegate to the SDK. No breaking changes are introduced to the `ContainerAgentService` or the `SandboxProvider`/`Sandbox` interfaces.

---

## Table of Contents

1. [What Gets Archived](#1-what-gets-archived)
2. [What Gets Replaced](#2-what-gets-replaced)
3. [What Stays](#3-what-stays)
4. [Migration Steps](#4-migration-steps)
5. [Archive Strategy](#5-archive-strategy)
6. [Import Path Updates](#6-import-path-updates)
7. [Concept Mapping](#7-concept-mapping)
8. [API Surface Changes](#8-api-surface-changes)
9. [Feature Comparison](#9-feature-comparison)
10. [Rollback Plan](#10-rollback-plan)
11. [Timeline Estimate](#11-timeline-estimate)
12. [Verification Checklist](#12-verification-checklist)

---

## 1. What Gets Archived

### Phase 1 Source Files

These files contain the custom K8s provider implementation. They are moved to `_archived/` -- not deleted -- so they remain available as reference material.

| File | LOC | Purpose | Phase 2 Replacement |
|------|-----|---------|---------------------|
| `src/lib/sandbox/providers/k8s-provider.ts` | ~800 | Pod lifecycle, namespace, PVC, security, warm pool orchestration | `agent-sandbox-provider.ts` (delegates to SDK) |
| `src/lib/sandbox/providers/k8s-sandbox.ts` | ~350 | Exec, tmux, metrics, status for a single sandbox | `agent-sandbox-instance.ts` (delegates to SDK) |
| `src/lib/sandbox/providers/k8s-config.ts` | ~200 | KubeConfig loading, context resolution, constants | SDK `kubeconfig.ts` + SDK config options |
| `src/lib/sandbox/providers/k8s-network-policy.ts` | ~400 | Manual NetworkPolicy CRUD operations | SandboxTemplate CRD `networkPolicy` field |
| `src/lib/sandbox/providers/k8s-rbac.ts` | ~500 | ServiceAccount, Role, RoleBinding creation | CRD controller handles RBAC automatically |
| `src/lib/sandbox/providers/k8s-security.ts` | ~600 | PodSecurityContext validation, PSS checks | SDK builder defaults + admission controllers |
| `src/lib/sandbox/providers/k8s-audit.ts` | ~450 | Custom audit logging for K8s operations | Standard K8s events + SDK provider events |
| `src/lib/sandbox/providers/k8s-warm-pool.ts` | ~1000 | Manual warm pool with polling-based lifecycle | SandboxWarmPool CRD resource |
| `src/lib/errors/k8s-errors.ts` | ~320 | K8s-specific error factory functions | SDK `errors.ts` (`AgentSandboxError`) |

### Phase 1 Test Files

| File | Purpose |
|------|---------|
| `src/lib/sandbox/providers/__tests__/k8s-provider.test.ts` | K8sProvider unit tests |
| `src/lib/sandbox/providers/__tests__/k8s-security.test.ts` | Security validation + network policy tests |
| `src/lib/sandbox/providers/__tests__/k8s-warm-pool.test.ts` | Warm pool controller unit tests |
| `src/lib/sandbox/providers/__tests__/k8s-tmux.integration.test.ts` | tmux integration tests (minikube required) |

### Phase 1 Manifest Files

| File | Action |
|------|--------|
| `k8s/manifests/network-policy.yaml` | **Archive** -- replaced by SandboxTemplate `networkPolicy` field |
| `k8s/manifests/rbac.yaml` | **Archive** -- CRD controller manages RBAC |

---

## 2. What Gets Replaced

### New Provider Files (already created)

| File | Purpose |
|------|---------|
| `src/lib/sandbox/providers/agent-sandbox-provider.ts` | `AgentSandboxProvider` class implementing `EventEmittingSandboxProvider` |
| `src/lib/sandbox/providers/agent-sandbox-instance.ts` | `AgentSandboxInstance` class implementing `Sandbox` |

### New SDK Package

| Location | Purpose |
|----------|---------|
| `packages/agent-sandbox-sdk/` | Standalone TypeScript SDK for the Agent Sandbox CRD |

### New Manifests (already created)

| File | Purpose |
|------|---------|
| `k8s/manifests/agentpane-sandbox-template.yaml` | SandboxTemplate CRD with pod spec, security, and network policy |
| `k8s/manifests/agentpane-warm-pool.yaml` | SandboxWarmPool CRD with replicas and template ref |
| `k8s/manifests/runtime-class-gvisor.yaml` | RuntimeClass for gVisor sandbox runtime |

---

## 3. What Stays

These files are unaffected or need only minor updates.

| File | Status | Notes |
|------|--------|-------|
| `src/lib/sandbox/providers/sandbox-provider.ts` | **Keep unchanged** | Interface definitions (`Sandbox`, `SandboxProvider`, etc.) remain the same |
| `src/lib/sandbox/providers/docker-provider.ts` | **Keep unchanged** | Docker provider is unaffected |
| `src/lib/sandbox/types.ts` | **Keep unchanged** | `SandboxProvider` type already includes `'kubernetes'` |
| `src/lib/sandbox/tmux-manager.ts` | **Keep unchanged** | Shared tmux utility |
| `src/lib/sandbox/credentials-injector.ts` | **Keep unchanged** | OAuth credential injection |
| `src/lib/sandbox/index.ts` | **Update exports** | Remove Phase 1 re-exports, add Phase 2 exports |
| `src/server/api.ts` (lines 525-652) | **Update** | Add provider selection logic for Docker vs K8s CRD |
| `src/server/routes/sandbox.ts` | **Update** | Replace `k8s-config.js` import with SDK import |
| `k8s/manifests/namespace.yaml` | **Keep** | Namespace is still needed |
| `k8s/manifests/limit-range.yaml` | **Keep** | Resource limits are still useful |

---

## 4. Migration Steps

Follow these steps in order. Each step includes a verification command so you can confirm success before proceeding.

### Step 1: Install the SDK Package

Add `@agentpane/agent-sandbox-sdk` to the workspace.

```bash
# Verify the SDK package exists
ls packages/agent-sandbox-sdk/package.json

# Install from workspace
cd /path/to/agentpane_nocode
bun install
```

**Verify:** `bun run --filter @agentpane/agent-sandbox-sdk build` completes without errors.

### Step 2: Confirm New Provider Files Exist

The Phase 2 provider files should already be in place:

```bash
ls src/lib/sandbox/providers/agent-sandbox-provider.ts
ls src/lib/sandbox/providers/agent-sandbox-instance.ts
```

These files implement the same `EventEmittingSandboxProvider` and `Sandbox` interfaces as the Phase 1 provider, but delegate all K8s operations to the SDK client.

**Verify:** Both files exist and import from `@agentpane/agent-sandbox-sdk`.

### Step 3: Update `src/server/api.ts` -- Provider Selection

Add logic to choose between Docker and K8s CRD providers based on settings. The current code (lines 525-652) only initializes the Docker provider. Add a parallel K8s CRD initialization path:

```typescript
import { AgentSandboxProvider } from '../lib/sandbox/providers/agent-sandbox-provider.js';

// After Docker provider initialization (line 652):

// Step 4: Initialize K8s Agent Sandbox provider (optional - only if configured)
let k8sCrdProvider: AgentSandboxProvider | null = null;

try {
  const k8sSettings = await db.query.settings.findFirst({
    where: eq(schemaTables.settings.key, 'sandbox.defaults.provider'),
  });

  if (k8sSettings?.value === 'kubernetes') {
    const k8sConfig = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.k8s'),
    });
    const config = k8sConfig?.value ? JSON.parse(k8sConfig.value) : {};

    k8sCrdProvider = new AgentSandboxProvider({
      namespace: config.namespace,
      kubeConfigPath: config.kubeConfigPath,
      kubeContext: config.kubeContext,
      enableWarmPool: config.enableWarmPool,
      warmPoolSize: config.warmPoolSize,
      runtimeClassName: config.runtimeClassName,
      image: config.image,
    });

    await k8sCrdProvider.healthCheck();
    log.info('[API Server] K8s Agent Sandbox provider initialized');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.warn(`[API Server] K8s Agent Sandbox not available: ${message}`);
}
```

**Verify:** `npm run dev` starts without errors. If K8s is not configured, the warning is logged and the Docker provider is used as before.

### Step 4: Update Settings UI

Add CRD-aware configuration fields to `src/app/routes/settings/sandbox.tsx`. Replace the "Coming Soon" placeholder with functional K8s settings:

- **Context selector**: Dropdown of available kubeconfig contexts
- **Namespace**: Text field (default: `agentpane-sandboxes`)
- **Runtime class**: Dropdown (`none`, `gvisor`, `kata`)
- **Enable warm pool**: Toggle
- **Warm pool size**: Number input (shown when warm pool is enabled)
- **Test Connection**: Button that calls `GET /api/sandbox/k8s/controller`

**Verify:** Navigate to Settings > Sandbox. K8s option is selectable and shows configuration fields.

### Step 5: Apply New K8s Manifests

Apply the CRD manifests to your cluster. These are already in `k8s/manifests/`:

```bash
# Ensure the Agent Sandbox CRD controller is installed first
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml

# Apply AgentPane manifests
kubectl apply -f k8s/manifests/namespace.yaml
kubectl apply -f k8s/manifests/runtime-class-gvisor.yaml
kubectl apply -f k8s/manifests/agentpane-sandbox-template.yaml
kubectl apply -f k8s/manifests/agentpane-warm-pool.yaml
kubectl apply -f k8s/manifests/limit-range.yaml
```

**Verify:**

```bash
kubectl get sandboxtemplates -n agentpane-sandboxes
# NAME               AGE
# agentpane-default   ...

kubectl get sandboxwarmpools -n agentpane-sandboxes
# NAME                    AGE
# agentpane-warm-pool      ...
```

### Step 6: Run New Tests

Run SDK tests and provider tests to confirm everything works:

```bash
# SDK unit tests
cd packages/agent-sandbox-sdk && bun test

# Provider unit tests
bun run test -- --grep "AgentSandboxProvider"

# All sandbox-related tests
bun run test -- --grep "sandbox"
```

**Verify:** All tests pass. No test failures related to K8s sandbox operations.

### Step 7: Archive Phase 1 Files

Move Phase 1 files to the `_archived/` directory. Do this only after Steps 1-6 pass.

```bash
# Create archive directories
mkdir -p src/lib/sandbox/providers/_archived/__tests__

# Move source files
mv src/lib/sandbox/providers/k8s-provider.ts    src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-sandbox.ts     src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-config.ts      src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-network-policy.ts src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-rbac.ts        src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-security.ts    src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-audit.ts       src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-warm-pool.ts   src/lib/sandbox/providers/_archived/

# Move error file
mv src/lib/errors/k8s-errors.ts                 src/lib/sandbox/providers/_archived/

# Move test files
mv src/lib/sandbox/providers/__tests__/k8s-provider.test.ts       src/lib/sandbox/providers/_archived/__tests__/
mv src/lib/sandbox/providers/__tests__/k8s-security.test.ts       src/lib/sandbox/providers/_archived/__tests__/
mv src/lib/sandbox/providers/__tests__/k8s-warm-pool.test.ts      src/lib/sandbox/providers/_archived/__tests__/
mv src/lib/sandbox/providers/__tests__/k8s-tmux.integration.test.ts src/lib/sandbox/providers/_archived/__tests__/

# Move replaced manifests
mkdir -p k8s/manifests/_archived
mv k8s/manifests/network-policy.yaml  k8s/manifests/_archived/
mv k8s/manifests/rbac.yaml            k8s/manifests/_archived/
```

Create `src/lib/sandbox/providers/_archived/README.md`:

```markdown
# Archived: Phase 1 Custom K8s Provider

These files are the Phase 1 custom Kubernetes sandbox provider implementation.
They used raw `@kubernetes/client-node` API calls for manual pod lifecycle,
RBAC, network policy, security validation, audit logging, and warm pool management.

**Replaced by**: Phase 2 Agent Sandbox CRD integration
- `agent-sandbox-provider.ts` -- new provider using `@agentpane/agent-sandbox-sdk`
- `agent-sandbox-instance.ts` -- new sandbox instance using SDK exec/lifecycle

**Why archived (not deleted)**:
- Reference material for K8s patterns (exec streams, tmux integration)
- Comparison for verifying CRD-based behavior matches Phase 1
- Rollback target if Phase 2 encounters issues

**See**: `specs/K8s/phase2/migration-guide.md` for the full migration plan.
```

**Verify:** `bun run test` still passes (no import errors from archived paths).

### Step 8: Update Barrel Exports and Imports

#### Update `src/lib/sandbox/index.ts`

Remove Phase 1 re-exports and add Phase 2 exports. The current file exports numerous symbols from the archived files. Replace them:

**Remove these export blocks:**

```typescript
// Remove all of these:
export type { K8sAuditEvent, K8sAuditEventType, K8sAuditSeverity } from './providers/k8s-audit.js';
export { createK8sAuditLogger, getK8sAuditLogger, K8sAuditLogger } from './providers/k8s-audit.js';
export type { K8sProviderOptions } from './providers/k8s-config.js';
export { K8S_POD_LABELS, K8S_PROVIDER_DEFAULTS } from './providers/k8s-config.js';
export type { NetworkPolicyConfig } from './providers/k8s-network-policy.js';
export { createNetworkPolicyManager, K8sNetworkPolicyManager, NETWORK_POLICY_DEFAULTS, NETWORK_POLICY_NAMES, PRIVATE_IP_RANGES } from './providers/k8s-network-policy.js';
export { createK8sProvider, K8sProvider } from './providers/k8s-provider.js';
export { createRbacManager, K8sRbacManager, RBAC_NAMES } from './providers/k8s-rbac.js';
export type { PssProfile, PssValidationResult } from './providers/k8s-security.js';
export { createPodSecurityValidator, ensureRestrictedPodSecurity, getPodSecurityValidator, PodSecurityValidator } from './providers/k8s-security.js';
export type { WarmPodInfo, WarmPoolConfig, WarmPoolMetrics, WarmPoolPodState } from './providers/k8s-warm-pool.js';
export { createWarmPoolController, K8S_WARM_POOL_LABELS, WARM_POOL_DEFAULTS, WarmPoolController } from './providers/k8s-warm-pool.js';
```

**Add these exports:**

```typescript
// Agent Sandbox CRD Provider (Phase 2)
export { AgentSandboxProvider } from './providers/agent-sandbox-provider.js';
export type { AgentSandboxProviderOptions } from './providers/agent-sandbox-provider.js';
export { AgentSandboxInstance } from './providers/agent-sandbox-instance.js';
```

#### Update `src/server/routes/sandbox.ts`

Replace the `k8s-config.js` import:

```typescript
// Before (Phase 1):
import {
  getClusterInfo,
  K8S_PROVIDER_DEFAULTS,
  loadKubeConfig,
  resolveContext,
} from '../../lib/sandbox/providers/k8s-config.js';

// After (Phase 2):
import {
  loadKubeConfig,
  resolveContext,
  getClusterInfo,
} from '@agentpane/agent-sandbox-sdk';
```

If `K8S_PROVIDER_DEFAULTS` is used in the sandbox routes, replace with the SDK equivalent or inline the defaults.

**Verify:** `bun run build` completes without import errors. `bun run test` passes.

### Step 9: Run E2E Validation

Full end-to-end test with minikube:

```bash
# Setup minikube with gVisor + Agent Sandbox controller
./scripts/k8s-setup-minikube.sh

# Run E2E tests
K8S_E2E=true bun run test:k8s-e2e
```

**Manual validation:**

1. Start AgentPane: `npm run dev`
2. Navigate to Settings > Sandbox > Select "Kubernetes (Agent Sandbox)"
3. Configure: context=minikube, namespace=agentpane-sandboxes, runtime=gVisor
4. Click "Test Connection" -- all indicators should be green
5. Create a project and a task
6. Move task to "In Progress" -- agent starts in CRD sandbox
7. Verify agent plan -- approve -- execution completes
8. Confirm CRD resources: `kubectl get sandboxes -n agentpane-sandboxes`

**Verify:** Agent completes task successfully. Pod lifecycle matches expected CRD states.

---

## 5. Archive Strategy

### Directory Structure

```
src/lib/sandbox/providers/_archived/
├── README.md                          # Why these are archived, link to Phase 2
├── k8s-provider.ts                    # Pod lifecycle, warm pool orchestration
├── k8s-sandbox.ts                     # Exec, tmux, metrics
├── k8s-config.ts                      # KubeConfig loading, context resolution
├── k8s-network-policy.ts              # Manual NetworkPolicy CRUD
├── k8s-rbac.ts                        # ServiceAccount, Role, RoleBinding
├── k8s-security.ts                    # PodSecurityContext validation
├── k8s-audit.ts                       # Custom audit logging
├── k8s-warm-pool.ts                   # Manual warm pool controller
├── k8s-errors.ts                      # K8s error factory (from src/lib/errors/)
└── __tests__/
    ├── k8s-provider.test.ts           # Provider unit tests
    ├── k8s-security.test.ts           # Security validation tests
    ├── k8s-warm-pool.test.ts          # Warm pool unit tests
    └── k8s-tmux.integration.test.ts   # tmux integration tests

k8s/manifests/_archived/
├── network-policy.yaml                # Manual NetworkPolicy manifest
└── rbac.yaml                          # Manual RBAC manifest
```

### Why Archive Instead of Delete

1. **Reference material**: The Phase 1 exec stream implementation (`k8s-sandbox.ts` lines 89-162) and tmux session methods (lines 164-346) contain patterns reused in the SDK. Keeping them available makes it easy to verify correctness.
2. **Rollback safety**: If the CRD controller has issues in production, the archived files can be restored to their original locations within minutes (see [Rollback Plan](#10-rollback-plan)).
3. **Audit trail**: The `_archived/` directory makes it clear what was replaced and when, without relying on git history alone.

### When to Delete the Archive

Delete the `_archived/` directory after:
- Phase 2 has been running in production for at least 2 release cycles
- All E2E tests pass consistently with CRD sandboxes
- No rollback has been needed
- The team agrees the archived code has no remaining reference value

---

## 6. Import Path Updates

Files that import from archived Phase 1 paths must be updated. Here is the complete list of affected files, identified by searching the codebase:

### Direct Imports from Phase 1 Files

| File | Old Import | New Import |
|------|------------|------------|
| `src/lib/sandbox/index.ts` | `from './providers/k8s-provider.js'` | `from './providers/agent-sandbox-provider.js'` |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-audit.js'` | Remove (no longer exported) |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-config.js'` | Remove (use SDK directly) |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-network-policy.js'` | Remove (CRD handles this) |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-rbac.js'` | Remove (CRD handles this) |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-security.js'` | Remove (SDK handles this) |
| `src/lib/sandbox/index.ts` | `from './providers/k8s-warm-pool.js'` | Remove (CRD handles this) |
| `src/server/routes/sandbox.ts` | `from '../../lib/sandbox/providers/k8s-config.js'` | `from '@agentpane/agent-sandbox-sdk'` |

### Internal Phase 1 Imports (archived together, no action needed)

These imports exist within the archived files themselves. Since all files are moved together into `_archived/`, these relative imports would still resolve within that directory. However, the archived files are not imported by any active code, so no changes are needed.

| Importing File | Imports From |
|---------------|--------------|
| `k8s-provider.ts` | `k8s-config.js`, `k8s-sandbox.js`, `k8s-audit.js`, `k8s-rbac.js`, `k8s-security.js`, `k8s-network-policy.js`, `k8s-warm-pool.js` |
| `k8s-warm-pool.ts` | `k8s-config.js`, `k8s-audit.js`, `k8s-errors.js` |
| `k8s-rbac.ts` | `k8s-errors.js` |
| `k8s-config.ts` | `k8s-errors.js` |
| `k8s-security.ts` | `k8s-errors.js` |
| `k8s-network-policy.ts` | `k8s-errors.js`, `k8s-config.js` |
| `k8s-sandbox.ts` | `k8s-errors.js` |

---

## 7. Concept Mapping

This table maps every Phase 1 concept to its Phase 2 CRD equivalent. Use this when reading Phase 1 code and understanding what the CRD controller replaces.

| Phase 1 Concept | Phase 1 Code | Phase 2 CRD Equivalent |
|-----------------|-------------|----------------------|
| Pod creation | `coreApi.createNamespacedPod()` in `k8s-provider.ts` | `client.sandboxes.create(sandbox)` via SDK |
| Pod deletion | `coreApi.deleteNamespacedPod()` in `k8s-provider.ts` | `client.sandboxes.delete(name)` via SDK |
| Pod readiness polling | `waitForPodRunning()` polling loop in `k8s-provider.ts` | Watch-based `client.waitForReady(name)` via SDK |
| Pod exec | `k8s.Exec` + Writable streams in `k8s-sandbox.ts` | `client.exec(name, command)` via SDK |
| Exec streaming | PassThrough + V1Status parsing in `k8s-sandbox.ts` | `client.execStream(name, options)` via SDK |
| NetworkPolicy creation | `networkingApi.createNamespacedNetworkPolicy()` in `k8s-network-policy.ts` | SandboxTemplate `spec.networkPolicy` field |
| NetworkPolicy deletion | `networkingApi.deleteNamespacedNetworkPolicy()` in `k8s-network-policy.ts` | Automatic -- CRD controller manages lifecycle |
| NetworkPolicy update | `networkingApi.replaceNamespacedNetworkPolicy()` in `k8s-network-policy.ts` | Update the SandboxTemplate resource |
| RBAC setup | `createRbacManager()` in `k8s-rbac.ts` | Automatic -- CRD controller creates ServiceAccount, Role, RoleBinding |
| PVC creation | Manual PVC in `k8s-provider.ts` | Sandbox `spec.volumeClaimTemplates` |
| KubeConfig loading | `loadKubeConfig()` in `k8s-config.ts` | SDK `loadKubeConfig()` (reused pattern) |
| Context resolution | `resolveContext()` in `k8s-config.ts` | SDK `resolveContext()` (reused pattern) |
| Warm pool controller | `createWarmPoolController()` in `k8s-warm-pool.ts` | SandboxWarmPool CRD resource |
| Warm pool scaling | Manual polling + pod creation in `k8s-warm-pool.ts` | CRD controller with HPA-compatible scaling |
| Warm pool metrics | `WarmPoolMetrics` interface in `k8s-warm-pool.ts` | `kubectl get sandboxwarmpool` status fields |
| PSS validation | `createPodSecurityValidator()` in `k8s-security.ts` | SandboxBuilder defaults enforce restricted PSS |
| Security context | Manual `PodSecurityContext` assembly in `k8s-security.ts` | Builder defaults: `runAsNonRoot`, `drop: ALL`, `seccompProfile` |
| Audit logging | `K8sAuditLogger` in `k8s-audit.ts` | Standard K8s events + SDK provider event callbacks |
| Error handling | `K8sErrors` factory in `k8s-errors.ts` | `AgentSandboxError` class from SDK |
| Cluster info | `getClusterInfo()` in `k8s-config.ts` | SDK `getClusterInfo()` |
| Pause/Resume | Not supported | `client.sandboxes.pause(name)` / `resume(name)` (replicas=0/1) |
| Service FQDN | Not supported | Auto-generated: `<name>.<namespace>.svc.cluster.local` |
| Shutdown TTL | Not supported | Sandbox `spec.shutdownTime` + `spec.shutdownPolicy` |

---

## 8. API Surface Changes

### No Breaking Changes

The `SandboxProvider` and `Sandbox` interfaces in `src/lib/sandbox/providers/sandbox-provider.ts` remain unchanged. The `AgentSandboxProvider` is a drop-in replacement for `K8sProvider` -- both implement `EventEmittingSandboxProvider`. The `AgentSandboxInstance` is a drop-in replacement for `K8sSandbox` -- both implement `Sandbox`.

`ContainerAgentService` does not need to know which provider is in use. It calls `provider.create()`, `sandbox.exec()`, `sandbox.execStream()`, etc., through the interface.

### New API Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sandbox/k8s/controller` | Check CRD controller status (installed, version, health) |

This endpoint is used by the Settings UI "Test Connection" button.

### Settings Key Changes

| Setting Key | Change |
|-------------|--------|
| `sandbox.defaults.provider` | Value `'kubernetes'` still works -- no change |
| `sandbox.k8s.namespace` | Existing -- still used |
| `sandbox.k8s.kubeContext` | Existing -- still used |
| `sandbox.k8s.kubeConfigPath` | Existing -- still used |
| `sandbox.k8s.runtimeClassName` | **New** -- `'gvisor'`, `'kata'`, or empty |
| `sandbox.k8s.enableWarmPool` | **New** -- boolean |
| `sandbox.k8s.warmPoolSize` | **New** -- number (default: 3) |

### Type Addition

In `src/lib/sandbox/types.ts`, the `SandboxProvider` type already includes `'kubernetes'`:

```typescript
export type SandboxProvider = 'docker' | 'devcontainer' | 'kubernetes';
```

No change needed. The new provider uses the same `'kubernetes'` value.

---

## 9. Feature Comparison

| Feature | Phase 1 (Custom) | Phase 2 (CRD) |
|---------|-------------------|----------------|
| **Pod lifecycle** | Manual API calls (~800 LOC) | Declarative CRD resource |
| **Network policy** | Manual CRUD (~400 LOC) | SandboxTemplate `networkPolicy` field |
| **RBAC** | Manual setup (~500 LOC) | Controller-managed automatically |
| **Warm pool** | Manual polling (~1000 LOC) | SandboxWarmPool CRD resource |
| **Security validation** | Custom validator (~600 LOC) | Builder defaults + K8s admission controllers |
| **Audit logging** | Custom logger (~450 LOC) | Standard K8s events + provider callbacks |
| **Pause/Resume** | Not supported | `replicas=0/1` via SDK |
| **Service FQDN** | Not supported | Auto-generated per sandbox |
| **Shutdown TTL** | Not supported | `shutdownTime` + `shutdownPolicy` |
| **gVisor support** | RuntimeClassName field | RuntimeClassName field (same) |
| **Kata support** | RuntimeClassName field | RuntimeClassName field (same) |
| **Pod readiness** | Polling loop | Watch-based (event-driven) |
| **Error handling** | Custom factory functions | `AgentSandboxError` class |
| **Total K8s-specific LOC** | ~4,300 | ~600 (provider + instance) |
| **External dependencies** | `@kubernetes/client-node` directly | `@agentpane/agent-sandbox-sdk` (wraps `@kubernetes/client-node`) |

---

## 10. Rollback Plan

If Phase 2 causes issues in production, follow these steps to revert to Phase 1.

### Rollback Steps

**Estimated time**: 10-15 minutes.

1. **Restore archived source files:**

   ```bash
   # Restore K8s provider files
   mv src/lib/sandbox/providers/_archived/k8s-provider.ts    src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-sandbox.ts     src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-config.ts      src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-network-policy.ts src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-rbac.ts        src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-security.ts    src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-audit.ts       src/lib/sandbox/providers/
   mv src/lib/sandbox/providers/_archived/k8s-warm-pool.ts   src/lib/sandbox/providers/

   # Restore error file
   mv src/lib/sandbox/providers/_archived/k8s-errors.ts      src/lib/errors/

   # Restore test files
   mv src/lib/sandbox/providers/_archived/__tests__/k8s-provider.test.ts       src/lib/sandbox/providers/__tests__/
   mv src/lib/sandbox/providers/_archived/__tests__/k8s-security.test.ts       src/lib/sandbox/providers/__tests__/
   mv src/lib/sandbox/providers/_archived/__tests__/k8s-warm-pool.test.ts      src/lib/sandbox/providers/__tests__/
   mv src/lib/sandbox/providers/_archived/__tests__/k8s-tmux.integration.test.ts src/lib/sandbox/providers/__tests__/

   # Restore manifests
   mv k8s/manifests/_archived/network-policy.yaml  k8s/manifests/
   mv k8s/manifests/_archived/rbac.yaml            k8s/manifests/
   ```

2. **Revert `src/lib/sandbox/index.ts`:**

   Restore the Phase 1 export block (use `git checkout` for this file if easier):

   ```bash
   git checkout HEAD~1 -- src/lib/sandbox/index.ts
   ```

3. **Revert `src/server/api.ts`:**

   Remove the K8s CRD provider initialization block added in Step 3. The Docker-only path remains.

4. **Revert `src/server/routes/sandbox.ts`:**

   Restore the `k8s-config.js` import:

   ```bash
   git checkout HEAD~1 -- src/server/routes/sandbox.ts
   ```

5. **Revert Settings UI:**

   Restore the "Coming Soon" placeholder in `src/app/routes/settings/sandbox.tsx`:

   ```bash
   git checkout HEAD~1 -- src/app/routes/settings/sandbox.tsx
   ```

6. **Remove SDK workspace reference** (optional):

   If the SDK package reference in root `package.json` causes issues, remove it. The SDK package itself can stay in `packages/` without harm.

7. **Verify:**

   ```bash
   bun run build
   bun run test
   npm run dev
   ```

### What Rollback Does NOT Affect

- The SDK package in `packages/agent-sandbox-sdk/` can remain -- it has no effect on the application unless imported.
- The new CRD manifests (`agentpane-sandbox-template.yaml`, `agentpane-warm-pool.yaml`, `runtime-class-gvisor.yaml`) can remain in `k8s/manifests/` -- they are only applied to clusters explicitly.
- Any CRD resources created in the cluster (`Sandbox`, `SandboxTemplate`, `SandboxWarmPool`) can be cleaned up with `kubectl delete` but are not harmful if left in place.

---

## 11. Timeline Estimate

| Phase | Task | Effort | Notes |
|-------|------|--------|-------|
| 1 | SDK package (`packages/agent-sandbox-sdk/`) | Large | Types, Zod schemas, CRUD operations, exec, watch, builders, tests |
| 2 | Provider integration (`agent-sandbox-provider.ts`, `agent-sandbox-instance.ts`) | Medium | Two files implementing existing interfaces; already scaffolded |
| 3 | API + Settings wiring (`api.ts`, `sandbox.tsx`) | Small | Provider selection logic + UI fields |
| 4 | Minikube setup scripts + manifests | Small | Scripts + 3 new YAML files (already created) |
| 5 | E2E validation | Medium | Full workflow: task move, agent start, plan, execute, complete |
| 6 | Archive + cleanup | Small | File moves + import path updates + barrel export changes |

### Parallelization

- Steps 1 and 4 can be done in parallel (SDK development and minikube setup are independent).
- Steps 2 and 3 depend on Step 1 (the SDK must exist before the provider can import it).
- Step 5 depends on Steps 1-4 (all components must be in place for E2E).
- Step 6 depends on Step 5 (only archive after validation passes).

---

## 12. Verification Checklist

Use this checklist to confirm the migration is complete.

### Pre-Migration

- [ ] Phase 1 tests all pass: `bun run test -- --grep "K8s"`
- [ ] Docker provider tests still pass: `bun run test -- --grep "Docker"`
- [ ] Application starts cleanly: `npm run dev`

### Post-Migration

- [ ] SDK package builds: `cd packages/agent-sandbox-sdk && bun run build`
- [ ] SDK tests pass: `cd packages/agent-sandbox-sdk && bun test`
- [ ] Provider tests pass: `bun run test -- --grep "AgentSandboxProvider"`
- [ ] Docker provider still works (regression check): `bun run test -- --grep "Docker"`
- [ ] No imports reference archived paths: search for `k8s-provider.js`, `k8s-sandbox.js`, `k8s-config.js`, `k8s-errors.js` in active source files
- [ ] `src/lib/sandbox/index.ts` exports `AgentSandboxProvider` and `AgentSandboxInstance`
- [ ] `src/lib/sandbox/index.ts` does NOT export Phase 1 symbols (`K8sProvider`, `K8sAuditLogger`, etc.)
- [ ] Build succeeds: `bun run build`
- [ ] All tests pass: `bun run test`
- [ ] Application starts: `npm run dev`
- [ ] Settings UI shows K8s configuration (not "Coming Soon")
- [ ] "Test Connection" works with minikube running

### E2E Validation (minikube required)

- [ ] Minikube setup script runs: `./scripts/k8s-setup-minikube.sh`
- [ ] CRD controller is running: `kubectl get pods -n agent-sandbox-system`
- [ ] SandboxTemplate exists: `kubectl get sandboxtemplates -n agentpane-sandboxes`
- [ ] Task moved to "In Progress" creates a Sandbox CR: `kubectl get sandboxes -n agentpane-sandboxes`
- [ ] Agent execution completes successfully in CRD sandbox
- [ ] Sandbox is cleaned up after task completion
- [ ] Warm pool pre-warms expected number of sandboxes (if enabled)

### Rollback Readiness

- [ ] Archived files exist in `src/lib/sandbox/providers/_archived/`
- [ ] `_archived/README.md` explains why files are archived
- [ ] Rollback instructions have been tested (or at minimum reviewed)
