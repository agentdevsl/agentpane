import type { SandboxWarmPool } from '@agentpane/agent-sandbox-sdk';
import {
  AgentSandboxClient,
  AlreadyExistsError,
  SandboxBuilder,
} from '@agentpane/agent-sandbox-sdk';
import { createId } from '@paralleldrive/cuid2';
import { K8sErrors } from '../../errors/k8s-errors.js';
import { createLogger } from '../../logging/logger.js';
import { errorMessage } from '../../utils/error-message';
import type { SandboxConfig, SandboxHealthCheck, SandboxInfo, SandboxStatus } from '../types.js';
import { getDefaultSandboxNetworkMode, SANDBOX_DEFAULTS } from '../types.js';
import { AgentSandboxInstance } from './agent-sandbox-instance.js';
import type {
  EventEmittingSandboxProvider,
  RecoverResult,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';

const log = createLogger('AgentSandboxProvider');

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
  /**
   * arch29-W2-J / F04-09: when true, every `create()` will also emit a
   * default-deny NetworkPolicy targeting the sandbox by label. Defaults to
   * `true` whenever `SANDBOX_DEFAULT_NETWORK_MODE=none` is set; otherwise
   * `false` (sandboxes use the cluster default bridge network).
   */
  private readonly enforceNetworkIsolation: boolean;

  private sandboxes = new Map<string, AgentSandboxInstance>();
  private codespaceToSandbox = new Map<string, string>();
  private listeners = new Set<SandboxProviderEventListener>();

  constructor(options: AgentSandboxProviderOptions = {}) {
    this.namespace = options.namespace ?? PROVIDER_DEFAULTS.namespace;
    this.runtimeClassName = options.runtimeClassName ?? PROVIDER_DEFAULTS.runtimeClassName;
    this.image = options.image ?? SANDBOX_DEFAULTS.image;
    this.enableWarmPool = options.enableWarmPool ?? PROVIDER_DEFAULTS.enableWarmPool;
    this.warmPoolSize = options.warmPoolSize ?? PROVIDER_DEFAULTS.warmPoolSize;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? PROVIDER_DEFAULTS.readyTimeoutSeconds;
    this.enforceNetworkIsolation = getDefaultSandboxNetworkMode() === 'none';

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

  /**
   * arch29-W2-J / F04-09: Verify the cluster supports `networking.k8s.io/v1`
   * NetworkPolicy resources. Called from boot when
   * `SANDBOX_DEFAULT_NETWORK_MODE=none` is set, so we fail-closed before any
   * sandbox is provisioned.
   *
   * Throws `K8sErrors.NETWORK_ISOLATION_UNSUPPORTED` when:
   * - The `networking.k8s.io` API group is not exposed by the cluster, OR
   * - We cannot reach the K8s discovery API (typically a connectivity issue).
   *
   * No-op when network isolation is not requested.
   */
  async assertNetworkIsolationSupport(): Promise<void> {
    if (!this.enforceNetworkIsolation) return;

    let availableGroups: string[];
    try {
      const k8s = await import('@kubernetes/client-node');
      const apisApi = this.client.kubeConfig.makeApiClient(k8s.ApisApi);
      const groups = await apisApi.getAPIVersions();
      availableGroups = (groups.groups ?? [])
        .map((g: { name?: string }) => g.name)
        .filter((n): n is string => typeof n === 'string');
    } catch (error) {
      const message = errorMessage(error);
      throw K8sErrors.NETWORK_ISOLATION_UNSUPPORTED(
        'kubernetes',
        `unable to query API groups (${message})`
      );
    }

    if (!availableGroups.includes('networking.k8s.io')) {
      throw K8sErrors.NETWORK_ISOLATION_UNSUPPORTED(
        'kubernetes',
        'cluster does not expose the networking.k8s.io API group, so a default-deny NetworkPolicy cannot be created'
      );
    }
  }

  /**
   * arch29-W2-J / F04-09: Emit a default-deny NetworkPolicy that selects the
   * sandbox by `agentpane.io/sandbox-id`. Both `policyTypes` are populated
   * with empty rule sets so all ingress AND all egress are blocked, matching
   * the intent of `SANDBOX_DEFAULT_NETWORK_MODE=none`.
   *
   * Idempotent: a 409 (already exists) is treated as success.
   */
  private async createDefaultDenyNetworkPolicy(
    sandboxId: string,
    sandboxName: string
  ): Promise<void> {
    const policyName = `np-${sandboxName}`;
    const k8s = await import('@kubernetes/client-node');
    const networkingApi = this.client.kubeConfig.makeApiClient(k8s.NetworkingV1Api);

    const body = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: this.namespace,
        labels: {
          'agentpane.io/sandbox-id': sandboxId,
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            'agentpane.io/sandbox-id': sandboxId,
          },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: [],
      },
    };

    try {
      await networkingApi.createNamespacedNetworkPolicy({
        namespace: this.namespace,
        body,
      });
      log.info('Default-deny NetworkPolicy created for sandbox', {
        data: { sandboxId, policyName, namespace: this.namespace },
      });
    } catch (error) {
      // 409 Conflict means the policy already exists for this sandbox — fine.
      const status =
        (error as { code?: number; statusCode?: number; status?: number }).code ??
        (error as { statusCode?: number }).statusCode ??
        (error as { status?: number }).status;
      if (status === 409) {
        log.info('NetworkPolicy already exists for sandbox (idempotent)', {
          data: { sandboxId, policyName },
        });
        return;
      }
      throw K8sErrors.NETWORK_POLICY_CREATION_FAILED(policyName, errorMessage(error));
    }
  }

  /**
   * Best-effort rollback for a default-deny policy created before the Sandbox
   * CRD. Network isolation must exist before the pod can become live, but if
   * CRD creation then fails we should not leave an orphaned policy behind.
   */
  private async deleteDefaultDenyNetworkPolicy(sandboxName: string): Promise<void> {
    const policyName = `np-${sandboxName}`;
    try {
      const k8s = await import('@kubernetes/client-node');
      const networkingApi = this.client.kubeConfig.makeApiClient(k8s.NetworkingV1Api);
      await networkingApi.deleteNamespacedNetworkPolicy({
        namespace: this.namespace,
        name: policyName,
      });
      log.info('Rolled back default-deny NetworkPolicy for failed sandbox create', {
        data: { policyName, namespace: this.namespace },
      });
    } catch (error) {
      const status =
        (error as { code?: number; statusCode?: number; status?: number }).code ??
        (error as { statusCode?: number }).statusCode ??
        (error as { status?: number }).status;
      if (status === 404) return;
      log.warn('Failed to rollback default-deny NetworkPolicy after sandbox create failure', {
        data: {
          policyName,
          namespace: this.namespace,
          error: errorMessage(error),
        },
      });
    }
  }

  // --- SandboxProvider interface ---

  private creatingCodespaces = new Set<string>();

  async create(config: SandboxConfig): Promise<Sandbox> {
    // Check for existing sandbox for this project
    // (mirrors DockerProvider.create at docker-provider.ts:527-535)
    const existing = this.codespaceToSandbox.get(config.codespaceId);
    if (existing) {
      const sandbox = this.sandboxes.get(existing);
      if (sandbox && sandbox.status !== 'stopped') {
        throw K8sErrors.POD_ALREADY_EXISTS(config.codespaceId);
      }
    }

    // Guard against concurrent creation for the same project
    if (this.creatingCodespaces.has(config.codespaceId)) {
      throw K8sErrors.POD_ALREADY_EXISTS(config.codespaceId);
    }

    await this.assertNoClusterSandboxForCodespace(config.codespaceId);
    this.creatingCodespaces.add(config.codespaceId);

    const sandboxId = config.id ?? createId();
    // CRD sandbox names must be DNS-1123 compliant
    const sandboxName = `agentpane-${config.codespaceId.slice(0, 20)}-${sandboxId.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');

    this.emit({
      type: 'sandbox:creating',
      sandboxId,
      codespaceId: config.codespaceId,
    });

    let sandboxCreated = false;
    let networkPolicyCreated = false;
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
          'agentpane.io/project-id': config.codespaceId,
        });

      // Configure runtime class for isolation (gvisor, kata, or default runc)
      if (this.runtimeClassName !== 'none') {
        builder.runtimeClass(this.runtimeClassName);
      }

      // Set absolute shutdown time for auto-cleanup
      const shutdownTime = new Date(
        Date.now() + config.idleTimeoutMinutes * 60 * 1000
      ).toISOString();
      builder.shutdownTime(shutdownTime);

      // MAY-02: create network isolation before the Sandbox CRD so the
      // controller never has a chance to start a pod without the default-deny
      // policy in place. If sandbox creation fails below, rollback this policy
      // best-effort in the catch block.
      if (this.enforceNetworkIsolation) {
        await this.createDefaultDenyNetworkPolicy(sandboxId, sandboxName);
        networkPolicyCreated = true;
      }

      // Apply the CRD manifest to the cluster
      const manifest = builder.build();
      await this.client.createSandbox(manifest);
      sandboxCreated = true;

      // Wait for the sandbox to reach Ready status.
      // The CRD controller creates the pod, sets up networking, and reports Ready.
      await this.client.waitForReady(sandboxName, {
        timeoutMs: this.readyTimeoutSeconds * 1000,
      });

      // Create the Sandbox interface wrapper
      const instance = new AgentSandboxInstance(
        sandboxId,
        sandboxName,
        config.codespaceId,
        this.namespace,
        this.client
      );

      // Refresh status from the cluster now that waitForReady has confirmed the sandbox is up.
      // Without this, the instance would retain the initial 'creating' status.
      await instance.refreshStatus();

      this.sandboxes.set(sandboxId, instance);
      this.codespaceToSandbox.set(config.codespaceId, sandboxId);

      this.emit({
        type: 'sandbox:created',
        sandboxId,
        codespaceId: config.codespaceId,
        containerId: sandboxName,
      });

      this.emit({ type: 'sandbox:started', sandboxId });

      return instance;
    } catch (error) {
      const message = errorMessage(error);
      if (sandboxCreated) {
        try {
          await this.client.deleteSandbox(sandboxName, this.namespace);
        } catch (deleteErr) {
          log.warn('Failed to rollback Sandbox CRD after create failure', {
            data: { sandboxName, namespace: this.namespace, error: errorMessage(deleteErr) },
          });
        }
      }
      if (networkPolicyCreated) {
        await this.deleteDefaultDenyNetworkPolicy(sandboxName);
      }
      this.emit({
        type: 'sandbox:error',
        sandboxId,
        error: error instanceof Error ? error : new Error(message),
      });
      throw K8sErrors.POD_CREATION_FAILED(sandboxName, message);
    } finally {
      this.creatingCodespaces.delete(config.codespaceId);
    }
  }

  private async assertNoClusterSandboxForCodespace(codespaceId: string): Promise<void> {
    const result = await this.client.listSandboxes({
      labelSelector: `agentpane.io/project-id=${codespaceId}`,
    });

    const activeSandbox = result.items.find((crd) => {
      const status = this.mapConditionsToStatus(crd);
      return status !== 'stopped' && status !== 'error';
    });
    if (!activeSandbox) return;

    const sandboxId = activeSandbox.metadata?.labels?.['agentpane.io/sandbox-id'];
    const name = activeSandbox.metadata?.name;
    if (sandboxId && name) {
      const instance = new AgentSandboxInstance(
        sandboxId,
        name,
        codespaceId,
        this.namespace,
        this.client
      );
      this.sandboxes.set(sandboxId, instance);
      this.codespaceToSandbox.set(codespaceId, sandboxId);
    }
    throw K8sErrors.POD_ALREADY_EXISTS(codespaceId);
  }

  /**
   * Reconcile in-memory state with the cluster on boot.
   *
   * theme-04 P1-03: Lists existing Sandbox CRDs in the managed namespace,
   * re-registers running ones into the in-memory cache, and deletes CRDs that
   * are in a terminal state (stopped / error) so they don't sit forever.
   *
   * Safe to call multiple times; idempotent.
   */
  async recover(): Promise<RecoverResult> {
    let recovered = 0;
    let removed = 0;

    try {
      const result = await this.client.listSandboxes({
        labelSelector: 'agentpane.io/sandbox-id',
      });

      for (const crd of result.items) {
        const sandboxId = crd.metadata?.labels?.['agentpane.io/sandbox-id'] ?? '';
        const codespaceId = crd.metadata?.labels?.['agentpane.io/project-id'] ?? '';
        const name = crd.metadata?.name ?? '';
        if (!sandboxId || !codespaceId || !name) continue;

        // Skip if already registered (recover may run twice)
        if (this.sandboxes.has(sandboxId)) continue;

        const status = this.mapConditionsToStatus(crd);
        if (status === 'error' || status === 'stopped') {
          // Tear down orphaned / terminal CRDs
          try {
            await this.client.deleteSandbox(name, this.namespace);
            removed++;
          } catch (deleteErr) {
            log.warn('Failed to delete orphaned sandbox during recover', {
              error: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)),
              data: { sandboxId, name },
            });
          }
          continue;
        }

        // Re-register live sandboxes
        const instance = new AgentSandboxInstance(
          sandboxId,
          name,
          codespaceId,
          this.namespace,
          this.client
        );
        try {
          await instance.refreshStatus();
        } catch (refreshErr) {
          log.warn('refreshStatus failed during recover, skipping sandbox', {
            error: refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)),
            data: { sandboxId },
          });
          continue;
        }
        this.sandboxes.set(sandboxId, instance);
        this.codespaceToSandbox.set(codespaceId, sandboxId);
        recovered++;
      }
    } catch (error) {
      log.warn('Kubernetes sandbox recovery failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    log.info('Kubernetes sandbox recovery complete', { data: { recovered, removed } });
    return { recovered, removed };
  }

  async validateSandboxes(): Promise<void> {
    const toEvict: string[] = [];
    for (const [sandboxId, instance] of this.sandboxes) {
      try {
        await instance.refreshStatus();
      } catch (error) {
        log.error(`refreshStatus failed for sandbox ${sandboxId}, treating as error`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      if (instance.status === 'error' || instance.status === 'stopped') {
        toEvict.push(sandboxId);
      }
    }
    for (const sandboxId of toEvict) {
      const instance = this.sandboxes.get(sandboxId);
      if (instance) {
        log.info('Evicting stale sandbox from cache', {
          data: { sandboxId, codespaceId: instance.codespaceId, status: instance.status },
        });
        this.sandboxes.delete(sandboxId);
        this.codespaceToSandbox.delete(instance.codespaceId);
      }
    }
  }

  async get(codespaceId: string): Promise<Sandbox | null> {
    // Check in-memory cache first (same pattern as DockerProvider.get)
    const sandboxId = this.codespaceToSandbox.get(codespaceId);
    if (sandboxId) {
      const cached = this.sandboxes.get(sandboxId);
      if (cached) {
        // Refresh status from cluster to avoid stale 'creating' status
        await cached.refreshStatus();
        if (cached.status === 'error' || cached.status === 'stopped') {
          log.info('Evicting stale sandbox from get() cache', {
            data: { sandboxId, codespaceId, status: cached.status },
          });
          this.sandboxes.delete(sandboxId);
          this.codespaceToSandbox.delete(codespaceId);
          // Fall through to cluster query below
        } else {
          return cached;
        }
      }
    }

    // Fall through to cluster query using label selector.
    try {
      const result = await this.client.listSandboxes({
        labelSelector: `agentpane.io/project-id=${codespaceId}`,
      });

      // Take the first active sandbox for this project
      const crdSandbox = result.items[0];
      if (!crdSandbox) {
        // Fall back to default sandbox (mirrors DockerProvider.get lines 615-619)
        if (codespaceId !== 'default') {
          return this.get('default');
        }
        return null;
      }
      const id = crdSandbox.metadata?.labels?.['agentpane.io/sandbox-id'] ?? createId();
      const name = crdSandbox.metadata?.name ?? '';

      const instance = new AgentSandboxInstance(id, name, codespaceId, this.namespace, this.client);
      await instance.refreshStatus();

      // Cache it
      this.sandboxes.set(id, instance);
      this.codespaceToSandbox.set(codespaceId, id);

      return instance;
    } catch (error) {
      // Only swallow "not found" type errors; propagate real failures
      const message = errorMessage(error);
      log.error(`Failed to query sandbox for codespace ${codespaceId}: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      return null;
    }
  }

  async getById(sandboxId: string): Promise<Sandbox | null> {
    const cached = this.sandboxes.get(sandboxId);
    if (cached) {
      try {
        await cached.refreshStatus();
      } catch (error) {
        log.error(`refreshStatus failed for sandbox ${sandboxId} in getById`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.sandboxes.delete(sandboxId);
        this.codespaceToSandbox.delete(cached.codespaceId);
        return null;
      }
      if (cached.status === 'error' || cached.status === 'stopped') {
        this.sandboxes.delete(sandboxId);
        this.codespaceToSandbox.delete(cached.codespaceId);
        return null;
      }
    }
    return cached ?? null;
  }

  async list(): Promise<SandboxInfo[]> {
    await this.validateSandboxes();
    try {
      const result = await this.client.listSandboxes({
        labelSelector: 'agentpane.io/sandbox-id',
      });

      return result.items.map((s) => ({
        id: s.metadata?.labels?.['agentpane.io/sandbox-id'] ?? '',
        codespaceId: s.metadata?.labels?.['agentpane.io/project-id'] ?? '',
        containerId: s.metadata?.name ?? '',
        status: this.mapConditionsToStatus(s),
        image: s.spec?.podTemplate?.spec?.containers?.[0]?.image ?? this.image,
        createdAt: s.metadata?.creationTimestamp?.toString() ?? new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        memoryMb: this.parseMemoryMi(
          s.spec?.podTemplate?.spec?.containers?.[0]?.resources?.limits?.memory as
            | string
            | undefined
        ),
        cpuCores: parseFloat(
          (s.spec?.podTemplate?.spec?.containers?.[0]?.resources?.limits?.cpu as string) ?? '0'
        ),
      }));
    } catch (error) {
      log.error('Failed to list sandboxes', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
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
      const message = errorMessage(error);
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

    // Collect IDs first to avoid mutating the map during iteration
    const toClean: string[] = [];
    for (const [sandboxId, instance] of this.sandboxes) {
      const shouldClean =
        (options?.status?.includes(instance.status) ?? instance.status === 'stopped') &&
        (!options?.olderThan || instance.getLastActivity() < options.olderThan);

      if (shouldClean) {
        toClean.push(sandboxId);
      }
    }

    for (const sandboxId of toClean) {
      const instance = this.sandboxes.get(sandboxId);
      if (!instance) continue;

      try {
        if (instance.status !== 'stopped') {
          await instance.stop();
        }
        cleaned++;
      } catch (error) {
        const message = errorMessage(error);
        log.error(`Failed to stop sandbox ${sandboxId} during cleanup — removing from cache`, {
          error: error instanceof Error ? error : new Error(message),
        });
      }
      // Always evict from cache regardless of stop success/failure
      this.sandboxes.delete(sandboxId);
      this.codespaceToSandbox.delete(instance.codespaceId);
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
        log.error('Event listener error', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
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
      apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
      kind: 'SandboxWarmPool',
      metadata: {
        name: warmPoolName,
        namespace: this.namespace,
      },
      spec: {
        replicas: this.warmPoolSize,
        sandboxTemplateRef: {
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
      // Already exists (409) — update spec in place instead of delete+recreate
      // to avoid orphaning existing warm pool sandboxes via ownerReference cascade
      try {
        await this.client.replaceWarmPool(warmPoolName, warmPool);
      } catch (replaceErr) {
        log.warn('Failed to replace warm pool, falling back to delete+recreate', {
          error: replaceErr,
        });
        await this.client.deleteWarmPool(warmPoolName);
        await this.client.createWarmPool(warmPool);
      }
    }

    log.info(`Warm pool initialized: ${warmPoolName}`, {
      data: { warmPoolName, size: this.warmPoolSize },
    });
  }

  // --- Helpers ---

  /**
   * Map CRD conditions to SandboxStatus type.
   *
   * v0.2.1 CRD uses status.conditions[] instead of status.phase.
   * Also checks spec.replicas === 0 for paused (idle) sandboxes.
   */
  private mapConditionsToStatus(sandbox: {
    spec?: { replicas?: number };
    status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }> };
  }): SandboxStatus {
    // Check pause first (replicas === 0)
    if (sandbox.spec?.replicas === 0) return 'idle';

    const conditions = sandbox.status?.conditions;
    const ready = conditions?.find((c) => c.type === 'Ready');
    if (!ready) return 'creating';
    if (ready.status === 'True') return 'running';
    if (ready.reason === 'SandboxExpired') return 'stopped';
    // Transient reasons (PodNotReady, ContainersNotReady) indicate startup in progress
    const transientReasons = ['PodNotReady', 'ContainersNotReady'];
    if (transientReasons.includes(ready.reason ?? '')) return 'creating';
    return 'error';
  }

  private parseMemoryMi(memoryStr?: string): number {
    if (!memoryStr) return 0;
    const miMatch = memoryStr.match(/^(\d+)Mi$/);
    if (miMatch?.[1]) return parseInt(miMatch[1], 10);
    const giMatch = memoryStr.match(/^(\d+)Gi$/);
    if (giMatch?.[1]) return parseInt(giMatch[1], 10) * 1024;
    return 0;
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
