# Agent Sandbox SDK Specification

> **Package**: `@agentpane/agent-sandbox-sdk`
> **Location**: `packages/agent-sandbox-sdk/`
> **Version**: `0.1.0`
> **Status**: Specification Complete
> **Created**: 2026-02-12

---

## Overview

A standalone TypeScript SDK for the kubernetes-sigs [Agent Sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox) (`agents.x-k8s.io/v1alpha1`). This package provides typed CRUD operations, exec/stream helpers, watch/informer support, lifecycle utilities, and fluent builders for all four CRD resource types: `Sandbox`, `SandboxTemplate`, `SandboxWarmPool`, and `SandboxClaim`.

The SDK is designed to be consumed by AgentPane's `AgentSandboxProvider` but is published as a reusable package with no AgentPane-specific dependencies.

---

## Directory Structure

```
packages/agent-sandbox-sdk/
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── src/
│   ├── index.ts                     # Public API barrel export
│   ├── client.ts                    # AgentSandboxClient orchestrator
│   ├── constants.ts                 # CRD constants (API groups, versions, labels)
│   ├── kubeconfig.ts                # 5-tier KubeConfig loader
│   │
│   ├── types/                       # TypeScript type definitions
│   │   ├── common.ts                # Shared types (ObjectMeta, Condition, etc.)
│   │   ├── sandbox.ts               # Sandbox resource types
│   │   ├── template.ts              # SandboxTemplate resource types
│   │   ├── claim.ts                 # SandboxClaim resource types
│   │   ├── warm-pool.ts             # SandboxWarmPool resource types
│   │   └── exec.ts                  # Exec/stream operation types
│   │
│   ├── schemas/                     # Zod validation schemas
│   │   ├── sandbox.ts               # Sandbox schemas
│   │   ├── template.ts              # SandboxTemplate schemas
│   │   ├── claim.ts                 # SandboxClaim schemas
│   │   └── warm-pool.ts             # SandboxWarmPool schemas
│   │
│   ├── operations/                  # Core operations
│   │   ├── crud.ts                  # Generic CustomResourceCrud<T>
│   │   ├── exec.ts                  # Buffered exec + streaming exec
│   │   ├── watch.ts                 # Watch/informer helpers
│   │   └── lifecycle.ts             # waitForReady, pause, resume
│   │
│   ├── builders/                    # Fluent resource builders
│   │   ├── sandbox.ts               # SandboxBuilder
│   │   ├── template.ts              # SandboxTemplateBuilder
│   │   ├── claim.ts                 # SandboxClaimBuilder
│   │   └── warm-pool.ts             # SandboxWarmPoolBuilder
│   │
│   └── errors.ts                    # SDK error types
│
└── __tests__/
    ├── client.test.ts               # Integration tests for AgentSandboxClient
    ├── crud.test.ts                 # CustomResourceCrud unit tests
    ├── exec.test.ts                 # Exec operation tests
    ├── builders.test.ts             # Builder pattern tests
    ├── schemas.test.ts              # Zod schema validation tests
    └── kubeconfig.test.ts           # KubeConfig loader tests
```

---

## CRD Constants

File: `src/constants.ts`

```typescript
/**
 * Agent Sandbox CRD API constants
 */
export const CRD_API = {
  /** API group for all Agent Sandbox CRDs */
  group: 'agents.x-k8s.io',

  /** Current API version */
  version: 'v1alpha1',

  /** Fully qualified apiVersion string */
  apiVersion: 'agents.x-k8s.io/v1alpha1',

  /** Extensions API group (for SandboxTemplate, SandboxWarmPool) */
  extensionsGroup: 'extensions.agents.x-k8s.io',

  /** Extensions fully qualified apiVersion */
  extensionsApiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
} as const;

/**
 * Resource plurals for K8s API paths
 */
export const CRD_PLURALS = {
  sandbox: 'sandboxes',
  sandboxTemplate: 'sandboxtemplates',
  sandboxClaim: 'sandboxclaims',
  sandboxWarmPool: 'sandboxwarmpools',
} as const;

/**
 * Resource kinds
 */
export const CRD_KINDS = {
  sandbox: 'Sandbox',
  sandboxTemplate: 'SandboxTemplate',
  sandboxClaim: 'SandboxClaim',
  sandboxWarmPool: 'SandboxWarmPool',
} as const;

/**
 * Standard annotations used by the CRD controller
 */
export const CRD_ANNOTATIONS = {
  /** TTL for sandbox auto-cleanup (e.g. "1h", "30m") */
  ttl: 'agents.x-k8s.io/ttl',

  /** Pause reason annotation */
  pauseReason: 'agents.x-k8s.io/pause-reason',

  /** Creator identity */
  createdBy: 'agents.x-k8s.io/created-by',

  /** AgentPane-specific: sandbox ID mapping */
  sandboxId: 'agentpane.io/sandbox-id',

  /** AgentPane-specific: project ID mapping */
  projectId: 'agentpane.io/project-id',

  /** AgentPane-specific: task ID mapping */
  taskId: 'agentpane.io/task-id',
} as const;

/**
 * Standard condition types on Sandbox status
 */
export const CRD_CONDITIONS = {
  /** Sandbox is ready and accepting connections */
  ready: 'Ready',

  /** Pod is scheduled and running */
  podReady: 'PodReady',

  /** Network policy is applied */
  networkReady: 'NetworkReady',

  /** Storage (PVC) is bound */
  storageReady: 'StorageReady',

  /** Sandbox is paused */
  paused: 'Paused',
} as const;

/**
 * Standard labels applied by the controller
 */
export const CRD_LABELS = {
  /** Managed by agentpane */
  managed: 'agentpane.io/managed',

  /** Sandbox marker */
  sandbox: 'agentpane.io/sandbox',

  /** Project association */
  projectId: 'agentpane.io/project-id',

  /** Warm pool membership */
  warmPool: 'agentpane.io/warm-pool',

  /** Warm pool state */
  warmPoolState: 'agentpane.io/warm-pool-state',
} as const;
```

---

## Type Definitions

### `src/types/common.ts`

```typescript
import type { V1ObjectMeta, V1Condition, V1PodTemplateSpec } from '@kubernetes/client-node';

/**
 * Base interface for all CRD resources
 */
export interface CRDResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec: TSpec;
  status?: TStatus;
}

/**
 * List wrapper for CRD resources
 */
export interface CRDResourceList<T extends CRDResource> {
  apiVersion: string;
  kind: string;
  metadata: { resourceVersion?: string; continue?: string };
  items: T[];
}

/**
 * Watch event types
 */
export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR' | 'BOOKMARK';

/**
 * Watch event
 */
export interface WatchEvent<T extends CRDResource> {
  type: WatchEventType;
  object: T;
}

/**
 * Standard condition from K8s status
 */
export type Condition = V1Condition;
```

### `src/types/sandbox.ts`

```typescript
import type { V1PodTemplateSpec, V1ObjectMeta } from '@kubernetes/client-node';
import type { CRDResource, CRDResourceList, Condition } from './common.js';

/**
 * Sandbox spec
 */
export interface SandboxSpec {
  /** Reference to a SandboxTemplate */
  sandboxTemplateRef?: {
    name: string;
    namespace?: string;
  };

  /** Inline pod template (alternative to templateRef) */
  podTemplate?: V1PodTemplateSpec;

  /** Number of replicas (0 = paused, 1 = running) */
  replicas?: number;

  /** Network policy configuration */
  networkPolicy?: SandboxNetworkPolicy;

  /** Volume claims for persistent storage */
  volumeClaims?: SandboxVolumeClaim[];

  /** Runtime class name (e.g., "gvisor", "kata") */
  runtimeClassName?: string;

  /** Time-to-live after completion */
  ttlSecondsAfterFinished?: number;
}

/**
 * Network policy embedded in sandbox spec
 */
export interface SandboxNetworkPolicy {
  egress?: SandboxNetworkRule[];
  ingress?: SandboxNetworkRule[];
}

/**
 * Network rule
 */
export interface SandboxNetworkRule {
  ports?: Array<{ port: number; protocol: string }>;
  to?: Array<{ ipBlock?: { cidr: string; except?: string[] } }>;
  from?: Array<{ ipBlock?: { cidr: string; except?: string[] } }>;
}

/**
 * Volume claim in sandbox
 */
export interface SandboxVolumeClaim {
  name: string;
  storageClassName?: string;
  accessModes: string[];
  resources: {
    requests: { storage: string };
  };
}

/**
 * Sandbox status
 */
export interface SandboxStatus {
  /** Current phase */
  phase?: 'Pending' | 'Running' | 'Paused' | 'Succeeded' | 'Failed' | 'Unknown';

  /** Standard conditions */
  conditions?: Condition[];

  /** Pod name backing this sandbox */
  podName?: string;

  /** Stable service FQDN */
  serviceFQDN?: string;

  /** IP address of the sandbox pod */
  podIP?: string;

  /** Ready replicas count */
  readyReplicas?: number;

  /** When the sandbox became ready */
  readyAt?: string;
}

/**
 * Full Sandbox resource
 */
export type Sandbox = CRDResource<SandboxSpec, SandboxStatus>;

/**
 * Sandbox list
 */
export type SandboxList = CRDResourceList<Sandbox>;
```

### `src/types/template.ts`

```typescript
import type { V1PodTemplateSpec } from '@kubernetes/client-node';
import type { CRDResource, CRDResourceList } from './common.js';
import type { SandboxNetworkPolicy } from './sandbox.js';

/**
 * SandboxTemplate spec
 */
export interface SandboxTemplateSpec {
  /** Pod template for sandboxes created from this template */
  podTemplate: V1PodTemplateSpec;

  /** Default network policy for sandboxes */
  networkPolicy?: SandboxNetworkPolicy;

  /** Default runtime class */
  runtimeClassName?: string;

  /** Default volume claims */
  volumeClaims?: Array<{
    name: string;
    storageClassName?: string;
    accessModes: string[];
    resources: { requests: { storage: string } };
  }>;
}

/**
 * SandboxTemplate status
 */
export interface SandboxTemplateStatus {
  /** Number of sandboxes using this template */
  sandboxCount?: number;
}

/**
 * Full SandboxTemplate resource
 */
export type SandboxTemplate = CRDResource<SandboxTemplateSpec, SandboxTemplateStatus>;

/**
 * SandboxTemplate list
 */
export type SandboxTemplateList = CRDResourceList<SandboxTemplate>;
```

### `src/types/claim.ts`

```typescript
import type { CRDResource, CRDResourceList, Condition } from './common.js';

/**
 * SandboxClaim spec -- used to request a sandbox from a warm pool
 */
export interface SandboxClaimSpec {
  /** Reference to the SandboxTemplate */
  sandboxTemplateRef: {
    name: string;
    namespace?: string;
  };

  /** Reference to the WarmPool to claim from */
  warmPoolRef?: {
    name: string;
    namespace?: string;
  };
}

/**
 * SandboxClaim status
 */
export interface SandboxClaimStatus {
  /** Phase of the claim */
  phase?: 'Pending' | 'Bound' | 'Failed';

  /** Name of the sandbox bound to this claim */
  sandboxRef?: {
    name: string;
    namespace?: string;
  };

  /** Conditions */
  conditions?: Condition[];

  /** When the claim was bound */
  boundAt?: string;
}

/**
 * Full SandboxClaim resource
 */
export type SandboxClaim = CRDResource<SandboxClaimSpec, SandboxClaimStatus>;

/**
 * SandboxClaim list
 */
export type SandboxClaimList = CRDResourceList<SandboxClaim>;
```

### `src/types/warm-pool.ts`

```typescript
import type { CRDResource, CRDResourceList, Condition } from './common.js';

/**
 * SandboxWarmPool spec
 */
export interface SandboxWarmPoolSpec {
  /** Number of warm replicas to maintain */
  replicas: number;

  /** Reference to the SandboxTemplate used for pool members */
  sandboxTemplateRef: {
    name: string;
    namespace?: string;
  };

  /** Minimum replicas (for autoscaling) */
  minReplicas?: number;

  /** Maximum replicas (for autoscaling) */
  maxReplicas?: number;
}

/**
 * SandboxWarmPool status
 */
export interface SandboxWarmPoolStatus {
  /** Number of ready warm sandboxes */
  readyReplicas?: number;

  /** Number of allocated sandboxes */
  allocatedReplicas?: number;

  /** Total replicas (warm + allocated) */
  replicas?: number;

  /** Conditions */
  conditions?: Condition[];
}

/**
 * Full SandboxWarmPool resource
 */
export type SandboxWarmPool = CRDResource<SandboxWarmPoolSpec, SandboxWarmPoolStatus>;

/**
 * SandboxWarmPool list
 */
export type SandboxWarmPoolList = CRDResourceList<SandboxWarmPool>;
```

### `src/types/exec.ts`

```typescript
import type { Readable, Writable } from 'node:stream';

/**
 * Result of a buffered exec command
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Options for buffered exec
 */
export interface ExecOptions {
  /** Sandbox name */
  sandboxName: string;
  /** Namespace */
  namespace: string;
  /** Container name (defaults to first container) */
  container?: string;
  /** Command to execute */
  command: string[];
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Options for streaming exec
 */
export interface ExecStreamOptions extends ExecOptions {
  /** Optional stdin stream */
  stdin?: Readable;
  /** Whether to allocate a TTY */
  tty?: boolean;
}

/**
 * Result of a streaming exec
 */
export interface ExecStreamResult {
  /** Readable stream for stdout */
  stdout: Readable;
  /** Readable stream for stderr */
  stderr: Readable;
  /** Promise that resolves when the process exits */
  wait(): Promise<{ exitCode: number }>;
  /** Kill the process */
  kill(): void | Promise<void>;
}
```

---

## KubeConfig Loader

File: `src/kubeconfig.ts`

5-tier discovery chain, reusing the pattern from Phase 1 (`src/lib/sandbox/providers/k8s-config.ts`):

| Tier | Source | Env Var / Path |
|------|--------|---------------|
| 1 | Explicit path parameter | `options.kubeconfigPath` |
| 2 | AgentPane env var | `K8S_KUBECONFIG` |
| 3 | Standard kubectl env var | `KUBECONFIG` (colon-separated) |
| 4 | Default file path | `~/.kube/config` |
| 5 | In-cluster service account | `/var/run/secrets/kubernetes.io/serviceaccount/` |

```typescript
export interface KubeConfigOptions {
  /** Explicit path to kubeconfig file */
  kubeconfigPath?: string;
  /** Context to use (defaults to current-context) */
  context?: string;
  /** Skip TLS verification */
  skipTLSVerify?: boolean;
}

/**
 * Load KubeConfig using tiered discovery
 */
export function loadKubeConfig(options?: KubeConfigOptions): KubeConfig;

/**
 * Resolve and set the active context
 */
export function resolveContext(kc: KubeConfig, context?: string): string;

/**
 * Get cluster info from the active context
 */
export function getClusterInfo(kc: KubeConfig): { name: string; server: string } | null;
```

---

## Generic CRUD

File: `src/operations/crud.ts`

```typescript
import type { KubeConfig } from '@kubernetes/client-node';
import type { CRDResource, CRDResourceList } from '../types/common.js';

/**
 * Configuration for CustomResourceCrud
 */
export interface CrudConfig {
  /** API group (e.g., 'agents.x-k8s.io') */
  group: string;
  /** API version (e.g., 'v1alpha1') */
  version: string;
  /** Resource plural (e.g., 'sandboxes') */
  plural: string;
}

/**
 * Options for list operations
 */
export interface ListOptions {
  /** Namespace (omit for cluster-scoped) */
  namespace?: string;
  /** Label selector */
  labelSelector?: string;
  /** Field selector */
  fieldSelector?: string;
  /** Maximum items to return */
  limit?: number;
  /** Continue token for pagination */
  continueToken?: string;
}

/**
 * Generic CRUD for any custom resource
 */
export class CustomResourceCrud<T extends CRDResource> {
  constructor(
    private kc: KubeConfig,
    private config: CrudConfig
  ) {}

  /** Create a resource */
  async create(namespace: string, body: T): Promise<T>;

  /** Get a resource by name */
  async get(namespace: string, name: string): Promise<T>;

  /** List resources */
  async list(options?: ListOptions): Promise<CRDResourceList<T>>;

  /** Update a resource (full replacement) */
  async update(namespace: string, name: string, body: T): Promise<T>;

  /** Patch a resource (strategic merge patch) */
  async patch(
    namespace: string,
    name: string,
    patch: Partial<T>
  ): Promise<T>;

  /** Delete a resource */
  async delete(namespace: string, name: string): Promise<void>;

  /** Check if a resource exists */
  async exists(namespace: string, name: string): Promise<boolean>;
}
```

Implementation note: Uses `KubernetesObjectApi` from `@kubernetes/client-node` for generic custom resource operations, falling back to raw `CustomObjectsApi` for CRD-specific paths.

---

## Exec Operations

File: `src/operations/exec.ts`

### Buffered Exec

Executes a command inside a sandbox pod and returns the complete stdout/stderr output.

```typescript
/**
 * Execute a command inside a sandbox pod (buffered)
 */
export async function execInSandbox(
  kc: KubeConfig,
  options: ExecOptions
): Promise<ExecResult>;
```

Implementation reuses the `k8s.Exec` + `Writable` stream pattern from Phase 1 (`k8s-sandbox.ts:89-162`), including `V1Status` exit code parsing.

### Streaming Exec

Executes a command and returns `Readable` streams for real-time output processing. This is the critical path for `ContainerAgentService.startAgent()` which reads agent-runner stdout line-by-line.

```typescript
/**
 * Execute a command inside a sandbox pod (streaming)
 */
export async function execStreamInSandbox(
  kc: KubeConfig,
  options: ExecStreamOptions
): Promise<ExecStreamResult>;
```

Implementation creates `PassThrough` streams for stdout/stderr (matching the `ExecStreamResult` contract from `sandbox-provider.ts`), wires them to `k8s.Exec`, and provides `wait()` / `kill()` handles.

---

## Watch / Informer

File: `src/operations/watch.ts`

```typescript
import type { KubeConfig } from '@kubernetes/client-node';
import type { CRDResource, WatchEvent } from '../types/common.js';
import type { CrudConfig } from './crud.js';

/**
 * Options for watch operations
 */
export interface WatchOptions {
  /** Namespace to watch */
  namespace: string;
  /** Label selector filter */
  labelSelector?: string;
  /** Resource version to start from */
  resourceVersion?: string;
  /** Timeout in seconds (server-side) */
  timeoutSeconds?: number;
}

/**
 * Watch callback
 */
export type WatchCallback<T extends CRDResource> = (event: WatchEvent<T>) => void;

/**
 * Watch handle returned by startWatch
 */
export interface WatchHandle {
  /** Stop watching */
  stop(): void;
  /** Promise that resolves when the watch is done */
  done: Promise<void>;
}

/**
 * Start watching custom resources
 */
export function startWatch<T extends CRDResource>(
  kc: KubeConfig,
  config: CrudConfig,
  options: WatchOptions,
  callback: WatchCallback<T>
): WatchHandle;
```

---

## Lifecycle Helpers

File: `src/operations/lifecycle.ts`

```typescript
import type { KubeConfig } from '@kubernetes/client-node';
import type { Sandbox } from '../types/sandbox.js';
import type { CustomResourceCrud } from './crud.js';

/**
 * Options for waitForReady
 */
export interface WaitForReadyOptions {
  /** Sandbox name */
  name: string;
  /** Namespace */
  namespace: string;
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
}

/**
 * Wait for a sandbox to reach the Ready condition
 */
export async function waitForReady(
  crud: CustomResourceCrud<Sandbox>,
  options: WaitForReadyOptions
): Promise<Sandbox>;

/**
 * Pause a sandbox (set replicas to 0)
 */
export async function pause(
  crud: CustomResourceCrud<Sandbox>,
  namespace: string,
  name: string,
  reason?: string
): Promise<Sandbox>;

/**
 * Resume a paused sandbox (set replicas to 1)
 */
export async function resume(
  crud: CustomResourceCrud<Sandbox>,
  namespace: string,
  name: string
): Promise<Sandbox>;
```

---

## Client Orchestrator

File: `src/client.ts`

The `AgentSandboxClient` is the primary public API. It composes all operations into a single entry point.

```typescript
import type { KubeConfig } from '@kubernetes/client-node';
import type { Sandbox, SandboxList } from './types/sandbox.js';
import type { SandboxTemplate, SandboxTemplateList } from './types/template.js';
import type { SandboxClaim, SandboxClaimList } from './types/claim.js';
import type { SandboxWarmPool, SandboxWarmPoolList } from './types/warm-pool.js';
import type { ExecResult, ExecOptions, ExecStreamOptions, ExecStreamResult } from './types/exec.js';
import type { WatchOptions, WatchCallback, WatchHandle } from './operations/watch.js';
import type { WaitForReadyOptions } from './operations/lifecycle.js';

export interface AgentSandboxClientOptions {
  /** KubeConfig instance (auto-loaded if not provided) */
  kubeConfig?: KubeConfig;
  /** Default namespace for all operations */
  namespace?: string;
  /** KubeConfig loading options (used if kubeConfig not provided) */
  kubeconfigPath?: string;
  context?: string;
  skipTLSVerify?: boolean;
}

export class AgentSandboxClient {
  readonly kubeConfig: KubeConfig;
  readonly namespace: string;

  constructor(options?: AgentSandboxClientOptions);

  // --- Sandbox CRUD ---
  createSandbox(sandbox: Sandbox, namespace?: string): Promise<Sandbox>;
  getSandbox(name: string, namespace?: string): Promise<Sandbox>;
  listSandboxes(options?: { labelSelector?: string; namespace?: string }): Promise<SandboxList>;
  deleteSandbox(name: string, namespace?: string): Promise<void>;
  sandboxExists(name: string, namespace?: string): Promise<boolean>;

  // --- Sandbox Lifecycle ---
  waitForReady(name: string, options?: Partial<WaitForReadyOptions>): Promise<Sandbox>;
  pause(name: string, reason?: string, namespace?: string): Promise<Sandbox>;
  resume(name: string, namespace?: string): Promise<Sandbox>;

  // --- Exec ---
  exec(options: Omit<ExecOptions, 'namespace'> & { namespace?: string }): Promise<ExecResult>;
  execStream(options: Omit<ExecStreamOptions, 'namespace'> & { namespace?: string }): Promise<ExecStreamResult>;

  // --- SandboxTemplate CRUD ---
  createTemplate(template: SandboxTemplate, namespace?: string): Promise<SandboxTemplate>;
  getTemplate(name: string, namespace?: string): Promise<SandboxTemplate>;
  listTemplates(namespace?: string): Promise<SandboxTemplateList>;
  deleteTemplate(name: string, namespace?: string): Promise<void>;

  // --- SandboxClaim CRUD ---
  createClaim(claim: SandboxClaim, namespace?: string): Promise<SandboxClaim>;
  getClaim(name: string, namespace?: string): Promise<SandboxClaim>;
  listClaims(namespace?: string): Promise<SandboxClaimList>;
  deleteClaim(name: string, namespace?: string): Promise<void>;

  // --- SandboxWarmPool CRUD ---
  createWarmPool(pool: SandboxWarmPool, namespace?: string): Promise<SandboxWarmPool>;
  getWarmPool(name: string, namespace?: string): Promise<SandboxWarmPool>;
  listWarmPools(namespace?: string): Promise<SandboxWarmPoolList>;
  deleteWarmPool(name: string, namespace?: string): Promise<void>;

  // --- Watch ---
  watchSandboxes(callback: WatchCallback<Sandbox>, options?: Partial<WatchOptions>): WatchHandle;
  watchClaims(callback: WatchCallback<SandboxClaim>, options?: Partial<WatchOptions>): WatchHandle;

  // --- Health ---
  healthCheck(): Promise<{
    healthy: boolean;
    controllerInstalled: boolean;
    controllerVersion?: string;
    crdRegistered: boolean;
    namespace: string;
    namespaceExists: boolean;
    clusterVersion?: string;
  }>;
}
```

---

## Builders

### SandboxBuilder

File: `src/builders/sandbox.ts`

```typescript
export class SandboxBuilder {
  private resource: Partial<Sandbox>;

  constructor(name: string);

  namespace(ns: string): this;
  labels(labels: Record<string, string>): this;
  annotations(annotations: Record<string, string>): this;

  /** Use a SandboxTemplate by name */
  fromTemplate(name: string, namespace?: string): this;

  /** Inline pod template */
  withPodTemplate(template: V1PodTemplateSpec): this;

  /** Set container image */
  image(image: string): this;

  /** Set resource limits */
  resources(limits: { cpu: string; memory: string }): this;

  /** Set runtime class (e.g., "gvisor") */
  runtimeClass(name: string): this;

  /** Add volume claim */
  addVolumeClaim(claim: SandboxVolumeClaim): this;

  /** Set network policy */
  networkPolicy(policy: SandboxNetworkPolicy): this;

  /** Set replicas (0 = paused, 1 = running) */
  replicas(count: number): this;

  /** Set TTL after completion */
  ttl(seconds: number): this;

  /** Add AgentPane project/task annotations */
  agentPaneContext(ctx: { projectId: string; taskId?: string; sandboxId?: string }): this;

  /** Build the Sandbox resource */
  build(): Sandbox;
}
```

### SandboxTemplateBuilder

File: `src/builders/template.ts`

```typescript
export class SandboxTemplateBuilder {
  constructor(name: string);

  namespace(ns: string): this;
  labels(labels: Record<string, string>): this;

  /** Set the pod template */
  podTemplate(template: V1PodTemplateSpec): this;

  /** Set container image */
  image(image: string): this;

  /** Set resource limits */
  resources(limits: { cpu: string; memory: string }): this;

  /** Set runtime class */
  runtimeClass(name: string): this;

  /** Set network policy */
  networkPolicy(policy: SandboxNetworkPolicy): this;

  /** Add volume claim template */
  addVolumeClaim(claim: SandboxVolumeClaim): this;

  /** Build the SandboxTemplate resource */
  build(): SandboxTemplate;
}
```

### SandboxClaimBuilder

File: `src/builders/claim.ts`

```typescript
export class SandboxClaimBuilder {
  constructor(name: string);

  namespace(ns: string): this;
  labels(labels: Record<string, string>): this;

  /** Reference the template */
  templateRef(name: string, namespace?: string): this;

  /** Reference a warm pool */
  warmPoolRef(name: string, namespace?: string): this;

  /** Build the SandboxClaim resource */
  build(): SandboxClaim;
}
```

### SandboxWarmPoolBuilder

File: `src/builders/warm-pool.ts`

```typescript
export class SandboxWarmPoolBuilder {
  constructor(name: string);

  namespace(ns: string): this;
  labels(labels: Record<string, string>): this;

  /** Set desired replica count */
  replicas(count: number): this;

  /** Reference the template */
  templateRef(name: string, namespace?: string): this;

  /** Set autoscaling bounds */
  autoscale(min: number, max: number): this;

  /** Build the SandboxWarmPool resource */
  build(): SandboxWarmPool;
}
```

---

## Zod Schemas

File: `src/schemas/sandbox.ts` (and analogous files for template, claim, warm-pool)

```typescript
import { z } from 'zod';

export const sandboxNetworkRuleSchema = z.object({
  ports: z.array(z.object({
    port: z.number(),
    protocol: z.string(),
  })).optional(),
  to: z.array(z.object({
    ipBlock: z.object({
      cidr: z.string(),
      except: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
  from: z.array(z.object({
    ipBlock: z.object({
      cidr: z.string(),
      except: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
});

export const sandboxVolumeClaimSchema = z.object({
  name: z.string(),
  storageClassName: z.string().optional(),
  accessModes: z.array(z.string()),
  resources: z.object({
    requests: z.object({
      storage: z.string(),
    }),
  }),
});

export const sandboxSpecSchema = z.object({
  sandboxTemplateRef: z.object({
    name: z.string(),
    namespace: z.string().optional(),
  }).optional(),
  podTemplate: z.any().optional(),
  replicas: z.number().int().min(0).max(1).optional(),
  networkPolicy: z.object({
    egress: z.array(sandboxNetworkRuleSchema).optional(),
    ingress: z.array(sandboxNetworkRuleSchema).optional(),
  }).optional(),
  volumeClaims: z.array(sandboxVolumeClaimSchema).optional(),
  runtimeClassName: z.string().optional(),
  ttlSecondsAfterFinished: z.number().int().positive().optional(),
});

export const sandboxStatusSchema = z.object({
  phase: z.enum(['Pending', 'Running', 'Paused', 'Succeeded', 'Failed', 'Unknown']).optional(),
  conditions: z.array(z.any()).optional(),
  podName: z.string().optional(),
  serviceFQDN: z.string().optional(),
  podIP: z.string().optional(),
  readyReplicas: z.number().optional(),
  readyAt: z.string().optional(),
});

export const sandboxSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('Sandbox'),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string()).optional(),
    annotations: z.record(z.string()).optional(),
  }),
  spec: sandboxSpecSchema,
  status: sandboxStatusSchema.optional(),
});
```

---

## Error Types

File: `src/errors.ts`

```typescript
/**
 * Base SDK error
 */
export class AgentSandboxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentSandboxError';
  }
}

/**
 * Resource not found
 */
export class NotFoundError extends AgentSandboxError {
  constructor(kind: string, name: string, namespace?: string) {
    super(
      `${kind} "${name}" not found${namespace ? ` in namespace "${namespace}"` : ''}`,
      'NOT_FOUND',
      404,
      { kind, name, namespace }
    );
    this.name = 'NotFoundError';
  }
}

/**
 * Resource already exists
 */
export class AlreadyExistsError extends AgentSandboxError {
  constructor(kind: string, name: string) {
    super(`${kind} "${name}" already exists`, 'ALREADY_EXISTS', 409, { kind, name });
    this.name = 'AlreadyExistsError';
  }
}

/**
 * Timeout waiting for condition
 */
export class TimeoutError extends AgentSandboxError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      408,
      { operation, timeoutMs }
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Exec operation failed
 */
export class ExecError extends AgentSandboxError {
  constructor(command: string, message: string, exitCode?: number) {
    super(
      `Exec failed for "${command}": ${message}`,
      'EXEC_FAILED',
      500,
      { command, exitCode }
    );
    this.name = 'ExecError';
  }
}

/**
 * CRD controller not installed
 */
export class ControllerNotInstalledError extends AgentSandboxError {
  constructor() {
    super(
      'Agent Sandbox CRD controller is not installed in the cluster',
      'CONTROLLER_NOT_INSTALLED',
      503
    );
    this.name = 'ControllerNotInstalledError';
  }
}

/**
 * KubeConfig errors
 */
export class KubeConfigError extends AgentSandboxError {
  constructor(message: string) {
    super(message, 'KUBECONFIG_ERROR', 500);
    this.name = 'KubeConfigError';
  }
}
```

---

## Package Configuration

### `package.json`

```json
{
  "name": "@agentpane/agent-sandbox-sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for the kubernetes-sigs Agent Sandbox CRD (agents.x-k8s.io/v1alpha1)",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist/", "README.md"],
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "prepublishOnly": "bun run test && bun run build"
  },
  "peerDependencies": {
    "@kubernetes/client-node": ">=0.21.0 <2.0.0",
    "zod": ">=3.0.0"
  },
  "devDependencies": {
    "@kubernetes/client-node": "^1.4.0",
    "zod": "^4.3.6",
    "typescript": "^5.8.0",
    "vitest": "^4.0.0",
    "@biomejs/biome": "^2.3.0"
  },
  "publishConfig": {
    "access": "public"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/agentpane/agentpane",
    "directory": "packages/agent-sandbox-sdk"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/"],
  "exclude": ["__tests__/", "dist/"]
}
```

---

## Test Strategy

| Test Suite | File | What It Covers |
|-----------|------|----------------|
| CRUD operations | `__tests__/crud.test.ts` | create, get, list, update, patch, delete with mocked K8s API |
| Exec operations | `__tests__/exec.test.ts` | Buffered exec, streaming exec, timeout, exit code parsing |
| Builders | `__tests__/builders.test.ts` | All four builders produce valid resources, chaining works |
| Schemas | `__tests__/schemas.test.ts` | Zod schemas accept valid data, reject malformed data |
| KubeConfig | `__tests__/kubeconfig.test.ts` | 5-tier discovery, context resolution, TLS skip |
| Client | `__tests__/client.test.ts` | AgentSandboxClient orchestrates operations, health check |

All tests mock `@kubernetes/client-node` APIs. Integration tests requiring a live cluster are in the main repo under `tests/e2e/k8s/` (see [minikube-setup-guide.md](./minikube-setup-guide.md)).
