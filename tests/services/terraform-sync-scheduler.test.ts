import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNextSyncAt,
  getTerraformSchedulerState,
  startTerraformSyncScheduler,
  stopTerraformSyncScheduler,
} from '../../src/services/terraform-sync-scheduler';

describe('terraform-sync-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopTerraformSyncScheduler();
    vi.useRealTimers();
  });

  it('calculateNextSyncAt(15) returns ISO string 15 minutes in the future', () => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const result = calculateNextSyncAt(15);
    expect(result).toBe('2025-01-01T00:15:00.000Z');
  });

  it('getTerraformSchedulerState returns correct initial state', () => {
    const state = getTerraformSchedulerState();
    expect(state.isRunning).toBe(false);
    expect(state.lastCheckAt).toBeNull();
    expect(state.syncInProgressCount).toBe(0);
  });

  it('startTerraformSyncScheduler sets isRunning to true', () => {
    const mockDb = {
      query: {
        terraformRegistries: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as any;
    const mockRegistry = {} as any;

    startTerraformSyncScheduler(mockDb, mockRegistry);

    expect(getTerraformSchedulerState().isRunning).toBe(true);
  });

  it('stopTerraformSyncScheduler resets state after starting', () => {
    const mockDb = {
      query: {
        terraformRegistries: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as any;
    const mockRegistry = {} as any;

    startTerraformSyncScheduler(mockDb, mockRegistry);
    expect(getTerraformSchedulerState().isRunning).toBe(true);

    stopTerraformSyncScheduler();
    expect(getTerraformSchedulerState().isRunning).toBe(false);
  });

  it('starting twice logs a warning and does not duplicate the scheduler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockDb = {
      query: {
        terraformRegistries: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as any;
    const mockRegistry = {} as any;

    startTerraformSyncScheduler(mockDb, mockRegistry);
    startTerraformSyncScheduler(mockDb, mockRegistry);

    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('already'))
      )
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it('stopTerraformSyncScheduler is idempotent when not running', () => {
    expect(getTerraformSchedulerState().isRunning).toBe(false);
    // Calling stop when not running should be a no-op and not throw
    expect(() => stopTerraformSyncScheduler()).not.toThrow();
    expect(getTerraformSchedulerState().isRunning).toBe(false);
  });

  it('calculateNextSyncAt with 0 minutes returns current time', () => {
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
    const result = calculateNextSyncAt(0);
    expect(result).toBe('2025-06-15T12:00:00.000Z');
  });
});
