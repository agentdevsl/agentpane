import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMetricsService, getMetricsService } from '../../../services/metrics.service.js';
import { createMetricsRoutes } from '../metrics.js';

describe('GET /api/metrics (F10-01)', () => {
  beforeEach(() => {
    __resetMetricsService();
  });

  function buildApp() {
    const metricsService = getMetricsService();
    const app = new Hono();
    app.route('/api/metrics', createMetricsRoutes({ metricsService }));
    return { app, metricsService };
  }

  it('returns the current snapshot wrapped in the standard envelope', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/metrics', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty('http');
    expect(body.data).toHaveProperty('agent');
    expect(body.data).toHaveProperty('sse');
    expect(body.data).toHaveProperty('db');
    expect(body.data).toHaveProperty('uptimeMs');
    expect(body.data).toHaveProperty('timestamp');
  });

  it('reflects traffic after N recorded requests', async () => {
    const { app, metricsService } = buildApp();
    for (let i = 0; i < 7; i++) metricsService.recordHttpRequest('/api/tasks/:id', 200);
    for (let i = 0; i < 3; i++) metricsService.recordHttpRequest('/api/tasks/:id', 500);
    metricsService.incAgentStarted();
    metricsService.incAgentCompleted();
    metricsService.incSse();
    metricsService.recordDbLatency('select_task', 4);

    const res = await app.request('/api/metrics', { method: 'GET' });
    const body = (await res.json()) as {
      data: {
        http: {
          totalRequests: number;
          byRouteStatus: Array<{ route: string; statusClass: string; count: number }>;
        };
        agent: { started: number; completed: number };
        sse: { activeConnections: number };
        db: { byQueryType: Array<{ queryType: string; count: number }> };
      };
    };

    expect(body.data.http.totalRequests).toBe(10);
    const tasks2xx = body.data.http.byRouteStatus.find(
      (r) => r.route === '/api/tasks/:id' && r.statusClass === '2xx'
    );
    const tasks5xx = body.data.http.byRouteStatus.find(
      (r) => r.route === '/api/tasks/:id' && r.statusClass === '5xx'
    );
    expect(tasks2xx?.count).toBe(7);
    expect(tasks5xx?.count).toBe(3);
    expect(body.data.agent.started).toBe(1);
    expect(body.data.agent.completed).toBe(1);
    expect(body.data.sse.activeConnections).toBe(1);
    expect(body.data.db.byQueryType.find((q) => q.queryType === 'select_task')?.count).toBe(1);
  });
});
