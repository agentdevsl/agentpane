import { createId } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks, templates } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Concurrency: Queue (IT-219 to IT-220)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-219: 5 queued tasks ordered by position ASC — FIFO ordering', async () => {
    const codespace = await createTestProject();

    const createdTasks = [];
    for (let i = 0; i < 5; i++) {
      const task = await createTestTask(codespace.id, {
        column: 'queued',
        position: i,
        title: `Queue item ${i}`,
      });
      createdTasks.push(task);
    }

    const queued = await db.query.tasks.findMany({
      where: eq(tasks.column, 'queued'),
      orderBy: asc(tasks.position),
    });

    expect(queued.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(queued[i]!.position).toBe(i);
      expect(queued[i]!.id).toBe(createdTasks[i]!.id);
    }
  });

  it('IT-220: two templates with independent syncStatus tracking', async () => {
    const template1Id = createId();
    const template2Id = createId();

    await db.insert(templates).values({
      id: template1Id,
      name: 'Template A',
      scope: 'org',
      githubOwner: 'org-a',
      githubRepo: 'repo-a',
      status: 'active',
    });

    await db.insert(templates).values({
      id: template2Id,
      name: 'Template B',
      scope: 'org',
      githubOwner: 'org-b',
      githubRepo: 'repo-b',
      status: 'active',
    });

    // Update both to syncing
    await db.update(templates).set({ status: 'syncing' }).where(eq(templates.id, template1Id));
    await db.update(templates).set({ status: 'syncing' }).where(eq(templates.id, template2Id));

    let t1 = await db.query.templates.findFirst({ where: eq(templates.id, template1Id) });
    let t2 = await db.query.templates.findFirst({ where: eq(templates.id, template2Id) });
    expect(t1!.status).toBe('syncing');
    expect(t2!.status).toBe('syncing');

    // Update back to active independently
    await db.update(templates).set({ status: 'active' }).where(eq(templates.id, template1Id));
    await db.update(templates).set({ status: 'active' }).where(eq(templates.id, template2Id));

    t1 = await db.query.templates.findFirst({ where: eq(templates.id, template1Id) });
    t2 = await db.query.templates.findFirst({ where: eq(templates.id, template2Id) });
    expect(t1!.status).toBe('active');
    expect(t2!.status).toBe('active');
  });
});
