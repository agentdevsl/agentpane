import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError } from '../src/errors.js';
import type { NomadHttpClient } from '../src/http.js';
import { waitForRunning } from '../src/operations/lifecycle.js';
import type { NomadAllocation } from '../src/types/allocation.js';

// Mock the allocations module
vi.mock('../src/operations/allocations.js', () => ({
  getJobAllocations: vi.fn(),
}));

// Mock the utils module (sleep) to avoid real delays
vi.mock('../src/utils.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { getJobAllocations } from '../src/operations/allocations.js';

const mockedGetJobAllocations = vi.mocked(getJobAllocations);

function createMockHttpClient(): NomadHttpClient {
  return {} as NomadHttpClient;
}

function createAllocation(overrides: Partial<NomadAllocation> = {}): NomadAllocation {
  return {
    ID: 'alloc-1',
    EvalID: 'eval-1',
    Name: 'job.main[0]',
    Namespace: 'default',
    NodeID: 'node-1',
    JobID: 'test-job',
    TaskGroup: 'main',
    ClientStatus: 'pending',
    DesiredStatus: 'run',
    CreateIndex: 1,
    ModifyIndex: 2,
    CreateTime: Date.now() * 1_000_000,
    ModifyTime: Date.now() * 1_000_000,
    ...overrides,
  };
}

describe('waitForRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers so Date.now() can be controlled for deadline checks
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns running allocation on first poll', async () => {
    const runningAlloc = createAllocation({ ClientStatus: 'running' });
    mockedGetJobAllocations.mockResolvedValueOnce([runningAlloc]);

    const http = createMockHttpClient();
    const result = await waitForRunning(http, 'test-job', 10_000);

    expect(result).toEqual(runningAlloc);
    expect(mockedGetJobAllocations).toHaveBeenCalledTimes(1);
  });

  it('polls until allocation reaches running state', async () => {
    const pendingAlloc = createAllocation({ ClientStatus: 'pending' });
    const runningAlloc = createAllocation({ ClientStatus: 'running' });

    // First call returns pending, second returns running
    mockedGetJobAllocations
      .mockResolvedValueOnce([pendingAlloc])
      .mockResolvedValueOnce([runningAlloc]);

    const http = createMockHttpClient();
    const result = await waitForRunning(http, 'test-job', 60_000);

    expect(result).toEqual(runningAlloc);
    expect(mockedGetJobAllocations).toHaveBeenCalledTimes(2);
  });

  it('throws TimeoutError when deadline expires', async () => {
    const pendingAlloc = createAllocation({ ClientStatus: 'pending' });

    // Always return pending
    mockedGetJobAllocations.mockImplementation(async () => {
      // Advance time by 2 seconds on each call to eventually pass the deadline
      vi.advanceTimersByTime(2000);
      return [pendingAlloc];
    });

    const http = createMockHttpClient();
    const promise = waitForRunning(http, 'test-job', 5000);

    // The function uses Date.now() internally and our mock advances time,
    // so after a few iterations it will exceed the deadline
    await expect(promise).rejects.toThrow(TimeoutError);
  });

  it('handles empty allocation list', async () => {
    let callCount = 0;
    mockedGetJobAllocations.mockImplementation(async () => {
      callCount++;
      if (callCount >= 3) {
        // Advance time past deadline to force timeout
        vi.advanceTimersByTime(120_001);
      }
      return [];
    });

    const http = createMockHttpClient();
    const promise = waitForRunning(http, 'test-job', 120_000);

    await expect(promise).rejects.toThrow(TimeoutError);
  });

  it('throws error when all allocations are failed', async () => {
    const failedAlloc = createAllocation({
      ClientStatus: 'failed',
      DesiredStatus: 'stop',
      TaskStates: {
        sandbox: {
          State: 'dead',
          Failed: true,
          Restarts: 0,
          Events: [
            {
              Type: 'Driver Failure',
              Time: Date.now(),
              FailsTask: true,
              DisplayMessage: 'Docker image not found',
            },
          ],
        },
      },
    });

    mockedGetJobAllocations.mockResolvedValueOnce([failedAlloc]);

    const http = createMockHttpClient();
    await expect(waitForRunning(http, 'test-job', 10_000)).rejects.toThrow(
      /All allocations for job "test-job" failed.*Docker image not found/
    );
  });

  it('uses default timeout when not specified', async () => {
    const pendingAlloc = createAllocation({ ClientStatus: 'pending' });

    mockedGetJobAllocations.mockImplementation(async () => {
      // Advance past the default 120_000ms timeout
      vi.advanceTimersByTime(121_000);
      return [pendingAlloc];
    });

    const http = createMockHttpClient();
    // No timeoutMs argument — should use NOMAD_DEFAULTS.readyTimeoutMs (120_000)
    const promise = waitForRunning(http, 'test-job');

    await expect(promise).rejects.toThrow(TimeoutError);
  });
});
