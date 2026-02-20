import type { NomadHttpClient } from '../http.js';
import type { NomadAllocation, NomadAllocStats } from '../types/allocation.js';

/**
 * List allocations for a specific job.
 */
export async function getJobAllocations(
  http: NomadHttpClient,
  jobId: string
): Promise<NomadAllocation[]> {
  return http.request<NomadAllocation[]>('GET', `/v1/job/${encodeURIComponent(jobId)}/allocations`);
}

/**
 * Get a single allocation by ID.
 */
export async function getAllocation(
  http: NomadHttpClient,
  allocId: string
): Promise<NomadAllocation> {
  return http.request<NomadAllocation>('GET', `/v1/allocation/${encodeURIComponent(allocId)}`);
}

/**
 * Get resource usage statistics for an allocation.
 */
export async function getAllocationStats(
  http: NomadHttpClient,
  allocId: string
): Promise<NomadAllocStats> {
  return http.request<NomadAllocStats>(
    'GET',
    `/v1/client/allocation/${encodeURIComponent(allocId)}/stats`
  );
}
