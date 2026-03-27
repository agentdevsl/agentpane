/**
 * GitHub API rate limit utilities.
 */
import type { Octokit } from 'octokit';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';

export interface RateLimitResource {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

export interface RateLimitStatus {
  core: RateLimitResource;
  search: RateLimitResource;
  graphql: RateLimitResource;
}

function parseResource(data: {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}): RateLimitResource {
  return {
    limit: data.limit,
    remaining: data.remaining,
    reset: new Date(data.reset * 1000),
    used: data.used,
  };
}

const EMPTY_RESOURCE: RateLimitResource = {
  limit: 0,
  remaining: 0,
  reset: new Date(0),
  used: 0,
};

/**
 * Fetch the current rate limit status from the GitHub API.
 */
export async function getRateLimitStatus(
  octokit: Octokit
): Promise<Result<RateLimitStatus, Error>> {
  try {
    const { data } = await octokit.rest.rateLimit.get();

    return ok({
      core: parseResource(data.rate),
      search: data.resources.search ? parseResource(data.resources.search) : EMPTY_RESOURCE,
      graphql: data.resources.graphql
        ? parseResource(
            data.resources.graphql as {
              limit: number;
              remaining: number;
              reset: number;
              used: number;
            }
          )
        : EMPTY_RESOURCE,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Default threshold: warn when remaining < 10% of limit */
const DEFAULT_THRESHOLD = 10;

/**
 * Check if the current rate limit is below a safe threshold.
 */
export function checkRateLimit(
  status: RateLimitStatus,
  threshold = DEFAULT_THRESHOLD
): Result<true, { code: string; message: string; resetAt: Date }> {
  if (status.core.remaining < threshold) {
    return err({
      code: 'GITHUB_RATE_LIMITED',
      message: `Core rate limit nearly exhausted: ${status.core.remaining}/${status.core.limit}`,
      resetAt: status.core.reset,
    });
  }
  return ok(true);
}

export interface RateLimitRetryOptions {
  maxRetries?: number;
  onRateLimited?: (resetAt: Date) => void;
}

/**
 * Retry a function with rate limit handling.
 * If a 429 error is received, waits until the rate limit resets and retries.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RateLimitRetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, onRateLimited } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const statusCode = (error as { status?: number }).status;

      // On last attempt, don't retry
      if (attempt >= maxRetries - 1) {
        break;
      }

      if (statusCode === 429) {
        const resetHeader = (error as { response?: { headers?: Record<string, string> } }).response
          ?.headers?.['x-ratelimit-reset'];
        const resetTimestamp = resetHeader ? Number.parseInt(resetHeader, 10) : 0;
        const resetDate = new Date(resetTimestamp * 1000);

        onRateLimited?.(resetDate);

        // Wait until reset time (minimum 100ms to prevent busy loop)
        const waitMs = Math.max(100, resetDate.getTime() - Date.now());
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      // All errors are retried up to maxRetries
    }
  }

  throw lastError;
}
