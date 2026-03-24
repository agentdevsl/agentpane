import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agents, tasks } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createCompletedAgentRun } from '../factories/agent-run.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Agent Pause/Resume/Queue (IT-082 to IT-085)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-082: pause a running agent — status transitions to paused with updatedAt refresh', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      name: 'Pausable Agent',
    });

    const originalUpdatedAt = agent.updatedAt;

    // Small delay to ensure updatedAt differs
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate pause
    const pauseTime = new Date().toISOString();
    await db
      .update(agents)
      .set({
        status: 'paused',
        updatedAt: pauseTime,
      })
      .where(eq(agents.id, agent.id));

    const pausedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });

    expect(pausedAgent).toBeDefined();
    expect(pausedAgent!.status).toBe('paused');
    expect(pausedAgent!.updatedAt).toBe(pauseTime);
    expect(pausedAgent!.updatedAt).not.toBe(originalUpdatedAt);
  });

  it('IT-083: resume a paused agent — status transitions back to running', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, {
      status: 'paused',
      name: 'Resumable Agent',
    });

    expect(agent.status).toBe('paused');

    // Simulate resume
    const resumeTime = new Date().toISOString();
    await db
      .update(agents)
      .set({
        status: 'running',
        updatedAt: resumeTime,
      })
      .where(eq(agents.id, agent.id));

    const resumedAgent = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
    });

    expect(resumedAgent).toBeDefined();
    expect(resumedAgent!.status).toBe('running');
    expect(resumedAgent!.updatedAt).toBe(resumeTime);
  });

  it('IT-084: queued tasks dequeue in FIFO order by position ASC', async () => {
    const codespace = await createTestProject();

    // Create 3 tasks in queued column with explicit positions
    const task1 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 0,
      title: 'First in queue',
    });
    const task2 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 1,
      title: 'Second in queue',
    });
    const task3 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 2,
      title: 'Third in queue',
    });

    // Query in FIFO order (position ASC)
    const queuedTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespace.id), eq(tasks.column, 'queued')),
      orderBy: [asc(tasks.position)],
    });

    expect(queuedTasks).toHaveLength(3);
    expect(queuedTasks[0].id).toBe(task1.id);
    expect(queuedTasks[1].id).toBe(task2.id);
    expect(queuedTasks[2].id).toBe(task3.id);

    // Dequeue first: get position 0
    const firstDequeued = await db.query.tasks.findFirst({
      where: and(eq(tasks.codespaceId, codespace.id), eq(tasks.column, 'queued')),
      orderBy: [asc(tasks.position)],
    });

    expect(firstDequeued).toBeDefined();
    expect(firstDequeued!.id).toBe(task1.id);
    expect(firstDequeued!.title).toBe('First in queue');
  });

  it('IT-085: calculate average completion time from agentRuns with completedAt', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { name: 'Stats Agent' });
    const task = await createTestTask(codespace.id, { title: 'Stats Task' });

    // Create completed runs with known durations
    // The factory uses Date objects but SQLite needs strings, so cast via unknown
    // Run 1: 10 seconds (10000ms)
    await createCompletedAgentRun(agent.id, task.id, codespace.id, {
      startedAt: '2026-01-01T00:00:00.000Z' as unknown as Date,
      completedAt: '2026-01-01T00:00:10.000Z' as unknown as Date,
    });

    // Run 2: 20 seconds (20000ms)
    await createCompletedAgentRun(agent.id, task.id, codespace.id, {
      startedAt: '2026-01-01T00:01:00.000Z' as unknown as Date,
      completedAt: '2026-01-01T00:01:20.000Z' as unknown as Date,
    });

    // Run 3: 30 seconds (30000ms)
    await createCompletedAgentRun(agent.id, task.id, codespace.id, {
      startedAt: '2026-01-01T00:02:00.000Z' as unknown as Date,
      completedAt: '2026-01-01T00:02:30.000Z' as unknown as Date,
    });

    // Query completed runs and calculate average manually
    const completedRuns = await db.query.agentRuns.findMany({
      where: eq(agentRuns.codespaceId, codespace.id),
    });

    // Filter those with both startedAt and completedAt
    const validRuns = completedRuns.filter((r) => r.startedAt && r.completedAt);
    expect(validRuns.length).toBe(3);

    let totalDurationMs = 0;
    for (const run of validRuns) {
      const startMs = new Date(run.startedAt).getTime();
      const endMs = new Date(run.completedAt!).getTime();
      totalDurationMs += endMs - startMs;
    }

    const averageMs = Math.round(totalDurationMs / validRuns.length);
    // (10000 + 20000 + 30000) / 3 = 20000
    expect(averageMs).toBe(20000);
  });
});
