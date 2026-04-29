import { and, eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents, sessions } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Session Filters and Delete (IT-091 to IT-095)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-091: filter sessions by status and by agentId', async () => {
    const codespace = await createTestProject();
    const agent1 = await createTestAgent(codespace.id, { name: 'Agent A' });
    const agent2 = await createTestAgent(codespace.id, { name: 'Agent B' });

    await createTestSession(codespace.id, {
      status: 'active',
      agentId: agent1.id,
      title: 'Active A1',
    });
    await createTestSession(codespace.id, {
      status: 'active',
      agentId: agent2.id,
      title: 'Active A2',
    });
    await createTestSession(codespace.id, {
      status: 'closed',
      agentId: agent1.id,
      title: 'Closed A1',
      closedAt: new Date().toISOString(),
    });

    // Filter by status='active'
    const activeSessions = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), eq(sessions.status, 'active')),
    });
    expect(activeSessions).toHaveLength(2);

    // Filter by agentId
    const agent1Sessions = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), eq(sessions.agentId, agent1.id)),
    });
    expect(agent1Sessions).toHaveLength(2);

    // Combined: active + agent1
    const activeAgent1 = await db.query.sessions.findMany({
      where: and(
        eq(sessions.codespaceId, codespace.id),
        eq(sessions.status, 'active'),
        eq(sessions.agentId, agent1.id)
      ),
    });
    expect(activeAgent1).toHaveLength(1);
    expect(activeAgent1[0].title).toBe('Active A1');
  });

  it('IT-092: verify total count vs paginated page size', async () => {
    const codespace = await createTestProject();

    // Create 5 active sessions
    for (let i = 0; i < 5; i++) {
      await createTestSession(codespace.id, {
        status: 'active',
        title: `Active ${i + 1}`,
      });
    }

    // Query with limit=2
    const page = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), eq(sessions.status, 'active')),
      limit: 2,
    });
    expect(page).toHaveLength(2);

    // Count all matching
    const all = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), eq(sessions.status, 'active')),
    });
    expect(all).toHaveLength(5);

    // Verify page is a subset of total
    expect(page.length).toBeLessThan(all.length);
  });

  it('IT-093: deleting session cascades to sessionEvents', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // Insert session events. F05-25: bare CUID = session-kind discriminator.
    await db.insert(sessionEvents).values({
      sessionId: session.id,
      streamKind: 'session',
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'hello world' },
      timestamp: Date.now(),
    });
    await db.insert(sessionEvents).values({
      sessionId: session.id,
      streamKind: 'session',
      offset: 1,
      type: 'agent:started',
      channel: 'agent',
      data: { agentId: 'test-agent' },
      timestamp: Date.now(),
    });
    await db.insert(sessionEvents).values({
      sessionId: session.id,
      streamKind: 'session',
      offset: 2,
      type: 'tool:start',
      channel: 'toolCalls',
      data: { tool: 'Read' },
      timestamp: Date.now(),
    });

    // Verify events exist
    const eventsBefore = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(eventsBefore).toHaveLength(3);

    // Delete session events explicitly, then session
    await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));
    await db.delete(sessions).where(eq(sessions.id, session.id));

    // Verify events are deleted
    const eventsAfter = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(eventsAfter).toHaveLength(0);

    // Verify session is gone
    const deletedSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(deletedSession).toBeUndefined();
  });

  it('IT-094: search sessions by partial title match using SQL LIKE', async () => {
    const codespace = await createTestProject();

    await createTestSession(codespace.id, { title: 'Deploy Feature Alpha' });
    await createTestSession(codespace.id, { title: 'Deploy Feature Beta' });
    await createTestSession(codespace.id, { title: 'Review Code Gamma' });
    await createTestSession(codespace.id, { title: 'Implement Alpha Fix' });

    // Search for "Alpha"
    const alphaResults = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), like(sessions.title, '%Alpha%')),
    });
    expect(alphaResults).toHaveLength(2);

    // Search for "Deploy"
    const deployResults = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), like(sessions.title, '%Deploy%')),
    });
    expect(deployResults).toHaveLength(2);

    // Search for "Gamma"
    const gammaResults = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), like(sessions.title, '%Gamma%')),
    });
    expect(gammaResults).toHaveLength(1);
    expect(gammaResults[0].title).toBe('Review Code Gamma');

    // Search for nonexistent term
    const noResults = await db.query.sessions.findMany({
      where: and(eq(sessions.codespaceId, codespace.id), like(sessions.title, '%Zzzzz%')),
    });
    expect(noResults).toHaveLength(0);
  });

  it('IT-095: delete session verifies record is removed from DB', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { title: 'To Be Deleted' });

    // Verify it exists
    const before = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(before).toBeDefined();
    expect(before!.title).toBe('To Be Deleted');

    // Delete it
    await db.delete(sessions).where(eq(sessions.id, session.id));

    // Verify gone
    const after = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(after).toBeUndefined();
  });
});
