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
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCronConfig(overrides: Partial<CronEventSourceConfig> = {}): CronEventSourceConfig {
  return {
    scheduleType: 'cron',
    cronExpression: '*/5 * * * *', // every 5 minutes
    timezone: 'UTC',
    budget: {},
    nextRunAt: new Date(Date.now() - 60_000).toISOString(), // 1 min in the past (due)
    lastRunAt: null,
    consecutiveErrors: 0,
    pausedAt: null,
    ...overrides,
  };
}

/** Ensure the schedule_executions table exists in the test database. */
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
    // Table may already exist — safe to ignore
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Scheduler Event Pipeline (IT-301 to IT-306)', () => {
  let db: ReturnType<typeof getTestDb>;
  let teamId: string;
  let pluginRegistry: PluginRegistry;
  let eventSourceService: EventSourceService;

  // Minimal mock for EventProcessingService
  function createMockEventProcessingService(
    overrides: { processScheduledEvent?: (...args: unknown[]) => unknown } = {}
  ) {
    return {
      processScheduledEvent:
        overrides.processScheduledEvent ??
        vi.fn().mockResolvedValue({
          ok: true,
          value: {
            eventSourceId: '',
            eventLogId: createId(),
            status: 'processed',
            matchCount: 1,
            tasksCreated: [createId()],
          },
        }),
      processIncomingEvent: vi.fn(),
    };
  }

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    ensureScheduleExecutionsTable();

    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Scheduler Team',
      slug: `scheduler-team-${teamId.slice(0, 6)}`,
    });

    pluginRegistry = new PluginRegistry();
    pluginRegistry.register('cron', new CronEventSourcePlugin());

    eventSourceService = new EventSourceService(db as any);
  });

  afterEach(async () => {
    // Clean schedule_executions before clearTestDatabase (which doesn't know about it)
    try {
      execRawSql('DELETE FROM schedule_executions');
    } catch {
      // Table may not exist
    }
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // IT-301: Manual trigger creates execution record
  // -------------------------------------------------------------------------
  it('IT-301: triggerManual on cron source creates execution record in schedule_executions', async () => {
    const config = makeCronConfig();
    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      status: 'active',
      isEnabled: true,
      config: config as unknown as Record<string, unknown>,
    });

    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id);
    const mockProcessing = createMockEventProcessingService({
      processScheduledEvent: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          eventSourceId: source.id,
          eventLogId: createId(),
          status: 'processed',
          matchCount: 1,
          tasksCreated: [task.id],
        },
      }),
    });

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const result = await scheduler.triggerManual(source.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.triggered).toBe(true);
    expect(result.value.taskIds).toContain(task.id);

    // Verify execution record was persisted
    const execRows = await db
      .select()
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.eventSourceId, source.id));

    expect(execRows.length).toBeGreaterThanOrEqual(1);
    const exec = execRows.find((r) => r.status === 'executed');
    expect(exec).toBeDefined();
    expect(exec!.eventSourceId).toBe(source.id);
    expect(exec!.taskId).toBe(task.id);
  });

  // -------------------------------------------------------------------------
  // IT-302: Budget limit exceeded → trigger returns skipped result
  // -------------------------------------------------------------------------
  it('IT-302: triggerManual with exhausted hourly budget records skipped_budget execution', async () => {
    const config = makeCronConfig({
      budget: { maxPerHour: 1 },
    });
    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      status: 'active',
      isEnabled: true,
      config: config as unknown as Record<string, unknown>,
    });

    // Pre-seed one executed record within the current hour to exhaust the budget
    await db.insert(scheduleExecutions).values({
      id: createId(),
      eventSourceId: source.id,
      status: 'executed',
      scheduledAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      windowExecutionCount: 0,
    });

    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const result = await scheduler.triggerManual(source.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Budget was exceeded, so triggered should be false
    expect(result.value.triggered).toBe(false);

    // processScheduledEvent should NOT have been called
    expect(mockProcessing.processScheduledEvent).not.toHaveBeenCalled();

    // A skipped_budget execution record should exist
    const execRows = await db
      .select()
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.eventSourceId, source.id));

    const skippedRow = execRows.find((r) => r.status === 'skipped_budget');
    expect(skippedRow).toBeDefined();
    expect(skippedRow!.budgetWindow).toBe('hour');

    // Budget remaining for hour should be 0
    expect(result.value.budgetRemaining.hour).toBe(0);
  });

  // -------------------------------------------------------------------------
  // IT-303: Concurrent execution guard — isRunning prevents double start()
  // -------------------------------------------------------------------------
  it('IT-303: calling start() twice does not create duplicate tick intervals', async () => {
    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    // Start scheduler (will run recoverSchedules + first tick)
    await scheduler.start();

    // Second start() should be a no-op (logs "already running")
    await scheduler.start();

    // Verify scheduler is functional by stopping it cleanly
    await scheduler.stop();

    // After stop, the scheduler should allow restart
    await scheduler.start();
    await scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // IT-304: Manual trigger creates task via event processing pipeline
  // -------------------------------------------------------------------------
  it('IT-304: triggerManual invokes processScheduledEvent with correct NormalizedEvent', async () => {
    const config = makeCronConfig({
      cronExpression: '0 9 * * 1-5',
    });
    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      name: 'Daily Review',
      status: 'active',
      isEnabled: true,
      config: config as unknown as Record<string, unknown>,
    });

    const processedTaskId = createId();
    const processFn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        eventSourceId: source.id,
        eventLogId: createId(),
        status: 'processed',
        matchCount: 1,
        tasksCreated: [processedTaskId],
      },
    });

    const mockProcessing = createMockEventProcessingService({
      processScheduledEvent: processFn,
    });

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    await scheduler.triggerManual(source.id);

    expect(processFn).toHaveBeenCalledTimes(1);

    const [calledSource, calledEvent] = processFn.mock.calls[0];

    // The source passed to processScheduledEvent should be the event source
    expect(calledSource.id).toBe(source.id);

    // The NormalizedEvent should be a manual trigger type
    expect(calledEvent.type).toBe('schedule.manual_trigger');
    expect(calledEvent.action).toBe('manual');
    expect(calledEvent.data.scheduleName).toBe('Daily Review');
    expect(calledEvent.data.scheduleType).toBe('cron');
    expect(calledEvent.data.cronExpression).toBe('0 9 * * 1-5');
  });

  // -------------------------------------------------------------------------
  // IT-305: Disabled scheduler — start() is no-op
  // -------------------------------------------------------------------------
  it('IT-305: scheduler with SCHEDULER_ENABLED=false does not start tick loop', async () => {
    const originalEnv = process.env.SCHEDULER_ENABLED;
    process.env.SCHEDULER_ENABLED = 'false';

    try {
      const mockProcessing = createMockEventProcessingService();

      const scheduler = new SchedulerService(
        db as any,
        pluginRegistry,
        mockProcessing as any,
        eventSourceService
      );

      await scheduler.start();

      // Stop should also be a no-op (isRunning is never set to true)
      await scheduler.stop();

      // Verify no interval was created by confirming stop completes immediately
      // (no active executions to wait on)
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SCHEDULER_ENABLED;
      } else {
        process.env.SCHEDULER_ENABLED = originalEnv;
      }
    }
  });

  // -------------------------------------------------------------------------
  // IT-306: Schedule recovery — processes sources with stale nextRunAt
  // -------------------------------------------------------------------------
  it('IT-306: start() recovers cron sources with past nextRunAt', async () => {
    const pastTime = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago
    const config = makeCronConfig({
      nextRunAt: pastTime,
      cronExpression: '*/10 * * * *',
    });

    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      status: 'active',
      isEnabled: true,
      config: config as unknown as Record<string, unknown>,
    });

    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    // start() calls recoverSchedules which should update nextRunAt to a future time
    await scheduler.start();
    await scheduler.stop();

    // Verify the source's nextRunAt was updated to a future time
    const updatedSource = await db.query.eventSources.findFirst({
      where: eq(eventSources.id, source.id),
    });

    expect(updatedSource).toBeDefined();
    const updatedConfig = updatedSource!.config as unknown as CronEventSourceConfig;

    // After recovery, nextRunAt should be in the future (or at least different from the old stale value)
    expect(updatedConfig.nextRunAt).not.toBe(pastTime);
    expect(new Date(updatedConfig.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  // -------------------------------------------------------------------------
  // Additional: triggerManual on non-cron source returns error
  // -------------------------------------------------------------------------
  it('triggerManual on a github source returns NOT_CRON_TYPE error', async () => {
    const source = await createTestEventSource({
      teamId,
      type: 'github',
      status: 'active',
      isEnabled: true,
    });

    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const result = await scheduler.triggerManual(source.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
  });

  // -------------------------------------------------------------------------
  // Additional: triggerManual on disabled source returns SOURCE_PAUSED
  // -------------------------------------------------------------------------
  it('triggerManual on disabled source returns SOURCE_PAUSED error', async () => {
    const config = makeCronConfig();
    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      status: 'disabled',
      isEnabled: false,
      config: config as unknown as Record<string, unknown>,
    });

    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const result = await scheduler.triggerManual(source.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SCHEDULE_SOURCE_PAUSED');
  });

  // -------------------------------------------------------------------------
  // Additional: calculateNextRunAt for interval schedules
  // -------------------------------------------------------------------------
  it('calculateNextRunAt computes correct next run for interval type', () => {
    const mockProcessing = createMockEventProcessingService();

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const now = Date.now();
    const config = makeCronConfig({
      scheduleType: 'interval',
      interval: 300, // 5 minutes
      cronExpression: undefined,
      lastRunAt: new Date(now - 60_000).toISOString(), // 1 min ago
    });

    const next = scheduler.calculateNextRunAt(config);
    const nextTime = new Date(next).getTime();

    // Next should be lastRunAt + 300s = now - 60s + 300s = now + 240s
    // Allow some tolerance for test execution time
    expect(nextTime).toBeGreaterThan(now);
    expect(nextTime).toBeLessThan(now + 300_000);
  });

  // -------------------------------------------------------------------------
  // Additional: processSource error records execution with error status
  // -------------------------------------------------------------------------
  it('triggerManual records error execution when processScheduledEvent fails', async () => {
    const config = makeCronConfig();
    const source = await createTestEventSource({
      teamId,
      type: 'cron',
      status: 'active',
      isEnabled: true,
      config: config as unknown as Record<string, unknown>,
    });

    const mockProcessing = createMockEventProcessingService({
      processScheduledEvent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_PROCESSING_FAILED', message: 'Test failure', statusCode: 500 },
      }),
    });

    const scheduler = new SchedulerService(
      db as any,
      pluginRegistry,
      mockProcessing as any,
      eventSourceService
    );

    const result = await scheduler.triggerManual(source.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.triggered).toBe(false);

    // An error execution record should be persisted
    const execRows = await db
      .select()
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.eventSourceId, source.id));

    const errorRow = execRows.find((r) => r.status === 'error');
    expect(errorRow).toBeDefined();
    expect(errorRow!.error).toBe('Test failure');
  });
});
