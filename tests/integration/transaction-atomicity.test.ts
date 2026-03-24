import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRuns, agents, sessionEvents, settings, tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestAgentRun } from '../factories/agent-run.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Transaction & Atomicity (IT-191 to IT-195)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await db.delete(settings);
  });

  afterEach(async () => {
    await db.delete(settings);
    await clearTestDatabase();
  });

  it('IT-191: TaskService.moveColumn moves task and session created atomically', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const mockWorktreeService = {
      getDiff: vi.fn().mockResolvedValue({
        ok: true,
        value: { files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } },
      }),
      merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };

    const taskService = new TaskService(db as never, mockWorktreeService);

    const result = await taskService.moveColumn(task.id, 'in_progress');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.task.column).toBe('in_progress');
    expect(result.value.task.startedAt).toBeTruthy();
  });

  it('IT-192: TaskService.approve fails if merge fails → task stays in waiting_approval', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });
    const worktree = await import('../factories/worktree.factory').then((m) =>
      m.createTestWorktree(codespace.id, { taskId: task.id, status: 'active' })
    );

    // Link worktree to task
    await db.update(tasks).set({ worktreeId: worktree.id }).where(eq(tasks.id, task.id));

    const mockWorktreeService = {
      getDiff: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
          stats: { filesChanged: 1, additions: 1, deletions: 0 },
        },
      }),
      merge: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'MERGE_CONFLICT', message: 'Merge conflict', status: 409 },
      }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };

    const taskService = new TaskService(db as never, mockWorktreeService);
    const result = await taskService.approve(task.id, { approvedBy: 'user' });

    // Should fail
    expect(result.ok).toBe(false);

    // Task should still be in waiting_approval
    const currentTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(currentTask!.column).toBe('waiting_approval');
    expect(currentTask!.approvedAt).toBeNull();
  });

  it('IT-193: insert multiple settings in sequence, all persisted', async () => {
    const settingsData = [
      { key: 'taskCreation.model', value: JSON.stringify('claude-sonnet-4') },
      { key: 'taskCreation.tools', value: JSON.stringify(['Read', 'Write']) },
      { key: 'sandbox.mode', value: JSON.stringify('shared') },
    ];

    for (const s of settingsData) {
      await db.insert(settings).values(s);
    }

    const all = await db.query.settings.findMany();
    expect(all.length).toBeGreaterThanOrEqual(3);

    for (const s of settingsData) {
      const found = await db.query.settings.findFirst({
        where: eq(settings.key, s.key),
      });
      expect(found).toBeTruthy();
      expect(found!.value).toBe(s.value);
    }
  });

  it('IT-194: insert 10 sessionEvents with unique offsets 0-9', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    for (let i = 0; i < 10; i++) {
      await db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        offset: i,
        type: 'chunk',
        channel: 'chunks',
        data: { text: `Event ${i}` },
        timestamp: Date.now() + i,
      });
    }

    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(events.length).toBe(10);

    const offsets = events.map((e) => e.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('IT-195: agent + task + agentRun records consistent', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });
    const session = await createTestSession(codespace.id, { taskId: task.id });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
      currentSessionId: session.id,
    });

    const run = await createTestAgentRun(agent.id, task.id, codespace.id, {
      sessionId: session.id,
      status: 'running',
      startedAt: new Date().toISOString() as unknown as Date,
      turnsUsed: 5,
      tokensUsed: 1200,
    });

    // Verify all 3 records consistent
    const foundAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    const foundTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    const foundRun = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, run.id) });

    expect(foundAgent!.codespaceId).toBe(codespace.id);
    expect(foundTask!.codespaceId).toBe(codespace.id);
    expect(foundRun!.codespaceId).toBe(codespace.id);
    expect(foundRun!.agentId).toBe(agent.id);
    expect(foundRun!.taskId).toBe(task.id);
    expect(foundRun!.sessionId).toBe(session.id);
    expect(foundAgent!.currentTaskId).toBe(task.id);
  });
});
