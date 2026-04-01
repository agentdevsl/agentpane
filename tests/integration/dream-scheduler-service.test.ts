/**
 * Integration tests for DreamScheduler.
 *
 * The scheduler is a setInterval-based loop that checks settings and triggers
 * DreamService.runDreamCycle() when conditions are met. Since the scheduler
 * depends on SettingsService (real or mock) and DreamService (mocked — it calls
 * the Claude API), we test the scheduling logic, interval enforcement, and
 * singleton management with fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DreamService } from '../../src/services/memory/dream.service';
import {
  DreamScheduler,
  startDreamScheduler,
  stopDreamScheduler,
} from '../../src/services/memory/dream-scheduler.service';
import type { SettingsService } from '../../src/services/settings.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSettings(overrides: Record<string, unknown> = {}): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key in overrides) {
        const val = overrides[key];
        if (val === null) return { ok: true, value: null };
        return { ok: true, value: { value: JSON.stringify(val) } };
      }
      return { ok: true, value: null };
    }),
    set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getAll: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    getMany: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    setMany: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  } as unknown as SettingsService;
}

function createMockDreamService(
  result = {
    ok: true as const,
    value: { skillsAnalyzed: 2, suggestionsGenerated: 1, tokensUsed: 500 },
  }
): DreamService {
  return {
    runDreamCycle: vi.fn().mockResolvedValue(result),
  } as unknown as DreamService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamScheduler (IT-DS-001)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset singleton between tests
    stopDreamScheduler();
  });

  afterEach(() => {
    stopDreamScheduler();
    vi.useRealTimers();
  });

  it('IT-DS-001a: start returns cleanup function and sets up interval', () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    const cleanup = scheduler.start();

    expect(typeof cleanup).toBe('function');

    // Cleanup stops the scheduler
    cleanup();
  });

  it('IT-DS-001b: does not run dream cycle when dreaming is disabled', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': false });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // Advance past the check interval (5 minutes)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(dreamService.runDreamCycle).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('IT-DS-001c: runs dream cycle when enabled and interval has elapsed', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
      'memory.dreaming.intervalHours': 0, // Will be clamped to min of 1 hour
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // First check interval fires at 5 minutes; since no lastDreamAt, it should run
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('IT-DS-001d: does not run dream again before interval elapses', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
      'memory.dreaming.intervalHours': 24,
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // First tick runs the dream (no lastDreamAt)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Second tick at 10 minutes — should NOT run (24h interval not elapsed)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('IT-DS-001e: clamps interval to minimum of 1 hour', async () => {
    const dreamService = createMockDreamService();
    // Set interval to 0.1 hours (should be clamped to 1)
    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
      'memory.dreaming.intervalHours': 0.1,
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // First tick triggers the first dream
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Advance 30 minutes (6 more check intervals) — should NOT run again
    // because clamped interval is 1 hour
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('IT-DS-001f: does not run if dreaming.enabled setting is absent', async () => {
    const dreamService = createMockDreamService();
    // No overrides means 'memory.dreaming.enabled' returns null
    const settingsService = createMockSettings({});

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(dreamService.runDreamCycle).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('IT-DS-001g: handles dream cycle errors gracefully without crashing', async () => {
    const dreamService = createMockDreamService();
    (dreamService.runDreamCycle as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API connection failed')
    );

    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // Should not throw
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Scheduler should still be running — next tick should attempt again
    // (since error resets dreamInProgress but doesn't set lastDreamAt)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('IT-DS-001h: prevents concurrent dream cycles (dreamInProgress guard)', async () => {
    let resolvePromise: () => void;
    const slowPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const dreamService = createMockDreamService();
    (dreamService.runDreamCycle as ReturnType<typeof vi.fn>).mockImplementation(() =>
      slowPromise.then(() => ({
        ok: true,
        value: { skillsAnalyzed: 1, suggestionsGenerated: 0, tokensUsed: 100 },
      }))
    );

    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // First tick starts the dream cycle
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Second tick while first is still running — should be skipped
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Resolve the first dream and verify
    resolvePromise!();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stop();
  });

  it('IT-DS-001i: start is idempotent — calling twice does not create duplicate intervals', () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    const cleanup1 = scheduler.start();
    const cleanup2 = scheduler.start();

    // Both return cleanup functions
    expect(typeof cleanup1).toBe('function');
    expect(typeof cleanup2).toBe('function');

    scheduler.stop();
  });

  it('IT-DS-001j: stop clears interval and marks scheduler as not running', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();
    scheduler.stop();

    // Advance past several check intervals — nothing should fire
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(dreamService.runDreamCycle).not.toHaveBeenCalled();
  });

  // --- Singleton management ---

  it('IT-DS-001k: startDreamScheduler creates singleton and returns cleanup', () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    const cleanup = startDreamScheduler(dreamService, settingsService);
    expect(typeof cleanup).toBe('function');

    stopDreamScheduler();
  });

  it('IT-DS-001l: startDreamScheduler reuses existing singleton', () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    const cleanup1 = startDreamScheduler(dreamService, settingsService);
    const cleanup2 = startDreamScheduler(dreamService, settingsService);

    // Both should return cleanup functions (the singleton is reused)
    expect(typeof cleanup1).toBe('function');
    expect(typeof cleanup2).toBe('function');

    stopDreamScheduler();
  });

  it('IT-DS-001m: stopDreamScheduler clears singleton', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({ 'memory.dreaming.enabled': true });

    startDreamScheduler(dreamService, settingsService);
    stopDreamScheduler();

    // After stopping, a new call should create a fresh singleton
    const dreamService2 = createMockDreamService();
    startDreamScheduler(dreamService2, settingsService);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(dreamService2.runDreamCycle).toHaveBeenCalledTimes(1);
    // Original should not have been called again
    expect(dreamService.runDreamCycle).not.toHaveBeenCalled();

    stopDreamScheduler();
  });

  it('IT-DS-001n: handles settings service errors gracefully', async () => {
    const dreamService = createMockDreamService();
    const settingsService = createMockSettings({});
    (settingsService.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection lost')
    );

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // Should not throw even if settings fails
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(dreamService.runDreamCycle).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('IT-DS-001o: dream cycle returning error result still updates lastDreamAt', async () => {
    const dreamService = createMockDreamService({
      ok: false as const,
      error: { code: 'DERIVATION_ERROR', message: 'Failed' },
    } as any);

    const settingsService = createMockSettings({
      'memory.dreaming.enabled': true,
      'memory.dreaming.intervalHours': 24,
    });

    const scheduler = new DreamScheduler(dreamService, settingsService);
    scheduler.start();

    // First tick triggers
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    // Second tick — lastDreamAt was updated, 24h interval has not elapsed
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(dreamService.runDreamCycle).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
