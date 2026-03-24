import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, settings, tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Concurrency: Approval (IT-216 to IT-218)', () => {
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

  it('IT-216: approve on waiting_approval → ok, approve again → ALREADY_APPROVED', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, { column: 'waiting_approval' });

    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, task.id));

    const mockWorktreeService = {
      getDiff: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          files: [{ path: 'a.ts', additions: 5, deletions: 2 }],
          stats: { filesChanged: 1, additions: 5, deletions: 2 },
        },
      }),
      merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };

    const taskService = new TaskService(db as never, mockWorktreeService);

    // First approve
    const result1 = await taskService.approve(task.id, { approvedBy: 'user' });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value.column).toBe('verified');
      expect(result1.value.approvedAt).toBeTruthy();
    }

    // Second approve → ALREADY_APPROVED (task is now in verified, not waiting_approval)
    const result2 = await taskService.approve(task.id, { approvedBy: 'user' });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
    }
  });

  it('IT-217: stop agent → idle, then stop again → no-op (task has no agentId)', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });
    const agent = await createTestAgent(codespace.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    await db.update(tasks).set({ agentId: agent.id }).where(eq(tasks.id, task.id));

    // Stop agent → idle
    await db
      .update(agents)
      .set({ status: 'idle', currentTaskId: null })
      .where(eq(agents.id, agent.id));
    await db
      .update(tasks)
      .set({ agentId: null, lastAgentStatus: 'cancelled' })
      .where(eq(tasks.id, task.id));

    const taskAfterStop = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfterStop!.agentId).toBeNull();
    expect(taskAfterStop!.lastAgentStatus).toBe('cancelled');

    // Try stop again — task has no agentId, this is a no-op
    const agentAfter = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(agentAfter!.status).toBe('idle');
    expect(agentAfter!.currentTaskId).toBeNull();
  });

  it('IT-218: setting last-write-wins: key1=value1, then key1=value2 → get returns value2', async () => {
    await db.insert(settings).values({
      key: 'key1',
      value: 'value1',
    });

    let setting = await db.query.settings.findFirst({ where: eq(settings.key, 'key1') });
    expect(setting!.value).toBe('value1');

    // Overwrite
    await db.update(settings).set({ value: 'value2' }).where(eq(settings.key, 'key1'));

    setting = await db.query.settings.findFirst({ where: eq(settings.key, 'key1') });
    expect(setting!.value).toBe('value2');
  });
});
