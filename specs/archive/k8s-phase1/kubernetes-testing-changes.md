# Kubernetes Integration Testing - Code Changes

> **Date**: 2026-01-24
> **Context**: Testing K8s provider with Docker Desktop kubeconfig

---

## Issue Discovered

When testing the K8s provider with Bun runtime, we discovered a **TLS client certificate authentication issue**:

- **Symptom**: API calls fail with "unable to verify the first certificate" or authenticate as "system:anonymous"
- **Root Cause**: Bun's TLS implementation doesn't properly send client certificates from kubeconfig
- **Workaround**: Works correctly with Node.js/tsx, or when `skipTLSVerify` is enabled

---

## Code Changes

### 1. `src/lib/sandbox/providers/k8s-config.ts`

**Change**: Added `skipTLSVerify` option to `K8sProviderOptions` interface

```typescript
// Added new option:
/** Skip TLS verification (useful for local development with Docker Desktop) */
skipTLSVerify?: boolean;
```

**Reason**: Allows users to bypass TLS verification for local development environments where the certificate chain may not be trusted by the runtime.

---

### 2. `src/lib/sandbox/providers/k8s-config.ts` (loadKubeConfig function)

**Change**: Apply `skipTLSVerify` to cluster configuration after loading

```typescript
// After loading kubeconfig, optionally skip TLS verification
if (skipTLSVerify) {
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    cluster.skipTLSVerify = true;
  }
}
```

**Reason**: The `@kubernetes/client-node` library respects the `skipTLSVerify` property on the cluster object.

---

### 3. `src/lib/sandbox/providers/k8s-provider.ts`

**Change**: Pass `skipTLSVerify` option through to kubeconfig loader

**Reason**: Allow provider instantiation with TLS verification disabled for local development.

---

### 4. `src/lib/workflow-dsl/layout.ts` (Pre-existing fix)

**Change**: Made ELK initialization lazy to avoid Web Worker errors in server context

```typescript
// Before:
const elk = new ELK();

// After:
let elkInstance: import('elkjs').default | null = null;

async function getElk(): Promise<import('elkjs').default> {
  if (!elkInstance) {
    const ELK = (await import('elkjs/lib/elk.bundled.js')).default;
    elkInstance = new ELK();
  }
  return elkInstance;
}
```

**Reason**: elkjs bundled version tries to create Web Workers at module load time, which fails in Bun's server environment.

---

## Test Scripts Created

1. `scripts/test-k8s-provider.ts` - Main K8s provider test suite
2. `scripts/debug-k8s-auth.ts` - TLS/auth debugging script

---

## Recommendations

1. **For local Docker Desktop testing**: Use `skipTLSVerify: true` in K8sProviderOptions
2. **For production**: Never skip TLS verification
3. **Consider**: Adding environment variable `K8S_SKIP_TLS_VERIFY=true` for convenience

---

## Dependencies Fixed

- `zod@4.x` → `zod@3.x` - Downgraded due to breaking API changes affecting `@tanstack/router-generator`

---

## Issues Discovered During Testing

### 1. Bun TLS Client Certificate Issue
- **Problem**: Bun doesn't properly send TLS client certificates for mTLS authentication
- **Result**: K8s API sees connections as "system:anonymous"
- **Workaround**: Use Node.js/tsx for K8s operations, or wait for Bun fix
- **Tracking**: This is a known Bun limitation with mTLS

### 2. Pod Security Standards Conflict
- **Problem**: Namespace created with "restricted" PSS, but `hostPath` volumes needed for workspace mounting
- **Error**: `violates PodSecurity "restricted:latest": restricted volume types`
- **Fix**: Change PSS from "restricted" to "baseline" for local development
- **Note**: Production deployments should use PVCs instead of hostPath

### 3. Error Handling Bug
- **Problem**: `appError.code.startsWith is not a function`
- **Cause**: HTTP error codes are numbers, not strings
- **Fix**: Add type check before calling `.startsWith()`

### 4. Docker Desktop hostPath Volume Sharing → FIXED with PVC
- **Problem**: hostPath volumes fail with "not a directory" error
- **Cause**: Docker Desktop VM doesn't automatically share host paths
- **Solution**: Implemented PVC (PersistentVolumeClaim) as the default volume type
- **Benefits**:
  - Works with Docker Desktop without configuration
  - Production-ready (portable across K8s environments)
  - Proper storage isolation per sandbox
  - Automatic cleanup when sandbox is deleted

---

## PVC Implementation Details

### New Configuration Options (k8s-config.ts)

```typescript
export type K8sVolumeType = 'hostPath' | 'pvc' | 'emptyDir';

export interface K8sProviderOptions {
  /** Volume type for workspace storage (default: 'pvc') */
  volumeType?: K8sVolumeType;

  /** Storage class for PVCs (default: uses cluster default) */
  storageClassName?: string;

  /** Default storage size for workspace PVCs (default: '1Gi') */
  workspaceStorageSize?: string;
}
```

### New Methods (k8s-provider.ts)

1. `buildWorkspaceVolume(sandboxId, projectPath)` - Creates volume spec based on volumeType
2. `createWorkspacePvc(sandboxId)` - Creates PVC for sandbox workspace
3. `deleteWorkspacePvc(sandboxId)` - Deletes PVC when sandbox is cleaned up

### New Audit Events (k8s-audit.ts)

1. `logPvcCreated({ pvcName, namespace, sandboxId, storageSize })`
2. `logPvcDeleted({ pvcName, namespace, sandboxId })`

### Default Behavior

- **volumeType**: `'pvc'` (changed from implicit `'hostPath'`)
- **workspaceStorageSize**: `'1Gi'`
- **storageClassName**: Uses cluster default (e.g., `hostpath` for Docker Desktop)

---

## Backend API Server Changes (src/server/api.ts)

### Issue: UI Showing "Route not found"

The K8s API routes were defined as TanStack Router file-based routes (`src/app/routes/api/sandbox/k8s/*.ts`), but:
1. The Vite config has `routeFileIgnorePattern: '.*\\/api\\/.*'` which excludes API routes from TanStack Router
2. All `/api/*` requests are proxied to the backend server at port 3001
3. The backend server didn't have the K8s routes implemented

### Fix: Added K8s API routes to backend server

Added three handler functions and route matching:

```typescript
// Handler functions added:
async function handleK8sStatus(url: URL): Promise<Response>
async function handleK8sContexts(url: URL): Promise<Response>
async function handleK8sNamespaces(url: URL): Promise<Response>

// Route matching added:
if (path === '/api/sandbox/k8s/status' && method === 'GET') {
  return handleK8sStatus(url);
}
if (path === '/api/sandbox/k8s/contexts' && method === 'GET') {
  return handleK8sContexts(url);
}
if (path === '/api/sandbox/k8s/namespaces' && method === 'GET') {
  return handleK8sNamespaces(url);
}
```

### Import added:

```typescript
import {
  loadKubeConfig,
  resolveContext,
  getClusterInfo,
  K8S_PROVIDER_DEFAULTS,
} from '../lib/sandbox/providers/k8s-config.js';
```

### Endpoint Responses

**GET /api/sandbox/k8s/status**
```json
{
  "ok": true,
  "data": {
    "healthy": true,
    "context": "docker-desktop",
    "cluster": "docker-desktop",
    "server": "https://127.0.0.1:65444",
    "serverVersion": "v1.31.4",
    "namespace": "agentpane-sandboxes",
    "namespaceExists": false,
    "pods": 0,
    "podsRunning": 0
  }
}
```

**GET /api/sandbox/k8s/contexts**
```json
{
  "ok": true,
  "data": {
    "contexts": [
      { "name": "docker-desktop", "cluster": "docker-desktop", "user": "docker-desktop" }
    ],
    "current": "docker-desktop"
  }
}
```

---

## UI Testing

After the backend API changes, the Sandbox Settings page (`/settings/sandbox`) now correctly shows:
- **Connected** status when Kubernetes provider is selected
- Cluster details (context, server, version)
- Namespace status
- Context dropdown with available contexts
