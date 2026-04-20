/**
 * MetricsService (F10-01)
 *
 * In-memory counters/histograms surfaced by GET /api/metrics. Intentionally
 * dependency-free (no prom-client) so it can evolve into a Prometheus surface
 * later without coupling consumers to the underlying encoding.
 *
 * Exposes:
 * - HTTP request counts by route + status class
 * - Agent lifecycle counters (started/completed/errored) and running gauge
 * - SSE connection gauge (`incSse`/`decSse`)
 * - DB query latency summaries (count, totalMs, maxMs) per query type
 * - Generic counter/gauge setters so other services can contribute
 *
 * The service is a singleton via {@link getMetricsService}. Tests can construct
 * a fresh instance.
 */

export interface HttpRequestMetric {
  route: string;
  /** Status class: '2xx' | '3xx' | '4xx' | '5xx' | 'unknown'. */
  statusClass: string;
  count: number;
}

export interface DbLatencySummary {
  queryType: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  timestamp: string;
  http: {
    totalRequests: number;
    byRouteStatus: HttpRequestMetric[];
  };
  agent: {
    started: number;
    completed: number;
    errored: number;
    running: number;
    idle: number;
  };
  sse: {
    activeConnections: number;
  };
  db: {
    byQueryType: DbLatencySummary[];
  };
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export class MetricsService {
  private readonly startedAt = Date.now();

  // HTTP
  private httpByRouteStatus = new Map<string, number>();

  // Agents
  private agentStarted = 0;
  private agentCompleted = 0;
  private agentErrored = 0;
  // `agentRunning`/`agentIdle` are gauges; maintained via setAgentGauge().
  private agentRunning = 0;
  private agentIdle = 0;

  // SSE
  private sseActive = 0;

  // DB latency — count + totalMs + maxMs by query type.
  private dbByType = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  // Generic counters / gauges for ad-hoc instrumentation.
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  /** Bump the request counter for an HTTP route + status code. */
  recordHttpRequest(route: string, status: number): void {
    const bucket = classifyStatus(status);
    // Keep cardinality bounded: route is the matched Hono pattern, not the raw
    // URL path. If callers pass raw paths the map can blow up; callers are
    // expected to pass a low-cardinality route pattern (e.g. '/api/tasks/:id').
    const key = `${route}|${bucket}`;
    this.httpByRouteStatus.set(key, (this.httpByRouteStatus.get(key) ?? 0) + 1);
  }

  /** Agent lifecycle counters. */
  incAgentStarted(): void {
    this.agentStarted++;
  }
  incAgentCompleted(): void {
    this.agentCompleted++;
  }
  incAgentErrored(): void {
    this.agentErrored++;
  }

  /** Set the running/idle gauges (authoritative; called from agent service). */
  setAgentGauge(running: number, idle: number): void {
    this.agentRunning = Math.max(0, running | 0);
    this.agentIdle = Math.max(0, idle | 0);
  }

  /** SSE connection gauge. */
  incSse(): void {
    this.sseActive++;
  }
  decSse(): void {
    this.sseActive = Math.max(0, this.sseActive - 1);
  }

  /** Record a DB query latency sample. `queryType` is a coarse label (e.g. 'select_task'). */
  recordDbLatency(queryType: string, durationMs: number): void {
    const ms = Math.max(0, durationMs);
    const existing = this.dbByType.get(queryType);
    if (!existing) {
      this.dbByType.set(queryType, { count: 1, totalMs: ms, maxMs: ms });
      return;
    }
    existing.count++;
    existing.totalMs += ms;
    if (ms > existing.maxMs) existing.maxMs = ms;
  }

  /** Ad-hoc counter for future call sites (feeds `counters` in the snapshot). */
  incCounter(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Ad-hoc gauge (overwrites previous value). */
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Return the current in-memory metrics snapshot. */
  snapshot(): MetricsSnapshot {
    const now = Date.now();
    const byRouteStatus: HttpRequestMetric[] = [];
    for (const [key, count] of this.httpByRouteStatus.entries()) {
      const [route, statusClass] = key.split('|');
      byRouteStatus.push({
        route: route ?? 'unknown',
        statusClass: statusClass ?? 'unknown',
        count,
      });
    }
    byRouteStatus.sort((a, b) => b.count - a.count);

    const byQueryType: DbLatencySummary[] = [];
    for (const [queryType, sample] of this.dbByType.entries()) {
      byQueryType.push({
        queryType,
        count: sample.count,
        totalMs: sample.totalMs,
        maxMs: sample.maxMs,
      });
    }
    byQueryType.sort((a, b) => b.count - a.count);

    const counters = Object.fromEntries(this.counters);
    const gauges = Object.fromEntries(this.gauges);

    let totalRequests = 0;
    for (const count of this.httpByRouteStatus.values()) totalRequests += count;

    return {
      uptimeMs: now - this.startedAt,
      timestamp: new Date(now).toISOString(),
      http: {
        totalRequests,
        byRouteStatus,
      },
      agent: {
        started: this.agentStarted,
        completed: this.agentCompleted,
        errored: this.agentErrored,
        running: this.agentRunning,
        idle: this.agentIdle,
      },
      sse: {
        activeConnections: this.sseActive,
      },
      db: {
        byQueryType,
      },
      counters,
      gauges,
    };
  }

  /** Reset all counters/gauges. Test helper. */
  reset(): void {
    this.httpByRouteStatus.clear();
    this.agentStarted = 0;
    this.agentCompleted = 0;
    this.agentErrored = 0;
    this.agentRunning = 0;
    this.agentIdle = 0;
    this.sseActive = 0;
    this.dbByType.clear();
    this.counters.clear();
    this.gauges.clear();
  }
}

function classifyStatus(status: number): string {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'unknown';
}

// --- Singleton accessor --------------------------------------------------

let singleton: MetricsService | null = null;

/** Get the process-wide MetricsService. Lazily instantiated. */
export function getMetricsService(): MetricsService {
  if (!singleton) singleton = new MetricsService();
  return singleton;
}

/** Test helper — swap the singleton for a fresh instance. */
export function __resetMetricsService(): void {
  singleton = null;
}
