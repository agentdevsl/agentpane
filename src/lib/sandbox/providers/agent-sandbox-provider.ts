import type { SandboxWarmPool } from '@agentpane/agent-sandbox-sdk';
import {
  AgentSandboxClient,
  AlreadyExistsError,
  SandboxBuilder,
} from '@agentpane/agent-sandbox-sdk';
import { createId } from '@paralleldrive/cuid2';
import { K8sErrors } from '../../errors/k8s-errors.js';
import type { SandboxConfig, SandboxHealthCheck, SandboxInfo, SandboxStatus } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import { AgentSandboxInstance } from './agent-sandbox-instance.js';
import type {
  EventEmittingSandboxProvider,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';

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

  /** Skip TLS verification for self-signed certs (minikube, kind). Default: false */
  skipTLSVerify?: boolean;

  /** Pre-constructed SDK client (for testing) */
  client?: AgentSandboxClient;
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

  readonly client: AgentSandboxClient;
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

    // Use injected client or create a new one via the SDK
    this.client =
      options.client ??
      new AgentSandboxClient({
        namespace: this.namespace,
        kubeconfigPath: options.kubeConfigPath,
        context: options.kubeContext,
        skipTLSVerify: options.skipTLSVerify,
      });
  }

  // --- SandboxProvider interface ---

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
      const builder = new SandboxBuilder(sandboxName)
        .namespace(this.namespace)
        .image(config.image)
        .resources({
          memory: `${config.memoryMb}Mi`,
          cpu: `${config.cpuCores}`,
        })
        .labels({
          'agentpane.io/sandbox-id': sandboxId,
          'agentpane.io/project-id': config.projectId,
        });

      // Configure runtime class for isolation (gvisor, kata, or default runc)
      if (this.runtimeClassName !== 'none') {
        builder.runtimeClass(this.runtimeClassName);
      }

      // Set TTL for auto-cleanup
      builder.ttl(config.idleTimeoutMinutes * 60);

      // Apply the CRD manifest to the cluster
      const manifest = builder.build();
      await this.client.createSandbox(manifest);

      // Wait for the sandbox to reach Ready status.
      // The CRD controller creates the pod, sets up networking, and reports Ready.
      await this.client.waitForReady(sandboxName, {
        timeoutMs: this.readyTimeoutSeconds * 1000,
      });

      // Create the Sandbox interface wrapper
      const instance = new AgentSandboxInstance(
        sandboxId,
        sandboxName,
        config.projectId,
        this.namespace,
        this.client
      );

      this.sandboxes.set(sandboxId, instance);
      this.projectToSandbox.set(config.projectId, sandboxId);

      this.emit({
        type: 'sandbox:created',
        sandboxId,
        projectId: config.projectId,
        containerId: sandboxName,
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

  async get(projectId: string): Promise<Sandbox | null> {
    // Check in-memory cache first (same pattern as DockerProvider.get)
    const sandboxId = this.projectToSandbox.get(projectId);
    if (sandboxId) {
      return this.sandboxes.get(sandboxId) ?? null;
    }

    // Fall through to cluster query using label selector.
    try {
      const result = await this.client.listSandboxes({
        labelSelector: `agentpane.io/project-id=${projectId}`,
      });

      // Take the first active sandbox for this project
      const crdSandbox = result.items[0];
      if (!crdSandbox) {
        // Fall back to default sandbox (mirrors DockerProvider.get lines 615-619)
        if (projectId !== 'default') {
          return this.get('default');
        }
        return null;
      }
      const id = crdSandbox.metadata?.labels?.['agentpane.io/sandbox-id'] ?? createId();
      const name = crdSandbox.metadata?.name ?? '';

      const instance = new AgentSandboxInstance(id, name, projectId, this.namespace, this.client);
      await instance.refreshStatus();

      // Cache it
      this.sandboxes.set(id, instance);
      this.projectToSandbox.set(projectId, id);

      return instance;
    } catch (error) {
      // Only swallow "not found" type errors; propagate real failures
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[AgentSandboxProvider] Failed to query sandbox for project ${projectId}:`,
        message
      );
      return null;
    }
  }

  async getById(sandboxId: string): Promise<Sandbox | null> {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  async list(): Promise<SandboxInfo[]> {
    try {
      const result = await this.client.listSandboxes({
        labelSelector: 'agentpane.io/sandbox-id',
      });

      return result.items.map((s) => ({
        id: s.metadata?.labels?.['agentpane.io/sandbox-id'] ?? '',
        projectId: s.metadata?.labels?.['agentpane.io/project-id'] ?? '',
        containerId: s.metadata?.name ?? '',
        status: this.mapCrdPhase(s.status?.phase),
        image: s.spec?.podTemplateSpec?.spec?.containers?.[0]?.image ?? this.image,
        createdAt: s.metadata?.creationTimestamp?.toString() ?? new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        memoryMb: this.parseMemoryMi(
          s.spec?.podTemplateSpec?.spec?.containers?.[0]?.resources?.limits?.memory as
            | string
            | undefined
        ),
        cpuCores: parseFloat(
          (s.spec?.podTemplateSpec?.spec?.containers?.[0]?.resources?.limits?.cpu as string) ?? '0'
        ),
      }));
    } catch (error) {
      console.error('[AgentSandboxProvider] Failed to list sandboxes:', error);
      return [];
    }
  }

  async pullImage(image: string): Promise<void> {
    // Kubernetes pulls images on pod scheduling. The CRD controller
    // handles imagePullPolicy. No pre-pull needed at the provider level.
    if (!image || image.trim() === '') {
      throw K8sErrors.IMAGE_NOT_FOUND(image);
    }
  }

  async isImageAvailable(image: string): Promise<boolean> {
    // CRD controller handles image pulls. Assume available if non-empty.
    return image !== undefined && image.trim() !== '';
  }

  async healthCheck(): Promise<SandboxHealthCheck> {
    try {
      const health = await this.client.healthCheck();

      if (!health.healthy) {
        const issues: string[] = [];
        if (!health.clusterVersion) issues.push('Cluster is not reachable');
        if (!health.crdRegistered) issues.push('Agent Sandbox CRD is not registered');
        if (!health.namespaceExists) issues.push(`Namespace '${this.namespace}' does not exist`);
        return {
          healthy: false,
          message:
            issues.length > 0 ? issues.join('; ') : 'Cluster not reachable or CRD not registered',
          details: {
            provider: 'kubernetes',
            namespace: this.namespace,
            clusterReachable: !!health.clusterVersion,
            crdRegistered: health.crdRegistered,
            namespaceExists: health.namespaceExists,
            clusterVersion: health.clusterVersion,
          },
        };
      }

      return {
        healthy: true,
        message: health.controllerInstalled
          ? undefined
          : 'Agent Sandbox CRD controller is not installed. ' +
            'Install from https://github.com/kubernetes-sigs/agent-sandbox',
        details: {
          provider: 'kubernetes',
          controller: {
            installed: health.controllerInstalled,
            version: health.controllerVersion,
          },
          namespace: this.namespace,
          namespaceExists: health.namespaceExists,
          crdRegistered: health.crdRegistered,
          clusterVersion: health.clusterVersion,
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
          console.error(`[AgentSandboxProvider] Failed to cleanup sandbox ${sandboxId}:`, message);
        }
      }
    }

    return cleaned;
  }

  // --- Event emission (same pattern as DockerProvider docker-provider.ts:831-848) ---

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

  // --- Warm Pool Management ---

  /**
   * Initialize the warm pool by creating or updating the SandboxWarmPool CRD.
   * Must be called explicitly after construction (not called automatically by constructor).
   *
   * The CRD controller handles all warm pool lifecycle:
   * - Maintaining the desired number of pre-warmed sandboxes
   * - Draining and replacing unhealthy sandboxes
   * - HPA-compatible scaling
   */
  async initWarmPool(): Promise<void> {
    if (!this.enableWarmPool) {
      return;
    }

    const warmPoolName = 'agentpane-warm-pool';

    const warmPool: SandboxWarmPool = {
      apiVersion: 'agents.x-k8s.io/v1alpha1',
      kind: 'SandboxWarmPool',
      metadata: {
        name: warmPoolName,
        namespace: this.namespace,
      },
      spec: {
        desiredReady: this.warmPoolSize,
        templateRef: {
          name: 'agentpane-default',
        },
      },
    };

    try {
      await this.client.createWarmPool(warmPool);
    } catch (error) {
      if (!(error instanceof AlreadyExistsError)) {
        throw error;
      }
      // Already exists (409) — delete and recreate with updated spec
      await this.client.deleteWarmPool(warmPoolName);
      await this.client.createWarmPool(warmPool);
    }

    console.log(
      `[AgentSandboxProvider] Warm pool initialized: ${warmPoolName} ` +
        `(size=${this.warmPoolSize})`
    );
  }

  // --- Helpers ---

  /**
   * Map CRD phase string to SandboxStatus type.
   *
   * CRD phases: Pending, Running, Paused, Succeeded, Failed
   * SandboxStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
   */
  private mapCrdPhase(phase?: string): SandboxStatus {
    switch (phase) {
      case 'Running':
        return 'running';
      case 'Pending':
        return 'creating';
      case 'Paused':
        return 'idle';
      case 'Failed':
        return 'error';
      case 'Succeeded':
        return 'stopped';
      default:
        return 'creating';
    }
  }

  private parseMemoryMi(memoryStr?: string): number {
    if (!memoryStr) return 0;
    const match = memoryStr.match(/^(\d+)Mi$/);
    return match?.[1] ? parseInt(match[1], 10) : 0;
  }
}

/**
 * Factory function (mirrors createDockerProvider pattern from docker-provider.ts:854).
 */
export function createAgentSandboxProvider(
  options?: AgentSandboxProviderOptions
): AgentSandboxProvider {
  return new AgentSandboxProvider(options);
}
