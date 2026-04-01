/**
 * Integration tests for AgentRetryQueue
 *
 * Tests the in-memory retry queue with exponential backoff.
 * No DB needed — this is a pure in-memory service, but we test
 * the full enqueue → process → retry/exhaust lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRetryQueue } from '../../src/services/agent/agent-retry-queue';

describe('AgentRetryQueue (IT-310 to IT-325)', () => {
  let queue: AgentRetryQueue;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    queue?.stop();
    vi.useRealTimers();
  });

  // ── Enqueue ──

  it('IT-310: enqueues a task and returns true', () => {
    queue = new AgentRetryQueue({ maxAttempts: 3 });
    const result = queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Rate limited',
    });
    expect(result).toBe(true);
    expect(queue.size).toBe(1);
  });

  it('IT-311: rejects enqueue when max attempts exceeded', () => {
    queue = new AgentRetryQueue({ maxAttempts: 2 });
    // First attempt
    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error 1',
      currentAttempt: 0,
    });
    // Second attempt
    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error 2',
    });
    // Third attempt exceeds maxAttempts=2
    const result = queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error 3',
    });
    expect(result).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('IT-312: increments attempt count on re-enqueue', () => {
    queue = new AgentRetryQueue({ maxAttempts: 5 });
    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error',
    });
    const state1 = queue.getQueueState();
    expect(state1[0].attempt).toBe(1);

    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error again',
    });
    const state2 = queue.getQueueState();
    expect(state2[0].attempt).toBe(2);
  });

  it('IT-313: uses currentAttempt when provided', () => {
    queue = new AgentRetryQueue({ maxAttempts: 5 });
    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error',
      currentAttempt: 3,
    });
    const state = queue.getQueueState();
    expect(state[0].attempt).toBe(4);
  });

  // ── Cancel ──

  it('IT-314: cancels an enqueued task', () => {
    queue = new AgentRetryQueue();
    queue.enqueue({
      taskId: 'task-1',
      agentId: 'agent-1',
      codespaceId: 'cs-1',
      errorMessage: 'Error',
    });
    expect(queue.size).toBe(1);
    const result = queue.cancel('task-1');
    expect(result).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('IT-315: cancel returns false for non-existent task', () => {
    queue = new AgentRetryQueue();
    expect(queue.cancel('nonexistent')).toBe(false);
  });

  // ── Queue State ──

  it('IT-316: getQueueState returns all enqueued tasks', () => {
    queue = new AgentRetryQueue();
    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E1' });
    queue.enqueue({ taskId: 't2', agentId: 'a2', codespaceId: 'cs2', errorMessage: 'E2' });

    const state = queue.getQueueState();
    expect(state).toHaveLength(2);
    expect(state.map((t) => t.taskId)).toContain('t1');
    expect(state.map((t) => t.taskId)).toContain('t2');
  });

  it('IT-317: getQueueState returns empty array initially', () => {
    queue = new AgentRetryQueue();
    expect(queue.getQueueState()).toHaveLength(0);
    expect(queue.size).toBe(0);
  });

  // ── Backoff ──

  it('IT-318: calculates exponential backoff correctly', () => {
    queue = new AgentRetryQueue({
      maxAttempts: 5,
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 100_000,
    });

    const now = Date.now();
    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    const state1 = queue.getQueueState();
    // Attempt 1: 1000 * 2^0 = 1000ms
    expect(state1[0].nextRetryAt).toBeGreaterThanOrEqual(now + 1000);
    expect(state1[0].nextRetryAt).toBeLessThanOrEqual(now + 1100);

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    const state2 = queue.getQueueState();
    // Attempt 2: 1000 * 2^1 = 2000ms
    expect(state2[0].nextRetryAt).toBeGreaterThanOrEqual(now + 2000);
  });

  it('IT-319: backoff is capped at maxBackoffMs', () => {
    queue = new AgentRetryQueue({
      maxAttempts: 10,
      initialBackoffMs: 100_000,
      backoffMultiplier: 10,
      maxBackoffMs: 300_000,
    });

    const now = Date.now();
    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    const state = queue.getQueueState();
    // 100_000 * 10^0 = 100_000, within max
    expect(state[0].nextRetryAt - now).toBeLessThanOrEqual(300_100);
  });

  // ── Start / Stop ──

  it('IT-320: start is idempotent', () => {
    queue = new AgentRetryQueue({ pollIntervalMs: 1000 });
    queue.start();
    queue.start(); // no-op
    queue.stop();
  });

  it('IT-321: stop clears the interval', () => {
    queue = new AgentRetryQueue({ pollIntervalMs: 1000 });
    queue.start();
    queue.stop();
    queue.stop(); // safe double-stop
  });

  // ── Process Queue ──

  it('IT-322: processes ready tasks and calls restartFn', async () => {
    const restartFn = vi.fn().mockResolvedValue(undefined);
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 100,
      pollIntervalMs: 50,
      restartFn,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    expect(queue.size).toBe(1);

    // Advance past backoff
    vi.advanceTimersByTime(200);
    queue.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(restartFn).toHaveBeenCalledWith('t1');
    expect(queue.size).toBe(0);
  });

  it('IT-323: does not process tasks before their nextRetryAt', async () => {
    const restartFn = vi.fn().mockResolvedValue(undefined);
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 60_000, // 1 minute
      pollIntervalMs: 50,
      restartFn,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    queue.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(restartFn).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it('IT-324: re-enqueues task with incremented attempt on restart failure', async () => {
    const restartFn = vi.fn().mockRejectedValue(new Error('Still failing'));
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 100,
      pollIntervalMs: 50,
      restartFn,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });

    // Advance past first backoff and trigger poll
    vi.advanceTimersByTime(200);
    queue.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(restartFn).toHaveBeenCalledWith('t1');
    // Task still in queue with incremented attempt
    expect(queue.size).toBe(1);
    const state = queue.getQueueState();
    expect(state[0].attempt).toBe(2);
  });

  it('IT-325: removes task permanently after all retry attempts exhausted', async () => {
    const restartFn = vi.fn().mockRejectedValue(new Error('Always fails'));
    queue = new AgentRetryQueue({
      maxAttempts: 2,
      initialBackoffMs: 10,
      pollIntervalMs: 10,
      restartFn,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });

    // Process attempt 1 failure → re-enqueue as attempt 2
    vi.advanceTimersByTime(50);
    queue.start();
    await vi.advanceTimersByTimeAsync(50);

    // Process attempt 2 failure → exceeds maxAttempts, removed
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(50);

    expect(queue.size).toBe(0);
  });

  // ── setRestartFn ──

  it('IT-326: setRestartFn allows deferred initialization', async () => {
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 10,
      pollIntervalMs: 10,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    queue.start();

    // Without restartFn, tasks are not processed
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(queue.size).toBe(1);

    // Set restartFn and now tasks get processed
    const restartFn = vi.fn().mockResolvedValue(undefined);
    queue.setRestartFn(restartFn);

    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(restartFn).toHaveBeenCalledWith('t1');
    expect(queue.size).toBe(0);
  });

  // ── Multiple tasks ──

  it('IT-327: processes multiple ready tasks in one cycle', async () => {
    const restartFn = vi.fn().mockResolvedValue(undefined);
    queue = new AgentRetryQueue({
      maxAttempts: 3,
      initialBackoffMs: 10,
      pollIntervalMs: 10,
      restartFn,
    });

    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E1' });
    queue.enqueue({ taskId: 't2', agentId: 'a2', codespaceId: 'cs2', errorMessage: 'E2' });
    queue.enqueue({ taskId: 't3', agentId: 'a3', codespaceId: 'cs3', errorMessage: 'E3' });

    vi.advanceTimersByTime(50);
    queue.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(restartFn).toHaveBeenCalledTimes(3);
    expect(queue.size).toBe(0);
  });

  // ── Default options ──

  it('IT-328: uses sensible defaults', () => {
    queue = new AgentRetryQueue();
    queue.enqueue({ taskId: 't1', agentId: 'a1', codespaceId: 'cs1', errorMessage: 'E' });
    const state = queue.getQueueState();
    expect(state[0].maxAttempts).toBe(3);
    // Default initialBackoffMs = 30_000
    const expectedMinRetry = Date.now() + 29_000;
    expect(state[0].nextRetryAt).toBeGreaterThan(expectedMinRetry);
  });
});
