import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransientError, withRetry } from '../retry.js';

describe('isTransientError', () => {
  it('returns true for errors with .status 429, 500, 502, 503, 504', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const error = Object.assign(new Error('http error'), { status });
      expect(isTransientError(error)).toBe(true);
    }
  });

  it('returns true for errors with .statusCode >= 500', () => {
    for (const statusCode of [500, 502, 503, 504, 520]) {
      const error = Object.assign(new Error('server error'), { statusCode });
      expect(isTransientError(error)).toBe(true);
    }
  });

  it('returns true for errors with .type === "overloaded_error"', () => {
    const error = Object.assign(new Error('overloaded'), { type: 'overloaded_error' });
    expect(isTransientError(error)).toBe(true);
  });

  it('returns true for errors with .type === "api_error"', () => {
    const error = Object.assign(new Error('api error'), { type: 'api_error' });
    expect(isTransientError(error)).toBe(true);
  });

  it('returns true for network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, socket hang up, fetch failed', () => {
    const messages = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'socket hang up', 'fetch failed'];
    for (const msg of messages) {
      expect(isTransientError(new Error(msg))).toBe(true);
    }
  });

  it('returns true for "rate limit" in message', () => {
    expect(isTransientError(new Error('Rate limit exceeded'))).toBe(true);
  });

  it('returns false for 400, 404, 403 status codes', () => {
    for (const status of [400, 404, 403]) {
      const error = Object.assign(new Error('client error'), { status });
      expect(isTransientError(error)).toBe(false);
    }
  });

  it('returns false for non-Error values (string, null, undefined, number)', () => {
    expect(isTransientError('some string')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it('returns false for generic Error with message like "Expected 500 items" (no substring false positive)', () => {
    const error = new Error('Expected 500 items');
    expect(isTransientError(error)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds on attempt N', async () => {
    vi.useFakeTimers();
    const transientError = Object.assign(new Error('server down'), { status: 503 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { initialDelayMs: 100, jitterFactor: 0 });

    // Advance through first retry delay
    await vi.advanceTimersByTimeAsync(100);
    // Advance through second retry delay (100 * 2^1 = 200)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('throws non-retryable errors immediately without retry', async () => {
    const clientError = Object.assign(new Error('not found'), { status: 404 });
    const fn = vi.fn().mockRejectedValue(clientError);

    await expect(withRetry(fn)).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries limit', async () => {
    vi.useFakeTimers();
    const transientError = Object.assign(new Error('overloaded'), { status: 503 });
    const fn = vi.fn().mockRejectedValue(transientError);

    const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 50, jitterFactor: 0 }).catch(
      (e: unknown) => e,
    );

    // Advance through all retry delays
    await vi.advanceTimersByTimeAsync(200);

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('overloaded');
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('respects AbortSignal — aborts during delay', async () => {
    const controller = new AbortController();
    const transientError = Object.assign(new Error('timeout'), { status: 503 });
    const fn = vi.fn().mockRejectedValue(transientError);

    const promise = withRetry(fn, {
      maxRetries: 5,
      initialDelayMs: 5000,
      jitterFactor: 0,
      signal: controller.signal,
      label: 'abort-test',
    });

    // Let the first attempt fail and enter the delay
    await new Promise((r) => setTimeout(r, 50));

    // Abort during the delay
    controller.abort();

    await expect(promise).rejects.toThrow("Retry aborted for 'abort-test'");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('custom isRetryable function is honored', async () => {
    vi.useFakeTimers();
    const customError = new Error('custom retryable');
    const fn = vi.fn().mockRejectedValueOnce(customError).mockResolvedValue('done');

    const promise = withRetry(fn, {
      initialDelayMs: 10,
      jitterFactor: 0,
      isRetryable: (err) => err instanceof Error && err.message === 'custom retryable',
    });

    await vi.advanceTimersByTimeAsync(10);

    const result = await promise;

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('delay increases exponentially', async () => {
    vi.useFakeTimers();
    const transientError = Object.assign(new Error('busy'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(transientError);

    // Catch the rejection early to avoid unhandled rejection warnings
    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      jitterFactor: 0,
    }).catch((e: unknown) => e);

    // Attempt 0 fails immediately, delay = 100 * 2^0 = 100ms
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2); // attempt 1

    // Attempt 1 fails, delay = 100 * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3); // attempt 2

    // Attempt 2 fails, delay = 100 * 2^2 = 400ms
    await vi.advanceTimersByTimeAsync(399);
    expect(fn).toHaveBeenCalledTimes(3); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(4); // attempt 3 (final)

    const caught = await promise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('busy');

    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
