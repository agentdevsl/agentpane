/**
 * Integration coverage for src/lib/events/event-bus.ts.
 *
 * Run: npx vitest run --project integration tests/integration/event-bus-listener-paths.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addStreamListener,
  decrementSSEConnections,
  getActiveSSEConnections,
  incrementSSEConnections,
  publishEventToStream,
  releaseEventBusSlot,
  removeStreamListener,
  tryAcquireEventBusSlot,
} from '../../src/lib/events/event-bus';

describe('lib/events/event-bus', () => {
  let captured: Array<{ type: string; data: unknown }>;
  let listener: (event: { type: string; data: unknown }) => void;

  beforeEach(() => {
    captured = [];
    listener = (event) => captured.push(event);
  });

  afterEach(() => {
    removeStreamListener(listener);
    // Also drop any throwing listener accidentally still registered
    vi.restoreAllMocks();
  });

  it('addStreamListener + publishEventToStream delivers events; remove unsubscribes', () => {
    addStreamListener(listener);
    publishEventToStream({ type: 'a', data: 1 });
    publishEventToStream({ type: 'b', data: 2 });
    expect(captured).toEqual([
      { type: 'a', data: 1 },
      { type: 'b', data: 2 },
    ]);

    removeStreamListener(listener);
    publishEventToStream({ type: 'c', data: 3 });
    expect(captured).toHaveLength(2); // c was not delivered
  });

  it('throwing listeners are removed automatically (publish self-heals)', () => {
    const throwing = vi.fn().mockImplementation(() => {
      throw new Error('listener bug');
    });
    addStreamListener(throwing);
    addStreamListener(listener);

    // Publish — throwing listener gets evicted; healthy listener still runs.
    publishEventToStream({ type: 'first', data: null });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([{ type: 'first', data: null }]);

    // Publish again — throwing was removed, only healthy listener is called.
    publishEventToStream({ type: 'second', data: 'x' });
    expect(throwing).toHaveBeenCalledTimes(1); // not called again
    expect(captured).toHaveLength(2);
  });

  it('SSE slot acquire/release counters work via legacy helpers', () => {
    const baseline = getActiveSSEConnections();

    // Legacy increment/decrement
    incrementSSEConnections();
    incrementSSEConnections();
    const afterTwo = getActiveSSEConnections();
    expect(afterTwo).toBeGreaterThanOrEqual(baseline + 1);

    decrementSSEConnections();
    decrementSSEConnections();
    expect(getActiveSSEConnections()).toBeLessThanOrEqual(afterTwo);
  });

  it('tryAcquireEventBusSlot + releaseEventBusSlot accepts a user id', () => {
    const result = tryAcquireEventBusSlot('user-1');
    // Result is a discriminated union; on success it's { ok: true, ... }
    expect(['ok', 'global_full', 'user_full']).toContain(
      typeof result === 'object' && result !== null && 'reason' in result
        ? (result as { reason: string }).reason
        : 'ok'
    );
    releaseEventBusSlot('user-1');
  });

  it('getActiveSSEConnections returns a non-negative integer', () => {
    expect(getActiveSSEConnections()).toBeGreaterThanOrEqual(0);
  });
});
