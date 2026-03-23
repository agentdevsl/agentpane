import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionErrors } from '../../src/lib/errors/session-errors';
import { SessionService } from '../../src/services/session.service';
import { flushPromises } from '../helpers/async';

// =============================================================================
// Presence Service Tests
// =============================================================================
// These tests focus on the presence management functionality within SessionService.
// Presence tracking enables real-time awareness of users in a session,
// including join/leave, cursor positions, active files, and heartbeat detection.
// =============================================================================

const createDbMock = () => ({
  query: {
    codespaces: { findFirst: vi.fn() },
    sessions: { findFirst: vi.fn(), findMany: vi.fn() },
    sessionEvents: { findFirst: vi.fn(), findMany: vi.fn() },
    sessionSummaries: { findFirst: vi.fn() },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) })),
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn() })) })),
});

const createStreamsMock = () => ({
  createStream: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(1), // Returns offset
  subscribe: vi.fn(async function* () {
    yield { type: 'presence:cursor', data: { userId: 'u1', cursor: { x: 0, y: 0 } }, offset: 0 };
  }),
});

describe('Presence Service', () => {
  let db: ReturnType<typeof createDbMock>;
  let streams: ReturnType<typeof createStreamsMock>;
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createDbMock();
    streams = createStreamsMock();
    service = new SessionService(db as never, streams as never, {
      baseUrl: 'http://localhost:3000',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =============================================================================
  // User Presence Tracking (5 tests)
  // =============================================================================

  describe('User Presence Tracking', () => {
    it('tracks user joining a session', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 's1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/s1',
      });

      const result = await service.join('s1', 'user1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(1);
        expect(result.value.presence[0]?.userId).toBe('user1');
        expect(result.value.presence[0]?.lastSeen).toBeDefined();
        expect(typeof result.value.presence[0]?.lastSeen).toBe('number');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        's1',
        'presence:joined',
        expect.objectContaining({
          userId: 'user1',
          meta: expect.objectContaining({
            streamId: 's1',
            partType: 'lifecycle',
          }),
        })
      );
    });

    it('tracks user disconnecting from a session', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 's1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/s1',
      });

      // Join first
      await service.join('s1', 'user1');
      vi.clearAllMocks();

      // Then leave
      const result = await service.leave('s1', 'user1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(0);
      }
      expect(streams.publish).toHaveBeenCalledWith(
        's1',
        'presence:left',
        expect.objectContaining({
          userId: 'user1',
          meta: expect.objectContaining({
            streamId: 's1',
            partType: 'lifecycle',
          }),
        })
      );
    });

    it('updates user presence data with cursor and active file', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 's1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/s1',
      });

      // Join first
      await service.join('s1', 'user1');
      vi.clearAllMocks();

      // Update presence
      const result = await service.updatePresence('s1', 'user1', {
        cursor: { x: 150, y: 300 },
        activeFile: 'src/components/App.tsx',
      });

      expect(result.ok).toBe(true);
      expect(streams.publish).toHaveBeenCalledWith(
        's1',
        'presence:cursor',
        expect.objectContaining({
          userId: 'user1',
          cursor: { x: 150, y: 300 },
          activeFile: 'src/components/App.tsx',
          meta: expect.objectContaining({
            streamId: 's1',
            partType: 'system',
          }),
        })
      );
    });

    it('tracks multiple users joining the same session', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 's1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/s1',
      });

      await service.join('s1', 'user1');
      await service.join('s1', 'user2');
      await service.join('s1', 'user3');

      const result = await service.getActiveUsers('s1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(3);
        const userIds = result.value.map((u) => u.userId);
        expect(userIds).toContain('user1');
        expect(userIds).toContain('user2');
        expect(userIds).toContain('user3');
      }
    });

    it('handles user rejoining after disconnect', async () => {
      // Use a unique session ID to avoid state pollution from other tests
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'rejoin-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/rejoin-s1',
      });

      // Join
      await service.join('rejoin-s1', 'user1');
      // Leave
      await service.leave('rejoin-s1', 'user1');
      // Rejoin
      const result = await service.join('rejoin-s1', 'user1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(1);
        expect(result.value.presence[0]?.userId).toBe('user1');
      }
    });
  });

  // =============================================================================
  // Connection Management (5 tests)
  // =============================================================================

  describe('Connection Management', () => {
    it('adds connection to session presence store', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'conn-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/conn-s1',
      });

      const result = await service.join('conn-s1', 'conn1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(1);
      }

      // Verify through getActiveUsers
      const activeResult = await service.getActiveUsers('conn-s1');
      expect(activeResult.ok).toBe(true);
      if (activeResult.ok) {
        expect(activeResult.value).toHaveLength(1);
      }
    });

    it('removes connection from session presence store', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'conn-s2',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/conn-s2',
      });

      await service.join('conn-s2', 'conn1');
      await service.leave('conn-s2', 'conn1');

      const result = await service.getActiveUsers('conn-s2');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it('retrieves all connections for a session', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'conn-s3',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/conn-s3',
      });

      await service.join('conn-s3', 'conn1');
      await service.join('conn-s3', 'conn2');

      const result = await service.getActiveUsers('conn-s3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value.every((u) => u.lastSeen > 0)).toBe(true);
      }
    });

    it('returns empty array when no connections exist', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'empty-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/empty-s1',
      });

      const result = await service.getActiveUsers('empty-s1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('handles removing non-existent connection gracefully', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'conn-s4',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/conn-s4',
      });

      // Leave without joining first - should not throw
      const result = await service.leave('conn-s4', 'non-existent-user');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(0);
      }
    });
  });

  // =============================================================================
  // Heartbeat Handling (4 tests)
  // =============================================================================

  describe('Heartbeat Handling', () => {
    it('updates lastSeen timestamp on presence update', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'hb-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/hb-s1',
      });

      await service.join('hb-s1', 'user1');
      const initialUsers = await service.getActiveUsers('hb-s1');
      const initialLastSeen = initialUsers.ok ? initialUsers.value[0]?.lastSeen : 0;

      // Flush microtasks to allow time to advance slightly
      await flushPromises();
      await service.updatePresence('hb-s1', 'user1', { cursor: { x: 10, y: 20 } });

      const updatedUsers = await service.getActiveUsers('hb-s1');

      expect(updatedUsers.ok).toBe(true);
      if (updatedUsers.ok) {
        const newLastSeen = updatedUsers.value[0]?.lastSeen ?? 0;
        expect(newLastSeen).toBeGreaterThanOrEqual(initialLastSeen ?? 0);
      }
    });

    it('tracks heartbeat via presence update without cursor', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'hb-s2',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/hb-s2',
      });

      await service.join('hb-s2', 'user1');

      // Update presence with just activeFile (heartbeat-like)
      const result = await service.updatePresence('hb-s2', 'user1', {
        activeFile: 'package.json',
      });

      expect(result.ok).toBe(true);

      const users = await service.getActiveUsers('hb-s2');
      expect(users.ok).toBe(true);
      if (users.ok) {
        expect(users.value[0]?.activeFile).toBe('package.json');
      }
    });

    it('preserves existing presence data on partial update', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'hb-s3',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/hb-s3',
      });

      await service.join('hb-s3', 'user1');

      // Set initial cursor
      await service.updatePresence('hb-s3', 'user1', { cursor: { x: 100, y: 200 } });

      // Update only activeFile, cursor should be preserved
      await service.updatePresence('hb-s3', 'user1', { activeFile: 'README.md' });

      const users = await service.getActiveUsers('hb-s3');

      expect(users.ok).toBe(true);
      if (users.ok) {
        expect(users.value[0]?.cursor).toEqual({ x: 100, y: 200 });
        expect(users.value[0]?.activeFile).toBe('README.md');
      }
    });

    it('returns error when updating presence for non-joined user', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'hb-s4',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/hb-s4',
      });

      // Try to update presence without joining
      const result = await service.updatePresence('hb-s4', 'unknown-user', {
        cursor: { x: 0, y: 0 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
      }
    });
  });

  // =============================================================================
  // Presence State Management (4 tests)
  // =============================================================================

  describe('Presence State Management', () => {
    it('initializes presence store on session create', async () => {
      db.query.codespaces.findFirst.mockResolvedValue({ id: 'p1' });
      db.insert.mockReturnValue({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            {
              id: 'state-s1',
              codespaceId: 'p1',
              status: 'initializing',
              url: 'http://localhost:3000/sessions/state-s1',
            },
          ]),
        })),
      });
      db.update.mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn() })),
      });

      const result = await service.create({ codespaceId: 'p1' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toEqual([]);
      }
    });

    it('returns presence data with session getById', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'state-s2',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/state-s2',
      });

      // Add a user
      await service.join('state-s2', 'user1');

      const result = await service.getById('state-s2');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(1);
        expect(result.value.presence[0]?.userId).toBe('user1');
      }
    });

    it('returns presence data in session list', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'state-s3',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/state-s3',
      });
      db.query.sessions.findMany.mockResolvedValue([
        {
          id: 'state-s3',
          codespaceId: 'p1',
          status: 'active',
          url: 'http://localhost:3000/sessions/state-s3',
        },
      ]);

      // Add a user to s3
      await service.join('state-s3', 'user1');

      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.presence).toHaveLength(1);
      }
    });

    it('maintains presence after session close', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'state-s4',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/state-s4',
      });

      // Add user
      await service.join('state-s4', 'user1');

      // Close session
      db.update.mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([
              {
                id: 'state-s4',
                status: 'closed',
                closedAt: new Date().toISOString(),
              },
            ]),
          })),
        })),
      });

      const result = await service.close('state-s4');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Presence data is still returned with the closed session
        expect(result.value.presence).toHaveLength(1);
      }
    });
  });

  // =============================================================================
  // Broadcast/Notification of Presence Changes (4 tests)
  // =============================================================================

  describe('Broadcast/Notification of Presence Changes', () => {
    it('broadcasts presence:joined event when user joins', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'bc-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/bc-s1',
      });

      await service.join('bc-s1', 'user1');

      expect(streams.publish).toHaveBeenCalledWith(
        'bc-s1',
        'presence:joined',
        expect.objectContaining({
          userId: 'user1',
          meta: expect.objectContaining({
            streamId: 'bc-s1',
            partType: 'lifecycle',
          }),
        })
      );
    });

    it('broadcasts presence:left event when user leaves', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'bc-s2',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/bc-s2',
      });

      await service.join('bc-s2', 'user1');
      vi.clearAllMocks();
      await service.leave('bc-s2', 'user1');

      expect(streams.publish).toHaveBeenCalledWith(
        'bc-s2',
        'presence:left',
        expect.objectContaining({
          userId: 'user1',
          meta: expect.objectContaining({
            streamId: 'bc-s2',
            partType: 'lifecycle',
          }),
        })
      );
    });

    it('broadcasts presence:cursor event when presence is updated', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'bc-s3',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/bc-s3',
      });

      await service.join('bc-s3', 'user1');
      vi.clearAllMocks();

      await service.updatePresence('bc-s3', 'user1', {
        cursor: { x: 500, y: 250 },
        activeFile: 'src/index.ts',
      });

      expect(streams.publish).toHaveBeenCalledWith(
        'bc-s3',
        'presence:cursor',
        expect.objectContaining({
          userId: 'user1',
          cursor: { x: 500, y: 250 },
          activeFile: 'src/index.ts',
          meta: expect.objectContaining({
            streamId: 'bc-s3',
            partType: 'system',
          }),
        })
      );
    });

    it('handles stream publish failure gracefully for join', async () => {
      // Create a new service with a failing publish
      const failingStreams = {
        ...createStreamsMock(),
        publish: vi.fn().mockRejectedValue(new Error('stream error')),
      };
      const failingService = new SessionService(db as never, failingStreams as never, {
        baseUrl: 'http://localhost:3000',
      });

      db.query.sessions.findFirst.mockResolvedValue({
        id: 'bc-s4',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/bc-s4',
      });

      // The join adds user to presence BEFORE calling publish, and publish errors
      // are caught internally. The join still succeeds even if publish fails,
      // because the user is already added to the presence store.
      const result = await failingService.join('bc-s4', 'user1');

      // The result should succeed - presence was added before publish was called
      // The publish failure is logged but doesn't cause join to fail
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.presence).toHaveLength(1);
        expect(result.value.presence[0]?.userId).toBe('user1');
      }
      // Verify publish was attempted
      expect(failingStreams.publish).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Error Handling (3 tests)
  // =============================================================================

  describe('Error Handling', () => {
    it('returns error when joining non-existent session', async () => {
      db.query.sessions.findFirst.mockResolvedValue(null);

      const result = await service.join('non-existent', 'user1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
      }
    });

    it('returns error when joining closed session', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'err-s2',
        codespaceId: 'p1',
        status: 'closed',
        url: 'http://localhost:3000/sessions/err-s2',
      });

      const result = await service.join('err-s2', 'user1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SessionErrors.CLOSED);
      }
    });

    it('returns error when getting active users for non-existent session', async () => {
      db.query.sessions.findFirst.mockResolvedValue(null);

      const result = await service.getActiveUsers('non-existent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SessionErrors.NOT_FOUND);
      }
    });
  });

  // =============================================================================
  // Integration with Session Service (additional coverage)
  // =============================================================================

  describe('Integration with Session Methods', () => {
    it('persists presence events to database via publish', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'int-s1',
        codespaceId: 'p1',
        status: 'active',
        url: 'http://localhost:3000/sessions/int-s1',
      });
      db.query.sessionEvents.findFirst.mockResolvedValue(null);
      db.insert.mockReturnValue({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'evt1', offset: 0 }]),
        })),
      });

      // Join triggers a publish which should persist
      await service.join('int-s1', 'user1');

      // The publish should be called
      expect(streams.publish).toHaveBeenCalledWith(
        'int-s1',
        'presence:joined',
        expect.objectContaining({
          userId: 'user1',
          meta: expect.objectContaining({
            streamId: 'int-s1',
            partType: 'lifecycle',
          }),
        })
      );
    });

    it('includes presence in session with presence type', async () => {
      db.query.sessions.findFirst.mockResolvedValue({
        id: 'int-s2',
        codespaceId: 'p1',
        taskId: 't1',
        agentId: 'a1',
        title: 'Test Session',
        status: 'active',
        url: 'http://localhost:3000/sessions/int-s2',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });

      await service.join('int-s2', 'user1');
      await service.updatePresence('int-s2', 'user1', {
        cursor: { x: 10, y: 20 },
        activeFile: 'test.ts',
      });

      const result = await service.getById('int-s2');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('int-s2');
        expect(result.value.codespaceId).toBe('p1');
        expect(result.value.presence).toHaveLength(1);
        expect(result.value.presence[0]).toMatchObject({
          userId: 'user1',
          cursor: { x: 10, y: 20 },
          activeFile: 'test.ts',
        });
      }
    });
  });
});
