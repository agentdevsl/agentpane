import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktrees } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-066–070: Worktree Merge & Remove', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-066: transitions worktree to merging then active with mergedAt set', async () => {
    const project = await createTestProject();
    const worktree = await createTestWorktree(project.id, { status: 'active' });

    // Transition to merging
    await db
      .update(worktrees)
      .set({ status: 'merging', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const merging = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(merging!.status).toBe('merging');

    // Merge succeeds: back to active with mergedAt
    const mergedAt = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'active', mergedAt, updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const merged = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(merged!.status).toBe('active');
    expect(merged!.mergedAt).toBeTruthy();
    expect(merged!.mergedAt).toBe(mergedAt);
  });

  it('IT-067: sets worktree to error status on merge conflict', async () => {
    const project = await createTestProject();
    const worktree = await createTestWorktree(project.id, { status: 'active' });

    // Transition to merging
    await db
      .update(worktrees)
      .set({ status: 'merging', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    // Merge conflict: transition to error
    await db
      .update(worktrees)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const errored = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(errored!.status).toBe('error');
    expect(errored!.mergedAt).toBeNull();
  });

  it('IT-068: transitions active -> removing -> removed with removedAt', async () => {
    const project = await createTestProject();
    const worktree = await createTestWorktree(project.id, { status: 'active' });

    // active -> removing
    await db
      .update(worktrees)
      .set({ status: 'removing', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const removing = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(removing!.status).toBe('removing');
    expect(removing!.removedAt).toBeNull();

    // removing -> removed
    const removedAt = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt, updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const removed = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(removed!.status).toBe('removed');
    expect(removed!.removedAt).toBe(removedAt);
  });

  it('IT-069: sets worktree to error status on removal failure', async () => {
    const project = await createTestProject();
    const worktree = await createTestWorktree(project.id, { status: 'active' });

    // Attempt removal: active -> removing
    await db
      .update(worktrees)
      .set({ status: 'removing', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    // Removal fails: set to error (no removedAt)
    await db
      .update(worktrees)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktree.id));

    const errored = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(errored!.status).toBe('error');
    expect(errored!.removedAt).toBeNull();
  });

  it('IT-070: worktrees across 2 codespaces are isolated per-codespace', async () => {
    const projectA = await createTestProject({ name: 'Project A' });
    const projectB = await createTestProject({ name: 'Project B' });

    // Create 3 worktrees in project A
    await createTestWorktree(projectA.id, { branch: 'a/feat-1', status: 'active' });
    await createTestWorktree(projectA.id, { branch: 'a/feat-2', status: 'merging' });
    await createTestWorktree(projectA.id, { branch: 'a/feat-3', status: 'removed' });

    // Create 2 worktrees in project B
    await createTestWorktree(projectB.id, { branch: 'b/feat-1', status: 'active' });
    await createTestWorktree(projectB.id, { branch: 'b/feat-2', status: 'creating' });

    // Query per codespace and verify isolation
    const worktreesA = await db.query.worktrees.findMany({
      where: eq(worktrees.codespaceId, projectA.id),
    });
    expect(worktreesA).toHaveLength(3);
    for (const wt of worktreesA) {
      expect(wt.codespaceId).toBe(projectA.id);
      expect(wt.branch.startsWith('a/')).toBe(true);
    }

    const worktreesB = await db.query.worktrees.findMany({
      where: eq(worktrees.codespaceId, projectB.id),
    });
    expect(worktreesB).toHaveLength(2);
    for (const wt of worktreesB) {
      expect(wt.codespaceId).toBe(projectB.id);
      expect(wt.branch.startsWith('b/')).toBe(true);
    }

    // Total is 5
    const allWorktrees = await db.query.worktrees.findMany();
    expect(allWorktrees).toHaveLength(5);
  });
});
