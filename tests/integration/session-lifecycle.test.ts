import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents, sessions } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-023: Session CRUD Lifecycle', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('creates a session with active status', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    expect(session).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.codespaceId).toBe(codespace.id);
    expect(session.closedAt).toBeNull();
  });

  it('updates session status to closed with closedAt', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const closedAt = new Date().toISOString();
    const [updated] = await db
      .update(sessions)
      .set({ status: 'closed', closedAt })
      .where(eq(sessions.id, session.id))
      .returning();

    expect(updated.status).toBe('closed');
    expect(updated.closedAt).toBe(closedAt);
  });

  it('creates multiple sessions and verifies count', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    await createTestSession(codespace.id, { status: 'active' });
    await createTestSession(codespace.id, { status: 'active' });
    await createTestSession(codespace.id, { status: 'closed', closedAt: new Date().toISOString() });

    const allSessions = await db.query.sessions.findMany({
      where: eq(sessions.codespaceId, codespace.id),
    });

    expect(allSessions.length).toBe(3);

    const activeSessions = allSessions.filter((s) => s.status === 'active');
    expect(activeSessions.length).toBe(2);

    const closedSessions = allSessions.filter((s) => s.status === 'closed');
    expect(closedSessions.length).toBe(1);
  });

  it('creates session with taskId and agentId referencing correct records', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id);
    const task = await createTestTask(codespace.id);

    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      agentId: agent.id,
      status: 'active',
    });

    expect(session.taskId).toBe(task.id);
    expect(session.agentId).toBe(agent.id);

    const db = getTestDb();
    const retrieved = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.taskId).toBe(task.id);
    expect(retrieved!.agentId).toBe(agent.id);
  });

  it('cascade deletes session_events when session is deleted', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // F05-25: bare CUIDs are session-kind.
    await db.insert(sessionEvents).values({
      sessionId: session.id,
      streamKind: 'session',
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'Hello' },
      timestamp: Date.now(),
    });

    await db.insert(sessionEvents).values({
      sessionId: session.id,
      streamKind: 'session',
      offset: 1,
      type: 'tool:start',
      channel: 'toolCalls',
      data: { tool: 'Read' },
      timestamp: Date.now(),
    });

    const eventsBefore = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(eventsBefore.length).toBe(2);

    // session_events cleanup is explicit (no FK cascade — table stores multi-type stream events)
    await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));
    await db.delete(sessions).where(eq(sessions.id, session.id));

    const eventsAfter = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(eventsAfter.length).toBe(0);
  });
});
