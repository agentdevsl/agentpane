import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents, sessions } from '../../src/db/schema';
import { SessionCrudService } from '../../src/services/session/session-crud.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Mock DurableStreamsServer — external I/O boundary
 */
function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn(),
    deleteStream: vi.fn().mockResolvedValue(true),
  };
}

const BASE_URL = 'http://localhost:3000';

describe('SessionCrudService (IT-220 to IT-245)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: SessionCrudService;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let presenceStore: Map<string, Map<string, any>>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockStreams = createMockStreams();
    presenceStore = new Map();
    service = new SessionCrudService(db as any, mockStreams, { baseUrl: BASE_URL }, presenceStore);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ===== create() =====

  it('IT-220: create() inserts a new session with active status', async () => {
    const codespace = await createTestProject();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'CRUD Test Session',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('active');
    expect(result.value.codespaceId).toBe(codespace.id);
    expect(result.value.title).toBe('CRUD Test Session');
    expect(result.value.id).toMatch(/^[a-z0-9]+$/);
    expect(result.value.presence).toEqual([]);

    // Verify in DB
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, result.value.id),
    });
    expect(dbSession).toBeDefined();
    expect(dbSession!.status).toBe('active');
  });

  it('IT-221: create() generates a URL containing the session ID', async () => {
    const codespace = await createTestProject();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'URL Test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toBe(`${BASE_URL}/sessions/${result.value.id}`);
  });

  it('IT-222: create() stores taskId and agentId', async () => {
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
  });

  it('IT-223: create() initializes the presence store for the session', async () => {
    const codespace = await createTestProject();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'Presence Init',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(presenceStore.has(result.value.id)).toBe(true);
    expect(presenceStore.get(result.value.id)!.size).toBe(0);
  });

  it('IT-224: create() calls streams.createStream', async () => {
    const codespace = await createTestProject();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'Stream Create',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockStreams.createStream).toHaveBeenCalledTimes(1);
    expect(mockStreams.createStream).toHaveBeenCalledWith(result.value.id, expect.anything());
  });

  it('IT-225: create() returns error for nonexistent codespace', async () => {
    const result = await service.create({
      codespaceId: 'fake-codespace-id',
      title: 'Orphan Session',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CODESPACE_NOT_FOUND');
  });

  it('IT-226: create() sets createdAt timestamp', async () => {
    const codespace = await createTestProject();
    const before = new Date().toISOString();

    const result = await service.create({
      codespaceId: codespace.id,
      title: 'Timestamp Test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, result.value.id),
    });
    expect(dbSession!.createdAt).toBeTruthy();
    expect(dbSession!.createdAt! >= before).toBe(true);
  });

  // ===== getById() =====

  it('IT-227: getById() returns session with presence data', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active', title: 'Find Me' });

    // Seed presence
    const users = new Map();
    users.set('user-1', { userId: 'user-1', lastSeen: Date.now() });
    presenceStore.set(session.id, users);

    const result = await service.getById(session.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe(session.id);
    expect(result.value.title).toBe('Find Me');
    expect(result.value.presence).toHaveLength(1);
    expect(result.value.presence[0].userId).toBe('user-1');
  });

  it('IT-228: getById() returns error for nonexistent session', async () => {
    const result = await service.getById('nonexistent-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-229: getById() returns empty presence when no users have joined', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const result = await service.getById(session.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.presence).toEqual([]);
  });

  // ===== list() =====

  it('IT-230: list() returns sessions with pagination', async () => {
    const codespace = await createTestProject();

    for (let i = 0; i < 5; i++) {
      await createTestSession(codespace.id, { title: `Session ${i}` });
    }

    const result = await service.list({ limit: 3, offset: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(3);
  });

  it('IT-231: list() defaults to 50 limit and 0 offset', async () => {
    const codespace = await createTestProject();

    for (let i = 0; i < 3; i++) {
      await createTestSession(codespace.id, { title: `Session ${i}` });
    }

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(3);
  });

  it('IT-232: list() includes presence data for each session', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    // Seed presence for the session
    const users = new Map();
    users.set('user-a', { userId: 'user-a', lastSeen: Date.now() });
    presenceStore.set(session.id, users);

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const found = result.value.find((s) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found!.presence).toHaveLength(1);
    expect(found!.presence[0].userId).toBe('user-a');
  });

  // ===== close() =====

  it('IT-233: close() sets status to closed and closedAt', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const result = await service.close(session.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('closed');
    expect(result.value.closedAt).toBeTruthy();
  });

  it('IT-234: close() is idempotent — second close returns same closedAt', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const close1 = await service.close(session.id);
    expect(close1.ok).toBe(true);
    if (!close1.ok) return;

    const close2 = await service.close(session.id);
    expect(close2.ok).toBe(true);
    if (!close2.ok) return;

    expect(close2.value.closedAt).toBe(close1.value.closedAt);
  });

  it('IT-235: close() returns error for nonexistent session', async () => {
    const result = await service.close('nonexistent-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  // ===== delete() =====

  it('IT-236: delete() removes session and its events from DB', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // Insert events. F05-25: bare CUIDs are session-kind.
    await db.insert(sessionEvents).values([
      {
        sessionId: session.id,
        streamKind: 'session',
        offset: 0,
        type: 'chunk',
        channel: 'chunks',
        data: { text: 'hello' },
        timestamp: Date.now(),
      },
      {
        sessionId: session.id,
        streamKind: 'session',
        offset: 1,
        type: 'tool:start',
        channel: 'toolCalls',
        data: { tool: 'Read' },
        timestamp: Date.now(),
      },
    ]);

    const result = await service.delete(session.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deleted).toBe(true);

    // Verify session gone
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(dbSession).toBeUndefined();

    // Verify events gone
    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(events).toHaveLength(0);
  });

  it('IT-237: delete() cleans up presence store', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // Seed presence
    presenceStore.set(
      session.id,
      new Map([['user-1', { userId: 'user-1', lastSeen: Date.now() }]])
    );
    expect(presenceStore.has(session.id)).toBe(true);

    const result = await service.delete(session.id);
    expect(result.ok).toBe(true);

    // Presence store should be cleaned
    expect(presenceStore.has(session.id)).toBe(false);
  });

  it('IT-238: delete() returns error for nonexistent session', async () => {
    const result = await service.delete('nonexistent-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  // ===== listSessionsWithFilters() =====

  it('IT-239: listSessionsWithFilters() filters by codespaceId', async () => {
    const codespace1 = await createTestProject({ name: 'Project A' });
    const codespace2 = await createTestProject({ name: 'Project B' });

    await createTestSession(codespace1.id, { title: 'Sess A1' });
    await createTestSession(codespace1.id, { title: 'Sess A2' });
    await createTestSession(codespace2.id, { title: 'Sess B1' });

    const result = await service.listSessionsWithFilters(codespace1.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(2);
    expect(result.value.total).toBe(2);
    for (const s of result.value.sessions) {
      expect(s.codespaceId).toBe(codespace1.id);
    }
  });

  it('IT-240: listSessionsWithFilters() filters by status', async () => {
    const codespace = await createTestProject();

    await createTestSession(codespace.id, { status: 'active', title: 'Active 1' });
    await createTestSession(codespace.id, { status: 'active', title: 'Active 2' });
    await createTestSession(codespace.id, {
      status: 'closed',
      title: 'Closed 1',
      closedAt: new Date().toISOString(),
    });

    const result = await service.listSessionsWithFilters(codespace.id, {
      status: ['active'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(2);
    expect(result.value.total).toBe(2);
  });

  it('IT-241: listSessionsWithFilters() filters by agentId', async () => {
    const codespace = await createTestProject();
    const agent1 = await createTestAgent(codespace.id, { name: 'Agent A' });
    const agent2 = await createTestAgent(codespace.id, { name: 'Agent B' });

    await createTestSession(codespace.id, { agentId: agent1.id, title: 'Agent A Session' });
    await createTestSession(codespace.id, { agentId: agent2.id, title: 'Agent B Session' });

    const result = await service.listSessionsWithFilters(codespace.id, {
      agentId: agent1.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(1);
    expect(result.value.sessions[0].title).toBe('Agent A Session');
  });

  it('IT-242: listSessionsWithFilters() filters by date range', async () => {
    const codespace = await createTestProject();

    const s1 = await createTestSession(codespace.id, { title: 'Old' });
    const s2 = await createTestSession(codespace.id, { title: 'New' });

    // Set explicit dates
    await db
      .update(sessions)
      .set({ createdAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(sessions.id, s1.id));
    await db
      .update(sessions)
      .set({ createdAt: '2026-03-01T00:00:00.000Z' })
      .where(eq(sessions.id, s2.id));

    const result = await service.listSessionsWithFilters(codespace.id, {
      dateFrom: '2026-02-01T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(1);
    expect(result.value.sessions[0].title).toBe('New');
  });

  it('IT-243: listSessionsWithFilters() filters by search term (title LIKE)', async () => {
    const codespace = await createTestProject();

    await createTestSession(codespace.id, { title: 'Deploy Alpha' });
    await createTestSession(codespace.id, { title: 'Deploy Beta' });
    await createTestSession(codespace.id, { title: 'Review Gamma' });

    const result = await service.listSessionsWithFilters(codespace.id, {
      search: 'Deploy',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(2);
    expect(result.value.total).toBe(2);
  });

  it('IT-244: listSessionsWithFilters() respects pagination (limit/offset)', async () => {
    const codespace = await createTestProject();

    for (let i = 0; i < 5; i++) {
      await createTestSession(codespace.id, { title: `Paginated ${i}` });
    }

    const result = await service.listSessionsWithFilters(codespace.id, {
      limit: 2,
      offset: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.length).toBe(2);
    expect(result.value.total).toBe(5);
  });

  // ===== generateUrl() / parseUrl() =====

  it('IT-245: generateUrl() and parseUrl() are inverses', () => {
    const sessionId = 'abc123xyz';
    const url = service.generateUrl(sessionId);
    expect(url).toBe(`${BASE_URL}/sessions/${sessionId}`);

    const parseResult = service.parseUrl(url);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;
    expect(parseResult.value).toBe(sessionId);
  });

  it('IT-245b: parseUrl() handles various valid URLs', () => {
    const result = service.parseUrl('https://example.com/sessions/myid123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('myid123');
  });

  it('IT-245c: parseUrl() rejects URLs without session path', () => {
    const result = service.parseUrl('https://example.com/codespaces/foo');
    expect(result.ok).toBe(false);
  });

  it('IT-245d: parseUrl() rejects malformed URLs', () => {
    const result = service.parseUrl('not-a-url');
    expect(result.ok).toBe(false);
  });

  it('IT-245e: parseUrl() rejects URLs with trailing path segments after session ID', () => {
    // The regex requires the session ID at the end of the path
    const result = service.parseUrl('https://example.com/sessions/abc123/extra');
    expect(result.ok).toBe(false);
  });
});
