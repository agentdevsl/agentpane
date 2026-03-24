import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeStatus } from '../../src/db/schema';
import { tasks, worktrees } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-061–065: Worktree Create & Diff', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-061: creates worktree with specific branch and verifies DB record fields', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Feature Task' });

    const worktree = await createTestWorktree(project.id, {
      branch: 'feature/login-fix-abc123',
      baseBranch: 'develop',
      taskId: task.id,
      status: 'active',
      path: '/tmp/worktrees/login-fix',
    });

    expect(worktree).toBeDefined();
    expect(worktree.branch).toBe('feature/login-fix-abc123');
    expect(worktree.baseBranch).toBe('develop');
    expect(worktree.status).toBe('active');
    expect(worktree.path).toBe('/tmp/worktrees/login-fix');
    expect(worktree.codespaceId).toBe(project.id);
    expect(worktree.taskId).toBe(task.id);
    expect(worktree.mergedAt).toBeNull();
    expect(worktree.removedAt).toBeNull();
    expect(worktree.createdAt).toBeTruthy();
  });

  it('IT-062: creates worktrees with various statuses and verifies each is stored', async () => {
    const project = await createTestProject();

    const statuses: WorktreeStatus[] = [
      'creating',
      'active',
      'merging',
      'removing',
      'removed',
      'error',
    ];
    const created: Array<{ id: string; expectedStatus: WorktreeStatus }> = [];

    for (const status of statuses) {
      const wt = await createTestWorktree(project.id, { status });
      created.push({ id: wt.id, expectedStatus: status });
    }

    // Verify each status was stored correctly
    for (const { id, expectedStatus } of created) {
      const retrieved = await db.query.worktrees.findFirst({
        where: eq(worktrees.id, id),
      });
      expect(retrieved).toBeDefined();
      expect(retrieved!.status).toBe(expectedStatus);
    }
  });

  it('IT-063: stores diffSummary on task and verifies data shape', async () => {
    const project = await createTestProject();

    // Create task with a diffSummary (simulates what happens after agent work)
    const diffSummary = {
      filesChanged: 3,
      additions: 42,
      deletions: 10,
      files: [
        { path: 'src/index.ts', additions: 20, deletions: 5 },
        { path: 'src/utils.ts', additions: 12, deletions: 3 },
        { path: 'README.md', additions: 10, deletions: 2 },
      ],
    };

    const task = await createTestTask(project.id, {
      title: 'Diff Task',
      diffSummary,
    });

    const retrieved = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.diffSummary).toBeDefined();
    expect((retrieved!.diffSummary as typeof diffSummary).filesChanged).toBe(3);
    expect((retrieved!.diffSummary as typeof diffSummary).additions).toBe(42);
    expect((retrieved!.diffSummary as typeof diffSummary).deletions).toBe(10);
    expect((retrieved!.diffSummary as typeof diffSummary).files).toHaveLength(3);
  });

  it('IT-064: task with no diff has null diffSummary', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      title: 'No Diff Task',
    });

    const retrieved = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.diffSummary).toBeNull();
  });

  it('IT-065: multiple worktrees for same codespace are tracked independently', async () => {
    const project = await createTestProject();

    const wt1 = await createTestWorktree(project.id, {
      branch: 'feature/auth',
      status: 'active',
    });
    const wt2 = await createTestWorktree(project.id, {
      branch: 'feature/dashboard',
      status: 'creating',
    });
    const wt3 = await createTestWorktree(project.id, {
      branch: 'fix/bug-123',
      status: 'merging',
    });

    // All belong to same codespace
    expect(wt1.codespaceId).toBe(project.id);
    expect(wt2.codespaceId).toBe(project.id);
    expect(wt3.codespaceId).toBe(project.id);

    // Each has unique id and branch
    const ids = [wt1.id, wt2.id, wt3.id];
    expect(new Set(ids).size).toBe(3);

    const branches = [wt1.branch, wt2.branch, wt3.branch];
    expect(new Set(branches).size).toBe(3);

    // Each has its own status
    expect(wt1.status).toBe('active');
    expect(wt2.status).toBe('creating');
    expect(wt3.status).toBe('merging');

    // Query all worktrees for this codespace
    const allWts = await db.query.worktrees.findMany({
      where: eq(worktrees.codespaceId, project.id),
    });
    expect(allWts).toHaveLength(3);
  });
});
