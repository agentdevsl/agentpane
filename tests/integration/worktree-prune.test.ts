import { and, eq, lt } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktrees } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-029: Worktree Pruning at DB Level', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('identifies stale active worktrees older than 7 days', async () => {
    const codespace = await createTestProject();

    const staleWorktree = await createTestWorktree(codespace.id, { status: 'active' });
    const recentWorktree = await createTestWorktree(codespace.id, { status: 'active' });
    const removedWorktree = await createTestWorktree(codespace.id, { status: 'active' });
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: new Date().toISOString() })
      .where(eq(worktrees.id, removedWorktree.id));

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, staleWorktree.id));

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, recentWorktree.id));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const staleActive = await db.query.worktrees.findMany({
      where: and(eq(worktrees.status, 'active'), lt(worktrees.updatedAt, sevenDaysAgo)),
    });

    expect(staleActive).toHaveLength(1);
    expect(staleActive[0].id).toBe(staleWorktree.id);
  });

  it('updates stale worktree to removed status', async () => {
    const codespace = await createTestProject();
    const staleWorktree = await createTestWorktree(codespace.id, { status: 'active' });

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, staleWorktree.id));

    const now = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: now })
      .where(eq(worktrees.id, staleWorktree.id));

    const updated = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, staleWorktree.id),
    });

    expect(updated!.status).toBe('removed');
    expect(updated!.removedAt).toBe(now);
  });

  it('does not affect recent active worktrees during pruning', async () => {
    const codespace = await createTestProject();

    const staleWorktree = await createTestWorktree(codespace.id, { status: 'active' });
    const recentWorktree = await createTestWorktree(codespace.id, { status: 'active' });

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, staleWorktree.id));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: now })
      .where(and(eq(worktrees.status, 'active'), lt(worktrees.updatedAt, sevenDaysAgo)));

    const recent = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, recentWorktree.id),
    });
    expect(recent!.status).toBe('active');
  });

  it('does not modify already-removed worktrees', async () => {
    const codespace = await createTestProject();
    const existingRemovedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const removedWorktree = await createTestWorktree(codespace.id, { status: 'active' });
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: existingRemovedAt })
      .where(eq(worktrees.id, removedWorktree.id));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: now })
      .where(and(eq(worktrees.status, 'active'), lt(worktrees.updatedAt, sevenDaysAgo)));

    const unchanged = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, removedWorktree.id),
    });
    expect(unchanged!.status).toBe('removed');
    expect(unchanged!.removedAt).not.toBe(now);
  });

  it('handles all three worktree states correctly in one pruning operation', async () => {
    const codespace = await createTestProject();

    const stale = await createTestWorktree(codespace.id, { status: 'active' });
    const recent = await createTestWorktree(codespace.id, { status: 'active' });
    const alreadyRemoved = await createTestWorktree(codespace.id, { status: 'active' });
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: new Date().toISOString() })
      .where(eq(worktrees.id, alreadyRemoved.id));

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, stale.id));

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, recent.id));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: now })
      .where(and(eq(worktrees.status, 'active'), lt(worktrees.updatedAt, sevenDaysAgo)));

    const staleResult = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, stale.id),
    });
    expect(staleResult!.status).toBe('removed');
    expect(staleResult!.removedAt).toBe(now);

    const recentResult = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, recent.id),
    });
    expect(recentResult!.status).toBe('active');

    const removedResult = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, alreadyRemoved.id),
    });
    expect(removedResult!.status).toBe('removed');
  });
});
