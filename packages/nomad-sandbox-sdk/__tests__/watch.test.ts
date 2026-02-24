import { beforeEach, describe, expect, it, vi } from 'vitest';
import { watchJob } from '../src/operations/watch.js';
import type { NomadJob } from '../src/types/job.js';

// Mock the sleep utility so tests don't actually wait
vi.mock('../src/utils.js', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}));

const createMockHttp = () => ({
  request: vi.fn(),
  blockingQuery: vi.fn(),
  wsBaseUrl: 'ws://127.0.0.1:4646',
  configuredNamespace: 'default',
  configuredToken: undefined,
});

const stubJob = (id: string): NomadJob => ({
  ID: id,
  Name: id,
  TaskGroups: [],
});

/**
 * Helper: creates a blockingQuery mock that auto-stops the watch handle
 * after `maxCalls` invocations, preventing runaway loops.
 */
function createBoundedMock(
  impl: (callNum: number) => { data: NomadJob; index: number },
  maxCalls: number,
  handleRef: { current: ReturnType<typeof watchJob> | null }
) {
  let callCount = 0;
  return vi.fn(async () => {
    callCount++;
    if (callCount > maxCalls) {
      handleRef.current?.stop();
      // Return same data to avoid triggering callback
      return { data: stubJob('stopped'), index: 0 };
    }
    return impl(callCount);
  });
}

/**
 * Flush the microtask queue enough times for the polling loop to settle.
 */
async function flushLoop(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
  // Also give macrotask queue a chance
  await new Promise((r) => setTimeout(r, 10));
}

describe('watchJob', () => {
  let http: ReturnType<typeof createMockHttp>;

  beforeEach(() => {
    http = createMockHttp();
    vi.clearAllMocks();
  });

  it('calls blockingQuery in a loop with incrementing index', async () => {
    const handleRef: { current: ReturnType<typeof watchJob> | null } = { current: null };

    http.blockingQuery = createBoundedMock(
      (n) => ({ data: stubJob('test-job'), index: n }),
      3,
      handleRef
    );

    const callback = vi.fn();
    const handle = watchJob(http as any, 'test-job', callback, {
      wait: '5s',
      minPollMs: 0,
    });
    handleRef.current = handle;

    await flushLoop();

    // Verify incrementing index: first call index=0, second call index=1, third call index=2
    expect(http.blockingQuery).toHaveBeenNthCalledWith(
      1,
      '/v1/job/test-job',
      0,
      '5s',
      expect.any(AbortSignal)
    );
    expect(http.blockingQuery).toHaveBeenNthCalledWith(
      2,
      '/v1/job/test-job',
      1,
      '5s',
      expect.any(AbortSignal)
    );
    expect(http.blockingQuery).toHaveBeenNthCalledWith(
      3,
      '/v1/job/test-job',
      2,
      '5s',
      expect.any(AbortSignal)
    );
  });

  it('invokes callback with updated job data when index changes', async () => {
    const handleRef: { current: ReturnType<typeof watchJob> | null } = { current: null };

    http.blockingQuery = createBoundedMock(
      (n) => ({ data: stubJob(`job-v${n}`), index: n }),
      3,
      handleRef
    );

    const callback = vi.fn();
    const handle = watchJob(http as any, 'my-job', callback, { minPollMs: 0 });
    handleRef.current = handle;

    await flushLoop();

    // Each call returns an increasing index, so callback fires for each
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, expect.objectContaining({ ID: 'job-v1' }));
    expect(callback).toHaveBeenNthCalledWith(2, expect.objectContaining({ ID: 'job-v2' }));
    expect(callback).toHaveBeenNthCalledWith(3, expect.objectContaining({ ID: 'job-v3' }));
  });

  it('does not invoke callback when index stays the same', async () => {
    const handleRef: { current: ReturnType<typeof watchJob> | null } = { current: null };

    http.blockingQuery = createBoundedMock(
      // Always return index=1 — only the first call changes from 0→1
      () => ({ data: stubJob('static-job'), index: 1 }),
      5,
      handleRef
    );

    const callback = vi.fn();
    const handle = watchJob(http as any, 'static-job', callback, { minPollMs: 0 });
    handleRef.current = handle;

    await flushLoop();

    // Only the first call changes from index 0 -> 1
    expect(callback).toHaveBeenCalledTimes(1);
    // 5 bounded calls + 1 guard call that triggers stop()
    expect(http.blockingQuery.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('returns a WatchHandle with stop() method that breaks the loop', async () => {
    const handleRef: { current: ReturnType<typeof watchJob> | null } = { current: null };

    http.blockingQuery = createBoundedMock(
      () => ({ data: stubJob('job'), index: 1 }),
      10,
      handleRef
    );

    const callback = vi.fn();
    const handle = watchJob(http as any, 'job', callback, { minPollMs: 0 });
    handleRef.current = handle;

    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe('function');

    // Let it run at least once
    await vi.waitFor(() => {
      expect(http.blockingQuery).toHaveBeenCalled();
    });

    handle.stop();

    // Record count after stop
    const callsAfterStop = http.blockingQuery.mock.calls.length;

    await flushLoop();

    // Should not have made significantly more calls after stopping
    // Allow at most 1 extra call that was in-flight
    expect(http.blockingQuery.mock.calls.length).toBeLessThanOrEqual(callsAfterStop + 1);
  });

  it('handles 404 errors by calling onError and stopping the loop', async () => {
    const error404 = Object.assign(new Error('Not found'), { statusCode: 404 });

    http.blockingQuery
      .mockResolvedValueOnce({ data: stubJob('disappearing-job'), index: 1 })
      .mockRejectedValue(error404);

    const callback = vi.fn();
    const onError = vi.fn();

    watchJob(http as any, 'disappearing-job', callback, { onError, minPollMs: 0 });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    expect(onError).toHaveBeenCalledWith(error404);

    // Record calls after error
    const callsAfterError = http.blockingQuery.mock.calls.length;

    await flushLoop();

    // Loop should have stopped — no more calls
    expect(http.blockingQuery.mock.calls.length).toBe(callsAfterError);
  });

  it('handles 403 errors by calling onError and stopping the loop', async () => {
    const error403 = Object.assign(new Error('Forbidden'), { statusCode: 403 });

    http.blockingQuery.mockRejectedValue(error403);

    const callback = vi.fn();
    const onError = vi.fn();

    watchJob(http as any, 'secret-job', callback, { onError, minPollMs: 0 });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    expect(onError).toHaveBeenCalledWith(error403);
    expect(callback).not.toHaveBeenCalled();

    // Loop should have stopped
    const callsAfterError = http.blockingQuery.mock.calls.length;
    await flushLoop();
    expect(http.blockingQuery.mock.calls.length).toBe(callsAfterError);
  });

  it('handles other errors by retrying with backoff (2s sleep)', async () => {
    const { sleep } = await import('../src/utils.js');
    const networkError = new Error('ECONNREFUSED');
    const handleRef: { current: ReturnType<typeof watchJob> | null } = { current: null };
    let callCount = 0;

    http.blockingQuery.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        throw networkError;
      }
      // Stop after recovery to prevent runaway loop
      if (callCount >= 4) {
        handleRef.current?.stop();
        return { data: stubJob('stopped'), index: 0 };
      }
      return { data: stubJob('recovered-job'), index: callCount };
    });

    const callback = vi.fn();
    const onError = vi.fn();
    const handle = watchJob(http as any, 'recovered-job', callback, {
      onError,
      minPollMs: 0,
    });
    handleRef.current = handle;

    await flushLoop();

    // onError should NOT have been called — retryable errors don't invoke onError
    expect(onError).not.toHaveBeenCalled();

    // callback should have fired when callCount=3 succeeded
    expect(callback).toHaveBeenCalledTimes(1);

    // sleep should have been called with 2000 for the backoff
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('uses default wait of 30s when no options provided', async () => {
    // Use a single response then stop via error-free approach
    let called = false;
    http.blockingQuery.mockImplementation(async () => {
      if (called) {
        // Block indefinitely (will be cleaned up by handle.stop())
        return new Promise(() => {});
      }
      called = true;
      return { data: stubJob('default-job'), index: 1 };
    });

    const callback = vi.fn();
    const handle = watchJob(http as any, 'default-job', callback);

    await vi.waitFor(() => {
      expect(http.blockingQuery).toHaveBeenCalled();
    });

    handle.stop();

    expect(http.blockingQuery).toHaveBeenCalledWith(
      '/v1/job/default-job',
      0,
      '30s',
      expect.any(AbortSignal)
    );
  });

  it('URL-encodes the jobId in the path', async () => {
    let called = false;
    http.blockingQuery.mockImplementation(async () => {
      if (called) {
        return new Promise(() => {});
      }
      called = true;
      return { data: stubJob('my/special job'), index: 1 };
    });

    const callback = vi.fn();
    const handle = watchJob(http as any, 'my/special job', callback, { minPollMs: 0 });

    await vi.waitFor(() => {
      expect(http.blockingQuery).toHaveBeenCalled();
    });

    handle.stop();

    expect(http.blockingQuery).toHaveBeenCalledWith(
      '/v1/job/my%2Fspecial%20job',
      0,
      '30s',
      expect.any(AbortSignal)
    );
  });
});
