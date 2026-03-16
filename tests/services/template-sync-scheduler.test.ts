import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNextSyncAt,
  getSchedulerState,
  MIN_SYNC_INTERVAL_MINUTES,
  startSyncScheduler,
  stopSyncScheduler,
  validateSyncInterval,
} from '../../src/services/template-sync-scheduler';

// Clean up scheduler state after each test to prevent cross-test leaks
afterEach(() => {
  stopSyncScheduler();
  vi.restoreAllMocks();
});

// ============================================
// calculateNextSyncAt
// ============================================

describe('calculateNextSyncAt', () => {
  it('returns an ISO 8601 string', () => {
    const result = calculateNextSyncAt(10);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns a time in the future', () => {
    const before = Date.now();
    const result = calculateNextSyncAt(5);
    const resultTime = new Date(result).getTime();
    // Should be at least ~5 minutes from now (with small tolerance)
    expect(resultTime).toBeGreaterThan(before + 4 * 60 * 1000);
  });

  it('interval of 0 returns approximately now', () => {
    const before = Date.now();
    const result = calculateNextSyncAt(0);
    const resultTime = new Date(result).getTime();
    // Should be within a few seconds of now
    expect(Math.abs(resultTime - before)).toBeLessThan(5000);
  });

  it('large interval produces a far-future timestamp', () => {
    const result = calculateNextSyncAt(60 * 24); // 24 hours
    const resultTime = new Date(result).getTime();
    const now = Date.now();
    // Should be roughly 24 hours ahead
    expect(resultTime - now).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});

// ============================================
// validateSyncInterval
// ============================================

describe('validateSyncInterval', () => {
  it('returns true for null (disabled)', () => {
    expect(validateSyncInterval(null)).toBe(true);
  });

  it('returns true for undefined (disabled)', () => {
    expect(validateSyncInterval(undefined)).toBe(true);
  });

  it('returns true for MIN_SYNC_INTERVAL_MINUTES', () => {
    expect(validateSyncInterval(MIN_SYNC_INTERVAL_MINUTES)).toBe(true);
  });

  it('returns true for values above minimum', () => {
    expect(validateSyncInterval(10)).toBe(true);
    expect(validateSyncInterval(60)).toBe(true);
    expect(validateSyncInterval(1440)).toBe(true);
  });

  it('returns false for values below minimum', () => {
    expect(validateSyncInterval(1)).toBe(false);
    expect(validateSyncInterval(4)).toBe(false);
    expect(validateSyncInterval(0)).toBe(false);
  });

  it('returns false for negative values', () => {
    expect(validateSyncInterval(-1)).toBe(false);
    expect(validateSyncInterval(-100)).toBe(false);
  });

  it('MIN_SYNC_INTERVAL_MINUTES is 5', () => {
    expect(MIN_SYNC_INTERVAL_MINUTES).toBe(5);
  });
});

// ============================================
// getSchedulerState
// ============================================

describe('getSchedulerState', () => {
  it('returns initial state when not started', () => {
    const state = getSchedulerState();
    expect(state.isRunning).toBe(false);
    expect(state.syncInProgressCount).toBe(0);
  });

  it('returns readonly object', () => {
    const state = getSchedulerState();
    expect(typeof state.isRunning).toBe('boolean');
    expect(typeof state.syncInProgressCount).toBe('number');
    // lastCheckAt can be null or string
    expect(state.lastCheckAt === null || typeof state.lastCheckAt === 'string').toBe(true);
  });
});

// ============================================
// start/stop scheduler
// ============================================

describe('startSyncScheduler', () => {
  it('sets isRunning to true', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    startSyncScheduler(mockDb, mockTemplateService);

    expect(getSchedulerState().isRunning).toBe(true);
  });

  it('returns a cleanup function', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    const cleanup = startSyncScheduler(mockDb, mockTemplateService);
    expect(typeof cleanup).toBe('function');
  });

  it('cleanup function stops the scheduler', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    const cleanup = startSyncScheduler(mockDb, mockTemplateService);
    cleanup();

    expect(getSchedulerState().isRunning).toBe(false);
  });

  it('does not start twice (returns cleanup on re-call)', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    startSyncScheduler(mockDb, mockTemplateService);
    const cleanup2 = startSyncScheduler(mockDb, mockTemplateService);

    // Should still be running (not crashed)
    expect(getSchedulerState().isRunning).toBe(true);

    // Cleanup should still work
    cleanup2();
    expect(getSchedulerState().isRunning).toBe(false);
  });
});

describe('stopSyncScheduler', () => {
  it('sets isRunning to false', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    startSyncScheduler(mockDb, mockTemplateService);
    expect(getSchedulerState().isRunning).toBe(true);

    stopSyncScheduler();
    expect(getSchedulerState().isRunning).toBe(false);
  });

  it('is idempotent (calling when not running does not throw)', () => {
    expect(() => stopSyncScheduler()).not.toThrow();
    expect(() => stopSyncScheduler()).not.toThrow();
  });

  it('clears syncInProgress on stop', () => {
    const mockDb = {
      query: { templates: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    startSyncScheduler(mockDb, mockTemplateService);
    stopSyncScheduler();

    expect(getSchedulerState().syncInProgressCount).toBe(0);
  });
});

// ============================================
// Sync cycle behavior
// ============================================

describe('sync cycle behavior', () => {
  it('runs initial check on start', async () => {
    const findManyMock = vi.fn().mockResolvedValue([]);
    const mockDb = {
      query: { templates: { findMany: findManyMock } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    startSyncScheduler(mockDb, mockTemplateService);

    // Wait for the initial async check to complete
    await vi.waitFor(() => {
      expect(findManyMock).toHaveBeenCalled();
    });
  });

  it('scheduler handles query errors gracefully', async () => {
    const findManyMock = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const mockDb = {
      query: { templates: { findMany: findManyMock } },
    } as any;
    const mockTemplateService = { sync: vi.fn() } as any;

    // Should not throw
    startSyncScheduler(mockDb, mockTemplateService);

    await vi.waitFor(() => {
      expect(findManyMock).toHaveBeenCalled();
    });

    // Scheduler should still be running
    expect(getSchedulerState().isRunning).toBe(true);
  });
});
