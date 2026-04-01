import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import {
  calculateNextSyncAt,
  TerraformSyncScheduler,
} from '../../src/services/terraform-sync-scheduler';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistryService(overrides: Record<string, unknown> = {}) {
  return {
    sync: vi.fn().mockResolvedValue({
      ok: true,
      value: { registryId: '', moduleCount: 5, syncedAt: new Date().toISOString() },
    }),
    ...overrides,
  };
}

async function insertRegistry(
  db: ReturnType<typeof getTestDb>,
  overrides: Partial<{
    id: string;
    name: string;
    orgName: string;
    syncIntervalMinutes: number | null;
    nextSyncAt: string | null;
    status: string;
  }> = {}
) {
  const id = overrides.id ?? createId();
  const [reg] = await db
    .insert(terraformRegistries)
    .values({
      id,
      name: overrides.name ?? 'Test Registry',
      orgName: overrides.orgName ?? `org-${id.slice(0, 6)}`,
      tokenSettingKey: `terraform.registry.${id}.apiToken`,
      status: (overrides.status as any) ?? 'active',
      syncIntervalMinutes: overrides.syncIntervalMinutes ?? null,
      nextSyncAt: overrides.nextSyncAt ?? null,
      moduleCount: 0,
    })
    .returning();
  return reg!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerraformSyncScheduler (IT-460 to IT-472)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    try {
      execRawSql(TERRAFORM_MIGRATION_SQL);
    } catch {
      // Tables may already exist
    }
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Pure function tests: calculateNextSyncAt
  // -------------------------------------------------------------------------

  describe('calculateNextSyncAt (IT-460)', () => {
    it('IT-460a: returns future ISO string', () => {
      const result = calculateNextSyncAt(30);
      const resultTime = new Date(result).getTime();
      const now = Date.now();
      expect(resultTime).toBeGreaterThan(now - 1000);
      expect(resultTime).toBeLessThan(now + 31 * 60 * 1000);
    });

    it('IT-460b: different intervals produce different times', () => {
      const short = calculateNextSyncAt(5);
      const long = calculateNextSyncAt(60);
      expect(new Date(long).getTime()).toBeGreaterThan(new Date(short).getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Scheduler lifecycle
  // -------------------------------------------------------------------------

  describe('Scheduler lifecycle (IT-461)', () => {
    it('IT-461a: start() sets isRunning and returns stop function', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      const stop = scheduler.start();

      expect(scheduler.getState().isRunning).toBe(true);
      expect(typeof stop).toBe('function');

      scheduler.stop();
    });

    it('IT-461b: stop() clears isRunning and syncInProgress', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();
      // Simulate an in-progress sync
      (scheduler as any).syncInProgress.add('fake-id');
      expect(scheduler.getState().syncInProgressCount).toBe(1);

      scheduler.stop();
      expect(scheduler.getState().isRunning).toBe(false);
      expect(scheduler.getState().syncInProgressCount).toBe(0);
    });

    it('IT-461c: double start() is idempotent', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();
      scheduler.start(); // Should log warning but not create duplicate

      expect(scheduler.getState().isRunning).toBe(true);

      scheduler.stop();
    });

    it('IT-461d: stop() when not running is a no-op', () => {
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      // Should not throw
      scheduler.stop();
      expect(scheduler.getState().isRunning).toBe(false);
    });

    it('IT-461e: returned stop function works correctly', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      const stop = scheduler.start();
      expect(scheduler.getState().isRunning).toBe(true);

      stop();
      expect(scheduler.getState().isRunning).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  describe('getState (IT-462)', () => {
    it('IT-462a: returns initial state when not started', () => {
      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      const state = scheduler.getState();
      expect(state.isRunning).toBe(false);
      expect(state.lastCheckAt).toBeNull();
      expect(state.syncInProgressCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Sync due registries
  // -------------------------------------------------------------------------

  describe('Sync due registries (IT-463)', () => {
    it('IT-463a: syncs registry with past nextSyncAt', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const registry = await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalledWith(registry.id);
      });

      scheduler.stop();
    });

    it('IT-463b: skips registry with future nextSyncAt', async () => {
      const futureTime = new Date(Date.now() + 3_600_000).toISOString();
      await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: futureTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      // Give time for initial check
      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('IT-463c: skips registry with null syncIntervalMinutes', async () => {
      await insertRegistry(db, {
        syncIntervalMinutes: null,
        nextSyncAt: null,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('IT-463d: skips registry with syncing status', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'syncing',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // nextSyncAt update after sync
  // -------------------------------------------------------------------------

  describe('nextSyncAt update (IT-464)', () => {
    it('IT-464a: updates nextSyncAt after successful sync', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const registry = await insertRegistry(db, {
        syncIntervalMinutes: 15,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalled();
      });

      // Allow nextSyncAt update to complete
      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, registry.id),
      });

      expect(updated!.nextSyncAt).not.toBe(pastTime);
      const nextTime = new Date(updated!.nextSyncAt!).getTime();
      // Should be in the future (approximately 15 minutes from now)
      expect(nextTime).toBeGreaterThan(Date.now() - 5000);

      scheduler.stop();
    });

    it('IT-464b: updates nextSyncAt even when sync fails', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const registry = await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService({
        sync: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'SYNC_FAILED', message: 'API error' },
        }),
      });
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 100));

      // nextSyncAt should still be updated to prevent retry storms
      const updated = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, registry.id),
      });
      expect(updated!.nextSyncAt).not.toBe(pastTime);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple registries
  // -------------------------------------------------------------------------

  describe('Multiple registries (IT-465)', () => {
    it('IT-465a: syncs all due registries', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const reg1 = await insertRegistry(db, {
        name: 'Registry 1',
        orgName: 'org-1',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });
      const reg2 = await insertRegistry(db, {
        name: 'Registry 2',
        orgName: 'org-2',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalledTimes(2);
      });

      expect(mockService.sync).toHaveBeenCalledWith(reg1.id);
      expect(mockService.sync).toHaveBeenCalledWith(reg2.id);

      scheduler.stop();
    });

    it('IT-465b: only syncs due registries, not future ones', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const futureTime = new Date(Date.now() + 3_600_000).toISOString();

      const dueReg = await insertRegistry(db, {
        name: 'Due',
        orgName: 'due-org',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });
      await insertRegistry(db, {
        name: 'Not Due',
        orgName: 'notdue-org',
        syncIntervalMinutes: 10,
        nextSyncAt: futureTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalledTimes(1);
      });

      expect(mockService.sync).toHaveBeenCalledWith(dueReg.id);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('Error handling (IT-466)', () => {
    it('IT-466a: continues processing when one registry sync fails', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const reg1 = await insertRegistry(db, {
        name: 'Failing',
        orgName: 'fail-org',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });
      const reg2 = await insertRegistry(db, {
        name: 'Passing',
        orgName: 'pass-org',
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const syncFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === reg1.id) {
          return { ok: false, error: { code: 'SYNC_FAILED', message: 'API error' } };
        }
        return {
          ok: true,
          value: { registryId: id, moduleCount: 3, syncedAt: new Date().toISOString() },
        };
      });

      const mockService = { sync: syncFn };
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(syncFn).toHaveBeenCalledTimes(2);
      });

      expect(syncFn).toHaveBeenCalledWith(reg1.id);
      expect(syncFn).toHaveBeenCalledWith(reg2.id);

      scheduler.stop();
    });

    it('IT-466b: handles sync function throwing an exception', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService({
        sync: vi.fn().mockRejectedValue(new Error('Unexpected crash')),
      });
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      // Should not throw
      scheduler.start();

      await new Promise((r) => setTimeout(r, 200));

      // Scheduler should still be running
      expect(scheduler.getState().isRunning).toBe(true);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent sync guard
  // -------------------------------------------------------------------------

  describe('Concurrent sync guard (IT-467)', () => {
    it('IT-467a: prevents duplicate sync for same registry', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const registry = await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      // Pre-mark as in progress
      (scheduler as any).syncInProgress.add(registry.id);

      scheduler.start();

      await new Promise((r) => setTimeout(r, 100));

      // Sync should NOT have been called because it's in progress
      expect(mockService.sync).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('IT-467b: syncInProgress is cleaned after sync completes', async () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await insertRegistry(db, {
        syncIntervalMinutes: 10,
        nextSyncAt: pastTime,
        status: 'active',
      });

      const mockService = createMockRegistryService();
      const scheduler = new TerraformSyncScheduler(db as any, mockService as any);

      scheduler.start();

      await vi.waitFor(() => {
        expect(mockService.sync).toHaveBeenCalled();
      });

      // After sync completes, syncInProgress should be empty
      await new Promise((r) => setTimeout(r, 100));
      expect(scheduler.getState().syncInProgressCount).toBe(0);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Module-level backward-compatible API
  // -------------------------------------------------------------------------

  describe('Module-level API (IT-468)', () => {
    it('IT-468a: calculateNextSyncAt is exported and functional', () => {
      const result = calculateNextSyncAt(5);
      expect(typeof result).toBe('string');
      expect(() => new Date(result)).not.toThrow();
    });
  });
});
