import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminMetricsRoutes } from '../../src/server/routes/admin-metrics';

/**
 * Integration tests for the admin metrics routes.
 *
 * Covers both the wired-service path (returns service metrics) and the
 * not-configured fallback path (returns zeroed defaults) for both
 * /plan-mode (F05-02) and /streams (F05-13).
 */

describe('Admin Metrics Routes (IT-1790)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('IT-1790-1: GET /plan-mode returns zeroed defaults when no service', async () => {
    const app = createAdminMetricsRoutes({});
    const res = await app.request('http://localhost/plan-mode');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      droppedEventCount: 0,
      droppedByEventType: {},
      droppedByReason: {},
    });
  });

  it('IT-1790-2: GET /plan-mode returns service metrics when wired', async () => {
    const planModeService = {
      getMetrics: vi.fn().mockReturnValue({
        droppedEventCount: 7,
        droppedByEventType: { 'agent:turn': 7 },
        droppedByReason: { 'queue-full': 7 },
      }),
    };
    const app = createAdminMetricsRoutes({ planModeService: planModeService as never });
    const res = await app.request('http://localhost/plan-mode');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.droppedEventCount).toBe(7);
    expect(planModeService.getMetrics).toHaveBeenCalled();
  });

  it('IT-1790-3: GET /plan-mode returns zeroed defaults when service is null', async () => {
    const app = createAdminMetricsRoutes({ planModeService: null });
    const res = await app.request('http://localhost/plan-mode');
    const body = await res.json();
    expect(body.data.droppedEventCount).toBe(0);
  });

  it('IT-1790-4: GET /streams returns zeroed defaults when no service', async () => {
    const app = createAdminMetricsRoutes({});
    const res = await app.request('http://localhost/streams');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      sampleCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      signalPause: false,
    });
  });

  it('IT-1790-5: GET /streams returns service metrics when wired', async () => {
    const streamsService = {
      getPublishLagMetrics: vi.fn().mockReturnValue({
        sampleCount: 100,
        p50Ms: 5,
        p95Ms: 20,
        maxMs: 50,
        signalPause: false,
      }),
    };
    const app = createAdminMetricsRoutes({ streamsService: streamsService as never });
    const res = await app.request('http://localhost/streams');
    const body = await res.json();
    expect(body.data.p95Ms).toBe(20);
    expect(streamsService.getPublishLagMetrics).toHaveBeenCalled();
  });

  it('IT-1790-6: GET /streams returns zeroed defaults when service is null', async () => {
    const app = createAdminMetricsRoutes({ streamsService: null });
    const res = await app.request('http://localhost/streams');
    const body = await res.json();
    expect(body.data.sampleCount).toBe(0);
  });
});
