import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaces,
  projectFolders,
  sessionEvents,
  sessions,
  tasks,
  templateCodespaces,
  templates,
} from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Codespace Lifecycle (IT-175 to IT-177)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-175: creates project folder → codespace in folder → verifies projectFolderId', async () => {
    const folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Engineering',
      slug: `engineering-${folderId.slice(0, 6)}`,
      description: 'Engineering projects',
    });

    const codespace = await createTestProject({
      projectFolderId: folderId,
      name: 'API Service',
    });

    expect(codespace.projectFolderId).toBe(folderId);

    const retrieved = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(retrieved!.projectFolderId).toBe(folderId);

    const folder = await db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, folderId),
    });
    expect(folder!.name).toBe('Engineering');
  });

  it('IT-176: deletes codespace → cascade removes tasks, sessions, session_events', async () => {
    const codespace = await createTestProject({ name: 'Cascade Test' });
    const task = await createTestTask(codespace.id, { title: 'Task to cascade' });
    const session = await createTestSession(codespace.id, { taskId: task.id });

    // Insert session events
    await db.insert(sessionEvents).values({
      id: createId(),
      sessionId: session.id,
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'hello' },
      timestamp: Date.now(),
    });
    await db.insert(sessionEvents).values({
      id: createId(),
      sessionId: session.id,
      offset: 1,
      type: 'tool:start',
      channel: 'toolCalls',
      data: { tool: 'Read' },
      timestamp: Date.now(),
    });

    // Verify data exists
    const tasksBefore = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    expect(tasksBefore.length).toBe(1);

    // Delete codespace
    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Verify cascade
    const tasksAfter = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    expect(tasksAfter.length).toBe(0);

    const sessionsAfter = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, codespace.id),
    });
    expect(sessionsAfter.length).toBe(0);

    const eventsAfter = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(eventsAfter.length).toBe(0);
  });

  it('IT-177: creates template with codespace association via junction table', async () => {
    const codespace1 = await createTestProject({ name: 'Codespace A' });
    const codespace2 = await createTestProject({ name: 'Codespace B' });

    const templateId = createId();
    await db.insert(templates).values({
      id: templateId,
      name: 'Shared Template',
      description: 'A shared template',
      scope: 'codespace',
      githubOwner: 'testorg',
      githubRepo: 'templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
    });

    // Create junction records
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace1.id,
    });
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace2.id,
    });

    // Verify
    const junctions = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, templateId),
    });
    expect(junctions.length).toBe(2);

    const codespaceIds = junctions.map((j) => j.codespaceId).sort();
    expect(codespaceIds).toContain(codespace1.id);
    expect(codespaceIds).toContain(codespace2.id);

    // Verify template itself
    const template = await db.query.templates.findFirst({
      where: eq(templates.id, templateId),
    });
    expect(template!.name).toBe('Shared Template');
    expect(template!.scope).toBe('codespace');
  });
});
