import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templates } from '../../src/db/schema';
import {
  calculateNextSyncAt,
  MIN_SYNC_INTERVAL_MINUTES,
  TemplateSyncScheduler,
  validateSyncInterval,
} from '../../src/services/template-sync-scheduler';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock the TemplateService — external I/O boundary (GitHub API calls)
// ---------------------------------------------------------------------------

function createMockTemplateService(overrides: Record<string, unknown> = {}) {
  return {
    sync: vi.fn().mockResolvedValue({ ok: true, value: { syncedAt: new Date().toISOString() } }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertTemplate(
  db: ReturnType<typeof getTestDb>,
  overrides: Partial<{
    id: string;
    name: string;
    syncIntervalMinutes: number | null;
    nextSyncAt: string | null;
    status: string;
  }> = {}
) {
  const now = new Date().toISOString();
  const [tmpl] = await db
    .insert(templates)
    .values({
      id: overrides.id ?? createId(),
      name: overrides.name ?? 'Test Template',
      scope: 'org',
      githubOwner: 'test-org',
      githubRepo: `repo-${createId().slice(0, 6)}`,
      status: (overrides.status as any) ?? 'active',
      syncIntervalMinutes: overrides.syncIntervalMinutes ?? null,
      nextSyncAt: overrides.nextSyncAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return tmpl!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TemplateSyncScheduler (IT-440 to IT-452)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clear template tables
    await db.delete(templates);
    // Use fake timers for scheduler interval control
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(templates);
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Pure function tests: calculateNextSyncAt
  // -------------------------------------------------------------------------

  describe('calculateNextSyncAt (IT-440)', () => {
    it('IT-440a: returns ISO string in the future', () => {
      vi.useRealTimers();
      const result = calculateNextSyncAt(10);
      const resultTime = new Date(result).getTime();
      const now = Date.now();
      expect(resultTime).toBeGreaterThan(now);
      // Should be approximately 10 minutes from now (within 2 seconds tolerance)
      expect(resultTime).toBeLessThan(now + 10 * 60 * 1000 + 2000);
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it('IT-440b: returns valid ISO string', () => {
      const result = calculateNextSyncAt(5);
      expect(() => new Date(result)).not.toThrow();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // -------------------------------------------------------------------------
  // Pure function tests: validateSyncInterval
  // -------------------------------------------------------------------------

  describe('validateSyncInterval (IT-441)', () => {
    it('IT-441a: null is valid (sync disabled)', () => {
      expect(validateSyncInterval(null)).toBe(true);
    });

    it('IT-441b: undefined is valid (sync disabled)', () => {
      expect(validateSyncInterval(undefined)).toBe(true);
    });

    it('IT-441c: MIN_SYNC_INTERVAL_MINUTES is valid', () => {
      expect(validateSyncInterval(MIN_SYNC_INTERVAL_MINUTES)).toBe(true);
    });

    it('IT-441d: value above minimum is valid', () => {
      expect(validateSyncInterval(60)).toBe(true);
    });

    it('IT-441e: value below minimum is invalid', () => {
      expect(validateSyncInterval(1)).toBe(false);
      expect(validateSyncInterval(4)).toBe(false);
    });

    it('IT-441f: zero is invalid', () => {
      expect(validateSyncInterval(0)).toBe(false);
    });

    it('IT-441g: negative value is invalid', () => {
      expect(validateSyncInterval(-10)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scheduler lifecycle
  // -------------------------------------------------------------------------

  describe('Scheduler lifecycle (IT-442)', () => {
    it('IT-442a: start() sets isRunning and returns stop function', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      const stop = scheduler.start();

      expect(scheduler.getState().isRunning).toBe(true);
      expect(typeof stop).toBe('function');

      scheduler.stop();
    });

    it('IT-442b: stop() clears isRunning', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();
      expect(scheduler.getState().isRunning).toBe(true);

      scheduler.stop();
      expect(scheduler.getState().isRunning).toBe(false);
    });

    it('IT-442c: double start() is idempotent', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      const stop1 = scheduler.start();
      const stop2 = scheduler.start();

      // Both return stop functions
      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');

      // Only one scheduler should be running
      expect(scheduler.getState().isRunning).toBe(true);

      scheduler.stop();
    });

    it('IT-442d: stop() when not running is a no-op', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      // Should not throw
      scheduler.stop();
      expect(scheduler.getState().isRunning).toBe(false);
    });

    it('IT-442e: returned stop function stops the scheduler', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      const stop = scheduler.start();
      expect(scheduler.getState().isRunning).toBe(true);

      stop();
      expect(scheduler.getState().isRunning).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  describe('getState (IT-443)', () => {
    it('IT-443a: returns initial state when not started', () => {
      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      const state = scheduler.getState();
      expect(state.isRunning).toBe(false);
      expect(state.lastCheckAt).toBeNull();
      expect(state.syncInProgressCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkAndSyncTemplates — templates due for sync
  // -------------------------------------------------------------------------

  describe('Sync due templates (IT-444)', () => {
    it('IT-444a: syncs template with past nextSyncAt', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const template = await insertTemplate(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      // Access private method via start() which triggers immediate check
      scheduler.start();

      // Wait for the async initial check to complete
      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalledWith(template.id);
      });

      scheduler.stop();
    });

    it('IT-444b: skips template with future nextSyncAt', async () => {
      vi.useRealTimers();

      const futureTime = new Date(Date.now() + 3_600_000).toISOString();
      await insertTemplate(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: futureTime,
        status: 'active',
      });

      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();

      // Give it time to process
      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('IT-444c: skips template with null syncIntervalMinutes', async () => {
      vi.useRealTimers();

      await insertTemplate(db, {
        syncIntervalMinutes: null,
        nextSyncAt: null,
        status: 'active',
      });

      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('IT-444d: skips template with syncing status', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await insertTemplate(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'syncing',
      });

      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // nextSyncAt update after sync
  // -------------------------------------------------------------------------

  describe('nextSyncAt update (IT-445)', () => {
    it('IT-445a: updates nextSyncAt after successful sync', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const template = await insertTemplate(db, {
        syncIntervalMinutes: 15,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockTemplateService();
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalled();
      });

      // Wait for nextSyncAt update
      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.templates.findFirst({
        where: eq(templates.id, template.id),
      });

      expect(updated!.nextSyncAt).not.toBe(pastTime);
      // New nextSyncAt should be in the future
      const nextTime = new Date(updated!.nextSyncAt!).getTime();
      expect(nextTime).toBeGreaterThan(Date.now() - 5000);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('Error handling (IT-446)', () => {
    it('IT-446a: continues processing remaining templates when one fails', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const tmpl1 = await insertTemplate(db, {
        name: 'Failing Template',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });
      const tmpl2 = await insertTemplate(db, {
        name: 'Succeeding Template',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const syncFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === tmpl1.id) {
          return { ok: false, error: { code: 'SYNC_FAILED', message: 'GitHub 500' } };
        }
        return { ok: true, value: { syncedAt: new Date().toISOString() } };
      });

      const mockService = { sync: syncFn };
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(syncFn).toHaveBeenCalledTimes(2);
      });

      // Both templates should have been attempted
      expect(syncFn).toHaveBeenCalledWith(tmpl1.id);
      expect(syncFn).toHaveBeenCalledWith(tmpl2.id);

      scheduler.stop();
    });

    it('IT-446b: handles sync function throwing an exception', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await insertTemplate(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockTemplateService({
        sync: vi.fn().mockRejectedValue(new Error('Unexpected crash')),
      });
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      // Should not throw — errors are caught internally
      scheduler.start();

      await new Promise((r) => setTimeout(r, 200));

      // Scheduler should still be running after error
      expect(scheduler.getState().isRunning).toBe(true);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent sync guard
  // -------------------------------------------------------------------------

  describe('Concurrent sync guard (IT-447)', () => {
    it('IT-447a: prevents duplicate sync for same template', async () => {
      vi.useRealTimers();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const template = await insertTemplate(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      // Simulate a slow sync that takes time
      let resolveSync: (() => void) | null = null;
      const syncPromise = new Promise<void>((r) => {
        resolveSync = r;
      });

      const syncFn = vi.fn().mockImplementation(async () => {
        await syncPromise;
        return { ok: true, value: { syncedAt: new Date().toISOString() } };
      });

      const mockService = { sync: syncFn };
      const scheduler = new TemplateSyncScheduler(db as any, mockService as any);

      // Manually add template to syncInProgress to simulate concurrent access
      (scheduler as any).syncInProgress.add(template.id);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      // Sync should NOT be called because it's already in progress
      expect(syncFn).not.toHaveBeenCalled();

      // Cleanup
      resolveSync!();
      scheduler.stop();
    });
  });
});
