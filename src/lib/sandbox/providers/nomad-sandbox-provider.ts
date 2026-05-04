import type { NomadJobStatus } from '@agentpane/nomad-sandbox-sdk';
import {
  ConnectionError,
  NOMAD_JOB_PREFIX,
  NOMAD_META,
  NomadApiError,
  NomadJobBuilder,
  NomadSandboxClient,
  NotFoundError,
  TimeoutError,
} from '@agentpane/nomad-sandbox-sdk';
import { createId } from '@paralleldrive/cuid2';
import { NOMAD_ERROR_IDS, NomadErrors } from '../../errors/nomad-errors.js';
import { createLogger } from '../../logging/logger.js';
import { errorMessage } from '../../utils/error-message';
import type { SandboxConfig, SandboxHealthCheck, SandboxInfo, SandboxStatus } from '../types.js';
import { getDefaultSandboxNetworkMode, SANDBOX_DEFAULTS } from '../types.js';
import { NomadSandboxInstance } from './nomad-sandbox-instance.js';
import type {
  EventEmittingSandboxProvider,
  RecoverResult,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';

const log = createLogger('NomadSandboxProvider');

/**
 * Map Nomad job status string to SandboxStatus type.
 *
 * Nomad job statuses: 'pending' | 'running' | 'dead'
 * SandboxStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
 *
 * Shared between NomadSandboxProvider and NomadSandboxInstance to avoid duplication.
 */
export function mapNomadJobStatus(status?: NomadJobStatus): SandboxStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'pending':
      return 'creating';
    case 'dead':
      return 'stopped';
    default:
      log.warn(`Unknown Nomad job status: "${status}", treating as error`);
      return 'error';
  }
}

/**
 * Configuration for NomadSandboxProvider.
 */
export interface NomadSandboxProviderOptions {
  /** Nomad HTTP API address. Default: http://127.0.0.1:4646 */
  address?: string;

  /** ACL token for authentication */
  token?: string;

  /** Nomad namespace. Default: 'default' */
  namespace?: string;

  /** Nomad region */
  region?: string;

  /** Nomad datacenter. Default: 'dc1' */
  datacenter?: string;

  /** Container image for sandbox jobs. Default: SANDBOX_DEFAULTS.image */
  image?: string;

  /** Timeout in seconds for job to reach running state. Default: 120 */
  readyTimeoutSeconds?: number;

  /** Pre-constructed SDK client (for testing) */
  client?: NomadSandboxClient;
}

const PROVIDER_DEFAULTS = {
  namespace: 'default',
  datacenter: 'dc1',
  readyTimeoutSeconds: 120,
} as const;

/**
 * Nomad sandbox provider.
 *
 * Manages sandbox lifecycle using HashiCorp Nomad jobs. Each sandbox is a
 * Nomad service job running the agent sandbox container image. The provider
 * uses meta tags on jobs to track sandbox-to-project mappings.
 *
 * Implements EventEmittingSandboxProvider so it can be used as a drop-in
 * replacement for DockerProvider/AgentSandboxProvider in ContainerAgentService.
 */
export class NomadSandboxProvider implements EventEmittingSandboxProvider {
  readonly name = 'nomad';

  private readonly client: NomadSandboxClient;
  private readonly namespace: string;
  private readonly datacenter: string;
  private readonly image: string;
  private readonly readyTimeoutSeconds: number;
  /**
   * arch29-W2-J / F04-09: when true, every `create()` will set the task group
   * network stanza to `mode = "none"` so the workload has no network access.
   * Defaults to `true` whenever `SANDBOX_DEFAULT_NETWORK_MODE=none` is set;
   * otherwise `false` (sandboxes use the cluster default network).
   */
  private readonly enforceNetworkIsolation: boolean;

  private sandboxes = new Map<string, NomadSandboxInstance>();
  private codespaceToSandbox = new Map<string, string>();
  private listeners = new Set<SandboxProviderEventListener>();
  private creatingCodespaces = new Set<string>();

  constructor(options: NomadSandboxProviderOptions = {}) {
    this.namespace = options.namespace ?? PROVIDER_DEFAULTS.namespace;
    this.datacenter = options.datacenter ?? PROVIDER_DEFAULTS.datacenter;
    this.image = options.image ?? SANDBOX_DEFAULTS.image;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? PROVIDER_DEFAULTS.readyTimeoutSeconds;
    this.enforceNetworkIsolation = getDefaultSandboxNetworkMode() === 'none';

    // Use injected client or create a new one via the SDK
    this.client =
      options.client ??
      new NomadSandboxClient({
        address: options.address,
        token: options.token,
        namespace: this.namespace,
        region: options.region,
      });
  }

  /**
   * arch29-W2-J / F04-09: Verify the cluster can enforce a
   * `network { mode = "none" }` stanza. Called from boot when
   * `SANDBOX_DEFAULT_NETWORK_MODE=none` is set, so we fail-closed before any
   * sandbox is provisioned.
   *
   * Throws `NomadErrors.NETWORK_ISOLATION_UNSUPPORTED` when:
   * - The Nomad cluster is unreachable (cannot verify support), OR
   * - The cluster's reported version is older than 0.10 (the version that
   *   introduced network mode `"none"` for the Docker driver).
   *
   * No-op when network isolation is not requested.
   */
  async assertNetworkIsolationSupport(): Promise<void> {
    if (!this.enforceNetworkIsolation) return;

    try {
      const health = await this.client.healthCheck();
      if (!health.healthy) {
        throw NomadErrors.NETWORK_ISOLATION_UNSUPPORTED(
          'cluster unhealthy — cannot verify network-mode-none support'
        );
      }
      // Nomad 0.10+ supports `mode = "none"` for the Docker driver. Older
      // versions ignore the stanza, which would silently permit network
      // access. If the version string is not parseable, we fail closed.
      const version = (health as { version?: string }).version;
      if (version) {
        // Parse a leading semver-like prefix; reject anything below 0.10.
        const match = version.match(/^v?(\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1] ?? '0', 10);
          const minor = parseInt(match[2] ?? '0', 10);
          if (major === 0 && minor < 10) {
            throw NomadErrors.NETWORK_ISOLATION_UNSUPPORTED(
              `Nomad ${version} predates the network mode 'none' stanza (introduced in 0.10)`
            );
          }
        }
      }
    } catch (error) {
      // If the error is already a typed NETWORK_ISOLATION_UNSUPPORTED, rethrow.
      const code = (error as { code?: string }).code;
      if (code === NOMAD_ERROR_IDS.NETWORK_ISOLATION_UNSUPPORTED) throw error;
      throw NomadErrors.NETWORK_ISOLATION_UNSUPPORTED(
        `unable to verify cluster support (${errorMessage(error)})`
      );
    }
  }

  // --- SandboxProvider interface ---

  async create(config: SandboxConfig): Promise<Sandbox> {
    // Guard against concurrent create() calls for the same project
    if (this.creatingCodespaces.has(config.codespaceId)) {
      throw NomadErrors.JOB_ALREADY_EXISTS(config.codespaceId);
    }

    // Check for existing sandbox for this project
    const existing = this.codespaceToSandbox.get(config.codespaceId);
    if (existing) {
      const sandbox = this.sandboxes.get(existing);
      if (sandbox && sandbox.status !== 'stopped') {
        throw NomadErrors.JOB_ALREADY_EXISTS(config.codespaceId);
      }
    }

    await this.assertNoClusterJobForCodespace(config.codespaceId);
    this.creatingCodespaces.add(config.codespaceId);
    const sandboxId = config.id ?? createId();
    // Job names must be DNS-compatible: lowercase alphanumeric and hyphens
    const jobName = `agentpane-${config.codespaceId.slice(0, 20)}-${sandboxId.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');

    this.emit({
      type: 'sandbox:creating',
      sandboxId,
      codespaceId: config.codespaceId,
    });

    try {
      // Build volume mount strings: project path → /workspace, plus any additional mounts.
      const volumeStrings = [
        `${config.codespacePath}:/workspace:rw`,
        ...config.volumeMounts.map(
          (v) => `${v.hostPath}:${v.containerPath}:${v.readonly ? 'ro' : 'rw'}`
        ),
      ];

      // Build the Nomad job spec using NomadJobBuilder from the SDK.
      const jobSpec = new NomadJobBuilder(jobName)
        .type('service')
        .namespace(this.namespace)
        .datacenter(this.datacenter)
        .image(config.image)
        .command('tail', ['-f', '/dev/null'])
        .resources(config.cpuCores * 1000, config.memoryMb)
        .volumes(volumeStrings)
        .meta(NOMAD_META.SANDBOX_ID, sandboxId)
        .meta(NOMAD_META.PROJECT_ID, config.codespaceId)
        .build();

      // arch29-W2-J / F04-09: when network isolation is requested via
      // `SANDBOX_DEFAULT_NETWORK_MODE=none`, set the task group's network
      // stanza to mode `"none"` so the workload has no network access. This
      // lands as a real `network { mode = "none" }` block in the job spec
      // (Docker driver supports this since Nomad 0.10).
      if (this.enforceNetworkIsolation) {
        const firstGroup = jobSpec.TaskGroups?.[0];
        if (firstGroup) {
          firstGroup.Networks = [{ Mode: 'none' }];
        }
      }

      // Register the job with Nomad
      await this.client.registerJob(jobSpec);

      // Wait for the job to reach running status
      await this.client.waitForRunning(jobName, this.readyTimeoutSeconds * 1000);

      // Get allocations to find the alloc ID for exec
      const allocations = await this.client.getJobAllocations(jobName);
      const runningAlloc = allocations.find(
        (a: { ClientStatus?: string }) => a.ClientStatus === 'running'
      );

      if (!runningAlloc?.ID) {
        throw NomadErrors.ALLOCATION_NOT_FOUND(
          `${jobName} (allocs: ${allocations.map((a) => `${a.ID?.slice(0, 8)}:${a.ClientStatus}`).join(', ')})`
        );
      }
      const allocId = runningAlloc.ID;

      // Create the Sandbox interface wrapper
      const instance = new NomadSandboxInstance(
        sandboxId,
        jobName,
        allocId,
        config.codespaceId,
        this.namespace,
        this.client
      );

      await instance.refreshStatus();

      this.sandboxes.set(sandboxId, instance);
      this.codespaceToSandbox.set(config.codespaceId, sandboxId);

      this.emit({
        type: 'sandbox:created',
        sandboxId,
        codespaceId: config.codespaceId,
        containerId: jobName,
      });

      this.emit({ type: 'sandbox:started', sandboxId });

      return instance;
    } catch (error) {
      // Best-effort cleanup of the registered Nomad job
      try {
        await this.client.stopJob(jobName, true);
      } catch (cleanupError) {
        log.warn(`Failed to clean up job ${jobName} after creation failure`, {
          error: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        });
      }

      this.emit({
        type: 'sandbox:error',
        sandboxId,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      if (error instanceof TimeoutError) {
        throw NomadErrors.JOB_STARTUP_TIMEOUT(jobName, this.readyTimeoutSeconds);
      }
      if (error instanceof ConnectionError) {
        throw NomadErrors.CLUSTER_UNREACHABLE(
          error.message,
          error.cause instanceof Error ? error.cause.message : 'connection failed'
        );
      }
      if (error instanceof NomadApiError && error.statusCode === 403) {
        throw NomadErrors.AUTH_FAILED(error.message);
      }
      const message = errorMessage(error);
      throw NomadErrors.JOB_CREATION_FAILED(jobName, message);
    } finally {
      this.creatingCodespaces.delete(config.codespaceId);
    }
  }

  private async assertNoClusterJobForCodespace(codespaceId: string): Promise<void> {
    const jobs = await this.client.listJobs(NOMAD_JOB_PREFIX);
    const activeJob = jobs.find((job) => {
      if (job.Meta?.[NOMAD_META.PROJECT_ID] !== codespaceId) return false;
      const status = mapNomadJobStatus(job.Status);
      return status !== 'stopped' && status !== 'error';
    });
    if (!activeJob) return;

    const sandboxId = activeJob.Meta?.[NOMAD_META.SANDBOX_ID];
    if (sandboxId && activeJob.ID) {
      this.codespaceToSandbox.set(codespaceId, sandboxId);
    }
    throw NomadErrors.JOB_ALREADY_EXISTS(codespaceId);
  }

  /**
   * Reconcile in-memory state with the Nomad cluster on boot.
   *
   * theme-04 P1-03: Lists existing jobs with the agentpane prefix, re-registers
   * running ones into the in-memory cache, and purges dead jobs that have
   * sandbox metadata. Safe to call multiple times; idempotent.
   */
  async recover(): Promise<RecoverResult> {
    let recovered = 0;
    let removed = 0;

    let jobs: Awaited<ReturnType<NomadSandboxClient['listJobs']>> = [];
    try {
      jobs = await this.client.listJobs(NOMAD_JOB_PREFIX);
    } catch (error) {
      log.warn('Nomad job listing failed during recover', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return { recovered, removed };
    }

    for (const job of jobs) {
      const sandboxId = job.Meta?.[NOMAD_META.SANDBOX_ID];
      const codespaceId = job.Meta?.[NOMAD_META.PROJECT_ID];
      const jobName = job.ID;
      if (!sandboxId || !codespaceId || !jobName) continue;
      if (this.sandboxes.has(sandboxId)) continue;

      const status = mapNomadJobStatus(job.Status);
      if (status === 'stopped' || status === 'error') {
        try {
          await this.client.stopJob(jobName, true);
          removed++;
        } catch (stopErr) {
          log.warn('Failed to purge orphaned Nomad job during recover', {
            error: stopErr instanceof Error ? stopErr : new Error(String(stopErr)),
            data: { sandboxId, jobName },
          });
        }
        continue;
      }

      // Fetch allocation so we can reconstruct the instance
      let allocId: string | undefined;
      try {
        const allocations = await this.client.getJobAllocations(jobName);
        const runningAlloc = allocations.find((a) => a.ClientStatus === 'running');
        allocId = runningAlloc?.ID;
      } catch (allocErr) {
        log.warn('Failed to load allocations during recover', {
          error: allocErr instanceof Error ? allocErr : new Error(String(allocErr)),
          data: { sandboxId, jobName },
        });
        continue;
      }

      if (!allocId) {
        continue; // Pending/queued — skip, don't tear down yet
      }

      const instance = new NomadSandboxInstance(
        sandboxId,
        jobName,
        allocId,
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

    log.info('Nomad sandbox recovery complete', { data: { recovered, removed } });
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
        // refreshStatus() throws do not update _status, so force eviction here
        toEvict.push(sandboxId);
        continue;
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
    // Check in-memory cache first
    const sandboxId = this.codespaceToSandbox.get(codespaceId);
    if (sandboxId) {
      const cached = this.sandboxes.get(sandboxId);
      if (cached) {
        // Refresh status from cluster to avoid stale 'creating' status
        try {
          await cached.refreshStatus();
        } catch (error) {
          log.error(`refreshStatus failed for sandbox ${sandboxId} in get()`, {
            error: error instanceof Error ? error : new Error(String(error)),
            data: { codespaceId },
          });
          this.sandboxes.delete(sandboxId);
          this.codespaceToSandbox.delete(codespaceId);
          // Fall through to cluster query below
        }
        if (this.sandboxes.has(sandboxId)) {
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
    }

    try {
      // Fall through to cluster query using job listing with prefix filter.
      const jobs = await this.client.listJobs(NOMAD_JOB_PREFIX);

      // Find a job with matching project-id meta
      const matchingJob = jobs.find(
        (job) => job.Meta?.[NOMAD_META.PROJECT_ID] === codespaceId && job.Status === 'running'
      );

      if (!matchingJob) {
        if (codespaceId !== 'default') {
          log.warn(`No Nomad job found for codespace ${codespaceId}`);
        }
        return null;
      }

      const id = matchingJob.Meta?.[NOMAD_META.SANDBOX_ID] ?? createId();
      const name = matchingJob.ID;

      // Get allocations to find the alloc ID for exec
      const allocations = await this.client.getJobAllocations(name);
      const runningAlloc = allocations.find((a) => a.ClientStatus === 'running');
      if (!runningAlloc?.ID) {
        log.warn('Found matching Nomad job but no running allocation', {
          data: {
            jobName: name,
            codespaceId,
            allocStatuses: allocations
              .map((a) => `${a.ID?.slice(0, 8)}:${a.ClientStatus}`)
              .join(', '),
          },
        });
        return null;
      }
      const allocId = runningAlloc.ID;

      const instance = new NomadSandboxInstance(
        id,
        name,
        allocId,
        codespaceId,
        this.namespace,
        this.client
      );
      await instance.refreshStatus();

      // Cache it
      this.sandboxes.set(id, instance);
      this.codespaceToSandbox.set(codespaceId, id);

      return instance;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      const message = errorMessage(error);
      log.error(`Failed to get sandbox for codespace ${codespaceId}: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw error;
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
      const jobs = await this.client.listJobs(NOMAD_JOB_PREFIX);

      return jobs
        .filter((job) => job.Meta?.[NOMAD_META.SANDBOX_ID])
        .map((job) => ({
          id: job.Meta?.[NOMAD_META.SANDBOX_ID] ?? '',
          codespaceId: job.Meta?.[NOMAD_META.PROJECT_ID] ?? '',
          containerId: job.ID,
          status: mapNomadJobStatus(job.Status),
          image: this.image,
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          memoryMb: 0,
          cpuCores: 0,
        }));
    } catch (error) {
      const message = errorMessage(error);
      log.error(`Failed to list Nomad sandboxes: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw error;
    }
  }

  async pullImage(image: string): Promise<void> {
    // Nomad pulls images on scheduling (like Kubernetes). The Docker driver
    // handles imagePullPolicy. No pre-pull needed at the provider level.
    if (!image || image.trim() === '') {
      throw NomadErrors.IMAGE_NOT_FOUND(image);
    }
  }

  async isImageAvailable(image: string): Promise<boolean> {
    // Nomad Docker driver handles image pulls. Assume available if non-empty.
    return image !== undefined && image.trim() !== '';
  }

  async healthCheck(): Promise<SandboxHealthCheck> {
    try {
      const health = await this.client.healthCheck();

      if (!health.healthy) {
        const issues: string[] = [];
        if (!health.leader) issues.push('Cluster has no leader');
        if (!health.version) issues.push('Cluster is not reachable');
        if (!health.namespaceExists) issues.push(`Namespace '${this.namespace}' does not exist`);
        return {
          healthy: false,
          message: issues.length > 0 ? issues.join('; ') : 'Nomad cluster not reachable',
          details: {
            provider: 'nomad',
            namespace: this.namespace,
            clusterReachable: !!health.version,
            namespaceExists: health.namespaceExists,
            version: health.version,
            leader: health.leader,
            datacenter: health.datacenter,
          },
        };
      }

      return {
        healthy: true,
        details: {
          provider: 'nomad',
          namespace: this.namespace,
          namespaceExists: health.namespaceExists,
          version: health.version,
          leader: health.leader,
          datacenter: health.datacenter,
        },
      };
    } catch (error) {
      // Only treat known infrastructure errors as "unhealthy". Let programming
      // errors (TypeError, ReferenceError, etc.) propagate so they surface in
      // logs instead of being silently reported as a cluster health problem.
      if (error instanceof NomadApiError || error instanceof ConnectionError) {
        const message = error.message;
        log.error(`Nomad health check failed: ${message}`, { error });
        return {
          healthy: false,
          message: `Nomad health check failed: ${message}`,
          details: {
            provider: 'nomad',
            namespace: this.namespace,
          },
        };
      }
      throw error;
    }
  }

  async cleanup(options?: { olderThan?: Date; status?: string[] }): Promise<number> {
    let cleaned = 0;
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
        log.error(`Failed to stop sandbox ${sandboxId} during cleanup — removing from cache`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      // Always evict from cache regardless of stop success/failure
      this.sandboxes.delete(sandboxId);
      this.codespaceToSandbox.delete(instance.codespaceId);
    }

    return cleaned;
  }

  // --- Event emission (same pattern as AgentSandboxProvider) ---

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
        log.error(`Event listener error during ${event.type}`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }
}

/**
 * Factory function (mirrors createAgentSandboxProvider pattern).
 */
export function createNomadSandboxProvider(
  options?: NomadSandboxProviderOptions
): NomadSandboxProvider {
  return new NomadSandboxProvider(options);
}
