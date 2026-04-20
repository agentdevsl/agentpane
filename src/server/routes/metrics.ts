/**
 * F10-01: GET /api/metrics — JSON metrics endpoint.
 *
 * In-memory counter/gauge/histogram surface produced by MetricsService. This
 * is the minimum-viable metrics endpoint called out in
 * specs/arch_review_april/10-observability.md.
 *
 * Admin-only; guard wiring lives in src/server/router.ts.
 */

import { Hono } from 'hono';
import { getEventRouterSnapshot } from '../../lib/events/event-router.js';
import type { DurableStreamsService } from '../../services/durable-streams.service.js';
import type { MetricsService } from '../../services/metrics.service.js';
import type { PlanModeService } from '../../services/plan-mode.service.js';
import { json } from '../shared.js';

export interface MetricsRouteDeps {
  metricsService: MetricsService;
  /** Optional: when present, stream publish-lag metrics are folded into the snapshot. */
  streamsService?: DurableStreamsService | null;
  /** Optional: when present, plan-mode drop counters are folded into the snapshot. */
  planModeService?: PlanModeService | null;
}

export function createMetricsRoutes(deps: MetricsRouteDeps) {
  const app = new Hono();

  app.get('/', (_c) => {
    const base = deps.metricsService.snapshot();
    // F05-03 EventRouter snapshot is the authoritative active-SSE count for
    // in-process streams. Fold it into the SSE section so a single /metrics
    // hit covers the observability surface.
    const sseSnapshot = getEventRouterSnapshot();
    const streams = deps.streamsService?.getPublishLagMetrics();
    const planMode = deps.planModeService?.getMetrics();
    return json({
      ok: true,
      data: {
        ...base,
        sse: {
          ...base.sse,
          eventRouter: sseSnapshot,
        },
        // Cross-theme links: F05-13 stream lag + F05-02/F10-09 dropped-event
        // counter are surfaced here too so a single scrape covers the
        // observability surface.
        streams: streams ?? null,
        planMode: planMode ?? null,
      },
    });
  });

  return app;
}
