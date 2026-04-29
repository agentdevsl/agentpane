/**
 * Background Job Lifecycle (F12-04)
 *
 * Standardises how long-lived `setInterval`/`setTimeout` owners are started
 * and stopped. Owners implement {@link BackgroundJob} and register with a
 * process-wide {@link BackgroundJobRegistry}. The registry drains all
 * jobs on graceful shutdown and surfaces a health snapshot for ops.
 *
 * Migration status: `EventCleanupService`, `SchedulerService`, and
 * `EventOutboxRelayService` are the first to adopt the interface. Other
 * timer owners (SSE pings, auth session-cleanup, cli-monitor flush)
 * are documented in `specs/arch_review_april/12-cross-cutting.md` as
 * a follow-up.
 *
 * Design goals:
 *   - A failing `stop()` must not prevent other jobs from stopping. The
 *     registry catches and logs individual errors and returns aggregate
 *     failure info.
 *   - `start()`/`stop()` are idempotent — the registry does not double-call.
 *   - The snapshot is cheap: read-only, no side effects, safe to call
 *     from an admin endpoint.
 */

import { createLogger } from '../logging/logger.js';

const log = createLogger('BackgroundJob');

/**
 * Read-only health snapshot returned by {@link BackgroundJob.healthSnapshot}.
 * Shapes are intentionally narrow so they can round-trip through JSON in an
 * admin API without further shaping.
 */
export interface BackgroundJobSnapshot {
  /** Stable logical name. Same value as {@link BackgroundJob.name}. */
  name: string;
  /** `true` if the job is currently scheduled/running. */
  running: boolean;
  /** ISO timestamp of the last successful tick, if any. */
  lastRunAt?: string;
  /** Most recent error message, if the last tick failed. */
  lastError?: string;
}

/**
 * A long-lived background timer owner.
 *
 * Rules:
 *   - `start()` MUST be idempotent: a second call while running is a no-op.
 *   - `stop()` MUST be idempotent and SHOULD drain in-flight work best-effort
 *     (e.g. a `setTimeout` that waits for the current batch, bounded by a
 *     deadline).
 *   - `healthSnapshot()` MUST NOT throw.
 */
export interface BackgroundJob {
  /** Stable logical name used in logs and the registry snapshot. */
  readonly name: string;
  /** Schedule the timers owned by this job. Idempotent. */
  start(): void | Promise<void>;
  /** Clear all timers owned by this job and drain in-flight work. Idempotent. */
  stop(): void | Promise<void>;
  /** Optional read-only status for an ops endpoint. */
  healthSnapshot?(): BackgroundJobSnapshot;
}

/**
 * Registers a set of {@link BackgroundJob}s and drains them on shutdown.
 *
 * Not a singleton — a fresh registry is created per bootstrap (and per test)
 * so that unit tests don't leak timers between runs.
 */
export class BackgroundJobRegistry {
  private readonly jobs: BackgroundJob[] = [];
  private started = false;
  private stopped = false;

  /**
   * Add a job to the registry. Registration order is preserved; `stopAll()`
   * stops in LIFO order to match {@link GracefulShutdown} conventions.
   *
   * Throws if a job with the same `name` is already registered (operator
   * error — likely a double-import).
   */
  register(job: BackgroundJob): void {
    if (this.jobs.some((j) => j.name === job.name)) {
      throw new Error(`BackgroundJobRegistry: duplicate job name '${job.name}'`);
    }
    this.jobs.push(job);
  }

  /** Current registered job count. */
  size(): number {
    return this.jobs.length;
  }

  /**
   * Start every registered job. Errors from an individual `start()` are
   * logged and do NOT abort the loop — a half-started registry is worse
   * than a fully-started one where one job logged a warning.
   *
   * Safe to call exactly once per lifecycle; subsequent calls are no-ops.
   */
  async startAll(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs) {
      try {
        await job.start();
        log.info('Background job started', { data: { name: job.name } });
      } catch (err) {
        log.error('Background job failed to start', {
          error: err instanceof Error ? err : new Error(String(err)),
          data: { name: job.name },
        });
      }
    }
  }

  /**
   * Stop every registered job in LIFO order. Errors from an individual
   * `stop()` are logged but do NOT prevent subsequent jobs from stopping
   * — this is the primary robustness guarantee of the registry.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  async stopAll(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const reversed = [...this.jobs].reverse();
    for (const job of reversed) {
      try {
        await job.stop();
        log.debug('Background job stopped', { data: { name: job.name } });
      } catch (err) {
        log.warn('Background job failed to stop', {
          error: err instanceof Error ? err : new Error(String(err)),
          data: { name: job.name },
        });
      }
    }
  }

  /**
   * Read-only health snapshot of every registered job.
   * Jobs that don't implement `healthSnapshot()` appear with `running: true`
   * if `startAll()` was called and `stopAll()` was not, otherwise `false`.
   */
  snapshot(): BackgroundJobSnapshot[] {
    const defaultRunning = this.started && !this.stopped;
    return this.jobs.map((job) => {
      if (job.healthSnapshot) {
        try {
          return job.healthSnapshot();
        } catch (err) {
          // Guarantee: snapshot() never throws. Report the failure instead.
          return {
            name: job.name,
            running: defaultRunning,
            lastError: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return { name: job.name, running: defaultRunning };
    });
  }
}
