import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import { AgentQueueService } from '../../src/services/agent/agent-queue.service';
import { createTestAgent } from '../factories/agent.factory';
import { createCompletedAgentRun } from '../factories/agent-run.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('AgentQueueService (IT-210)', () => {
  let db: ReturnType<typeof getTestDb>;
  let queueService: AgentQueueService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    queueService = new AgentQueueService(db as any);

    const codespace = await createTestProject({ name: 'Queue Test Codespace' });
    codespaceId = codespace.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('queueTask (IT-211)', () => {
    it('IT-211a: queues a backlog task and returns position 0', async () => {
      const task = await createTestTask(codespaceId, {
        column: 'backlog',
        title: 'First queue task',
      });

      const result = await queueService.queueTask(codespaceId, task.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe(task.id);
      expect(result.value.position).toBe(0);
      expect(result.value.totalQueued).toBe(1);

      // Verify DB state
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('queued');
    });

    it('IT-211b: second queued task gets position 1', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);

      // Small delay to ensure different updatedAt timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await queueService.queueTask(codespaceId, task2.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.position).toBe(1);
      expect(result.value.totalQueued).toBe(2);
    });

    it('IT-211c: returns error when task does not exist', async () => {
      const result = await queueService.queueTask(codespaceId, 'nonexistent-task');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('QUEUE_ERROR');
      expect(result.error.message).toContain('Task not found');
    });

    it('IT-211d: returns error for invalid transition (in_progress to queued)', async () => {
      const task = await createTestTask(codespaceId, { column: 'in_progress' });

      const result = await queueService.queueTask(codespaceId, task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('QUEUE_ERROR');
      expect(result.error.message).toContain('invalid transition');
    });

    it('IT-211e: returns error for invalid transition (verified to queued)', async () => {
      const task = await createTestTask(codespaceId, { column: 'verified' });

      const result = await queueService.queueTask(codespaceId, task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('QUEUE_ERROR');
    });

    it('IT-211f: estimated wait time scales with position and average completion', async () => {
      // Create completed agent runs to build an average
      const agent = await createTestAgent(codespaceId, { status: 'idle' });
      const helperTask = await createTestTask(codespaceId, { column: 'backlog' });

      const baseTime = new Date('2026-01-01T00:00:00.000Z');
      // Create runs that average 60 seconds each (pass ISO strings for SQLite)
      for (let i = 0; i < 3; i++) {
        const startedAt = new Date(baseTime.getTime() + i * 120_000).toISOString();
        const completedAt = new Date(baseTime.getTime() + i * 120_000 + 60_000).toISOString(); // 60s per run
        await createCompletedAgentRun(agent.id, helperTask.id, codespaceId, {
          startedAt,
          completedAt,
        });
      }

      // Queue 3 tasks
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });
      const task3 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await queueService.queueTask(codespaceId, task3.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.position).toBe(2);
      // Position 2 * 60000ms average = 120000ms wait
      expect(result.value.estimatedWaitMs).toBe(120_000);
      expect(result.value.estimatedWaitMinutes).toBe(2);
      expect(result.value.estimatedWaitFormatted).toBe('2 mins');
    });
  });

  describe('dequeueNext (IT-212)', () => {
    it('IT-212a: returns null when queue is empty', async () => {
      const result = await queueService.dequeueNext(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('IT-212b: dequeues oldest task first (FIFO)', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);

      const result = await queueService.dequeueNext(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe(task1.id);
      // Task should be moved to backlog (ready for start())
      expect(result.value!.column).toBe('backlog');
    });

    it('IT-212c: second dequeue returns next task', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });
      const task3 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task3.id);

      // Dequeue first
      const result1 = await queueService.dequeueNext(codespaceId);
      expect(result1.ok).toBe(true);
      if (result1.ok) expect(result1.value?.id).toBe(task1.id);

      // Dequeue second
      const result2 = await queueService.dequeueNext(codespaceId);
      expect(result2.ok).toBe(true);
      if (result2.ok) expect(result2.value?.id).toBe(task2.id);

      // Dequeue third
      const result3 = await queueService.dequeueNext(codespaceId);
      expect(result3.ok).toBe(true);
      if (result3.ok) expect(result3.value?.id).toBe(task3.id);

      // Queue is now empty
      const result4 = await queueService.dequeueNext(codespaceId);
      expect(result4.ok).toBe(true);
      if (result4.ok) expect(result4.value).toBeNull();
    });

    it('IT-212d: does not dequeue tasks from another codespace', async () => {
      const codespace2 = await createTestProject({ name: 'Other Codespace' });
      const task = await createTestTask(codespace2.id, { column: 'backlog' });
      await queueService.queueTask(codespace2.id, task.id);

      const result = await queueService.dequeueNext(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('getQueuePosition (IT-213)', () => {
    it('IT-213a: returns null when task is not queued', async () => {
      const task = await createTestTask(codespaceId, { column: 'backlog' });

      const result = await queueService.getQueuePosition(task.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('IT-213b: returns null for nonexistent task', async () => {
      const result = await queueService.getQueuePosition('nonexistent-task');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('IT-213c: returns correct position for queued task', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });
      const task3 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task3.id);

      const result = await queueService.getQueuePosition(task2.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.position).toBe(1); // 0-indexed: task1=0, task2=1
      expect(result.value!.totalQueued).toBe(3);
    });

    it('IT-213d: position updates after earlier task is dequeued', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);

      // task2 is at position 1
      let result = await queueService.getQueuePosition(task2.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.position).toBe(1);

      // Dequeue task1
      await queueService.dequeueNext(codespaceId);

      // task2 is now at position 0
      result = await queueService.getQueuePosition(task2.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.position).toBe(0);
      if (result.ok) expect(result.value?.totalQueued).toBe(1);
    });
  });

  describe('getQueueStats (IT-214)', () => {
    it('IT-214a: returns zero stats when queue is empty', async () => {
      const result = await queueService.getQueueStats(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalQueued).toBe(0);
      expect(result.value.averageCompletionMs).toBe(0);
      expect(result.value.recentCompletions).toBe(0);
    });

    it('IT-214b: returns correct queued count', async () => {
      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespaceId, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await queueService.queueTask(codespaceId, task2.id);

      const result = await queueService.getQueueStats(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalQueued).toBe(2);
    });

    it('IT-214c: calculates average completion time from agent runs', async () => {
      const agent = await createTestAgent(codespaceId, { status: 'idle' });
      const task = await createTestTask(codespaceId, { column: 'backlog' });

      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Run 1: 30s (pass ISO strings for SQLite)
      await createCompletedAgentRun(agent.id, task.id, codespaceId, {
        startedAt: new Date(baseTime.getTime()).toISOString(),
        completedAt: new Date(baseTime.getTime() + 30_000).toISOString(),
      });

      // Run 2: 90s
      await createCompletedAgentRun(agent.id, task.id, codespaceId, {
        startedAt: new Date(baseTime.getTime() + 100_000).toISOString(),
        completedAt: new Date(baseTime.getTime() + 190_000).toISOString(),
      });

      const result = await queueService.getQueueStats(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recentCompletions).toBe(2);
      // Average of 30s and 90s = 60s = 60000ms
      expect(result.value.averageCompletionMs).toBe(60_000);
    });

    it('IT-214d: global stats include all codespaces when no codespaceId', async () => {
      const codespace2 = await createTestProject({ name: 'Other' });

      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespace2.id, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await queueService.queueTask(codespace2.id, task2.id);

      const result = await queueService.getQueueStats(); // no codespaceId

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalQueued).toBe(2);
    });
  });

  describe('getQueuedTasks (IT-215)', () => {
    it('IT-215a: returns empty array when no tasks queued', async () => {
      const result = await queueService.getQueuedTasks(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it('IT-215b: returns tasks in FIFO order with positions', async () => {
      const task1 = await createTestTask(codespaceId, {
        column: 'backlog',
        title: 'First',
      });
      const task2 = await createTestTask(codespaceId, {
        column: 'backlog',
        title: 'Second',
      });
      const task3 = await createTestTask(codespaceId, {
        column: 'backlog',
        title: 'Third',
      });

      await queueService.queueTask(codespaceId, task1.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task2.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queueService.queueTask(codespaceId, task3.id);

      const result = await queueService.getQueuedTasks(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
      expect(result.value[0]?.taskId).toBe(task1.id);
      expect(result.value[0]?.position).toBe(0);
      expect(result.value[1]?.taskId).toBe(task2.id);
      expect(result.value[1]?.position).toBe(1);
      expect(result.value[2]?.taskId).toBe(task3.id);
      expect(result.value[2]?.position).toBe(2);
    });

    it('IT-215c: global queued tasks includes all codespaces', async () => {
      const codespace2 = await createTestProject({ name: 'Other' });

      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      const task2 = await createTestTask(codespace2.id, { column: 'backlog' });

      await queueService.queueTask(codespaceId, task1.id);
      await queueService.queueTask(codespace2.id, task2.id);

      const result = await queueService.getQueuedTasks(); // no codespaceId

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it('IT-215d: estimated wait formatted correctly for various durations', async () => {
      const agent = await createTestAgent(codespaceId, { status: 'idle' });
      const helperTask = await createTestTask(codespaceId, { column: 'backlog' });

      // Create runs averaging 30s each (pass ISO strings for SQLite)
      const baseTime = new Date('2026-01-01T00:00:00.000Z');
      await createCompletedAgentRun(agent.id, helperTask.id, codespaceId, {
        startedAt: baseTime.toISOString(),
        completedAt: new Date(baseTime.getTime() + 30_000).toISOString(),
      });

      const task1 = await createTestTask(codespaceId, { column: 'backlog' });
      await queueService.queueTask(codespaceId, task1.id);

      const result = await queueService.getQueuedTasks(codespaceId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.estimatedWaitFormatted).toBe('< 1 min'); // position 0 * 30s = 0
    });
  });
});
