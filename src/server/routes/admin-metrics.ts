/**
 * Admin metrics routes.
 *
 * F05-02: GET /api/admin/metrics/plan-mode — surface dropped-event counters from PlanModeService.
 * F05-13: GET /api/admin/metrics/streams — surface publish-lag p50/p95/max and backpressure signal.
 *
 * These are admin-only observability endpoints. They are not in the public API surface.
 */

import { Hono } from 'hono';
import type { DurableStreamsService } from '../../services/durable-streams.service.js';
import type { PlanModeService } from '../../services/plan-mode.service.js';
import { json } from '../shared.js';

export interface AdminMetricsDeps {
  planModeService?: PlanModeService | null;
  streamsService?: DurableStreamsService | null;
}

export function createAdminMetricsRoutes(deps: AdminMetricsDeps) {
  const app = new Hono();

  // GET /api/admin/metrics/plan-mode — F05-02
  app.get('/plan-mode', (_c) => {
    if (!deps.planModeService) {
      return json(
        {
          ok: true,
          data: {
            droppedEventCount: 0,
            droppedByEventType: {},
            droppedByReason: {},
          },
        },
        200
      );
    }
    return json({ ok: true, data: deps.planModeService.getMetrics() });
  });

  // GET /api/admin/metrics/streams — F05-13
  app.get('/streams', (_c) => {
    if (!deps.streamsService) {
      return json(
        {
          ok: true,
          data: {
            sampleCount: 0,
            p50Ms: 0,
            p95Ms: 0,
            maxMs: 0,
            signalPause: false,
          },
        },
        200
      );
    }
    return json({ ok: true, data: deps.streamsService.getPublishLagMetrics() });
  });

  return app;
}
