import {
  NOMAD_JOB_PREFIX,
  NOMAD_META,
  NomadJobBuilder,
  NomadSandboxClient,
} from '@agentpane/nomad-sandbox-sdk';
import { createId } from '@paralleldrive/cuid2';
import { NomadErrors } from '../../errors/nomad-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { SandboxConfig, SandboxHealthCheck, SandboxInfo, SandboxStatus } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import { NomadSandboxInstance } from './nomad-sandbox-instance.js';
import type {
  EventEmittingSandboxProvider,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';

const log = createLogger('NomadSandboxProvider');

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

  readonly client: NomadSandboxClient;
  private readonly namespace: string;
  private readonly datacenter: string;
  private readonly image: string;
  private readonly readyTimeoutSeconds: number;

  private sandboxes = new Map<string, NomadSandboxInstance>();
  private projectToSandbox = new Map<string, string>();
  private listeners = new Set<SandboxProviderEventListener>();

  constructor(options: NomadSandboxProviderOptions = {}) {
    this.namespace = options.namespace ?? PROVIDER_DEFAULTS.namespace;
    this.datacenter = options.datacenter ?? PROVIDER_DEFAULTS.datacenter;
    this.image = options.image ?? SANDBOX_DEFAULTS.image;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? PROVIDER_DEFAULTS.readyTimeoutSeconds;

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

  // --- SandboxProvider interface ---

  async create(config: SandboxConfig): Promise<Sandbox> {
    // Check for existing sandbox for this project
    const existing = this.projectToSandbox.get(config.projectId);
    if (existing) {
      const sandbox = this.sandboxes.get(existing);
      if (sandbox && sandbox.status !== 'stopped') {
        throw NomadErrors.JOB_ALREADY_EXISTS(config.projectId);
      }
    }

    const sandboxId = createId();
    // Job names must be DNS-compatible: lowercase alphanumeric and hyphens
    const jobName = `agentpane-${config.projectId.slice(0, 20)}-${sandboxId.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');

    this.emit({
      type: 'sandbox:creating',
      sandboxId,
      projectId: config.projectId,
    });

    try {
      // Build the Nomad job spec using NomadJobBuilder from the SDK.
      const jobSpec = new NomadJobBuilder(jobName)
        .type('service')
        .namespace(this.namespace)
        .datacenter(this.datacenter)
        .image(config.image)
        .resources(config.cpuCores * 1000, config.memoryMb)
        .meta(NOMAD_META.SANDBOX_ID, sandboxId)
        .meta(NOMAD_META.PROJECT_ID, config.projectId)
        .build();

      // Register the job with Nomad
      await this.client.registerJob(jobSpec);

      // Wait for the job to reach running status
      await this.client.waitForRunning(jobName, this.readyTimeoutSeconds * 1000);

      // Get allocations to find the alloc ID for exec
      const allocations = await this.client.getJobAllocations(jobName);
      const runningAlloc = allocations.find(
        (a: { ClientStatus?: string }) => a.ClientStatus === 'running'
      );
      const allocId = runningAlloc?.ID ?? allocations[0]?.ID ?? '';

      if (!allocId) {
        throw new Error('No allocation found after job started');
      }

      // Create the Sandbox interface wrapper
      const instance = new NomadSandboxInstance(
        sandboxId,
        jobName,
        allocId,
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
        containerId: jobName,
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
      throw NomadErrors.JOB_CREATION_FAILED(jobName, message);
    }
  }

  async validateSandboxes(): Promise<void> {
    for (const [sandboxId, instance] of this.sandboxes) {
      await instance.refreshStatus();
      if (instance.status === 'error' || instance.status === 'stopped') {
        log.info('Evicting stale sandbox from cache', {
          data: { sandboxId, projectId: instance.projectId, status: instance.status },
        });
        this.sandboxes.delete(sandboxId);
        this.projectToSandbox.delete(instance.projectId);
      }
    }
  }

  async get(projectId: string): Promise<Sandbox | null> {
    // Check in-memory cache first
    const sandboxId = this.projectToSandbox.get(projectId);
    if (sandboxId) {
      const cached = this.sandboxes.get(sandboxId);
      if (cached) {
        // Refresh status from cluster to avoid stale 'creating' status
        await cached.refreshStatus();
        if (cached.status === 'error' || cached.status === 'stopped') {
          log.info('Evicting stale sandbox from get() cache', {
            data: { sandboxId, projectId, status: cached.status },
          });
          this.sandboxes.delete(sandboxId);
          this.projectToSandbox.delete(projectId);
          // Fall through to cluster query below
        } else {
          return cached;
        }
      }
    }

    // Fall through to cluster query using job listing with prefix filter.
    try {
      const jobs = await this.client.listJobs(NOMAD_JOB_PREFIX);

      // Find a job with matching project-id meta
      const matchingJob = jobs.find(
        (job) => job.Meta?.[NOMAD_META.PROJECT_ID] === projectId && job.Status === 'running'
      );

      if (!matchingJob) {
        // Fall back to default sandbox (mirrors AgentSandboxProvider.get)
        if (projectId !== 'default') {
          return this.get('default');
        }
        return null;
      }

      const id = matchingJob.Meta?.[NOMAD_META.SANDBOX_ID] ?? createId();
      const name = matchingJob.ID;

      // Get allocations to find the alloc ID for exec
      const allocations = await this.client.getJobAllocations(name);
      const runningAlloc = allocations.find((a) => a.ClientStatus === 'running');
      const allocId = runningAlloc?.ID ?? allocations[0]?.ID ?? '';

      const instance = new NomadSandboxInstance(
        id,
        name,
        allocId,
        projectId,
        this.namespace,
        this.client
      );
      await instance.refreshStatus();

      // Cache it
      this.sandboxes.set(id, instance);
      this.projectToSandbox.set(projectId, id);

      return instance;
    } catch (error) {
      // Distinguish "not found" from actual cluster errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotFoundError') {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to query sandbox for project ${projectId}: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      // Propagate cluster connectivity/auth errors so callers know the lookup failed
      throw NomadErrors.CLUSTER_UNREACHABLE('cluster', message);
    }
  }

  async getById(sandboxId: string): Promise<Sandbox | null> {
    const cached = this.sandboxes.get(sandboxId);
    if (cached) {
      await cached.refreshStatus();
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
          projectId: job.Meta?.[NOMAD_META.PROJECT_ID] ?? '',
          containerId: job.ID,
          status: this.mapJobStatus(job.Status),
          image: this.image,
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          memoryMb: 0,
          cpuCores: 0,
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list sandboxes', {
        error: error instanceof Error ? error : new Error(message),
      });
      throw NomadErrors.CLUSTER_UNREACHABLE('cluster', message);
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        healthy: false,
        message: `Nomad health check failed: ${message}`,
        details: {
          provider: 'nomad',
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
          log.error(`Failed to cleanup sandbox ${sandboxId}: ${message}`, {
            error: error instanceof Error ? error : new Error(message),
          });
        }
      }
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
        log.error('Event listener error', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  // --- Helpers ---

  /**
   * Map Nomad job status string to SandboxStatus type.
   *
   * Nomad job statuses: 'pending' | 'running' | 'dead'
   * SandboxStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
   */
  private mapJobStatus(status?: string): SandboxStatus {
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
}

/**
 * Factory function (mirrors createAgentSandboxProvider pattern).
 */
export function createNomadSandboxProvider(
  options?: NomadSandboxProviderOptions
): NomadSandboxProvider {
  return new NomadSandboxProvider(options);
}
