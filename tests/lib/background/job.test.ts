/**
 * Tests for the BackgroundJob / BackgroundJobRegistry contract (F12-04).
 *
 * The registry's primary robustness guarantee is that a failing `stop()`
 * on one job must not prevent siblings from stopping. These tests verify
 * that contract plus the idempotency and snapshot shape.
 */

import { describe, expect, it, vi } from 'vitest';
import { type BackgroundJob, BackgroundJobRegistry } from '../../../src/lib/background/job.js';

function makeJob(
  name: string,
  overrides: Partial<BackgroundJob> = {}
): BackgroundJob & { startCalls: number; stopCalls: number } {
  const state = { startCalls: 0, stopCalls: 0 };
  return {
    name,
    start: overrides.start ?? (() => void state.startCalls++),
    stop: overrides.stop ?? (() => void state.stopCalls++),
    healthSnapshot: overrides.healthSnapshot,
    get startCalls() {
      return state.startCalls;
    },
    get stopCalls() {
      return state.stopCalls;
    },
  } as BackgroundJob & { startCalls: number; stopCalls: number };
}

describe('BackgroundJobRegistry', () => {
  it('startAll invokes start() on every registered job', async () => {
    const registry = new BackgroundJobRegistry();
    const a = makeJob('a');
    const b = makeJob('b');
    registry.register(a);
    registry.register(b);

    await registry.startAll();

    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(1);
  });

  it('stopAll invokes stop() on every registered job in LIFO order', async () => {
    const registry = new BackgroundJobRegistry();
    const order: string[] = [];
    registry.register(makeJob('first', { stop: () => void order.push('first') }));
    registry.register(makeJob('second', { stop: () => void order.push('second') }));
    registry.register(makeJob('third', { stop: () => void order.push('third') }));

    await registry.startAll();
    await registry.stopAll();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('stopAll continues stopping even when one job throws', async () => {
    const registry = new BackgroundJobRegistry();
    const stoppedNames: string[] = [];
    const throwingStop = vi.fn(() => {
      throw new Error('stop failed');
    });

    registry.register(
      makeJob('good-1', {
        stop: () => void stoppedNames.push('good-1'),
      })
    );
    registry.register(
      makeJob('bad', {
        stop: throwingStop,
      })
    );
    registry.register(
      makeJob('good-2', {
        stop: () => void stoppedNames.push('good-2'),
      })
    );

    await registry.startAll();
    await registry.stopAll();

    expect(throwingStop).toHaveBeenCalledOnce();
    // LIFO: good-2 stopped before bad (which throws), but good-1 must still
    // be stopped AFTER the throw — that's the core robustness guarantee.
    expect(stoppedNames).toEqual(['good-2', 'good-1']);
  });

  it('stopAll is idempotent (second call is a no-op)', async () => {
    const registry = new BackgroundJobRegistry();
    const a = makeJob('a');
    registry.register(a);

    await registry.startAll();
    await registry.stopAll();
    await registry.stopAll();

    expect(a.stopCalls).toBe(1);
  });

  it('startAll is idempotent (second call is a no-op)', async () => {
    const registry = new BackgroundJobRegistry();
    const a = makeJob('a');
    registry.register(a);

    await registry.startAll();
    await registry.startAll();

    expect(a.startCalls).toBe(1);
  });

  it('registering two jobs with the same name throws', () => {
    const registry = new BackgroundJobRegistry();
    registry.register(makeJob('dup'));
    expect(() => registry.register(makeJob('dup'))).toThrow(/duplicate/);
  });

  it('snapshot returns the expected fields for each job', async () => {
    const registry = new BackgroundJobRegistry();
    registry.register(
      makeJob('a', {
        healthSnapshot: () => ({
          name: 'a',
          running: true,
          lastRunAt: '2026-04-20T00:00:00.000Z',
        }),
      })
    );
    registry.register(makeJob('b')); // no healthSnapshot()

    await registry.startAll();
    const snap = registry.snapshot();

    expect(snap).toHaveLength(2);
    expect(snap[0]).toEqual({
      name: 'a',
      running: true,
      lastRunAt: '2026-04-20T00:00:00.000Z',
    });
    // Fallback: jobs without healthSnapshot default to the registry's
    // started/stopped flags.
    expect(snap[1]).toEqual({ name: 'b', running: true });
  });

  it('snapshot reports false when registry has been stopped', async () => {
    const registry = new BackgroundJobRegistry();
    registry.register(makeJob('a'));

    await registry.startAll();
    await registry.stopAll();

    const snap = registry.snapshot();
    expect(snap[0]?.running).toBe(false);
  });

  it('snapshot captures thrown error from a misbehaving healthSnapshot', async () => {
    const registry = new BackgroundJobRegistry();
    registry.register(
      makeJob('bad-snap', {
        healthSnapshot: () => {
          throw new Error('snapshot-error');
        },
      })
    );

    await registry.startAll();
    const snap = registry.snapshot();

    expect(snap[0]?.name).toBe('bad-snap');
    expect(snap[0]?.lastError).toBe('snapshot-error');
  });

  it('startAll continues starting even when one job throws', async () => {
    const registry = new BackgroundJobRegistry();
    const thirdStart = vi.fn();
    registry.register(makeJob('first'));
    registry.register(
      makeJob('second', {
        start: () => {
          throw new Error('cannot start');
        },
      })
    );
    registry.register(makeJob('third', { start: thirdStart }));

    await registry.startAll();

    expect(thirdStart).toHaveBeenCalledOnce();
  });

  it('handles async start()/stop() returning a Promise', async () => {
    const registry = new BackgroundJobRegistry();
    let startedAt = 0;
    let stoppedAt = 0;
    let clock = 0;
    const job: BackgroundJob = {
      name: 'async-job',
      start: async () => {
        await new Promise((r) => setTimeout(r, 5));
        startedAt = ++clock;
      },
      stop: async () => {
        await new Promise((r) => setTimeout(r, 5));
        stoppedAt = ++clock;
      },
    };
    registry.register(job);

    await registry.startAll();
    expect(startedAt).toBe(1);

    await registry.stopAll();
    expect(stoppedAt).toBe(2);
  });

  it('size() returns the registered count', () => {
    const registry = new BackgroundJobRegistry();
    expect(registry.size()).toBe(0);
    registry.register(makeJob('a'));
    expect(registry.size()).toBe(1);
    registry.register(makeJob('b'));
    expect(registry.size()).toBe(2);
  });
});
