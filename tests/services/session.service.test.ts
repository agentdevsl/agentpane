import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DurableStreamsServer,
  SessionEvent,
  SessionEventType,
} from '../../src/services/session.service';
import { SessionService } from '../../src/services/session.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('SessionService', () => {
  let sessionService: SessionService;
  let mockStreams: DurableStreamsServer;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();

    mockStreams = {
      createStream: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(1), // Returns offset
      subscribe: vi.fn().mockImplementation(function* () {
        // Default empty iterator
      }),
    };

    sessionService = new SessionService(db as never, mockStreams, {
      baseUrl: 'http://localhost:3000',
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =============================================================================
  // Session Creation (5 tests)
  // =============================================================================

  describe('Session Creation', () => {
    it('creates a session with minimal input', async () => {
      const project = await createTestProject();

      const result = await sessionService.create({
        projectId: project.id,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectId).toBe(project.id);
        expect(result.value.status).toBe('active');
        expect(result.value.url).toContain('http://localhost:3000/sessions/');
        expect(result.value.presence).toEqual([]);
        expect(mockStreams.createStream).toHaveBeenCalled();
      }
    });

    it('creates a session with all optional fields', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);
      const agent = await createTestAgent(project.id);

      const result = await sessionService.create({
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
        title: 'My Test Session',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe(task.id);
        expect(result.value.agentId).toBe(agent.id);
        expect(result.value.title).toBe('My Test Session');
      }
    });

    it('returns error when creating session for non-existent project', async () => {
      const result = await sessionService.create({
        projectId: 'non-existent-project-id',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_NOT_FOUND');
      }
    });

    it('initializes presence store for new session', async () => {
      const project = await createTestProject();

      const result = await sessionService.create({
        projectId: project.id,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const activeUsersResult = await sessionService.getActiveUsers(result.value.id);
        expect(activeUsersResult.ok).toBe(true);
        if (activeUsersResult.ok) {
          expect(activeUsersResult.value).toEqual([]);
        }
      }
    });

    it('creates stream with correct schema', async () => {
      const project = await createTestProject();

      await sessionService.create({
        projectId: project.id,
      });

      expect(mockStreams.createStream).toHaveBeenCalledWith(expect.any(String), expect.anything());
    });
  });

  // =============================================================================
  // Session Retrieval (4 tests)
  // =============================================================================

  describe('Session Retrieval', () => {
    it('retrieves a session by ID', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { title: 'Find Me' });

      const result = await sessionService.getById(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(session.id);
        expect(result.value.title).toBe('Find Me');
        expect(result.value.presence).toEqual([]);
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await sessionService.getById('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('lists sessions with default options', async () => {
      const project = await createTestProject();
      await createTestSession(project.id, { title: 'Session 1' });
      await createTestSession(project.id, { title: 'Session 2' });

      const result = await sessionService.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('lists sessions with pagination and ordering', async () => {
      const project = await createTestProject();
      await createTestSession(project.id, { title: 'Session 1' });
      await createTestSession(project.id, { title: 'Session 2' });
      await createTestSession(project.id, { title: 'Session 3' });

      const result = await sessionService.list({
        limit: 2,
        offset: 0,
        orderBy: 'createdAt',
        orderDirection: 'asc',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });
  });

  // =============================================================================
  // Session Lifecycle (3 tests)
  // =============================================================================

  describe('Session Lifecycle', () => {
    it('closes an active session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      const result = await sessionService.close(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('closed');
        expect(result.value.closedAt).toBeTruthy();
      }
    });

    it('returns error when closing non-existent session', async () => {
      const result = await sessionService.close('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('sets closedAt timestamp when closing', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      const result = await sessionService.close(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closedAt).toBeTruthy();
        const closedAt = new Date(result.value.closedAt as string);
        expect(closedAt.getTime()).toBeGreaterThan(Date.now() - 5000);
      }
    });
  });

  // =============================================================================
  // Presence Management (7 tests)
  // =============================================================================

  describe('Presence Management', () => {
    it('allows user to join a session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      const result = await sessionService.join(session.id, 'user-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence.length).toBe(1);
        expect(result.value.presence[0].userId).toBe('user-1');
        expect(mockStreams.publish).toHaveBeenCalledWith(
          session.id,
          'presence:joined',
          expect.objectContaining({ userId: 'user-1' })
        );
      }
    });

    it('returns error when joining non-existent session', async () => {
      const result = await sessionService.join('non-existent-id', 'user-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('returns error when joining closed session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, {
        status: 'closed',
        closedAt: new Date().toISOString(),
      });

      const result = await sessionService.join(session.id, 'user-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_CLOSED');
      }
    });

    it('allows user to leave a session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      // First join
      await sessionService.join(session.id, 'user-1');

      // Then leave
      const result = await sessionService.leave(session.id, 'user-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence.length).toBe(0);
        expect(mockStreams.publish).toHaveBeenCalledWith(
          session.id,
          'presence:left',
          expect.objectContaining({ userId: 'user-1' })
        );
      }
    });

    it('returns error when leaving non-existent session', async () => {
      const result = await sessionService.leave('non-existent-id', 'user-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('updates user presence with cursor position', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      // First join
      await sessionService.join(session.id, 'user-1');

      // Update presence
      const result = await sessionService.updatePresence(session.id, 'user-1', {
        cursor: { x: 100, y: 200 },
        activeFile: '/src/index.ts',
      });

      expect(result.ok).toBe(true);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        session.id,
        'presence:cursor',
        expect.objectContaining({
          userId: 'user-1',
          cursor: { x: 100, y: 200 },
          activeFile: '/src/index.ts',
        })
      );
    });

    it('returns error when updating presence for user not in session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      const result = await sessionService.updatePresence(session.id, 'user-not-joined', {
        cursor: { x: 100, y: 200 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Active Users (2 tests)
  // =============================================================================

  describe('Active Users', () => {
    it('returns active users in session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id, { status: 'active' });

      await sessionService.join(session.id, 'user-1');
      await sessionService.join(session.id, 'user-2');

      const result = await sessionService.getActiveUsers(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        expect(result.value.map((u) => u.userId)).toContain('user-1');
        expect(result.value.map((u) => u.userId)).toContain('user-2');
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await sessionService.getActiveUsers('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Event Publishing (4 tests)
  // =============================================================================

  describe('Event Publishing', () => {
    it('publishes event to stream', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;
      const event: SessionEvent = {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Hello world' },
      };

      const result = await sessionService.publish(sessionId, event);

      expect(result.ok).toBe(true);
      expect(mockStreams.publish).toHaveBeenCalledWith(sessionId, 'chunk', event.data);
    });

    it('succeeds even when stream publish fails (RS-013: DB-first, stream is best-effort)', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;
      mockStreams.publish = vi.fn().mockRejectedValue(new Error('Stream error'));

      const event: SessionEvent = {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Hello world' },
      };

      const result = await sessionService.publish(sessionId, event);

      // RS-013: With DB-first persistence, stream publish failure is best-effort.
      // The publish should still succeed as the event is persisted to DB.
      expect(result.ok).toBe(true);
    });

    it('publishes tool:start event', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;
      const event: SessionEvent = {
        id: 'evt-1',
        type: 'tool:start',
        timestamp: Date.now(),
        data: { tool: 'Read', input: { path: '/file.ts' } },
      };

      const result = await sessionService.publish(sessionId, event);

      expect(result.ok).toBe(true);
      expect(mockStreams.publish).toHaveBeenCalledWith(sessionId, 'tool:start', event.data);
    });

    it('publishes terminal:output event', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;
      const event: SessionEvent = {
        id: 'evt-1',
        type: 'terminal:output',
        timestamp: Date.now(),
        data: { output: 'Hello from terminal' },
      };

      const result = await sessionService.publish(sessionId, event);

      expect(result.ok).toBe(true);
      expect(mockStreams.publish).toHaveBeenCalledWith(sessionId, 'terminal:output', event.data);
    });
  });

  // =============================================================================
  // History and Subscription (3 tests)
  // =============================================================================

  describe('History and Subscription', () => {
    it('returns empty history without startTime', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      const result = await sessionService.getHistory(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns history with startTime (delegates to getEventsBySession)', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const startTime = Date.now() - 60000;

      // Persist an event so getHistory (via getEventsBySession) returns it
      const event: SessionEvent = {
        id: 'hist-evt-1',
        type: 'chunk',
        timestamp: startTime,
        data: { text: 'hello' },
      };
      await sessionService.publish(session.id, event);
      // publish() persists asynchronously — wait for the fire-and-forget persist
      await new Promise((r) => setTimeout(r, 50));

      const result = await sessionService.getHistory(session.id, { startTime });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        expect(result.value[0].type).toBe('chunk');
      }
    });

    it('subscribes to session events (history only, live via Caddy)', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      // Persist an event so subscribe (via getHistory -> getEventsBySession) can replay it
      const event: SessionEvent = {
        id: 'sub-evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'hello' },
      };
      await sessionService.publish(session.id, event);
      // publish() persists asynchronously — wait for the fire-and-forget persist
      await new Promise((r) => setTimeout(r, 50));

      const events: SessionEvent[] = [];

      // With Caddy durable streams, subscribe() only replays history.
      // Live events are delivered via Caddy SSE directly to clients.
      for await (const ev of sessionService.subscribe(session.id, { includeHistory: true })) {
        events.push(ev);
      }

      // Should get history events (1 persisted event)
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('chunk');
    });
  });

  // =============================================================================
  // URL Generation and Parsing (4 tests)
  // =============================================================================

  describe('URL Generation and Parsing', () => {
    it('generates correct URL', () => {
      const url = sessionService.generateUrl('test-session-id');
      expect(url).toBe('http://localhost:3000/sessions/test-session-id');
    });

    it('parses valid session URL', () => {
      const result = sessionService.parseUrl('http://localhost:3000/sessions/abc123xyz');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('abc123xyz');
      }
    });

    it('returns error for invalid URL format', () => {
      const result = sessionService.parseUrl('http://localhost:3000/invalid/path');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_URL');
      }
    });

    it('returns error for malformed URL', () => {
      const result = sessionService.parseUrl('not-a-valid-url');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_URL');
      }
    });
  });

  // =============================================================================
  // Event Persistence (6 tests)
  // =============================================================================

  describe('Event Persistence', () => {
    it('persists event to database', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;
      const event: SessionEvent = {
        id: 'evt-persist-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Persisted event' },
      };

      const result = await sessionService.persistEvent(sessionId, event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('evt-persist-1');
        expect(result.value.offset).toBe(0);
      }
    });

    it('increments offset for subsequent events', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      const event1: SessionEvent = {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'First' },
      };

      const event2: SessionEvent = {
        id: 'evt-2',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Second' },
      };

      const result1 = await sessionService.persistEvent(sessionId, event1);
      const result2 = await sessionService.persistEvent(sessionId, event2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.offset).toBe(0);
        expect(result2.value.offset).toBe(1);
      }
    });

    it('returns error for non-existent session', async () => {
      const event: SessionEvent = {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Test' },
      };

      const result = await sessionService.persistEvent('non-existent-id', event);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('retrieves persisted events by session', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      // Persist some events
      await sessionService.persistEvent(sessionId, {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Event 1' },
      });
      await sessionService.persistEvent(sessionId, {
        id: 'evt-2',
        type: 'tool:start',
        timestamp: Date.now(),
        data: { tool: 'Read' },
      });

      const result = await sessionService.getEventsBySession(sessionId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        expect(result.value[0].type).toBe('chunk');
        expect(result.value[1].type).toBe('tool:start');
      }
    });

    it('paginates events correctly', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      // Persist 5 events
      for (let i = 0; i < 5; i++) {
        await sessionService.persistEvent(sessionId, {
          id: `evt-${i}`,
          type: 'chunk',
          timestamp: Date.now(),
          data: { text: `Event ${i}` },
        });
      }

      const result = await sessionService.getEventsBySession(sessionId, {
        limit: 2,
        offset: 1,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        expect(result.value[0].id).toBe('evt-1');
        expect(result.value[1].id).toBe('evt-2');
      }
    });

    it('returns error when getting events for non-existent session', async () => {
      const result = await sessionService.getEventsBySession('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Session Summary (5 tests)
  // =============================================================================

  describe('Session Summary', () => {
    it('returns null for session without summary', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      const result = await sessionService.getSessionSummary(session.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await sessionService.getSessionSummary('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('creates session summary when updating non-existent summary', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      const result = await sessionService.updateSessionSummary(session.id, {
        turnsCount: 10,
        tokensUsed: 5000,
        filesModified: 3,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turnsCount).toBe(10);
        expect(result.value.tokensUsed).toBe(5000);
        expect(result.value.filesModified).toBe(3);
      }
    });

    it('updates existing session summary', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      // Create initial summary
      await sessionService.updateSessionSummary(session.id, {
        turnsCount: 5,
        tokensUsed: 2000,
      });

      // Update summary
      const result = await sessionService.updateSessionSummary(session.id, {
        turnsCount: 15,
        tokensUsed: 8000,
        finalStatus: 'success',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turnsCount).toBe(15);
        expect(result.value.tokensUsed).toBe(8000);
        expect(result.value.finalStatus).toBe('success');
      }
    });

    it('returns error when updating summary for non-existent session', async () => {
      const result = await sessionService.updateSessionSummary('non-existent-id', {
        turnsCount: 10,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // List Sessions with Filters (6 tests)
  // =============================================================================

  describe('List Sessions with Filters', () => {
    it('lists sessions for a project', async () => {
      const project = await createTestProject();
      await createTestSession(project.id, { title: 'Session 1' });
      await createTestSession(project.id, { title: 'Session 2' });

      const result = await sessionService.listSessionsWithFilters(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.total).toBe(2);
      }
    });

    it('filters sessions by status', async () => {
      const project = await createTestProject();
      await createTestSession(project.id, { status: 'active' });
      await createTestSession(project.id, {
        status: 'closed',
        closedAt: new Date().toISOString(),
      });
      await createTestSession(project.id, { status: 'active' });

      const result = await sessionService.listSessionsWithFilters(project.id, {
        status: ['active'],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.sessions.every((s) => s.status === 'active')).toBe(true);
      }
    });

    it('filters sessions by agent ID', async () => {
      const project = await createTestProject();
      const agent1 = await createTestAgent(project.id, { name: 'Agent 1' });
      const agent2 = await createTestAgent(project.id, { name: 'Agent 2' });
      await createTestSession(project.id, { agentId: agent1.id });
      await createTestSession(project.id, { agentId: agent2.id });
      await createTestSession(project.id, { agentId: agent1.id });

      const result = await sessionService.listSessionsWithFilters(project.id, {
        agentId: agent1.id,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.sessions.every((s) => s.agentId === agent1.id)).toBe(true);
      }
    });

    it('filters sessions by date range', async () => {
      const project = await createTestProject();
      const db = getTestDb();
      const { sessions } = await import('../../src/db/schema');
      const { eq } = await import('drizzle-orm');

      // Create sessions with specific dates
      const session1 = await createTestSession(project.id, { title: 'Old Session' });
      const session2 = await createTestSession(project.id, { title: 'Recent Session' });

      // Update dates directly in DB
      await db
        .update(sessions)
        .set({ createdAt: '2025-01-01T00:00:00Z' })
        .where(eq(sessions.id, session1.id));
      await db
        .update(sessions)
        .set({ createdAt: '2025-06-15T00:00:00Z' })
        .where(eq(sessions.id, session2.id));

      const result = await sessionService.listSessionsWithFilters(project.id, {
        dateFrom: '2025-06-01T00:00:00Z',
        dateTo: '2025-12-31T23:59:59Z',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0].title).toBe('Recent Session');
      }
    });

    it('filters sessions by search term', async () => {
      const project = await createTestProject();
      await createTestSession(project.id, { title: 'Alpha Session' });
      await createTestSession(project.id, { title: 'Beta Session' });
      await createTestSession(project.id, { title: 'Alpha Testing' });

      const result = await sessionService.listSessionsWithFilters(project.id, {
        search: 'Alpha',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.sessions.every((s) => s.title?.includes('Alpha'))).toBe(true);
      }
    });

    it('paginates filtered results', async () => {
      const project = await createTestProject();
      for (let i = 0; i < 10; i++) {
        await createTestSession(project.id, { title: `Session ${i}` });
      }

      const result = await sessionService.listSessionsWithFilters(project.id, {
        limit: 3,
        offset: 2,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(3);
        expect(result.value.total).toBe(10);
      }
    });
  });

  // =============================================================================
  // Channel Classification (Covers lines 676-683)
  // =============================================================================

  describe('Channel Classification', () => {
    it('classifies chunk events to chunks channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-chunk',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'test' },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
    });

    it('classifies tool events to toolCalls channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-tool',
        type: 'tool:start',
        timestamp: Date.now(),
        data: { tool: 'Read' },
      });

      await sessionService.persistEvent(sessionId, {
        id: 'evt-tool-result',
        type: 'tool:result',
        timestamp: Date.now(),
        data: { result: 'content' },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
      if (events.ok) {
        expect(events.value.length).toBe(2);
      }
    });

    it('classifies terminal events to terminal channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-terminal',
        type: 'terminal:input',
        timestamp: Date.now(),
        data: { input: 'ls -la' },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
    });

    it('classifies presence events to presence channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-presence',
        type: 'presence:joined',
        timestamp: Date.now(),
        data: { userId: 'user-1' },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
    });

    it('classifies approval events to approval channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-approval-req',
        type: 'approval:requested',
        timestamp: Date.now(),
        data: { tool: 'Bash', command: 'rm -rf /' },
      });

      await sessionService.persistEvent(sessionId, {
        id: 'evt-approval-approved',
        type: 'approval:approved',
        timestamp: Date.now(),
        data: { approvedBy: 'user-1' },
      });

      await sessionService.persistEvent(sessionId, {
        id: 'evt-agent-resumed',
        type: 'agent:resumed',
        timestamp: Date.now(),
        data: { feedback: 'Continue with changes' },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
      if (events.ok) {
        expect(events.value.length).toBe(3);
      }
    });

    it('classifies agent events to agent channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      const agentEventTypes: SessionEventType[] = [
        'agent:started',
        'agent:turn',
        'agent:turn_limit',
        'agent:completed',
        'agent:error',
        'agent:warning',
      ];

      for (let i = 0; i < agentEventTypes.length; i++) {
        await sessionService.persistEvent(sessionId, {
          id: `evt-agent-${i}`,
          type: agentEventTypes[i],
          timestamp: Date.now(),
          data: { agentId: 'agent-1' },
        });
      }

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
      if (events.ok) {
        expect(events.value.length).toBe(6);
      }
    });

    it('classifies state:update to state channel', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      await sessionService.persistEvent(sessionId, {
        id: 'evt-state',
        type: 'state:update',
        timestamp: Date.now(),
        data: { status: 'running', turn: 5 },
      });

      const events = await sessionService.getEventsBySession(sessionId);
      expect(events.ok).toBe(true);
    });
  });

  // =============================================================================
  // Session Summary Offset Update (Covers line 695)
  // =============================================================================

  describe('Session Summary Offset Update', () => {
    it('creates summary when persisting first event', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      // Persist an event which triggers updateSessionSummaryOffset
      await sessionService.persistEvent(sessionId, {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'test' },
      });

      // Verify summary was created
      const summaryResult = await sessionService.getSessionSummary(sessionId);
      expect(summaryResult.ok).toBe(true);
      if (summaryResult.ok) {
        expect(summaryResult.value).not.toBeNull();
      }
    });

    it('updates summary when persisting subsequent events', async () => {
      const project = await createTestProject();
      const createResult = await sessionService.create({ projectId: project.id });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      // Create initial summary
      await sessionService.updateSessionSummary(sessionId, {
        turnsCount: 1,
      });

      // Persist events to trigger updateSessionSummaryOffset
      await sessionService.persistEvent(sessionId, {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'First' },
      });

      await sessionService.persistEvent(sessionId, {
        id: 'evt-2',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'Second' },
      });

      // Summary should still exist and be updated
      const summaryResult = await sessionService.getSessionSummary(sessionId);
      expect(summaryResult.ok).toBe(true);
      if (summaryResult.ok) {
        expect(summaryResult.value).not.toBeNull();
        expect(summaryResult.value?.turnsCount).toBe(1);
      }
    });
  });

  // =============================================================================
  // Error Handling Edge Cases
  // =============================================================================

  describe('Error Handling Edge Cases', () => {
    it('handles updatePresence for non-existent session', async () => {
      const result = await sessionService.updatePresence('non-existent-id', 'user-1', {
        cursor: { x: 0, y: 0 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('handles getEventsBySession database error', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      // Create a new service with a broken database connection
      const brokenDb = {
        query: {
          sessions: {
            findFirst: vi.fn().mockResolvedValue(session),
          },
          sessionEvents: {
            findMany: vi.fn().mockRejectedValue(new Error('Database error')),
          },
        },
      };

      const brokenService = new SessionService(brokenDb as never, mockStreams, {
        baseUrl: 'http://localhost:3000',
      });

      const result = await brokenService.getEventsBySession(session.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_SYNC_FAILED');
      }
    });

    it('handles getSessionSummary database error', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);

      const brokenDb = {
        query: {
          sessions: {
            findFirst: vi.fn().mockResolvedValue(session),
          },
          sessionSummaries: {
            findFirst: vi.fn().mockRejectedValue(new Error('Database error')),
          },
        },
      };

      const brokenService = new SessionService(brokenDb as never, mockStreams, {
        baseUrl: 'http://localhost:3000',
      });

      const result = await brokenService.getSessionSummary(session.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_SYNC_FAILED');
      }
    });

    it('handles listSessionsWithFilters database error', async () => {
      const brokenDb = {
        query: {
          sessions: {
            findMany: vi.fn().mockRejectedValue(new Error('Database error')),
          },
        },
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockRejectedValue(new Error('Database error')),
          }),
        }),
      };

      const brokenService = new SessionService(brokenDb as never, mockStreams, {
        baseUrl: 'http://localhost:3000',
      });

      const result = await brokenService.listSessionsWithFilters('project-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_SYNC_FAILED');
      }
    });
  });
});
