import { NOMAD_JOB_PREFIX } from './constants.js';
import { NomadHttpClient } from './http.js';
import { getAllocation, getAllocationStats, getJobAllocations } from './operations/allocations.js';
import { execInAllocation, execStreamInAllocation } from './operations/exec.js';
import { getJob, listJobs, registerJob, stopJob } from './operations/jobs.js';
import { waitForRunning } from './operations/lifecycle.js';
import type { WatchHandle, WatchJobCallback, WatchOptions } from './operations/watch.js';
import { watchJob } from './operations/watch.js';
import type { NomadAllocation, NomadAllocStats } from './types/allocation.js';
import type { NomadClientOptions } from './types/common.js';
import type { ExecOptions, ExecResult, ExecStreamOptions, ExecStreamResult } from './types/exec.js';
import type { NomadHealthCheckResult } from './types/health.js';
import type { NomadJob, NomadJobListStub, NomadJobRegisterResponse } from './types/job.js';

/**
 * Main facade for interacting with Nomad sandboxes.
 * Composes all operations into a single, ergonomic client.
 */
export class NomadSandboxClient {
  private readonly http: NomadHttpClient;

  constructor(options?: NomadClientOptions) {
    this.http = new NomadHttpClient(options);
  }

  // --- Jobs ---

  /** Register (create or update) a Nomad job */
  async registerJob(spec: NomadJob): Promise<NomadJobRegisterResponse> {
    return registerJob(this.http, spec);
  }

  /** Get a job by ID, returns null if not found */
  async getJob(jobId: string): Promise<NomadJob | null> {
    try {
      return await getJob(this.http, jobId);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        (error as { statusCode: number }).statusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  /** List jobs, optionally filtered by prefix */
  async listJobs(prefix?: string): Promise<NomadJobListStub[]> {
    return listJobs(this.http, prefix ?? NOMAD_JOB_PREFIX);
  }

  /** Stop (deregister) a job. Optionally purge it completely. */
  async stopJob(jobId: string, purge?: boolean): Promise<void> {
    await stopJob(this.http, jobId, purge);
  }

  // --- Allocations ---

  /** List allocations for a job */
  async getJobAllocations(jobId: string): Promise<NomadAllocation[]> {
    return getJobAllocations(this.http, jobId);
  }

  /** Get a single allocation by ID */
  async getAllocation(allocId: string): Promise<NomadAllocation> {
    return getAllocation(this.http, allocId);
  }

  /** Get resource usage statistics for an allocation */
  async getAllocationStats(allocId: string): Promise<NomadAllocStats> {
    return getAllocationStats(this.http, allocId);
  }

  // --- Exec ---

  /** Execute a command in an allocation (buffered) */
  async exec(options: ExecOptions): Promise<ExecResult> {
    return execInAllocation(this.http, options);
  }

  /** Execute a command in an allocation (streaming) */
  execStream(options: ExecStreamOptions): ExecStreamResult {
    return execStreamInAllocation(this.http, options);
  }

  // --- Lifecycle ---

  /** Wait for at least one allocation of a job to reach 'running' state */
  async waitForRunning(jobId: string, timeoutMs?: number): Promise<NomadAllocation> {
    return waitForRunning(this.http, jobId, timeoutMs);
  }

  // --- Watch ---

  /** Watch a job for changes using blocking queries */
  watchJob(jobId: string, callback: WatchJobCallback, options?: WatchOptions): WatchHandle {
    return watchJob(this.http, jobId, callback, options);
  }

  // --- Health ---

  /** Check Nomad cluster health, leader status, and namespace existence */
  async healthCheck(): Promise<NomadHealthCheckResult> {
    let leader: string | null = null;
    let version: string | null = null;
    let datacenter: string | null = null;
    let namespaceExists = false;

    // Check agent self info (connectivity, version, datacenter)
    try {
      const agentSelf = await this.http.request<{
        config?: {
          Datacenter?: string;
          Region?: string;
          Version?: string | { Version?: string };
        };
        member?: { Tags?: Record<string, string> };
        stats?: { nomad?: { leader_addr?: string } };
      }>('GET', '/v1/agent/self');

      // Nomad returns Version as an object {Version, BuildDate, ...} in newer versions
      const rawVersion = agentSelf.config?.Version;
      version =
        typeof rawVersion === 'string'
          ? rawVersion
          : ((rawVersion as { Version?: string })?.Version ?? null);
      datacenter = agentSelf.config?.Datacenter ?? null;

      // Check leader
      const status = await this.http.request<string>('GET', '/v1/status/leader');
      leader = status || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        healthy: false,
        leader: null,
        version: null,
        namespaceExists: false,
        datacenter: null,
        error: message,
      };
    }

    // Check namespace exists
    try {
      const namespaces = await this.http.request<Array<{ Name: string; Description: string }>>(
        'GET',
        '/v1/namespaces'
      );
      namespaceExists = namespaces.some((ns) => ns.Name === this.http.configuredNamespace);
    } catch {
      // Namespace check failed — might be OSS Nomad without namespace support
      // OSS Nomad only has 'default' namespace
      namespaceExists = this.http.configuredNamespace === 'default';
    }

    return {
      healthy: !!leader,
      leader,
      version,
      namespaceExists,
      datacenter,
    };
  }

  // --- Namespaces & Datacenters ---

  /** List all namespaces */
  async listNamespaces(): Promise<Array<{ Name: string; Description: string }>> {
    return this.http.request<Array<{ Name: string; Description: string }>>('GET', '/v1/namespaces');
  }

  /** List all datacenters */
  async listDatacenters(): Promise<string[]> {
    return this.http.request<string[]>('GET', '/v1/datacenters');
  }
}
