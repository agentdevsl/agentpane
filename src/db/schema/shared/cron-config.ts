/**
 * Budget limits per time window.
 * All limits are optional; if not set, that window is unconstrained.
 */
export interface CronBudgetConfig {
  maxPerHour?: number;
  maxPerDay?: number;
  maxPerWeek?: number;
  maxPerMonth?: number;
}

/**
 * Configuration stored in event_sources.config for type='cron'.
 */
export interface CronEventSourceConfig {
  /** 'interval' for simple repeating, 'cron' for cron expressions */
  scheduleType: 'interval' | 'cron';

  /** Interval in seconds (for scheduleType: 'interval'). Min: 60, Max: 2592000 */
  interval?: number;

  /** Standard 5-field cron expression (for scheduleType: 'cron') */
  cronExpression?: string;

  /** IANA timezone for cron evaluation */
  timezone: string;

  /** Budget limits per time window */
  budget: CronBudgetConfig;

  /** Next scheduled run time (ISO 8601 UTC). Managed by SchedulerService */
  nextRunAt: string | null;

  /** Last successful run time (ISO 8601 UTC) */
  lastRunAt: string | null;

  /** Number of consecutive execution errors (resets on success) */
  consecutiveErrors: number;

  /** ISO 8601 timestamp when schedule was paused (null when active) */
  pausedAt: string | null;
}
