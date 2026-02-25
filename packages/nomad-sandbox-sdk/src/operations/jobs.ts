import type { NomadHttpClient } from '../http.js';
import type { NomadJob, NomadJobListStub, NomadJobRegisterResponse } from '../types/job.js';

/**
 * Register (create or update) a job.
 */
export async function registerJob(
  http: NomadHttpClient,
  jobSpec: NomadJob
): Promise<NomadJobRegisterResponse> {
  const result = await http.request<NomadJobRegisterResponse>('POST', '/v1/jobs', {
    body: { Job: jobSpec },
  });
  if (!result) {
    throw new Error('Job registration returned empty response');
  }
  return result;
}

/**
 * Get a job by ID.
 */
export async function getJob(http: NomadHttpClient, jobId: string): Promise<NomadJob> {
  const result = await http.request<NomadJob>('GET', `/v1/job/${encodeURIComponent(jobId)}`);
  if (!result) {
    throw new Error(`Job ${jobId} returned empty response`);
  }
  return result;
}

/**
 * List jobs, optionally filtered by prefix.
 */
export async function listJobs(
  http: NomadHttpClient,
  prefix?: string
): Promise<NomadJobListStub[]> {
  const query: Record<string, string> = {};
  if (prefix) {
    query.prefix = prefix;
  }
  return (await http.request<NomadJobListStub[]>('GET', '/v1/jobs', { query })) ?? [];
}

/**
 * Stop (deregister) a job.
 * If purge is true, the job is completely removed from Nomad.
 */
export async function stopJob(
  http: NomadHttpClient,
  jobId: string,
  purge?: boolean
): Promise<void> {
  const query: Record<string, string> = {};
  if (purge) {
    query.purge = 'true';
  }
  await http.request('DELETE', `/v1/job/${encodeURIComponent(jobId)}`, { query });
}
