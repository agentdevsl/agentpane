import { NOMAD_DEFAULTS } from '../constants.js';
import { TimeoutError } from '../errors.js';
import type { NomadHttpClient } from '../http.js';
import type { NomadAllocation } from '../types/allocation.js';
import { getJobAllocations } from './allocations.js';

/**
 * Wait for at least one allocation of a job to reach the 'running' state.
 * Uses progressive backoff polling (1.5x growth factor).
 *
 * @returns The first running allocation found
 * @throws TimeoutError if no allocation is running within the timeout
 */
export async function waitForRunning(
  http: NomadHttpClient,
  jobId: string,
  timeoutMs?: number
): Promise<NomadAllocation> {
  const timeout = timeoutMs ?? NOMAD_DEFAULTS.readyTimeoutMs;
  const deadline = Date.now() + timeout;
  let pollMs = 500;
  const maxPollMs = 5000;

  while (Date.now() < deadline) {
    const allocations = await getJobAllocations(http, jobId);

    const running = allocations.find((a) => a.ClientStatus === 'running');
    if (running) {
      return running;
    }

    // Check for terminal failures
    const failed = allocations.find(
      (a) => a.ClientStatus === 'failed' || a.DesiredStatus === 'stop'
    );
    if (
      failed &&
      allocations.every((a) => a.ClientStatus === 'failed' || a.ClientStatus === 'lost')
    ) {
      const taskStates = failed.TaskStates ?? {};
      const events = Object.values(taskStates).flatMap((ts) =>
        ts.Events.filter((e) => e.FailsTask).map((e) => e.DisplayMessage ?? e.Message ?? e.Type)
      );
      throw new Error(
        `All allocations for job "${jobId}" failed: ${events.join('; ') || 'unknown reason'}`
      );
    }

    await sleep(pollMs);
    // Exponential backoff
    pollMs = Math.min(pollMs * 1.5, maxPollMs);
  }

  throw new TimeoutError(`waitForRunning(${jobId})`, timeout);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
