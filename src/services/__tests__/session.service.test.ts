import { describe, expect, it, vi } from 'vitest';
import { SessionErrors } from '../../lib/errors/session-errors.js';
import { SessionService } from '../session.service.js';

const createDbMock = () => ({
  query: {
    projects: { findFirst: vi.fn() },
    sessions: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
});

const createStreamsMock = () => ({
  createStream: vi.fn(),
  publish: vi.fn().mockResolvedValue(1), // Returns offset
  subscribe: vi.fn(async function* () {
    yield { type: 'chunk', data: { text: 'hello' } };
  }),
});

describe('SessionService', () => {
  it('creates session and returns active status', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 's1', status: 'initializing' }]),
      })),
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.create({ projectId: 'p1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
    }
  });

  it('returns error when session missing', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.getById('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('publishes events via streams', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.publish('s1', {
      id: 'e1',
      type: 'chunk',
      timestamp: 1,
      data: { text: 'hi' },
    });

    expect(result.ok).toBe(true);
    expect(streams.publish).toHaveBeenCalled();
  });

  it('subscribe yields events', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const iterable = service.subscribe('s1');
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
  });

  it('returns error when project not found on create', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.projects.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.create({ projectId: 'missing' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    }
  });

  it('returns error when insert returns nothing', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.create({ projectId: 'p1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('getById returns session with presence', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
      url: 'http://localhost:3000/sessions/s1',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.getById('s1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('s1');
      expect(result.value.presence).toEqual([]);
    }
  });

  it('list returns sessions with pagination defaults', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findMany.mockResolvedValue([
      { id: 's1', projectId: 'p1', status: 'active' },
      { id: 's2', projectId: 'p1', status: 'closed' },
    ]);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('list respects pagination options', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findMany.mockResolvedValue([{ id: 's1' }]);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.list({
      limit: 10,
      offset: 5,
      orderBy: 'createdAt',
      orderDirection: 'asc',
    });

    expect(result.ok).toBe(true);
  });

  it('close updates session status', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 's1', status: 'closed' }]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.close('s1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('closed');
    }
  });

  it('close returns error when session not found', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const updateWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([]),
    }));
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.close('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('join adds user to presence', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.join('s1', 'user1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.presence).toHaveLength(1);
      expect(result.value.presence[0]?.userId).toBe('user1');
    }
    expect(streams.publish).toHaveBeenCalled();
  });

  it('join returns error when session not found', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.join('missing', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('join returns error when session is closed', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      status: 'closed',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.join('s1', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.CLOSED);
    }
  });

  it('leave removes user from presence', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    // First join the session
    await service.join('s1', 'user1');

    // Then leave
    const result = await service.leave('s1', 'user1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.presence).toHaveLength(0);
    }
    expect(streams.publish).toHaveBeenCalled();
  });

  it('leave returns error when session not found', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.leave('missing', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('updatePresence updates user presence data', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    // First join the session
    await service.join('s1', 'user1');

    // Then update presence
    const result = await service.updatePresence('s1', 'user1', {
      cursor: { x: 100, y: 200 },
      activeFile: 'src/index.ts',
    });

    expect(result.ok).toBe(true);
    expect(streams.publish).toHaveBeenCalled();
  });

  it('updatePresence returns error when session not found', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.updatePresence('missing', 'user1', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('updatePresence returns error when user not in session', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.updatePresence('s1', 'unknown-user', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('getActiveUsers returns users in session', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      status: 'active',
    });

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    // First join the session
    await service.join('s1', 'user1');
    await service.join('s1', 'user2');

    const result = await service.getActiveUsers('s1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('getActiveUsers returns error when session not found', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    db.query.sessions.findFirst.mockResolvedValue(null);

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.getActiveUsers('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
    }
  });

  it('publish returns error when streams fail', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();
    streams.publish.mockRejectedValue(new Error('stream error'));

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.publish('s1', {
      id: 'e1',
      type: 'chunk',
      timestamp: 1,
      data: { text: 'hi' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_SYNC_FAILED');
    }
  });

  it('getHistory returns empty array when no startTime', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.getHistory('s1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it('getHistory returns events with startTime', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = await service.getHistory('s1', { startTime: 1000 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.type).toBe('chunk');
    }
  });

  it('generateUrl creates correct URL', () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const url = service.generateUrl('abc123');

    expect(url).toBe('http://localhost:3000/sessions/abc123');
  });

  it('parseUrl extracts session ID from valid URL', () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = service.parseUrl('http://localhost:3000/sessions/abc123');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('abc123');
    }
  });

  it('parseUrl returns error for invalid URL', () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = service.parseUrl('not-a-url');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_URL');
    }
  });

  it('parseUrl returns error for URL without session ID', () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const result = service.parseUrl('http://localhost:3000/other/path');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_URL');
    }
  });

  it('subscribe skips history when includeHistory is false', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const iterable = service.subscribe('s1', { includeHistory: false });
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();

    // With Caddy durable streams, subscribe() only replays history.
    // When includeHistory is false and live subscription is via Caddy,
    // the iterator completes immediately.
    expect(first.done).toBe(true);
  });

  it('subscribe uses custom startTime', async () => {
    const db = createDbMock();
    const streams = createStreamsMock();

    const service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });

    const iterable = service.subscribe('s1', {
      startTime: 5000,
      includeHistory: true,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();

    // With includeHistory: true and a startTime, getHistory returns a hardcoded chunk event
    expect(first.done).toBe(false);
  });
});
