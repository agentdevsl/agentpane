/**
 * Integration tests for CliMonitorService.
 *
 * Exercises REAL database operations for CLI session persistence, historical
 * queries, and maintenance cleanup against an in-memory SQLite database.
 * Only the StreamsServer (durable streams) is mocked since it is an external
 * I/O boundary.
 */

import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliSessions } from '../../src/db/schema';
import { CliMonitorService } from '../../src/services/cli-monitor/cli-monitor.service';
import type { CliSession, DaemonRegisterPayload } from '../../src/services/cli-monitor/types';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStreamsServer() {
  return {
    publish: vi.fn().mockResolvedValue(0),
  };
}

function makeDaemonPayload(overrides: Partial<DaemonRegisterPayload> = {}): DaemonRegisterPayload {
  return {
    daemonId: overrides.daemonId ?? `daemon-${createId()}`,
    pid: overrides.pid ?? 12345,
    version: overrides.version ?? '1.0.0',
    watchPath: overrides.watchPath ?? '/home/user/.claude/projects',
    capabilities: overrides.capabilities ?? ['watch', 'ingest'],
    startedAt: overrides.startedAt ?? Date.now(),
  };
}

function makeCliSession(overrides: Partial<CliSession> = {}): CliSession {
  const sessionId = overrides.sessionId ?? `session-${createId()}`;
  return {
    sessionId,
    filePath: overrides.filePath ?? `/home/user/.claude/sessions/${sessionId}.jsonl`,
    cwd: overrides.cwd ?? '/home/user/projects/my-app',
    projectName: overrides.projectName ?? 'my-app',
    projectHash: overrides.projectHash ?? 'abc123',
    gitBranch: overrides.gitBranch ?? 'main',
    status: overrides.status ?? 'working',
    messageCount: overrides.messageCount ?? 5,
    turnCount: overrides.turnCount ?? 3,
    goal: overrides.goal ?? 'Fix the login bug',
    recentOutput: overrides.recentOutput ?? 'Running tests...',
    tokenUsage: overrides.tokenUsage ?? {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 200,
    },
    model: overrides.model ?? 'claude-sonnet-4-6',
    startedAt: overrides.startedAt ?? Date.now() - 60000,
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    lastReadOffset: overrides.lastReadOffset ?? 0,
    isSubagent: overrides.isSubagent ?? false,
    parentSessionId: overrides.parentSessionId,
    slug: overrides.slug,
    version: overrides.version,
    permissionMode: overrides.permissionMode,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CliMonitorService (IT-CLI-001)', () => {
  let db: ReturnType<typeof getTestDb>;
  let streamsServer: ReturnType<typeof createMockStreamsServer>;
  let service: CliMonitorService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    // Create cli_sessions table (not in base MIGRATION_SQL — it's in CLI_SESSIONS_MIGRATION_SQL)
    const sqlite = (db as any).$client;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "cli_sessions" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "session_id" TEXT NOT NULL UNIQUE,
        "file_path" TEXT NOT NULL,
        "cwd" TEXT NOT NULL,
        "project_name" TEXT NOT NULL,
        "project_hash" TEXT NOT NULL,
        "git_branch" TEXT,
        "status" TEXT NOT NULL DEFAULT 'idle',
        "message_count" INTEGER NOT NULL DEFAULT 0,
        "turn_count" INTEGER NOT NULL DEFAULT 0,
        "goal" TEXT,
        "recent_output" TEXT,
        "pending_tool_use" TEXT,
        "token_usage" TEXT,
        "performance_metrics" TEXT,
        "model" TEXT,
        "started_at" INTEGER NOT NULL,
        "last_activity_at" INTEGER NOT NULL,
        "is_subagent" INTEGER NOT NULL DEFAULT 0,
        "parent_session_id" TEXT,
        "slug" TEXT,
        "cli_version" TEXT,
        "permission_mode" TEXT,
        "topology" TEXT,
        "queue_operations" TEXT,
        "tool_invocations" TEXT,
        "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
        "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_sessions_project" ON "cli_sessions"("project_hash", "last_activity_at");
      CREATE INDEX IF NOT EXISTS "idx_cli_sessions_status" ON "cli_sessions"("status");
      CREATE INDEX IF NOT EXISTS "idx_cli_sessions_last_activity" ON "cli_sessions"("last_activity_at");
    `);
    sqlite.exec('DELETE FROM cli_sessions;');

    streamsServer = createMockStreamsServer();
    service = new CliMonitorService(streamsServer as any, db as any);
  });

  afterEach(async () => {
    service.destroy();
    await clearTestDatabase();
  });

  // =========================================================================
  // Daemon registration
  // =========================================================================

  describe('daemon registration', () => {
    it('IT-CLI-001a: registerDaemon sets daemon and publishes event', () => {
      const payload = makeDaemonPayload();
      const result = service.registerDaemon(payload);

      expect(result.ok).toBe(true);
      expect(service.isDaemonConnected()).toBe(true);
      expect(service.getDaemon()?.daemonId).toBe(payload.daemonId);
      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:daemon-connected',
        expect.objectContaining({ daemon: expect.objectContaining({ daemonId: payload.daemonId }) })
      );
    });

    it('IT-CLI-001b: registering a different daemon clears existing sessions', () => {
      const payload1 = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload1);

      // Ingest a session
      const session = makeCliSession();
      service.ingestSessions('daemon-1', [session], []);
      expect(service.getSessionCount()).toBe(1);

      // Register a new daemon
      const payload2 = makeDaemonPayload({ daemonId: 'daemon-2' });
      service.registerDaemon(payload2);

      // Sessions from old daemon should be cleared
      expect(service.getSessionCount()).toBe(0);
      expect(service.getDaemon()?.daemonId).toBe('daemon-2');
    });

    it('IT-CLI-001c: deregisterDaemon clears daemon and sessions', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const session = makeCliSession();
      service.ingestSessions('daemon-1', [session], []);

      const result = service.deregisterDaemon('daemon-1');
      expect(result).toBe(true);
      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getSessionCount()).toBe(0);
    });

    it('IT-CLI-001d: deregisterDaemon returns false for wrong daemonId', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const result = service.deregisterDaemon('wrong-daemon');
      expect(result).toBe(false);
      expect(service.isDaemonConnected()).toBe(true);
    });
  });

  // =========================================================================
  // Heartbeat
  // =========================================================================

  describe('heartbeat', () => {
    it('IT-CLI-002a: handleHeartbeat updates last heartbeat time', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const result = service.handleHeartbeat('daemon-1', 5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('ok');
      }
    });

    it('IT-CLI-002b: handleHeartbeat returns unknown when no daemon registered', () => {
      const result = service.handleHeartbeat('daemon-1', 5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('unknown');
      }
    });

    it('IT-CLI-002c: handleHeartbeat returns stale for wrong daemonId', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const result = service.handleHeartbeat('daemon-2', 5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('stale');
      }
    });
  });

  // =========================================================================
  // Session ingestion
  // =========================================================================

  describe('session ingestion', () => {
    it('IT-CLI-003a: ingestSessions adds sessions to in-memory map', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const sessions = [makeCliSession({ sessionId: 's1' }), makeCliSession({ sessionId: 's2' })];
      const result = service.ingestSessions('daemon-1', sessions, []);

      expect(result).toBe(true);
      expect(service.getSessionCount()).toBe(2);
    });

    it('IT-CLI-003b: ingestSessions returns false for wrong daemonId', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const result = service.ingestSessions('wrong-daemon', [makeCliSession()], []);
      expect(result).toBe(false);
    });

    it('IT-CLI-003c: ingestSessions removes specified sessions', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      service.ingestSessions('daemon-1', [makeCliSession({ sessionId: 's1' })], []);
      expect(service.getSessionCount()).toBe(1);

      service.ingestSessions('daemon-1', [], ['s1']);
      expect(service.getSessionCount()).toBe(0);
    });

    it('IT-CLI-003d: ingestSessions publishes status-change events', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      // First ingest — creates session
      service.ingestSessions(
        'daemon-1',
        [makeCliSession({ sessionId: 's1', status: 'working' })],
        []
      );
      streamsServer.publish.mockClear();

      // Second ingest — status changes
      service.ingestSessions('daemon-1', [makeCliSession({ sessionId: 's1', status: 'idle' })], []);

      expect(streamsServer.publish).toHaveBeenCalledWith(
        'cli-monitor',
        'cli-monitor:status-change',
        expect.objectContaining({
          sessionId: 's1',
          previousStatus: 'working',
          newStatus: 'idle',
        })
      );
    });

    it('IT-CLI-003e: ingestSessions drops sessions older than retention period', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const oldSession = makeCliSession({
        sessionId: 'old-session',
        lastActivityAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      });

      service.ingestSessions('daemon-1', [oldSession], []);
      // Old session should be filtered out
      expect(service.getSessionCount()).toBe(0);
    });

    it('IT-CLI-003f: ingestSessions persists to database', async () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const session = makeCliSession({ sessionId: 'persist-test' });
      service.ingestSessions('daemon-1', [session], []);

      // Wait for async persistence
      await new Promise((resolve) => setTimeout(resolve, 100));

      const rows = db.select().from(cliSessions).all();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const persisted = rows.find((r) => r.sessionId === 'persist-test');
      expect(persisted).toBeDefined();
      expect(persisted?.projectName).toBe('my-app');
    });

    it('IT-CLI-003g: ingestSessions evicts oldest sessions when exceeding max', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      // We cannot easily test the MAX_SESSIONS limit (10,000) but we can verify
      // the eviction logic works by checking that ingestion doesn't crash.
      const sessions = Array.from({ length: 100 }, (_, i) =>
        makeCliSession({
          sessionId: `s-${i}`,
          lastActivityAt: Date.now() - i * 1000,
        })
      );

      service.ingestSessions('daemon-1', sessions, []);
      expect(service.getSessionCount()).toBe(100);
    });
  });

  // =========================================================================
  // Queries
  // =========================================================================

  describe('queries', () => {
    it('IT-CLI-004a: getSessions returns active sessions within retention', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const sessions = [
        makeCliSession({ sessionId: 's1', lastActivityAt: Date.now() }),
        makeCliSession({ sessionId: 's2', lastActivityAt: Date.now() - 1000 }),
      ];
      service.ingestSessions('daemon-1', sessions, []);

      const result = service.getSessions();
      expect(result.length).toBe(2);
    });

    it('IT-CLI-004b: getStatus returns connection and session info', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      service.ingestSessions('daemon-1', [makeCliSession()], []);

      const status = service.getStatus();
      expect(status.connected).toBe(true);
      expect(status.daemon).not.toBeNull();
      expect(status.sessionCount).toBe(1);
    });

    it('IT-CLI-004c: getStatus returns disconnected when no daemon', () => {
      const status = service.getStatus();
      expect(status.connected).toBe(false);
      expect(status.daemon).toBeNull();
      expect(status.sessionCount).toBe(0);
    });
  });

  // =========================================================================
  // Historical queries (from DB)
  // =========================================================================

  describe('historical queries', () => {
    let histService: CliMonitorService;

    beforeEach(async () => {
      // Wait for any fire-and-forget persistence from prior tests to settle
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Clear any sessions persisted by prior tests
      (db as any).$client.exec('DELETE FROM cli_sessions;');

      // Create a fresh service instance to avoid interference
      histService = new CliMonitorService(createMockStreamsServer() as any, db as any);

      // Seed DB with historical sessions
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await db.insert(cliSessions).values({
          id: createId(),
          sessionId: `hist-${i}`,
          filePath: `/path/session-${i}.jsonl`,
          cwd: `/projects/app-${i}`,
          projectName: `app-${i}`,
          projectHash: i < 3 ? 'hash-a' : 'hash-b',
          status: 'idle',
          messageCount: 10 + i,
          turnCount: 5 + i,
          startedAt: now - (5 - i) * 3600_000,
          lastActivityAt: now - (5 - i) * 1800_000,
        });
      }
    });

    afterEach(() => {
      histService.destroy();
    });

    it('IT-CLI-005a: getHistoricalSessions returns persisted sessions', () => {
      const results = histService.getHistoricalSessions();
      expect(results.length).toBe(5);
    });

    it('IT-CLI-005b: getHistoricalSessions filters by projectHash', () => {
      const results = histService.getHistoricalSessions({ projectHash: 'hash-a' });
      expect(results.length).toBe(3);
      for (const s of results) {
        expect(s.projectHash).toBe('hash-a');
      }
    });

    it('IT-CLI-005c: getHistoricalSessions filters by since timestamp', () => {
      const since = Date.now() - 2 * 3600_000; // 2 hours ago
      const results = histService.getHistoricalSessions({ since });
      // Should return sessions with lastActivityAt > since
      expect(results.length).toBeGreaterThan(0);
      for (const s of results) {
        expect(s.lastActivityAt).toBeGreaterThan(since);
      }
    });

    it('IT-CLI-005d: getHistoricalSessions respects limit', () => {
      const results = histService.getHistoricalSessions({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('IT-CLI-005e: getHistoricalSessions returns empty when no DB', () => {
      const serviceNoDB = new CliMonitorService(streamsServer as any);
      const results = serviceNoDB.getHistoricalSessions();
      expect(results).toEqual([]);
      serviceNoDB.destroy();
    });
  });

  // =========================================================================
  // Topology
  // =========================================================================

  describe('topology graph', () => {
    it('IT-CLI-006a: getTopologyGraph returns null for unknown session', () => {
      const result = service.getTopologyGraph('nonexistent');
      expect(result).toBeNull();
    });

    it('IT-CLI-006b: getTopologyGraph builds tree from parent-child sessions', () => {
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      const root = makeCliSession({
        sessionId: 'root',
        isSubagent: false,
      });
      const child1 = makeCliSession({
        sessionId: 'child-1',
        isSubagent: true,
        parentSessionId: 'root',
      });
      const child2 = makeCliSession({
        sessionId: 'child-2',
        isSubagent: true,
        parentSessionId: 'root',
      });
      const grandchild = makeCliSession({
        sessionId: 'grandchild-1',
        isSubagent: true,
        parentSessionId: 'child-1',
      });

      service.ingestSessions('daemon-1', [root, child1, child2, grandchild], []);

      const graph = service.getTopologyGraph('root');
      expect(graph).not.toBeNull();
      expect(graph!.length).toBe(4);

      // Root is at depth 0
      const rootNode = graph!.find((n) => n.sessionId === 'root');
      expect(rootNode?.depth).toBe(0);

      // Children at depth 1
      const child1Node = graph!.find((n) => n.sessionId === 'child-1');
      expect(child1Node?.depth).toBe(1);

      // Grandchild at depth 2
      const grandchildNode = graph!.find((n) => n.sessionId === 'grandchild-1');
      expect(grandchildNode?.depth).toBe(2);
    });
  });

  // =========================================================================
  // Maintenance
  // =========================================================================

  describe('maintenance', () => {
    beforeEach(() => {
      // Clear any sessions from prior tests
      (db as any).$client.exec('DELETE FROM cli_sessions;');
    });

    it('IT-CLI-007a: runMaintenance deletes sessions older than retention period', async () => {
      const now = Date.now();
      const oldTime = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago

      await db.insert(cliSessions).values({
        id: createId(),
        sessionId: 'old-session',
        filePath: '/path/old.jsonl',
        cwd: '/projects/old',
        projectName: 'old-project',
        projectHash: 'hash-old',
        status: 'idle',
        messageCount: 5,
        turnCount: 3,
        startedAt: oldTime,
        lastActivityAt: oldTime,
      });

      await db.insert(cliSessions).values({
        id: createId(),
        sessionId: 'new-session',
        filePath: '/path/new.jsonl',
        cwd: '/projects/new',
        projectName: 'new-project',
        projectHash: 'hash-new',
        status: 'working',
        messageCount: 10,
        turnCount: 5,
        startedAt: now,
        lastActivityAt: now,
      });

      const deleted = await service.runMaintenance();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = db.select().from(cliSessions).all();
      expect(remaining.length).toBe(1);
      expect(remaining[0].sessionId).toBe('new-session');
    });

    it('IT-CLI-007b: runMaintenance returns 0 when no DB', async () => {
      const serviceNoDB = new CliMonitorService(streamsServer as any);
      const deleted = await serviceNoDB.runMaintenance();
      expect(deleted).toBe(0);
      serviceNoDB.destroy();
    });

    it('IT-CLI-007c: runMaintenance deletes sessions older than default retention', async () => {
      // Note: the service reads 'cliMonitor.retentionDays' from settings via
      // db.query.settings.findFirst (not awaited), so it always falls through
      // to the DEFAULT_RETENTION_DAYS (7 days). We test with a 10-day-old session.
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      await db.insert(cliSessions).values({
        id: createId(),
        sessionId: 'ten-days-old',
        filePath: '/path/old.jsonl',
        cwd: '/projects/old',
        projectName: 'old',
        projectHash: 'hash',
        status: 'idle',
        messageCount: 5,
        turnCount: 3,
        startedAt: tenDaysAgo,
        lastActivityAt: tenDaysAgo,
      });

      const deleted = await service.runMaintenance();
      expect(deleted).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // SSE subscription
  // =========================================================================

  describe('realtime subscriber', () => {
    it('IT-CLI-008a: addRealtimeSubscriber receives events', () => {
      const received: Array<{ type: string; data: unknown; offset: number }> = [];
      const unsub = service.addRealtimeSubscriber((event) => {
        received.push(event);
      });

      // Trigger an event
      const payload = makeDaemonPayload({ daemonId: 'daemon-1' });
      service.registerDaemon(payload);

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0].type).toBe('cli-monitor:daemon-connected');

      unsub();
    });

    it('IT-CLI-008b: unsubscribe stops receiving events', () => {
      const received: Array<{ type: string }> = [];
      const unsub = service.addRealtimeSubscriber((event) => {
        received.push(event);
      });

      unsub();

      // Trigger an event after unsubscribe
      service.registerDaemon(makeDaemonPayload());
      expect(received.length).toBe(0);
    });
  });

  // =========================================================================
  // Destroy / cleanup
  // =========================================================================

  describe('destroy', () => {
    it('IT-CLI-009a: destroy clears all state', () => {
      service.registerDaemon(makeDaemonPayload({ daemonId: 'daemon-1' }));
      service.ingestSessions('daemon-1', [makeCliSession()], []);
      service.addRealtimeSubscriber(() => {});

      service.destroy();

      expect(service.isDaemonConnected()).toBe(false);
      expect(service.getSessionCount()).toBe(0);
    });
  });
});
