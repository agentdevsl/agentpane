import { createId } from '@paralleldrive/cuid2';
import { CronExpressionParser } from 'cron-parser';
import { and, eq, sql } from 'drizzle-orm';
import type { EventSource } from '../db/schema/index.js';
import { eventSources } from '../db/schema/index.js';
import type { CronEventSourceConfig } from '../db/schema/shared/cron-config.js';
import { scheduleExecutions } from '../db/schema/sqlite/schedule-executions.js';
import type { AppError } from '../lib/errors/base.js';
import { ScheduleErrors } from '../lib/errors/event-errors.js';
import { ServiceErrors } from '../lib/errors/service-errors.js';
import { publishEventToStream } from '../lib/events/event-bus.js';
import type { PluginRegistry } from '../lib/events/plugin-registry.js';
import type { CronTickContext } from '../lib/events/plugins/cron-plugin.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { EventProcessingService } from './event-processing.service.js';
import type { EventSourceService } from './event-source.service.js';

const log = createLogger('SchedulerService');

export interface ManualTriggerResult {
  triggered: boolean;
  executionId: string;
  taskIds: string[];
  budgetRemaining: {
    hour: number | null;
    day: number | null;
    week: number | null;
    month: number | null;
  };
}

import type { BudgetWindow } from '../db/schema/shared/enums.js';

interface BudgetCheckResult {
  ok: boolean;
  window?: BudgetWindow;
  count?: number;
}

export class SchedulerService {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private activeExecutions = new Set<string>();

  private readonly tickIntervalMs: number;
  private readonly concurrencyLimit: number;
  private readonly enabled: boolean;

  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor(
    private db: Database,
    private pluginRegistry: PluginRegistry,
    private eventProcessingService: EventProcessingService,
    private eventSourceService: EventSourceService
  ) {
    this.tickIntervalMs = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000;
    this.concurrencyLimit = Number(process.env.SCHEDULER_CONCURRENCY_LIMIT) || 5;
    this.enabled = process.env.SCHEDULER_ENABLED !== 'false';
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      log.info('Scheduler disabled via SCHEDULER_ENABLED=false');
      return;
    }

    if (this.isRunning) {
      log.warn('Scheduler already running, ignoring start()');
      return;
    }

    log.info('Starting scheduler', {
      data: { tickIntervalMs: this.tickIntervalMs, concurrencyLimit: this.concurrencyLimit },
    });

    await this.recoverSchedules();

    this.isRunning = true;
    this.tickInterval = setInterval(() => this.tick(), this.tickIntervalMs);

    await this.tick();

    log.info('Scheduler started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    log.info('Stopping scheduler...');
    this.isRunning = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    const deadline = Date.now() + 30_000;
    while (this.activeExecutions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.activeExecutions.size > 0) {
      log.warn('Scheduler stopped with active executions', {
        data: { remaining: this.activeExecutions.size },
      });
    }

    log.info('Scheduler stopped');
  }

  // -------------------------------------------------------------------------
  // Tick Loop
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.isRunning) return;

    const tickStart = Date.now();
    const now = new Date().toISOString();

    let dueSources: EventSource[];
    try {
      dueSources = await this.db
        .select()
        .from(eventSources)
        .where(
          and(
            eq(eventSources.type, 'cron'),
            eq(eventSources.status, 'active'),
            eq(eventSources.isEnabled, true),
            sql`json_extract(${eventSources.config}, '$.nextRunAt') <= ${now}`
          )
        );
    } catch (queryError) {
      log.error('Failed to query due sources', { error: queryError });
      return;
    }

    if (dueSources.length === 0) return;

    log.info('Tick: processing due sources', { data: { dueCount: dueSources.length } });

    const results = { executed: 0, skippedBudget: 0, skippedLock: 0, errors: 0 };

    for (let i = 0; i < dueSources.length; i += this.concurrencyLimit) {
      const batch = dueSources.slice(i, i + this.concurrencyLimit);
      const batchResults = await Promise.allSettled(
        batch.map((source) => this.processSource(source, 'tick'))
      );

      for (const result of batchResults) {
        if (result.status === 'rejected') {
          results.errors++;
          log.error('Source processing rejected unexpectedly', { error: result.reason });
        } else {
          switch (result.value.outcome) {
            case 'executed':
              results.executed++;
              break;
            case 'skipped_budget':
              results.skippedBudget++;
              break;
            case 'skipped_lock':
              results.skippedLock++;
              break;
            case 'error':
              results.errors++;
              break;
          }
        }
      }
    }

    log.info('Tick complete', {
      data: { durationMs: Date.now() - tickStart, ...results },
    });
  }

  // -------------------------------------------------------------------------
  // Source Processing
  // -------------------------------------------------------------------------

  private async processSource(
    source: EventSource,
    trigger: 'tick' | 'manual'
  ): Promise<{
    outcome: 'executed' | 'skipped_budget' | 'skipped_lock' | 'error';
    executionId: string;
    tasksCreated: string[];
  }> {
    const config = source.config as unknown as CronEventSourceConfig;
    const executionId = createId();

    this.activeExecutions.add(executionId);

    try {
      const newNextRunAt = this.calculateNextRunAt(config);

      // CAS lock for tick-triggered executions; manual triggers update state directly
      if (trigger === 'tick') {
        if (!config.nextRunAt) {
          log.warn('Source has null nextRunAt, recovering', { data: { sourceId: source.id } });
          await this.updateNextRunAt(source.id, newNextRunAt);
          return { outcome: 'skipped_lock', executionId, tasksCreated: [] };
        }
        const locked = await this.acquireLock(source.id, config.nextRunAt, newNextRunAt);
        if (!locked) {
          log.debug('Skipped source (lock contention)', { data: { sourceId: source.id } });
          return { outcome: 'skipped_lock', executionId, tasksCreated: [] };
        }
      } else {
        // Manual trigger: update nextRunAt and lastRunAt outside of CAS lock
        await this.db.run(sql`
          UPDATE event_sources
          SET config = json_set(
                json_set(config, '$.nextRunAt', ${newNextRunAt}),
                '$.lastRunAt', ${new Date().toISOString()}
              ),
              updated_at = datetime('now')
          WHERE id = ${source.id}
        `);
      }

      // Check budget
      const budgetResult = await this.checkBudget(source.id, config);
      if (!budgetResult.ok) {
        await this.recordExecution({
          eventSourceId: source.id,
          status: 'skipped_budget',
          scheduledAt: config.nextRunAt ?? new Date().toISOString(),
          budgetWindow: budgetResult.window,
          windowExecutionCount: budgetResult.count ?? 0,
        });

        publishEventToStream({
          type: 'schedule:skipped',
          data: {
            eventSourceId: source.id,
            reason: 'budget_exceeded',
            window: budgetResult.window,
          },
        });

        log.info('Skipped source (budget exceeded)', {
          data: { sourceId: source.id, window: budgetResult.window },
        });
        return { outcome: 'skipped_budget', executionId, tasksCreated: [] };
      }

      // Get execution count for context
      const executionCount = await this.getExecutionCount(source.id);

      // Build tick context and invoke plugin
      const tickContext: CronTickContext = {
        sourceName: source.name,
        config,
        executionCount,
        trigger,
      };

      const plugin = this.pluginRegistry.get('cron');
      if (!plugin) {
        log.error('Cron plugin not registered');
        return { outcome: 'error', executionId, tasksCreated: [] };
      }

      const parseResult = plugin.parseEvent(new Headers(), JSON.stringify(tickContext));
      if (!parseResult.ok) {
        await this.recordExecution({
          eventSourceId: source.id,
          status: 'error',
          scheduledAt: config.nextRunAt ?? new Date().toISOString(),
          error: parseResult.error.message,
        });
        return { outcome: 'error', executionId, tasksCreated: [] };
      }

      // Feed into event processing pipeline
      const processingResult = await this.eventProcessingService.processScheduledEvent(
        source,
        parseResult.value
      );

      const tasksCreated = processingResult.ok ? processingResult.value.tasksCreated : [];

      await this.recordExecution({
        eventSourceId: source.id,
        status: processingResult.ok ? 'executed' : 'error',
        scheduledAt: config.nextRunAt ?? new Date().toISOString(),
        taskId: tasksCreated[0],
        error: processingResult.ok ? undefined : processingResult.error.message,
      });

      if (!processingResult.ok) {
        await this.incrementConsecutiveErrors(source.id, config);
        publishEventToStream({
          type: 'schedule:error',
          data: { eventSourceId: source.id, executionId, error: processingResult.error.message },
        });
        return { outcome: 'error', executionId, tasksCreated: [] };
      }

      // Reset consecutive errors on success
      try {
        await this.resetConsecutiveErrors(source.id);
      } catch (resetErr) {
        log.error('Failed to reset consecutive errors after successful execution', {
          data: { sourceId: source.id },
          error: resetErr,
        });
      }

      publishEventToStream({
        type: 'schedule:executed',
        data: {
          executionId,
          eventSourceId: source.id,
          status: 'executed',
          taskIds: tasksCreated,
        },
      });

      log.info('Source executed successfully', {
        data: { sourceId: source.id, tasksCreated: tasksCreated.length },
      });

      return { outcome: 'executed', executionId, tasksCreated };
    } catch (err_) {
      log.error('Unexpected error processing source', {
        data: { sourceId: source.id },
        error: err_,
      });
      try {
        await this.recordExecution({
          eventSourceId: source.id,
          status: 'error',
          scheduledAt: config.nextRunAt ?? new Date().toISOString(),
          error: String(err_),
        });
      } catch (recordErr) {
        log.error('Failed to record execution after error', { error: recordErr });
      }
      try {
        await this.incrementConsecutiveErrors(source.id, config);
      } catch (incErr) {
        log.error('Failed to increment consecutive errors', { error: incErr });
      }
      return { outcome: 'error', executionId, tasksCreated: [] };
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  // -------------------------------------------------------------------------
  // CAS Locking
  // -------------------------------------------------------------------------

  private async acquireLock(
    sourceId: string,
    expectedNextRunAt: string,
    newNextRunAt: string
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE event_sources
      SET config = json_set(
            json_set(config, '$.nextRunAt', ${newNextRunAt}),
            '$.lastRunAt', ${new Date().toISOString()}
          ),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
        AND json_extract(config, '$.nextRunAt') = ${expectedNextRunAt}
    `);

    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Budget Enforcement
  // -------------------------------------------------------------------------

  /**
   * Query execution counts for all budget windows in a single SQL query.
   * Returns a map of window key to execution count.
   */
  private async queryWindowCounts(
    sourceId: string,
    timezone: string
  ): Promise<Record<BudgetWindow, number>> {
    const hourStart = this.getWindowStart('hour', timezone);
    const dayStart = this.getWindowStart('day', timezone);
    const weekStart = this.getWindowStart('week', timezone);
    const monthStart = this.getWindowStart('month', timezone);

    const rows = await this.db
      .select({
        countHour: sql<number>`sum(CASE WHEN ${scheduleExecutions.executedAt} >= ${hourStart} THEN 1 ELSE 0 END)`,
        countDay: sql<number>`sum(CASE WHEN ${scheduleExecutions.executedAt} >= ${dayStart} THEN 1 ELSE 0 END)`,
        countWeek: sql<number>`sum(CASE WHEN ${scheduleExecutions.executedAt} >= ${weekStart} THEN 1 ELSE 0 END)`,
        countMonth: sql<number>`sum(CASE WHEN ${scheduleExecutions.executedAt} >= ${monthStart} THEN 1 ELSE 0 END)`,
      })
      .from(scheduleExecutions)
      .where(
        and(
          eq(scheduleExecutions.eventSourceId, sourceId),
          eq(scheduleExecutions.status, 'executed'),
          sql`${scheduleExecutions.executedAt} >= ${monthStart}`
        )
      );

    const row = rows[0];
    return {
      hour: row?.countHour ?? 0,
      day: row?.countDay ?? 0,
      week: row?.countWeek ?? 0,
      month: row?.countMonth ?? 0,
    };
  }

  private async checkBudget(
    sourceId: string,
    config: CronEventSourceConfig
  ): Promise<BudgetCheckResult> {
    const { budget } = config;
    if (!budget) return { ok: true };

    const hasAnyLimit =
      budget.maxPerHour !== undefined ||
      budget.maxPerDay !== undefined ||
      budget.maxPerWeek !== undefined ||
      budget.maxPerMonth !== undefined;
    if (!hasAnyLimit) return { ok: true };

    const counts = await this.queryWindowCounts(sourceId, config.timezone);

    const checks: Array<{ window: BudgetWindow; limit: number | undefined; count: number }> = [
      { window: 'hour', limit: budget.maxPerHour, count: counts.hour },
      { window: 'day', limit: budget.maxPerDay, count: counts.day },
      { window: 'week', limit: budget.maxPerWeek, count: counts.week },
      { window: 'month', limit: budget.maxPerMonth, count: counts.month },
    ];

    for (const check of checks) {
      if (check.limit !== undefined && check.count >= check.limit) {
        return { ok: false, window: check.window, count: check.count };
      }
    }

    return { ok: true };
  }

  private getWindowStart(window: 'hour' | 'day' | 'week' | 'month', timezone: string): string {
    const now = new Date();

    let validTimezone = timezone;
    try {
      // Validate timezone by constructing a formatter — throws RangeError if invalid
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      log.warn('Invalid timezone, falling back to UTC', { data: { timezone } });
      validTimezone = 'UTC';
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: validTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));

    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour === '24' ? '0' : parts.hour);

    // Get the UTC offset for this timezone so we can convert local time to UTC.
    const offsetMs = this.getTimezoneOffsetMs(now, validTimezone);

    switch (window) {
      case 'hour': {
        // Start of current hour in target timezone, converted to UTC
        const localMs = Date.UTC(year, month - 1, day, hour, 0, 0);
        return new Date(localMs - offsetMs).toISOString();
      }
      case 'day': {
        // Start of current day in target timezone, converted to UTC
        const localMs = Date.UTC(year, month - 1, day, 0, 0, 0);
        return new Date(localMs - offsetMs).toISOString();
      }
      case 'week': {
        // Find Monday of current week in target timezone
        // Use Date.UTC to avoid host timezone interference
        const localMs = Date.UTC(year, month - 1, day, 0, 0, 0);
        const utcDate = new Date(localMs);
        const dayOfWeek = utcDate.getUTCDay();
        const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const mondayMs = localMs - daysToMonday * 86_400_000;
        return new Date(mondayMs - offsetMs).toISOString();
      }
      case 'month': {
        // Start of current month in target timezone, converted to UTC
        const localMs = Date.UTC(year, month - 1, 1, 0, 0, 0);
        return new Date(localMs - offsetMs).toISOString();
      }
    }
  }

  private getTimezoneOffsetMs(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const match = offsetPart.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? 0);
    return sign * (hours * 60 + minutes) * 60_000;
  }

  // -------------------------------------------------------------------------
  // nextRunAt Calculation
  // -------------------------------------------------------------------------

  calculateNextRunAt(config: CronEventSourceConfig): string {
    const now = new Date();
    const baseTime = config.lastRunAt ? new Date(config.lastRunAt) : now;

    if (config.scheduleType === 'interval') {
      const intervalMs = (config.interval ?? 60) * 1000;
      const next = new Date(baseTime.getTime() + intervalMs);
      if (next <= now) {
        const elapsed = now.getTime() - baseTime.getTime();
        const missedIntervals = Math.ceil(elapsed / intervalMs);
        return new Date(baseTime.getTime() + missedIntervals * intervalMs).toISOString();
      }
      return next.toISOString();
    }

    if (config.scheduleType === 'cron' && config.cronExpression) {
      try {
        const interval = CronExpressionParser.parse(config.cronExpression, {
          currentDate: baseTime,
          tz: config.timezone,
        });

        let next = interval.next().toDate();
        while (next <= now) {
          next = interval.next().toDate();
        }
        return next.toISOString();
      } catch (cronError) {
        throw ScheduleErrors.INVALID_CRON(
          `${config.cronExpression} (timezone: ${config.timezone}): ${cronError instanceof Error ? cronError.message : String(cronError)}`
        );
      }
    }

    throw ServiceErrors.INVALID_SCHEDULE_TYPE(config.scheduleType);
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async recoverSchedules(): Promise<void> {
    let cronSources: EventSource[];
    try {
      cronSources = await this.db
        .select()
        .from(eventSources)
        .where(
          and(
            eq(eventSources.type, 'cron'),
            eq(eventSources.status, 'active'),
            eq(eventSources.isEnabled, true)
          )
        );
    } catch (queryError) {
      log.error('Failed to query cron sources for recovery — will retry on first tick', {
        error: queryError,
      });
      return;
    }

    let recovered = 0;
    let missed = 0;
    let errors = 0;

    for (const source of cronSources) {
      try {
        const config = source.config as unknown as CronEventSourceConfig;

        if (!config.nextRunAt) {
          const nextRunAt = this.calculateNextRunAt(config);
          await this.updateNextRunAt(source.id, nextRunAt);
          recovered++;
          continue;
        }

        const nextRunAt = new Date(config.nextRunAt);
        if (nextRunAt <= new Date()) {
          const newNextRunAt = this.calculateNextRunAt(config);
          await this.updateNextRunAt(source.id, newNextRunAt);
          recovered++;
          missed++;
        }
      } catch (sourceError) {
        errors++;
        log.error('Failed to recover schedule for source, skipping', {
          data: { sourceId: source.id },
          error: sourceError,
        });
      }
    }

    log.info('Schedule recovery complete', {
      data: { totalSources: cronSources.length, recovered, missedExecutions: missed, errors },
    });
  }

  private async updateNextRunAt(sourceId: string, nextRunAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE event_sources
      SET config = json_set(config, '$.nextRunAt', ${nextRunAt}),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
    `);
  }

  // -------------------------------------------------------------------------
  // Execution Recording
  // -------------------------------------------------------------------------

  private async recordExecution(params: {
    eventSourceId: string;
    status: 'executed' | 'skipped_budget' | 'skipped_disabled' | 'error';
    scheduledAt: string;
    taskId?: string;
    subscriptionId?: string;
    budgetWindow?: BudgetWindow;
    windowExecutionCount?: number;
    error?: string;
  }): Promise<boolean> {
    try {
      await this.db.insert(scheduleExecutions).values({
        id: createId(),
        eventSourceId: params.eventSourceId,
        status: params.status,
        scheduledAt: params.scheduledAt,
        executedAt: new Date().toISOString(),
        taskId: params.taskId,
        subscriptionId: params.subscriptionId,
        budgetWindow: params.budgetWindow,
        windowExecutionCount: params.windowExecutionCount ?? 0,
        error: params.error,
      });
      return true;
    } catch (insertError) {
      log.error('Failed to record schedule execution — budget tracking may be inaccurate', {
        data: { eventSourceId: params.eventSourceId, status: params.status },
        error: insertError,
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Error Tracking
  // -------------------------------------------------------------------------

  private async incrementConsecutiveErrors(
    sourceId: string,
    config: CronEventSourceConfig
  ): Promise<void> {
    const newCount = (config.consecutiveErrors ?? 0) + 1;

    await this.db.run(sql`
      UPDATE event_sources
      SET config = json_set(config, '$.consecutiveErrors', ${newCount}),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
    `);

    if (newCount >= SchedulerService.MAX_CONSECUTIVE_ERRORS) {
      log.warn('Source exceeded consecutive error threshold, setting error status', {
        data: { sourceId, consecutiveErrors: newCount },
      });

      await this.db
        .update(eventSources)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(eventSources.id, sourceId));

      publishEventToStream({
        type: 'schedule:paused',
        data: { eventSourceId: sourceId, reason: 'consecutive_errors', errorCount: newCount },
      });
    }
  }

  private async resetConsecutiveErrors(sourceId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE event_sources
      SET config = json_set(config, '$.consecutiveErrors', 0),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
    `);
  }

  // -------------------------------------------------------------------------
  // Execution Count
  // -------------------------------------------------------------------------

  private async getExecutionCount(sourceId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(scheduleExecutions)
      .where(
        and(
          eq(scheduleExecutions.eventSourceId, sourceId),
          eq(scheduleExecutions.status, 'executed')
        )
      );
    return rows[0]?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // Public Methods (for API routes)
  // -------------------------------------------------------------------------

  async triggerManual(sourceId: string): Promise<Result<ManualTriggerResult, AppError>> {
    const sourceResult = await this.eventSourceService.getById(sourceId);
    if (!sourceResult.ok) return sourceResult;

    const source = sourceResult.value;
    if (source.type !== 'cron') {
      return err(ScheduleErrors.NOT_CRON_TYPE(sourceId));
    }
    if (source.status === 'disabled' || source.status === 'error') {
      return err(ScheduleErrors.SOURCE_PAUSED(sourceId));
    }

    const result = await this.processSource(source, 'manual');

    const budgetRemaining = await this.getBudgetRemaining(
      sourceId,
      source.config as unknown as CronEventSourceConfig
    );

    return ok({
      triggered: result.outcome === 'executed',
      executionId: result.executionId,
      taskIds: result.tasksCreated,
      budgetRemaining,
    });
  }

  async pauseSource(
    sourceId: string
  ): Promise<Result<{ id: string; status: string; pausedAt: string }, AppError>> {
    const sourceResult = await this.eventSourceService.getById(sourceId);
    if (!sourceResult.ok) return sourceResult;

    const source = sourceResult.value;
    if (source.type !== 'cron') {
      return err(ScheduleErrors.NOT_CRON_TYPE(sourceId));
    }
    if (source.status !== 'active') {
      return err(ScheduleErrors.ALREADY_PAUSED(sourceId));
    }

    const pausedAt = new Date().toISOString();

    await this.db.run(sql`
      UPDATE event_sources
      SET status = 'disabled',
          config = json_set(config, '$.pausedAt', ${pausedAt}),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
    `);

    publishEventToStream({
      type: 'schedule:paused',
      data: { eventSourceId: sourceId, reason: 'manual', errorCount: 0 },
    });

    return ok({ id: sourceId, status: 'disabled', pausedAt });
  }

  async resumeSource(
    sourceId: string
  ): Promise<
    Result<{ id: string; status: string; nextRunAt: string; resumedAt: string }, AppError>
  > {
    const sourceResult = await this.eventSourceService.getById(sourceId);
    if (!sourceResult.ok) return sourceResult;

    const source = sourceResult.value;
    if (source.type !== 'cron') {
      return err(ScheduleErrors.NOT_CRON_TYPE(sourceId));
    }
    if (source.status === 'active') {
      return err(ScheduleErrors.ALREADY_ACTIVE(sourceId));
    }

    const config = source.config as unknown as CronEventSourceConfig;
    const newNextRunAt = this.calculateNextRunAt({
      ...config,
      lastRunAt: new Date().toISOString(),
    });

    const resumedAt = new Date().toISOString();

    await this.db.run(sql`
      UPDATE event_sources
      SET status = 'active',
          is_enabled = 1,
          config = json_set(
            json_set(
              json_set(config, '$.nextRunAt', ${newNextRunAt}),
              '$.consecutiveErrors', 0
            ),
            '$.pausedAt', null
          ),
          updated_at = datetime('now')
      WHERE id = ${sourceId}
    `);

    publishEventToStream({
      type: 'schedule:resumed',
      data: { eventSourceId: sourceId, nextRunAt: newNextRunAt },
    });

    return ok({ id: sourceId, status: 'active', nextRunAt: newNextRunAt, resumedAt });
  }

  async getBudgetRemaining(
    sourceId: string,
    config: CronEventSourceConfig
  ): Promise<{
    hour: number | null;
    day: number | null;
    week: number | null;
    month: number | null;
  }> {
    const { budget } = config;
    const result = {
      hour: null as number | null,
      day: null as number | null,
      week: null as number | null,
      month: null as number | null,
    };

    if (!budget) return result;

    const hasAnyLimit =
      budget.maxPerHour !== undefined ||
      budget.maxPerDay !== undefined ||
      budget.maxPerWeek !== undefined ||
      budget.maxPerMonth !== undefined;
    if (!hasAnyLimit) return result;

    const counts = await this.queryWindowCounts(sourceId, config.timezone);

    const windows = [
      { key: 'hour' as const, limit: budget.maxPerHour },
      { key: 'day' as const, limit: budget.maxPerDay },
      { key: 'week' as const, limit: budget.maxPerWeek },
      { key: 'month' as const, limit: budget.maxPerMonth },
    ];

    for (const w of windows) {
      if (w.limit === undefined) continue;
      result[w.key] = Math.max(0, w.limit - counts[w.key]);
    }

    return result;
  }

  async getBudgetStatus(
    sourceId: string,
    config: CronEventSourceConfig
  ): Promise<{
    limits: Record<string, { limit: number | null; used: number; remaining: number | null }>;
  }> {
    const { budget } = config;
    const limits: Record<string, { limit: number | null; used: number; remaining: number | null }> =
      {};

    const hasAnyLimit =
      budget?.maxPerHour !== undefined ||
      budget?.maxPerDay !== undefined ||
      budget?.maxPerWeek !== undefined ||
      budget?.maxPerMonth !== undefined;

    const counts = hasAnyLimit
      ? await this.queryWindowCounts(sourceId, config.timezone)
      : { hour: 0, day: 0, week: 0, month: 0 };

    const windows = [
      { key: 'hour' as const, limit: budget?.maxPerHour },
      { key: 'day' as const, limit: budget?.maxPerDay },
      { key: 'week' as const, limit: budget?.maxPerWeek },
      { key: 'month' as const, limit: budget?.maxPerMonth },
    ];

    for (const w of windows) {
      if (w.limit === undefined) {
        limits[w.key] = { limit: null, used: 0, remaining: null };
        continue;
      }

      const used = counts[w.key];
      limits[w.key] = { limit: w.limit, used, remaining: Math.max(0, w.limit - used) };
    }

    return { limits };
  }
}
