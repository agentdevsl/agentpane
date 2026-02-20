import type { NomadHttpClient } from '../http.js';
import type {
  NomadJob,
  NomadJobDeregisterResponse,
  NomadJobListStub,
  NomadJobRegisterResponse,
} from '../types/job.js';

/**
 * Register (create or update) a job.
 */
export async function registerJob(
  http: NomadHttpClient,
  jobSpec: NomadJob
): Promise<NomadJobRegisterResponse> {
  return http.request<NomadJobRegisterResponse>('POST', '/v1/jobs', {
    body: { Job: jobSpec },
  });
}

/**
 * Get a job by ID.
 */
export async function getJob(http: NomadHttpClient, jobId: string): Promise<NomadJob> {
  return http.request<NomadJob>('GET', `/v1/job/${encodeURIComponent(jobId)}`);
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
  return http.request<NomadJobListStub[]>('GET', '/v1/jobs', { query });
}

/**
 * Stop (deregister) a job.
 * If purge is true, the job is completely removed from Nomad.
 */
export async function stopJob(
  http: NomadHttpClient,
  jobId: string,
  purge?: boolean
): Promise<NomadJobDeregisterResponse> {
  const query: Record<string, string> = {};
  if (purge) {
    query.purge = 'true';
  }
  return http.request<NomadJobDeregisterResponse>(
    'DELETE',
    `/v1/job/${encodeURIComponent(jobId)}`,
    { query }
  );
}
