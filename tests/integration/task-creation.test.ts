import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-018: Task creation with validation and auto-positioning', () => {
  const mockWorktreeService = {
    getDiff: async () => ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
    merge: async () => ok(undefined),
    remove: async () => ok(undefined),
  };

  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('creates a task with valid input in backlog at position 0', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const result = await taskService.create({
      codespaceId: project.id,
      title: 'First task',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.column).toBe('backlog');
      expect(result.value.position).toBe(0);
      expect(result.value.title).toBe('First task');
      expect(result.value.codespaceId).toBe(project.id);
    }
  });

  it('auto-increments position for successive tasks', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const result1 = await taskService.create({ codespaceId: project.id, title: 'Task 1' });
    const result2 = await taskService.create({ codespaceId: project.id, title: 'Task 2' });
    const result3 = await taskService.create({ codespaceId: project.id, title: 'Task 3' });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result3.ok).toBe(true);

    if (result1.ok && result2.ok && result3.ok) {
      expect(result1.value.position).toBe(0);
      expect(result2.value.position).toBe(1);
      expect(result3.value.position).toBe(2);
    }
  });

  it('assigns distinct contiguous positions for concurrent task creation batches', async () => {
    const db = getTestDb();
    const taskService = new TaskService(db, mockWorktreeService);

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(5, 50, 200), async (count) => {
        const project = await createTestProject({
          name: `Concurrent Position Batch ${count} ${crypto.randomUUID()}`,
        });

        const results = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            taskService.create({
              codespaceId: project.id,
              title: `Concurrent task ${index}`,
            })
          )
        );

        const created = results.map((result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        });

        const positions = created.map((task) => task.position);
        const sortedPositions = [...positions].sort((a, b) => a - b);

        expect(new Set(positions).size).toBe(count);
        expect(sortedPositions).toEqual(Array.from({ length: count }, (_, index) => index));
      }),
      { numRuns: 6 }
    );
  });

  it('returns error for invalid codespaceId', async () => {
    const db = getTestDb();
    const taskService = new TaskService(db, mockWorktreeService);

    const result = await taskService.create({
      codespaceId: 'nonexistent-codespace-id',
      title: 'Orphan task',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CODESPACE_NOT_FOUND');
    }
  });

  it('stores labels, priority, skillId, and skillName correctly', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const result = await taskService.create({
      codespaceId: project.id,
      title: 'Rich task',
      description: 'A task with all fields',
      labels: ['bug', 'urgent'],
      priority: 'high',
      skillId: 'terraform-compose',
      skillName: 'Terraform Compose',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.labels).toEqual(['bug', 'urgent']);
      expect(result.value.priority).toBe('high');
      expect(result.value.skillId).toBe('terraform-compose');
      expect(result.value.skillName).toBe('Terraform Compose');
      expect(result.value.description).toBe('A task with all fields');
    }
  });

  it('defaults priority to medium', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const result = await taskService.create({
      codespaceId: project.id,
      title: 'Default priority task',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe('medium');
    }
  });

  it('defaults labels to empty array', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const result = await taskService.create({
      codespaceId: project.id,
      title: 'No labels task',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.labels).toEqual([]);
    }
  });

  it('sets createdAt and updatedAt timestamps', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const taskService = new TaskService(db, mockWorktreeService);

    const before = new Date().toISOString();
    const result = await taskService.create({
      codespaceId: project.id,
      title: 'Timestamped task',
    });
    const after = new Date().toISOString();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.createdAt).toBeTruthy();
      expect(result.value.updatedAt).toBeTruthy();
      expect(result.value.createdAt! >= before).toBe(true);
      expect(result.value.createdAt! <= after).toBe(true);
    }
  });
});
