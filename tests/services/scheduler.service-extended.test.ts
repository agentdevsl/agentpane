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
  createId: vi.fn().mockReturnValue('mock-exec-id-2'),
}));

const mockPublishEventToStream = vi.fn();
vi.mock('../../src/lib/events/event-bus.js', () => ({
  publishEventToStream: (...args: unknown[]) => mockPublishEventToStream(...args),
}));

const _mockCronNext = vi.fn();
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
// Extended SchedulerService Tests
// =============================================================================

describe('SchedulerService — Extended Coverage', () => {
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

    delete process.env.SCHEDULER_ENABLED;
    delete process.env.SCHEDULER_TICK_INTERVAL_MS;
    delete process.env.SCHEDULER_CONCURRENCY_LIMIT;

    mockDb = createMockDb();
    mockPlugin = createMockPlugin();
    mockPluginRegistry = createMockPluginRegistry(mockPlugin);
    mockEventProcessingService = createMockEventProcessingService();
    mockEventSourceService = createMockEventSourceService();

    mockDb._selectChain.where.mockResolvedValue([]);

    service = new SchedulerService(
      mockDb as never,
      mockPluginRegistry as unknown as PluginRegistry,
      mockEventProcessingService as unknown as EventProcessingService,
      mockEventSourceService as unknown as EventSourceService
    );
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // Tick loop — due source processing
  // ===========================================================================

  describe('tick loop processing', () => {
    it('processes due sources returned by tick query', async () => {
      const dueSource = makeEventSource({
        config: makeCronConfig({
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
        }) as unknown as Record<string, unknown>,
      });

      // Recovery returns nothing, tick returns due source
      mockDb._selectChain.where
        .mockResolvedValueOnce([]) // recovery
        .mockResolvedValueOnce([dueSource]) // first tick
        .mockResolvedValue([]); // subsequent

      await service.start();

      // Should have processed the source — plugin parseEvent called
      expect(mockPlugin.parseEvent).toHaveBeenCalled();
      expect(mockEventProcessingService.processScheduledEvent).toHaveBeenCalled();
    });

    it('handles tick query failure gracefully', async () => {
      mockDb._selectChain.where
        .mockResolvedValueOnce([]) // recovery
        .mockRejectedValueOnce(new Error('DB timeout')) // tick query fails
        .mockResolvedValue([]); // subsequent ticks

      // Should not throw
      await service.start();
    });

    it('skips tick when not running', async () => {
      // Start then immediately stop
      await service.start();
      await service.stop();

      const callCount = mockDb.select.mock.calls.length;

      // Advance timers — should not trigger more ticks
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockDb.select.mock.calls.length).toBe(callCount);
    });

    it('processes sources in batches respecting concurrency limit', async () => {
      // Set concurrency to 2
      process.env.SCHEDULER_CONCURRENCY_LIMIT = '2';
      service = new SchedulerService(
        mockDb as never,
        mockPluginRegistry as unknown as PluginRegistry,
        mockEventProcessingService as unknown as EventProcessingService,
        mockEventSourceService as unknown as EventSourceService
      );

      const sources = Array.from({ length: 5 }, (_, i) =>
        makeEventSource({
          id: `source-${i}`,
          config: makeCronConfig({
            nextRunAt: new Date(Date.now() - 1000).toISOString(),
          }) as unknown as Record<string, unknown>,
        })
      );

      mockDb._selectChain.where
        .mockResolvedValueOnce([]) // recovery
        .mockResolvedValueOnce(sources) // first tick
        .mockResolvedValue([]); // subsequent

      await service.start();

      // All 5 sources should be processed eventually
      expect(mockPlugin.parseEvent).toHaveBeenCalledTimes(5);
    });
  });

  // ===========================================================================
  // CAS locking during tick
  // ===========================================================================

  describe('CAS locking', () => {
    it('skips source when CAS lock fails (contention)', async () => {
      const source = makeEventSource({
        config: makeCronConfig({
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
        }) as unknown as Record<string, unknown>,
      });

      mockDb._selectChain.where
        .mockResolvedValueOnce([]) // recovery
        .mockResolvedValueOnce([source]) // tick
        .mockResolvedValue([]);

      // CAS lock fails (another worker took it)
      mockDb.run.mockResolvedValue({ changes: 0 });

      await service.start();

      // Plugin should NOT have been called — source was skipped
      expect(mockPlugin.parseEvent).not.toHaveBeenCalled();
    });

    it('skips source when nextRunAt is null (recovers it)', async () => {
      const source = makeEventSource({
        config: makeCronConfig({
          nextRunAt: null,
        }) as unknown as Record<string, unknown>,
      });

      mockDb._selectChain.where
        .mockResolvedValueOnce([]) // recovery
        .mockResolvedValueOnce([source]) // tick
        .mockResolvedValue([]);

      await service.start();

      // Should have called db.run to update nextRunAt
      expect(mockDb.run).toHaveBeenCalled();
      // Plugin should NOT have been called (skipped_lock)
      expect(mockPlugin.parseEvent).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Error tracking — consecutive errors threshold
  // ===========================================================================

  describe('consecutive errors tracking', () => {
    it('sets source to error status after MAX_CONSECUTIVE_ERRORS', async () => {
      const config = makeCronConfig({
        budget: {},
        consecutiveErrors: 4, // One more error will hit threshold of 5
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockEventProcessingService.processScheduledEvent.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_PROCESSING_FAILED', message: 'Repeated failure', status: 500 },
      });

      await service.triggerManual('source-1');

      // Should publish schedule:paused event
      expect(mockPublishEventToStream).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'schedule:paused',
          data: expect.objectContaining({
            reason: 'consecutive_errors',
            errorCount: 5,
          }),
        })
      );

      // Should update event source status to 'error'
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('does not pause source when under error threshold', async () => {
      const config = makeCronConfig({
        budget: {},
        consecutiveErrors: 2,
      });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      mockEventProcessingService.processScheduledEvent.mockResolvedValue({
        ok: false,
        error: { code: 'EVENT_PROCESSING_FAILED', message: 'Single failure', status: 500 },
      });

      await service.triggerManual('source-1');

      // schedule:paused should NOT have been published (only 3 errors, threshold is 5)
      const pausedCalls = mockPublishEventToStream.mock.calls.filter(
        (c) => c[0].type === 'schedule:paused' && c[0].data?.reason === 'consecutive_errors'
      );
      expect(pausedCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Unexpected errors in processSource
  // ===========================================================================

  describe('unexpected errors in processSource', () => {
    it('catches unexpected errors and records execution', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      // parseEvent throws unexpectedly
      mockPlugin.parseEvent.mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      const result = await service.triggerManual('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggered).toBe(false);
    });

    it('handles recordExecution failure after unexpected error', async () => {
      const config = makeCronConfig({ budget: {} });
      mockEventSourceService.getById.mockResolvedValue({
        ok: true,
        value: makeEventSource({ config: config as unknown as Record<string, unknown> }),
      });

      // Make parseEvent throw
      mockPlugin.parseEvent.mockImplementation(() => {
        throw new Error('Crash');
      });

      // Make insert also fail
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockRejectedValue(new Error('Insert failed')),
      });

      // Should not throw despite double failure
      const result = await service.triggerManual('source-1');
      expect(result.ok).toBe(true);
    });
  });

  // ===========================================================================
  // calculateNextRunAt — cron expression error
  // ===========================================================================

  describe('calculateNextRunAt — edge cases', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('throws for invalid cron expression', () => {
      mockCronParse.mockImplementation(() => {
        throw new Error('Invalid expression');
      });

      const config = makeCronConfig({
        scheduleType: 'cron',
        cronExpression: 'invalid cron',
      });

      expect(() => service.calculateNextRunAt(config)).toThrow('Invalid cron expression');
    });

    it('uses now as base for interval when lastRunAt is null', () => {
      const now = Date.now();
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 60,
        lastRunAt: null,
      });

      const result = service.calculateNextRunAt(config);
      const nextTime = new Date(result).getTime();

      // Should be ~60s from now
      expect(nextTime).toBeGreaterThanOrEqual(now + 59_000);
      expect(nextTime).toBeLessThanOrEqual(now + 61_000);
    });

    it('handles very long intervals correctly', () => {
      const config = makeCronConfig({
        scheduleType: 'interval',
        interval: 86400, // 1 day
        lastRunAt: new Date().toISOString(),
      });

      const result = service.calculateNextRunAt(config);
      const nextTime = new Date(result).getTime();

      expect(nextTime).toBeGreaterThan(Date.now());
      expect(nextTime).toBeLessThanOrEqual(Date.now() + 86400_000 + 1000);
    });
  });

  // ===========================================================================
  // getBudgetStatus — comprehensive
  // ===========================================================================

  describe('getBudgetStatus — comprehensive', () => {
    it('returns all windows with limits and usage', async () => {
      const config = makeCronConfig({
        budget: {
          maxPerHour: 5,
          maxPerDay: 20,
          maxPerWeek: 100,
          maxPerMonth: 300,
        },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 2, countDay: 10, countWeek: 50, countMonth: 150 },
      ]);

      const result = await service.getBudgetStatus('source-1', config);

      expect(result.limits.hour).toEqual({ limit: 5, used: 2, remaining: 3 });
      expect(result.limits.day).toEqual({ limit: 20, used: 10, remaining: 10 });
      expect(result.limits.week).toEqual({ limit: 100, used: 50, remaining: 50 });
      expect(result.limits.month).toEqual({ limit: 300, used: 150, remaining: 150 });
    });

    it('returns 0 remaining when over limit', async () => {
      const config = makeCronConfig({
        budget: { maxPerHour: 3 },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 10, countDay: 10, countWeek: 10, countMonth: 10 },
      ]);

      const result = await service.getBudgetStatus('source-1', config);

      expect(result.limits.hour).toEqual({ limit: 3, used: 10, remaining: 0 });
    });

    it('skips DB query when no budget limits are set', async () => {
      const config = makeCronConfig({ budget: {} });

      const result = await service.getBudgetStatus('source-1', config);

      // All windows should have null limits
      expect(result.limits.hour?.limit).toBeNull();
      expect(result.limits.day?.limit).toBeNull();
    });

    it('handles undefined budget', async () => {
      const config = makeCronConfig({ budget: undefined });

      const result = await service.getBudgetStatus('source-1', config);

      expect(result.limits.hour).toEqual({ limit: null, used: 0, remaining: null });
    });
  });

  // ===========================================================================
  // getBudgetRemaining — comprehensive
  // ===========================================================================

  describe('getBudgetRemaining — edge cases', () => {
    it('returns all nulls when budget is undefined', async () => {
      const config = makeCronConfig({ budget: undefined });

      const result = await service.getBudgetRemaining('source-1', config);

      expect(result).toEqual({ hour: null, day: null, week: null, month: null });
    });

    it('computes remaining for all four windows', async () => {
      const config = makeCronConfig({
        budget: {
          maxPerHour: 10,
          maxPerDay: 50,
          maxPerWeek: 200,
          maxPerMonth: 500,
        },
      });

      mockDb._selectChain.where.mockResolvedValue([
        { countHour: 3, countDay: 20, countWeek: 100, countMonth: 250 },
      ]);

      const result = await service.getBudgetRemaining('source-1', config);

      expect(result.hour).toBe(7);
      expect(result.day).toBe(30);
      expect(result.week).toBe(100);
      expect(result.month).toBe(250);
    });
  });

  // ===========================================================================
  // Recovery — edge cases
  // ===========================================================================

  describe('recovery edge cases', () => {
    it('handles per-source recovery errors without failing entire recovery', async () => {
      const goodConfig = makeCronConfig({
        nextRunAt: null,
      });
      const badConfig = makeCronConfig({
        scheduleType: 'unknown-type' as 'interval',
        nextRunAt: null,
      });

      const sources = [
        makeEventSource({
          id: 'good-source',
          config: goodConfig as unknown as Record<string, unknown>,
        }),
        makeEventSource({
          id: 'bad-source',
          config: badConfig as unknown as Record<string, unknown>,
        }),
      ];

      mockDb._selectChain.where
        .mockResolvedValueOnce(sources) // recovery
        .mockResolvedValue([]); // tick

      // Should not throw despite one source failing to calculate nextRunAt
      await service.start();

      // db.run should have been called at least for the good source
      expect(mockDb.run).toHaveBeenCalled();
    });
  });
});
