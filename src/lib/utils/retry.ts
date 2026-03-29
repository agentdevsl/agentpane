import { createLogger } from '../logging/logger.js';

const log = createLogger('Retry');

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default: 30000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Optional jitter factor 0-1 to randomize delay (default: 0.1) */
  jitterFactor?: number;
  /** Function to determine if an error is retryable (default: checks for transient HTTP errors) */
  isRetryable?: (error: unknown) => boolean;
  /** Optional label for logging */
  label?: string;
  /** Optional AbortSignal to cancel retries */
  signal?: AbortSignal;
}

/** Default check for transient/retryable errors (429, 500, 502, 503, 504, network errors) */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }
    // Check for status property on error objects
    const statusError = error as Error & {
      status?: number;
      statusCode?: number;
    };
    const status = statusError.status ?? statusError.statusCode;
    if (status && (status === 429 || status >= 500)) {
      return true;
    }
  }
  return false;
}

/**
 * Execute a function with retry logic and exponential backoff.
 * Only retries on transient errors by default.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30_000,
    backoffMultiplier = 2,
    jitterFactor = 0.1,
    isRetryable = isTransientError,
    label = 'operation',
    signal,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error(`Retry aborted for '${label}'`);
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const baseDelay = Math.min(initialDelayMs * backoffMultiplier ** attempt, maxDelayMs);
      const jitter = baseDelay * jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(baseDelay + jitter));

      log.warn(`Retrying '${label}' after transient error (attempt ${attempt + 1}/${maxRetries})`, {
        error: error instanceof Error ? error.message : String(error),
        data: { attempt: attempt + 1, maxRetries, delayMs: delay },
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error(`Retry aborted for '${label}'`));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }

  throw lastError;
}
