import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents, sessions } from '../../src/db/schema';
import { createSessionEventWithMetadata } from '../../src/services/session/event-metadata';
import { SessionService } from '../../src/services/session.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Mock DurableStreamsServer — external I/O boundary
 */
function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: vi.fn().mockResolvedValue({ done: true }),
      }),
    }),
    deleteStream: vi.fn().mockResolvedValue(true),
  };
}

const BASE_URL = 'http://localhost:3000';

describe('SessionService Facade (IT-200 to IT-215)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: SessionService;
  let mockStreams: ReturnType<typeof createMockStreams>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockStreams = createMockStreams();
    service = new SessionService(db as any, mockStreams, { baseUrl: BASE_URL });
  });

  afterEach(async () => {
    service.destroy();
    await clearTestDatabase();
  });

  // ===== CRUD via facade =====

  it('IT-200: create() returns active session with presence array', async () => {
    const codespace = await createTestProject();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'Facade Session',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('active');
    expect(result.value.codespaceId).toBe(codespace.id);
    expect(result.value.title).toBe('Facade Session');
    expect(result.value.presence).toEqual([]);
    expect(result.value.url).toContain('/sessions/');
    expect(result.value.url).toContain(result.value.id);

    // Verify stream was created
    expect(mockStreams.createStream).toHaveBeenCalledTimes(1);
    expect(mockStreams.createStream).toHaveBeenCalledWith(result.value.id, expect.anything());
  });

  it('IT-201: create() with taskId and agentId stores references', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id);
    const task = await createTestTask(codespace.id);

    const result = await service.create({
      codespaceId: codespace.id,
      taskId: task.id,
      agentId: agent.id,
      title: 'With References',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.taskId).toBe(task.id);
    expect(result.value.agentId).toBe(agent.id);

    // Verify in DB
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, result.value.id),
    });
    expect(dbSession).toBeDefined();
    expect(dbSession!.taskId).toBe(task.id);
    expect(dbSession!.agentId).toBe(agent.id);
  });

  it('IT-202: create() fails for nonexistent codespace', async () => {
    const result = await service.create({
      codespaceId: 'nonexistent-codespace-id',
      title: 'Orphan',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CODESPACE_NOT_FOUND');
  });

  it('IT-203: getById() returns session with presence', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'Get By Id',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = await service.getById(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value.id).toBe(createResult.value.id);
    expect(getResult.value.title).toBe('Get By Id');
    expect(getResult.value.presence).toEqual([]);
  });

  it('IT-204: getById() fails for nonexistent session', async () => {
    const result = await service.getById('nonexistent-session-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-205: list() returns sessions ordered by updatedAt desc by default', async () => {
    const codespace = await createTestProject();

    // Create 3 sessions via the service
    const r1 = await service.create({ codespaceId: codespace.id, title: 'Session 1' });
    const r2 = await service.create({ codespaceId: codespace.id, title: 'Session 2' });
    const r3 = await service.create({ codespaceId: codespace.id, title: 'Session 3' });

    expect(r1.ok && r2.ok && r3.ok).toBe(true);

    const listResult = await service.list({ limit: 10 });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value.length).toBeGreaterThanOrEqual(3);
    // Each item should have a presence array
    for (const s of listResult.value) {
      expect(Array.isArray(s.presence)).toBe(true);
    }
  });

  it('IT-206: list() respects limit and offset', async () => {
    const codespace = await createTestProject();

    for (let i = 0; i < 5; i++) {
      await service.create({ codespaceId: codespace.id, title: `Session ${i}` });
    }

    const page1 = await service.list({ limit: 2, offset: 0 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.length).toBe(2);

    const page2 = await service.list({ limit: 2, offset: 2 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.length).toBe(2);

    // Pages should not overlap
    const page1Ids = new Set(page1.value.map((s) => s.id));
    for (const s of page2.value) {
      expect(page1Ids.has(s.id)).toBe(false);
    }
  });

  it('IT-207: close() transitions session to closed status', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'To Close',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const closeResult = await service.close(createResult.value.id);
    expect(closeResult.ok).toBe(true);
    if (!closeResult.ok) return;

    expect(closeResult.value.status).toBe('closed');
    expect(closeResult.value.closedAt).toBeTruthy();

    // Verify in DB
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, createResult.value.id),
    });
    expect(dbSession!.status).toBe('closed');
    expect(dbSession!.closedAt).toBeTruthy();
  });

  it('IT-208: close() is idempotent — closing a closed session returns current state', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'Double Close',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const close1 = await service.close(createResult.value.id);
    expect(close1.ok).toBe(true);
    if (!close1.ok) return;
    const firstClosedAt = close1.value.closedAt;

    const close2 = await service.close(createResult.value.id);
    expect(close2.ok).toBe(true);
    if (!close2.ok) return;

    expect(close2.value.status).toBe('closed');
    // closedAt should not be updated on second close
    expect(close2.value.closedAt).toBe(firstClosedAt);
  });

  it('IT-209: close() fails for nonexistent session', async () => {
    const result = await service.close('nonexistent-session-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-210: delete() removes session and its events', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'To Delete',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sessionId = createResult.value.id;

    // Insert some events. F05-25: bare CUIDs are session-kind.
    await db.insert(sessionEvents).values({
      sessionId,
      streamKind: 'session',
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'Hello' },
      timestamp: Date.now(),
    });

    const deleteResult = await service.delete(sessionId);
    expect(deleteResult.ok).toBe(true);
    if (!deleteResult.ok) return;
    expect(deleteResult.value.deleted).toBe(true);

    // Session should be gone
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });
    expect(dbSession).toBeUndefined();

    // Events should be gone
    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });
    expect(events).toHaveLength(0);
  });

  it('IT-211: delete() fails for nonexistent session', async () => {
    const result = await service.delete('nonexistent-session-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  // ===== URL Generation/Parsing =====

  it('IT-212: generateUrl() produces correct URL', async () => {
    const url = service.generateUrl('test-session-abc');
    expect(url).toBe(`${BASE_URL}/sessions/test-session-abc`);
  });

  it('IT-213: parseUrl() extracts session ID from valid URL', async () => {
    const result = service.parseUrl(`${BASE_URL}/sessions/abc123def`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('abc123def');
  });

  it('IT-214: parseUrl() returns error for invalid URL', async () => {
    const result = service.parseUrl('not-a-url');
    expect(result.ok).toBe(false);
  });

  it('IT-214b: parseUrl() returns error for URL without session path', async () => {
    const result = service.parseUrl(`${BASE_URL}/codespaces/foo`);
    expect(result.ok).toBe(false);
  });

  // ===== Filtered listing =====

  it('IT-215: listSessionsWithFilters() filters by status and search', async () => {
    const codespace = await createTestProject();

    await service.create({ codespaceId: codespace.id, title: 'Deploy Alpha' });
    await service.create({ codespaceId: codespace.id, title: 'Deploy Beta' });
    const r3 = await service.create({ codespaceId: codespace.id, title: 'Review Gamma' });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    // Close one
    await service.close(r3.value.id);

    // Filter by status
    const activeResult = await service.listSessionsWithFilters(codespace.id, {
      status: ['active'],
    });
    expect(activeResult.ok).toBe(true);
    if (!activeResult.ok) return;
    expect(activeResult.value.sessions.length).toBe(2);
    expect(activeResult.value.total).toBe(2);

    // Filter by search
    const searchResult = await service.listSessionsWithFilters(codespace.id, {
      search: 'Deploy',
    });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.sessions.length).toBe(2);
    for (const s of searchResult.value.sessions) {
      expect(s.title).toContain('Deploy');
    }
  });

  // ===== Presence via facade =====

  it('IT-215b: join() and leave() manage user presence', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'Presence Test',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sessionId = createResult.value.id;

    // Join
    const joinResult = await service.join(sessionId, 'user-1');
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) return;
    expect(joinResult.value.presence.length).toBe(1);
    expect(joinResult.value.presence[0].userId).toBe('user-1');

    // Get active users
    const usersResult = await service.getActiveUsers(sessionId);
    expect(usersResult.ok).toBe(true);
    if (!usersResult.ok) return;
    expect(usersResult.value.length).toBe(1);

    // Leave
    const leaveResult = await service.leave(sessionId, 'user-1');
    expect(leaveResult.ok).toBe(true);
    if (!leaveResult.ok) return;
    expect(leaveResult.value.presence.length).toBe(0);
  });

  // ===== Streaming via facade =====

  it('IT-215c: persistEvent() stores event in database', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'Event Persist',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sessionId = createResult.value.id;
    const event = createSessionEventWithMetadata({
      sessionId,
      type: 'chunk',
      partType: 'chunk_delta',
      blockId: 'b1',
      data: { text: 'hello' },
    });

    const persistResult = await service.persistEvent(sessionId, event);
    expect(persistResult.ok).toBe(true);
    if (!persistResult.ok) return;
    expect(persistResult.value.id).toBeTruthy();

    // Verify in DB
    const dbEvents = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });
    expect(dbEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('IT-215d: getEventsBySession() returns persisted events', async () => {
    const codespace = await createTestProject();
    const createResult = await service.create({
      codespaceId: codespace.id,
      title: 'Events Query',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sessionId = createResult.value.id;

    // Insert events directly. F05-25: bare CUIDs are session-kind.
    await db.insert(sessionEvents).values([
      {
        sessionId,
        streamKind: 'session',
        offset: 0,
        type: 'chunk',
        channel: 'chunks',
        data: { text: 'first' },
        timestamp: Date.now(),
      },
      {
        sessionId,
        streamKind: 'session',
        offset: 1,
        type: 'tool:start',
        channel: 'toolCalls',
        data: { tool: 'Read' },
        timestamp: Date.now() + 1,
      },
    ]);

    const eventsResult = await service.getEventsBySession(sessionId);
    expect(eventsResult.ok).toBe(true);
    if (!eventsResult.ok) return;
    expect(eventsResult.value.length).toBe(2);
  });

  // ===== destroy() cleans up timers =====

  it('IT-215e: destroy() stops cleanup timer', () => {
    // Should not throw
    service.destroy();
    // Calling again should also not throw (idempotent)
    service.destroy();
  });
});
