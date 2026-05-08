import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetricsRoutes } from '../../src/server/routes/metrics';

/**
 * Integration tests for the JSON metrics endpoint (F10-01).
 *
 * Covers all four optional-service combinations: with/without
 * streamsService, with/without planModeService.
 */

vi.mock('../../src/lib/events/event-router.js', () => ({
  getEventRouterSnapshot: () => ({ activeStreams: 3, totalDelivered: 100 }),
}));

describe('Metrics Routes (IT-1800)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('IT-1800-1: GET / returns base snapshot with sse.eventRouter folded in', async () => {
    const metricsService = {
      snapshot: vi.fn().mockReturnValue({
        counters: { x: 1 },
        sse: { connections: 5 },
      }),
    };
    const app = createMetricsRoutes({ metricsService: metricsService as never });
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.counters.x).toBe(1);
    expect(body.data.sse.connections).toBe(5);
    expect(body.data.sse.eventRouter).toEqual({ activeStreams: 3, totalDelivered: 100 });
    expect(body.data.streams).toBeNull();
    expect(body.data.planMode).toBeNull();
  });

  it('IT-1800-2: GET / folds in streamsService metrics when wired', async () => {
    const metricsService = { snapshot: vi.fn().mockReturnValue({ sse: {} }) };
    const streamsService = {
      getPublishLagMetrics: vi.fn().mockReturnValue({ p95Ms: 12 }),
    };
    const app = createMetricsRoutes({
      metricsService: metricsService as never,
      streamsService: streamsService as never,
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.streams.p95Ms).toBe(12);
  });

  it('IT-1800-3: GET / folds in planModeService metrics when wired', async () => {
    const metricsService = { snapshot: vi.fn().mockReturnValue({ sse: {} }) };
    const planModeService = {
      getMetrics: vi.fn().mockReturnValue({ droppedEventCount: 4 }),
    };
    const app = createMetricsRoutes({
      metricsService: metricsService as never,
      planModeService: planModeService as never,
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.planMode.droppedEventCount).toBe(4);
  });

  it('IT-1800-4: GET / handles null optional services', async () => {
    const metricsService = { snapshot: vi.fn().mockReturnValue({ sse: {} }) };
    const app = createMetricsRoutes({
      metricsService: metricsService as never,
      streamsService: null,
      planModeService: null,
    });
    const body = await (await app.request('http://localhost/')).json();
    expect(body.data.streams).toBeNull();
    expect(body.data.planMode).toBeNull();
  });
});
