/**
 * Event Cleanup Service
 *
 * Background service that periodically deletes old rows from session_events
 * and event_log tables to bound storage growth. Retention periods are
 * configurable via admin settings (retention.sessionEventsDays,
 * retention.eventLogDays) and take effect without restart.
 */
import { sql } from 'drizzle-orm';
import { createLogger } from '../lib/logging/logger.js';
import type { Database } from '../types/database.js';
import type { SettingsService } from './settings.service.js';

const log = createLogger('EventCleanup');

/** Default retention: session events kept for 30 days */
const DEFAULT_SESSION_EVENTS_RETENTION_DAYS = 30;

/** Default retention: event log entries kept for 90 days */
const DEFAULT_EVENT_LOG_RETENTION_DAYS = 90;

/** How often the cleanup runs (24 hours) */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Delay before the first cleanup run after startup (60 seconds) */
const INITIAL_DELAY_MS = 60 * 1000;

/** Number of rows to delete per batch to avoid long-held locks */
const BATCH_SIZE = 1000;

export class EventCleanupService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private lastRunAt: string | null = null;

  constructor(
    private db: Database,
    private settingsService: SettingsService
  ) {}

  /**
   * Read a numeric retention setting, falling back to the provided default.
   */
  private async getRetentionDays(key: string, defaultDays: number): Promise<number> {
    try {
      const result = await this.settingsService.get(key);
      if (result.ok && result.value) {
        const parsed = JSON.parse(result.value.value);
        if (typeof parsed === 'number' && parsed > 0) {
          return parsed;
        }
      }
    } catch (err) {
      // EH-021: Fall through to default on any read/parse failure
      log.warn('Failed to read retention setting, using default', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return defaultDays;
  }

  /**
   * Batch-delete old rows from a table using a parameterized query.
   * Deletes in BATCH_SIZE chunks to avoid long-held locks.
   */
  private batchDelete(
    buildQuery: (cutoff: string) => ReturnType<typeof sql>,
    table: string,
    cutoff: string
  ): number {
    let totalDeleted = 0;
    let batchDeleted = BATCH_SIZE;

    while (batchDeleted >= BATCH_SIZE) {
      try {
        const result = this.db.run(buildQuery(cutoff));
        batchDeleted = result.changes;
        totalDeleted += batchDeleted;
      } catch (err) {
        log.error(`Batch delete failed for ${table}`, {
          error: err instanceof Error ? err : new Error(String(err)),
          data: { table, totalDeletedSoFar: totalDeleted, cutoff },
        });
        break;
      }
    }

    return totalDeleted;
  }

  /**
   * Run a single cleanup cycle: read config, compute cutoffs, batch-delete.
   */
  async runCleanup(): Promise<{
    sessionEventsDeleted: number;
    eventLogDeleted: number;
  }> {
    const sessionEventsDays = await this.getRetentionDays(
      'retention.sessionEventsDays',
      DEFAULT_SESSION_EVENTS_RETENTION_DAYS
    );
    const eventLogDays = await this.getRetentionDays(
      'retention.eventLogDays',
      DEFAULT_EVENT_LOG_RETENTION_DAYS
    );

    const now = new Date();

    function cutoffIso(days: number): string {
      const d = new Date(now);
      d.setDate(d.getDate() - days);
      return d.toISOString();
    }

    const sessionEventsDeleted = this.batchDelete(
      (cutoff) =>
        sql`DELETE FROM session_events WHERE rowid IN (SELECT rowid FROM session_events WHERE created_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'session_events',
      cutoffIso(sessionEventsDays)
    );
    const eventLogDeleted = this.batchDelete(
      (cutoff) =>
        sql`DELETE FROM event_log WHERE rowid IN (SELECT rowid FROM event_log WHERE received_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'event_log',
      cutoffIso(eventLogDays)
    );

    this.lastRunAt = now.toISOString();

    if (sessionEventsDeleted > 0 || eventLogDeleted > 0) {
      log.info('Event cleanup completed', {
        data: {
          sessionEventsDeleted,
          eventLogDeleted,
          sessionEventsDays,
          eventLogDays,
        },
      });
    } else {
      log.info('Event cleanup completed — no rows to delete');
    }

    return { sessionEventsDeleted, eventLogDeleted };
  }

  /**
   * Start the cleanup scheduler.
   * Returns a stop function for use with the shutdown handler.
   */
  start(): () => void {
    if (this.isRunning) {
      return () => this.stop();
    }
    this.isRunning = true;

    // Delay the first run to avoid startup contention
    this.initialTimeoutId = setTimeout(() => {
      this.runCleanup().catch((error) => {
        log.error('Event cleanup failed', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

      // Set up periodic cleanup
      this.intervalId = setInterval(() => {
        this.runCleanup().catch((error) => {
          log.error('Event cleanup failed', {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }, CLEANUP_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    return () => this.stop();
  }

  /**
   * Stop the cleanup scheduler and clear all timers.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
  }

  /**
   * Get the current service state (for debugging/monitoring).
   */
  getState(): Readonly<{ isRunning: boolean; lastRunAt: string | null }> {
    return {
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt,
    };
  }
}
