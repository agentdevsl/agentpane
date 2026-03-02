/**
 * Configuration stored in event_sources.config for type='cron'.
 */
export interface CronEventSourceConfig {
  scheduleType: 'interval' | 'cron';
  interval?: number;
  cronExpression?: string;
  timezone: string;
  budget: {
    maxPerHour?: number;
    maxPerDay?: number;
    maxPerWeek?: number;
    maxPerMonth?: number;
  };
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveErrors: number;
  pausedAt: string | null;
}

/**
 * Context passed from the SchedulerService when invoking the cron plugin.
 */
export interface CronTickContext {
  sourceName: string;
  config: CronEventSourceConfig;
  executionCount: number;
  trigger: 'tick' | 'manual';
}
