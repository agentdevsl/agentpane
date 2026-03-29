import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRetryQueue } from '../agent-retry-queue.js';

// Mock the logger
vi.mock('../../../lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const makeParams = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  agentId: 'agent-1',
  codespaceId: 'cs-1',
  errorMessage: 'transient error',
  ...overrides,
});

describe('AgentRetryQueue', () => {
  let queue: AgentRetryQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 30_000,
      backoffMultiplier: 2,
      maxBackoffMs: 300_000,
      pollIntervalMs: 10_000,
    });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
  });

  // 1. enqueue adds task with correct backoff and returns true
  describe('enqueue', () => {
    it('adds task with correct backoff and returns true', () => {
      const result = queue.enqueue(makeParams());

      expect(result).toBe(true);
      expect(queue.size).toBe(1);

      const state = queue.getQueueState();
      expect(state).toHaveLength(1);
      expect(state[0]!.taskId).toBe('task-1');
      expect(state[0]!.agentId).toBe('agent-1');
      expect(state[0]!.codespaceId).toBe('cs-1');
      expect(state[0]!.attempt).toBe(1);
      expect(state[0]!.maxAttempts).toBe(3);
      // First attempt: initialBackoffMs * 2^0 = 30000
      expect(state[0]!.nextRetryAt).toBe(Date.now() + 30_000);
    });

    // 2. enqueue exceeds maxAttempts returns false and deletes from queue
    it('returns false and deletes from queue when exceeding maxAttempts', () => {
      const result = queue.enqueue(makeParams({ currentAttempt: 3 }));

      expect(result).toBe(false);
      expect(queue.size).toBe(0);
    });

    // 3. enqueue existing task increments attempt from existing entry
    it('increments attempt from existing entry when task already queued', () => {
      queue.enqueue(makeParams());
      expect(queue.getQueueState()[0]!.attempt).toBe(1);

      const result = queue.enqueue(makeParams());
      expect(result).toBe(true);
      expect(queue.size).toBe(1);
      expect(queue.getQueueState()[0]!.attempt).toBe(2);
    });
  });

  // 4. cancel removes task from queue
  describe('cancel', () => {
    it('removes task from queue and returns true', () => {
      queue.enqueue(makeParams());
      expect(queue.size).toBe(1);

      const result = queue.cancel('task-1');
      expect(result).toBe(true);
      expect(queue.size).toBe(0);
    });

    it('returns false when task is not in queue', () => {
      const result = queue.cancel('nonexistent');
      expect(result).toBe(false);
    });
  });

  // 5. processQueue with restartFn calls restartFn for ready tasks and removes on success
  describe('processQueue', () => {
    it('calls restartFn for ready tasks and removes on success', async () => {
      const restartFn = vi.fn().mockResolvedValue(undefined);
      queue.setRestartFn(restartFn);
      queue.enqueue(makeParams());

      // Advance past the backoff delay so the task is ready
      vi.advanceTimersByTime(30_000);

      queue.start();
      // Advance past poll interval to trigger processQueue
      await vi.advanceTimersByTimeAsync(10_000);

      expect(restartFn).toHaveBeenCalledWith('task-1');
      expect(queue.size).toBe(0);
    });

    // 6. retry failure re-enqueues with incremented attempt and new backoff
    it('re-enqueues with incremented attempt and new backoff on retry failure', async () => {
      const restartFn = vi.fn().mockRejectedValue(new Error('still failing'));
      queue.setRestartFn(restartFn);
      queue.enqueue(makeParams());

      const originalTask = queue.getQueueState()[0]!;

      // Advance past backoff so task is ready
      vi.advanceTimersByTime(30_000);

      queue.start();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(restartFn).toHaveBeenCalledWith('task-1');
      expect(queue.size).toBe(1);

      const updatedTask = queue.getQueueState()[0]!;
      // Should be a new object (not in-place mutation)
      expect(updatedTask).not.toBe(originalTask);
      expect(updatedTask.attempt).toBe(2);
      // Second attempt backoff: 30000 * 2^1 = 60000
      expect(updatedTask.nextRetryAt).toBeGreaterThan(originalTask.nextRetryAt);
    });

    // 7. permanent failure removes task after exceeding maxAttempts
    it('removes task after exceeding maxAttempts on permanent failure', async () => {
      const restartFn = vi.fn().mockRejectedValue(new Error('permanent fail'));
      queue = new AgentRetryQueue({
        maxAttempts: 2,
        initialBackoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 300_000,
        pollIntervalMs: 500,
        restartFn,
      });

      // Enqueue at attempt 1
      queue.enqueue(makeParams());
      expect(queue.getQueueState()[0]!.attempt).toBe(1);

      // First retry: advance past backoff, trigger processQueue
      vi.advanceTimersByTime(1_000);
      queue.start();
      await vi.advanceTimersByTimeAsync(500);

      // After failure, attempt becomes 2 (which equals maxAttempts)
      expect(queue.size).toBe(1);
      expect(queue.getQueueState()[0]!.attempt).toBe(2);

      // Second retry: advance past new backoff (1000 * 2^1 = 2000)
      await vi.advanceTimersByTimeAsync(2_000);
      // processQueue fires again on next poll
      await vi.advanceTimersByTimeAsync(500);

      // Now attempt would be 3 > maxAttempts=2, so task is removed
      expect(queue.size).toBe(0);
    });

    // 8. processQueue without restartFn logs warning but doesn't crash
    it('logs warning but does not crash when restartFn is not set', async () => {
      queue.enqueue(makeParams());

      // Advance past backoff
      vi.advanceTimersByTime(30_000);

      queue.start();
      // Should not throw
      await vi.advanceTimersByTimeAsync(10_000);

      // Task should still be in the queue (not processed)
      expect(queue.size).toBe(1);
    });

    // 9. processQueue skips future tasks
    it('skips tasks with nextRetryAt in the future', async () => {
      const restartFn = vi.fn().mockResolvedValue(undefined);
      queue.setRestartFn(restartFn);
      queue.enqueue(makeParams());

      // Don't advance past the backoff — task is still in the future
      queue.start();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(restartFn).not.toHaveBeenCalled();
      expect(queue.size).toBe(1);
    });
  });

  // 10. start/stop lifecycle
  describe('start/stop lifecycle', () => {
    it('creates interval on start and clears on stop', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      queue.start();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);

      queue.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('does not create duplicate intervals on multiple start calls', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      queue.start();
      queue.start();
      queue.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('stop is idempotent when not started', () => {
      // Should not throw
      queue.stop();
      queue.stop();
    });
  });

  // 11. getQueueState returns snapshot
  describe('getQueueState', () => {
    it('returns snapshot of current queue', () => {
      queue.enqueue(makeParams({ taskId: 'task-a' }));
      queue.enqueue(makeParams({ taskId: 'task-b' }));

      const state = queue.getQueueState();
      expect(state).toHaveLength(2);

      const taskIds = state.map((t) => t.taskId);
      expect(taskIds).toContain('task-a');
      expect(taskIds).toContain('task-b');
    });

    it('returns empty array when queue is empty', () => {
      expect(queue.getQueueState()).toEqual([]);
    });
  });

  // 12. backoff calculation: exponential backoff (30s, 60s, 120s with multiplier 2)
  describe('backoff calculation', () => {
    it('uses exponential backoff: 30s, 60s, 120s for attempts 1, 2, 3', () => {
      const now = Date.now();

      // Attempt 1: 30000 * 2^0 = 30000
      queue.enqueue(makeParams({ taskId: 'task-exp' }));
      expect(queue.getQueueState()[0]!.nextRetryAt).toBe(now + 30_000);

      // Attempt 2: 30000 * 2^1 = 60000
      queue.enqueue(makeParams({ taskId: 'task-exp' }));
      expect(queue.getQueueState()[0]!.nextRetryAt).toBe(now + 60_000);

      // Attempt 3: 30000 * 2^2 = 120000
      queue.enqueue(makeParams({ taskId: 'task-exp' }));
      expect(queue.getQueueState()[0]!.nextRetryAt).toBe(now + 120_000);
    });

    it('caps backoff at maxBackoffMs', () => {
      const smallMaxQueue = new AgentRetryQueue({
        maxAttempts: 10,
        initialBackoffMs: 100_000,
        backoffMultiplier: 10,
        maxBackoffMs: 300_000,
        pollIntervalMs: 10_000,
      });

      const now = Date.now();

      // Attempt 1: 100000 * 10^0 = 100000
      smallMaxQueue.enqueue(makeParams());
      expect(smallMaxQueue.getQueueState()[0]!.nextRetryAt).toBe(now + 100_000);

      // Attempt 2: 100000 * 10^1 = 1000000, capped at 300000
      smallMaxQueue.enqueue(makeParams());
      expect(smallMaxQueue.getQueueState()[0]!.nextRetryAt).toBe(now + 300_000);
    });
  });
});
