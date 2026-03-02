import { createId } from '@paralleldrive/cuid2';
import { CronExpressionParser } from 'cron-parser';
import { and, eq, sql } from 'drizzle-orm';
import type { EventSource } from '../db/schema/index.js';
import { eventSources } from '../db/schema/index.js';
import { scheduleExecutions } from '../db/schema/sqlite/schedule-executions.js';
import type { AppError } from '../lib/errors/base.js';
import { ScheduleErrors } from '../lib/errors/event-errors.js';
import type { PluginRegistry } from '../lib/events/plugin-registry.js';
import type { CronEventSourceConfig, CronTickContext } from '../lib/events/plugins/cron-types.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import { publishEventToStream } from '../server/routes/events.js';
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

interface BudgetCheckResult {
  ok: boolean;
  window?: string;
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
        } else {
          switch (result.value) {
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
  ): Promise<'executed' | 'skipped_budget' | 'skipped_lock' | 'error'> {
    const config = source.config as unknown as CronEventSourceConfig;
    const executionId = createId();

    this.activeExecutions.add(executionId);

    try {
      const newNextRunAt = this.calculateNextRunAt(config);

      // CAS lock for tick-triggered executions
      if (trigger === 'tick') {
        const locked = await this.acquireLock(source.id, config.nextRunAt!, newNextRunAt);
        if (!locked) {
          log.debug('Skipped source (lock contention)', { data: { sourceId: source.id } });
          return 'skipped_lock';
        }
      }

      // Check budget
      const budgetResult = await this.checkBudget(source.id, config);
      if (!budgetResult.ok) {
        await this.recordExecution({
          eventSourceId: source.id,
          status: 'skipped_budget',
          scheduledAt: config.nextRunAt ?? new Date().toISOString(),
          budgetWindow: budgetResult.window as any,
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
        return 'skipped_budget';
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
        return 'error';
      }

      const parseResult = plugin.parseEvent(new Headers(), JSON.stringify(tickContext));
      if (!parseResult.ok) {
        await this.recordExecution({
          eventSourceId: source.id,
          status: 'error',
          scheduledAt: config.nextRunAt ?? new Date().toISOString(),
          error: parseResult.error.message,
        });
        return 'error';
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
        return 'error';
      }

      // Reset consecutive errors on success
      await this.resetConsecutiveErrors(source.id);

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

      return 'executed';
    } catch (err_) {
      log.error('Unexpected error processing source', {
        data: { sourceId: source.id },
        error: err_,
      });
      await this.recordExecution({
        eventSourceId: source.id,
        status: 'error',
        scheduledAt: config.nextRunAt ?? new Date().toISOString(),
        error: String(err_),
      });
      await this.incrementConsecutiveErrors(source.id, config);
      return 'error';
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

    return (result as any).changes > 0;
  }

  // -------------------------------------------------------------------------
  // Budget Enforcement
  // -------------------------------------------------------------------------

  private async checkBudget(
    sourceId: string,
    config: CronEventSourceConfig
  ): Promise<BudgetCheckResult> {
    const { budget } = config;
    if (!budget) return { ok: true };

    const windows: Array<{ name: string; limit: number | undefined; start: string }> = [
      {
        name: 'hour',
        limit: budget.maxPerHour,
        start: this.getWindowStart('hour', config.timezone),
      },
      { name: 'day', limit: budget.maxPerDay, start: this.getWindowStart('day', config.timezone) },
      {
        name: 'week',
        limit: budget.maxPerWeek,
        start: this.getWindowStart('week', config.timezone),
      },
      {
        name: 'month',
        limit: budget.maxPerMonth,
        start: this.getWindowStart('month', config.timezone),
      },
    ];

    for (const window of windows) {
      if (window.limit === undefined) continue;

      const rows = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(scheduleExecutions)
        .where(
          and(
            eq(scheduleExecutions.eventSourceId, sourceId),
            eq(scheduleExecutions.status, 'executed'),
            sql`${scheduleExecutions.executedAt} >= ${window.start}`
          )
        );

      const count = rows[0]?.count ?? 0;

      if (count >= window.limit) {
        return { ok: false, window: window.name, count };
      }
    }

    return { ok: true };
  }

  private getWindowStart(window: 'hour' | 'day' | 'week' | 'month', timezone: string): string {
    const now = new Date();

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
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

    const pad = (n: number) => String(n).padStart(2, '0');

    switch (window) {
      case 'hour': {
        const dt = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00`);
        return this.toTimezoneISO(dt, timezone);
      }
      case 'day': {
        const dt = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00`);
        return this.toTimezoneISO(dt, timezone);
      }
      case 'week': {
        const current = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00`);
        const dayOfWeek = current.getDay();
        const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        current.setDate(current.getDate() - daysToMonday);
        return this.toTimezoneISO(current, timezone);
      }
      case 'month': {
        const dt = new Date(`${year}-${pad(month)}-01T00:00:00`);
        return this.toTimezoneISO(dt, timezone);
      }
    }
  }

  private toTimezoneISO(date: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '+0';
    const match = offsetPart.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
    if (!match) return date.toISOString();
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? 0);
    const offsetMs = sign * (hours * 60 + minutes) * 60_000;
    return new Date(date.getTime() - offsetMs).toISOString();
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
      const interval = CronExpressionParser.parse(config.cronExpression, {
        currentDate: baseTime,
        tz: config.timezone,
      });

      let next = interval.next().toDate();
      while (next <= now) {
        next = interval.next().toDate();
      }
      return next.toISOString();
    }

    return new Date(now.getTime() + 60_000).toISOString();
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async recoverSchedules(): Promise<void> {
    const cronSources = await this.db
      .select()
      .from(eventSources)
      .where(
        and(
          eq(eventSources.type, 'cron'),
          eq(eventSources.status, 'active'),
          eq(eventSources.isEnabled, true)
        )
      );

    let recovered = 0;
    let missed = 0;

    for (const source of cronSources) {
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
    }

    log.info('Schedule recovery complete', {
      data: { totalSources: cronSources.length, recovered, missedExecutions: missed },
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
    budgetWindow?: string;
    windowExecutionCount?: number;
    error?: string;
  }): Promise<void> {
    try {
      await this.db.insert(scheduleExecutions).values({
        id: createId(),
        eventSourceId: params.eventSourceId,
        status: params.status,
        scheduledAt: params.scheduledAt,
        executedAt: new Date().toISOString(),
        taskId: params.taskId,
        subscriptionId: params.subscriptionId,
        budgetWindow: params.budgetWindow as any,
        windowExecutionCount: params.windowExecutionCount ?? 0,
        error: params.error,
      });
    } catch (insertError) {
      log.error('Failed to record execution', { error: insertError });
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
      triggered: result === 'executed',
      executionId: createId(),
      taskIds: [],
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

    const windows = [
      { key: 'hour' as const, limit: budget.maxPerHour },
      { key: 'day' as const, limit: budget.maxPerDay },
      { key: 'week' as const, limit: budget.maxPerWeek },
      { key: 'month' as const, limit: budget.maxPerMonth },
    ];

    for (const w of windows) {
      if (w.limit === undefined) continue;
      const start = this.getWindowStart(w.key, config.timezone);
      const rows = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(scheduleExecutions)
        .where(
          and(
            eq(scheduleExecutions.eventSourceId, sourceId),
            eq(scheduleExecutions.status, 'executed'),
            sql`${scheduleExecutions.executedAt} >= ${start}`
          )
        );
      const used = rows[0]?.count ?? 0;
      result[w.key] = Math.max(0, w.limit - used);
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

    const windows = [
      { key: 'hour', limit: budget?.maxPerHour },
      { key: 'day', limit: budget?.maxPerDay },
      { key: 'week', limit: budget?.maxPerWeek },
      { key: 'month', limit: budget?.maxPerMonth },
    ];

    for (const w of windows) {
      if (w.limit === undefined) {
        limits[w.key] = { limit: null, used: 0, remaining: null };
        continue;
      }

      const start = this.getWindowStart(w.key as any, config.timezone);
      const rows = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(scheduleExecutions)
        .where(
          and(
            eq(scheduleExecutions.eventSourceId, sourceId),
            eq(scheduleExecutions.status, 'executed'),
            sql`${scheduleExecutions.executedAt} >= ${start}`
          )
        );
      const used = rows[0]?.count ?? 0;
      limits[w.key] = { limit: w.limit, used, remaining: Math.max(0, w.limit - used) };
    }

    return { limits };
  }
}
