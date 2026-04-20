import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMetricsService, getMetricsService, MetricsService } from '../metrics.service.js';

describe('MetricsService (F10-01)', () => {
  beforeEach(() => {
    __resetMetricsService();
  });

  it('counts HTTP requests by route and status class', () => {
    const svc = new MetricsService();

    svc.recordHttpRequest('/api/tasks/:id', 200);
    svc.recordHttpRequest('/api/tasks/:id', 200);
    svc.recordHttpRequest('/api/tasks/:id', 500);
    svc.recordHttpRequest('/api/codespaces', 201);
    svc.recordHttpRequest('/api/codespaces', 404);

    const snap = svc.snapshot();

    expect(snap.http.totalRequests).toBe(5);
    const tasks2xx = snap.http.byRouteStatus.find(
      (r) => r.route === '/api/tasks/:id' && r.statusClass === '2xx'
    );
    const tasks5xx = snap.http.byRouteStatus.find(
      (r) => r.route === '/api/tasks/:id' && r.statusClass === '5xx'
    );
    const codespaces2xx = snap.http.byRouteStatus.find(
      (r) => r.route === '/api/codespaces' && r.statusClass === '2xx'
    );
    const codespaces4xx = snap.http.byRouteStatus.find(
      (r) => r.route === '/api/codespaces' && r.statusClass === '4xx'
    );

    expect(tasks2xx?.count).toBe(2);
    expect(tasks5xx?.count).toBe(1);
    expect(codespaces2xx?.count).toBe(1);
    expect(codespaces4xx?.count).toBe(1);
  });

  it('tracks agent lifecycle counters and gauges', () => {
    const svc = new MetricsService();

    svc.incAgentStarted();
    svc.incAgentStarted();
    svc.incAgentCompleted();
    svc.incAgentErrored();
    svc.setAgentGauge(2, 5);

    const snap = svc.snapshot();
    expect(snap.agent.started).toBe(2);
    expect(snap.agent.completed).toBe(1);
    expect(snap.agent.errored).toBe(1);
    expect(snap.agent.running).toBe(2);
    expect(snap.agent.idle).toBe(5);
  });

  it('clamps SSE gauge to zero on over-release', () => {
    const svc = new MetricsService();

    svc.incSse();
    svc.incSse();
    svc.decSse();
    svc.decSse();
    svc.decSse();
    svc.decSse();

    expect(svc.snapshot().sse.activeConnections).toBe(0);
  });

  it('aggregates DB latency samples by query type', () => {
    const svc = new MetricsService();

    svc.recordDbLatency('select_task', 5);
    svc.recordDbLatency('select_task', 12);
    svc.recordDbLatency('select_task', 3);
    svc.recordDbLatency('insert_event', 7);

    const snap = svc.snapshot();
    const selectTask = snap.db.byQueryType.find((q) => q.queryType === 'select_task');
    const insertEvent = snap.db.byQueryType.find((q) => q.queryType === 'insert_event');

    expect(selectTask).toEqual({
      queryType: 'select_task',
      count: 3,
      totalMs: 20,
      maxMs: 12,
    });
    expect(insertEvent).toEqual({
      queryType: 'insert_event',
      count: 1,
      totalMs: 7,
      maxMs: 7,
    });
  });

  it('reflects traffic hitting the endpoint by counting multiple recorded requests', () => {
    const svc = new MetricsService();
    const N = 10;
    for (let i = 0; i < N; i++) svc.recordHttpRequest('/api/metrics', 200);

    const snap = svc.snapshot();
    expect(snap.http.totalRequests).toBe(N);
  });

  it('singleton returns a single instance until reset', () => {
    const a = getMetricsService();
    const b = getMetricsService();
    expect(a).toBe(b);

    __resetMetricsService();
    const c = getMetricsService();
    expect(c).not.toBe(a);
  });
});
