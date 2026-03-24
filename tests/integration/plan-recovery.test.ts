import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-019: Plan Recovery from Database', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('recovers plan data stored on the task record', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      worktreeId: 'wt-123',
      branch: 'agent/task/feature',
    });

    await db
      .update(tasks)
      .set({
        plan: 'Step 1: Implement feature\nStep 2: Write tests',
        planOptions: { allowedPrompts: [{ tool: 'Bash' as const, prompt: 'npm test' }] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    const recovered = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(recovered).toBeDefined();
    expect(recovered!.plan).toBe('Step 1: Implement feature\nStep 2: Write tests');
    expect(recovered!.lastAgentStatus).toBe('planning');
    expect(recovered!.worktreeId).toBe('wt-123');
    expect(recovered!.branch).toBe('agent/task/feature');

    const options = recovered!.planOptions as {
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    } | null;
    expect(options).toBeDefined();
    expect(options!.allowedPrompts).toEqual([{ tool: 'Bash', prompt: 'npm test' }]);
  });

  it('preserves plan data when task is moved to backlog (rejection)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
    });

    await db
      .update(tasks)
      .set({
        plan: 'Step 1: Refactor module\nStep 2: Add tests',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    const moveResult = await taskService.moveColumn(task.id, 'backlog');
    expect(moveResult.ok).toBe(true);

    const movedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(movedTask!.column).toBe('backlog');
    expect(movedTask!.plan).toBe('Step 1: Refactor module\nStep 2: Add tests');
    expect(movedTask!.lastAgentStatus).toBe('planning');
  });

  it('creates task without plan data — plan is null', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const task = await createTestTask(codespace.id, {
      column: 'backlog',
    });

    const retrieved = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.plan).toBeNull();
    expect(retrieved!.planOptions).toBeNull();
    expect(retrieved!.lastAgentStatus).toBeNull();
  });
});
