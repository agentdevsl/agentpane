import type { NomadHttpClient } from '../http.js';
import type { NomadJob } from '../types/job.js';
import { sleep } from '../utils.js';

/**
 * Handle returned by watch operations
 */
export interface WatchHandle {
  /** Stop watching */
  stop(): void;
}

/**
 * Callback invoked when a watched job changes
 */
export type WatchJobCallback = (job: NomadJob) => void;

/**
 * Options for watch operations
 */
export interface WatchOptions {
  /** Blocking query wait parameter (default: '30s') */
  wait?: string;
  /** Poll interval fallback in ms if blocking query returns immediately */
  minPollMs?: number;
  /** Callback invoked when the watch loop encounters a fatal error (e.g. 403, 404) */
  onError?: (error: Error) => void;
}

/**
 * Watch a job for changes using Nomad's blocking query mechanism.
 * Uses `?index=N&wait=30s` for near-instant change detection.
 * Returns a handle with a stop() method.
 */
export function watchJob(
  http: NomadHttpClient,
  jobId: string,
  callback: WatchJobCallback,
  options?: WatchOptions
): WatchHandle {
  let stopped = false;
  let currentIndex = 0;
  const wait = options?.wait ?? '30s';
  const minPollMs = options?.minPollMs ?? 500;

  const poll = async () => {
    while (!stopped) {
      try {
        const result = await http.blockingQuery<NomadJob>(
          `/v1/job/${encodeURIComponent(jobId)}`,
          currentIndex,
          wait
        );

        if (stopped) break;

        // Only invoke callback if index actually changed
        if (result.index > currentIndex) {
          currentIndex = result.index;
          callback(result.data);
        }

        // Prevent tight loops if the server returns immediately
        await sleep(minPollMs);
      } catch (error) {
        if (stopped) break;
        // Stop watching on fatal errors
        if (error && typeof error === 'object' && 'statusCode' in error) {
          const statusCode = (error as { statusCode: number }).statusCode;
          if (statusCode === 404) {
            // Job was deleted — stop watching
            options?.onError?.(error instanceof Error ? error : new Error(String(error)));
            break;
          }
          if (statusCode === 403) {
            console.error(`[NomadSDK] Watch for ${jobId} stopped: authentication failed`);
            options?.onError?.(error instanceof Error ? error : new Error(String(error)));
            break;
          }
        }
        console.warn(
          `[NomadSDK] Watch poll error for ${jobId}:`,
          error instanceof Error ? error.message : String(error)
        );
        // Back off on retryable errors
        await sleep(2000);
      }
    }
  };

  // Start polling (fire and forget)
  poll().catch((err) => {
    options?.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    stop() {
      stopped = true;
    },
  };
}
