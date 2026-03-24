import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessions, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Container Agent (IT-187 to IT-188)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-187: full container agent state machine at DB level', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog', title: 'Container task' });

    // Step 1: backlog → in_progress
    await db
      .update(tasks)
      .set({ column: 'in_progress', startedAt: new Date().toISOString() })
      .where(eq(tasks.id, task.id));

    let current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(current!.column).toBe('in_progress');

    // Step 2: agent assigned
    const agent = await createTestAgent(codespace.id, { status: 'running' });
    await db.update(tasks).set({ agentId: agent.id }).where(eq(tasks.id, task.id));

    // Step 3: plan stored
    await db
      .update(tasks)
      .set({
        plan: '1. Analyze code\n2. Make changes\n3. Test',
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Step 4: in_progress → waiting_approval (plan ready)
    await db.update(tasks).set({ column: 'waiting_approval' }).where(eq(tasks.id, task.id));

    current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(current!.column).toBe('waiting_approval');
    expect(current!.plan).toContain('Analyze code');

    // Step 5: approved → back to in_progress
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, task.id));

    // Step 6: agent completes → waiting_approval
    await db
      .update(tasks)
      .set({
        column: 'waiting_approval',
        lastAgentStatus: 'completed',
      })
      .where(eq(tasks.id, task.id));

    current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(current!.column).toBe('waiting_approval');
    expect(current!.lastAgentStatus).toBe('completed');

    // Verify every state was visited
    expect(current!.plan).toBeTruthy();
    expect(current!.agentId).toBe(agent.id);
    expect(current!.startedAt).toBeTruthy();
  });

  it('IT-188: two agents for same codespace with independent worktrees and sessions', async () => {
    const codespace = await createTestProject();

    // Agent 1 with its own task, session, worktree
    const task1 = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task A',
    });
    const session1 = await createTestSession(codespace.id, {
      taskId: task1.id,
      status: 'active',
    });
    const worktree1 = await createTestWorktree(codespace.id, {
      taskId: task1.id,
      status: 'active',
    });
    const agent1 = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task1.id,
      currentSessionId: session1.id,
      name: 'Agent A',
    });

    // Agent 2 with its own task, session, worktree
    const task2 = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task B',
    });
    const session2 = await createTestSession(codespace.id, {
      taskId: task2.id,
      status: 'active',
    });
    const worktree2 = await createTestWorktree(codespace.id, {
      taskId: task2.id,
      status: 'active',
    });
    const agent2 = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task2.id,
      currentSessionId: session2.id,
      name: 'Agent B',
    });

    // Verify independence
    expect(agent1.id).not.toBe(agent2.id);
    expect(session1.id).not.toBe(session2.id);
    expect(worktree1.id).not.toBe(worktree2.id);
    expect(worktree1.branch).not.toBe(worktree2.branch);

    // Both agents belong to same codespace
    expect(agent1.codespaceId).toBe(codespace.id);
    expect(agent2.codespaceId).toBe(codespace.id);

    // Each agent has its own task
    expect(agent1.currentTaskId).toBe(task1.id);
    expect(agent2.currentTaskId).toBe(task2.id);

    // Sessions are independent
    const s1 = await db.query.sessions.findFirst({ where: eq(sessions.id, session1.id) });
    const s2 = await db.query.sessions.findFirst({ where: eq(sessions.id, session2.id) });
    expect(s1!.taskId).toBe(task1.id);
    expect(s2!.taskId).toBe(task2.id);
  });
});
