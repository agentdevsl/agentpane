import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQueueService } from '../../src/services/agent/agent-queue.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('AgentQueueService', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('queueTask sets task to queued and returns queue position', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Queue Test', column: 'backlog' });

    const service = new AgentQueueService(db);
    const result = await service.queueTask(project.id, task.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe(task.id);
      expect(result.value.position).toBe(0);
      expect(result.value.totalQueued).toBe(1);
      expect(result.value.estimatedWaitMs).toBe(0);
      expect(result.value.estimatedWaitFormatted).toBe('< 1 min');
    }
  });

  it('queueTask returns correct position for multiple queued tasks', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task1 = await createTestTask(project.id, { title: 'Task 1', column: 'backlog' });
    const task2 = await createTestTask(project.id, { title: 'Task 2', column: 'backlog' });

    const service = new AgentQueueService(db);

    await service.queueTask(project.id, task1.id);
    const result = await service.queueTask(project.id, task2.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe(task2.id);
      expect(result.value.position).toBe(1);
      expect(result.value.totalQueued).toBe(2);
    }
  });

  it('getQueuePosition returns null for non-queued task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Backlog Task', column: 'backlog' });

    const service = new AgentQueueService(db);
    const result = await service.getQueuePosition(task.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('getQueuePosition returns position for queued task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Queue Task', column: 'backlog' });

    const service = new AgentQueueService(db);
    await service.queueTask(project.id, task.id);

    const result = await service.getQueuePosition(task.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.taskId).toBe(task.id);
      expect(result.value!.position).toBe(0);
      expect(result.value!.totalQueued).toBe(1);
    }
  });

  it('getQueueStats returns stats with zero values when no tasks queued', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const service = new AgentQueueService(db);
    const result = await service.getQueueStats(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalQueued).toBe(0);
      expect(result.value.averageCompletionMs).toBe(0);
      expect(result.value.recentCompletions).toBe(0);
    }
  });

  it('getQueueStats returns correct count when tasks are queued', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Task', column: 'backlog' });

    const service = new AgentQueueService(db);
    await service.queueTask(project.id, task.id);

    const result = await service.getQueueStats(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalQueued).toBe(1);
    }
  });

  it('getQueuedTasks returns empty array when no tasks queued', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const service = new AgentQueueService(db);
    const result = await service.getQueuedTasks(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it('getQueuedTasks returns queued tasks in FIFO order', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task1 = await createTestTask(project.id, { title: 'First', column: 'backlog' });
    const task2 = await createTestTask(project.id, { title: 'Second', column: 'backlog' });

    const service = new AgentQueueService(db);
    await service.queueTask(project.id, task1.id);
    await service.queueTask(project.id, task2.id);

    const result = await service.getQueuedTasks(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].taskId).toBe(task1.id);
      expect(result.value[1].taskId).toBe(task2.id);
      expect(result.value[0].position).toBe(0);
      expect(result.value[1].position).toBe(1);
    }
  });

  it('dequeueNext returns oldest queued task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task1 = await createTestTask(project.id, { title: 'First', column: 'backlog' });
    const task2 = await createTestTask(project.id, { title: 'Second', column: 'backlog' });

    const service = new AgentQueueService(db);
    await service.queueTask(project.id, task1.id);
    await service.queueTask(project.id, task2.id);

    const result = await service.dequeueNext(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe(task1.id);
    }
  });

  it('dequeueNext returns null when queue is empty', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const service = new AgentQueueService(db);
    const result = await service.dequeueNext(project.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});
