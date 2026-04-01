import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliMonitorRoutes } from '../../src/server/routes/cli-monitor';
import type { CliMonitorService } from '../../src/services/cli-monitor/cli-monitor.service';
import type { CliSession, DaemonInfo } from '../../src/services/cli-monitor/types';

/**
 * Integration tests for CLI Monitor routes.
 *
 * The CLI monitor service is in-memory (no DB for live sessions),
 * so we create a mock service that tracks daemon/session state.
 */

const now = Date.now();

function makeCliSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'sess-1',
    filePath: '/home/user/.claude/sessions/sess-1.jsonl',
    cwd: '/home/user/project',
    projectName: 'project',
    projectHash: 'abc123',
    status: 'working',
    messageCount: 5,
    turnCount: 3,
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    startedAt: now - 60_000,
    lastActivityAt: now,
    lastReadOffset: 0,
    isSubagent: false,
    ...overrides,
  };
}

function makeDaemonInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    daemonId: 'daemon-1',
    pid: 12345,
    version: '1.0.0',
    watchPath: '/home/user/.claude',
    capabilities: ['watch', 'ingest'],
    registeredAt: now,
    lastHeartbeatAt: now,
    ...overrides,
  };
}

function createMockCliMonitorService() {
  let daemon: DaemonInfo | null = null;
  const sessions = new Map<string, CliSession>();
  const subscribers = new Set<(event: { type: string; data: unknown }) => void>();

  return {
    registerDaemon: vi.fn((payload: DaemonInfo) => {
      daemon = { ...payload, registeredAt: Date.now(), lastHeartbeatAt: Date.now() };
      return { ok: true as const, value: undefined };
    }),
    handleHeartbeat: vi.fn((daemonId: string, _count: number) => {
      if (!daemon) return { ok: true as const, value: 'unknown' };
      if (daemon.daemonId !== daemonId) return { ok: true as const, value: 'stale' };
      daemon.lastHeartbeatAt = Date.now();
      return { ok: true as const, value: 'ok' };
    }),
    ingestSessions: vi.fn((daemonId: string, newSessions: CliSession[], removedIds: string[]) => {
      if (daemon?.daemonId !== daemonId) return false;
      for (const s of newSessions) sessions.set(s.sessionId, s);
      for (const id of removedIds) sessions.delete(id);
      return true;
    }),
    deregisterDaemon: vi.fn((daemonId: string) => {
      if (daemon?.daemonId !== daemonId) return false;
      daemon = null;
      sessions.clear();
      return true;
    }),
    getStatus: vi.fn(() => ({
      connected: daemon !== null,
      daemon,
      sessionCount: sessions.size,
    })),
    getSessions: vi.fn(() => Array.from(sessions.values())),
    isDaemonConnected: vi.fn(() => daemon !== null),
    getDaemon: vi.fn(() => daemon),
    getHistoricalSessions: vi.fn((_opts?: unknown) => []),
    addRealtimeSubscriber: vi.fn((cb: (event: { type: string; data: unknown }) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
    getTopologyGraph: vi.fn((_rootSessionId: string) => null),

    // Test helpers (not part of public interface)
    _setDaemon: (d: DaemonInfo | null) => {
      daemon = d;
    },
    _setSessions: (s: CliSession[]) => {
      sessions.clear();
      for (const sess of s) sessions.set(sess.sessionId, sess);
    },
  };
}

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('CLI Monitor Routes (IT-500)', () => {
  let app: ReturnType<typeof createCliMonitorRoutes>;
  let mockService: ReturnType<typeof createMockCliMonitorService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockCliMonitorService();
    app = createCliMonitorRoutes({
      cliMonitorService: mockService as unknown as CliMonitorService,
    });
  });

  // ─── POST /register ───────────────────────────

  describe('POST /register', () => {
    it('IT-501: registers a daemon successfully', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/register', {
          daemonId: 'daemon-1',
          pid: 12345,
          version: '1.0.0',
          watchPath: '/home/user/.claude',
          capabilities: ['watch'],
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(mockService.registerDaemon).toHaveBeenCalledOnce();
    });

    it('IT-502: returns 400 for missing required fields', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/register', {
          daemonId: 'daemon-1',
          // missing pid, version, watchPath
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-503: returns 400 for invalid JSON', async () => {
      const response = await app.request(
        new Request('http://localhost/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_JSON');
    });

    it('IT-504: returns 400 for empty daemonId', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/register', {
          daemonId: '',
          pid: 12345,
          version: '1.0.0',
          watchPath: '/home/user/.claude',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });
  });

  // ─── POST /heartbeat ──────────────────────────

  describe('POST /heartbeat', () => {
    it('IT-505: handles heartbeat for registered daemon', async () => {
      // Pre-register the daemon so handleHeartbeat returns 'ok'
      mockService._setDaemon(makeDaemonInfo());

      const response = await app.request(
        jsonRequest('http://localhost/heartbeat', {
          daemonId: 'daemon-1',
          sessionCount: 3,
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(mockService.handleHeartbeat).toHaveBeenCalledWith('daemon-1', 3);
    });

    it('IT-506: returns 409 when daemon is not recognized', async () => {
      // Force the mock to return 'unknown' (unregistered daemon)
      mockService.handleHeartbeat.mockReturnValue({ ok: true, value: 'unknown' });

      const response = await app.request(
        jsonRequest('http://localhost/heartbeat', {
          daemonId: 'unknown-daemon',
          sessionCount: 0,
        })
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('REREGISTER');
    });

    it('IT-507: returns 400 for missing daemonId', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/heartbeat', {
          sessionCount: 0,
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });
  });

  // ─── POST /ingest ─────────────────────────────

  describe('POST /ingest', () => {
    it('IT-508: accepts session ingest from registered daemon', async () => {
      mockService._setDaemon(makeDaemonInfo());

      const session = makeCliSession();
      const response = await app.request(
        jsonRequest('http://localhost/ingest', {
          daemonId: 'daemon-1',
          sessions: [session],
          removedSessionIds: [],
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(mockService.ingestSessions).toHaveBeenCalledOnce();
    });

    it('IT-509: returns 404 for unknown daemon', async () => {
      mockService.ingestSessions.mockReturnValue(false);

      const response = await app.request(
        jsonRequest('http://localhost/ingest', {
          daemonId: 'unknown-daemon',
          sessions: [],
          removedSessionIds: [],
        })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('UNKNOWN_DAEMON');
    });

    it('IT-510: returns 400 for missing daemonId in ingest', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/ingest', {
          sessions: [],
        })
      );

      expect(response.status).toBe(400);
    });

    it('IT-511: rejects payload exceeding 5MB', async () => {
      const response = await app.request(
        new Request('http://localhost/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'content-length': String(6 * 1024 * 1024),
          },
          body: JSON.stringify({ daemonId: 'daemon-1', sessions: [] }),
        })
      );

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  // ─── POST /deregister ─────────────────────────

  describe('POST /deregister', () => {
    it('IT-512: deregisters a daemon', async () => {
      const response = await app.request(
        jsonRequest('http://localhost/deregister', {
          daemonId: 'daemon-1',
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(mockService.deregisterDaemon).toHaveBeenCalledWith('daemon-1');
    });

    it('IT-513: returns 400 for missing daemonId', async () => {
      const response = await app.request(jsonRequest('http://localhost/deregister', {}));

      expect(response.status).toBe(400);
    });
  });

  // ─── GET /status ──────────────────────────────

  describe('GET /status', () => {
    it('IT-514: returns status when no daemon connected', async () => {
      const response = await app.request('http://localhost/status');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.connected).toBe(false);
    });

    it('IT-515: returns status with connected daemon', async () => {
      mockService.getStatus.mockReturnValue({
        connected: true,
        daemon: makeDaemonInfo(),
        sessionCount: 2,
      });

      const response = await app.request('http://localhost/status');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.connected).toBe(true);
      expect(body.data.sessionCount).toBe(2);
    });
  });

  // ─── GET /sessions ────────────────────────────

  describe('GET /sessions', () => {
    it('IT-516: returns empty sessions list', async () => {
      const response = await app.request('http://localhost/sessions');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.sessions).toEqual([]);
      expect(body.data.total).toBe(0);
    });

    it('IT-517: returns sessions sorted by lastActivityAt', async () => {
      const sessions = [
        makeCliSession({ sessionId: 'sess-1', lastActivityAt: now - 10_000 }),
        makeCliSession({ sessionId: 'sess-2', lastActivityAt: now }),
      ];
      mockService.getSessions.mockReturnValue(sessions);

      const response = await app.request('http://localhost/sessions');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.sessions).toHaveLength(2);
      // Most recent first
      expect(body.data.sessions[0].sessionId).toBe('sess-2');
      expect(body.data.total).toBe(2);
    });

    it('IT-518: supports pagination with limit and offset', async () => {
      const sessions = Array.from({ length: 5 }, (_, i) =>
        makeCliSession({ sessionId: `sess-${i}`, lastActivityAt: now - i * 1000 })
      );
      mockService.getSessions.mockReturnValue(sessions);

      const response = await app.request('http://localhost/sessions?limit=2&offset=1');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.sessions).toHaveLength(2);
      expect(body.data.total).toBe(5);
    });
  });

  // ─── GET /history ─────────────────────────────

  describe('GET /history', () => {
    it('IT-519: returns historical sessions', async () => {
      mockService.getHistoricalSessions.mockReturnValue([]);

      const response = await app.request('http://localhost/history');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.sessions).toEqual([]);
    });

    it('IT-520: passes query filters to service', async () => {
      mockService.getHistoricalSessions.mockReturnValue([]);

      await app.request('http://localhost/history?projectHash=abc&since=1700000000000&limit=10');

      expect(mockService.getHistoricalSessions).toHaveBeenCalledWith({
        projectHash: 'abc',
        since: 1700000000000,
        limit: 10,
      });
    });

    it('IT-521: returns 500 when historical query fails', async () => {
      mockService.getHistoricalSessions.mockImplementation(() => {
        throw new Error('DB error');
      });

      const response = await app.request('http://localhost/history');

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe('DB_ERROR');
    });
  });

  // ─── GET /topology ────────────────────────────

  describe('GET /topology', () => {
    it('IT-522: returns 400 when rootSessionId missing', async () => {
      const response = await app.request('http://localhost/topology');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('MISSING_PARAMS');
    });

    it('IT-523: returns 404 when session not found', async () => {
      mockService.getTopologyGraph.mockReturnValue(null);

      const response = await app.request('http://localhost/topology?rootSessionId=nonexistent');

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('IT-524: returns topology nodes for valid session', async () => {
      const nodes = [
        {
          sessionId: 'root-1',
          agentType: 'main',
          childSessionIds: ['child-1'],
          depth: 0,
          status: 'working',
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          turnCount: 2,
          messageCount: 4,
        },
      ];
      mockService.getTopologyGraph.mockReturnValue(nodes);

      const response = await app.request('http://localhost/topology?rootSessionId=root-1');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.nodes).toHaveLength(1);
      expect(body.data.rootSessionId).toBe('root-1');
    });
  });

  // ─── GET /stream (SSE) ────────────────────────

  describe('GET /stream', () => {
    it('IT-525: returns SSE content type', async () => {
      const response = await app.request('http://localhost/stream');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    });
  });
});
