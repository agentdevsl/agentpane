import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessions } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Session CRUD Operations (IT-086 to IT-090)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-086: create session with correct codespaceId, status, taskId, agentId', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { name: 'Session Agent' });
    const task = await createTestTask(codespace.id, { title: 'Session Task' });

    const session = await createTestSession(codespace.id, {
      status: 'active',
      taskId: task.id,
      agentId: agent.id,
      title: 'Test CRUD Session',
    });

    expect(session).toBeDefined();
    expect(session.codespaceId).toBe(codespace.id);
    expect(session.status).toBe('active');
    expect(session.taskId).toBe(task.id);
    expect(session.agentId).toBe(agent.id);
    expect(session.title).toBe('Test CRUD Session');

    // Verify via DB query
    const retrieved = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(retrieved).toBeDefined();
    expect(retrieved!.codespaceId).toBe(codespace.id);
    expect(retrieved!.taskId).toBe(task.id);
    expect(retrieved!.agentId).toBe(agent.id);
  });

  it('IT-087: sessions have unique cuid2 IDs and valid URL format', async () => {
    const codespace = await createTestProject();

    const session1 = await createTestSession(codespace.id, { title: 'Session One' });
    const session2 = await createTestSession(codespace.id, { title: 'Session Two' });

    // IDs are unique
    expect(session1.id).not.toBe(session2.id);

    // IDs are cuid2 format (lowercase alphanumeric, typical length 24-25)
    expect(session1.id).toMatch(/^[a-z0-9]+$/);
    expect(session2.id).toMatch(/^[a-z0-9]+$/);
    expect(session1.id.length).toBeGreaterThanOrEqual(20);
    expect(session2.id.length).toBeGreaterThanOrEqual(20);

    // URL contains the session ID
    expect(session1.url).toContain(session1.id);
    expect(session2.url).toContain(session2.id);
    expect(session1.url).toContain('/sessions/');
    expect(session2.url).toContain('/sessions/');
  });

  it('IT-088: session fields are correctly stored and retrieved from DB', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id);
    const task = await createTestTask(codespace.id);

    const session = await createTestSession(codespace.id, {
      status: 'active',
      taskId: task.id,
      agentId: agent.id,
      title: 'Full Field Session',
    });

    // Retrieve from DB
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });

    expect(dbSession).toBeDefined();
    expect(dbSession!.id).toBe(session.id);
    expect(dbSession!.codespaceId).toBe(codespace.id);
    expect(dbSession!.status).toBe('active');
    expect(dbSession!.taskId).toBe(task.id);
    expect(dbSession!.agentId).toBe(agent.id);
    expect(dbSession!.title).toBe('Full Field Session');
    expect(dbSession!.closedAt).toBeNull();
    expect(dbSession!.createdAt).toBeDefined();
  });

  it('IT-089: pagination — limit and offset work for session listing', async () => {
    const codespace = await createTestProject();

    // Create 5 sessions with staggered createdAt
    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const session = await createTestSession(codespace.id, {
        title: `Paginated Session ${i + 1}`,
      });
      // Set explicit createdAt for deterministic ordering
      await db
        .update(sessions)
        .set({ createdAt: `2026-01-0${i + 1}T00:00:00.000Z` })
        .where(eq(sessions.id, session.id));
      sessionIds.push(session.id);
    }

    // Page 1: limit=2, offset=0, ordered by createdAt DESC
    const page1 = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, codespace.id),
      orderBy: [desc(sessions.createdAt)],
      limit: 2,
      offset: 0,
    });

    expect(page1).toHaveLength(2);
    // Most recent first (session 5, then session 4)
    expect(page1[0].id).toBe(sessionIds[4]);
    expect(page1[1].id).toBe(sessionIds[3]);

    // Page 2: limit=2, offset=2
    const page2 = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, codespace.id),
      orderBy: [desc(sessions.createdAt)],
      limit: 2,
      offset: 2,
    });

    expect(page2).toHaveLength(2);
    expect(page2[0].id).toBe(sessionIds[2]);
    expect(page2[1].id).toBe(sessionIds[1]);

    // Total count should be 5
    const all = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, codespace.id),
    });
    expect(all).toHaveLength(5);
  });

  it('IT-090: close session — sets status to closed and closedAt timestamp', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    expect(session.status).toBe('active');
    expect(session.closedAt).toBeNull();

    const closedAt = new Date().toISOString();
    const [updated] = await db
      .update(sessions)
      .set({ status: 'closed', closedAt })
      .where(eq(sessions.id, session.id))
      .returning();

    expect(updated).toBeDefined();
    expect(updated.status).toBe('closed');
    expect(updated.closedAt).toBe(closedAt);

    // Verify from DB
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(dbSession!.status).toBe('closed');
    expect(dbSession!.closedAt).toBe(closedAt);
  });
});
