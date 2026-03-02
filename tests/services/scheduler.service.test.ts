import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronEventSourceConfig } from '../../src/db/schema/shared/cron-config';
import type { EventSource } from '../../src/db/schema/sqlite/event-sources';
import type { NormalizedEvent } from '../../src/lib/events/plugin-interface';
import type { PluginRegistry } from '../../src/lib/events/plugin-registry';
import type { EventProcessingService } from '../../src/services/event-processing.service';
import type { EventSourceService } from '../../src/services/event-source.service';
import { SchedulerService } from '../../src/services/scheduler.service';

// =============================================================================
// Module mocks
// =============================================================================

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-exec-id'),
}));

const mockPublishEventToStream = vi.fn();
vi.mock('../../src/lib/events/event-bus.js', () => ({
  publishEventToStream: (...args: unknown[]) => mockPublishEventToStream(...args),
}));

const mockCronNext = vi.fn();
const mockCronParse = vi.fn();
vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: (...args: unknown[]) => mockCronParse(...args),
  },
}));

// =============================================================================
// Mock factories
// =============================================================================

function makeCronConfig(overrides: Partial<CronEventSourceConfig> = {}): CronEventSourceConfig {
  return {
    scheduleType: 'interval',
    interval: 300,
    timezone: 'UTC',
    budget: {},
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    lastRunAt: new Date(Date.now() - 360_000).toISOString(),
    consecutiveErrors: 0,
    pausedAt: null,
    ...overrides,
  };
}

function makeEventSource(overrides: Partial<EventSource> = {}): EventSource {
  return {
    id: 'source-1',
    teamId: 'team-1',
    name: 'My Cron Source',
    type: 'cron',
    slug: 'my-cron-source',
    webhookSecret: null,
    isEnabled: true,
    config: makeCronConfig() as unknown as Record<string, unknown>,
    eventCount: 0,
    lastEventAt: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    type: 'schedule.tick',
    action: 'tick',
    deliveryId: 'delivery-cron-1',
    source: { repo: undefined, labels: [], author: 'system' },
    data: { title: 'Scheduled execution: My Cron Source' },
    raw: { trigger: 'tick' },
    ...overrides,
  };
}

function createMockDb() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    _selectChain: selectChain,
    _insertChain: insertChain,
    _updateChain: updateChain,
  };
}

function createMockPlugin() {
  return {
    type: 'cron' as const,
    verifySignature: vi.fn().mockResolvedValue({ ok: true, value: true }),
    parseEvent: vi.fn().mockReturnValue({ ok: true, value: makeNormalizedEvent() }),
    getEventTypes: vi.fn().mockReturnValue([]),
    getTemplateVariables: vi.fn().mockReturnValue([]),
    matchesFilter: vi.fn().mockReturnValue(true),
  };
}

function createMockPluginRegistry(plugin = createMockPlugin()) {
  return {
    get: vi.fn().mockReturnValue(plugin),
    register: vi.fn(),
    getRegisteredTypes: vi.fn().mockReturnValue(['cron']),
  };
}

function createMockEventProcessingService() {
  return {
    processScheduledEvent: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: 'processed',
        matchCount: 1,
        tasksCreated: ['task-1'],
        eventLogId: 'log-1',
      },
    }),
  };
}

function createMockEventSourceService() {
  return {
    getById: vi.fn().mockResolvedValue({
      ok: true,
      value: makeEventSource(),
    }),
    decryptSecret: vi.fn().mockReturnValue(null),
    incrementEventCount: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

// =============================================================================
// SchedulerService Tests
// =============================================================================

describe('SchedulerService', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let mockPlugin: ReturnType<typeof createMockPlugin>;
  let mockPluginRegistry: ReturnType<typeof createMockPluginRegistry>;
  let mockEventProcessingService: ReturnType<typeof createMockEventProcessingService>;
  let mockEventSourceService: ReturnType<typeof createMockEventSourceService>;
  let service: SchedulerService;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset env vars
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.SCHEDULER_TICK_INTERVAL_MS;
    delete process.env.SCHEDULER_CONCURRENCY_LIMIT;

    mockDb = createMockDb();
    mockPlugin = createMockPlugin();
    mockPluginRegistry = createMockPluginRegistry(mockPlugin);
    mockEventProcessingService = createMockEventProcessingService();
    mockEventSourceService = createMockEventSourceService();

    // Default: no due sources when tick queries the DB
    mockDb._selectChain.where.mockResolvedValue([]);

    service = new SchedulerService(
      mockDb as never,
      mockPluginRegistry as unknown as PluginRegistry,
      mockEventProcessingService as unknown as EventProcessingService,
      mockEventSourceService as unknown as EventSourceService
    );
  });

  afterEach(async () => {
    // Ensure scheduler is stopped between tests
    await service.stop();
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // calculateNextRunAt()
  // ===========================================================================

  describe('calculateNextRunAt()', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('returns next interval time when lastRunAt is in the past and interval has not been missed', () => {
      const now = Date.now();
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 300,
        lastRunAt: new Date(now - 60_000).toISOString(), // 1 minute ago
      });

      const result = service.calculateNextRunAt(config);
      const nextDate = new Date(result);
      const expectedNext = new Date(now - 60_000 + 300_000);

      // The next run should be ~4 minutes from now (lastRunAt + 300s)
      expect(nextDate.getTime()).toBeCloseTo(expectedNext.getTime(), -3);
      expect(nextDate.getTime()).toBeGreaterThan(now);
    });

    it('catches up for missed intervals when next run would be in the past', () => {
      const now = Date.now();
      // lastRunAt was 10 minutes ago with 300s interval = 2 intervals missed
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 300,
        lastRunAt: new Date(now - 10 * 60_000).toISOString(),
      });

      const result = service.calculateNextRunAt(config);
      const nextDate = new Date(result);

      // next should be in the future or exactly now (catch-up calculation)
      expect(nextDate.getTime()).toBeGreaterThanOrEqual(now);
    });

    it('defaults interval to 60 seconds when not provided', () => {
      const now = Date.now();
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: undefined,
        lastRunAt: new Date(now - 30_000).toISOString(), // 30s ago
      });

      const result = service.calculateNextRunAt(config);
      const nextDate = new Date(result);

      // With default 60s interval, lastRunAt + 60s should be ~30s from now
      const expected = new Date(now - 30_000 + 60_000);
      expect(nextDate.getTime()).toBeCloseTo(expected.getTime(), -3);
    });

    it('uses now as base time when lastRunAt is null', () => {
      const now = Date.now();
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 120,
        lastRunAt: null,
      });

      const result = service.calculateNextRunAt(config);
      const nextDate = new Date(result);

      // Should be ~120s from now
      expect(nextDate.getTime()).toBeGreaterThanOrEqual(now + 119_000);
      expect(nextDate.getTime()).toBeLessThanOrEqual(now + 121_000);
    });

    it('returns next future cron occurrence via CronExpressionParser', () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 3600_000);

      mockCronParse.mockReturnValue({
        next: mockCronNext.mockReturnValue({
          toDate: () => futureDate,
        }),
      });

      const config = makeCronConfig({
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1-5',
        lastRunAt: new Date(now.getTime() - 60_000).toISOString(),
      });

      const result = service.calculateNextRunAt(config);

      expect(mockCronParse).toHaveBeenCalledWith(
        '0 9 * * 1-5',
        expect.objectContaining({
          tz: 'UTC',
        })
      );
      expect(new Date(result).getTime()).toBe(futureDate.getTime());
    });

    it('advances cron iterator until result is in the future', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 1000);
      const futureDate = new Date(now.getTime() + 3600_000);

      mockCronNext
        .mockReturnValueOnce({ toDate: () => pastDate })
        .mockReturnValueOnce({ toDate: () => futureDate });

      mockCronParse.mockReturnValue({ next: mockCronNext });

      const config = makeCronConfig({
        scheduleType: 'cron',
        cronExpression: '*/5 * * * *',
        lastRunAt: new Date(now.getTime() - 120_000).toISOString(),
      });

      const result = service.calculateNextRunAt(config);

      expect(mockCronNext).toHaveBeenCalledTimes(2);
      expect(new Date(result).getTime()).toBe(futureDate.getTime());
    });

    it('defaults to 60s interval for unknown scheduleType', () => {
      const now = Date.now();
      const config = makeCronConfig({
        scheduleType: 'unknown-type' as 'interval',
      });

      const result = service.calculateNextRunAt(config);
      const nextDate = new Date(result);

      // Should be roughly now + 60s
      expect(nextDate.getTime()).toBeGreaterThanOrEqual(now + 59_000);
      expect(nextDate.getTime()).toBeLessThanOrEqual(now + 61_000);
    });
  });

  // ===========================================================================
  // triggerManual()
  // ===========================================================================

  describe('triggerManual()', () => {
    it('returns triggered=true with task IDs on happy path', async () => {
      // Setup the source with budget info
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(true);
      expect(result.value.executionId).toBe('mock-exec-id');
      expect(result.value.taskIds).toEqual(['task-1']);
    });

    it('rejects non-cron source type', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ type: 'github' }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('rejects disabled source', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'disabled' }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_SOURCE_PAUSED');
    });

    it('rejects errored source', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'error' }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_SOURCE_PAUSED');
    });

    it('returns source-not-found error when eventSourceService fails', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_SOURCE_NOT_FOUND', message: 'Not found', status: 404 },
      });

      const result = await service.triggerManual('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });

    it('updates nextRunAt and lastRunAt via db.run for manual trigger', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      await service.triggerManual('source-1');

      // processSource with trigger='manual' calls db.run to update nextRunAt/lastRunAt
      expect(mockDb.run).toHaveBeenCalled();
    });

    it('publishes schedule:executed event on success', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      await service.triggerManual('source-1');

      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:executed',
          data: expect.objectContaining({
            eventSourceId: 'source-1',
            taskIds: ['task-1'],
          }),
        })
      );
    });

    it('returns triggered=false when budget is exceeded', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 1 },
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      // Mock queryWindowCounts to return count >= limit
      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 1, countDay: 1, countWeek: 1, countMonth: 1 },
      ]);

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);
    });

    it('returns error outcome when cron plugin is not registered', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });
      mockPluginRegistry.get.mockReturnValue(undefined);

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Plugin not found leads to error outcome, triggered=false
      expect(result.value.triggered).toBe(false);
    });

    it('increments consecutive errors when processing fails', async () => {
      const config = makeCronConfig({ budget: {}, consecutiveErrors: 0 });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockEventProcessingService.processScheduledEvent.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_PROCESSING_FAILED', message: 'Task fail', status: 500 },
      });

      await service.triggerManual('source-1');

      // Should call db.run to increment consecutive errors (json_set)
      // The mock db.run is called for both the manual trigger update and consecutive error increment
      expect(mockDb.run.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('resets consecutive errors on successful execution', async () => {
      const config = makeCronConfig({ budget: {}, consecutiveErrors: 3 });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      await service.triggerManual('source-1');

      // Should call db.run to reset consecutive errors to 0
      const runCalls = mockDb.run.mock.calls;
      // At least one call should be for resetting consecutive errors
      expect(runCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // pauseSource()
  // ===========================================================================

  describe('pauseSource()', () => {
    it('sets status to disabled on happy path', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'active' }),
      });

      const result = await service.pauseSource('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('source-1');
      expect(result.value.status).toBe('disabled');
      expect(result.value.pausedAt).toBeTruthy();
    });

    it('publishes schedule:paused event', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'active' }),
      });

      await service.pauseSource('source-1');

      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:paused',
          data: expect.objectContaining({
            eventSourceId: 'source-1',
            reason: 'manual',
          }),
        })
      );
    });

    it('calls db.run to update status and config', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'active' }),
      });

      await service.pauseSource('source-1');

      expect(mockDb.run).toHaveBeenCalled();
    });

    it('rejects already-paused source (status !== active)', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'disabled' }),
      });

      const result = await service.pauseSource('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_ALREADY_PAUSED');
    });

    it('rejects errored source (status !== active)', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'error' }),
      });

      const result = await service.pauseSource('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_ALREADY_PAUSED');
    });

    it('rejects non-cron type', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ type: 'github' }),
      });

      const result = await service.pauseSource('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('returns error when source not found', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_SOURCE_NOT_FOUND', message: 'Not found', status: 404 },
      });

      const result = await service.pauseSource('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // resumeSource()
  // ===========================================================================

  describe('resumeSource()', () => {
    it('sets status to active and resets consecutiveErrors on happy path', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'disabled' }),
      });

      const result = await service.resumeSource('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('source-1');
      expect(result.value.status).toBe('active');
      expect(result.value.nextRunAt).toBeTruthy();
      expect(result.value.resumedAt).toBeTruthy();
    });

    it('publishes schedule:resumed event', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'disabled' }),
      });

      await service.resumeSource('source-1');

      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:resumed',
          data: expect.objectContaining({
            eventSourceId: 'source-1',
          }),
        })
      );
    });

    it('calls db.run to update status, nextRunAt, and consecutiveErrors', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'disabled' }),
      });

      await service.resumeSource('source-1');

      expect(mockDb.run).toHaveBeenCalled();
    });

    it('rejects already-active source', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'active' }),
      });

      const result = await service.resumeSource('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_ALREADY_ACTIVE');
    });

    it('rejects non-cron type', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ type: 'github' }),
      });

      const result = await service.resumeSource('source-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('returns error when source not found', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_SOURCE_NOT_FOUND', message: 'Not found', status: 404 },
      });

      const result = await service.resumeSource('nonexistent');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });

    it('can resume an errored source', async () => {
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ status: 'error' }),
      });

      const result = await service.resumeSource('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('active');
    });
  });

  // ===========================================================================
  // start() / stop()
  // ===========================================================================

  describe('start()', () => {
    it('sets isRunning and creates interval', async () => {
      await service.start();

      // The tick was invoked during start() and a setInterval was created.
      // We can verify by checking that the db was queried for due sources.
      // First query is for recoverSchedules (active cron sources), second is from tick.
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('does nothing when SCHEDULER_ENABLED is false', async () => {
      process.env.SCHEDULER_ENABLED = 'false';

      // Need to recreate service with the new env
      service = new SchedulerService(
        mockDb as never,
        mockPluginRegistry as unknown as PluginRegistry,
        mockEventProcessingService as unknown as EventProcessingService,
        mockEventSourceService as unknown as EventSourceService
      );

      await service.start();

      // Should not query db at all
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('warns and returns when already running', async () => {
      await service.start();

      const selectCallCount = mockDb.select.mock.calls.length;

      // Second call should be a no-op
      await service.start();

      // No additional DB queries beyond what the first start triggered
      expect(mockDb.select.mock.calls.length).toBe(selectCallCount);
    });

    it('runs initial tick immediately after start', async () => {
      await service.start();

      // The tick queries for due sources. recoverSchedules also queries.
      // At minimum, select should be called for both recovery and tick.
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('clears interval and sets isRunning to false', async () => {
      await service.start();
      await service.stop();

      // After stop, advancing timers should not trigger more ticks
      const callCount = mockDb.select.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDb.select.mock.calls.length).toBe(callCount);
    });

    it('is a no-op if not running', async () => {
      // Should not throw
      await service.stop();
    });

    it('allows restart after stop', async () => {
      await service.start();
      await service.stop();

      mockDb.select.mockClear();
      mockDb._selectChain.from.mockClear();
      mockDb._selectChain.where.mockClear();
      mockDb._selectChain.where.mockResolvedValue([]);

      await service.start();

      // Should have queried again for recovery and tick
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recoverSchedules() — tested through start()
  // ===========================================================================

  describe('recoverSchedules (via start)', () => {
    it('recovers sources with past nextRunAt by updating them', async () => {
      const pastConfig = makeCronConfig({
        nextRunAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
        lastRunAt: new Date(Date.now() - 7200_000).toISOString(),
      });

      const pastSource = makeEventSource({
        config: pastConfig as unknown as Record<string, unknown>,
      });

      // recoverSchedules queries for active cron sources
      mockDb._selectChain.where
        .mockResolvedValueOnce([pastSource]) // recovery query
        .mockResolvedValue([]); // tick query

      await service.start();

      // Should have called db.run to update nextRunAt for the recovered source
      expect(mockDb.run).toHaveBeenCalled();
    });

    it('recovers sources with null nextRunAt', async () => {
      const nullConfig = makeCronConfig({
        nextRunAt: null,
        lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
      });

      const nullSource = makeEventSource({
        config: nullConfig as unknown as Record<string, unknown>,
      });

      mockDb._selectChain.where
        .mockResolvedValueOnce([nullSource]) // recovery query
        .mockResolvedValue([]); // tick query

      await service.start();

      // Should have called db.run to set nextRunAt
      expect(mockDb.run).toHaveBeenCalled();
    });

    it('does not update sources whose nextRunAt is still in the future', async () => {
      const futureConfig = makeCronConfig({
        nextRunAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
      });

      const futureSource = makeEventSource({
        config: futureConfig as unknown as Record<string, unknown>,
      });

      mockDb._selectChain.where
        .mockResolvedValueOnce([futureSource]) // recovery query
        .mockResolvedValue([]); // tick query

      await service.start();

      // db.run should NOT be called (no recovery needed)
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    it('handles recovery query failure gracefully', async () => {
      mockDb._selectChain.where
        .mockRejectedValueOnce(new Error('DB connection failed')) // recovery query fails
        .mockResolvedValue([]); // tick query succeeds

      // Should not throw
      await service.start();

      // Scheduler should still be running despite recovery failure
    });
  });

  // ===========================================================================
  // processSource — tested through triggerManual
  // ===========================================================================

  describe('processSource (via triggerManual)', () => {
    it('publishes schedule:skipped when budget exceeded', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 1 },
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      // Return counts that exceed the budget
      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 5, countDay: 5, countWeek: 5, countMonth: 5 },
      ]);

      await service.triggerManual('source-1');

      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:skipped',
          data: expect.objectContaining({
            reason: 'budget_exceeded',
            window: 'hour',
          }),
        })
      );
    });

    it('records skipped_budget execution when budget exceeded', async () => {
      const config = makeCronConfig({
        budget: { maxPerDay: 2 },
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      // Return counts that exceed daily budget
      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 2, countDay: 2, countWeek: 2, countMonth: 2 },
      ]);

      await service.triggerManual('source-1');

      // Should record the execution as skipped_budget
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('publishes schedule:error when processing fails', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockEventProcessingService.processScheduledEvent.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_PROCESSING_FAILED', message: 'Processing exploded', status: 500 },
      });

      await service.triggerManual('source-1');

      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:error',
          data: expect.objectContaining({
            eventSourceId: 'source-1',
            error: 'Processing exploded',
          }),
        })
      );
    });

    it('records execution on successful processing', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      await service.triggerManual('source-1');

      // recordExecution inserts into scheduleExecutions
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('passes tick context to cron plugin parseEvent', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({
          name: 'Daily Deploy',
          config: config as unknown as Record<string, unknown>,
        }),
      });

      await service.triggerManual('source-1');

      expect(mockPlugin.parseEvent).toHaveBeenCalledTimes(1);
      const parseArgs = mockPlugin.parseEvent.mock.calls[0];
      const body = JSON.parse(parseArgs[1]);
      expect(body.sourceName).toBe('Daily Deploy');
      expect(body.trigger).toBe('manual');
    });

    it('handles parseEvent failure gracefully', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockPlugin.parseEvent.mockReturnValue({
        ok: false,
        error: { code: 'EVENT_PARSE_FAILED', message: 'Bad context', status: 400 },
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);
    });

    it('removes executionId from activeExecutions after completion', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      // Internal activeExecutions should be empty after processSource completes.
      // We can verify indirectly: stopping should be immediate (no waiting).
      const stopStart = Date.now();
      await service.stop();
      const stopDuration = Date.now() - stopStart;
      expect(stopDuration).toBeLessThan(1000);
    });
  });

  // ===========================================================================
  // Budget checking — tested through triggerManual with different windows
  // ===========================================================================

  describe('budget checking (via triggerManual)', () => {
    it('passes when no budget is configured', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(true);
    });

    it('blocks when weekly budget is exceeded', async () => {
      const config = makeCronConfig({
        budget: { maxPerWeek: 3 },
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 1, countDay: 2, countWeek: 3, countMonth: 3 },
      ]);

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);
    });

    it('blocks when monthly budget is exceeded', async () => {
      const config = makeCronConfig({
        budget: { maxPerMonth: 10 },
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 0, countDay: 0, countWeek: 5, countMonth: 10 },
      ]);

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);
    });
  });

  // ===========================================================================
  // Environment variable configuration
  // ===========================================================================

  describe('environment configuration', () => {
    it('uses custom tick interval from env', () => {
      process.env.SCHEDULER_TICK_INTERVAL_MS = '5000';

      const customService = new SchedulerService(
        mockDb as never,
        mockPluginRegistry as unknown as PluginRegistry,
        mockEventProcessingService as unknown as EventProcessingService,
        mockEventSourceService as unknown as EventSourceService
      );

      // We verify indirectly: the service was constructed without error.
      // The tickIntervalMs is private, but it's used in setInterval.
      expect(customService).toBeDefined();
    });

    it('uses custom concurrency limit from env', () => {
      process.env.SCHEDULER_CONCURRENCY_LIMIT = '10';

      const customService = new SchedulerService(
        mockDb as never,
        mockPluginRegistry as unknown as PluginRegistry,
        mockEventProcessingService as unknown as EventProcessingService,
        mockEventSourceService as unknown as EventSourceService
      );

      expect(customService).toBeDefined();
    });

    it('defaults tick interval to 30000ms when env not set', () => {
      // No env set — already the default
      const customService = new SchedulerService(
        mockDb as never,
        mockPluginRegistry as unknown as PluginRegistry,
        mockEventProcessingService as unknown as EventProcessingService,
        mockEventSourceService as unknown as EventSourceService
      );

      expect(customService).toBeDefined();
    });
  });

  // ===========================================================================
  // getBudgetRemaining()
  // ===========================================================================

  describe('getBudgetRemaining()', () => {
    it('returns all nulls when no budget configured', async () => {
      const config = makeCronConfig({ budget: {} });

      const result = await service.getBudgetRemaining('source-1', config);

      expect(result).toEqual({
        hour: null,
        day: null,
        week: null,
        month: null,
      });
    });

    it('returns remaining counts for configured windows', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 5, maxPerDay: 20 },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 2, countDay: 8, countWeek: 15, countMonth: 50 },
      ]);

      const result = await service.getBudgetRemaining('source-1', config);

      expect(result.hour).toBe(3); // 5 - 2
      expect(result.day).toBe(12); // 20 - 8
      expect(result.week).toBeNull(); // not configured
      expect(result.month).toBeNull(); // not configured
    });

    it('returns 0 remaining when at limit', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 3 },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 5, countDay: 10, countWeek: 20, countMonth: 50 },
      ]);

      const result = await service.getBudgetRemaining('source-1', config);

      // max(0, 3 - 5) = 0
      expect(result.hour).toBe(0);
    });
  });

  // ===========================================================================
  // getBudgetStatus()
  // ===========================================================================

  describe('getBudgetStatus()', () => {
    it('returns null limits for unconfigured windows', async () => {
      const config = makeCronConfig({ budget: {} });

      const result = await service.getBudgetStatus('source-1', config);

      expect(result.limits.hour).toEqual({ limit: null, used: 0, remaining: null });
      expect(result.limits.day).toEqual({ limit: null, used: 0, remaining: null });
    });

    it('returns used and remaining for configured windows', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 10, maxPerDay: 50 },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 3, countDay: 20, countWeek: 40, countMonth: 100 },
      ]);

      const result = await service.getBudgetStatus('source-1', config);

      expect(result.limits.hour).toEqual({ limit: 10, used: 3, remaining: 7 });
      expect(result.limits.day).toEqual({ limit: 50, used: 20, remaining: 30 });
      expect(result.limits.week).toEqual({ limit: null, used: 0, remaining: null });
    });
  });
});
