import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPresenceService } from '../../src/services/session/session-presence.service';
import type { SessionStreamService } from '../../src/services/session/session-stream.service';
import { createTestProject } from '../factories/project.factory';
import { createClosedSession, createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/** Create a mock SessionStreamService that records publish calls */
function createMockStreamService(): SessionStreamService {
  return {
    publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
  } as unknown as SessionStreamService;
}

describe('SessionPresenceService (IT-220)', () => {
  let service: SessionPresenceService;
  let mockStreamService: SessionStreamService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    mockStreamService = createMockStreamService();
    service = new SessionPresenceService(db as any, () => mockStreamService);
  });

  afterEach(async () => {
    service.stopCleanupTimer();
    vi.restoreAllMocks();
    await clearTestDatabase();
  });

  describe('join (IT-221)', () => {
    it('adds a user to a session and returns presence', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      const result = await service.join(session.id, 'user-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe(session.id);
      expect(result.value.presence).toHaveLength(1);
      expect(result.value.presence[0]?.userId).toBe('user-1');
      expect(result.value.presence[0]?.lastSeen).toBeGreaterThan(0);
    });

    it('allows multiple users to join the same session', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      const result = await service.join(session.id, 'user-2');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.presence).toHaveLength(2);
      const userIds = result.value.presence.map((u) => u.userId);
      expect(userIds).toContain('user-1');
      expect(userIds).toContain('user-2');
    });

    it('publishes a presence:joined event', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');

      expect(mockStreamService.publish).toHaveBeenCalledTimes(1);
      const [streamId, event] = (mockStreamService.publish as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(streamId).toBe(session.id);
      expect(event.type).toBe('presence:joined');
    });

    it('returns NOT_FOUND for nonexistent session', async () => {
      const result = await service.join('nonexistent-session', 'user-1');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns CLOSED error for closed session', async () => {
      const codespace = await createTestProject();
      const session = await createClosedSession(codespace.id, {
        closedAt: new Date().toISOString(),
      });

      const result = await service.join(session.id, 'user-1');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_CLOSED');
    });

    it('updates lastSeen when same user joins again', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      const firstJoin = service.getPresenceStore().get(session.id)?.get('user-1');
      expect(firstJoin).toBeDefined();

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      await service.join(session.id, 'user-1');
      const secondJoin = service.getPresenceStore().get(session.id)?.get('user-1');
      expect(secondJoin).toBeDefined();
      expect(secondJoin!.lastSeen).toBeGreaterThanOrEqual(firstJoin!.lastSeen);
    });
  });

  describe('leave (IT-222)', () => {
    it('removes a user from the session presence', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      await service.join(session.id, 'user-2');

      const result = await service.leave(session.id, 'user-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.presence).toHaveLength(1);
      expect(result.value.presence[0]?.userId).toBe('user-2');
    });

    it('publishes a presence:left event', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      vi.mocked(mockStreamService.publish).mockClear();

      await service.leave(session.id, 'user-1');

      expect(mockStreamService.publish).toHaveBeenCalledTimes(1);
      const [, event] = (mockStreamService.publish as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(event.type).toBe('presence:left');
    });

    it('returns NOT_FOUND for nonexistent session', async () => {
      const result = await service.leave('nonexistent-session', 'user-1');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('handles leaving when user was never in the session', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      // User never joined, but leave should still succeed (no-op on presence map)
      const result = await service.leave(session.id, 'never-joined');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.presence).toHaveLength(0);
    });
  });

  describe('updatePresence (IT-223)', () => {
    it('updates cursor position for an active user', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');

      const result = await service.updatePresence(session.id, 'user-1', {
        cursor: { x: 100, y: 200 },
      });
      expect(result.ok).toBe(true);

      const store = service.getPresenceStore().get(session.id);
      const user = store?.get('user-1');
      expect(user?.cursor).toEqual({ x: 100, y: 200 });
    });

    it('updates activeFile for an active user', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');

      const result = await service.updatePresence(session.id, 'user-1', {
        activeFile: '/src/main.ts',
      });
      expect(result.ok).toBe(true);

      const store = service.getPresenceStore().get(session.id);
      const user = store?.get('user-1');
      expect(user?.activeFile).toBe('/src/main.ts');
    });

    it('updates lastSeen timestamp on presence update', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      const beforeUpdate = service.getPresenceStore().get(session.id)?.get('user-1')?.lastSeen;

      await new Promise((resolve) => setTimeout(resolve, 5));

      await service.updatePresence(session.id, 'user-1', {
        cursor: { x: 50, y: 50 },
      });
      const afterUpdate = service.getPresenceStore().get(session.id)?.get('user-1')?.lastSeen;

      expect(afterUpdate).toBeGreaterThanOrEqual(beforeUpdate!);
    });

    it('publishes a presence:cursor event', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      vi.mocked(mockStreamService.publish).mockClear();

      await service.updatePresence(session.id, 'user-1', {
        cursor: { x: 10, y: 20 },
      });

      expect(mockStreamService.publish).toHaveBeenCalledTimes(1);
      const [, event] = (mockStreamService.publish as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(event.type).toBe('presence:cursor');
    });

    it('returns NOT_FOUND for nonexistent session', async () => {
      const result = await service.updatePresence('nonexistent', 'user-1', {
        cursor: { x: 0, y: 0 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns NOT_FOUND when user has not joined', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      const result = await service.updatePresence(session.id, 'not-joined-user', {
        cursor: { x: 0, y: 0 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('getActiveUsers (IT-224)', () => {
    it('returns all active users for a session', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      await service.join(session.id, 'user-2');

      const result = await service.getActiveUsers(session.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      const userIds = result.value.map((u) => u.userId);
      expect(userIds).toContain('user-1');
      expect(userIds).toContain('user-2');
    });

    it('returns empty array when no users are present', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      const result = await service.getActiveUsers(session.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('returns NOT_FOUND for nonexistent session', async () => {
      const result = await service.getActiveUsers('nonexistent-session');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('reflects users who have left', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      await service.join(session.id, 'user-2');
      await service.leave(session.id, 'user-1');

      const result = await service.getActiveUsers(session.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.userId).toBe('user-2');
    });
  });

  describe('sweepStaleUsers (IT-225)', () => {
    it('removes users with lastSeen older than 30 minutes', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      // Join a user, then manually set their lastSeen to 31 minutes ago
      await service.join(session.id, 'stale-user');
      const store = service.getMutablePresenceStore().get(session.id);
      expect(store).toBeDefined();
      store!.set('stale-user', {
        userId: 'stale-user',
        lastSeen: Date.now() - 31 * 60 * 1000, // 31 minutes ago
      });

      // Also add a fresh user
      await service.join(session.id, 'fresh-user');

      vi.mocked(mockStreamService.publish).mockClear();
      await service.sweepStaleUsers();

      const result = await service.getActiveUsers(session.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.userId).toBe('fresh-user');
    });

    it('publishes presence:timeout events for swept users', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'stale-user');
      const store = service.getMutablePresenceStore().get(session.id);
      store!.set('stale-user', {
        userId: 'stale-user',
        lastSeen: Date.now() - 31 * 60 * 1000,
      });

      vi.mocked(mockStreamService.publish).mockClear();
      await service.sweepStaleUsers();

      expect(mockStreamService.publish).toHaveBeenCalledTimes(1);
      const [, event] = (mockStreamService.publish as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(event.type).toBe('presence:timeout');
    });

    it('removes empty session entries from the store', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'stale-user');
      const store = service.getMutablePresenceStore().get(session.id);
      store!.set('stale-user', {
        userId: 'stale-user',
        lastSeen: Date.now() - 31 * 60 * 1000,
      });

      await service.sweepStaleUsers();

      // Session entry should be removed since it has no users left
      expect(service.getPresenceStore().has(session.id)).toBe(false);
    });

    it('does nothing when no stale users exist', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });
      await service.join(session.id, 'fresh-user');

      vi.mocked(mockStreamService.publish).mockClear();
      await service.sweepStaleUsers();

      // No timeout events published (publish was called for the join, but we cleared it)
      expect(mockStreamService.publish).not.toHaveBeenCalled();

      // User still present
      const result = await service.getActiveUsers(session.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
    });
  });

  describe('clearSession (IT-226)', () => {
    it('removes all presence records for a session', async () => {
      const codespace = await createTestProject();
      const session = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session.id, 'user-1');
      await service.join(session.id, 'user-2');

      service.clearSession(session.id);

      expect(service.getPresenceStore().has(session.id)).toBe(false);
    });

    it('is a no-op for nonexistent sessions', async () => {
      // Should not throw
      service.clearSession('nonexistent-session');
      expect(service.getPresenceStore().has('nonexistent-session')).toBe(false);
    });

    it('does not affect other sessions', async () => {
      const codespace = await createTestProject();
      const session1 = await createTestSession(codespace.id, { status: 'active' });
      const session2 = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session1.id, 'user-1');
      await service.join(session2.id, 'user-2');

      service.clearSession(session1.id);

      expect(service.getPresenceStore().has(session1.id)).toBe(false);
      expect(service.getPresenceStore().has(session2.id)).toBe(true);

      const result = await service.getActiveUsers(session2.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.userId).toBe('user-2');
    });
  });

  describe('cleanup timer (IT-227)', () => {
    it('starts and stops the cleanup timer', () => {
      service.startCleanupTimer();
      // Starting again should be a no-op (not throw)
      service.startCleanupTimer();
      // Stop should not throw
      service.stopCleanupTimer();
      // Stopping again should be a no-op
      service.stopCleanupTimer();
    });
  });

  describe('cross-session isolation (IT-228)', () => {
    it('maintains separate presence state per session', async () => {
      const codespace = await createTestProject();
      const session1 = await createTestSession(codespace.id, { status: 'active' });
      const session2 = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session1.id, 'user-1');
      await service.join(session1.id, 'user-2');
      await service.join(session2.id, 'user-3');

      const result1 = await service.getActiveUsers(session1.id);
      const result2 = await service.getActiveUsers(session2.id);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value).toHaveLength(2);
      expect(result2.value).toHaveLength(1);
      expect(result2.value[0]?.userId).toBe('user-3');
    });

    it('same user can be in multiple sessions simultaneously', async () => {
      const codespace = await createTestProject();
      const session1 = await createTestSession(codespace.id, { status: 'active' });
      const session2 = await createTestSession(codespace.id, { status: 'active' });

      await service.join(session1.id, 'shared-user');
      await service.join(session2.id, 'shared-user');

      const result1 = await service.getActiveUsers(session1.id);
      const result2 = await service.getActiveUsers(session2.id);

      expect(result1.ok && result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value).toHaveLength(1);
      expect(result1.value[0]?.userId).toBe('shared-user');
      expect(result2.value).toHaveLength(1);
      expect(result2.value[0]?.userId).toBe('shared-user');
    });
  });
});
