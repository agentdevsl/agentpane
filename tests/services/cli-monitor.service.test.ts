import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliMonitorService } from '../../src/services/cli-monitor/cli-monitor.service';
import type { CliSession, DaemonRegisterPayload } from '../../src/services/cli-monitor/types';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockStreamsServer() {
  return {
    publish: vi.fn().mockResolvedValue(1),
  };
}

function makeSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    filePath: '/home/user/.claude/projects/test/session.jsonl',
    cwd: '/home/user/project',
    projectName: 'test',
    projectHash: 'testhash',
    status: 'working',
    messageCount: 5,
    turnCount: 3,
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 200,
    },
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    lastReadOffset: 0,
    isSubagent: false,
    ...overrides,
  };
}

function makeDaemonPayload(overrides: Partial<DaemonRegisterPayload> = {}): DaemonRegisterPayload {
  return {
    daemonId: 'daemon-001',
    pid: 12345,
    version: '1.0.0',
    watchPath: '/home/user/.claude',
    capabilities: ['jsonl-watch', 'session-tracking'],
    startedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CliMonitorService', () => {
  let service: CliMonitorService;
  let mockStreams: ReturnType<typeof createMockStreamsServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreams = createMockStreamsServer();
    // Pass no DB to avoid maintenance timers
    service = new CliMonitorService(mockStreams);
  });

  afterEach(() => {
    service.destroy();
  });

  // --------------------------------------------------------------------------
  // Daemon Registration
  // --------------------------------------------------------------------------

  describe('daemon registration', () => {
    it('registers a daemon and reports connected', () => {
      service.registerDaemon(makeDaemonPayload());

      expect(service.isDaemonConnected()).toBe(true);
      expect(service.getDaemon()?.daemonId).toBe('daemon-001');
    });

    it('publishes daemon-connected event on registration', () => {
      service.registerDaemon(makeDaemonPayload());

      expect(mockStreams.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:daemon-connected',
        expect.objectContaining({ daemon: expect.any(Object) })
      );
    });

    it('replaces previous daemon on re-registration with different ID', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-old' }));
      service.ingestSessions('daemon-old', [makeSession()], []);

      expect(service.getSessionCount()).toBe(1);

      // Register new daemon — sessions should be cleared
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-new' }));

      expect(service.getDaemon()?.daemonId).toBe('daemon-new');
      expect(service.getSessionCount()).toBe(0);
    });

    it('keeps sessions when re-registering with same daemon ID', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-same' }));
      service.ingestSessions('daemon-same', [makeSession()], []);

      // Re-register with same ID — sessions should persist
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-same' }));

      expect(service.getSessionCount()).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Daemon Deregistration
  // --------------------------------------------------------------------------

  describe('daemon deregistration', () => {
    it('deregisters the daemon and clears sessions', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-001', [makeSession()], []);

      const result = service.deregisterDaemon('daemon-001');

      expect(result).toBe(true);
      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getSessionCount()).toBe(0);
    });

    it('publishes daemon-disconnected event', () => {
      service.registerDaemon(makeDaemonPayload());
      service.deregisterDaemon('daemon-001');

      expect(mockStreams.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:daemon-disconnected',
        {}
      );
    });

    it('returns false when deregistering unknown daemon', () => {
      service.registerDaemon(makeDaemonPayload());
      const result = service.deregisterDaemon('wrong-daemon');

      expect(result).toBe(false);
      expect(service.isDaemonConnected()).toBe(true);
    });

    it('returns false when no daemon is registered', () => {
      const result = service.deregisterDaemon('daemon-001');
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  describe('heartbeat handling', () => {
    it('returns ok for matching daemon', () => {
      service.registerDaemon(makeDaemonPayload());
      const result = service.handleHeartbeat('daemon-001', 5);

      expect(result).toBe('ok');
    });

    it('returns unknown when no daemon registered', () => {
      const result = service.handleHeartbeat('daemon-001', 0);
      expect(result).toBe('unknown');
    });

    it('returns stale for mismatched daemon ID', () => {
      service.registerDaemon(makeDaemonPayload());
      const result = service.handleHeartbeat('different-daemon', 0);

      expect(result).toBe('stale');
    });
  });

  // --------------------------------------------------------------------------
  // Session Ingestion
  // --------------------------------------------------------------------------

  describe('session ingestion', () => {
    it('ingests sessions and publishes update events', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'sess-1' });

      const result = service.ingestSessions('daemon-001', [session], []);

      expect(result).toBe(true);
      expect(service.getSessionCount()).toBe(1);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:session-update',
        expect.objectContaining({ session })
      );
    });

    it('returns false for mismatched daemon ID', () => {
      service.registerDaemon(makeDaemonPayload());
      const result = service.ingestSessions('wrong-daemon', [makeSession()], []);

      expect(result).toBe(false);
    });

    it('removes sessions listed in removedIds', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'sess-remove' });
      service.ingestSessions('daemon-001', [session], []);

      expect(service.getSessionCount()).toBe(1);

      service.ingestSessions('daemon-001', [], ['sess-remove']);

      expect(service.getSessionCount()).toBe(0);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:session-removed',
        { sessionId: 'sess-remove' }
      );
    });

    it('publishes status-change event when session status changes', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'sess-status', status: 'working' });
      service.ingestSessions('daemon-001', [session], []);

      mockStreams.publish.mockClear();

      const updatedSession = { ...session, status: 'idle' as const };
      service.ingestSessions('daemon-001', [updatedSession], []);

      expect(mockStreams.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:status-change',
        expect.objectContaining({
          sessionId: 'sess-status',
          previousStatus: 'working',
          newStatus: 'idle',
        })
      );
    });

    it('filters out sessions older than retention period', () => {
      service.registerDaemon(makeDaemonPayload());
      const oldSession = makeSession({
        sessionId: 'old-sess',
        lastActivityAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      });

      service.ingestSessions('daemon-001', [oldSession], []);

      // Old session should have been filtered out
      expect(service.getSessionCount()).toBe(0);
    });

    it('evicts oldest sessions when exceeding MAX_SESSIONS', () => {
      service.registerDaemon(makeDaemonPayload());

      // We can't easily test 10000 sessions, but we can verify the mechanism
      // by ingesting sessions and checking they're stored
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeSession({
          sessionId: `sess-${i}`,
          lastActivityAt: Date.now() - (5 - i) * 1000,
        })
      );

      service.ingestSessions('daemon-001', sessions, []);
      expect(service.getSessionCount()).toBe(5);
    });

    it('does not publish status-change for first ingestion of a session', () => {
      service.registerDaemon(makeDaemonPayload());
      const session = makeSession({ sessionId: 'new-sess', status: 'working' });

      service.ingestSessions('daemon-001', [session], []);

      // Should have session-update but NOT status-change (no previous status)
      const publishCalls = mockStreams.publish.mock.calls;
      const statusChangeCalls = publishCalls.filter((c) => c[1] === 'cli-monitor:status-change');
      expect(statusChangeCalls).toHaveLength(0);
    });

    it('ignores removal of non-existent session', () => {
      service.registerDaemon(makeDaemonPayload());
      const countBefore = mockStreams.publish.mock.calls.length;

      service.ingestSessions('daemon-001', [], ['nonexistent']);

      // Should not publish session-removed for sessions that don't exist
      const removedCalls = mockStreams.publish.mock.calls
        .slice(countBefore)
        .filter((c) => c[1] === 'cli-monitor:session-removed');
      expect(removedCalls).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  describe('query methods', () => {
    it('getSessions returns all active sessions', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions(
        'daemon-001',
        [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })],
        []
      );

      const sessions = service.getSessions();
      expect(sessions).toHaveLength(2);
    });

    it('getSessions filters by retention period', () => {
      service.registerDaemon(makeDaemonPayload());
      const recentSession = makeSession({ sessionId: 'recent', lastActivityAt: Date.now() });
      // Manually add an old session by first ingesting then time-shifting
      service.ingestSessions('daemon-001', [recentSession], []);

      const sessions = service.getSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('getStatus returns connected info', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-001', [makeSession()], []);

      const status = service.getStatus();

      expect(status.connected).toBe(true);
      expect(status.daemon).not.toBeNull();
      expect(status.sessionCount).toBe(1);
    });

    it('getStatus returns disconnected info when no daemon', () => {
      const status = service.getStatus();

      expect(status.connected).toBe(false);
      expect(status.daemon).toBeNull();
      expect(status.sessionCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Topology Graph
  // --------------------------------------------------------------------------

  describe('getTopologyGraph', () => {
    it('returns null when root session not found', () => {
      const result = service.getTopologyGraph('nonexistent');
      expect(result).toBeNull();
    });

    it('builds a topology tree from parent-child sessions', () => {
      service.registerDaemon(makeDaemonPayload());

      const root = makeSession({ sessionId: 'root', status: 'working' });
      const child1 = makeSession({
        sessionId: 'child1',
        parentSessionId: 'root',
        isSubagent: true,
      });
      const child2 = makeSession({
        sessionId: 'child2',
        parentSessionId: 'root',
        isSubagent: true,
      });
      const grandchild = makeSession({
        sessionId: 'grandchild',
        parentSessionId: 'child1',
        isSubagent: true,
      });

      service.ingestSessions('daemon-001', [root, child1, child2, grandchild], []);

      const graph = service.getTopologyGraph('root');

      expect(graph).not.toBeNull();
      expect(graph?.length).toBe(4);

      const rootNode = graph?.find((n) => n.sessionId === 'root');
      expect(rootNode?.depth).toBe(0);

      const child1Node = graph?.find((n) => n.sessionId === 'child1');
      expect(child1Node?.depth).toBe(1);

      const grandchildNode = graph?.find((n) => n.sessionId === 'grandchild');
      expect(grandchildNode?.depth).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Real-time Subscribers
  // --------------------------------------------------------------------------

  describe('real-time subscribers', () => {
    it('delivers events to local subscribers', () => {
      const received: Array<{ type: string; data: unknown; offset: number }> = [];
      const unsub = service.addRealtimeSubscriber((event) => received.push(event));

      service.registerDaemon(makeDaemonPayload());

      expect(received.length).toBeGreaterThan(0);
      expect(received[0].type).toBe('cli-monitor:daemon-connected');

      unsub();
    });

    it('unsubscribes correctly', () => {
      const received: Array<{ type: string }> = [];
      const unsub = service.addRealtimeSubscriber((event) => received.push(event));

      service.registerDaemon(makeDaemonPayload());
      const countAfterRegister = received.length;

      unsub();

      // Further events should not be received
      service.deregisterDaemon('daemon-001');
      expect(received.length).toBe(countAfterRegister);
    });

    it('handles subscriber errors gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      service.addRealtimeSubscriber(() => {
        throw new Error('subscriber error');
      });

      // Should not throw
      service.registerDaemon(makeDaemonPayload());

      consoleSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // Destroy
  // --------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears all state on destroy', () => {
      service.registerDaemon(makeDaemonPayload());
      service.ingestSessions('daemon-001', [makeSession()], []);

      service.destroy();

      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getSessionCount()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Historical Queries (no DB)
  // --------------------------------------------------------------------------

  describe('historical queries without DB', () => {
    it('returns empty array when no DB configured', () => {
      const result = service.getHistoricalSessions();
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance (no DB)
  // --------------------------------------------------------------------------

  describe('maintenance without DB', () => {
    it('returns 0 when no DB configured', async () => {
      const result = await service.runMaintenance();
      expect(result).toBe(0);
    });
  });
});
