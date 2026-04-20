/**
 * F05-03: EventRouter unified SSE accounting.
 *
 * Verifies:
 *   1. Global cap enforced across all routes.
 *   2. Per-user cap enforced within the global cap.
 *   3. Release returns the slot to the pool.
 *   4. 429 vs 503 differentiation via the reason code.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetEventRouterForTests,
  acquireSseSlot,
  getEventRouterSnapshot,
  releaseSseSlot,
  setEventRouterOverrides,
} from '../../../src/lib/events/event-router.js';

describe('EventRouter (F05-03)', () => {
  afterEach(() => {
    __resetEventRouterForTests();
  });

  it('rejects per-user acquisitions past the quota with USER_QUOTA_EXCEEDED', () => {
    setEventRouterOverrides({ perUserCap: 2, globalCap: 100 });
    const user = 'user-1';
    expect(acquireSseSlot('/api/events', user).ok).toBe(true);
    expect(acquireSseSlot('/api/events', user).ok).toBe(true);
    const third = acquireSseSlot('/api/events', user);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe('USER_QUOTA_EXCEEDED');
      expect(third.perUserCap).toBe(2);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('rejects global acquisitions past the cap with GLOBAL_CAP_EXCEEDED', () => {
    setEventRouterOverrides({ perUserCap: 100, globalCap: 3 });
    expect(acquireSseSlot('/api/events', 'a').ok).toBe(true);
    expect(acquireSseSlot('/api/events', 'b').ok).toBe(true);
    expect(acquireSseSlot('/api/cli-monitor/stream', 'c').ok).toBe(true);
    const fourth = acquireSseSlot('/api/events', 'd');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.code).toBe('GLOBAL_CAP_EXCEEDED');
      expect(fourth.globalCap).toBe(3);
    }
  });

  it('counts per-route and per-user correctly', () => {
    setEventRouterOverrides({ perUserCap: 10, globalCap: 10 });
    acquireSseSlot('/api/events', 'user-1');
    acquireSseSlot('/api/events', 'user-1');
    acquireSseSlot('/api/cli-monitor/stream', 'user-2');
    const snap = getEventRouterSnapshot();
    expect(snap.total).toBe(3);
    expect(snap.byRoute['/api/events']).toBe(2);
    expect(snap.byRoute['/api/cli-monitor/stream']).toBe(1);
    expect(snap.byUser['user-1']).toBe(2);
    expect(snap.byUser['user-2']).toBe(1);
  });

  it('release returns the slot to the pool', () => {
    setEventRouterOverrides({ perUserCap: 1, globalCap: 10 });
    expect(acquireSseSlot('/api/events', 'solo').ok).toBe(true);
    expect(acquireSseSlot('/api/events', 'solo').ok).toBe(false);
    releaseSseSlot('/api/events', 'solo');
    expect(acquireSseSlot('/api/events', 'solo').ok).toBe(true);
  });

  it('keys anonymous connections under __anon', () => {
    setEventRouterOverrides({ perUserCap: 2, globalCap: 10 });
    expect(acquireSseSlot('/api/events').ok).toBe(true);
    expect(acquireSseSlot('/api/events').ok).toBe(true);
    expect(acquireSseSlot('/api/events').ok).toBe(false);
  });

  it('does not decrement total when releasing a user with no active slot', () => {
    setEventRouterOverrides({ perUserCap: 10, globalCap: 10 });
    // Acquire for user-1 so total=1.
    expect(acquireSseSlot('/api/events', 'user-1').ok).toBe(true);
    expect(getEventRouterSnapshot().total).toBe(1);

    // Release for a DIFFERENT user — should be a no-op, not decrement total.
    releaseSseSlot('/api/events', 'user-ghost');
    expect(getEventRouterSnapshot().total).toBe(1);

    // Release twice for user-1: first succeeds, second is a no-op.
    releaseSseSlot('/api/events', 'user-1');
    expect(getEventRouterSnapshot().total).toBe(0);
    releaseSseSlot('/api/events', 'user-1');
    expect(getEventRouterSnapshot().total).toBe(0);
  });

  it('does not decrement total when releasing an unknown route', () => {
    setEventRouterOverrides({ perUserCap: 10, globalCap: 10 });
    expect(acquireSseSlot('/api/events', 'user-1').ok).toBe(true);
    expect(getEventRouterSnapshot().total).toBe(1);

    // User exists but on a different route — must not decrement total.
    releaseSseSlot('/api/cli-monitor/stream', 'user-1');
    expect(getEventRouterSnapshot().total).toBe(1);

    // Correct route + user releases the slot normally.
    releaseSseSlot('/api/events', 'user-1');
    expect(getEventRouterSnapshot().total).toBe(0);
  });

  it('releasing without a prior acquire does not produce negative counts or leak capacity', () => {
    setEventRouterOverrides({ perUserCap: 1, globalCap: 1 });
    // Release with no prior acquire — should be harmless.
    releaseSseSlot('/api/events', 'nobody');
    expect(getEventRouterSnapshot().total).toBe(0);

    // Cap is still honoured: one slot available, second rejected.
    expect(acquireSseSlot('/api/events', 'user-1').ok).toBe(true);
    const second = acquireSseSlot('/api/events', 'user-2');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('GLOBAL_CAP_EXCEEDED');
    }
  });
});
