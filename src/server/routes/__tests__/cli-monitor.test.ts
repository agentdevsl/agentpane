import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliMonitorService } from '../../../services/cli-monitor/cli-monitor.service.js';
import { createCliMonitorRoutes } from '../cli-monitor.js';

// ── Mock Streams Server ──

function createMockStreamsServer() {
  const published: Array<{ id: string; type: string; data: unknown }> = [];
  return {
    publish: vi.fn(async (id: string, type: string, data: unknown) => {
      published.push({ id, type, data });
      return published.length;
    }),
    addRealtimeSubscriber: vi.fn(() => vi.fn()),
    getEvents: vi.fn(() => []),
    _published: published,
  };
}

// ── Test App Factory ──

function createTestApp() {
  const streamsServer = createMockStreamsServer();
  const service = new CliMonitorService(streamsServer as never);
  const routes = createCliMonitorRoutes({ cliMonitorService: service });
  const app = new Hono();
  app.route('/api/cli-monitor', routes);
  return { app, service, streamsServer };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('CLI Monitor API Routes', () => {
  let app: Hono;
  let service: CliMonitorService;

  afterEach(() => {
    service.destroy();
  });

  // ── POST /register ──

  describe('POST /api/cli-monitor/register', () => {
    it('registers daemon and returns ok', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'daemon-1',
        pid: 12345,
        version: '0.1.0',
        watchPath: '/home/user/.claude/projects',
        capabilities: ['jsonl'],
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
      expect(service.isDaemonConnected()).toBe(true);
      expect(service.getDaemon()!.daemonId).toBe('daemon-1');
    });

    it('defaults capabilities and startedAt when omitted', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'daemon-2',
        pid: 999,
        version: '0.2.0',
        watchPath: '/tmp',
      });

      expect(res.status).toBe(200);
      expect(service.getDaemon()!.daemonId).toBe('daemon-2');
    });

    it('returns 400 when daemonId is missing', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        pid: 123,
        version: '0.1.0',
        watchPath: '/tmp',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when pid is negative', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'daemon-1',
        pid: -5,
        version: '0.1.0',
        watchPath: '/tmp',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when pid is a string', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'daemon-1',
        pid: 'not-a-number',
        version: '0.1.0',
        watchPath: '/tmp',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-JSON body', async () => {
      ({ app, service } = createTestApp());

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      };
      const res = await app.request('/api/cli-monitor/register', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 200 with valid minimal payload', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'd',
        pid: 1,
        version: 'v',
        watchPath: '/',
      });

      expect(res.status).toBe(200);
    });
  });

  // ── POST /heartbeat ──

  describe('POST /api/cli-monitor/heartbeat', () => {
    it('returns ok for registered daemon', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      const res = await request(app, 'POST', '/api/cli-monitor/heartbeat', {
        daemonId: 'daemon-1',
        sessionCount: 3,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
    });

    it('returns 409 for unknown daemon', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/heartbeat', {
        daemonId: 'unknown-daemon',
        sessionCount: 0,
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('REREGISTER');
    });

    it('returns 400 when daemonId is missing', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/heartbeat', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-JSON body', async () => {
      ({ app, service } = createTestApp());

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/cli-monitor/heartbeat', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });
  });

  // ── POST /ingest ──

  describe('POST /api/cli-monitor/ingest', () => {
    it('ingests sessions and returns ok', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      const sessions = [
        {
          sessionId: 'sess-1',
          filePath: '/test/sess-1.jsonl',
          cwd: '/project',
          projectName: 'project',
          projectHash: 'hash1',
          status: 'working',
          messageCount: 2,
          turnCount: 1,
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          lastReadOffset: 0,
          isSubagent: false,
        },
      ];

      const res = await request(app, 'POST', '/api/cli-monitor/ingest', {
        daemonId: 'daemon-1',
        sessions,
        removedSessionIds: [],
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
      expect(service.getSessionCount()).toBe(1);
    });

    it('returns 404 for unknown daemon', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/ingest', {
        daemonId: 'unknown',
        sessions: [],
        removedSessionIds: [],
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('UNKNOWN_DAEMON');
    });

    it('handles missing sessions and removedSessionIds fields', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      const res = await request(app, 'POST', '/api/cli-monitor/ingest', {
        daemonId: 'daemon-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
    });

    it('returns 400 for malformed session object', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/ingest', {
        daemonId: 'daemon-1',
        sessions: [{ invalid: true }],
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for oversized sessions array (>500)', async () => {
      ({ app, service } = createTestApp());

      const sessions = Array.from({ length: 501 }, (_, i) => ({
        sessionId: `sess-${i}`,
        filePath: `/test/sess-${i}.jsonl`,
        cwd: '/project',
        projectName: 'project',
        status: 'working',
        messageCount: 0,
        turnCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastReadOffset: 0,
        isSubagent: false,
      }));

      const res = await request(app, 'POST', '/api/cli-monitor/ingest', {
        daemonId: 'daemon-1',
        sessions,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-JSON body', async () => {
      ({ app, service } = createTestApp());

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/cli-monitor/ingest', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });
  });

  // ── POST /deregister ──

  describe('POST /api/cli-monitor/deregister', () => {
    it('deregisters daemon and returns ok', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      const res = await request(app, 'POST', '/api/cli-monitor/deregister', {
        daemonId: 'daemon-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
      expect(service.isDaemonConnected()).toBe(false);
    });

    it('returns ok even for unknown daemon (idempotent)', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/deregister', {
        daemonId: 'nonexistent',
      });

      // deregisterDaemon returns false but route still returns ok
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
    });

    it('returns 400 when daemonId is missing', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/deregister', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-JSON body', async () => {
      ({ app, service } = createTestApp());

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '!!!',
      };
      const res = await app.request('/api/cli-monitor/deregister', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });
  });

  // ── GET /status ──

  describe('GET /api/cli-monitor/status', () => {
    it('returns disconnected status when no daemon', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/status');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.connected).toBe(false);
      expect(json.data.daemon).toBeNull();
      expect(json.data.sessionCount).toBe(0);
    });

    it('returns connected status with session count', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });
      service.ingestSessions(
        'daemon-1',
        [
          {
            sessionId: 'sess-1',
            filePath: '/test.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'h1',
            status: 'working',
            messageCount: 0,
            turnCount: 0,
            tokenUsage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            lastReadOffset: 0,
            isSubagent: false,
          },
        ],
        []
      );

      const res = await request(app, 'GET', '/api/cli-monitor/status');

      const json = await res.json();
      expect(json.data.connected).toBe(true);
      expect(json.data.daemon.daemonId).toBe('daemon-1');
      expect(json.data.sessionCount).toBe(1);
    });
  });

  // ── GET /sessions ──

  describe('GET /api/cli-monitor/sessions', () => {
    it('returns empty sessions list when none ingested', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/sessions');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.sessions).toEqual([]);
      expect(json.data.connected).toBe(false);
    });

    it('returns sessions and connected state', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });
      service.ingestSessions(
        'daemon-1',
        [
          {
            sessionId: 'sess-1',
            filePath: '/test.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'h1',
            status: 'idle',
            messageCount: 10,
            turnCount: 5,
            tokenUsage: {
              inputTokens: 500,
              outputTokens: 200,
              cacheCreationTokens: 0,
              cacheReadTokens: 100,
            },
            startedAt: Date.now() - 60000,
            lastActivityAt: Date.now(),
            lastReadOffset: 4096,
            isSubagent: false,
          },
        ],
        []
      );

      const res = await request(app, 'GET', '/api/cli-monitor/sessions');

      const json = await res.json();
      expect(json.data.sessions).toHaveLength(1);
      expect(json.data.sessions[0].sessionId).toBe('sess-1');
      expect(json.data.connected).toBe(true);
    });
  });

  // ── GET /stream ──

  describe('GET /api/cli-monitor/stream', () => {
    it('returns SSE response with correct content-type header', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/stream');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.headers.get('Connection')).toBe('keep-alive');
    });

    it('sends initial snapshot as first SSE message', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);

      // Should start with "data: " prefix (SSE format)
      expect(text).toContain('data: ');
      const jsonStr = text.replace('data: ', '').trim();
      const parsed = JSON.parse(jsonStr);
      expect(parsed.type).toBe('cli-monitor:snapshot');
      expect(parsed.sessions).toEqual([]);
      expect(parsed.connected).toBe(false);

      reader.cancel();
    });
  });

  // ── GET /topology ──

  describe('GET /api/cli-monitor/topology', () => {
    it('returns 400 when rootSessionId is missing', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/topology');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAM');
    });

    it('returns 404 when rootSessionId does not match any session', async () => {
      ({ app, service } = createTestApp());

      const res = await request(
        app,
        'GET',
        '/api/cli-monitor/topology?rootSessionId=nonexistent-id'
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns nodes array for valid rootSessionId', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });
      service.ingestSessions(
        'daemon-1',
        [
          {
            sessionId: 'root-sess',
            filePath: '/test/root.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'h1',
            status: 'working',
            messageCount: 5,
            turnCount: 2,
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            lastReadOffset: 0,
            isSubagent: false,
          },
        ],
        []
      );

      const res = await request(app, 'GET', '/api/cli-monitor/topology?rootSessionId=root-sess');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.nodes).toBeDefined();
      expect(Array.isArray(json.data.nodes)).toBe(true);
      expect(json.data.nodes).toHaveLength(1);
      expect(json.data.nodes[0].sessionId).toBe('root-sess');
      expect(json.data.rootSessionId).toBe('root-sess');
    });

    it('returns parent at depth 0 and child at depth 1 for multi-level topology', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });
      service.ingestSessions(
        'daemon-1',
        [
          {
            sessionId: 'parent-sess',
            filePath: '/test/parent.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'h1',
            status: 'working',
            messageCount: 3,
            turnCount: 1,
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            startedAt: Date.now() - 5000,
            lastActivityAt: Date.now(),
            lastReadOffset: 0,
            isSubagent: false,
          },
          {
            sessionId: 'child-sess',
            filePath: '/test/child.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'h1',
            status: 'working',
            messageCount: 1,
            turnCount: 0,
            tokenUsage: {
              inputTokens: 20,
              outputTokens: 10,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            startedAt: Date.now() - 2000,
            lastActivityAt: Date.now(),
            lastReadOffset: 0,
            isSubagent: true,
            parentSessionId: 'parent-sess',
          },
        ],
        []
      );

      const res = await request(app, 'GET', '/api/cli-monitor/topology?rootSessionId=parent-sess');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.nodes).toHaveLength(2);

      const parentNode = json.data.nodes.find(
        (n: { sessionId: string }) => n.sessionId === 'parent-sess'
      );
      const childNode = json.data.nodes.find(
        (n: { sessionId: string }) => n.sessionId === 'child-sess'
      );

      expect(parentNode).toBeDefined();
      expect(parentNode.depth).toBe(0);
      expect(childNode).toBeDefined();
      expect(childNode.depth).toBe(1);
    });
  });

  // ── GET /sessions with pagination ──

  describe('GET /api/cli-monitor/sessions (pagination)', () => {
    it('returns total count alongside sessions', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/sessions');
      const json = await res.json();

      expect(json.data.total).toBe(0);
      expect(json.data.sessions).toEqual([]);
    });

    it('paginates with limit and offset', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      // Ingest 5 sessions
      const sessions = Array.from({ length: 5 }, (_, i) => ({
        sessionId: `sess-${i}`,
        filePath: `/test/sess-${i}.jsonl`,
        cwd: '/project',
        projectName: 'project',
        projectHash: `h${i}`,
        status: 'working' as const,
        messageCount: 0,
        turnCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastReadOffset: 0,
        isSubagent: false,
      }));
      service.ingestSessions('daemon-1', sessions, []);

      // Get first 2
      const res = await request(app, 'GET', '/api/cli-monitor/sessions?limit=2&offset=0');
      const json = await res.json();

      expect(json.data.sessions).toHaveLength(2);
      expect(json.data.total).toBe(5);
    });

    it('returns all sessions when no pagination params', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });

      const sessions = Array.from({ length: 3 }, (_, i) => ({
        sessionId: `sess-${i}`,
        filePath: `/test/sess-${i}.jsonl`,
        cwd: '/project',
        projectName: 'project',
        projectHash: `h${i}`,
        status: 'working' as const,
        messageCount: 0,
        turnCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastReadOffset: 0,
        isSubagent: false,
      }));
      service.ingestSessions('daemon-1', sessions, []);

      const res = await request(app, 'GET', '/api/cli-monitor/sessions');
      const json = await res.json();

      expect(json.data.sessions).toHaveLength(3);
      expect(json.data.total).toBe(3);
    });
  });

  // ── GET /history ──

  describe('GET /api/cli-monitor/history', () => {
    it('returns sessions and total when daemon is registered and sessions have been ingested', async () => {
      ({ app, service } = createTestApp());
      service.registerDaemon({
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
        capabilities: [],
        startedAt: Date.now(),
      });
      service.ingestSessions(
        'daemon-1',
        [
          {
            sessionId: 'sess-hist-1',
            filePath: '/test/sess-hist-1.jsonl',
            cwd: '/project',
            projectName: 'project',
            projectHash: 'hash-abc',
            status: 'idle',
            messageCount: 5,
            turnCount: 2,
            tokenUsage: {
              inputTokens: 200,
              outputTokens: 100,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            startedAt: Date.now() - 120000,
            lastActivityAt: Date.now(),
            lastReadOffset: 0,
            isSubagent: false,
          },
        ],
        []
      );

      const res = await request(app, 'GET', '/api/cli-monitor/history');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeDefined();
      expect(Array.isArray(json.data.sessions)).toBe(true);
      expect(typeof json.data.total).toBe('number');
    });

    it('returns empty sessions and total 0 when no daemon and no DB sessions', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'GET', '/api/cli-monitor/history');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.sessions).toEqual([]);
      expect(json.data.total).toBe(0);
    });

    it('returns 500 with DB_ERROR code when getHistoricalSessions throws', async () => {
      ({ app, service } = createTestApp());
      vi.spyOn(service, 'getHistoricalSessions').mockImplementation(() => {
        throw new Error('Simulated database failure');
      });

      const res = await request(app, 'GET', '/api/cli-monitor/history');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── Body size limit ──

  describe('POST body size limit', () => {
    it('returns 413 when content-length exceeds 5MB', async () => {
      ({ app, service } = createTestApp());

      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(6 * 1024 * 1024), // 6MB
        },
        body: JSON.stringify({ daemonId: 'test' }),
      };
      const res = await app.request('/api/cli-monitor/register', init);

      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('allows requests within 5MB limit', async () => {
      ({ app, service } = createTestApp());

      const res = await request(app, 'POST', '/api/cli-monitor/register', {
        daemonId: 'daemon-1',
        pid: 1,
        version: '0.1.0',
        watchPath: '/tmp',
      });

      expect(res.status).toBe(200);
    });
  });
});
