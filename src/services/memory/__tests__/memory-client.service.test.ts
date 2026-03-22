// @ts-nocheck — test assertions use array indexing that TS flags as possibly undefined
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references (available inside vi.mock factory)
// ---------------------------------------------------------------------------

const {
  mockGetMetadata,
  mockDeleteWorkspace,
  mockPeerFn,
  mockSessionFn,
  mockSessionsFn,
  mockScheduleDream,
  MockConnectionError,
  MockTimeoutError,
} = vi.hoisted(() => {
  class _MockConnectionError extends Error {
    constructor(message = 'connection error') {
      super(message);
      this.name = 'ConnectionError';
    }
  }
  class _MockTimeoutError extends Error {
    constructor(message = 'timeout error') {
      super(message);
      this.name = 'TimeoutError';
    }
  }
  return {
    mockGetMetadata: vi.fn().mockResolvedValue({}),
    mockDeleteWorkspace: vi.fn().mockResolvedValue(undefined),
    mockPeerFn: vi.fn(),
    mockSessionFn: vi.fn(),
    mockSessionsFn: vi.fn(),
    mockScheduleDream: vi.fn().mockResolvedValue(undefined),
    MockConnectionError: _MockConnectionError,
    MockTimeoutError: _MockTimeoutError,
  };
});

vi.mock('@honcho-ai/sdk', () => {
  // Must use a class (not arrow function) so it works with `new Honcho({...})`
  class MockHoncho {
    workspaceId: string;
    peer = mockPeerFn;
    session = mockSessionFn;
    sessions = mockSessionsFn;
    getMetadata = mockGetMetadata;
    scheduleDream = mockScheduleDream;
    deleteWorkspace = mockDeleteWorkspace;
    constructor(opts: { workspaceId: string }) {
      this.workspaceId = opts.workspaceId;
    }
  }
  return {
    Honcho: MockHoncho,
    ConnectionError: MockConnectionError,
    TimeoutError: MockTimeoutError,
  };
});

// Mock fetch for ping/health
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import type { Peer, Session } from '@honcho-ai/sdk';
import { ok } from '../../../lib/utils/result.js';
import type { SettingsService } from '../../settings.service.js';
import { MemoryClientService } from '../memory-client.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSettingsService(settings: Record<string, string> = {}) {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key in settings) {
        return ok({ key, value: settings[key], updatedAt: '' });
      }
      return ok(null);
    }),
    getValue: vi.fn(),
  } as unknown as SettingsService;
}

function createMockPeer(id = 'peer-1'): Peer {
  return {
    id,
    message: vi.fn().mockReturnValue({ id: 'msg-1', content: 'hello' }),
    representation: vi.fn().mockResolvedValue('representation text'),
    conclusions: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Peer;
}

function createMockSession(id = 'session-1'): Session {
  return {
    id,
    addPeers: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryClientService', () => {
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: MemoryClientService;

  beforeEach(() => {
    // Clear call counts but keep mock implementations from vi.mock factory
    mockGetMetadata.mockClear().mockResolvedValue({});
    mockDeleteWorkspace.mockClear().mockResolvedValue(undefined);
    mockPeerFn.mockReset();
    mockSessionFn.mockReset();
    mockSessionsFn.mockReset();
    mockScheduleDream.mockClear().mockResolvedValue(undefined);
    mockFetch.mockReset();

    settingsService = createMockSettingsService();
    service = new MemoryClientService(settingsService as unknown as SettingsService);
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe('initialize', () => {
    it('sets available=false when memory.enabled is not "true"', async () => {
      settingsService = createMockSettingsService({ 'memory.enabled': 'false' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      const result = await service.initialize();

      expect(result.ok).toBe(true);
      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false when memory.enabled setting is missing', async () => {
      // Default mock returns null for any key
      const result = await service.initialize();

      expect(result.ok).toBe(true);
      expect(service.isAvailable()).toBe(false);
    });

    it('reads honcho URL from settings JSON', async () => {
      settingsService = createMockSettingsService({
        'memory.enabled': 'true',
        'memory.honcho': JSON.stringify({ url: 'http://honcho:9000', apiKey: 'key-123' }),
      });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      // Mock healthy ping
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '2.0' }),
      });

      await service.initialize();

      // Verify fetch was called with the URL from settings
      expect(mockFetch).toHaveBeenCalledWith(
        'http://honcho:9000/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('falls back to env vars HONCHO_URL and HONCHO_API_KEY', async () => {
      const originalUrl = process.env.HONCHO_URL;
      const originalKey = process.env.HONCHO_API_KEY;
      try {
        process.env.HONCHO_URL = 'http://env-honcho:7000';
        process.env.HONCHO_API_KEY = 'env-key-456';

        settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
        service = new MemoryClientService(settingsService as unknown as SettingsService);

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ status: 'ok', version: '2.0' }),
        });

        await service.initialize();

        // Should use env var URL for health check
        expect(mockFetch).toHaveBeenCalledWith(
          'http://env-honcho:7000/health',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      } finally {
        // Restore
        if (originalUrl === undefined) delete process.env.HONCHO_URL;
        else process.env.HONCHO_URL = originalUrl;
        if (originalKey === undefined) delete process.env.HONCHO_API_KEY;
        else process.env.HONCHO_API_KEY = originalKey;
      }
    });

    it('sets available=false when ping fails', async () => {
      settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      const result = await service.initialize();

      expect(result.ok).toBe(true); // Non-fatal
      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=true on successful initialization', async () => {
      settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '2.0' }),
      });

      const result = await service.initialize();

      expect(result.ok).toBe(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('returns ok on any failure (non-fatal — never throws)', async () => {
      settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      // Make fetch throw
      mockFetch.mockRejectedValue(new Error('network down'));

      const result = await service.initialize();

      expect(result.ok).toBe(true);
      expect(service.isAvailable()).toBe(false);
    });

    it('handles malformed honcho settings JSON gracefully', async () => {
      settingsService = createMockSettingsService({
        'memory.enabled': 'true',
        'memory.honcho': 'not valid json{{{',
      });
      service = new MemoryClientService(settingsService as unknown as SettingsService);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '2.0' }),
      });

      const result = await service.initialize();

      // Should still succeed using default URL
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8000/health', expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // ping
  // -------------------------------------------------------------------------

  describe('ping', () => {
    it('returns status and version on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', version: '1.5.0' }),
      });

      const result = await service.ping();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('healthy');
        expect(result.value.version).toBe('1.5.0');
      }
    });

    it('returns err when response is not ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await service.ping();

      expect(result.ok).toBe(false);
    });

    it('returns err when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.ping();

      expect(result.ok).toBe(false);
    });

    it('defaults status and version to "unknown" when missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.ping();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('unknown');
        expect(result.value.version).toBe('unknown');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Caching: getCodespaceClient / getPlatformClient
  // -------------------------------------------------------------------------

  describe('caching', () => {
    it('getCodespaceClient returns same Honcho instance for same codespaceId', () => {
      const first = service.getCodespaceClient('cs1');
      const second = service.getCodespaceClient('cs1');

      expect(first).toBe(second);
    });

    it('getCodespaceClient returns different instances for different codespaceIds', () => {
      const first = service.getCodespaceClient('cs1');
      const second = service.getCodespaceClient('cs2');

      expect(first).not.toBe(second);
    });

    it('getPlatformClient returns same instance on second call', () => {
      const first = service.getPlatformClient();
      const second = service.getPlatformClient();

      expect(first).toBe(second);
    });

    it('ensurePeer returns cached peer on second call (mock called only once)', async () => {
      const mockPeerObj = createMockPeer('peer-cached');
      mockPeerFn.mockResolvedValue(mockPeerObj);

      const client = service.getCodespaceClient('cs1');
      const first = await service.ensurePeer(client, 'agent-a1');
      const second = await service.ensurePeer(client, 'agent-a1');

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).toBe(second.value);
      }
      // peer() should only be called once due to caching
      expect(mockPeerFn).toHaveBeenCalledTimes(1);
    });

    it('ensurePeer creates separate cache entries per workspace', async () => {
      const peer1 = createMockPeer('peer-ws1');
      const peer2 = createMockPeer('peer-ws2');
      mockPeerFn.mockResolvedValueOnce(peer1).mockResolvedValueOnce(peer2);

      const client1 = service.getCodespaceClient('cs1');
      const client2 = service.getCodespaceClient('cs2');

      await service.ensurePeer(client1, 'agent-a1');
      await service.ensurePeer(client2, 'agent-a1');

      expect(mockPeerFn).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // handleConnectionError
  // -------------------------------------------------------------------------

  describe('handleConnectionError', () => {
    // We test handleConnectionError indirectly via methods that call it.
    // ensurePeer calls handleConnectionError when client.peer() throws.

    async function initializeService() {
      settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '2.0' }),
      });
      await service.initialize();
      expect(service.isAvailable()).toBe(true);
    }

    it('sets available=false on ConnectionError', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new MockConnectionError('conn lost'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false on TimeoutError', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new MockTimeoutError('timed out'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false on ECONNREFUSED message', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false on "fetch failed" message', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new Error('fetch failed'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false on "network" message', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new Error('network error'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(service.isAvailable()).toBe(false);
    });

    it('does NOT set available=false on generic Error', async () => {
      await initializeService();

      mockPeerFn.mockRejectedValue(new Error('some random error'));
      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      // Generic error should NOT mark service unavailable
      expect(service.isAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Conclusion operations
  // -------------------------------------------------------------------------

  describe('conclusion operations', () => {
    let peer: Peer;

    beforeEach(() => {
      peer = createMockPeer('peer-conc');
    });

    describe('createConclusion', () => {
      it('returns err when no results created', async () => {
        (peer.conclusions.create as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const result = await service.createConclusion(peer, 'some insight');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
        }
      });

      it('returns first result from array', async () => {
        const conclusion = {
          id: 'conc-1',
          content: 'lesson learned',
          observerId: 'peer-conc',
          observedId: 'observed-1',
          sessionId: 'sess-1',
          createdAt: '2026-01-01T00:00:00Z',
        };
        (peer.conclusions.create as ReturnType<typeof vi.fn>).mockResolvedValue([
          conclusion,
          { ...conclusion, id: 'conc-2' },
        ]);

        const result = await service.createConclusion(peer, 'lesson learned');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.id).toBe('conc-1');
          expect(result.value.content).toBe('lesson learned');
        }
      });

      it('passes content and sessionId to peer.conclusions.create', async () => {
        (peer.conclusions.create as ReturnType<typeof vi.fn>).mockResolvedValue([
          {
            id: 'c1',
            content: 'test',
            observerId: 'p1',
            observedId: 'o1',
            sessionId: 'sess-x',
            createdAt: '2026-01-01',
          },
        ]);

        await service.createConclusion(peer, 'test insight', 'sess-x');

        expect(peer.conclusions.create).toHaveBeenCalledWith({
          content: 'test insight',
          sessionId: 'sess-x',
        });
      });

      it('returns err when peer.conclusions.create throws', async () => {
        (peer.conclusions.create as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('create failed')
        );

        const result = await service.createConclusion(peer, 'test');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
        }
      });
    });

    describe('deleteConclusion', () => {
      it('delegates to peer.conclusions.delete', async () => {
        (peer.conclusions.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const result = await service.deleteConclusion(peer, 'conc-del-1');

        expect(result.ok).toBe(true);
        expect(peer.conclusions.delete).toHaveBeenCalledWith('conc-del-1');
      });

      it('returns err on deletion failure', async () => {
        (peer.conclusions.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('not found')
        );

        const result = await service.deleteConclusion(peer, 'conc-missing');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_NOT_FOUND');
        }
      });
    });

    describe('listConclusions', () => {
      it('maps results via toMemoryConclusion', async () => {
        const items = [
          {
            id: 'c1',
            content: 'insight A',
            observerId: 'peer-1',
            observedId: 'obs-1',
            sessionId: 'sess-1',
            createdAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'c2',
            content: 'insight B',
            observerId: 'peer-1',
            observedId: 'obs-2',
            sessionId: null,
            createdAt: '2026-01-02T00:00:00Z',
          },
        ];
        (peer.conclusions.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items });

        const result = await service.listConclusions(peer);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(2);
          expect(result.value[0].id).toBe('c1');
          expect(result.value[0].content).toBe('insight A');
          expect(result.value[1].id).toBe('c2');
          expect(result.value[1].sessionId).toBeNull();
        }
      });

      it('passes pagination options to peer.conclusions.list', async () => {
        (peer.conclusions.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });

        await service.listConclusions(peer, { page: 3, size: 25 });

        expect(peer.conclusions.list).toHaveBeenCalledWith({
          page: 3,
          size: 25,
          session: undefined,
        });
      });

      it('uses default page=1 and size=50', async () => {
        (peer.conclusions.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });

        await service.listConclusions(peer);

        expect(peer.conclusions.list).toHaveBeenCalledWith({
          page: 1,
          size: 50,
          session: undefined,
        });
      });

      it('returns err on list failure', async () => {
        (peer.conclusions.list as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('list failed')
        );

        const result = await service.listConclusions(peer);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
        }
      });
    });

    describe('queryConclusions', () => {
      it('performs semantic search with topK', async () => {
        const items = [
          {
            id: 'c1',
            content: 'relevant insight',
            observerId: 'p1',
            observedId: 'o1',
            sessionId: 's1',
            createdAt: '2026-01-01',
          },
        ];
        (peer.conclusions.query as ReturnType<typeof vi.fn>).mockResolvedValue(items);

        const result = await service.queryConclusions(peer, 'search query', 5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toHaveLength(1);
          expect(result.value[0].content).toBe('relevant insight');
        }
        expect(peer.conclusions.query).toHaveBeenCalledWith('search query', 5);
      });

      it('defaults topK to 10', async () => {
        (peer.conclusions.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        await service.queryConclusions(peer, 'query text');

        expect(peer.conclusions.query).toHaveBeenCalledWith('query text', 10);
      });

      it('returns err on query failure', async () => {
        (peer.conclusions.query as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('query failed')
        );

        const result = await service.queryConclusions(peer, 'test');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  describe('session operations', () => {
    describe('createSession', () => {
      it('creates and caches the session', async () => {
        const mockSession = createMockSession('sess-new');
        mockSessionFn.mockResolvedValue(mockSession);

        const client = service.getCodespaceClient('cs1');
        const agentPeer = createMockPeer('agent-peer');
        const userPeer = createMockPeer('user-peer');

        const result = await service.createSession(client, 'sess-new', agentPeer, userPeer, {
          taskId: 't1',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.workspaceId).toBe('codespace-cs1');
          expect(result.value.sessionId).toBe('sess-new');
          expect(result.value.agentPeerId).toBe('agent-peer');
          expect(result.value.userPeerId).toBe('user-peer');
        }
        expect(mockSessionFn).toHaveBeenCalledWith('sess-new', { metadata: { taskId: 't1' } });
        expect(mockSession.addPeers).toHaveBeenCalledWith([agentPeer, userPeer]);
      });

      it('returns err on session creation failure', async () => {
        mockSessionFn.mockRejectedValue(new Error('session failed'));

        const client = service.getCodespaceClient('cs1');
        const result = await service.createSession(
          client,
          'sess-fail',
          createMockPeer('a'),
          createMockPeer('u'),
          {}
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
        }
      });
    });

    describe('addMessage', () => {
      it('uses cached session (no extra client.session() call)', async () => {
        const mockSession = createMockSession('sess-msg');
        mockSessionFn.mockResolvedValue(mockSession);

        const client = service.getCodespaceClient('cs1');
        const agentPeer = createMockPeer('agent-peer');
        const userPeer = createMockPeer('user-peer');

        // First create the session to populate the cache
        await service.createSession(client, 'sess-msg', agentPeer, userPeer, {});

        // Reset to track subsequent calls
        mockSessionFn.mockClear();
        mockPeerFn.mockResolvedValue(agentPeer);

        const ref = {
          workspaceId: 'codespace-cs1',
          sessionId: 'sess-msg',
          agentPeerId: 'agent-peer',
          userPeerId: 'user-peer',
        };

        await service.addMessage(client, ref, 'agent-peer', 'Hello world');

        // session() should NOT be called again since session was cached
        expect(mockSessionFn).not.toHaveBeenCalled();
        expect(mockSession.addMessages).toHaveBeenCalled();
      });

      it('fetches session if not cached', async () => {
        const mockSession = createMockSession('sess-uncached');
        mockSessionFn.mockResolvedValue(mockSession);

        const mockPeerObj = createMockPeer('agent-p');
        mockPeerFn.mockResolvedValue(mockPeerObj);

        const client = service.getCodespaceClient('cs1');
        const ref = {
          workspaceId: 'codespace-cs1',
          sessionId: 'sess-uncached',
          agentPeerId: 'agent-p',
          userPeerId: 'user-p',
        };

        await service.addMessage(client, ref, 'agent-p', 'Hello');

        // session() should be called since not in cache
        expect(mockSessionFn).toHaveBeenCalledWith('sess-uncached');
      });

      it('returns err on message failure', async () => {
        const mockSession = createMockSession('sess-err');
        mockSession.addMessages = vi.fn().mockRejectedValue(new Error('msg failed'));
        mockSessionFn.mockResolvedValue(mockSession);

        const mockPeerObj = createMockPeer('agent-p');
        mockPeerFn.mockResolvedValue(mockPeerObj);

        const client = service.getCodespaceClient('cs1');
        const ref = {
          workspaceId: 'codespace-cs1',
          sessionId: 'sess-err',
          agentPeerId: 'agent-p',
          userPeerId: 'user-p',
        };

        const result = await service.addMessage(client, ref, 'agent-p', 'test');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
        }
      });
    });

    describe('finalizeSession', () => {
      it('calls scheduleDream with observer and session', async () => {
        const client = service.getCodespaceClient('cs1');
        const ref = {
          workspaceId: 'codespace-cs1',
          sessionId: 'sess-fin',
          agentPeerId: 'agent-peer',
          userPeerId: 'user-peer',
        };

        const result = await service.finalizeSession(client, ref);

        expect(result.ok).toBe(true);
        expect(mockScheduleDream).toHaveBeenCalledWith({
          observer: 'agent-peer',
          session: 'sess-fin',
        });
      });

      it('returns err on finalization failure', async () => {
        mockScheduleDream.mockRejectedValue(new Error('dream failed'));

        const client = service.getCodespaceClient('cs1');
        const ref = {
          workspaceId: 'codespace-cs1',
          sessionId: 'sess-fail',
          agentPeerId: 'ap',
          userPeerId: 'up',
        };

        const result = await service.finalizeSession(client, ref);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // getRepresentation
  // -------------------------------------------------------------------------

  describe('getRepresentation', () => {
    it('returns representation text from peer', async () => {
      const peer = createMockPeer('rep-peer');
      (peer.representation as ReturnType<typeof vi.fn>).mockResolvedValue('summary of knowledge');

      const result = await service.getRepresentation(peer, {
        searchQuery: 'test',
        maxConclusions: 10,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('summary of knowledge');
      }
      expect(peer.representation).toHaveBeenCalledWith({
        searchQuery: 'test',
        maxConclusions: 10,
      });
    });

    it('defaults maxConclusions to 20', async () => {
      const peer = createMockPeer('rep-peer');
      (peer.representation as ReturnType<typeof vi.fn>).mockResolvedValue('text');

      await service.getRepresentation(peer);

      expect(peer.representation).toHaveBeenCalledWith({
        searchQuery: undefined,
        maxConclusions: 20,
      });
    });

    it('returns err on representation failure', async () => {
      const peer = createMockPeer('rep-peer');
      (peer.representation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rep failed'));

      const result = await service.getRepresentation(peer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns session items from the client', async () => {
      const sessions = [
        { id: 's1', metadata: {} },
        { id: 's2', metadata: { taskId: 't1' } },
      ];
      mockSessionsFn.mockResolvedValue({ items: sessions });

      const client = service.getCodespaceClient('cs1');
      const result = await service.listSessions(client);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].id).toBe('s1');
      }
    });

    it('returns err on list failure', async () => {
      mockSessionsFn.mockRejectedValue(new Error('sessions failed'));

      const client = service.getCodespaceClient('cs1');
      const result = await service.listSessions(client);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // deleteWorkspace
  // -------------------------------------------------------------------------

  describe('deleteWorkspace', () => {
    it('removes cached clients and peers for that workspace', async () => {
      // First populate caches
      const mockPeerObj = createMockPeer('del-peer');
      mockPeerFn.mockResolvedValue(mockPeerObj);

      const client = service.getCodespaceClient('cs-to-delete');
      await service.ensurePeer(client, 'agent-a1');

      // Verify caching works
      const sameClient = service.getCodespaceClient('cs-to-delete');
      expect(sameClient).toBe(client);

      // Delete workspace
      const result = await service.deleteWorkspace('codespace-cs-to-delete');

      expect(result.ok).toBe(true);
      expect(mockDeleteWorkspace).toHaveBeenCalledWith('codespace-cs-to-delete');

      // After deletion, getting the client should create a new instance
      const newClient = service.getCodespaceClient('cs-to-delete');
      expect(newClient).not.toBe(client);
    });

    it('returns err on deletion failure', async () => {
      mockDeleteWorkspace.mockRejectedValue(new Error('delete workspace failed'));

      const result = await service.deleteWorkspace('codespace-cs-fail');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns false by default', () => {
      expect(service.isAvailable()).toBe(false);
    });

    it('returns true after successful initialization', async () => {
      settingsService = createMockSettingsService({ 'memory.enabled': 'true' });
      service = new MemoryClientService(settingsService as unknown as SettingsService);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '2.0' }),
      });

      await service.initialize();

      expect(service.isAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ensurePeer
  // -------------------------------------------------------------------------

  describe('ensurePeer', () => {
    it('passes metadata to client.peer()', async () => {
      const mockPeerObj = createMockPeer('meta-peer');
      mockPeerFn.mockResolvedValue(mockPeerObj);

      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1', { role: 'planner' });

      expect(mockPeerFn).toHaveBeenCalledWith('agent-a1', { metadata: { role: 'planner' } });
    });

    it('does not pass metadata when undefined', async () => {
      const mockPeerObj = createMockPeer('no-meta-peer');
      mockPeerFn.mockResolvedValue(mockPeerObj);

      const client = service.getCodespaceClient('cs1');
      await service.ensurePeer(client, 'agent-a1');

      expect(mockPeerFn).toHaveBeenCalledWith('agent-a1', undefined);
    });

    it('returns err when client.peer() throws', async () => {
      mockPeerFn.mockRejectedValue(new Error('peer creation failed'));

      const client = service.getCodespaceClient('cs1');
      const result = await service.ensurePeer(client, 'agent-a1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
    });
  });
});
