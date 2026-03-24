import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('PlanApprovalService — DB-level integration tests', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-113: stores plan data, planOptions, lastAgentStatus, and column on task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const planText = '## Implementation Plan\n1. Create module\n2. Add tests\n3. Deploy';
    const planOptions = {
      allowedPrompts: [{ tool: 'Bash' as const, prompt: 'npm test' }],
      launchSwarm: false,
      teammateCount: 0,
      sdkSessionId: 'sdk-session-123',
      planningSandboxId: 'sandbox-456',
    };

    await db
      .update(tasks)
      .set({
        plan: planText,
        planOptions,
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
      })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.plan).toBe(planText);
    expect(dbTask?.planOptions).toEqual(planOptions);
    expect(dbTask?.lastAgentStatus).toBe('planning');
    expect(dbTask?.column).toBe('waiting_approval');
  });

  it('IT-114: updating nonexistent task has no side effects', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'backlog' });

    const nonexistentId = 'nonexistent-task-id-12345';

    // Attempt to update a task that does not exist
    const result = await db
      .update(tasks)
      .set({ plan: 'Should not be stored', column: 'waiting_approval' })
      .where(eq(tasks.id, nonexistentId))
      .returning();

    expect(result).toHaveLength(0);

    // Original task is unchanged
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('backlog');
    expect(dbTask?.plan).toBeNull();
  });

  it('IT-115: plan approval moves task from waiting_approval to in_progress', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'waiting_approval' });

    await db
      .update(tasks)
      .set({
        plan: 'Approved plan content',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Approve: move to in_progress
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('in_progress');
    expect(dbTask?.plan).toBe('Approved plan content');
  });

  it('IT-116: task without plan data — plan is null', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.plan).toBeNull();
    expect(dbTask?.planOptions).toBeNull();
    expect(dbTask?.lastAgentStatus).toBeNull();
  });

  it('IT-117: plan rejection clears all plan fields and moves to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'waiting_approval' });

    // Set plan data
    await db
      .update(tasks)
      .set({
        plan: 'Plan to reject',
        planOptions: { allowedPrompts: [], sdkSessionId: 'sdk-123' },
        lastAgentStatus: 'planning',
        worktreeId: null,
        branch: 'agent/test-branch',
      })
      .where(eq(tasks.id, task.id));

    // Reject: clear everything and move to backlog
    await db
      .update(tasks)
      .set({
        column: 'backlog',
        plan: null,
        planOptions: null,
        lastAgentStatus: null,
        worktreeId: null,
        branch: null,
        rejectionReason: 'Needs more detail in step 3',
        rejectionCount: 1,
      })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('backlog');
    expect(dbTask?.plan).toBeNull();
    expect(dbTask?.planOptions).toBeNull();
    expect(dbTask?.lastAgentStatus).toBeNull();
    expect(dbTask?.worktreeId).toBeNull();
    expect(dbTask?.branch).toBeNull();
    expect(dbTask?.rejectionReason).toBe('Needs more detail in step 3');
    expect(dbTask?.rejectionCount).toBe(1);
  });

  it('IT-118: task with lastAgentStatus != planning is not a pending plan', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    // Create tasks with various non-planning statuses
    const task1 = await createTestTask(project.id, { column: 'waiting_approval' });
    const task2 = await createTestTask(project.id, { column: 'waiting_approval' });
    const task3 = await createTestTask(project.id, { column: 'waiting_approval' });

    await db.update(tasks).set({ lastAgentStatus: 'completed' }).where(eq(tasks.id, task1.id));
    await db.update(tasks).set({ lastAgentStatus: 'error' }).where(eq(tasks.id, task2.id));
    await db.update(tasks).set({ lastAgentStatus: 'planning' }).where(eq(tasks.id, task3.id));

    // Query for pending plans: waiting_approval AND lastAgentStatus = 'planning'
    const pendingPlans = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'waiting_approval'), eq(tasks.lastAgentStatus, 'planning')),
    });

    expect(pendingPlans).toHaveLength(1);
    expect(pendingPlans[0]?.id).toBe(task3.id);
  });

  it('IT-119: plan data roundtrip — store and retrieve JSON plan options', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const complexPlanOptions = {
      allowedPrompts: [
        { tool: 'Bash' as const, prompt: 'npm install' },
        { tool: 'Bash' as const, prompt: 'npm test' },
      ],
      launchSwarm: true,
      teammateCount: 3,
      pushToRemote: true,
      sdkSessionId: 'sdk-abc-def',
      planningSandboxId: 'sandbox-xyz',
    };

    await db
      .update(tasks)
      .set({
        plan: 'Multi-agent plan:\n1. Agent A handles frontend\n2. Agent B handles backend\n3. Agent C handles tests',
        planOptions: complexPlanOptions,
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.planOptions).toEqual(complexPlanOptions);
    expect((dbTask?.planOptions as typeof complexPlanOptions)?.launchSwarm).toBe(true);
    expect((dbTask?.planOptions as typeof complexPlanOptions)?.teammateCount).toBe(3);
    expect((dbTask?.planOptions as typeof complexPlanOptions)?.allowedPrompts).toHaveLength(2);
  });

  it('IT-120: queries pending plans using DB fallback pattern (column + lastAgentStatus)', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    // Create multiple tasks in different states
    const pendingTask = await createTestTask(project.id, { column: 'waiting_approval' });
    await createTestTask(project.id, { column: 'backlog' });
    await createTestTask(project.id, { column: 'in_progress' });
    const completedTask = await createTestTask(project.id, { column: 'waiting_approval' });

    // Set plan data on the pending one
    await db
      .update(tasks)
      .set({
        plan: 'Ready for review',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, pendingTask.id));

    // Completed task has different status
    await db
      .update(tasks)
      .set({ lastAgentStatus: 'completed' })
      .where(eq(tasks.id, completedTask.id));

    // DB fallback query: find all tasks in waiting_approval with planning status
    const pending = await db.query.tasks.findMany({
      where: and(
        eq(tasks.column, 'waiting_approval'),
        eq(tasks.lastAgentStatus, 'planning'),
        eq(tasks.codespaceId, project.id)
      ),
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(pendingTask.id);
    expect(pending[0]?.plan).toBe('Ready for review');
  });
});
