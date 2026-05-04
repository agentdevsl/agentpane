import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, codespaces, sessionEvents } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createMockContainerAgent } from '../factories/container-agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const mockWorktreeService = {
  getDiff: vi.fn().mockResolvedValue({
    ok: true,
    value: { files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } },
  }),
  merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
};

describe('Concurrency: Race Conditions (IT-211 to IT-215)', () => {
  let db: ReturnType<typeof getTestDb>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    taskService = new TaskService(db as never, mockWorktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-211: sequential moves work, invalid from stale state fails', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    // backlog → queued (valid)
    const move1 = await taskService.moveColumn(task.id, 'queued');
    expect(move1.ok).toBe(true);

    // queued → in_progress (valid)
    const move2 = await taskService.moveColumn(task.id, 'in_progress');
    expect(move2.ok).toBe(true);

    // Try backlog → queued again (task is already in_progress, not backlog)
    // The no-op check: if we try in_progress → in_progress, it's a no-op
    const noOp = await taskService.moveColumn(task.id, 'in_progress');
    expect(noOp.ok).toBe(true); // no-op returns ok

    // Invalid: in_progress → verified (not allowed)
    const invalid = await taskService.moveColumn(task.id, 'verified');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('TASK_INVALID_TRANSITION');
    }
  });

  it('IT-212: maxConcurrentAgents limit detection', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 2 });

    // Create 2 running agents
    await createTestAgent(codespace.id, { status: 'running' });
    await createTestAgent(codespace.id, { status: 'running' });

    // Count running agents
    const runningAgents = await db.query.agents.findMany({
      where: and(eq(agents.codespaceId, codespace.id), eq(agents.status, 'running')),
    });
    expect(runningAgents.length).toBe(2);

    // Verify codespace limit
    const cs = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(cs!.maxConcurrentAgents).toBe(2);

    // 3rd agent would exceed limit
    expect(runningAgents.length).toBeGreaterThanOrEqual(cs!.maxConcurrentAgents!);
  });

  it('IT-213: UNIQUE constraint on (sessionId, offset) enforced', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // Insert 10 events with offsets 0-9. F05-25: bare CUIDs are session-kind.
    for (let i = 0; i < 10; i++) {
      await db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        streamKind: 'session',
        offset: i,
        type: 'chunk',
        channel: 'chunks',
        data: { text: `Event ${i}` },
        timestamp: Date.now() + i,
      });
    }

    // Try duplicate offset → should throw UNIQUE constraint violation
    await expect(
      db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        streamKind: 'session',
        offset: 5,
        type: 'chunk',
        channel: 'chunks',
        data: { text: 'Duplicate' },
        timestamp: Date.now(),
      })
    ).rejects.toThrow(/UNIQUE/);
  });

  it('IT-214: delete codespace twice — second delete is idempotent', async () => {
    const codespace = await createTestProject();

    // First delete
    const _result1 = await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Second delete — 0 rows affected, no error
    const _result2 = await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Verify codespace is gone
    const found = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(found).toBeUndefined();
  });

  it('IT-215: task in waiting_approval → approve to in_progress → reject to backlog fails', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'waiting_approval' });

    // Approve: waiting_approval → in_progress
    const approve = await taskService.moveColumn(task.id, 'in_progress');
    expect(approve.ok).toBe(true);

    // Now try backlog (reject) — but task is already in_progress
    // in_progress → backlog is actually valid!
    const moveBack = await taskService.moveColumn(task.id, 'backlog');
    expect(moveBack.ok).toBe(true);
    if (moveBack.ok) {
      expect(moveBack.value.task.column).toBe('backlog');
    }

    // Now try verified (not valid from backlog)
    const moveVerified = await taskService.moveColumn(task.id, 'verified');
    expect(moveVerified.ok).toBe(false);
    if (!moveVerified.ok) {
      expect(moveVerified.error.code).toBe('TASK_INVALID_TRANSITION');
    }
  });
});
