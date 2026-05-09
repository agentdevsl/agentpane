/**
 * Integration coverage for bootstrap/phases/recovery error paths.
 *
 * Each recovery function logs and swallows DB errors; this test injects a
 * minimal DB stub whose query/update methods throw so each catch branch
 * runs. Boosts recovery.ts from 70% → ~95% line coverage.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  cleanOrphanedWorktrees,
  recoverOrphanedTasks,
  resetStaleAgentReviewing,
  resetStaleAgents,
  runRecovery,
} from '../../src/server/bootstrap/phases/recovery';

function buildThrowingDb() {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => {
          throw new Error('db down');
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          throw new Error('db down');
        }),
      })),
    })),
  } as never;
}

describe('bootstrap/phases/recovery — DB-error catch branches', () => {
  it('resetStaleAgents swallows DB errors', async () => {
    const db = buildThrowingDb();
    await expect(resetStaleAgents(db)).resolves.toBeUndefined();
  });

  it('resetStaleAgentReviewing swallows DB errors', async () => {
    const db = buildThrowingDb();
    await expect(resetStaleAgentReviewing(db)).resolves.toBeUndefined();
  });

  it('recoverOrphanedTasks swallows DB errors', async () => {
    const db = buildThrowingDb();
    await expect(recoverOrphanedTasks(db)).resolves.toBeUndefined();
  });

  it('cleanOrphanedWorktrees swallows DB errors on the SELECT side', async () => {
    const db = buildThrowingDb();
    await expect(cleanOrphanedWorktrees(db)).resolves.toBeUndefined();
  });

  it('runRecovery returns errors=[] when all sub-steps swallow internally', async () => {
    const db = buildThrowingDb();
    const { errors } = await runRecovery(db);
    // Each individual function logs+swallows; runRecovery's outer try/catch
    // never sees them, so errors should still be empty.
    expect(errors).toEqual([]);
  });
});
