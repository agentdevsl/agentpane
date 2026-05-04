import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskColumn } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { VALID_TRANSITIONS } from '../../src/services/task-transitions';
import { createMockContainerAgent } from '../factories/container-agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const ALL_COLUMNS: TaskColumn[] = [
  'backlog',
  'queued',
  'in_progress',
  'waiting_approval',
  'verified',
];

const mockWorktreeService = {
  getDiff: async () => ok({ files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } }),
  merge: async () => ok(undefined),
  remove: async () => ok(undefined),
};

describe('Task State Transitions (IT-007)', () => {
  let taskService: TaskService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    taskService = new TaskService(db, mockWorktreeService);
    // MAY-04 guard requires a container agent for in_progress moves.
    taskService.setContainerAgentService(createMockContainerAgent());
    const project = await createTestProject({ name: 'Transition Test' });
    codespaceId = project.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('valid transitions', () => {
    const validCases: Array<{ from: TaskColumn; to: TaskColumn }> = [];
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        validCases.push({ from: from as TaskColumn, to });
      }
    }

    it.each(validCases)('$from -> $to succeeds', async ({ from, to }) => {
      const task = await createTestTask(codespaceId, { column: from });
      const result = await taskService.moveColumn(task.id, to);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe(to);
      }
    });
  });

  describe('invalid transitions', () => {
    const invalidCases: Array<{ from: TaskColumn; to: TaskColumn }> = [];
    for (const from of ALL_COLUMNS) {
      for (const to of ALL_COLUMNS) {
        if (from === to) continue;
        if (VALID_TRANSITIONS[from].includes(to)) continue;
        invalidCases.push({ from, to });
      }
    }

    it.each(invalidCases)('$from -> $to is rejected', async ({ from, to }) => {
      const task = await createTestTask(codespaceId, { column: from });
      const result = await taskService.moveColumn(task.id, to);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
      }
    });
  });

  describe('same-column moves', () => {
    it.each(ALL_COLUMNS)('%s -> %s is a no-op returning ok', async (column) => {
      const task = await createTestTask(codespaceId, { column });
      const result = await taskService.moveColumn(task.id, column);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe(column);
      }
    });
  });

  it('invalid transition error includes allowedTransitions', async () => {
    const task = await createTestTask(codespaceId, { column: 'backlog' });
    const result = await taskService.moveColumn(task.id, 'verified');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
      expect(result.error.details).toBeDefined();
      expect(result.error.details?.allowedTransitions).toEqual(
        expect.arrayContaining(['queued', 'in_progress'])
      );
    }
  });

  it('moving to in_progress sets startedAt', async () => {
    const task = await createTestTask(codespaceId, { column: 'backlog' });
    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.startedAt).toBeTruthy();
    }
  });

  it('task position is appended to end of target column', async () => {
    const _db = getTestDb();
    await createTestTask(codespaceId, { column: 'queued', position: 0 });
    await createTestTask(codespaceId, { column: 'queued', position: 1 });
    const task = await createTestTask(codespaceId, { column: 'backlog' });

    const result = await taskService.moveColumn(task.id, 'queued');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.position).toBe(2);
    }
  });
});
