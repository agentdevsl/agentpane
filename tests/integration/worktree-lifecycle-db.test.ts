import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktrees } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-016: Worktree lifecycle DB state transitions', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('transitions through full lifecycle: creating → active → merging → active → removing → removed', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const worktree = await createTestWorktree(project.id, { status: 'creating' });
    expect(worktree.status).toBe('creating');

    await db.update(worktrees).set({ status: 'active' }).where(eq(worktrees.id, worktree.id));
    const active = await db.query.worktrees.findFirst({ where: eq(worktrees.id, worktree.id) });
    expect(active!.status).toBe('active');

    await db.update(worktrees).set({ status: 'merging' }).where(eq(worktrees.id, worktree.id));
    const merging = await db.query.worktrees.findFirst({ where: eq(worktrees.id, worktree.id) });
    expect(merging!.status).toBe('merging');

    await db.update(worktrees).set({ status: 'active' }).where(eq(worktrees.id, worktree.id));
    const backToActive = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(backToActive!.status).toBe('active');

    await db.update(worktrees).set({ status: 'removing' }).where(eq(worktrees.id, worktree.id));
    const removing = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(removing!.status).toBe('removing');

    const removedAt = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt })
      .where(eq(worktrees.id, worktree.id));
    const removed = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(removed!.status).toBe('removed');
    expect(removed!.removedAt).toBeTruthy();
  });

  it('tracks mergedAt timestamp on active worktree', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const worktree = await createTestWorktree(project.id, { status: 'active' });
    expect(worktree.mergedAt).toBeNull();

    const mergedAt = new Date().toISOString();
    await db.update(worktrees).set({ mergedAt }).where(eq(worktrees.id, worktree.id));

    const updated = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(updated!.mergedAt).toBeTruthy();
  });

  it('preserves branch and baseBranch through transitions', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const worktree = await createTestWorktree(project.id, {
      status: 'creating',
      branch: 'agent/feature-123/task',
      baseBranch: 'develop',
    });

    expect(worktree.branch).toBe('agent/feature-123/task');
    expect(worktree.baseBranch).toBe('develop');

    await db.update(worktrees).set({ status: 'active' }).where(eq(worktrees.id, worktree.id));
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const final = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(final!.branch).toBe('agent/feature-123/task');
    expect(final!.baseBranch).toBe('develop');
    expect(final!.status).toBe('removed');
  });

  it('supports error status', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const worktree = await createTestWorktree(project.id, { status: 'active' });

    await db.update(worktrees).set({ status: 'error' }).where(eq(worktrees.id, worktree.id));

    const errored = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(errored!.status).toBe('error');
  });
});
