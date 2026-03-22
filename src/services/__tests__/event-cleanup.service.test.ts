import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventCleanupService } from '../event-cleanup.service.js';

// ---- helpers ----------------------------------------------------------------

/** Create a mock Database with a controllable `run()` method. */
function createDbMock(changesPerCall = 0) {
  return {
    run: vi.fn().mockReturnValue({ changes: changesPerCall }),
  };
}

/** Create a mock SettingsService whose `get()` resolves to configurable values. */
function createSettingsMock(overrides: Record<string, number | null> = {}) {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key in overrides && overrides[key] !== null) {
        return { ok: true, value: { key, value: JSON.stringify(overrides[key]) } };
      }
      // Setting not found — service will use its default
      return { ok: true, value: null };
    }),
  };
}

// ---- tests ------------------------------------------------------------------

describe('EventCleanupService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- deletion logic -------------------------------------------------

  it('deletes old session events and event log entries', async () => {
    // First call returns BATCH_SIZE (1000) to simulate a full batch,
    // second call returns fewer to terminate the loop — for each table.
    const db = createDbMock();
    db.run
      .mockReturnValueOnce({ changes: 500 }) // session_events: < BATCH_SIZE → done
      .mockReturnValueOnce({ changes: 200 }); // event_log: < BATCH_SIZE → done

    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    const result = await service.runCleanup();

    expect(result.sessionEventsDeleted).toBe(500);
    expect(result.eventLogDeleted).toBe(200);
    // Two calls: one for session_events, one for event_log
    expect(db.run).toHaveBeenCalledTimes(2);
  });

  it('respects configurable retention days from settings', async () => {
    const db = createDbMock(0);
    const settings = createSettingsMock({
      'retention.sessionEventsDays': 7,
      'retention.eventLogDays': 14,
    });

    const service = new EventCleanupService(db as never, settings as never);
    await service.runCleanup();

    // Verify settings were read for both keys
    expect(settings.get).toHaveBeenCalledWith('retention.sessionEventsDays');
    expect(settings.get).toHaveBeenCalledWith('retention.eventLogDays');
  });

  it('leaves recent events untouched (zero deletes when no old rows)', async () => {
    const db = createDbMock(0); // No rows match the cutoff
    const settings = createSettingsMock();

    const service = new EventCleanupService(db as never, settings as never);
    const result = await service.runCleanup();

    expect(result.sessionEventsDeleted).toBe(0);
    expect(result.eventLogDeleted).toBe(0);
  });

  it('handles empty tables without errors', async () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();

    const service = new EventCleanupService(db as never, settings as never);

    // Should not throw
    await expect(service.runCleanup()).resolves.toEqual({
      sessionEventsDeleted: 0,
      eventLogDeleted: 0,
    });
  });

  it('batch-processes when more than BATCH_SIZE rows exist', async () => {
    const db = createDbMock();
    // session_events: 3 batches (1000 + 1000 + 500)
    db.run
      .mockReturnValueOnce({ changes: 1000 }) // batch 1
      .mockReturnValueOnce({ changes: 1000 }) // batch 2
      .mockReturnValueOnce({ changes: 500 }) // batch 3 — terminates
      // event_log: 1 batch
      .mockReturnValueOnce({ changes: 300 });

    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    const result = await service.runCleanup();

    expect(result.sessionEventsDeleted).toBe(2500);
    expect(result.eventLogDeleted).toBe(300);
    // 3 calls for session_events + 1 for event_log = 4
    expect(db.run).toHaveBeenCalledTimes(4);
  });

  it('uses default retention days when settings return null', async () => {
    const db = createDbMock(0);
    // Settings return null — service should use defaults (30 / 90)
    const settings = createSettingsMock();

    const service = new EventCleanupService(db as never, settings as never);
    await service.runCleanup();

    // Verify the service still ran (called db.run for each table)
    expect(db.run).toHaveBeenCalledTimes(2);
  });

  it('uses default retention when settings service errors', async () => {
    const db = createDbMock(0);
    const settings = {
      get: vi.fn().mockRejectedValue(new Error('DB offline')),
    };

    const service = new EventCleanupService(db as never, settings as never);

    // Should not throw — falls through to defaults
    const result = await service.runCleanup();
    expect(result.sessionEventsDeleted).toBe(0);
    expect(result.eventLogDeleted).toBe(0);
  });

  // ---------- lifecycle ------------------------------------------------------

  it('start/stop lifecycle', () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    expect(service.getState().isRunning).toBe(false);

    const stop = service.start();

    expect(service.getState().isRunning).toBe(true);

    stop();

    expect(service.getState().isRunning).toBe(false);
  });

  it('start returns stop function and calling stop twice is safe', () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    const stop = service.start();
    stop();

    // Second stop should be a no-op, not throw
    expect(() => service.stop()).not.toThrow();
    expect(service.getState().isRunning).toBe(false);
  });

  it('does not start twice when start() is called again', () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    service.start();
    const stop2 = service.start(); // Should return stop without starting again

    expect(service.getState().isRunning).toBe(true);
    stop2();
    expect(service.getState().isRunning).toBe(false);
  });

  it('runs cleanup after initial delay', async () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    service.start();

    // Before initial delay: no cleanup run
    expect(db.run).not.toHaveBeenCalled();
    expect(service.getState().lastRunAt).toBeNull();

    // Advance past initial delay (60s)
    await vi.advanceTimersByTimeAsync(60_000);

    // Cleanup should have run
    expect(db.run).toHaveBeenCalled();
    expect(service.getState().lastRunAt).not.toBeNull();

    service.stop();
  });

  it('records lastRunAt after cleanup', async () => {
    const db = createDbMock(0);
    const settings = createSettingsMock();
    const service = new EventCleanupService(db as never, settings as never);

    expect(service.getState().lastRunAt).toBeNull();

    await service.runCleanup();

    expect(service.getState().lastRunAt).not.toBeNull();
  });
});
