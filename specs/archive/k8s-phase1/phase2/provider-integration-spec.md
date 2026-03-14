# Provider Integration Spec: AgentSandboxProvider, ContainerAgentService, and Settings UI

> **Status**: Draft
> **Created**: 2026-02-12
> **Part of**: Phase 2 -- Agent Sandbox CRD Integration
> **Depends On**: `@agentpane/agent-sandbox-sdk` ([agent-sandbox-sdk-spec.md](./agent-sandbox-sdk-spec.md))

---

## Table of Contents

1. [Overview](#1-overview)
2. [AgentSandboxProvider](#2-agentsandboxprovider)
   - 2.1 [File Layout](#21-file-layout)
   - 2.2 [Constructor and Configuration](#22-constructor-and-configuration)
   - 2.3 [SandboxProvider Interface Implementation](#23-sandboxprovider-interface-implementation)
   - 2.4 [Event Emission](#24-event-emission)
   - 2.5 [Warm Pool Management](#25-warm-pool-management)
3. [AgentSandboxInstance](#3-agentsandboxinstance)
   - 3.1 [Constructor](#31-constructor)
   - 3.2 [Sandbox Interface Implementation](#32-sandbox-interface-implementation)
   - 3.3 [execStream Implementation](#33-execstream-implementation)
   - 3.4 [tmux Methods](#34-tmux-methods)
   - 3.5 [Metrics](#35-metrics)
4. [ContainerAgentService Integration](#4-containeragentservice-integration)
   - 4.1 [Key Insight: Zero Changes Required](#41-key-insight-zero-changes-required)
   - 4.2 [execStream Data Flow](#42-execstream-data-flow)
   - 4.3 [Contract Verification](#43-contract-verification)
5. [api.ts Provider Wiring Changes](#5-apits-provider-wiring-changes)
   - 5.1 [Current Code (Before)](#51-current-code-before)
   - 5.2 [New Code (After)](#52-new-code-after)
   - 5.3 [Settings Key Schema](#53-settings-key-schema)
6. [Settings UI Updates](#6-settings-ui-updates)
   - 6.1 [New UI Elements](#61-new-ui-elements)
   - 6.2 [CRD Controller Status API](#62-crd-controller-status-api)
   - 6.3 [Runtime Class Selector](#63-runtime-class-selector)
   - 6.4 [Warm Pool Controls](#64-warm-pool-controls)
   - 6.5 [Updated Test Connection](#65-updated-test-connection)
7. [What Gets Archived](#7-what-gets-archived)
8. [Test Plan](#8-test-plan)

---

## 1. Overview

This spec covers three tightly coupled deliverables from the Phase 2 plan:

| # | Deliverable | Scope |
|---|-------------|-------|
| 2 | `AgentSandboxProvider` | New `EventEmittingSandboxProvider` implementation using the Agent Sandbox CRD SDK |
| 3 | ContainerAgentService integration | Provider-agnostic wiring: zero changes to ContainerAgentService itself |
| 4 | Settings UI updates | CRD controller status, runtime class selector, warm pool controls |

The core principle is **interface compliance**. The existing `SandboxProvider` and `Sandbox` interfaces (defined in `src/lib/sandbox/providers/sandbox-provider.ts`) are the contract. `ContainerAgentService` already programs to these interfaces. By implementing a new provider that fulfills the same contract, the entire agent execution pipeline works without modification.

### What Gets Replaced

The following 8 Phase 1 files (~4,300 LOC) are replaced by 2 new files (~500-800 LOC) plus the SDK package:

| Phase 1 File | LOC | Replaced By |
|-------------|-----|-------------|
| `k8s-provider.ts` | ~800 | `AgentSandboxProvider` + SDK `client.ts` |
| `k8s-sandbox.ts` | ~350 | `AgentSandboxInstance` + SDK `exec.ts` |
| `k8s-config.ts` | ~200 | SDK KubeConfig handling |
| `k8s-network-policy.ts` | ~400 | CRD controller (via SandboxTemplate) |
| `k8s-rbac.ts` | ~500 | CRD controller (RBAC installed with controller) |
| `k8s-security.ts` | ~600 | CRD controller (PodSecurityStandards in template) |
| `k8s-audit.ts` | ~450 | CRD controller audit logs + K8s events |
| `k8s-warm-pool.ts` | ~1000 | `SandboxWarmPool` CRD resource |

### Key References

| File | Path | Relevance |
|------|------|-----------|
| SandboxProvider interfaces | `src/lib/sandbox/providers/sandbox-provider.ts` | Interfaces to implement (lines 1-200) |
| DockerProvider (reference impl) | `src/lib/sandbox/providers/docker-provider.ts` | Pattern to follow for events, execStream, shell escaping |
| K8sSandbox (tmux patterns) | `src/lib/sandbox/providers/k8s-sandbox.ts:164-346` | tmux code to reuse verbatim |
| ContainerAgentService | `src/services/container-agent.service.ts` | Consumer of SandboxProvider; integration point at line 901 |
| api.ts provider wiring | `src/server/api.ts:525-652` | Docker-only block to replace |
| Sandbox settings UI | `src/app/routes/settings/sandbox.tsx` | UI to update (1738 lines) |
| Sandbox types | `src/lib/sandbox/types.ts` | `SandboxProvider` type union (line 86), `SandboxConfig`, `SANDBOX_DEFAULTS` |
| K8s error catalog | `src/lib/errors/k8s-errors.ts` | Error factory functions (retained, not archived) |

---

## 2. AgentSandboxProvider

### 2.1 File Layout

```
src/lib/sandbox/providers/
├── agent-sandbox-provider.ts       # AgentSandboxProvider class (NEW)
├── agent-sandbox-instance.ts       # AgentSandboxInstance class (NEW)
├── docker-provider.ts              # Existing Docker provider (UNCHANGED)
├── sandbox-provider.ts             # Existing interfaces (UNCHANGED)
└── __tests__/
    └── agent-sandbox-provider.test.ts  # (NEW)
```

### 2.2 Constructor and Configuration

```typescript
// src/lib/sandbox/providers/agent-sandbox-provider.ts

import { createId } from '@paralleldrive/cuid2';
import type { AgentSandboxClient } from '@agentpane/agent-sandbox-sdk';
import { createAgentSandboxClient, SandboxBuilder } from '@agentpane/agent-sandbox-sdk';
import { K8sErrors } from '../../errors/k8s-errors.js';
import type {
  SandboxConfig,
  SandboxHealthCheck,
  SandboxInfo,
  SandboxStatus,
} from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import type {
  EventEmittingSandboxProvider,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';
import { AgentSandboxInstance } from './agent-sandbox-instance.js';

/**
 * Runtime class for sandbox pod isolation.
 * - 'gvisor': Uses gVisor (runsc) for user-space kernel isolation
 * - 'kata': Uses Kata Containers for VM-based isolation
 * - 'none': Uses the cluster default runtime (typically runc)
 */
export type RuntimeClassName = 'gvisor' | 'kata' | 'none';

/**
 * Configuration for AgentSandboxProvider.
 */
export interface AgentSandboxProviderOptions {
  /** Kubernetes namespace for sandbox resources. Default: 'agentpane-sandboxes' */
  namespace?: string;

  /** Path to kubeconfig file. Default: standard kubeconfig discovery */
  kubeConfigPath?: string;

  /** Kubernetes context to use. Default: current context */
  kubeContext?: string;

  /** Enable warm pool for fast sandbox allocation. Default: false */
  enableWarmPool?: boolean;

  /** Number of pre-warmed sandboxes to maintain. Default: 2 */
  warmPoolSize?: number;

  /** Runtime class for sandbox isolation. Default: 'none' */
  runtimeClassName?: RuntimeClassName;

  /** Container image for sandbox pods. Default: SANDBOX_DEFAULTS.image */
  image?: string;

  /** Timeout in seconds for sandbox to reach Ready state. Default: 120 */
  readyTimeoutSeconds?: number;
}

const PROVIDER_DEFAULTS = {
  namespace: 'agentpane-sandboxes',
  enableWarmPool: false,
  warmPoolSize: 2,
  runtimeClassName: 'none' as RuntimeClassName,
  readyTimeoutSeconds: 120,
} as const;

/**
 * Kubernetes sandbox provider using the Agent Sandbox CRD.
 *
 * Replaces the Phase 1 K8sProvider (~4300 LOC across 8 files) with a
 * CRD-based approach that delegates pod lifecycle, network policy,
 * warm pool, and security to the cluster controller.
 *
 * Implements EventEmittingSandboxProvider so it can be used as a
 * drop-in replacement for DockerProvider in ContainerAgentService.
 */
export class AgentSandboxProvider implements EventEmittingSandboxProvider {
  readonly name = 'kubernetes';

  private readonly client: AgentSandboxClient;
  private readonly namespace: string;
  private readonly runtimeClassName: RuntimeClassName;
  private readonly image: string;
  private readonly enableWarmPool: boolean;
  private readonly warmPoolSize: number;
  private readonly readyTimeoutSeconds: number;

  private sandboxes = new Map<string, AgentSandboxInstance>();
  private projectToSandbox = new Map<string, string>();
  private listeners = new Set<SandboxProviderEventListener>();

  constructor(options: AgentSandboxProviderOptions = {}) {
    this.namespace = options.namespace ?? PROVIDER_DEFAULTS.namespace;
    this.runtimeClassName = options.runtimeClassName ?? PROVIDER_DEFAULTS.runtimeClassName;
    this.image = options.image ?? SANDBOX_DEFAULTS.image;
    this.enableWarmPool = options.enableWarmPool ?? PROVIDER_DEFAULTS.enableWarmPool;
    this.warmPoolSize = options.warmPoolSize ?? PROVIDER_DEFAULTS.warmPoolSize;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? PROVIDER_DEFAULTS.readyTimeoutSeconds;

    // Create the Agent Sandbox SDK client
    this.client = createAgentSandboxClient({
      namespace: this.namespace,
      kubeConfigPath: options.kubeConfigPath,
      kubeContext: options.kubeContext,
    });
  }

  // ... methods defined in subsequent sections
}

/**
 * Factory function (mirrors createDockerProvider pattern from docker-provider.ts:854).
 */
export function createAgentSandboxProvider(
  options?: AgentSandboxProviderOptions
): AgentSandboxProvider {
  return new AgentSandboxProvider(options);
}
```

### 2.3 SandboxProvider Interface Implementation

Each method below implements one method from the `SandboxProvider` interface defined in `src/lib/sandbox/providers/sandbox-provider.ts:124-167`.

#### `create(config: SandboxConfig): Promise<Sandbox>`

```typescript
async create(config: SandboxConfig): Promise<Sandbox> {
  // Check for existing sandbox for this project
  // (mirrors DockerProvider.create at docker-provider.ts:527-535)
  const existing = this.projectToSandbox.get(config.projectId);
  if (existing) {
    const sandbox = this.sandboxes.get(existing);
    if (sandbox && sandbox.status !== 'stopped') {
      throw K8sErrors.POD_ALREADY_EXISTS(config.projectId);
    }
  }

  const sandboxId = createId();
  // CRD sandbox names must be DNS-1123 compliant
  const sandboxName = `agentpane-${config.projectId.slice(0, 20)}-${sandboxId.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');

  this.emit({
    type: 'sandbox:creating',
    sandboxId,
    projectId: config.projectId,
  });

  try {
    // Build the Sandbox CRD manifest using SandboxBuilder from the SDK.
    // This replaces the manual pod spec building in k8s-provider.ts:873-955.
    const builder = new SandboxBuilder(sandboxName, this.namespace)
      .setImage(config.image)
      .setResources({
        limits: {
          memory: `${config.memoryMb}Mi`,
          cpu: `${config.cpuCores}`,
        },
        requests: {
          memory: `${Math.floor(config.memoryMb / 2)}Mi`,
          cpu: `${config.cpuCores / 2}`,
        },
      })
      .setLabels({
        'agentpane.io/sandbox-id': sandboxId,
        'agentpane.io/project-id': config.projectId,
      })
      .setWorkingDir('/workspace');

    // Configure runtime class for isolation (gvisor, kata, or default runc)
    if (this.runtimeClassName !== 'none') {
      builder.setRuntimeClassName(this.runtimeClassName);
    }

    // Configure workspace volume from projectPath
    // This replaces the buildWorkspaceVolume logic in k8s-provider.ts:960-984
    builder.addHostPathVolume('workspace', config.projectPath, '/workspace');

    // Add additional volume mounts from SandboxConfig
    for (const mount of config.volumeMounts) {
      const volName = `vol-${mount.containerPath.replace(/\//g, '-').slice(1)}`;
      builder.addHostPathVolume(
        volName,
        mount.hostPath,
        mount.containerPath,
        mount.readonly
      );
    }

    // Set environment variables
    if (config.env) {
      builder.setEnv(config.env);
    }

    // Set idle timeout via CRD TTL (the controller handles cleanup)
    builder.setTTLSecondsAfterIdle(config.idleTimeoutMinutes * 60);

    // Apply the CRD manifest to the cluster
    const manifest = builder.build();
    await this.client.create(manifest);

    // Wait for the sandbox to reach Ready status.
    // The CRD controller creates the pod, sets up networking, and reports Ready.
    // This replaces the waitForPodRunning loop in k8s-provider.ts:1056-1097.
    await this.client.waitForReady(sandboxName, {
      timeoutSeconds: this.readyTimeoutSeconds,
    });

    // Create the Sandbox interface wrapper
    const instance = new AgentSandboxInstance(
      sandboxId,
      sandboxName,
      config.projectId,
      this.namespace,
      this.client,
    );

    this.sandboxes.set(sandboxId, instance);
    this.projectToSandbox.set(config.projectId, sandboxId);

    this.emit({
      type: 'sandbox:created',
      sandboxId,
      projectId: config.projectId,
      containerId: sandboxName, // CRD sandbox name serves as container ID
    });

    this.emit({ type: 'sandbox:started', sandboxId });

    return instance;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.emit({
      type: 'sandbox:error',
      sandboxId,
      error: error instanceof Error ? error : new Error(message),
    });
    throw K8sErrors.POD_CREATION_FAILED(sandboxName, message);
  }
}
```

#### `get(projectId: string): Promise<Sandbox | null>`

```typescript
async get(projectId: string): Promise<Sandbox | null> {
  // Check in-memory cache first (same pattern as DockerProvider.get)
  const sandboxId = this.projectToSandbox.get(projectId);
  if (sandboxId) {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  // Fall through to cluster query using label selector.
  // This is the CRD equivalent of DockerProvider scanning containers.
  try {
    const sandboxes = await this.client.list({
      labelSelector: `agentpane.io/project-id=${projectId}`,
    });

    if (sandboxes.length === 0) {
      return null;
    }

    // Take the first active sandbox for this project
    const crdSandbox = sandboxes[0];
    const id = crdSandbox.metadata?.labels?.['agentpane.io/sandbox-id'] ?? createId();
    const name = crdSandbox.metadata?.name ?? '';

    const instance = new AgentSandboxInstance(
      id,
      name,
      projectId,
      this.namespace,
      this.client,
    );

    // Cache it
    this.sandboxes.set(id, instance);
    this.projectToSandbox.set(projectId, id);

    return instance;
  } catch {
    return null;
  }
}
```

#### `getById(sandboxId: string): Promise<Sandbox | null>`

```typescript
async getById(sandboxId: string): Promise<Sandbox | null> {
  return this.sandboxes.get(sandboxId) ?? null;
}
```

#### `list(): Promise<SandboxInfo[]>`

```typescript
async list(): Promise<SandboxInfo[]> {
  try {
    const crdSandboxes = await this.client.list({
      labelSelector: 'agentpane.io/sandbox-id',
    });

    return crdSandboxes.map((s) => ({
      id: s.metadata?.labels?.['agentpane.io/sandbox-id'] ?? '',
      projectId: s.metadata?.labels?.['agentpane.io/project-id'] ?? '',
      containerId: s.metadata?.name ?? '',
      status: this.mapCrdPhase(s.status?.phase),
      image: s.spec?.containers?.[0]?.image ?? this.image,
      createdAt: s.metadata?.creationTimestamp ?? new Date().toISOString(),
      lastActivityAt: s.status?.lastActivityTime ?? new Date().toISOString(),
      memoryMb: this.parseMemoryMi(s.spec?.containers?.[0]?.resources?.limits?.memory),
      cpuCores: parseFloat(s.spec?.containers?.[0]?.resources?.limits?.cpu ?? '0'),
    }));
  } catch (error) {
    console.error('[AgentSandboxProvider] Failed to list sandboxes:', error);
    return [];
  }
}

/**
 * Map CRD phase string to SandboxStatus type.
 *
 * CRD phases: Pending, Running, Paused, Succeeded, Failed
 * SandboxStatus (from types.ts:6): 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
 */
private mapCrdPhase(phase?: string): SandboxStatus {
  switch (phase) {
    case 'Running':   return 'running';
    case 'Pending':   return 'creating';
    case 'Paused':    return 'idle';
    case 'Failed':    return 'error';
    case 'Succeeded': return 'stopped';
    default:          return 'creating';
  }
}

private parseMemoryMi(memoryStr?: string): number {
  if (!memoryStr) return 0;
  const match = memoryStr.match(/^(\d+)Mi$/);
  return match ? parseInt(match[1], 10) : 0;
}
```

#### `pullImage(image: string): Promise<void>`

```typescript
async pullImage(image: string): Promise<void> {
  // Kubernetes pulls images on pod scheduling. The CRD controller
  // handles imagePullPolicy. No pre-pull needed at the provider level.
  // (Same approach as K8sProvider.pullImage at k8s-provider.ts:337-354)
  if (!image || image.trim() === '') {
    throw K8sErrors.IMAGE_NOT_FOUND(image);
  }
}
```

#### `isImageAvailable(image: string): Promise<boolean>`

```typescript
async isImageAvailable(image: string): Promise<boolean> {
  // CRD controller handles image pulls. Assume available if non-empty.
  // (Same approach as K8sProvider.isImageAvailable at k8s-provider.ts:356-363)
  return image !== undefined && image.trim() !== '';
}
```

#### `healthCheck(): Promise<SandboxHealthCheck>`

```typescript
async healthCheck(): Promise<SandboxHealthCheck> {
  try {
    // 1. Check cluster connectivity
    const clusterHealth = await this.client.healthCheck();
    if (!clusterHealth.healthy) {
      return {
        healthy: false,
        message: clusterHealth.message ?? 'Cluster not reachable',
        details: { provider: 'kubernetes' },
      };
    }

    // 2. Check CRD controller is installed
    const controllerStatus = await this.client.getControllerStatus();

    // 3. Check namespace exists
    const namespaceExists = await this.client.namespaceExists(this.namespace);

    // 4. Check warm pool status if enabled
    let warmPoolStatus: Record<string, unknown> | undefined;
    if (this.enableWarmPool) {
      try {
        const pool = await this.client.getWarmPool(this.namespace);
        warmPoolStatus = {
          enabled: true,
          desiredSize: pool?.spec?.size ?? 0,
          readyReplicas: pool?.status?.readyReplicas ?? 0,
        };
      } catch {
        warmPoolStatus = { enabled: true, error: 'WarmPool not found' };
      }
    }

    // 5. Count sandbox resources in namespace
    let sandboxCount = 0;
    let runningSandboxCount = 0;
    if (namespaceExists) {
      const sandboxes = await this.client.list({
        labelSelector: 'agentpane.io/sandbox-id',
      });
      sandboxCount = sandboxes.length;
      runningSandboxCount = sandboxes.filter(
        (s) => s.status?.phase === 'Running'
      ).length;
    }

    return {
      healthy: controllerStatus.installed,
      message: controllerStatus.installed
        ? undefined
        : 'Agent Sandbox CRD controller is not installed. ' +
          'Install from https://github.com/kubernetes-sigs/agent-sandbox',
      details: {
        provider: 'kubernetes',
        controller: {
          installed: controllerStatus.installed,
          version: controllerStatus.version,
          crdVersion: controllerStatus.crdVersion,
        },
        namespace: this.namespace,
        namespaceExists,
        sandboxes: sandboxCount,
        sandboxesRunning: runningSandboxCount,
        warmPool: warmPoolStatus ?? { enabled: false },
        runtimeClassName: this.runtimeClassName,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      healthy: false,
      message: `Kubernetes health check failed: ${message}`,
      details: {
        provider: 'kubernetes',
        namespace: this.namespace,
      },
    };
  }
}
```

#### `cleanup(options?): Promise<number>`

```typescript
async cleanup(options?: { olderThan?: Date; status?: string[] }): Promise<number> {
  let cleaned = 0;

  for (const [sandboxId, instance] of this.sandboxes) {
    const shouldClean =
      (options?.status?.includes(instance.status) ?? instance.status === 'stopped') &&
      (!options?.olderThan || instance.getLastActivity() < options.olderThan);

    if (shouldClean) {
      try {
        if (instance.status !== 'stopped') {
          await instance.stop();
        }

        this.sandboxes.delete(sandboxId);
        this.projectToSandbox.delete(instance.projectId);
        cleaned++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[AgentSandboxProvider] Failed to cleanup sandbox ${sandboxId}:`,
          message
        );
      }
    }
  }

  return cleaned;
}
```

### 2.4 Event Emission

Identical pattern to `DockerProvider` (see `src/lib/sandbox/providers/docker-provider.ts:831-848`):

```typescript
on(listener: SandboxProviderEventListener): () => void {
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
}

off(listener: SandboxProviderEventListener): void {
  this.listeners.delete(listener);
}

private emit(event: SandboxProviderEvent): void {
  for (const listener of this.listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[AgentSandboxProvider] Event listener error:', error);
    }
  }
}
```

### 2.5 Warm Pool Management

The warm pool is managed via the `SandboxWarmPool` CRD, not application code. This replaces the ~1000 LOC `k8s-warm-pool.ts` with a single CRD resource. The provider exposes an initialization method called during startup:

```typescript
/**
 * Initialize the warm pool by creating or updating the SandboxWarmPool CRD.
 * Called during provider initialization if enableWarmPool is true.
 *
 * The CRD controller handles all warm pool lifecycle:
 * - Maintaining the desired number of pre-warmed sandboxes
 * - Draining and replacing unhealthy sandboxes
 * - HPA-compatible scaling
 *
 * This replaces the manual warm pool management in k8s-warm-pool.ts.
 */
async initWarmPool(): Promise<void> {
  if (!this.enableWarmPool) {
    return;
  }

  const warmPoolName = 'agentpane-warm-pool';

  await this.client.createOrUpdateWarmPool({
    metadata: {
      name: warmPoolName,
      namespace: this.namespace,
    },
    spec: {
      size: this.warmPoolSize,
      template: {
        spec: {
          image: this.image,
          runtimeClassName:
            this.runtimeClassName !== 'none' ? this.runtimeClassName : undefined,
          resources: {
            limits: {
              memory: `${SANDBOX_DEFAULTS.memoryMb}Mi`,
              cpu: `${SANDBOX_DEFAULTS.cpuCores}`,
            },
            requests: {
              memory: `${Math.floor(SANDBOX_DEFAULTS.memoryMb / 2)}Mi`,
              cpu: `${SANDBOX_DEFAULTS.cpuCores / 2}`,
            },
          },
        },
      },
    },
  });

  console.log(
    `[AgentSandboxProvider] Warm pool initialized: ${warmPoolName} ` +
    `(size=${this.warmPoolSize})`
  );
}
```

---

## 3. AgentSandboxInstance

### 3.1 Constructor

```typescript
// src/lib/sandbox/providers/agent-sandbox-instance.ts

import { PassThrough, type Readable } from 'node:stream';
import type { AgentSandboxClient } from '@agentpane/agent-sandbox-sdk';
import { K8sErrors } from '../../errors/k8s-errors.js';
import type {
  ExecResult,
  SandboxMetrics,
  SandboxStatus,
  TmuxSession,
} from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import type {
  ExecStreamOptions,
  ExecStreamResult,
  Sandbox,
} from './sandbox-provider.js';

/**
 * Sandbox instance backed by an Agent Sandbox CRD resource.
 *
 * Implements the Sandbox interface (sandbox-provider.ts:45-118) by delegating
 * to the SDK client's exec and lifecycle methods. The CRD controller manages
 * the underlying pod; this class provides the application-layer abstraction.
 */
export class AgentSandboxInstance implements Sandbox {
  private _lastActivity: Date;
  private _status: SandboxStatus = 'running';

  constructor(
    /** Unique sandbox ID (cuid2) */
    public readonly id: string,
    /** CRD sandbox resource name (also serves as containerId) */
    private readonly sandboxName: string,
    /** Project this sandbox belongs to */
    public readonly projectId: string,
    /** Kubernetes namespace */
    private readonly namespace: string,
    /** Agent Sandbox SDK client */
    private readonly client: AgentSandboxClient,
  ) {
    this._lastActivity = new Date();
  }

  /**
   * Maps to the CRD sandbox name for interface compatibility.
   * The Sandbox interface requires a containerId; for CRD sandboxes
   * the resource name serves this purpose.
   */
  get containerId(): string {
    return this.sandboxName;
  }

  get status(): SandboxStatus {
    return this._status;
  }
}
```

### 3.2 Sandbox Interface Implementation

#### `exec(cmd, args)` and `execAsRoot(cmd, args)`

```typescript
async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
  this.touch();

  try {
    const result = await this.client.exec(this.sandboxName, {
      command: [cmd, ...args],
      container: 'sandbox',
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw K8sErrors.EXEC_FAILED(cmd, message);
  }
}

async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
  // CRD sandboxes run as non-root (UID 1000) by default.
  // Root execution is not supported -- same behavior as K8sSandbox.execAsRoot
  // at k8s-sandbox.ts:73-87.
  console.warn(
    '[AgentSandboxInstance] execAsRoot called but CRD sandboxes run as non-root. ' +
    'Executing as default user.'
  );
  return this.exec(cmd, args);
}
```

#### `stop()`

```typescript
async stop(): Promise<void> {
  this._status = 'stopping';

  try {
    // Delete the Sandbox CRD resource. The controller handles pod cleanup,
    // network policy removal, and any associated PVC cleanup.
    await this.client.delete(this.sandboxName);
    this._status = 'stopped';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this._status = 'error';
    throw K8sErrors.POD_DELETION_FAILED(this.sandboxName, message);
  }
}
```

### 3.3 execStream Implementation

This is the **critical integration point**. `ContainerAgentService` calls `sandbox.execStream()` at line 901 of `src/services/container-agent.service.ts` to start the agent-runner process inside the sandbox. The return value must conform to the `ExecStreamResult` interface defined in `sandbox-provider.ts:30-39`.

The implementation follows the same shell-escape and `sh -c "cd <cwd> && exec <cmd>"` pattern used by `DockerSandbox.execStream()` (see `src/lib/sandbox/providers/docker-provider.ts:271-400`):

```typescript
/**
 * Escape a string for safe use in shell commands.
 * Uses single quotes and handles embedded single quotes.
 * Matches the DockerSandbox.shellEscape pattern (docker-provider.ts:261-264).
 */
private shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute a command with streaming output.
 *
 * Builds the same kind of `sh -c "cd <cwd> && exec <cmd> <args>"` shell
 * command that DockerSandbox uses (docker-provider.ts:279-288), then delegates
 * to the SDK's execStream which manages the K8s Exec WebSocket.
 *
 * Returns PassThrough streams for stdout/stderr, matching the ExecStreamResult
 * contract that ContainerAgentService.startAgent() relies on:
 *
 *   // container-agent.service.ts:901
 *   const execResult = await sandbox.execStream({
 *     cmd: 'node',
 *     args: ['/opt/agent-runner/dist/index.js'],
 *     env: { ...env, CLAUDE_OAUTH_TOKEN: oauthToken, AGENT_PROMPT: prompt },
 *     cwd: worktreePath,
 *   });
 */
async execStream(options: ExecStreamOptions): Promise<ExecStreamResult> {
  this.touch();

  const { cmd, args = [], env = {}, cwd } = options;

  // Build the command with cwd handling.
  // When cwd is specified, use sh -c to handle the cd + exec pattern.
  // This matches DockerSandbox.execStream (docker-provider.ts:279-288).
  let fullCmd: string[];
  if (cwd) {
    const escapedCwd = this.shellEscape(cwd);
    const escapedCmd = this.shellEscape(cmd);
    const escapedArgs = args.map((arg) => this.shellEscape(arg)).join(' ');
    fullCmd = ['sh', '-c', `cd ${escapedCwd} && exec ${escapedCmd} ${escapedArgs}`];
  } else {
    // Without cwd, pass command directly without shell (safer)
    fullCmd = [cmd, ...args];
  }

  // Build environment variables for the exec.
  // K8s exec doesn't support setting env vars directly on the exec call,
  // so we prefix the command with env assignments in the shell.
  const envEntries = Object.entries(env);
  if (envEntries.length > 0) {
    const envPrefix = envEntries
      .map(([k, v]) => `${k}=${this.shellEscape(v)}`)
      .join(' ');

    if (fullCmd[0] === 'sh' && fullCmd[1] === '-c') {
      // Already wrapped in shell -- inject env into the shell command
      fullCmd = ['sh', '-c', `${envPrefix} ${fullCmd[2]}`];
    } else {
      // Wrap with env command
      fullCmd = ['env', ...envEntries.map(([k, v]) => `${k}=${v}`), ...fullCmd];
    }
  }

  // Create PassThrough streams for stdout and stderr.
  // These are the streams that ContainerBridge.processStream reads from.
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  let killed = false;

  // Delegate to the SDK's execStream which manages the K8s Exec WebSocket.
  // The SDK returns streams and wait/kill methods.
  const sdkStream = await this.client.execStream(this.sandboxName, {
    command: fullCmd,
    container: 'sandbox',
  });

  // Pipe SDK output to our PassThrough streams
  sdkStream.stdout.on('data', (chunk: Buffer) => {
    if (!killed) {
      stdoutStream.write(chunk);
    }
  });

  sdkStream.stderr.on('data', (chunk: Buffer) => {
    if (!killed) {
      stderrStream.write(chunk);
    }
  });

  sdkStream.stdout.on('end', () => {
    if (!killed) {
      stdoutStream.end();
    }
  });

  sdkStream.stderr.on('end', () => {
    if (!killed) {
      stderrStream.end();
    }
  });

  sdkStream.stdout.on('error', (err: Error) => {
    stdoutStream.destroy(err);
  });

  sdkStream.stderr.on('error', (err: Error) => {
    stderrStream.destroy(err);
  });

  return {
    stdout: stdoutStream as Readable,
    stderr: stderrStream as Readable,

    async wait(): Promise<{ exitCode: number }> {
      return sdkStream.wait();
    },

    async kill(): Promise<void> {
      killed = true;
      stdoutStream.end();
      stderrStream.end();
      await sdkStream.kill();
    },
  };
}
```

### 3.4 tmux Methods

Reuse the identical tmux patterns from `K8sSandbox` (`src/lib/sandbox/providers/k8s-sandbox.ts:164-346`). The only change is that `exec()` now delegates to the SDK client instead of raw `k8s.Exec`. The tmux command patterns are identical since tmux runs inside the container regardless of how exec is implemented.

```typescript
async createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession> {
  this.touch();

  // Check if session already exists
  const listResult = await this.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (listResult.stdout.split('\n').includes(sessionName)) {
    throw K8sErrors.TMUX_SESSION_ALREADY_EXISTS(sessionName);
  }

  // Create new tmux session
  const result = await this.exec('tmux', ['new-session', '-d', '-s', sessionName]);
  if (result.exitCode !== 0) {
    throw K8sErrors.TMUX_CREATION_FAILED(sessionName, result.stderr);
  }

  return {
    name: sessionName,
    sandboxId: this.id,
    taskId,
    createdAt: new Date().toISOString(),
    windowCount: 1,
    attached: false,
  };
}

async listTmuxSessions(): Promise<TmuxSession[]> {
  this.touch();

  const result = await this.exec('tmux', [
    'list-sessions',
    '-F',
    '#{session_name}:#{session_windows}:#{session_attached}',
  ]);

  if (result.exitCode !== 0) {
    // Expected: no tmux server running = no sessions
    if (result.stderr.includes('no server running') || result.stderr.includes('no sessions')) {
      return [];
    }
    throw K8sErrors.EXEC_FAILED('tmux list-sessions', result.stderr);
  }

  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(':');
      const name = parts[0] ?? '';
      const windows = parts[1] ?? '1';
      const attached = parts[2] ?? '0';
      return {
        name,
        sandboxId: this.id,
        createdAt: new Date().toISOString(),
        windowCount: parseInt(windows, 10) || 1,
        attached: attached === '1',
      };
    })
    .filter((session) => session.name !== '');
}

async killTmuxSession(sessionName: string): Promise<void> {
  this.touch();

  const result = await this.exec('tmux', ['kill-session', '-t', sessionName]);
  if (result.exitCode !== 0) {
    // Match the K8sSandbox behavior: treat "session not found" as success
    if (
      result.stderr.includes('session not found') ||
      result.stderr.includes("can't find session")
    ) {
      return;
    }
    throw K8sErrors.EXEC_FAILED(`tmux kill-session -t ${sessionName}`, result.stderr);
  }
}

async sendKeysToTmux(sessionName: string, keys: string): Promise<void> {
  this.touch();

  const result = await this.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
  if (result.exitCode !== 0) {
    throw K8sErrors.EXEC_FAILED(`tmux send-keys -t ${sessionName}`, result.stderr);
  }
}

async captureTmuxPane(sessionName: string, lines = 100): Promise<string> {
  this.touch();

  const result = await this.exec('tmux', [
    'capture-pane',
    '-t',
    sessionName,
    '-p',
    '-S',
    `-${lines}`,
  ]);

  if (result.exitCode !== 0) {
    throw K8sErrors.EXEC_FAILED(`tmux capture-pane -t ${sessionName}`, result.stderr);
  }

  return result.stdout;
}
```

### 3.5 Metrics

```typescript
async getMetrics(): Promise<SandboxMetrics> {
  this.touch();

  try {
    const status = await this.client.getStatus(this.sandboxName);

    // Calculate uptime from sandbox creation timestamp
    const createdAt = status?.metadata?.creationTimestamp;
    const uptime = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;

    // CRD status may include resource usage if metrics-server is installed
    const resourceUsage = status?.status?.resourceUsage;

    return {
      cpuUsagePercent: resourceUsage?.cpuPercent ?? 0,
      memoryUsageMb: resourceUsage?.memoryMb ?? 0,
      memoryLimitMb: SANDBOX_DEFAULTS.memoryMb,
      diskUsageMb: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptime,
    };
  } catch (error) {
    // Same fallback pattern as K8sSandbox.getMetrics (k8s-sandbox.ts:318-336)
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[AgentSandboxInstance] Failed to get metrics for ${this.sandboxName}: ${message}. ` +
      'Returning placeholder values.'
    );
    return {
      cpuUsagePercent: 0,
      memoryUsageMb: 0,
      memoryLimitMb: 0,
      diskUsageMb: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptime: Date.now() - this._lastActivity.getTime(),
    };
  }
}

touch(): void {
  this._lastActivity = new Date();
}

getLastActivity(): Date {
  return this._lastActivity;
}
```

---

## 4. ContainerAgentService Integration

### 4.1 Key Insight: Zero Changes Required

`ContainerAgentService` (`src/services/container-agent.service.ts`) already programs to the `SandboxProvider` interface generically. It receives a provider instance via its factory function and uses only interface methods. The type of the provider parameter is `SandboxProvider` (the interface from `sandbox-provider.ts:124`), not a concrete class.

The critical call site is at line 901:

```typescript
// src/services/container-agent.service.ts:901
const execResult = await sandbox.execStream({
  cmd: 'node',
  args: ['/opt/agent-runner/dist/index.js'],
  env: {
    ...env,
    CLAUDE_OAUTH_TOKEN: oauthToken,   // Passed to agent-runner to write credentials file
    AGENT_PROMPT: prompt,              // Use actual prompt
  },
  cwd: worktreePath,
});
```

This calls `Sandbox.execStream()` which is defined as optional in the interface (`execStream?(options: ExecStreamOptions): Promise<ExecStreamResult>` at `sandbox-provider.ts:117`). Both `DockerSandbox` and `AgentSandboxInstance` implement it.

As long as `AgentSandboxInstance.execStream()` returns a compliant `ExecStreamResult` with:
- `stdout` as `Readable` (PassThrough)
- `stderr` as `Readable` (PassThrough)
- `wait()` returning `Promise<{ exitCode: number }>`
- `kill()` returning `void | Promise<void>`

...the entire agent execution pipeline works unchanged.

**No changes to `ContainerAgentService` are required for Kubernetes CRD support.**

### 4.2 execStream Data Flow

The complete data flow from task start through CRD sandbox to event delivery:

```
ContainerAgentService.startAgent(input)
  |
  +-- Get sandbox: provider.get(projectId) or provider.create(config)
  |     Returns: AgentSandboxInstance (implements Sandbox interface)
  |
  +-- sandbox.execStream({
  |     cmd: 'node',
  |     args: ['/opt/agent-runner/dist/index.js'],
  |     env: { CLAUDE_OAUTH_TOKEN, AGENT_PROMPT, AGENT_MODEL, ... },
  |     cwd: '/workspace/worktrees/<worktree-name>'
  |   })
  |     |
  |     +-- AgentSandboxInstance.execStream()
  |     |     |
  |     |     +-- Build shell command (same pattern as DockerSandbox):
  |     |     |   sh -c "CLAUDE_OAUTH_TOKEN='...' AGENT_PROMPT='...'
  |     |     |          cd '/workspace/worktrees/...' &&
  |     |     |          exec 'node' '/opt/agent-runner/dist/index.js'"
  |     |     |
  |     |     +-- client.execStream(sandboxName, { command: [...], container: 'sandbox' })
  |     |     |     |
  |     |     |     +-- SDK: K8s Exec WebSocket to sandbox pod
  |     |     |     |   Returns: { stdout: Readable, stderr: Readable, wait(), kill() }
  |     |     |
  |     |     +-- Pipe SDK streams --> PassThrough streams
  |     |     |
  |     |     +-- Return ExecStreamResult { stdout, stderr, wait(), kill() }
  |     |
  |     +-- Returns to ContainerAgentService
  |
  +-- ContainerBridge.processStream(execResult.stdout)
  |     |
  |     +-- JSON-line parsing of agent-runner output
  |     |   Each line: { type: "chunk" | "tool:start" | "tool:result" | ... }
  |     |
  |     +-- DurableStreamsService.publish(sessionId, eventType, payload)
  |           |
  |           +-- SSE to frontend: GET /api/sessions/:id/stream
  |
  +-- execResult.wait()
  |     Returns: { exitCode: 0 }
  |
  +-- Cleanup: update task status, close session
```

### 4.3 Contract Verification

The following properties must hold for the integration to work:

| Property | DockerSandbox | AgentSandboxInstance | Verified By |
|----------|---------------|---------------------|-------------|
| `execStream` returns `ExecStreamResult` | `docker-provider.ts:366-399` | Section 3.3 above | TypeScript compiler |
| `stdout` is `Readable` | PassThrough (line 306) | PassThrough | Interface type |
| `stderr` is `Readable` | PassThrough (line 307) | PassThrough | Interface type |
| `wait()` resolves with `{ exitCode }` | Docker stream `end` event (line 370-386) | SDK WebSocket close | Unit test |
| `kill()` terminates the process | Docker exec PID kill (line 348-364) | SDK kill + stream end | Unit test |
| Shell escape for `cwd` | `shellEscape()` + `sh -c "cd ... && exec ..."` | Same pattern verbatim | Code review |
| Env vars passed to process | Docker `Env` array on exec (line 297) | `env KEY=VALUE` shell prefix | Integration test |

---

## 5. api.ts Provider Wiring Changes

### 5.1 Current Code (Before)

Lines 525-652 of `src/server/api.ts` are Docker-only. The key structure:

```typescript
// src/server/api.ts:525-652 (current)

// Docker provider for sandbox containers (optional - only if Docker is available)
let dockerProvider: ReturnType<typeof createDockerProvider> | null = null;
let containerAgentService: ReturnType<typeof createContainerAgentService> | null = null;

// Step 1: Initialize Docker provider
try {
  dockerProvider = createDockerProvider();
  log.info('[API Server] Docker provider initialized');
  const { recovered, removed } = await dockerProvider.recover();
  // ...
} catch (error) {
  // ... Docker not available handling ...
}

// Step 2: Create default sandbox (only if Docker is available)
if (dockerProvider) {
  // ... default sandbox creation (lines 558-629) ...

  // Step 3: Create ContainerAgentService (only if Docker is available)
  try {
    containerAgentService = createContainerAgentService(
      db,
      dockerProvider,           // <-- Always Docker
      durableStreamsService,
      apiKeyService,
      worktreeService
    );
    taskService.setContainerAgentService(containerAgentService);
  } catch (serviceErr) { /* ... */ }
}
```

### 5.2 New Code (After)

Replace the entire block (lines 525-652) with provider selection based on settings:

```typescript
// ============================================================================
// Sandbox Provider Initialization
// ============================================================================
// Selects and initializes the configured sandbox provider (Docker or K8s CRD).
// The selected provider is passed to createContainerAgentService for agent execution.

import { createDockerProvider } from '../lib/sandbox/providers/docker-provider.js';
import {
  createAgentSandboxProvider,
} from '../lib/sandbox/providers/agent-sandbox-provider.js';
import type { EventEmittingSandboxProvider } from '../lib/sandbox/providers/sandbox-provider.js';

let sandboxProvider: EventEmittingSandboxProvider | null = null;
let containerAgentService: ReturnType<typeof createContainerAgentService> | null = null;

// Step 1: Determine which provider to use from settings
type ProviderSelection = 'docker' | 'kubernetes';
let providerType: ProviderSelection = 'docker'; // default

try {
  const providerSetting = await db.query.settings.findFirst({
    where: eq(schemaTables.settings.key, 'sandbox.defaults'),
  });
  if (providerSetting?.value) {
    const parsed = JSON.parse(providerSetting.value) as { provider?: string };
    if (parsed.provider === 'kubernetes') {
      providerType = 'kubernetes';
    }
  }
} catch (settingsErr) {
  console.warn(
    '[API Server] Failed to load sandbox provider setting (using Docker default):',
    settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
  );
}

// Step 2: Initialize the selected provider
if (providerType === 'kubernetes') {
  // ------ Kubernetes CRD Provider ------
  try {
    // Load K8s-specific settings from the sandbox.kubernetes key
    let k8sSettings: {
      namespace?: string;
      kubeConfigPath?: string;
      kubeContext?: string;
      enableWarmPool?: boolean;
      warmPoolSize?: number;
      runtimeClassName?: 'gvisor' | 'kata' | 'none';
      image?: string;
    } = {};

    try {
      const k8sSetting = await db.query.settings.findFirst({
        where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
      });
      if (k8sSetting?.value) {
        k8sSettings = JSON.parse(k8sSetting.value);
      }
    } catch {
      // Use defaults
    }

    const k8sProvider = createAgentSandboxProvider({
      namespace: k8sSettings.namespace,
      kubeConfigPath: k8sSettings.kubeConfigPath,
      kubeContext: k8sSettings.kubeContext,
      enableWarmPool: k8sSettings.enableWarmPool,
      warmPoolSize: k8sSettings.warmPoolSize,
      runtimeClassName: k8sSettings.runtimeClassName,
      image: k8sSettings.image,
    });

    // Verify cluster connectivity and controller installation
    const health = await k8sProvider.healthCheck();
    if (health.healthy) {
      sandboxProvider = k8sProvider;
      log.info('[API Server] Kubernetes CRD sandbox provider initialized', {
        namespace: k8sSettings.namespace ?? 'agentpane-sandboxes',
        controller: health.details?.controller,
      });

      // Initialize warm pool if enabled
      if (k8sSettings.enableWarmPool) {
        try {
          await k8sProvider.initWarmPool();
          log.info('[API Server] Warm pool initialized');
        } catch (warmPoolErr) {
          console.warn(
            '[API Server] Warm pool initialization failed (continuing without):',
            warmPoolErr instanceof Error ? warmPoolErr.message : String(warmPoolErr)
          );
        }
      }
    } else {
      console.warn(
        `[API Server] Kubernetes CRD provider unhealthy: ${health.message}. ` +
        'Falling back to Docker provider.'
      );
      // Fall through to Docker initialization below
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[API Server] Kubernetes CRD provider init failed: ${message}. ` +
      'Falling back to Docker.'
    );
  }
}

// Step 3: Fall back to Docker if K8s was not initialized (or was not selected)
if (!sandboxProvider) {
  try {
    const dockerProvider = createDockerProvider();
    log.info('[API Server] Docker provider initialized');

    // Recover existing containers from previous runs
    const { recovered, removed } = await dockerProvider.recover();
    if (recovered > 0 || removed > 0) {
      console.log(
        `[API Server] Container recovery: ${recovered} recovered, ` +
        `${removed} stale removed`
      );
    }

    sandboxProvider = dockerProvider;

    // Create default sandbox (Docker-specific behavior, not needed for K8s CRD)
    try {
      const existingDefault = await dockerProvider.get('default');
      if (!existingDefault) {
        interface SandboxDefaults {
          image?: string;
          memoryMb?: number;
          cpuCores?: number;
          idleTimeoutMinutes?: number;
        }
        let defaults: SandboxDefaults | null = null;

        try {
          const globalDefaults = await db.query.settings.findFirst({
            where: eq(schemaTables.settings.key, 'sandbox.defaults'),
          });
          if (globalDefaults?.value) {
            defaults = JSON.parse(globalDefaults.value) as SandboxDefaults;
          }
        } catch (settingsErr) {
          console.warn(
            '[API Server] Failed to load sandbox settings (using defaults):',
            settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
          );
        }

        const defaultImage = defaults?.image ?? SANDBOX_DEFAULTS.image;
        console.log(
          `[API Server] Checking for default sandbox image: ${defaultImage}`
        );

        const imageAvailable = await dockerProvider.isImageAvailable(defaultImage);
        console.log(`[API Server] Image available: ${imageAvailable}`);
        if (imageAvailable) {
          try {
            const defaultWorkspacePath = path.join(
              process.cwd(),
              'data',
              'sandbox-workspaces',
              'default'
            );
            await fs.mkdir(defaultWorkspacePath, { recursive: true });

            await dockerProvider.create({
              projectId: 'default',
              projectPath: defaultWorkspacePath,
              image: defaultImage,
              memoryMb: defaults?.memoryMb ?? 2048,
              cpuCores: defaults?.cpuCores ?? 2,
              idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
              volumeMounts: [],
            });
            log.info('[API Server] Default global sandbox created');
          } catch (createErr) {
            log.warn('[API Server] Failed to create default sandbox', {
              error: createErr,
            });
          }
        } else {
          console.log(
            `[API Server] Default sandbox image '${defaultImage}' not available, ` +
            'skipping default sandbox creation'
          );
        }
      } else {
        log.info('[API Server] Default global sandbox already exists');
      }
    } catch (sandboxErr) {
      console.warn(
        '[API Server] Failed to setup default sandbox (container agent still available):',
        sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr)
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isExpectedError =
      message.includes('ENOENT') ||
      message.includes('connect ECONNREFUSED') ||
      message.includes('permission denied') ||
      message.includes('Cannot connect to Docker');

    if (isExpectedError) {
      log.info(
        '[API Server] Docker not available (expected), container agent service disabled'
      );
    } else {
      log.error(
        `[API Server] Docker initialization failed with unexpected error: ${message}`
      );
    }
  }
}

// Step 4: Create ContainerAgentService with whichever provider was initialized
if (sandboxProvider) {
  try {
    containerAgentService = createContainerAgentService(
      db,
      sandboxProvider,    // <-- DockerProvider OR AgentSandboxProvider
      durableStreamsService,
      apiKeyService,
      worktreeService
    );

    taskService.setContainerAgentService(containerAgentService);
    log.info(
      `[API Server] ContainerAgentService wired up to TaskService ` +
      `(provider: ${sandboxProvider.name})`
    );
  } catch (serviceErr) {
    console.error(
      '[API Server] Failed to create ContainerAgentService:',
      serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
    );
  }
}
```

### 5.3 Settings Key Schema

The provider wiring reads two settings keys from the database:

| Key | Type | Purpose | Existing? |
|-----|------|---------|-----------|
| `sandbox.defaults` | JSON | Global defaults including `provider` field | Yes (existing) |
| `sandbox.kubernetes` | JSON | K8s-specific CRD settings | **New** |

**`sandbox.defaults` schema** (existing, extended with provider field):

```typescript
// Already exists in sandbox.tsx, used at api.ts:572-574
interface SandboxDefaults {
  provider?: 'docker' | 'kubernetes';  // determines which provider to init
  image?: string;
  memoryMb?: number;
  cpuCores?: number;
  idleTimeoutMinutes?: number;
  containerMode?: 'shared' | 'per-project';
}
```

**`sandbox.kubernetes` schema** (new):

```typescript
interface K8sSettings {
  /** Namespace for sandbox CRD resources */
  namespace?: string;           // default: 'agentpane-sandboxes'
  /** Path to kubeconfig file */
  kubeConfigPath?: string;      // default: standard discovery (~/.kube/config)
  /** Kubernetes context */
  kubeContext?: string;          // default: current context
  /** Enable warm pool */
  enableWarmPool?: boolean;     // default: false
  /** Warm pool size */
  warmPoolSize?: number;        // default: 2
  /** Runtime class for pod isolation */
  runtimeClassName?: 'gvisor' | 'kata' | 'none';  // default: 'none'
  /** Container image override */
  image?: string;               // default: SANDBOX_DEFAULTS.image
}
```

---

## 6. Settings UI Updates

**File**: `src/app/routes/settings/sandbox.tsx`

The existing file is 1738 lines. The Kubernetes Configuration section lives at lines 929-1110. The changes below add new subsections within that section and modify the save handler.

### 6.1 New UI Elements

When the provider is set to `kubernetes`, the Kubernetes Configuration `<ConfigSection>` (lines 929-1110) gets three new subsections:

1. **CRD Controller Status** -- shows whether the Agent Sandbox controller is installed, its version, and CRD API version
2. **Runtime Class Selector** -- dropdown to choose `gvisor`, `kata`, or `none`
3. **Warm Pool Controls** -- toggle to enable/disable and a slider for pool size

New state variables to add (after line 131):

```typescript
// CRD controller state
const [controllerStatus, setControllerStatus] = useState<{
  installed: boolean;
  version?: string;
  crdVersion?: string;
} | null>(null);
const [controllerLoading, setControllerLoading] = useState(false);

// Runtime class state
const [runtimeClass, setRuntimeClass] = useState<'gvisor' | 'kata' | 'none'>('none');

// Warm pool state
const [warmPoolEnabled, setWarmPoolEnabled] = useState(false);
const [warmPoolSize, setWarmPoolSize] = useState(2);
```

### 6.2 CRD Controller Status API

**New endpoint**: `GET /api/sandbox/k8s/controller`

Add to the sandbox routes file (or inline in `api.ts`):

```typescript
// Route handler for CRD controller status
app.get('/api/sandbox/k8s/controller', async (c) => {
  try {
    // Load K8s settings from DB
    let namespace = 'agentpane-sandboxes';
    let kubeConfigPath: string | undefined;
    let kubeContext: string | undefined;

    try {
      const k8sSetting = await db.query.settings.findFirst({
        where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
      });
      if (k8sSetting?.value) {
        const parsed = JSON.parse(k8sSetting.value);
        namespace = parsed.namespace ?? namespace;
        kubeConfigPath = parsed.kubeConfigPath;
        kubeContext = parsed.kubeContext;
      }
    } catch {
      // Use defaults
    }

    // Create a temporary SDK client to check controller status
    const client = createAgentSandboxClient({
      namespace,
      kubeConfigPath,
      kubeContext,
    });

    const controllerStatus = await client.getControllerStatus();

    return c.json({
      ok: true,
      data: {
        installed: controllerStatus.installed,
        version: controllerStatus.version ?? null,
        crdVersion: controllerStatus.crdVersion ?? null,
        crdGroup: 'agents.x-k8s.io',
        crdApiVersion: 'v1alpha1',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json(
      {
        ok: false,
        error: { message: `Failed to check CRD controller: ${message}` },
      },
      500
    );
  }
});
```

**Response types:**

```typescript
// Success response
interface ControllerStatusResponse {
  ok: true;
  data: {
    installed: boolean;
    version: string | null;       // e.g., "0.3.1"
    crdVersion: string | null;    // e.g., "v1alpha1"
    crdGroup: string;             // "agents.x-k8s.io"
    crdApiVersion: string;        // "v1alpha1"
  };
}

// Error response (controller not installed or cluster unreachable)
interface ControllerStatusError {
  ok: false;
  error: {
    message: string;
  };
}
```

**UI component** -- insert within the Kubernetes Configuration `<ConfigSection>`, before the K8s Form Fields `<div>` (line 984):

```tsx
{/* CRD Controller Status */}
<div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
  <div className="flex items-center gap-3">
    {controllerLoading ? (
      <CircleNotch className="h-5 w-5 animate-spin text-fg-muted" />
    ) : controllerStatus?.installed ? (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success-muted">
        <Check className="h-4 w-4 text-success" weight="bold" />
      </div>
    ) : (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-danger-muted">
        <Warning className="h-4 w-4 text-danger" />
      </div>
    )}
    <div>
      <p className="font-medium text-fg">
        {controllerLoading
          ? 'Checking controller...'
          : controllerStatus?.installed
            ? 'Agent Sandbox Controller'
            : 'Controller Not Installed'}
      </p>
      {controllerStatus?.installed && (
        <p className="text-xs text-fg-muted">
          v{controllerStatus.version} &middot; CRD {controllerStatus.crdVersion}
        </p>
      )}
      {!controllerStatus?.installed && !controllerLoading && (
        <p className="text-xs text-danger">
          Install the Agent Sandbox CRD controller to use Kubernetes sandboxes
        </p>
      )}
    </div>
  </div>
</div>
```

### 6.3 Runtime Class Selector

Insert after the Namespace field (line 1072) within the K8s Form Fields:

```tsx
{/* Runtime Class */}
<div>
  <label
    htmlFor="k8s-runtime-class"
    className="mb-1.5 block text-sm font-medium text-fg"
  >
    Runtime Class
  </label>
  <select
    id="k8s-runtime-class"
    value={runtimeClass}
    onChange={(e) =>
      setRuntimeClass(e.target.value as 'gvisor' | 'kata' | 'none')
    }
    className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
    data-testid="k8s-runtime-class-select"
  >
    <option value="none">Default (runc)</option>
    <option value="gvisor">gVisor (runsc) -- Recommended</option>
    <option value="kata">Kata Containers (VM isolation)</option>
  </select>
  <p className="mt-1 text-xs text-fg-muted">
    gVisor provides user-space kernel isolation with low overhead.
    Kata uses lightweight VMs for stronger isolation.
    Default uses the cluster&apos;s standard container runtime.
  </p>
</div>
```

### 6.4 Warm Pool Controls

Insert after the Cluster Info section (line 1107), before the closing `</div>` of the K8s config section:

```tsx
{/* Warm Pool Configuration */}
<div className="space-y-4">
  {/* Warm Pool Toggle */}
  <div className="flex items-center justify-between rounded-lg border border-border bg-surface-subtle p-4">
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
          warmPoolEnabled
            ? 'bg-success/20 text-success'
            : 'bg-surface-muted text-fg-muted'
        )}
      >
        <Gauge
          className="h-5 w-5"
          weight={warmPoolEnabled ? 'fill' : 'regular'}
        />
      </div>
      <div>
        <p className="font-medium text-fg">Warm Pool</p>
        <p className="text-sm text-fg-muted">
          {warmPoolEnabled
            ? `Maintaining ${warmPoolSize} pre-warmed sandbox${warmPoolSize !== 1 ? 'es' : ''} for instant allocation`
            : 'Sandboxes are created on-demand (cold start ~10-30s)'}
        </p>
      </div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={warmPoolEnabled}
      onClick={() => setWarmPoolEnabled(!warmPoolEnabled)}
      className={cn(
        'relative h-6 w-11 rounded-full transition-colors',
        warmPoolEnabled ? 'bg-success' : 'bg-surface-muted'
      )}
      data-testid="k8s-warm-pool-toggle"
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          warmPoolEnabled ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  </div>

  {/* Warm Pool Size Slider -- only shown when enabled */}
  {warmPoolEnabled && (
    <div className="pl-4">
      <label
        htmlFor="k8s-warm-pool-size"
        className="mb-1.5 flex items-center justify-between text-sm font-medium text-fg"
      >
        <span>Pool Size</span>
        <span className="rounded bg-accent-muted px-2 py-0.5 font-mono text-xs text-accent">
          {warmPoolSize} sandbox{warmPoolSize !== 1 ? 'es' : ''}
        </span>
      </label>
      <input
        id="k8s-warm-pool-size"
        type="range"
        min={1}
        max={10}
        step={1}
        value={warmPoolSize}
        onChange={(e) => setWarmPoolSize(Number(e.target.value))}
        className="w-full accent-accent"
        data-testid="k8s-warm-pool-size-slider"
      />
      <div className="mt-1 flex justify-between text-xs text-fg-subtle">
        <span>1</span>
        <span>10</span>
      </div>
    </div>
  )}
</div>
```

### 6.5 Updated Test Connection

The existing `loadK8sStatus` callback (lines 197-223) should be updated to also check the CRD controller status alongside the cluster health. Replace it with:

```typescript
const loadK8sStatus = useCallback(async () => {
  setK8sStatusLoading(true);
  setControllerLoading(true);

  try {
    // Build query params for cluster status check
    const params = new URLSearchParams();
    if (k8sConfigPath) params.set('kubeconfigPath', k8sConfigPath);
    if (k8sContext) params.set('context', k8sContext);

    // Run cluster status + controller status checks in parallel
    const [statusResponse, controllerResponse] = await Promise.all([
      fetch(`/api/sandbox/k8s/status?${params.toString()}`),
      fetch('/api/sandbox/k8s/controller'),
    ]);

    const statusResult = await statusResponse.json();
    const controllerResult = await controllerResponse.json();

    // Update cluster status
    if (statusResult.ok) {
      setK8sStatus(statusResult.data);
    } else {
      setK8sStatus({
        healthy: false,
        message: statusResult.error?.message ?? 'Failed to connect to cluster',
      });
    }

    // Update controller status
    if (controllerResult.ok) {
      setControllerStatus(controllerResult.data);
    } else {
      setControllerStatus({ installed: false });
    }
  } catch (_err) {
    setK8sStatus({
      healthy: false,
      message: 'Failed to check cluster status',
    });
    setControllerStatus({ installed: false });
  } finally {
    setK8sStatusLoading(false);
    setControllerLoading(false);
  }
}, [k8sConfigPath, k8sContext]);
```

The `saveDefaultSettings` handler (lines 172-189) should be extended to persist the K8s-specific settings to the `sandbox.kubernetes` key:

```typescript
const saveDefaultSettings = async () => {
  setIsSavingDefaults(true);
  try {
    const settingsToSave: Record<string, unknown> = {
      'sandbox.defaults': defaultSettings,
      'sandbox.mode': defaultSettings.containerMode ?? 'shared',
    };

    // If Kubernetes is selected, also persist K8s-specific settings
    if (defaultSettings.provider === 'kubernetes') {
      settingsToSave['sandbox.kubernetes'] = {
        namespace: k8sNamespace || 'agentpane-sandboxes',
        kubeConfigPath: k8sConfigPath || undefined,
        kubeContext: k8sContext || undefined,
        enableWarmPool: warmPoolEnabled,
        warmPoolSize,
        runtimeClassName: runtimeClass,
      };
    }

    const result = await apiClient.settings.update(settingsToSave);
    if (result.ok) {
      setDefaultsSaved(true);
      setTimeout(() => setDefaultsSaved(false), 2000);
    }
  } catch (_err) {
    setError('Failed to save default settings');
  } finally {
    setIsSavingDefaults(false);
  }
};
```

The `loadDefaultSettings` callback (lines 152-169) should also load K8s settings:

```typescript
const loadDefaultSettings = useCallback(async () => {
  setIsLoadingDefaults(true);
  try {
    const result = await apiClient.settings.get([
      'sandbox.defaults',
      'sandbox.kubernetes',
    ]);
    if (result.ok) {
      // Load default settings
      if (result.data.settings['sandbox.defaults']) {
        const saved = result.data.settings['sandbox.defaults'] as DefaultSandboxSettings;
        setDefaultSettings(saved);
        if (saved.provider) {
          setSelectedProvider(saved.provider);
        }
      }

      // Load K8s-specific settings
      if (result.data.settings['sandbox.kubernetes']) {
        const k8s = result.data.settings['sandbox.kubernetes'] as {
          namespace?: string;
          kubeConfigPath?: string;
          kubeContext?: string;
          enableWarmPool?: boolean;
          warmPoolSize?: number;
          runtimeClassName?: 'gvisor' | 'kata' | 'none';
        };
        if (k8s.namespace) setK8sNamespace(k8s.namespace);
        if (k8s.kubeConfigPath) setK8sConfigPath(k8s.kubeConfigPath);
        if (k8s.kubeContext) setK8sContext(k8s.kubeContext);
        if (k8s.enableWarmPool !== undefined) setWarmPoolEnabled(k8s.enableWarmPool);
        if (k8s.warmPoolSize !== undefined) setWarmPoolSize(k8s.warmPoolSize);
        if (k8s.runtimeClassName) setRuntimeClass(k8s.runtimeClassName);
      }
    }
  } catch (_err) {
    // Use defaults if not set
  } finally {
    setIsLoadingDefaults(false);
  }
}, []);
```

---

## 7. What Gets Archived

Move the following files to `src/lib/sandbox/providers/_archived/` for reference. These are the Phase 1 custom K8s implementation files that are replaced by the CRD-based approach.

| Source File | LOC | Replacement |
|-------------|-----|-------------|
| `src/lib/sandbox/providers/k8s-provider.ts` | ~800 | `agent-sandbox-provider.ts` |
| `src/lib/sandbox/providers/k8s-sandbox.ts` | ~350 | `agent-sandbox-instance.ts` |
| `src/lib/sandbox/providers/k8s-config.ts` | ~200 | SDK handles KubeConfig |
| `src/lib/sandbox/providers/k8s-network-policy.ts` | ~400 | CRD controller manages NetworkPolicy |
| `src/lib/sandbox/providers/k8s-rbac.ts` | ~500 | CRD controller manages RBAC |
| `src/lib/sandbox/providers/k8s-security.ts` | ~600 | CRD controller enforces pod security |
| `src/lib/sandbox/providers/k8s-audit.ts` | ~450 | CRD controller provides audit events |
| `src/lib/sandbox/providers/k8s-warm-pool.ts` | ~1000 | `SandboxWarmPool` CRD |

**Total archived**: ~4,300 LOC across 8 files.

**Total new code**: ~500-800 LOC across 2 files (`agent-sandbox-provider.ts` + `agent-sandbox-instance.ts`).

### What Is NOT Archived

The error file `src/lib/errors/k8s-errors.ts` is **retained** (not archived) because the new `AgentSandboxInstance` reuses the same error factory functions:
- `K8sErrors.EXEC_FAILED` -- used in `exec()` and tmux methods
- `K8sErrors.POD_DELETION_FAILED` -- used in `stop()`
- `K8sErrors.POD_ALREADY_EXISTS` -- used in `create()`
- `K8sErrors.POD_CREATION_FAILED` -- used in `create()`
- `K8sErrors.TMUX_SESSION_ALREADY_EXISTS` -- used in `createTmuxSession()`
- `K8sErrors.TMUX_CREATION_FAILED` -- used in `createTmuxSession()`
- `K8sErrors.IMAGE_NOT_FOUND` -- used in `pullImage()`

### Archive Commands

```bash
# Create archive directory
mkdir -p src/lib/sandbox/providers/_archived

# Move Phase 1 files
mv src/lib/sandbox/providers/k8s-provider.ts    src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-sandbox.ts      src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-config.ts       src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-network-policy.ts src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-rbac.ts         src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-security.ts     src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-audit.ts        src/lib/sandbox/providers/_archived/
mv src/lib/sandbox/providers/k8s-warm-pool.ts    src/lib/sandbox/providers/_archived/
```

---

## 8. Test Plan

### Unit Tests

File: `src/lib/sandbox/providers/__tests__/agent-sandbox-provider.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSandboxProvider } from '../agent-sandbox-provider.js';
import { AgentSandboxInstance } from '../agent-sandbox-instance.js';

// Mock the SDK client
vi.mock('@agentpane/agent-sandbox-sdk', () => ({
  createAgentSandboxClient: vi.fn(() => mockClient),
  SandboxBuilder: vi.fn(() => mockBuilder),
}));

const mockClient = {
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  exec: vi.fn(),
  execStream: vi.fn(),
  waitForReady: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  getControllerStatus: vi.fn().mockResolvedValue({
    installed: true,
    version: '0.3.1',
    crdVersion: 'v1alpha1',
  }),
  namespaceExists: vi.fn().mockResolvedValue(true),
  getStatus: vi.fn(),
  getWarmPool: vi.fn(),
  createOrUpdateWarmPool: vi.fn(),
};

const mockBuilder = {
  setImage: vi.fn().mockReturnThis(),
  setResources: vi.fn().mockReturnThis(),
  setLabels: vi.fn().mockReturnThis(),
  setWorkingDir: vi.fn().mockReturnThis(),
  setRuntimeClassName: vi.fn().mockReturnThis(),
  addHostPathVolume: vi.fn().mockReturnThis(),
  setEnv: vi.fn().mockReturnThis(),
  setTTLSecondsAfterIdle: vi.fn().mockReturnThis(),
  build: vi.fn().mockReturnValue({ metadata: { name: 'test-sandbox' } }),
};

describe('AgentSandboxProvider', () => {
  let provider: AgentSandboxProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentSandboxProvider({ namespace: 'test-ns' });
  });

  describe('create', () => {
    it('creates a sandbox CRD and returns an AgentSandboxInstance', async () => {
      const sandbox = await provider.create({
        projectId: 'proj-1',
        projectPath: '/workspace/proj-1',
        image: 'srlynch1/agent-sandbox:latest',
        memoryMb: 4096,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(mockClient.create).toHaveBeenCalledOnce();
      expect(mockClient.waitForReady).toHaveBeenCalledOnce();
      expect(sandbox).toBeInstanceOf(AgentSandboxInstance);
      expect(sandbox.projectId).toBe('proj-1');
      expect(sandbox.status).toBe('running');
    });

    it('throws if sandbox already exists for project', async () => {
      await provider.create({
        projectId: 'proj-1',
        projectPath: '/workspace/proj-1',
        image: 'test:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      await expect(
        provider.create({
          projectId: 'proj-1',
          projectPath: '/workspace/proj-1',
          image: 'test:latest',
          memoryMb: 2048,
          cpuCores: 1,
          idleTimeoutMinutes: 30,
          volumeMounts: [],
        })
      ).rejects.toThrow();
    });

    it('emits sandbox:creating, sandbox:created, and sandbox:started events', async () => {
      const listener = vi.fn();
      provider.on(listener);

      await provider.create({
        projectId: 'proj-2',
        projectPath: '/workspace/proj-2',
        image: 'test:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sandbox:creating' })
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sandbox:created' })
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sandbox:started' })
      );
    });

    it('sets runtimeClassName when configured', async () => {
      const providerWithGvisor = new AgentSandboxProvider({
        namespace: 'test-ns',
        runtimeClassName: 'gvisor',
      });

      await providerWithGvisor.create({
        projectId: 'proj-3',
        projectPath: '/workspace/proj-3',
        image: 'test:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      expect(mockBuilder.setRuntimeClassName).toHaveBeenCalledWith('gvisor');
    });
  });

  describe('get', () => {
    it('returns cached sandbox by project ID', async () => {
      const created = await provider.create({
        projectId: 'proj-get',
        projectPath: '/workspace',
        image: 'test:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      const found = await provider.get('proj-get');
      expect(found).toBe(created);
    });

    it('returns null for unknown project', async () => {
      const found = await provider.get('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('healthCheck', () => {
    it('reports healthy when controller is installed', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details?.controller).toEqual({
        installed: true,
        version: '0.3.1',
        crdVersion: 'v1alpha1',
      });
    });

    it('reports unhealthy when controller is not installed', async () => {
      mockClient.getControllerStatus.mockResolvedValueOnce({
        installed: false,
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('not installed');
    });
  });

  describe('cleanup', () => {
    it('deletes stopped sandboxes and returns count', async () => {
      const sandbox = await provider.create({
        projectId: 'proj-cleanup',
        projectPath: '/workspace',
        image: 'test:latest',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      });

      await sandbox.stop();

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(1);
    });
  });
});

describe('AgentSandboxInstance', () => {
  let instance: AgentSandboxInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = new AgentSandboxInstance(
      'sandbox-id',
      'sandbox-name',
      'project-id',
      'test-ns',
      mockClient as any,
    );
  });

  describe('exec', () => {
    it('delegates to SDK client with correct arguments', async () => {
      mockClient.exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
      });

      const result = await instance.exec('echo', ['hello']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello');
      expect(mockClient.exec).toHaveBeenCalledWith('sandbox-name', {
        command: ['echo', 'hello'],
        container: 'sandbox',
      });
    });
  });

  describe('execStream', () => {
    it('returns ExecStreamResult with stdout/stderr Readable streams', async () => {
      const { PassThrough } = await import('node:stream');
      const mockStdout = new PassThrough();
      const mockStderr = new PassThrough();

      mockClient.execStream.mockResolvedValueOnce({
        stdout: mockStdout,
        stderr: mockStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      const result = await instance.execStream({
        cmd: 'node',
        args: ['/opt/agent-runner/dist/index.js'],
        env: { AGENT_PROMPT: 'test prompt' },
        cwd: '/workspace',
      });

      expect(result.stdout).toBeDefined();
      expect(result.stderr).toBeDefined();
      expect(typeof result.wait).toBe('function');
      expect(typeof result.kill).toBe('function');

      // Verify the command was built with cwd and env vars
      const callArgs = mockClient.execStream.mock.calls[0];
      const command = callArgs[1].command;
      expect(command[0]).toBe('sh');
      expect(command[1]).toBe('-c');
      expect(command[2]).toContain('/workspace');
      expect(command[2]).toContain('node');
      expect(command[2]).toContain('AGENT_PROMPT');
    });

    it('builds correct command without cwd', async () => {
      const { PassThrough } = await import('node:stream');
      const mockStdout = new PassThrough();
      const mockStderr = new PassThrough();

      mockClient.execStream.mockResolvedValueOnce({
        stdout: mockStdout,
        stderr: mockStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: vi.fn(),
      });

      await instance.execStream({
        cmd: 'node',
        args: ['script.js'],
      });

      const callArgs = mockClient.execStream.mock.calls[0];
      const command = callArgs[1].command;
      // Without cwd, should pass command directly
      expect(command).toEqual(['node', 'script.js']);
    });

    it('handles kill() by ending streams and calling SDK kill', async () => {
      const { PassThrough } = await import('node:stream');
      const mockStdout = new PassThrough();
      const mockStderr = new PassThrough();
      const mockKill = vi.fn();

      mockClient.execStream.mockResolvedValueOnce({
        stdout: mockStdout,
        stderr: mockStderr,
        wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
        kill: mockKill,
      });

      const result = await instance.execStream({
        cmd: 'node',
        args: ['script.js'],
      });

      await result.kill();
      expect(mockKill).toHaveBeenCalledOnce();
    });
  });

  describe('stop', () => {
    it('deletes the sandbox CRD and sets status to stopped', async () => {
      await instance.stop();
      expect(mockClient.delete).toHaveBeenCalledWith('sandbox-name');
      expect(instance.status).toBe('stopped');
    });

    it('sets status to error on failure', async () => {
      mockClient.delete.mockRejectedValueOnce(new Error('delete failed'));

      await expect(instance.stop()).rejects.toThrow();
      expect(instance.status).toBe('error');
    });
  });

  describe('tmux', () => {
    it('creates tmux sessions via exec', async () => {
      // Mock list-sessions (empty -- no server running)
      mockClient.exec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'no server running',
      });
      // Mock new-session
      mockClient.exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      const session = await instance.createTmuxSession('agent-1', 'task-1');
      expect(session.name).toBe('agent-1');
      expect(session.sandboxId).toBe('sandbox-id');
      expect(session.taskId).toBe('task-1');
    });

    it('lists tmux sessions', async () => {
      mockClient.exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'session-1:2:0\nsession-2:1:1',
        stderr: '',
      });

      const sessions = await instance.listTmuxSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].name).toBe('session-1');
      expect(sessions[0].windowCount).toBe(2);
      expect(sessions[1].attached).toBe(true);
    });

    it('returns empty array when no tmux server is running', async () => {
      mockClient.exec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'no server running on /tmp/tmux-1000/default',
      });

      const sessions = await instance.listTmuxSessions();
      expect(sessions).toEqual([]);
    });
  });
});
```

### Integration Test Checklist

| # | Test | How to Verify |
|---|------|---------------|
| 1 | Provider initializes from settings | Set `sandbox.defaults.provider = 'kubernetes'` in DB, restart server, check logs for `Kubernetes CRD sandbox provider initialized` |
| 2 | Provider falls back to Docker on K8s failure | Disconnect cluster, verify `Falling back to Docker provider` in logs |
| 3 | `healthCheck` returns CRD controller status | Call `GET /api/sandbox/k8s/controller`, verify `installed`, `version`, `crdVersion` fields |
| 4 | Sandbox creation via CRD | Move task to `in_progress`, verify `kubectl get sandboxes -n agentpane-sandboxes` shows new resource |
| 5 | Agent execution in CRD sandbox | Verify agent-runner starts (logs show `Executing agent-runner in container`), events stream to frontend |
| 6 | Sandbox cleanup on task completion | After agent completes, verify sandbox CRD deleted (`kubectl get sandboxes` shows removal) |
| 7 | Warm pool initialization | Enable warm pool in settings, verify `kubectl get sandboxwarmpools -n agentpane-sandboxes` shows resource |
| 8 | Settings UI persists K8s config | Change settings, reload page, verify values retained in form fields |
| 9 | Runtime class applied to sandbox | Set `gvisor`, create sandbox, check `kubectl get sandbox -o yaml` for `runtimeClassName: gvisor` |
| 10 | Event emission matches DockerProvider | Listen for `sandbox:creating`, `sandbox:created`, `sandbox:started`, `sandbox:error` events |
| 11 | Shell escaping for cwd with spaces | Create project path with spaces, verify execStream builds correct `sh -c` command |
| 12 | Env var passing to agent-runner | Verify `CLAUDE_OAUTH_TOKEN` and `AGENT_PROMPT` are present in exec command |
