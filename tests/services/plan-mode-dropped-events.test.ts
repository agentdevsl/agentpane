/**
 * F05-02: Plan-mode dropped-event metrics.
 *
 * Verifies that when a stream publish throws, the PlanModeService:
 *   1. Increments the droppedEventCount
 *   2. Breaks the count down by event type and error reason
 *   3. Exposes the structured counters via getMetrics() for the admin endpoint
 *
 * The test exercises the `recordDroppedEvent` path directly because the real
 * PlanModeService requires a Claude client which needs an API key; the metric
 * plumbing is the unit under test.
 */

import { describe, expect, it } from 'vitest';
import { createPlanModeService } from '../../src/services/plan-mode.service.js';

describe('PlanModeService dropped-event metrics (F05-02)', () => {
  function makeService() {
    // Minimal mock streams that throw on every publish.
    const throwingStreams = {
      createStream: async () => {
        throw Object.assign(new Error('Caddy unavailable'), { code: 'CADDY_DOWN' });
      },
      publishPlanStarted: async () => {
        throw Object.assign(new Error('Publish failed'), { code: 'PUBLISH_FAILED' });
      },
    };
    const fakeDb = {
      query: { codespaces: { findFirst: async () => null } },
    };
    return createPlanModeService(fakeDb as never, throwingStreams as never, null, null);
  }

  it('starts with zero counters', () => {
    const svc = makeService();
    expect(svc.getMetrics()).toEqual({
      droppedEventCount: 0,
      droppedByEventType: {},
      droppedByReason: {},
    });
  });

  it('records drops via the private recordDroppedEvent path', () => {
    const svc = makeService();
    // Cast to any to poke at the private method under test.
    const svcAny = svc as any;
    svcAny.recordDroppedEvent(
      'plan:started',
      'plan:abc',
      Object.assign(new Error('x'), { code: 'CADDY_DOWN' })
    );
    svcAny.recordDroppedEvent(
      'plan:token',
      'plan:abc',
      Object.assign(new Error('y'), { code: 'CADDY_DOWN' })
    );
    svcAny.recordDroppedEvent(
      'plan:token',
      'plan:abc',
      Object.assign(new Error('z'), { code: 'UNKNOWN' })
    );

    const metrics = svc.getMetrics();
    expect(metrics.droppedEventCount).toBe(3);
    expect(metrics.droppedByEventType).toEqual({
      'plan:started': 1,
      'plan:token': 2,
    });
    expect(metrics.droppedByReason.CADDY_DOWN).toBe(2);
    expect(metrics.droppedByReason.UNKNOWN).toBe(1);
  });

  it('extracts a code from non-standard error shapes', () => {
    const svc = makeService();
    const svcAny = svc as any;
    svcAny.recordDroppedEvent('plan:error', 'plan:x', 'just a string');
    const metrics = svc.getMetrics();
    expect(metrics.droppedByReason.UNKNOWN).toBe(1);
  });
});
