import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createMockContainerAgent } from '../factories/container-agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Error Propagation: Stream (IT-209 to IT-210)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-209: sessionEvent inserted directly is persisted without stream', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const eventId = createId();
    // F05-25: bare CUIDs are session-kind.
    await db.insert(sessionEvents).values({
      id: eventId,
      sessionId: session.id,
      streamKind: 'session',
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'Direct insert without stream' },
      timestamp: Date.now(),
    });

    const event = await db.query.sessionEvents.findFirst({
      where: eq(sessionEvents.id, eventId),
    });
    expect(event).toBeTruthy();
    expect(event!.type).toBe('chunk');
    expect(event!.sessionId).toBe(session.id);
    expect((event!.data as Record<string, unknown>).text).toBe('Direct insert without stream');
  });

  it('IT-210: concurrent task moves — second move gets INVALID_TRANSITION', async () => {
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
    taskService.setContainerAgentService(createMockContainerAgent());

    // First move: backlog → in_progress (valid)
    const move1 = await taskService.moveColumn(task.id, 'in_progress');
    expect(move1.ok).toBe(true);

    // Second move: try backlog → queued (task is already in_progress, not backlog)
    // This simulates a concurrent attempt where the caller still thinks task is in backlog
    const move2 = await taskService.moveColumn(task.id, 'queued');
    // in_progress → queued is not a valid transition
    expect(move2.ok).toBe(false);
    if (!move2.ok) {
      expect(move2.error.code).toBe('TASK_INVALID_TRANSITION');
    }
  });
});
