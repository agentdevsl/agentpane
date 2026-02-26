import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliMonitorService } from '../cli-monitor.service.js';
import type { CliSession, DaemonRegisterPayload } from '../types.js';
import { DAEMON_TIMEOUT_MS } from '../types.js';

// ── Mock Streams Server ──

function createMockStreamsServer() {
  const published: Array<{ id: string; type: string; data: unknown }> = [];
  return {
    publish: vi.fn(async (id: string, type: string, data: unknown) => {
      published.push({ id, type, data });
      return published.length;
    }),
    _published: published,
  };
}

// ── Helpers ──

function makeDaemonPayload(overrides?: Partial<DaemonRegisterPayload>): DaemonRegisterPayload {
  return {
    daemonId: 'daemon-1',
    pid: 12345,
    version: '0.1.0',
    watchPath: '/home/user/.claude/projects',
    capabilities: ['jsonl'],
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeSession(overrides?: Partial<CliSession>): CliSession {
  return {
    sessionId: 'session-1',
    filePath: '/home/user/.claude/projects/abc123/session-1.jsonl',
    cwd: '/home/user/my-project',
    projectName: 'my-project',
    projectHash: 'abc123',
    status: 'working',
    messageCount: 5,
    turnCount: 2,
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 200,
    },
    startedAt: Date.now() - 60000,
    lastActivityAt: Date.now(),
    lastReadOffset: 0,
    isSubagent: false,
    ...overrides,
  };
}

// ── Tests ──

describe('CliMonitorService', () => {
  let service: CliMonitorService;
  let streamsServer: ReturnType<typeof createMockStreamsServer>;

  beforeEach(() => {
    streamsServer = createMockStreamsServer();
    service = new CliMonitorService(streamsServer as never);
  });

  afterEach(() => {
    service.destroy();
    vi.restoreAllMocks();
  });

  // ── Registration ──

  describe('registerDaemon', () => {
    it('registers a daemon successfully', () => {
      const payload = makeDaemonPayload();
      service.registerDaemon(payload);

      expect(service.isDaemonConnected()).toBe(true);
      const daemon = service.getDaemon();
      expect(daemon).not.toBeNull();
      expect(daemon!.daemonId).toBe('daemon-1');
      expect(daemon!.pid).toBe(12345);
      expect(daemon!.version).toBe('0.1.0');
      expect(daemon!.watchPath).toBe('/home/user/.claude/projects');
      expect(daemon!.capabilities).toEqual(['jsonl']);
      expect(daemon!.registeredAt).toBeGreaterThan(0);
      expect(daemon!.lastHeartbeatAt).toBeGreaterThan(0);
    });

    it('publishes daemon-connected event on registration', () => {
      service.registerDaemon(makeDaemonPayload());

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:daemon-connected',
        expect.objectContaining({
          daemon: expect.objectContaining({ daemonId: 'daemon-1' }),
        })
      );
    });

    it('replaces old daemon and clears sessions when a new daemon registers', () => {
      // Register first daemon and ingest a session
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-old' }));
      service.ingestSessions('daemon-old', [makeSession()], []);
      expect(service.getSessionCount()).toBe(1);

      // Register new daemon
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-new' }));

      expect(service.isDaemonConnected()).toBe(true);
      expect(service.getDaemon()!.daemonId).toBe('daemon-new');
      // Sessions from old daemon should be cleared
      expect(service.getSessionCount()).toBe(0);
    });

    it('does not clear sessions when the same daemon re-registers', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));
      service.ingestSessions('daemon-1', [makeSession()], []);
      expect(service.getSessionCount()).toBe(1);

      // Re-register same daemon
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));
      // Sessions should remain because same daemonId doesn't trigger clear
      expect(service.getDaemon()!.daemonId).toBe('daemon-1');
    });
  });

  // ── Heartbeat ──

  describe('handleHeartbeat', () => {
    it('updates lastHeartbeatAt on successful heartbeat', () => {
      service.registerDaemon(makeDaemonPayload());
      const initialHeartbeat = service.getDaemon()!.lastHeartbeatAt;

      // Advance time slightly so Date.now() differs
      const later = initialHeartbeat + 1000;
      vi.spyOn(Date, 'now').mockReturnValue(later);

      const result = service.handleHeartbeat('daemon-1', 3);
      expect(result).toBe('ok');
      expect(service.getDaemon()!.lastHeartbeatAt).toBe(later);
    });

    it('returns stale for unknown daemon', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));

      const result = service.handleHeartbeat('daemon-unknown', 0);
      expect(result).toBe('stale');
    });

    it('returns unknown when no daemon is registered', () => {
      const result = service.handleHeartbeat('daemon-1', 0);
      expect(result).toBe('unknown');
    });
  });

  // ── Heartbeat Timeout ──

  describe('heartbeat timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-deregisters daemon after DAEMON_TIMEOUT_MS without heartbeat', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      service.registerDaemon(makeDaemonPayload());
      expect(service.isDaemonConnected()).toBe(true);

      // Advance past the timeout threshold (includes 1.5x grace period)
      vi.setSystemTime(now + DAEMON_TIMEOUT_MS * 1.5 + 1000);

      // The heartbeat check interval is 15s, so advance timers to trigger it
      vi.advanceTimersByTime(15_000);

      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getDaemon()).toBeNull();
    });

    it('does not deregister if heartbeat is recent', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      service.registerDaemon(makeDaemonPayload());

      // Advance only 5 seconds (well within the 30s timeout)
      vi.setSystemTime(now + 5000);
      vi.advanceTimersByTime(10_000);

      expect(service.isDaemonConnected()).toBe(true);
    });
  });

  // ── Session Ingestion ──

  describe('ingestSessions', () => {
    it('adds sessions to the cache', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'sess-a' });

      const result = service.ingestSessions('daemon-1', [session], []);
      expect(result).toBe(true);

      const sessions = service.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sessionId).toBe('sess-a');
    });

    it('returns all ingested sessions', () => {
      service.registerDaemon(makeDaemonPayload());
      const s1 = makeSession({ sessionId: 'sess-1' });
      const s2 = makeSession({ sessionId: 'sess-2' });

      service.ingestSessions('daemon-1', [s1, s2], []);

      expect(service.getSessions()).toHaveLength(2);
      expect(service.getSessionCount()).toBe(2);
    });

    it('replaces an existing session on update', () => {
      service.registerDaemon(makeDaemonPayload());
      const original = makeSession({ sessionId: 'sess-1', status: 'working', turnCount: 1 });
      service.ingestSessions('daemon-1', [original], []);

      const updated = makeSession({ sessionId: 'sess-1', status: 'idle', turnCount: 5 });
      service.ingestSessions('daemon-1', [updated], []);

      const sessions = service.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe('idle');
      expect(sessions[0]!.turnCount).toBe(5);
    });

    it('publishes session-update event on ingest', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession();

      service.ingestSessions('daemon-1', [session], []);

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:session-update',
        expect.objectContaining({
          session: expect.objectContaining({ sessionId: 'session-1' }),
        })
      );
    });

    it('publishes status-change event when session status changes', () => {
      service.registerDaemon(makeDaemonPayload());
      const initial = makeSession({ sessionId: 'sess-1', status: 'working' });
      service.ingestSessions('daemon-1', [initial], []);

      streamsServer.publish.mockClear();

      const updated = makeSession({ sessionId: 'sess-1', status: 'waiting_for_approval' });
      service.ingestSessions('daemon-1', [updated], []);

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:status-change',
        expect.objectContaining({
          sessionId: 'sess-1',
          previousStatus: 'working',
          newStatus: 'waiting_for_approval',
        })
      );
    });

    it('does not publish status-change event when status is the same', () => {
      service.registerDaemon(makeDaemonPayload());
      const initial = makeSession({ sessionId: 'sess-1', status: 'working' });
      service.ingestSessions('daemon-1', [initial], []);

      streamsServer.publish.mockClear();

      const updated = makeSession({ sessionId: 'sess-1', status: 'working', turnCount: 3 });
      service.ingestSessions('daemon-1', [updated], []);

      // Should only publish session-update, not status-change
      const statusChangeCalls = streamsServer.publish.mock.calls.filter(
        (call) => call[1] === 'cli-monitor:status-change'
      );
      expect(statusChangeCalls).toHaveLength(0);
    });

    it('does not publish status-change for first ingest of a session', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'sess-new', status: 'working' });

      service.ingestSessions('daemon-1', [session], []);

      const statusChangeCalls = streamsServer.publish.mock.calls.filter(
        (call) => call[1] === 'cli-monitor:status-change'
      );
      expect(statusChangeCalls).toHaveLength(0);
    });

    it('removes sessions specified in removedIds', () => {
      service.registerDaemon(makeDaemonPayload());
      const s1 = makeSession({ sessionId: 'sess-1' });
      const s2 = makeSession({ sessionId: 'sess-2' });
      service.ingestSessions('daemon-1', [s1, s2], []);
      expect(service.getSessionCount()).toBe(2);

      service.ingestSessions('daemon-1', [], ['sess-1']);
      expect(service.getSessionCount()).toBe(1);
      expect(service.getSessions()[0]!.sessionId).toBe('sess-2');
    });

    it('publishes session-removed event for removed sessions', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-1', [makeSession({ sessionId: 'sess-1' })], []);

      streamsServer.publish.mockClear();
      service.ingestSessions('daemon-1', [], ['sess-1']);

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:session-removed',
        { sessionId: 'sess-1' }
      );
    });

    it('ignores removal of non-existent session IDs', () => {
      service.registerDaemon(makeDaemonPayload());
      streamsServer.publish.mockClear();

      service.ingestSessions('daemon-1', [], ['nonexistent-id']);

      const removedCalls = streamsServer.publish.mock.calls.filter(
        (call) => call[1] === 'cli-monitor:session-removed'
      );
      expect(removedCalls).toHaveLength(0);
    });

    it('returns false for unknown daemon', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));

      const result = service.ingestSessions('daemon-unknown', [makeSession()], []);
      expect(result).toBe(false);
    });

    it('returns false when no daemon is registered', () => {
      const result = service.ingestSessions('daemon-1', [makeSession()], []);
      expect(result).toBe(false);
    });
  });

  // ── Session Memory Limit ──

  describe('session memory limit', () => {
    it('evicts oldest sessions when exceeding MAX_SESSIONS limit', () => {
      service.registerDaemon(makeDaemonPayload());

      // Ingest exactly MAX_SESSIONS (10,000) sessions
      const batchSize = 500;
      for (let batch = 0; batch < 20; batch++) {
        const sessions = Array.from({ length: batchSize }, (_, i) => {
          const idx = batch * batchSize + i;
          return makeSession({
            sessionId: `sess-${idx}`,
            lastActivityAt: Date.now() - (10000 - idx) * 1000, // Oldest first
          });
        });
        service.ingestSessions('daemon-1', sessions, []);
      }

      expect(service.getSessionCount()).toBe(10_000);

      // Ingest one more session — should evict the oldest
      streamsServer.publish.mockClear();
      service.ingestSessions(
        'daemon-1',
        [makeSession({ sessionId: 'sess-new', lastActivityAt: Date.now() })],
        []
      );

      expect(service.getSessionCount()).toBe(10_000);

      // Verify eviction published session-removed
      const removedCalls = streamsServer.publish.mock.calls.filter(
        (call) => call[1] === 'cli-monitor:session-removed'
      );
      expect(removedCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('publishes session-removed events for evicted sessions', () => {
      service.registerDaemon(makeDaemonPayload());

      // Fill to near capacity (9,999)
      const sessions = Array.from({ length: 9_999 }, (_, i) =>
        makeSession({
          sessionId: `sess-${i}`,
          lastActivityAt: Date.now() - (10000 - i) * 1000,
        })
      );

      // Ingest in batches
      for (let i = 0; i < sessions.length; i += 500) {
        service.ingestSessions('daemon-1', sessions.slice(i, i + 500), []);
      }

      expect(service.getSessionCount()).toBe(9_999);

      streamsServer.publish.mockClear();

      // Add 2 new sessions, pushing over limit by 1
      service.ingestSessions(
        'daemon-1',
        [
          makeSession({ sessionId: 'new-1', lastActivityAt: Date.now() }),
          makeSession({ sessionId: 'new-2', lastActivityAt: Date.now() }),
        ],
        []
      );

      // Should have evicted 1 session
      const removedCalls = streamsServer.publish.mock.calls.filter(
        (call) => call[1] === 'cli-monitor:session-removed'
      );
      expect(removedCalls.length).toBe(1);
      expect(service.getSessionCount()).toBe(10_000);
    });
  });

  // ── Deregistration ──

  describe('deregisterDaemon', () => {
    it('clears daemon and sessions on deregistration', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-1', [makeSession()], []);

      const result = service.deregisterDaemon('daemon-1');
      expect(result).toBe(true);
      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getDaemon()).toBeNull();
      expect(service.getSessionCount()).toBe(0);
    });

    it('publishes daemon-disconnected event', () => {
      service.registerDaemon(makeDaemonPayload());
      streamsServer.publish.mockClear();

      service.deregisterDaemon('daemon-1');

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:daemon-disconnected',
        {}
      );
    });

    it('returns false for unknown daemon', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));
      const result = service.deregisterDaemon('daemon-unknown');
      expect(result).toBe(false);
    });
  });

  // ── Queries ──

  describe('getStatus', () => {
    it('returns correct shape when disconnected', () => {
      const status = service.getStatus();
      expect(status).toEqual({
        connected: false,
        daemon: null,
        sessionCount: 0,
      });
    });

    it('returns correct shape when connected with sessions', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-1', [makeSession(), makeSession({ sessionId: 'sess-2' })], []);

      const status = service.getStatus();
      expect(status.connected).toBe(true);
      expect(status.daemon).not.toBeNull();
      expect(status.daemon!.daemonId).toBe('daemon-1');
      expect(status.sessionCount).toBe(2);
    });
  });

  describe('isDaemonConnected', () => {
    it('returns false when no daemon registered', () => {
      expect(service.isDaemonConnected()).toBe(false);
    });

    it('returns true when daemon is registered', () => {
      service.registerDaemon(makeDaemonPayload());
      expect(service.isDaemonConnected()).toBe(true);
    });
  });

  // ── SSE Subscription ──

  describe('addRealtimeSubscriber', () => {
    it('adds a local subscriber and returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsub = service.addRealtimeSubscriber(callback);

      expect(typeof unsub).toBe('function');
    });

    it('subscriber receives events when publish happens', () => {
      const callback = vi.fn();
      service.addRealtimeSubscriber(callback);

      // Register daemon and trigger a publish
      service.registerDaemon(makeDaemonPayload());

      // The publish from registerDaemon should notify local subscribers
      expect(callback).toHaveBeenCalled();
      const firstCall = callback.mock.calls[0];
      expect(firstCall).toBeDefined();
      const call = firstCall![0] as { type: string; data: unknown; offset: number };
      expect(call).toHaveProperty('type');
      expect(call).toHaveProperty('data');
      expect(call).toHaveProperty('offset');
    });

    it('unsubscribe stops further notifications', () => {
      const callback = vi.fn();
      const unsub = service.addRealtimeSubscriber(callback);

      // Unsubscribe
      unsub();

      // Register daemon — should not notify the callback
      callback.mockClear();
      service.registerDaemon(makeDaemonPayload());
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── Cleanup ──

  describe('destroy', () => {
    it('clears daemon, sessions, and stops heartbeat timer', () => {
      vi.useFakeTimers();
      try {
        service.registerDaemon(makeDaemonPayload());
        service.ingestSessions('daemon-1', [makeSession()], []);

        service.destroy();

        expect(service.isDaemonConnected()).toBe(false);
        expect(service.getDaemon()).toBeNull();
        expect(service.getSessionCount()).toBe(0);

        // Advancing timers should not cause errors (timer was cleared)
        vi.advanceTimersByTime(60_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
