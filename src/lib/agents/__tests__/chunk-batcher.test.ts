import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkBatcher } from '../chunk-batcher.js';

type PersistFn = (
  sessionId: string,
  event: { id: string; type: string; timestamp: number; data: Record<string, unknown> }
) => Promise<unknown>;
type RealtimeFn = (sessionId: string, type: string, data: unknown) => Promise<number>;

describe('ChunkBatcher', () => {
  let persistEvent: ReturnType<typeof vi.fn<PersistFn>>;
  let publishRealtime: ReturnType<typeof vi.fn<RealtimeFn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    persistEvent = vi.fn<PersistFn>().mockResolvedValue(undefined);
    publishRealtime = vi.fn<RealtimeFn>().mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createBatcher(overrides?: {
    flushIntervalMs?: number;
    maxBatchSize?: number;
    persistEvent?: PersistFn;
  }): ChunkBatcher {
    return new ChunkBatcher({
      sessionId: 'session-1',
      agentId: 'agent-1',
      persistEvent: overrides?.persistEvent ?? persistEvent,
      publishRealtime,
      flushIntervalMs: overrides?.flushIntervalMs ?? 100,
      maxBatchSize: overrides?.maxBatchSize ?? 10,
    });
  }

  it('publishes individual deltas to realtime immediately', async () => {
    const batcher = createBatcher();

    await batcher.addDelta('Hello');
    await batcher.addDelta(' world');

    expect(publishRealtime).toHaveBeenCalledTimes(2);
    expect(publishRealtime).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'chunk',
      expect.objectContaining({
        agentId: 'agent-1',
        text: 'Hello',
        phase: 'planning',
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 0,
        }),
      })
    );
    expect(publishRealtime).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'chunk',
      expect.objectContaining({
        agentId: 'agent-1',
        text: ' world',
        phase: 'planning',
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
        }),
      })
    );

    await batcher.destroy();
  });

  it('batches flush after max batch size threshold', async () => {
    const batcher = createBatcher({ maxBatchSize: 3 });

    await batcher.addDelta('a');
    await batcher.addDelta('b');
    expect(persistEvent).not.toHaveBeenCalled();

    await batcher.addDelta('c'); // Triggers flush at threshold
    expect(persistEvent).toHaveBeenCalledTimes(1);

    const call = persistEvent.mock.calls[0]!;
    expect(call[0]).toBe('session-1');
    expect(call[1].type).toBe('chunk');
    expect(call[1].data.text).toBe('abc');
    expect(call[1].data.agentId).toBe('agent-1');
    expect(call[1].data.phase).toBe('planning');
    expect(call[1].data.meta).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        streamId: 'session-1',
        partType: 'chunk_end',
        durability: 'durable',
        sequence: null,
      })
    );

    await batcher.destroy();
  });

  it('flushes on timer when below threshold', async () => {
    const batcher = createBatcher({ flushIntervalMs: 100, maxBatchSize: 10 });

    await batcher.addDelta('hello');
    expect(persistEvent).not.toHaveBeenCalled();

    // Advance past the flush interval
    await vi.advanceTimersByTimeAsync(150);

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]![1].data.text).toBe('hello');

    await batcher.destroy();
  });

  it('manual flush() clears timer and persists', async () => {
    const batcher = createBatcher();

    await batcher.addDelta('data');
    expect(persistEvent).not.toHaveBeenCalled();

    await batcher.flush();
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]![1].data.text).toBe('data');

    // Timer should be cleared - advancing should not cause another persist
    await vi.advanceTimersByTimeAsync(200);
    expect(persistEvent).toHaveBeenCalledTimes(1);

    await batcher.destroy();
  });

  it('destroy() flushes remaining buffer', async () => {
    const batcher = createBatcher();

    await batcher.addDelta('remaining');
    expect(persistEvent).not.toHaveBeenCalled();

    await batcher.destroy();
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]![1].data.text).toBe('remaining');
  });

  it('setPhase() flushes current buffer before switching', async () => {
    const batcher = createBatcher();

    await batcher.addDelta('planning-data');
    expect(persistEvent).not.toHaveBeenCalled();

    batcher.setPhase('execution');

    // flushSync is fire-and-forget, but the promise was started
    // Wait for microtask queue to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]![1].data.text).toBe('planning-data');
    expect(persistEvent.mock.calls[0]![1].data.phase).toBe('planning');

    // New deltas should use the new phase
    await batcher.addDelta('exec-data');
    await batcher.flush();
    expect(persistEvent).toHaveBeenCalledTimes(2);
    expect(persistEvent.mock.calls[1]![1].data.phase).toBe('execution');

    await batcher.destroy();
  });

  it('flush() on empty buffer is a no-op', async () => {
    const batcher = createBatcher();

    await batcher.flush();
    expect(persistEvent).not.toHaveBeenCalled();

    await batcher.destroy();
    expect(persistEvent).not.toHaveBeenCalled();
  });

  it('publishRealtime failure does not block delta buffering', async () => {
    publishRealtime.mockRejectedValue(new Error('Caddy down'));
    const batcher = createBatcher();

    // Should not throw
    await batcher.addDelta('resilient');

    // Delta should still be buffered
    await batcher.flush();
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]![1].data.text).toBe('resilient');

    await batcher.destroy();
  });

  it('accumulates multiple batches correctly (25 deltas with batch size 10)', async () => {
    const batcher = createBatcher({ maxBatchSize: 10 });

    // Send 25 deltas
    for (let i = 0; i < 25; i++) {
      await batcher.addDelta(`d${i}`);
    }

    // Should have 2 full batches persisted (at 10 and 20)
    expect(persistEvent).toHaveBeenCalledTimes(2);

    // First batch: d0..d9
    const firstBatch = persistEvent.mock.calls[0]![1].data.text;
    expect(firstBatch).toBe('d0d1d2d3d4d5d6d7d8d9');

    // Second batch: d10..d19
    const secondBatch = persistEvent.mock.calls[1]![1].data.text;
    expect(secondBatch).toBe('d10d11d12d13d14d15d16d17d18d19');

    // Remaining 5 deltas still in buffer - flush via destroy
    await batcher.destroy();
    expect(persistEvent).toHaveBeenCalledTimes(3);
    const thirdBatch = persistEvent.mock.calls[2]![1].data.text;
    expect(thirdBatch).toBe('d20d21d22d23d24');

    // All 25 deltas should have been published to realtime individually
    expect(publishRealtime).toHaveBeenCalledTimes(25);
  });

  it('persisted events have valid id, type, and timestamp', async () => {
    const batcher = createBatcher({ maxBatchSize: 2 });

    await batcher.addDelta('x');
    await batcher.addDelta('y');

    expect(persistEvent).toHaveBeenCalledTimes(1);
    const event = persistEvent.mock.calls[0]![1];
    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe('chunk');
    expect(typeof event.timestamp).toBe('number');
    expect(event.timestamp).toBeGreaterThan(0);

    await batcher.destroy();
  });

  it('restores buffer on persist failure', async () => {
    let callCount = 0;
    const failingPersist = vi.fn<PersistFn>().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('DB locked'));
      }
      return Promise.resolve(undefined);
    });

    const batcher = createBatcher({ maxBatchSize: 10, persistEvent: failingPersist });

    // Add 10 deltas — the 10th triggers a threshold flush which will fail.
    // flush() restores the buffer then re-throws, so addDelta propagates the error.
    for (let i = 0; i < 10; i++) {
      if (i < 9) {
        await batcher.addDelta(`chunk${i}`);
      } else {
        await expect(batcher.addDelta(`chunk${i}`)).rejects.toThrow('DB locked');
      }
    }

    expect(failingPersist).toHaveBeenCalledTimes(1);

    // Buffer was restored after the failure — flush again (should succeed)
    await batcher.flush();

    expect(failingPersist).toHaveBeenCalledTimes(2);
    // Second call should contain all the original data
    const secondCallData = failingPersist.mock.calls[1]![1].data;
    expect(secondCallData.text).toBe(
      'chunk0chunk1chunk2chunk3chunk4chunk5chunk6chunk7chunk8chunk9'
    );

    await batcher.destroy();
  });

  it('silently ignores addDelta after destroy', async () => {
    const batcher = createBatcher();
    await batcher.destroy();
    await batcher.addDelta('late');

    // publishRealtime should NOT have been called for the late delta
    // (it may have been called 0 times if destroy was on empty buffer)
    expect(publishRealtime).not.toHaveBeenCalled();
    expect(persistEvent).not.toHaveBeenCalled();
  });
});
