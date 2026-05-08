/**
 * Functional Bug-Proving Tests for SchedulerService
 *
 * Each test exercises REAL SchedulerService code against an in-memory SQLite
 * database. EventProcessingService is replaced with a thin in-test stub
 * (its surface is the integration boundary), and EventSourceService is real.
 *
 * Focus areas:
 *   - pauseSource / resumeSource (state transitions, error paths)
 *   - getBudgetStatus / getBudgetRemaining (zero, partial, none)
 *   - Recovery loop on start: nextRunAt absent OR in the past
 *   - Manual trigger error / NOT_CRON_TYPE / SOURCE_PAUSED guards
 *   - Consecutive-error increment + auto-pause threshold
 *   - calculateNextRunAt for both 'cron' and 'interval'
 *   - getWindowStart timezone fallback (invalid tz → UTC)
 *   - healthSnapshot reflects last tick / lastError
 *
 * Run: npx vitest run --project functional tests/functional/prove-scheduler-bugs.test.ts
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventSources, teams } from '../../src/db/schema';
import type { CronEventSourceConfig } from '../../src/db/schema/shared/cron-config';
import { scheduleExecutions } from '../../src/db/schema/sqlite/schedule-executions';
import { PluginRegistry } from '../../src/lib/events/plugin-registry';
import { CronEventSourcePlugin } from '../../src/lib/events/plugins/cron-plugin';
import { EventSourceService } from '../../src/services/event-source.service';
import { SchedulerService } from '../../src/services/scheduler.service';
import { createTestEventSource } from '../factories/event-source.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

function makeCronConfig(overrides: Partial<CronEventSourceConfig> = {}): CronEventSourceConfig {
  return {
    scheduleType: 'cron',
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    budget: {},
    nextRunAt: new Date(Date.now() + 600_000).toISOString(),
    lastRunAt: null,
    consecutiveErrors: 0,
    pausedAt: null,
    ...overrides,
  };
}

function ensureScheduleExecutionsTable() {
  try {
    execRawSql(`
      CREATE TABLE IF NOT EXISTS schedule_executions (
        id TEXT PRIMARY KEY,
        event_source_id TEXT NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        task_id TEXT,
        subscription_id TEXT,
        budget_window TEXT,
        window_execution_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS schedule_executions_event_source_idx ON schedule_executions(event_source_id);
      CREATE INDEX IF NOT EXISTS schedule_executions_source_status_idx ON schedule_executions(event_source_id, status);
      CREATE INDEX IF NOT EXISTS schedule_executions_source_executed_at_idx ON schedule_executions(event_source_id, executed_at);
      CREATE INDEX IF NOT EXISTS schedule_executions_source_scheduled_at_idx ON schedule_executions(event_source_id, scheduled_at);
    `);
  } catch {
    // already exists
  }
}

function buildProcessingService(override?: () => Promise<unknown>): {
  processScheduledEvent: ReturnType<typeof vi.fn>;
  processIncomingEvent: ReturnType<typeof vi.fn>;
} {
  return {
    processScheduledEvent: vi.fn(
      override ??
        (async () => ({
          ok: true,
          value: {
            eventSourceId: '',
            eventLogId: createId(),
            status: 'processed',
            matchCount: 1,
            tasksCreated: [createId()],
          },
        }))
    ),
    processIncomingEvent: vi.fn(),
  };
}

describe('Bug-Proving Tests: SchedulerService', () => {
  let db: ReturnType<typeof getTestDb>;
  let teamId: string;
  let pluginRegistry: PluginRegistry;
  let eventSourceService: EventSourceService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    ensureScheduleExecutionsTable();

    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Sched Team',
      slug: `sched-${teamId.slice(0, 6)}`,
    });

    pluginRegistry = new PluginRegistry();
    pluginRegistry.register('cron', new CronEventSourcePlugin());
    eventSourceService = new EventSourceService(db);
  });

  afterEach(async () => {
    try {
      execRawSql('DELETE FROM schedule_executions');
    } catch {
      /* ignore */
    }
    await clearTestDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════
  // calculateNextRunAt - both cron and interval
  // ═══════════════════════════════════════════════════════════════════
  describe('calculateNextRunAt()', () => {
    it('interval schedule advances by N seconds', () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const config: CronEventSourceConfig = {
        scheduleType: 'interval',
        interval: 300,
        timezone: 'UTC',
        budget: {},
        nextRunAt: null,
        lastRunAt: new Date().toISOString(),
      };

      const result = sched.calculateNextRunAt(config);
      const nextMs = Date.parse(result);
      expect(Number.isFinite(nextMs)).toBe(true);
      expect(nextMs).toBeGreaterThan(Date.now());
    });

    it('interval skips missed intervals when lastRunAt is far in the past', () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const config: CronEventSourceConfig = {
        scheduleType: 'interval',
        interval: 60,
        timezone: 'UTC',
        budget: {},
        nextRunAt: null,
        lastRunAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      };

      const result = sched.calculateNextRunAt(config);
      // The next run must be in the future
      expect(Date.parse(result)).toBeGreaterThanOrEqual(Date.now() - 1000);
    });

    it('cron schedule yields a valid future ISO timestamp', () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);
      const result = sched.calculateNextRunAt(makeCronConfig({ cronExpression: '0 * * * *' }));
      expect(Date.parse(result)).toBeGreaterThan(Date.now() - 1000);
    });

    it('cron schedule throws SCHEDULE_INVALID_CRON for malformed expression', () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);
      expect(() =>
        sched.calculateNextRunAt(makeCronConfig({ cronExpression: 'not-a-cron-expr' }))
      ).toThrow(/INVALID_CRON|cron/i);
    });

    it('throws on unsupported schedule type', () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);
      expect(() =>
        sched.calculateNextRunAt({
          scheduleType: 'mystery' as never,
          timezone: 'UTC',
          budget: {},
          nextRunAt: null,
          lastRunAt: null,
        })
      ).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // pauseSource() / resumeSource()
  // ═══════════════════════════════════════════════════════════════════
  describe('pauseSource() / resumeSource()', () => {
    it('pause flips status=disabled and stamps pausedAt; resume re-enables and computes nextRunAt', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig() as never,
      });

      const pauseRes = await sched.pauseSource(source.id);
      expect(pauseRes.ok).toBe(true);
      if (!pauseRes.ok) return;
      expect(pauseRes.value.status).toBe('disabled');
      expect(pauseRes.value.pausedAt).toBeTruthy();

      const after = await db.query.eventSources.findFirst({
        where: eq(eventSources.id, source.id),
      });
      expect(after?.status).toBe('disabled');

      const resumeRes = await sched.resumeSource(source.id);
      expect(resumeRes.ok).toBe(true);
      if (!resumeRes.ok) return;
      expect(resumeRes.value.status).toBe('active');
      expect(Date.parse(resumeRes.value.nextRunAt)).toBeGreaterThan(Date.now() - 1000);
    });

    it('pause on a non-cron source returns NOT_CRON_TYPE', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'github',
        status: 'active',
        isEnabled: true,
      });
      const result = await sched.pauseSource(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('pause on already-disabled source returns ALREADY_PAUSED', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'disabled',
        isEnabled: false,
        config: makeCronConfig() as never,
      });
      const result = await sched.pauseSource(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_ALREADY_PAUSED');
    });

    it('resume on already-active source returns ALREADY_ACTIVE', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig() as never,
      });
      const result = await sched.resumeSource(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_ALREADY_ACTIVE');
    });

    it('resume on non-cron source returns NOT_CRON_TYPE', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);
      const source = await createTestEventSource({
        teamId,
        type: 'github',
        status: 'disabled',
        isEnabled: false,
      });
      const result = await sched.resumeSource(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('pause/resume on missing source bubbles up not-found', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const r1 = await sched.pauseSource('does-not-exist');
      expect(r1.ok).toBe(false);
      const r2 = await sched.resumeSource('does-not-exist');
      expect(r2.ok).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // triggerManual
  // ═══════════════════════════════════════════════════════════════════
  describe('triggerManual()', () => {
    it('returns NOT_CRON_TYPE for non-cron source', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'github',
        status: 'active',
        isEnabled: true,
      });
      const result = await sched.triggerManual(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('returns SOURCE_PAUSED for disabled source', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'disabled',
        isEnabled: false,
        config: makeCronConfig() as never,
      });
      const result = await sched.triggerManual(source.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_SOURCE_PAUSED');
    });

    it('successful trigger reports tasksCreated and budgetRemaining', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({
          budget: { maxPerHour: 10 },
        }) as never,
      });

      const result = await sched.triggerManual(source.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(true);
      expect(result.value.taskIds.length).toBeGreaterThan(0);
      expect(result.value.budgetRemaining.hour).not.toBeNull();
    });

    it('records error execution when processScheduledEvent returns err', async () => {
      const proc = buildProcessingService(async () => ({
        ok: false,
        error: { code: 'EVENT_PROCESS_FAILED', message: 'simulated' },
      }));
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig() as never,
      });

      const result = await sched.triggerManual(source.id);
      expect(result.ok).toBe(true); // triggerManual always returns ok wrapper
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);

      // Execution row should be 'error'
      const rows = await db
        .select()
        .from(scheduleExecutions)
        .where(eq(scheduleExecutions.eventSourceId, source.id));
      expect(rows.some((r) => r.status === 'error')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getBudgetStatus / getBudgetRemaining
  // ═══════════════════════════════════════════════════════════════════
  describe('getBudgetStatus() / getBudgetRemaining()', () => {
    it('returns nulls when no budget configured', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const config = makeCronConfig({ budget: {} });
      const remaining = await sched.getBudgetRemaining('any', config);
      expect(remaining.hour).toBeNull();
      expect(remaining.day).toBeNull();
      expect(remaining.week).toBeNull();
      expect(remaining.month).toBeNull();

      const status = await sched.getBudgetStatus('any', config);
      // No limits → all four limits are null
      for (const key of ['hour', 'day', 'week', 'month'] as const) {
        expect(status.limits[key].limit).toBeNull();
        expect(status.limits[key].remaining).toBeNull();
      }
    });

    it('returns remaining for configured windows', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({
          budget: { maxPerHour: 5, maxPerDay: 50 },
        }) as never,
      });
      const config = source.config as unknown as CronEventSourceConfig;
      const remaining = await sched.getBudgetRemaining(source.id, config);
      expect(remaining.hour).toBe(5);
      expect(remaining.day).toBe(50);
      // Unlimited windows stay null
      expect(remaining.week).toBeNull();
      expect(remaining.month).toBeNull();
    });

    it('getBudgetStatus combines limit/used/remaining for configured windows', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({ budget: { maxPerHour: 10 } }) as never,
      });
      const config = source.config as unknown as CronEventSourceConfig;
      const status = await sched.getBudgetStatus(source.id, config);
      expect(status.limits.hour.limit).toBe(10);
      expect(status.limits.hour.used).toBe(0);
      expect(status.limits.hour.remaining).toBe(10);
      expect(status.limits.day.limit).toBeNull();
    });

    it('falls back to UTC for invalid IANA timezone (getWindowStart try/catch)', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({
          timezone: 'Invalid/Zone',
          budget: { maxPerHour: 1 },
        }) as never,
      });

      // Calling getBudgetStatus exercises queryWindowCounts → getWindowStart;
      // an invalid tz must NOT throw — it should fall back to UTC and succeed.
      const config = source.config as unknown as CronEventSourceConfig;
      const status = await sched.getBudgetStatus(source.id, config);
      expect(status.limits.hour.limit).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // start() / stop() / healthSnapshot
  // ═══════════════════════════════════════════════════════════════════
  describe('start() / stop() / healthSnapshot()', () => {
    it('healthSnapshot reflects running flag and lastRunAt after a tick', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      // Pre-create a due cron source so the tick has something to do
      await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({
          nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        }) as never,
      });

      await sched.start();
      const snap = sched.healthSnapshot();
      expect(snap.name).toBe('scheduler');
      expect(snap.running).toBe(true);
      expect(snap.lastRunAt).toBeTruthy();

      await sched.stop();
      const after = sched.healthSnapshot();
      expect(after.running).toBe(false);
    });

    it('start() honours SCHEDULER_ENABLED=false (no tick interval, no recovery)', async () => {
      const original = process.env.SCHEDULER_ENABLED;
      process.env.SCHEDULER_ENABLED = 'false';
      try {
        const proc = buildProcessingService();
        const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);
        await sched.start();
        const snap = sched.healthSnapshot();
        // Disabled scheduler never marks itself running
        expect(snap.running).toBe(false);
      } finally {
        if (original === undefined) delete process.env.SCHEDULER_ENABLED;
        else process.env.SCHEDULER_ENABLED = original;
      }
    });

    it('start() recovers sources whose nextRunAt is null or in the past', async () => {
      const proc = buildProcessingService();
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      // Source A: nextRunAt absent → recovery sets it
      const sourceA = await createTestEventSource({
        teamId,
        name: 'A',
        slug: `s-a-${createId().slice(0, 6)}`,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({ nextRunAt: null }) as never,
      });

      // Source B: nextRunAt in the past → recovery advances
      const sourceB = await createTestEventSource({
        teamId,
        name: 'B',
        slug: `s-b-${createId().slice(0, 6)}`,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({
          nextRunAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }) as never,
      });

      await sched.start();
      try {
        const a = await db.query.eventSources.findFirst({
          where: eq(eventSources.id, sourceA.id),
        });
        const aConfig = a?.config as unknown as CronEventSourceConfig;
        expect(aConfig.nextRunAt).toBeTruthy();
        expect(Date.parse(aConfig.nextRunAt!)).toBeGreaterThan(Date.now() - 1000);

        const b = await db.query.eventSources.findFirst({
          where: eq(eventSources.id, sourceB.id),
        });
        const bConfig = b?.config as unknown as CronEventSourceConfig;
        expect(Date.parse(bConfig.nextRunAt!)).toBeGreaterThan(Date.now() - 1000);
      } finally {
        await sched.stop();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Auto-pause on consecutive errors
  // ═══════════════════════════════════════════════════════════════════
  describe('consecutive errors → auto-pause', () => {
    it('after MAX_CONSECUTIVE_ERRORS failures, source flips to status=error', async () => {
      const proc = buildProcessingService(async () => ({
        ok: false,
        error: { code: 'X', message: 'always fails' },
      }));
      const sched = new SchedulerService(db, pluginRegistry, proc as never, eventSourceService);

      const source = await createTestEventSource({
        teamId,
        type: 'cron',
        status: 'active',
        isEnabled: true,
        config: makeCronConfig({ consecutiveErrors: 4 }) as never, // one shy of threshold
      });

      // Fire one failing manual trigger — bumps consecutiveErrors to 5
      await sched.triggerManual(source.id);

      const after = await db.query.eventSources.findFirst({
        where: eq(eventSources.id, source.id),
      });
      expect(after?.status).toBe('error');
      const cfg = after?.config as unknown as CronEventSourceConfig;
      expect(cfg.consecutiveErrors).toBe(5);
    });
  });
});
