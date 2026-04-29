/**
 * F10-14 — DB latency instrumentation helper.
 *
 * Wraps a Drizzle query (or any async DB operation) and records the elapsed
 * milliseconds against {@link MetricsService.recordDbLatency}. The label is a
 * coarse query-type string (e.g. 'select_task', 'insert_event'); cardinality
 * stays bounded because callers are expected to use a small fixed set of
 * labels rather than dynamic ones.
 *
 * Failures inside the wrapped operation are recorded too — the timing always
 * reaches the metrics service, then the original error is rethrown so callers
 * see no behavioural change. A best-effort try/catch around the metrics call
 * itself prevents instrumentation bugs from breaking the underlying query.
 *
 * @example
 * const task = await withDbLatency('select_task', () =>
 *   db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })
 * );
 */

import { getMetricsService } from '../../services/metrics.service.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('withDbLatency');

export async function withDbLatency<T>(queryType: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    try {
      getMetricsService().recordDbLatency(queryType, Date.now() - start);
    } catch (metricsErr) {
      // Instrumentation must never break a query, but failures should be
      // visible so broken metrics don't silently decay.
      log.warn('withDbLatency: recordDbLatency failed', {
        error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
        data: { queryType },
      });
    }
  }
}
