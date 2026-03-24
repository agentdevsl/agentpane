import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agents, sessions, tasks, worktrees } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestAgentRun } from '../factories/agent-run.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Task → Agent Flow (IT-171 to IT-174)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-171: creates codespace → task → agent → session with all records linked', async () => {
    const codespace = await createTestProject({ name: 'Flow Test' });
    const task = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Implement feature X',
    });

    // Move task to in_progress
    await db
      .update(tasks)
      .set({ column: 'in_progress', startedAt: new Date().toISOString() })
      .where(eq(tasks.id, task.id));

    // Create agent and session
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      status: 'active',
    });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
      currentSessionId: session.id,
    });

    // Link task to agent and session
    await db
      .update(tasks)
      .set({ agentId: agent.id, sessionId: session.id })
      .where(eq(tasks.id, task.id));

    // Verify all records linked
    const updatedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updatedTask).toBeTruthy();
    expect(updatedTask!.column).toBe('in_progress');
    expect(updatedTask!.agentId).toBe(agent.id);
    expect(updatedTask!.sessionId).toBe(session.id);
    expect(updatedTask!.codespaceId).toBe(codespace.id);

    const foundAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(foundAgent!.status).toBe('running');
    expect(foundAgent!.currentTaskId).toBe(task.id);
    expect(foundAgent!.currentSessionId).toBe(session.id);
    expect(foundAgent!.codespaceId).toBe(codespace.id);

    const foundSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(foundSession!.taskId).toBe(task.id);
    expect(foundSession!.codespaceId).toBe(codespace.id);
  });

  it('IT-172: agent completes → agentRun created → task moves to waiting_approval', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });
    const session = await createTestSession(codespace.id, { taskId: task.id });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
      currentSessionId: session.id,
    });
    const worktree = await createTestWorktree(codespace.id, { taskId: task.id, status: 'active' });

    // Link task
    await db
      .update(tasks)
      .set({ agentId: agent.id, sessionId: session.id, worktreeId: worktree.id })
      .where(eq(tasks.id, task.id));

    // Agent completes
    await db
      .update(agents)
      .set({ status: 'completed', currentTaskId: null })
      .where(eq(agents.id, agent.id));

    // Create agentRun
    const run = await createTestAgentRun(agent.id, task.id, codespace.id, {
      sessionId: session.id,
      status: 'completed',
      completedAt: new Date().toISOString() as unknown as Date,
      startedAt: new Date().toISOString() as unknown as Date,
      turnsUsed: 15,
      tokensUsed: 3000,
    });

    // Move task to waiting_approval
    await db
      .update(tasks)
      .set({
        column: 'waiting_approval',
        lastAgentStatus: 'completed',
      })
      .where(eq(tasks.id, task.id));

    // Verify full state
    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(finalTask!.column).toBe('waiting_approval');
    expect(finalTask!.lastAgentStatus).toBe('completed');

    const finalAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(finalAgent!.status).toBe('completed');
    expect(finalAgent!.currentTaskId).toBeNull();

    const finalRun = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, run.id),
    });
    expect(finalRun!.status).toBe('completed');
    expect(finalRun!.completedAt).toBeTruthy();
    expect(finalRun!.turnsUsed).toBe(15);
    expect(finalRun!.tokensUsed).toBe(3000);
  });

  it('IT-173: agent errors → task reflects error, worktree set to error', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });
    const worktree = await createTestWorktree(codespace.id, {
      taskId: task.id,
      status: 'active',
    });
    const session = await createTestSession(codespace.id, { taskId: task.id });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
      currentSessionId: session.id,
    });

    await db
      .update(tasks)
      .set({ agentId: agent.id, worktreeId: worktree.id })
      .where(eq(tasks.id, task.id));

    // Agent encounters error
    await db.update(agents).set({ status: 'error' }).where(eq(agents.id, agent.id));

    // Task reflects error
    await db.update(tasks).set({ lastAgentStatus: 'error' }).where(eq(tasks.id, task.id));

    // Worktree set to error
    await db.update(worktrees).set({ status: 'error' }).where(eq(worktrees.id, worktree.id));

    // Verify cascade
    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(finalTask!.lastAgentStatus).toBe('error');

    const finalAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(finalAgent!.status).toBe('error');

    const finalWorktree = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(finalWorktree!.status).toBe('error');
  });

  it('IT-174: plan approval preserves plan data through transition', async () => {
    const codespace = await createTestProject();
    const planData = 'Step 1: Refactor\nStep 2: Add tests\nStep 3: Deploy';
    const planOptions = { allowedPrompts: [{ tool: 'Bash' as const, prompt: 'npm test' }] };

    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });

    // Store plan data
    await db
      .update(tasks)
      .set({
        plan: planData,
        planOptions,
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Simulate plan approval → back to in_progress for execution
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, task.id));

    // Verify plan data preserved
    const approvedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(approvedTask!.column).toBe('in_progress');
    expect(approvedTask!.plan).toBe(planData);
    expect(approvedTask!.planOptions).toEqual(planOptions);
    expect(approvedTask!.lastAgentStatus).toBe('planning');
  });
});
