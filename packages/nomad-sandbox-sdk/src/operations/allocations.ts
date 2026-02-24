import type { NomadHttpClient } from '../http.js';
import type { NomadAllocation, NomadAllocStats } from '../types/allocation.js';

/**
 * List allocations for a specific job.
 */
export async function getJobAllocations(
  http: NomadHttpClient,
  jobId: string
): Promise<NomadAllocation[]> {
  return (
    (await http.request<NomadAllocation[]>(
      'GET',
      `/v1/job/${encodeURIComponent(jobId)}/allocations`
    )) ?? []
  );
}

/**
 * Get a single allocation by ID.
 */
export async function getAllocation(
  http: NomadHttpClient,
  allocId: string
): Promise<NomadAllocation> {
  const result = await http.request<NomadAllocation>(
    'GET',
    `/v1/allocation/${encodeURIComponent(allocId)}`
  );
  if (!result) {
    throw new Error(`Allocation ${allocId} returned empty response`);
  }
  return result;
}

/**
 * Get resource usage statistics for an allocation.
 */
export async function getAllocationStats(
  http: NomadHttpClient,
  allocId: string
): Promise<NomadAllocStats> {
  const result = await http.request<NomadAllocStats>(
    'GET',
    `/v1/client/allocation/${encodeURIComponent(allocId)}/stats`
  );
  if (!result) {
    throw new Error(`Allocation stats for ${allocId} returned empty response`);
  }
  return result;
}
