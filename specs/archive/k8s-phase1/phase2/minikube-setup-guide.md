# Minikube Setup Guide: Agent Sandbox CRD Validation Environment

> **Status**: Specification Complete
> **Created**: 2026-02-12
> **Parent**: [Phase 2 README](./README.md) -- Deliverable #5
> **Artifacts**: `scripts/k8s-setup-minikube.sh`, `scripts/k8s-teardown-minikube.sh`, `k8s/manifests/*.yaml`, `tests/e2e/k8s/`

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Minikube Setup Script](#2-minikube-setup-script)
3. [K8s Manifests](#3-k8s-manifests)
4. [E2E Test Specification](#4-e2e-test-specification)
5. [Teardown Script](#5-teardown-script)
6. [CI/CD Integration Notes](#6-cicd-integration-notes)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

### Required Tools

| Tool | Minimum Version | Install |
|------|-----------------|---------|
| minikube | v1.32.0+ | `brew install minikube` or [minikube.sigs.k8s.io](https://minikube.sigs.k8s.io/docs/start/) |
| kubectl | v1.28.0+ | `brew install kubectl` or ships with minikube (`minikube kubectl`) |
| Docker or containerd | Docker 24+ / containerd 1.7+ | `brew install --cask docker` or system containerd |
| Helm | v3.14+ (optional) | `brew install helm` |
| Bun | v1.3.10+ | `curl -fsSL https://bun.sh/install \| bash` |

### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU cores | 4 | 6+ |
| RAM | 8 GB available for minikube | 12 GB+ |
| Disk | 20 GB free | 40 GB+ |
| OS | macOS 12+, Linux 5.10+, Windows 10+ (WSL2) | macOS 13+ or Ubuntu 22.04+ |

### Verify Prerequisites

```bash
# Run this before proceeding -- all four commands must succeed
minikube version    # minikube version: v1.32.x
kubectl version --client --short 2>/dev/null || kubectl version --client
docker version      # or: containerd --version
bun --version       # 1.3.10
```

### Kernel Requirements for gVisor

gVisor (`runsc`) requires:
- Linux kernel 4.15+ (KVM-based) or 5.10+ (recommended)
- On macOS, minikube uses a HyperKit/QEMU VM, so the host kernel version does not matter -- the VM kernel handles it
- On Windows WSL2, kernel 5.10+ is standard

---

## 2. Minikube Setup Script

**File**: `scripts/k8s-setup-minikube.sh`

This script is idempotent -- it can be re-run safely. It detects an already-running minikube and skips accordingly.

```bash
#!/bin/bash
set -euo pipefail

# ============================================================================
# AgentPane K8s Setup: Minikube + Agent Sandbox CRD
# ============================================================================
#
# Usage:
#   ./scripts/k8s-setup-minikube.sh
#
# Environment variables:
#   AGENT_SANDBOX_VERSION  - CRD controller version (default: v0.1.0)
#   MINIKUBE_CPUS          - CPU cores for minikube (default: 4)
#   MINIKUBE_MEMORY        - Memory in MB for minikube (default: 8192)
#   SKIP_GVISOR            - Set to "true" to skip gVisor setup (default: false)
#
# Prerequisites:
#   - minikube installed
#   - kubectl installed
#   - Docker or containerd runtime available
# ============================================================================

# --- Colors ----------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}=== Step $1: $2 ===${NC}"; }

# --- Configuration ---------------------------------------------------------

VERSION="${AGENT_SANDBOX_VERSION:-v0.1.0}"
CPUS="${MINIKUBE_CPUS:-4}"
MEMORY="${MINIKUBE_MEMORY:-8192}"
SKIP_GVISOR="${SKIP_GVISOR:-false}"
NAMESPACE="agentpane-sandboxes"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="${SCRIPT_DIR}/../k8s/manifests"

echo -e "${BOLD}=== AgentPane K8s Setup: Minikube + Agent Sandbox CRD ===${NC}"
echo ""
echo "  Controller version : ${VERSION}"
echo "  minikube CPUs      : ${CPUS}"
echo "  minikube memory    : ${MEMORY}MB"
echo "  gVisor             : $([ "${SKIP_GVISOR}" = "true" ] && echo "SKIPPED" || echo "enabled")"
echo "  Namespace          : ${NAMESPACE}"
echo ""

# --- Prerequisite checks ---------------------------------------------------

command -v minikube >/dev/null 2>&1 || { log_error "minikube is not installed. See https://minikube.sigs.k8s.io/docs/start/"; exit 1; }
command -v kubectl  >/dev/null 2>&1 || { log_error "kubectl is not installed. See https://kubernetes.io/docs/tasks/tools/"; exit 1; }

# --- Step 1: Start minikube ------------------------------------------------

log_step "1/7" "Start minikube with containerd runtime"

if minikube status --format='{{.Host}}' 2>/dev/null | grep -q "Running"; then
  log_warn "minikube is already running -- skipping start"
  log_info "Current profile: $(minikube profile)"
  log_info "Kubernetes version: $(minikube kubectl -- version --client --short 2>/dev/null || echo 'unknown')"
else
  log_info "Starting minikube (containerd runtime, ${CPUS} CPUs, ${MEMORY}MB RAM)..."
  minikube start \
    --container-runtime=containerd \
    --cpus="${CPUS}" \
    --memory="${MEMORY}" \
    --driver=docker \
    --addons=default-storageclass,storage-provisioner
  log_ok "minikube started"
fi

# --- Step 2: Enable gVisor addon -------------------------------------------

log_step "2/7" "Enable gVisor addon"

if [ "${SKIP_GVISOR}" = "true" ]; then
  log_warn "Skipping gVisor (SKIP_GVISOR=true). Sandboxes will run without gVisor isolation."
else
  log_info "Enabling gVisor addon..."
  if minikube addons enable gvisor 2>/dev/null; then
    log_info "Waiting for gVisor DaemonSet to become ready..."
    # The gVisor addon creates a DaemonSet in the kube-system or gvisor namespace
    # The exact namespace varies by minikube version
    if kubectl rollout status daemonset/gvisor -n gvisor --timeout=120s 2>/dev/null; then
      log_ok "gVisor DaemonSet is ready"
    elif kubectl rollout status daemonset/gvisor -n kube-system --timeout=120s 2>/dev/null; then
      log_ok "gVisor DaemonSet is ready (kube-system)"
    else
      log_warn "gVisor DaemonSet rollout status check timed out -- continuing anyway"
    fi
  else
    log_warn "gVisor addon could not be enabled (may already be active or unsupported on this driver)"
    log_warn "To verify manually: minikube addons list | grep gvisor"
  fi
fi

# --- Step 3: Install Agent Sandbox controller + CRDs -----------------------

log_step "3/7" "Install Agent Sandbox controller ${VERSION}"

log_info "Applying core CRD manifest..."
if kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml" 2>/dev/null; then
  log_ok "Core manifest applied"
else
  log_warn "Failed to apply manifest.yaml from release ${VERSION}. Trying latest from main branch..."
  kubectl apply -f "https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/main/config/crd/bases/agents.x-k8s.io_sandboxes.yaml" || {
    log_error "Could not install core Sandbox CRD. Check your internet connection and the release version."
    exit 1
  }
fi

log_info "Applying extension CRDs..."
if kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml" 2>/dev/null; then
  log_ok "Extension CRDs applied"
else
  log_warn "Extensions manifest not found at release ${VERSION} -- applying individual CRDs from main..."
  for crd in sandboxtemplates sandboxclaims sandboxwarmpools; do
    if kubectl apply -f "https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/main/config/crd/bases/extensions.agents.x-k8s.io_${crd}.yaml" 2>/dev/null; then
      log_ok "CRD extensions.agents.x-k8s.io/${crd} applied"
    else
      log_warn "Extension CRD ${crd} not available (optional)"
    fi
  done
fi

# --- Step 4: Wait for controller -------------------------------------------

log_step "4/7" "Wait for controller deployment"

log_info "Checking for controller deployment in agent-sandbox-system namespace..."
if kubectl get namespace agent-sandbox-system >/dev/null 2>&1; then
  if kubectl wait --for=condition=available deployment/agent-sandbox-controller-manager \
    -n agent-sandbox-system --timeout=120s 2>/dev/null; then
    log_ok "Controller is ready"
  else
    log_warn "Controller deployment not available within 120s"
    log_warn "CRDs are installed but the controller may need manual intervention"
    log_info "Debug: kubectl get pods -n agent-sandbox-system"
  fi
else
  log_warn "agent-sandbox-system namespace not found -- controller may not be packaged in this release"
  log_warn "CRDs can still be used for manifest-driven sandbox management"
fi

# --- Step 5: Create namespace ----------------------------------------------

log_step "5/7" "Create agentpane-sandboxes namespace"

kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "${NAMESPACE}" \
  agentpane.io/managed=true \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest \
  --overwrite
log_ok "Namespace ${NAMESPACE} created with restricted pod security"

# --- Step 6: Apply K8s manifests -------------------------------------------

log_step "6/7" "Apply K8s manifests"

if [ ! -d "${MANIFESTS_DIR}" ]; then
  log_error "Manifests directory not found at ${MANIFESTS_DIR}"
  log_error "Expected location: k8s/manifests/ relative to the project root"
  exit 1
fi

log_info "Applying RuntimeClass (gVisor)..."
kubectl apply -f "${MANIFESTS_DIR}/runtime-class-gvisor.yaml"
log_ok "RuntimeClass 'gvisor' applied"

log_info "Applying SandboxTemplate..."
kubectl apply -f "${MANIFESTS_DIR}/agentpane-sandbox-template.yaml"
log_ok "SandboxTemplate 'agentpane-default' applied"

log_info "Applying NetworkPolicy..."
kubectl apply -f "${MANIFESTS_DIR}/agentpane-network-policy.yaml"
log_ok "NetworkPolicy 'agentpane-sandbox-default' applied"

log_info "Applying SandboxWarmPool..."
if kubectl apply -f "${MANIFESTS_DIR}/agentpane-warm-pool.yaml" 2>/dev/null; then
  log_ok "SandboxWarmPool 'agentpane-warm-pool' applied (3 replicas)"
else
  log_warn "SandboxWarmPool manifest skipped (SandboxWarmPool CRD may not be available)"
fi

# Apply Phase 1 RBAC and limit-range if they exist
if [ -f "${MANIFESTS_DIR}/rbac.yaml" ]; then
  kubectl apply -f "${MANIFESTS_DIR}/rbac.yaml"
  log_ok "RBAC manifests applied"
fi

if [ -f "${MANIFESTS_DIR}/limit-range.yaml" ]; then
  kubectl apply -f "${MANIFESTS_DIR}/limit-range.yaml"
  log_ok "LimitRange applied"
fi

# --- Step 7: Verify CRDs ---------------------------------------------------

log_step "7/7" "Verify CRD installation"

CRDS_OK=true
echo ""

# Core CRD (required)
if kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1; then
  log_ok "sandboxes.agents.x-k8s.io"
else
  log_error "sandboxes.agents.x-k8s.io NOT FOUND"
  CRDS_OK=false
fi

# Extension CRDs (optional but expected)
for crd in \
  sandboxtemplates.extensions.agents.x-k8s.io \
  sandboxclaims.extensions.agents.x-k8s.io \
  sandboxwarmpools.extensions.agents.x-k8s.io; do
  if kubectl get crd "${crd}" >/dev/null 2>&1; then
    log_ok "${crd}"
  else
    log_warn "${crd} not found (optional)"
  fi
done

# Verify resources in namespace
echo ""
log_info "Resources in ${NAMESPACE}:"
echo ""
kubectl get sandboxtemplates,networkpolicies -n "${NAMESPACE}" 2>/dev/null || true
echo ""

# RuntimeClass check
if kubectl get runtimeclass gvisor >/dev/null 2>&1; then
  log_ok "RuntimeClass 'gvisor' exists"
else
  log_warn "RuntimeClass 'gvisor' not found"
fi

# --- Summary ----------------------------------------------------------------

echo ""
echo "============================================================================"
if [ "${CRDS_OK}" = true ]; then
  echo -e "  ${GREEN}${BOLD}Setup complete!${NC} Agent Sandbox CRDs are ready."
else
  echo -e "  ${RED}${BOLD}Setup incomplete${NC} -- some required CRDs are missing."
  echo "  Check the errors above and re-run."
  exit 1
fi
echo ""
echo "  Context   : $(kubectl config current-context)"
echo "  Namespace : ${NAMESPACE}"
echo ""
echo "  Quick checks:"
echo "    kubectl get sandboxes -n ${NAMESPACE}"
echo "    kubectl get sandboxtemplates -n ${NAMESPACE}"
echo "    kubectl get sandboxwarmpools -n ${NAMESPACE}"
echo ""
echo "  Teardown:"
echo "    ./scripts/k8s-teardown-minikube.sh"
echo "============================================================================"
```

### Making It Executable

```bash
chmod +x scripts/k8s-setup-minikube.sh
```

### Running the Setup

```bash
# Default configuration
./scripts/k8s-setup-minikube.sh

# Custom configuration
MINIKUBE_CPUS=6 MINIKUBE_MEMORY=12288 ./scripts/k8s-setup-minikube.sh

# Skip gVisor (useful in CI or environments where it is unsupported)
SKIP_GVISOR=true ./scripts/k8s-setup-minikube.sh

# Use a specific Agent Sandbox controller version
AGENT_SANDBOX_VERSION=v0.2.0 ./scripts/k8s-setup-minikube.sh
```

---

## 3. K8s Manifests

All manifests live in `k8s/manifests/`. They are applied by the setup script and can also be applied manually with `kubectl apply -f k8s/manifests/<file>.yaml`.

### 3.1 RuntimeClass: gVisor

**File**: `k8s/manifests/runtime-class-gvisor.yaml`

Defines the `gvisor` RuntimeClass that maps to the `runsc` container handler. The `scheduling` block ensures pods requesting this RuntimeClass only land on nodes with gVisor installed.

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
scheduling:
  nodeSelector:
    sandbox.gvisor.dev/runtime: "true"
  tolerations:
    - key: "sandbox.gvisor.dev/runtime"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
```

**Notes**:
- The `handler: runsc` maps to the gVisor runtime binary
- `scheduling.nodeSelector` ensures pods are scheduled only on gVisor-capable nodes
- In minikube, the gVisor addon automatically labels the node; no manual labeling is needed
- In production clusters, you must label nodes: `kubectl label node <name> sandbox.gvisor.dev/runtime=true`

### 3.2 SandboxTemplate

**File**: `k8s/manifests/agentpane-sandbox-template.yaml`

Defines the pod template that all AgentPane sandboxes are created from. This is the CRD equivalent of the manual pod spec from Phase 1.

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: agentpane-default
  namespace: agentpane-sandboxes
  labels:
    agentpane.io/managed: "true"
spec:
  podTemplate:
    metadata:
      labels:
        agentpane.io/sandbox: "true"
    spec:
      containers:
        - name: agent-runner
          image: srlynch1/agent-sandbox:latest
          workingDir: /workspace
          command: ["tail", "-f", "/dev/null"]
          resources:
            limits:
              cpu: "2"
              memory: 4Gi
            requests:
              cpu: "1"
              memory: 2Gi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      restartPolicy: Never
      runtimeClassName: gvisor
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      automountServiceAccountToken: false
  networkPolicy:
    egress:
      - ports:
          - port: 443
            protocol: TCP
          - port: 80
            protocol: TCP
        to:
          - ipBlock:
              cidr: 0.0.0.0/0
              except:
                - 10.0.0.0/8
                - 172.16.0.0/12
                - 192.168.0.0/16
    ingress: []
```

**Security properties**:

| Property | Value | Purpose |
|----------|-------|---------|
| `runAsNonRoot` | `true` | Container must not run as UID 0 |
| `runAsUser` | `1000` | Runs as the `node` user (matching the agent-sandbox image) |
| `runAsGroup` / `fsGroup` | `1000` | Consistent file ownership |
| `allowPrivilegeEscalation` | `false` | Prevents `setuid`/`setgid` escalation |
| `capabilities.drop` | `["ALL"]` | Drops all Linux capabilities |
| `seccompProfile` | `RuntimeDefault` | Applies the default seccomp filter |
| `automountServiceAccountToken` | `false` | No K8s API access from inside the sandbox |
| `restartPolicy` | `Never` | Sandboxes are one-shot; no automatic restart |
| `runtimeClassName` | `gvisor` | Runs under gVisor for kernel-level isolation |

**Resource allocation**:

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 1 core | 2 cores |
| Memory | 2 GiB | 4 GiB |

**Notes on the `command` field**:
- `tail -f /dev/null` keeps the container alive without consuming CPU
- The actual agent work is performed via `kubectl exec` / SDK `exec()` into the running container
- This is the same pattern used by the Docker provider (`docker exec`)

### 3.3 SandboxWarmPool

**File**: `k8s/manifests/agentpane-warm-pool.yaml`

Pre-warms 3 sandbox pods for faster agent startup. The warm pool controller creates pods from the referenced template and keeps them in a "ready" state.

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: agentpane-warm-pool
  namespace: agentpane-sandboxes
  labels:
    agentpane.io/managed: "true"
spec:
  replicas: 3
  sandboxTemplateRef:
    name: agentpane-default
```

**How warm pools work**:
1. The controller creates `replicas` sandbox pods from the referenced template
2. Pods sit idle, already pulled and running
3. When a sandbox is claimed (via `SandboxClaim`), one warm pod is "adopted" -- no cold start
4. The controller replenishes the pool back to `replicas`
5. Target: **<5 seconds** from task-start to agent-running (vs ~30s cold start)

**Scaling the pool**:
```bash
# Increase warm pool size
kubectl patch sandboxwarmpool agentpane-warm-pool -n agentpane-sandboxes \
  --type merge -p '{"spec":{"replicas":5}}'

# Scale to zero (disable warm pool)
kubectl patch sandboxwarmpool agentpane-warm-pool -n agentpane-sandboxes \
  --type merge -p '{"spec":{"replicas":0}}'
```

### 3.4 NetworkPolicy

**File**: `k8s/manifests/agentpane-network-policy.yaml`

Defines the default network isolation for all sandbox pods in the namespace. This is an additional namespace-level policy that works alongside the per-sandbox policy in the `SandboxTemplate.spec.networkPolicy`.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agentpane-sandbox-default
  namespace: agentpane-sandboxes
  labels:
    agentpane.io/managed: "true"
spec:
  podSelector:
    matchLabels:
      agentpane.io/sandbox: "true"
  policyTypes:
    - Ingress
    - Egress
  # Default deny all ingress -- sandboxes should never receive inbound traffic
  ingress: []
  egress:
    # Rule 1: Allow DNS resolution (UDP + TCP port 53)
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
      to: []
    # Rule 2: Allow HTTPS and HTTP to public internet (exclude private ranges)
    - ports:
        - port: 443
          protocol: TCP
        - port: 80
          protocol: TCP
      to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8       # RFC 1918 Class A
              - 172.16.0.0/12    # RFC 1918 Class B
              - 192.168.0.0/16   # RFC 1918 Class C
```

**Policy breakdown**:

| Direction | Rule | Purpose |
|-----------|------|---------|
| Ingress | Deny all | Sandboxes are not web servers; nothing should connect to them |
| Egress | DNS (port 53 UDP/TCP) | Required for domain resolution (`api.anthropic.com`, npm registry, etc.) |
| Egress | HTTPS (port 443 TCP) | Agent needs to call the Anthropic API and pull packages |
| Egress | HTTP (port 80 TCP) | Some package registries and redirects use HTTP |
| Egress | Block private ranges | Prevents lateral movement within the cluster/VPC |

**Important**: Both this NetworkPolicy and the `SandboxTemplate.spec.networkPolicy` are enforced. Kubernetes NetworkPolicies are additive for allow rules, but the most restrictive intersection applies. Having both ensures defense-in-depth.

---

## 4. E2E Test Specification

### Location

```
tests/e2e/k8s/
  agent-sandbox-e2e.test.ts    # All E2E test cases
  helpers.ts                    # Shared test utilities
```

### Gating

E2E tests require a running minikube cluster with the Agent Sandbox controller installed. They are gated by the `K8S_E2E` environment variable and will be skipped entirely if it is not set to `true`.

```bash
# Run the E2E tests
K8S_E2E=true bun run vitest run tests/e2e/k8s/

# Or via the npm script (to be added to package.json)
K8S_E2E=true bun run test:k8s-e2e
```

### Test Helpers

**File**: `tests/e2e/k8s/helpers.ts`

```typescript
import { describe, beforeAll, afterAll, it, expect } from 'vitest';

// Skip entire suite if K8S_E2E is not set
export function describeK8s(name: string, fn: () => void) {
  const shouldRun = process.env.K8S_E2E === 'true';
  return (shouldRun ? describe : describe.skip)(name, fn);
}

// Namespace for test isolation (unique per run)
export function testNamespace(): string {
  return `agentpane-e2e-${Date.now()}`;
}

// Wait for a condition with polling
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

// Check if a RuntimeClass exists (for gVisor skip logic)
export async function hasRuntimeClass(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['kubectl', 'get', 'runtimeclass', name], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// kubectl helper that returns stdout
export async function kubectl(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`kubectl ${args.join(' ')} failed (exit ${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}
```

### Test Cases

**File**: `tests/e2e/k8s/agent-sandbox-e2e.test.ts`

```typescript
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { describeK8s, testNamespace, waitFor, hasRuntimeClass, kubectl } from './helpers';

// Import the SDK client (from packages/agent-sandbox-sdk)
// import { AgentSandboxClient } from '@agentpane/agent-sandbox-sdk';

describeK8s('Agent Sandbox CRD E2E', () => {
  const ns = testNamespace();
  let gvisorAvailable = false;

  beforeAll(async () => {
    // Create test namespace
    await kubectl('create', 'namespace', ns);
    await kubectl('label', 'namespace', ns, 'agentpane.io/managed=true', '--overwrite');

    // Check if gVisor RuntimeClass is available
    gvisorAvailable = await hasRuntimeClass('gvisor');

    // Apply the SandboxTemplate into test namespace
    // (modify the namespace in the manifest or use kubectl apply with --namespace)
    await kubectl(
      'apply', '-n', ns, '-f', 'k8s/manifests/agentpane-sandbox-template.yaml',
    );
    await kubectl(
      'apply', '-n', ns, '-f', 'k8s/manifests/agentpane-network-policy.yaml',
    );
  }, 60_000);

  afterAll(async () => {
    // Clean up test namespace (cascading delete of all resources)
    await kubectl('delete', 'namespace', ns, '--wait=false').catch(() => {});
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 1: Sandbox CRUD
  // ---------------------------------------------------------------------------
  describe('Sandbox CRUD', () => {
    it('should create a sandbox and verify the pod is running', async () => {
      // Create a Sandbox CR
      const sandboxName = `e2e-crud-${Date.now()}`;
      const manifest = JSON.stringify({
        apiVersion: 'agents.x-k8s.io/v1alpha1',
        kind: 'Sandbox',
        metadata: { name: sandboxName, namespace: ns },
        spec: {
          sandboxTemplateRef: { name: 'agentpane-default' },
        },
      });

      // Apply via stdin
      const proc = Bun.spawn(['kubectl', 'apply', '-n', ns, '-f', '-'], {
        stdin: new TextEncoder().encode(manifest),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      // Wait for the sandbox pod to be running
      await waitFor(async () => {
        const output = await kubectl(
          'get', 'sandbox', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return output === 'Running';
      }, 60_000);

      // Verify the underlying pod exists
      const pods = await kubectl(
        'get', 'pods', '-n', ns,
        '-l', `agentpane.io/sandbox=true`,
        '-o', 'jsonpath={.items[*].metadata.name}',
      );
      expect(pods).toContain(sandboxName);

      // Delete the sandbox
      await kubectl('delete', 'sandbox', sandboxName, '-n', ns);

      // Verify the pod is gone
      await waitFor(async () => {
        try {
          await kubectl('get', 'sandbox', sandboxName, '-n', ns);
          return false;
        } catch {
          return true; // NotFound means it was deleted
        }
      }, 30_000);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Exec (buffered)
  // ---------------------------------------------------------------------------
  describe('Exec buffered', () => {
    it('should exec a command and capture stdout', async () => {
      const sandboxName = `e2e-exec-${Date.now()}`;

      // Create sandbox (using kubectl for simplicity)
      await kubectl(
        'apply', '-n', ns, '-f', '-',
        // ... same pattern as above
      ).catch(() => {});

      // For this test, create a simple pod directly
      await kubectl(
        'run', sandboxName, '-n', ns,
        '--image=alpine:3.19',
        '--restart=Never',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 60_000);

      // Exec into the pod
      const output = await kubectl(
        'exec', sandboxName, '-n', ns, '--', 'echo', 'hello',
      );
      expect(output).toBe('hello');

      // Cleanup
      await kubectl('delete', 'pod', sandboxName, '-n', ns, '--wait=false');
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Exec streaming
  // ---------------------------------------------------------------------------
  describe('Exec streaming', () => {
    it('should stream stdout from a long-running command', async () => {
      const sandboxName = `e2e-stream-${Date.now()}`;

      await kubectl(
        'run', sandboxName, '-n', ns,
        '--image=alpine:3.19',
        '--restart=Never',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 60_000);

      // Run a command that produces multiple lines
      const output = await kubectl(
        'exec', sandboxName, '-n', ns, '--',
        'sh', '-c', 'for i in 1 2 3 4 5; do echo "line-$i"; sleep 0.1; done',
      );

      const lines = output.split('\n').filter(Boolean);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('line-1');
      expect(lines[4]).toBe('line-5');

      await kubectl('delete', 'pod', sandboxName, '-n', ns, '--wait=false');
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Agent runner
  // ---------------------------------------------------------------------------
  describe('Agent runner', () => {
    it('should run the agent-runner image and emit JSON-line events', async () => {
      const sandboxName = `e2e-agent-${Date.now()}`;

      await kubectl(
        'run', sandboxName, '-n', ns,
        '--image=srlynch1/agent-sandbox:latest',
        '--restart=Never',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 120_000); // Image pull may take longer

      // Verify the agent-runner binary is present
      const whichOutput = await kubectl(
        'exec', sandboxName, '-n', ns, '--',
        'which', 'node',
      ).catch(() => 'not-found');
      expect(whichOutput).not.toBe('not-found');

      // Run a simple script that emits JSON lines (simulating agent events)
      const output = await kubectl(
        'exec', sandboxName, '-n', ns, '--',
        'sh', '-c', 'echo \'{"type":"agent:started","timestamp":"2026-01-01T00:00:00Z"}\'',
      );
      const event = JSON.parse(output);
      expect(event.type).toBe('agent:started');

      await kubectl('delete', 'pod', sandboxName, '-n', ns, '--wait=false');
    }, 180_000);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Warm pool
  // ---------------------------------------------------------------------------
  describe('Warm pool', () => {
    it('should claim a pre-warmed sandbox in <5s', async () => {
      // Apply warm pool to test namespace
      const warmPoolManifest = JSON.stringify({
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxWarmPool',
        metadata: { name: 'e2e-warm-pool', namespace: ns },
        spec: {
          replicas: 2,
          sandboxTemplateRef: { name: 'agentpane-default' },
        },
      });

      const proc = Bun.spawn(['kubectl', 'apply', '-n', ns, '-f', '-'], {
        stdin: new TextEncoder().encode(warmPoolManifest),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      // Wait for warm pods to be ready
      await waitFor(async () => {
        const output = await kubectl(
          'get', 'pods', '-n', ns,
          '-l', 'agentpane.io/sandbox=true',
          '-o', 'jsonpath={.items[?(@.status.phase=="Running")].metadata.name}',
        );
        const runningPods = output.split(' ').filter(Boolean);
        return runningPods.length >= 2;
      }, 120_000);

      // Claim a sandbox from the warm pool
      const claimStart = Date.now();
      const claimManifest = JSON.stringify({
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxClaim',
        metadata: { name: `e2e-claim-${Date.now()}`, namespace: ns },
        spec: {
          warmPoolRef: { name: 'e2e-warm-pool' },
        },
      });

      const claimProc = Bun.spawn(['kubectl', 'apply', '-n', ns, '-f', '-'], {
        stdin: new TextEncoder().encode(claimManifest),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await claimProc.exited;
      const claimDuration = Date.now() - claimStart;

      // Warm pool claim should be nearly instant (<5s)
      expect(claimDuration).toBeLessThan(5_000);

      // Cleanup
      await kubectl('delete', 'sandboxwarmpool', 'e2e-warm-pool', '-n', ns, '--wait=false').catch(() => {});
    }, 180_000);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Sandbox shutdown (TTL)
  // ---------------------------------------------------------------------------
  describe('Sandbox shutdown', () => {
    it('should set TTL via shutdownAfter annotation', async () => {
      const sandboxName = `e2e-ttl-${Date.now()}`;

      const manifest = JSON.stringify({
        apiVersion: 'agents.x-k8s.io/v1alpha1',
        kind: 'Sandbox',
        metadata: {
          name: sandboxName,
          namespace: ns,
          annotations: {
            'agents.x-k8s.io/shutdown-after': '5m',
          },
        },
        spec: {
          sandboxTemplateRef: { name: 'agentpane-default' },
        },
      });

      const proc = Bun.spawn(['kubectl', 'apply', '-n', ns, '-f', '-'], {
        stdin: new TextEncoder().encode(manifest),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      // Verify the annotation is set
      const annotations = await kubectl(
        'get', 'sandbox', sandboxName, '-n', ns,
        '-o', 'jsonpath={.metadata.annotations}',
      );
      expect(annotations).toContain('shutdown-after');
      expect(annotations).toContain('5m');

      await kubectl('delete', 'sandbox', sandboxName, '-n', ns, '--wait=false');
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Pause/Resume (replicas scaling)
  // ---------------------------------------------------------------------------
  describe('Pause/Resume', () => {
    it('should pause a sandbox by scaling to 0 and resume by scaling to 1', async () => {
      const sandboxName = `e2e-pause-${Date.now()}`;

      // Create sandbox
      await kubectl(
        'run', sandboxName, '-n', ns,
        '--image=alpine:3.19',
        '--restart=Never',
        '--labels=agentpane.io/sandbox=true',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 60_000);

      // Pause: delete the pod (simulating replicas=0 for non-CRD pods)
      await kubectl('delete', 'pod', sandboxName, '-n', ns, '--wait=true');

      // Verify pod is gone
      await waitFor(async () => {
        try {
          await kubectl('get', 'pod', sandboxName, '-n', ns);
          return false;
        } catch {
          return true;
        }
      }, 30_000);

      // Resume: recreate the pod (simulating replicas=1)
      await kubectl(
        'run', sandboxName, '-n', ns,
        '--image=alpine:3.19',
        '--restart=Never',
        '--labels=agentpane.io/sandbox=true',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', sandboxName, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 60_000);

      await kubectl('delete', 'pod', sandboxName, '-n', ns, '--wait=false');
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Provider health check
  // ---------------------------------------------------------------------------
  describe('Provider health check', () => {
    it('should verify cluster connectivity and CRDs', async () => {
      // Verify cluster is reachable
      const version = await kubectl('version', '--client=false', '-o', 'json');
      const versionObj = JSON.parse(version);
      expect(versionObj.serverVersion).toBeDefined();
      expect(versionObj.serverVersion.major).toBeDefined();

      // Verify CRDs exist
      const crds = await kubectl('get', 'crd', '-o', 'jsonpath={.items[*].metadata.name}');
      expect(crds).toContain('sandboxes.agents.x-k8s.io');

      // Verify namespace exists
      const namespaces = await kubectl('get', 'namespace', '-o', 'jsonpath={.items[*].metadata.name}');
      expect(namespaces).toContain('agentpane-sandboxes');

      // Verify RuntimeClass (may not exist if gVisor not installed)
      if (gvisorAvailable) {
        const rtc = await kubectl('get', 'runtimeclass', 'gvisor', '-o', 'jsonpath={.handler}');
        expect(rtc).toBe('runsc');
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Template with network policy
  // ---------------------------------------------------------------------------
  describe('Template with network policy', () => {
    it('should apply network policy from SandboxTemplate', async () => {
      // Verify the NetworkPolicy was created in the namespace
      const policies = await kubectl(
        'get', 'networkpolicy', '-n', ns,
        '-o', 'jsonpath={.items[*].metadata.name}',
      );
      expect(policies).toContain('agentpane-sandbox-default');

      // Verify policy spec: default deny ingress
      const ingress = await kubectl(
        'get', 'networkpolicy', 'agentpane-sandbox-default', '-n', ns,
        '-o', 'jsonpath={.spec.ingress}',
      );
      expect(ingress).toBe('[]');

      // Verify policy spec: has egress rules
      const policyTypes = await kubectl(
        'get', 'networkpolicy', 'agentpane-sandbox-default', '-n', ns,
        '-o', 'jsonpath={.spec.policyTypes}',
      );
      expect(policyTypes).toContain('Egress');
      expect(policyTypes).toContain('Ingress');

      // Verify DNS egress is allowed
      const egressPorts = await kubectl(
        'get', 'networkpolicy', 'agentpane-sandbox-default', '-n', ns,
        '-o', 'jsonpath={.spec.egress[0].ports[0].port}',
      );
      expect(egressPorts).toBe('53');

      // Create a pod and verify it cannot reach internal services
      const testPod = `e2e-netpol-${Date.now()}`;
      await kubectl(
        'run', testPod, '-n', ns,
        '--image=alpine:3.19',
        '--restart=Never',
        '--labels=agentpane.io/sandbox=true',
        '--command', '--', 'tail', '-f', '/dev/null',
      );

      await waitFor(async () => {
        const phase = await kubectl(
          'get', 'pod', testPod, '-n', ns,
          '-o', 'jsonpath={.status.phase}',
        );
        return phase === 'Running';
      }, 60_000);

      // Verify DNS works (should succeed)
      const dnsResult = await kubectl(
        'exec', testPod, '-n', ns, '--',
        'nslookup', 'api.anthropic.com',
      ).catch(() => 'dns-failed');
      // DNS should work -- the query itself may fail but should not timeout
      // (depending on network, the domain may or may not resolve)
      expect(dnsResult).not.toBe('dns-failed');

      await kubectl('delete', 'pod', testPod, '-n', ns, '--wait=false');
    }, 120_000);
  });
});
```

### package.json Script

Add the following to the root `package.json`:

```json
{
  "scripts": {
    "test:k8s-e2e": "vitest run tests/e2e/k8s/"
  }
}
```

### Running Tests

```bash
# Full suite (requires minikube + controller running)
K8S_E2E=true bun run vitest run tests/e2e/k8s/

# Single test file
K8S_E2E=true bun run vitest run tests/e2e/k8s/agent-sandbox-e2e.test.ts

# With verbose output
K8S_E2E=true bun run vitest run tests/e2e/k8s/ --reporter=verbose

# Skip if K8S_E2E is not set (tests are no-ops)
bun run vitest run tests/e2e/k8s/
# => All tests skipped
```

---

## 5. Teardown Script

**File**: `scripts/k8s-teardown-minikube.sh`

Cleans up all AgentPane resources and optionally stops minikube.

```bash
#!/bin/bash
set -euo pipefail

# ============================================================================
# AgentPane K8s Teardown: Clean up minikube environment
# ============================================================================
#
# Usage:
#   ./scripts/k8s-teardown-minikube.sh              # Clean resources only
#   ./scripts/k8s-teardown-minikube.sh --stop        # Clean + stop minikube
#   ./scripts/k8s-teardown-minikube.sh --delete      # Clean + delete minikube VM
#
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

NAMESPACE="agentpane-sandboxes"
STOP_MINIKUBE=false
DELETE_MINIKUBE=false

# Parse arguments
for arg in "$@"; do
  case "${arg}" in
    --stop)   STOP_MINIKUBE=true ;;
    --delete) DELETE_MINIKUBE=true ;;
    *)        log_error "Unknown argument: ${arg}"; exit 1 ;;
  esac
done

echo -e "${BOLD}=== AgentPane K8s Teardown ===${NC}"
echo ""

# --- Step 1: Delete all sandboxes ------------------------------------------

log_info "Deleting all Sandboxes in ${NAMESPACE}..."
if kubectl get sandboxes -n "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl delete sandboxes --all -n "${NAMESPACE}" --wait=false 2>/dev/null || true
  log_ok "Sandboxes deleted"
else
  log_warn "No Sandbox resources found (CRD may not exist)"
fi

# --- Step 2: Delete warm pools ---------------------------------------------

log_info "Deleting SandboxWarmPools in ${NAMESPACE}..."
if kubectl get sandboxwarmpools -n "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl delete sandboxwarmpools --all -n "${NAMESPACE}" --wait=false 2>/dev/null || true
  log_ok "Warm pools deleted"
else
  log_warn "No SandboxWarmPool resources found"
fi

# --- Step 3: Delete sandbox claims ------------------------------------------

log_info "Deleting SandboxClaims in ${NAMESPACE}..."
if kubectl get sandboxclaims -n "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl delete sandboxclaims --all -n "${NAMESPACE}" --wait=false 2>/dev/null || true
  log_ok "Sandbox claims deleted"
else
  log_warn "No SandboxClaim resources found"
fi

# --- Step 4: Delete sandbox templates --------------------------------------

log_info "Deleting SandboxTemplates in ${NAMESPACE}..."
if kubectl get sandboxtemplates -n "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl delete sandboxtemplates --all -n "${NAMESPACE}" --wait=false 2>/dev/null || true
  log_ok "Templates deleted"
else
  log_warn "No SandboxTemplate resources found"
fi

# --- Step 5: Delete remaining pods (cleanup stragglers) --------------------

log_info "Deleting remaining pods in ${NAMESPACE}..."
kubectl delete pods --all -n "${NAMESPACE}" --wait=false 2>/dev/null || true
log_ok "Pods deleted"

# --- Step 6: Delete network policies ---------------------------------------

log_info "Deleting NetworkPolicies in ${NAMESPACE}..."
kubectl delete networkpolicies --all -n "${NAMESPACE}" 2>/dev/null || true
log_ok "Network policies deleted"

# --- Step 7: Delete the namespace ------------------------------------------

log_info "Deleting namespace ${NAMESPACE}..."
kubectl delete namespace "${NAMESPACE}" --wait=false 2>/dev/null || true
log_ok "Namespace deletion initiated"

# --- Step 8: Delete RuntimeClass -------------------------------------------

log_info "Deleting gVisor RuntimeClass..."
kubectl delete runtimeclass gvisor 2>/dev/null || true
log_ok "RuntimeClass deleted"

# --- Step 9: Clean up E2E test namespaces ----------------------------------

log_info "Cleaning up E2E test namespaces (agentpane-e2e-*)..."
E2E_NAMESPACES=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep '^agentpane-e2e-' || true)
if [ -n "${E2E_NAMESPACES}" ]; then
  for e2e_ns in ${E2E_NAMESPACES}; do
    kubectl delete namespace "${e2e_ns}" --wait=false 2>/dev/null || true
    log_ok "Deleted E2E namespace: ${e2e_ns}"
  done
else
  log_info "No E2E namespaces found"
fi

# --- Step 10: Optionally stop/delete minikube ------------------------------

if [ "${DELETE_MINIKUBE}" = true ]; then
  echo ""
  log_info "Deleting minikube cluster..."
  minikube delete
  log_ok "minikube cluster deleted"
elif [ "${STOP_MINIKUBE}" = true ]; then
  echo ""
  log_info "Stopping minikube..."
  minikube stop
  log_ok "minikube stopped"
else
  echo ""
  log_info "minikube is still running. Use --stop or --delete to shut it down."
fi

# --- Summary ----------------------------------------------------------------

echo ""
echo "============================================================================"
echo -e "  ${GREEN}${BOLD}Teardown complete.${NC}"
echo ""
if [ "${DELETE_MINIKUBE}" = true ]; then
  echo "  minikube cluster has been deleted."
  echo "  To set up again: ./scripts/k8s-setup-minikube.sh"
elif [ "${STOP_MINIKUBE}" = true ]; then
  echo "  minikube has been stopped."
  echo "  To restart: minikube start"
else
  echo "  AgentPane resources removed. minikube is still running."
  echo "  To stop:   ./scripts/k8s-teardown-minikube.sh --stop"
  echo "  To delete: ./scripts/k8s-teardown-minikube.sh --delete"
fi
echo "============================================================================"
```

### Making It Executable

```bash
chmod +x scripts/k8s-teardown-minikube.sh
```

### Usage

```bash
# Remove all AgentPane resources but keep minikube running
./scripts/k8s-teardown-minikube.sh

# Remove resources and stop minikube (preserves VM for fast restart)
./scripts/k8s-teardown-minikube.sh --stop

# Remove resources and delete minikube entirely (full cleanup)
./scripts/k8s-teardown-minikube.sh --delete
```

---

## 6. CI/CD Integration Notes

### GitHub Actions Workflow

E2E tests should run in a separate CI job that sets up minikube. The gVisor addon is not reliably available in all CI environments, so tests must gracefully degrade.

**File**: `.github/workflows/test-k8s-e2e.yml`

```yaml
name: K8s E2E Tests

on:
  push:
    branches: [main]
    paths:
      - 'packages/agent-sandbox-sdk/**'
      - 'src/lib/sandbox/providers/agent-sandbox-*'
      - 'k8s/**'
      - 'tests/e2e/k8s/**'
  pull_request:
    branches: [main]
    paths:
      - 'packages/agent-sandbox-sdk/**'
      - 'src/lib/sandbox/providers/agent-sandbox-*'
      - 'k8s/**'
      - 'tests/e2e/k8s/**'
  workflow_dispatch:  # Manual trigger

jobs:
  k8s-e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Setup minikube
        uses: medyagh/setup-minikube@latest
        with:
          minikube-version: 1.33.0
          kubernetes-version: v1.30.0
          container-runtime: containerd
          cpus: 4
          memory: 8192

      - name: Verify minikube
        run: |
          minikube status
          kubectl cluster-info
          kubectl get nodes

      - name: Enable gVisor (best-effort)
        continue-on-error: true
        run: |
          minikube addons enable gvisor
          kubectl rollout status daemonset/gvisor -n gvisor --timeout=120s || true

      - name: Install Agent Sandbox CRDs
        run: |
          VERSION="${AGENT_SANDBOX_VERSION:-v0.1.0}"
          kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml" || \
            kubectl apply -f "https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/main/config/crd/bases/agents.x-k8s.io_sandboxes.yaml"
          kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml" || true

      - name: Create namespace and apply manifests
        run: |
          kubectl create namespace agentpane-sandboxes --dry-run=client -o yaml | kubectl apply -f -
          kubectl apply -f k8s/manifests/runtime-class-gvisor.yaml
          kubectl apply -f k8s/manifests/agentpane-sandbox-template.yaml
          kubectl apply -f k8s/manifests/agentpane-network-policy.yaml
          kubectl apply -f k8s/manifests/agentpane-warm-pool.yaml || true

      - name: Verify CRDs
        run: |
          kubectl get crd sandboxes.agents.x-k8s.io
          kubectl get sandboxtemplates -n agentpane-sandboxes

      - name: Run E2E tests
        env:
          K8S_E2E: "true"
        run: bun run vitest run tests/e2e/k8s/ --reporter=verbose

      - name: Collect debug info on failure
        if: failure()
        run: |
          echo "=== Pods ==="
          kubectl get pods -A
          echo "=== Events ==="
          kubectl get events -n agentpane-sandboxes --sort-by='.lastTimestamp'
          echo "=== CRDs ==="
          kubectl get crd | grep -E 'sandbox|agent' || true
          echo "=== Describe failed pods ==="
          kubectl describe pods -n agentpane-sandboxes 2>/dev/null || true

      - name: Cleanup
        if: always()
        run: |
          kubectl delete namespace agentpane-sandboxes --wait=false || true
          # Clean up E2E test namespaces
          kubectl get ns -o name | grep agentpane-e2e | xargs -r kubectl delete --wait=false || true
```

### Key CI/CD Considerations

| Consideration | Approach |
|---------------|----------|
| **gVisor availability** | `continue-on-error: true` on the gVisor addon step. Tests skip gVisor-specific assertions if RuntimeClass is absent. |
| **Image pull time** | The `srlynch1/agent-sandbox:latest` image may take 30-60s to pull in CI. Test timeouts account for this (120-180s per test). |
| **Minikube driver** | In GitHub Actions, use the `docker` driver (default for `medyagh/setup-minikube`). |
| **Path-based triggers** | The workflow only runs when K8s-related files change to avoid unnecessary CI time. |
| **Debug on failure** | The `Collect debug info` step dumps pods, events, and CRDs to help diagnose failures. |
| **Parallelism** | E2E tests use unique namespaces per run (`agentpane-e2e-<timestamp>`), so multiple CI runs do not conflict. |
| **Cleanup** | The `always()` cleanup step ensures namespaces are deleted even if tests fail. |

### Local CI Simulation

To run the CI workflow locally (useful for debugging):

```bash
# 1. Start minikube
./scripts/k8s-setup-minikube.sh

# 2. Run the same test command as CI
K8S_E2E=true bun run vitest run tests/e2e/k8s/ --reporter=verbose

# 3. Clean up
./scripts/k8s-teardown-minikube.sh
```

---

## 7. Troubleshooting

### gVisor Addon Not Starting

**Symptoms**: `minikube addons enable gvisor` succeeds but the DaemonSet never becomes ready.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Wrong container runtime | minikube must use `--container-runtime=containerd`. Docker runtime does not support gVisor. Recreate: `minikube delete && minikube start --container-runtime=containerd` |
| Kernel too old | gVisor requires Linux kernel 4.15+. In minikube VMs this is usually fine, but WSL1 may not work. Use WSL2. |
| Insufficient resources | gVisor DaemonSet needs ~256MB. Increase minikube memory: `MINIKUBE_MEMORY=12288 ./scripts/k8s-setup-minikube.sh` |
| Driver incompatibility | The `none` driver may have issues. Use `docker` or `hyperkit` driver. |

**Debug commands**:
```bash
minikube addons list | grep gvisor
kubectl get daemonset -A | grep gvisor
kubectl describe daemonset gvisor -n gvisor
kubectl logs -n gvisor -l app=gvisor --tail=50
```

**Workaround**: Skip gVisor and run sandboxes with the default `runc` runtime:
```bash
SKIP_GVISOR=true ./scripts/k8s-setup-minikube.sh
```

Then remove `runtimeClassName: gvisor` from the SandboxTemplate (or create a separate template without it).

### Controller Pod Crashlooping

**Symptoms**: `kubectl get pods -n agent-sandbox-system` shows the controller in `CrashLoopBackOff`.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Missing RBAC | The controller needs ClusterRole permissions. Re-apply: `kubectl apply -f manifest.yaml` |
| CRD version mismatch | Ensure `manifest.yaml` and `extensions.yaml` are from the same release version |
| Insufficient resources | Controller needs ~128MB. Check: `kubectl describe pod -n agent-sandbox-system` |
| Webhook TLS issue | If the controller uses admission webhooks, the CA bundle may be misconfigured. Check controller logs. |

**Debug commands**:
```bash
kubectl get pods -n agent-sandbox-system
kubectl logs -n agent-sandbox-system -l control-plane=controller-manager --tail=100
kubectl describe deployment agent-sandbox-controller-manager -n agent-sandbox-system
kubectl get events -n agent-sandbox-system --sort-by='.lastTimestamp'
```

### Sandbox Stuck in Pending

**Symptoms**: `kubectl get sandbox <name> -n agentpane-sandboxes` shows `Pending` indefinitely.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Image pull failure | Check image name and registry access. `kubectl describe pod <name> -n agentpane-sandboxes` will show `ImagePullBackOff` events. |
| Insufficient node resources | minikube has limited resources. Check: `kubectl describe node minikube \| grep -A5 "Allocated resources"` |
| RuntimeClass not found | If gVisor is not installed but the template references `runtimeClassName: gvisor`, the pod cannot be scheduled. Remove or install gVisor. |
| PodSecurityPolicy blocking | The namespace has `restricted` PSS enforcement. Ensure the pod spec complies (no root, no privilege escalation, etc.) |
| Node selector mismatch | The gVisor RuntimeClass has a `nodeSelector`. Verify the node has the label: `kubectl get nodes --show-labels` |

**Debug commands**:
```bash
kubectl get pods -n agentpane-sandboxes
kubectl describe pod <pod-name> -n agentpane-sandboxes
kubectl get events -n agentpane-sandboxes --sort-by='.lastTimestamp'
kubectl top node   # Check resource usage
```

### Exec Timeout

**Symptoms**: `kubectl exec` hangs or returns a timeout error.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Pod not running | Verify pod is in `Running` phase: `kubectl get pod <name> -n agentpane-sandboxes` |
| Container not ready | Check readiness: `kubectl describe pod <name> -n agentpane-sandboxes \| grep "Ready"` |
| Network issue | In minikube, the API server must be reachable. Check: `kubectl cluster-info` |
| WebSocket blocked | Some proxies block WebSocket upgrades used by `kubectl exec`. Ensure direct connectivity. |
| Command does not exist | If the binary is not in the container image, exec will fail. Verify: `kubectl exec <pod> -- which <cmd>` |

**Debug commands**:
```bash
# Check pod status
kubectl get pod <name> -n agentpane-sandboxes -o wide

# Check container logs
kubectl logs <name> -n agentpane-sandboxes

# Test basic exec
kubectl exec <name> -n agentpane-sandboxes -- echo "test"

# Check API server connectivity
kubectl cluster-info
kubectl get --raw /healthz
```

### NetworkPolicy Not Working

**Symptoms**: Sandbox pods can reach services they should not, or cannot reach services they should.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| CNI does not support NetworkPolicy | minikube's default CNI (kindnet) has limited NetworkPolicy support. Use Calico: `minikube start --cni=calico` |
| Label mismatch | NetworkPolicy `podSelector` must match the pod labels. Verify: `kubectl get pod <name> -n agentpane-sandboxes --show-labels` |
| DNS blocked | Ensure DNS egress rule is present (UDP/TCP port 53). Without it, nothing works. |
| Policy not applied | Check the policy exists: `kubectl get networkpolicy -n agentpane-sandboxes` |

**Debug commands**:
```bash
# Check policies
kubectl get networkpolicy -n agentpane-sandboxes -o yaml

# Test connectivity from inside a pod
kubectl exec <pod> -n agentpane-sandboxes -- nslookup api.anthropic.com
kubectl exec <pod> -n agentpane-sandboxes -- wget -qO- --timeout=5 https://api.anthropic.com 2>&1 || true

# Use Calico CNI for full NetworkPolicy support
minikube delete
minikube start --container-runtime=containerd --cni=calico --cpus=4 --memory=8192
```

### Warm Pool Not Replenishing

**Symptoms**: After claiming a warm pod, the pool does not grow back to the desired replica count.

**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Controller not running | The warm pool controller must be running. Check: `kubectl get pods -n agent-sandbox-system` |
| Resource quota exceeded | The namespace may have resource quotas blocking new pods. Check: `kubectl get resourcequota -n agentpane-sandboxes` |
| Image pull rate limit | Docker Hub rate limits may prevent new pods from pulling images. Use a local registry or pre-pull images. |

**Debug commands**:
```bash
kubectl get sandboxwarmpool -n agentpane-sandboxes -o yaml
kubectl get pods -n agentpane-sandboxes -l agentpane.io/sandbox=true
kubectl describe sandboxwarmpool agentpane-warm-pool -n agentpane-sandboxes
```

### Common Quick Fixes

```bash
# Reset everything and start fresh
./scripts/k8s-teardown-minikube.sh --delete
./scripts/k8s-setup-minikube.sh

# Restart minikube (preserves configuration)
minikube stop && minikube start

# Force-delete stuck namespace
kubectl delete namespace agentpane-sandboxes --force --grace-period=0

# Pre-pull the sandbox image into minikube
minikube ssh -- docker pull srlynch1/agent-sandbox:latest

# Check minikube resource usage
minikube ssh -- free -h
minikube ssh -- df -h
minikube ssh -- nproc

# View minikube logs
minikube logs --last=50
```

---

## Appendix: Quick Reference

### File Inventory

| File | Type | Purpose |
|------|------|---------|
| `scripts/k8s-setup-minikube.sh` | Bash | Start minikube, install CRDs, apply manifests |
| `scripts/k8s-teardown-minikube.sh` | Bash | Remove all resources, optionally stop minikube |
| `k8s/manifests/runtime-class-gvisor.yaml` | K8s manifest | gVisor RuntimeClass definition |
| `k8s/manifests/agentpane-sandbox-template.yaml` | K8s manifest | SandboxTemplate for agent pods |
| `k8s/manifests/agentpane-warm-pool.yaml` | K8s manifest | SandboxWarmPool (3 replicas) |
| `k8s/manifests/agentpane-network-policy.yaml` | K8s manifest | Namespace-level NetworkPolicy |
| `tests/e2e/k8s/agent-sandbox-e2e.test.ts` | Vitest | 9 E2E test cases |
| `tests/e2e/k8s/helpers.ts` | TypeScript | Test utilities and kubectl wrapper |
| `.github/workflows/test-k8s-e2e.yml` | GitHub Actions | CI workflow for E2E tests |

### Command Cheat Sheet

```bash
# Setup
./scripts/k8s-setup-minikube.sh                          # Full setup
SKIP_GVISOR=true ./scripts/k8s-setup-minikube.sh         # Without gVisor

# Verify
kubectl get crd | grep sandbox                            # CRDs installed?
kubectl get sandboxtemplates -n agentpane-sandboxes       # Template applied?
kubectl get sandboxwarmpools -n agentpane-sandboxes       # Warm pool running?
kubectl get networkpolicy -n agentpane-sandboxes          # Network policy active?
kubectl get runtimeclass gvisor                           # gVisor available?

# Test
K8S_E2E=true bun run vitest run tests/e2e/k8s/           # Run E2E tests

# Teardown
./scripts/k8s-teardown-minikube.sh                        # Resources only
./scripts/k8s-teardown-minikube.sh --stop                 # Stop minikube
./scripts/k8s-teardown-minikube.sh --delete               # Full cleanup

# Debug
kubectl get pods -n agentpane-sandboxes                   # Pod status
kubectl get events -n agentpane-sandboxes --sort-by='.lastTimestamp'
kubectl logs -n agent-sandbox-system -l control-plane=controller-manager
minikube dashboard                                        # Web UI
```
