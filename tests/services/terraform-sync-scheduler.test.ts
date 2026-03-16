import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNextSyncAt,
  getTerraformSchedulerState,
  MIN_SYNC_INTERVAL_MINUTES,
  startTerraformSyncScheduler,
  stopTerraformSyncScheduler,
} from '../../src/services/terraform-sync-scheduler';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockDb(registries: any[] = []) {
  return {
    query: {
      terraformRegistries: {
        findMany: vi.fn().mockResolvedValue(registries),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  } as any;
}

function createMockRegistryService(syncResult?: any) {
  return {
    sync: vi.fn().mockResolvedValue(
      syncResult ?? {
        ok: true,
        value: { registryId: 'reg-1', moduleCount: 5, syncedAt: new Date().toISOString() },
      }
    ),
  } as any;
}

function makeRegistry(overrides: Record<string, any> = {}) {
  return {
    id: 'reg-1',
    name: 'Test Registry',
    status: 'active',
    syncIntervalMinutes: 15,
    nextSyncAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('terraform-sync-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopTerraformSyncScheduler();
    vi.useRealTimers();
  });

  // ===========================================================================
  // calculateNextSyncAt()
  // ===========================================================================

  describe('calculateNextSyncAt()', () => {
    it('returns ISO string N minutes in the future', () => {
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const result = calculateNextSyncAt(15);
      expect(result).toBe('2025-01-01T00:15:00.000Z');
    });

    it('returns current time for 0 minutes', () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
      const result = calculateNextSyncAt(0);
      expect(result).toBe('2025-06-15T12:00:00.000Z');
    });

    it('handles large intervals (24 hours = 1440 minutes)', () => {
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const result = calculateNextSyncAt(1440);
      expect(result).toBe('2025-01-02T00:00:00.000Z');
    });
  });

  // ===========================================================================
  // MIN_SYNC_INTERVAL_MINUTES export
  // ===========================================================================

  describe('MIN_SYNC_INTERVAL_MINUTES', () => {
    it('is exported and equals 5', () => {
      expect(MIN_SYNC_INTERVAL_MINUTES).toBe(5);
    });
  });

  // ===========================================================================
  // getTerraformSchedulerState()
  // ===========================================================================

  describe('getTerraformSchedulerState()', () => {
    it('returns correct initial state', () => {
      const state = getTerraformSchedulerState();
      expect(state.isRunning).toBe(false);
      expect(state.lastCheckAt).toBeNull();
      expect(state.syncInProgressCount).toBe(0);
    });

    it('returns isRunning=true after starting', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);

      expect(getTerraformSchedulerState().isRunning).toBe(true);
    });

    it('returns isRunning=false after stopping', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      stopTerraformSyncScheduler();

      expect(getTerraformSchedulerState().isRunning).toBe(false);
    });
  });

  // ===========================================================================
  // startTerraformSyncScheduler()
  // ===========================================================================

  describe('startTerraformSyncScheduler()', () => {
    it('sets isRunning to true', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);

      expect(getTerraformSchedulerState().isRunning).toBe(true);
    });

    it('returns a cleanup function', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      const cleanup = startTerraformSyncScheduler(mockDb, mockService);

      expect(typeof cleanup).toBe('function');
    });

    it('cleanup function stops the scheduler', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      const cleanup = startTerraformSyncScheduler(mockDb, mockService);
      expect(getTerraformSchedulerState().isRunning).toBe(true);

      cleanup();
      expect(getTerraformSchedulerState().isRunning).toBe(false);
    });

    it('runs initial check immediately on start', async () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);

      await vi.advanceTimersByTimeAsync(0);

      expect(mockDb.query.terraformRegistries.findMany).toHaveBeenCalledTimes(1);
    });

    it('logs warning and does not duplicate when started twice', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      startTerraformSyncScheduler(mockDb, mockService);

      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('already'))
        )
      ).toBe(true);

      warnSpy.mockRestore();
    });

    it('second start returns a cleanup function that still works', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      const cleanup2 = startTerraformSyncScheduler(mockDb, mockService);

      expect(typeof cleanup2).toBe('function');
      cleanup2();
      expect(getTerraformSchedulerState().isRunning).toBe(false);

      vi.restoreAllMocks();
    });
  });

  // ===========================================================================
  // stopTerraformSyncScheduler()
  // ===========================================================================

  describe('stopTerraformSyncScheduler()', () => {
    it('resets state after starting', () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      expect(getTerraformSchedulerState().isRunning).toBe(true);

      stopTerraformSyncScheduler();
      expect(getTerraformSchedulerState().isRunning).toBe(false);
    });

    it('is idempotent when not running', () => {
      expect(getTerraformSchedulerState().isRunning).toBe(false);
      expect(() => stopTerraformSyncScheduler()).not.toThrow();
      expect(getTerraformSchedulerState().isRunning).toBe(false);
    });

    it('clears the interval so no further checks occur', async () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);

      await vi.advanceTimersByTimeAsync(0);
      const callsAfterStart = mockDb.query.terraformRegistries.findMany.mock.calls.length;

      stopTerraformSyncScheduler();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockDb.query.terraformRegistries.findMany.mock.calls.length).toBe(callsAfterStart);
    });
  });

  // ===========================================================================
  // checkAndSyncRegistries (tested via scheduler cycle)
  // ===========================================================================

  describe('sync cycle', () => {
    it('syncs registries that are due', async () => {
      const dueRegistry = makeRegistry();
      const mockDb = createMockDb([dueRegistry]);
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).toHaveBeenCalledWith('reg-1');
    });

    it('updates nextSyncAt after successful sync', async () => {
      const dueRegistry = makeRegistry({ syncIntervalMinutes: 30 });
      const mockDb = createMockDb([dueRegistry]);
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('skips registries with status=syncing', async () => {
      const syncingRegistry = makeRegistry({ status: 'syncing' });
      const mockDb = createMockDb([syncingRegistry]);
      const mockService = createMockRegistryService();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('status is syncing'))
        )
      ).toBe(true);

      logSpy.mockRestore();
    });

    it('skips registries that are already in the syncInProgress set', async () => {
      const dueRegistry = makeRegistry();
      let resolveFirst: () => void;
      const slowSync = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const mockService = {
        sync: vi
          .fn()
          .mockReturnValueOnce(
            slowSync.then(() => ({
              ok: true,
              value: { registryId: 'reg-1', moduleCount: 0, syncedAt: new Date().toISOString() },
            }))
          )
          .mockResolvedValue({
            ok: true,
            value: { registryId: 'reg-1', moduleCount: 0, syncedAt: new Date().toISOString() },
          }),
      } as any;

      const mockDb = createMockDb([dueRegistry]);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).toHaveBeenCalledTimes(1);

      // Advance to the next scheduler tick (60 seconds)
      await vi.advanceTimersByTimeAsync(60_000);

      expect(
        logSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('sync already in progress'))
        )
      ).toBe(true);

      resolveFirst!();
      await vi.advanceTimersByTimeAsync(0);

      logSpy.mockRestore();
    });

    it('handles sync error gracefully and counts as error', async () => {
      const dueRegistry = makeRegistry();
      const mockDb = createMockDb([dueRegistry]);
      const mockService = createMockRegistryService({
        ok: false,
        error: { code: 'SYNC_FAILED', message: 'Network error' },
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('Failed to sync'))
        )
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it('handles sync throwing an exception gracefully', async () => {
      const dueRegistry = makeRegistry();
      const mockDb = createMockDb([dueRegistry]);
      const mockService = {
        sync: vi.fn().mockRejectedValue(new Error('Unexpected crash')),
      } as any;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('Error syncing'))
        )
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it('handles db query failure in checkAndSyncRegistries gracefully', async () => {
      const mockDb = {
        query: {
          terraformRegistries: {
            findMany: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          },
        },
        update: vi.fn(),
      } as any;
      const mockService = createMockRegistryService();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('Error checking registries'))
        )
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it('runs periodic checks on interval', async () => {
      const mockDb = createMockDb();
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);

      await vi.advanceTimersByTimeAsync(0);
      expect(mockDb.query.terraformRegistries.findMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockDb.query.terraformRegistries.findMany).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockDb.query.terraformRegistries.findMany).toHaveBeenCalledTimes(3);
    });

    it('does not update nextSyncAt when syncIntervalMinutes is null/0', async () => {
      const dueRegistry = makeRegistry({ syncIntervalMinutes: 0 });
      const mockDb = createMockDb([dueRegistry]);
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('handles nextSyncAt update failure gracefully', async () => {
      const dueRegistry = makeRegistry({ syncIntervalMinutes: 15 });
      const mockDb = createMockDb([dueRegistry]);
      mockDb.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('Update failed')),
        }),
      });
      const mockService = createMockRegistryService();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).toHaveBeenCalled();
      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('Failed to update nextSyncAt'))
        )
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it('syncs multiple registries in a single check', async () => {
      const reg1 = makeRegistry({ id: 'reg-1', name: 'Registry 1' });
      const reg2 = makeRegistry({ id: 'reg-2', name: 'Registry 2' });
      const mockDb = createMockDb([reg1, reg2]);
      const mockService = createMockRegistryService();

      startTerraformSyncScheduler(mockDb, mockService);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockService.sync).toHaveBeenCalledTimes(2);
      expect(mockService.sync).toHaveBeenCalledWith('reg-1');
      expect(mockService.sync).toHaveBeenCalledWith('reg-2');
    });
  });
});
