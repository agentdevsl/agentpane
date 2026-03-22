// @ts-nocheck — test assertions use array indexing that TS flags as possibly undefined
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdminService } from '../memory-admin.service.js';
import type { MemoryClientService } from '../memory-client.service.js';

// ── Mock Client Service ──

function createMockClientService() {
  return {
    getCodespaceClient: vi.fn().mockReturnValue({ workspaceId: 'codespace-cs-1' }),
    ensurePeer: vi.fn(),
    listConclusions: vi.fn(),
    createConclusion: vi.fn(),
    deleteConclusion: vi.fn(),
    queryConclusions: vi.fn(),
    listSessions: vi.fn(),
  };
}

// ── Test Data ──

const mockPeer = { id: 'peer-1', conclusions: {} };

const mockConclusion = {
  id: 'conc-1',
  content: 'Always use Drizzle for DB queries',
  observerId: 'agent-default',
  observedId: 'user-default',
  sessionId: 'sess-1',
  createdAt: '2026-01-01T00:00:00Z',
};

const mockConclusion2 = {
  id: 'conc-2',
  content: 'Prefer TypeScript strict mode',
  observerId: 'agent-default',
  observedId: 'user-default',
  sessionId: null,
  createdAt: '2026-01-02T00:00:00Z',
};

const peerError = {
  ok: false as const,
  error: {
    code: 'MEMORY_WORKSPACE_ERROR',
    message: 'Failed to ensure peer agent:default: connection lost',
    status: 500,
  },
};

// ── Tests ──

describe('MemoryAdminService', () => {
  let client: ReturnType<typeof createMockClientService>;
  let admin: MemoryAdminService;

  beforeEach(() => {
    client = createMockClientService();
    admin = new MemoryAdminService(client as unknown as MemoryClientService);
    vi.clearAllMocks();
  });

  // ── getConclusions ──

  describe('getConclusions', () => {
    it('delegates to client with codespace client and default peer', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.listConclusions.mockResolvedValue({
        ok: true,
        value: [mockConclusion, mockConclusion2],
      });

      const result = await admin.getConclusions('cs-1', { page: 1, size: 10 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]?.id).toBe('conc-1');
        expect(result.value[1]?.id).toBe('conc-2');
      }

      expect(client.getCodespaceClient).toHaveBeenCalledWith('cs-1');
      expect(client.ensurePeer).toHaveBeenCalledWith(
        { workspaceId: 'codespace-cs-1' },
        'agent-default'
      );
      expect(client.listConclusions).toHaveBeenCalledWith(mockPeer, { page: 1, size: 10 });
    });

    it('returns err when ensurePeer fails', async () => {
      client.ensurePeer.mockResolvedValue(peerError);

      const result = await admin.getConclusions('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      expect(client.listConclusions).not.toHaveBeenCalled();
    });
  });

  // ── createConclusion ──

  describe('createConclusion', () => {
    it('creates via client and returns result', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.createConclusion.mockResolvedValue({ ok: true, value: mockConclusion });

      const result = await admin.createConclusion('cs-1', 'Always use Drizzle for DB queries');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('conc-1');
        expect(result.value.content).toBe('Always use Drizzle for DB queries');
      }

      expect(client.getCodespaceClient).toHaveBeenCalledWith('cs-1');
      expect(client.ensurePeer).toHaveBeenCalledWith(
        { workspaceId: 'codespace-cs-1' },
        'agent-default'
      );
      expect(client.createConclusion).toHaveBeenCalledWith(
        mockPeer,
        'Always use Drizzle for DB queries'
      );
    });

    it('returns err when ensurePeer fails', async () => {
      client.ensurePeer.mockResolvedValue(peerError);

      const result = await admin.createConclusion('cs-1', 'some content');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      expect(client.createConclusion).not.toHaveBeenCalled();
    });
  });

  // ── deleteConclusion ──

  describe('deleteConclusion', () => {
    it('deletes via client', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.deleteConclusion.mockResolvedValue({ ok: true, value: undefined });

      const result = await admin.deleteConclusion('cs-1', 'conc-1');

      expect(result.ok).toBe(true);
      expect(client.deleteConclusion).toHaveBeenCalledWith(mockPeer, 'conc-1');
    });

    it('returns err when ensurePeer fails', async () => {
      client.ensurePeer.mockResolvedValue(peerError);

      const result = await admin.deleteConclusion('cs-1', 'conc-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      expect(client.deleteConclusion).not.toHaveBeenCalled();
    });
  });

  // ── getSessions ──

  describe('getSessions', () => {
    it('maps Honcho Sessions to MemorySession (id, metadata)', async () => {
      const honchoSessions = [
        { id: 'sess-1', metadata: { phase: 'planning' } },
        { id: 'sess-2', metadata: { phase: 'execution', taskId: 'task-1' } },
      ];
      client.listSessions.mockResolvedValue({ ok: true, value: honchoSessions });

      const result = await admin.getSessions('cs-1', { page: 1, size: 25 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]).toEqual({ id: 'sess-1', metadata: { phase: 'planning' } });
        expect(result.value[1]).toEqual({
          id: 'sess-2',
          metadata: { phase: 'execution', taskId: 'task-1' },
        });
      }

      expect(client.getCodespaceClient).toHaveBeenCalledWith('cs-1');
      expect(client.listSessions).toHaveBeenCalledWith({ workspaceId: 'codespace-cs-1' });
    });

    it('handles sessions with null metadata', async () => {
      const honchoSessions = [{ id: 'sess-3', metadata: null }];
      client.listSessions.mockResolvedValue({ ok: true, value: honchoSessions });

      const result = await admin.getSessions('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0]).toEqual({ id: 'sess-3', metadata: {} });
      }
    });

    it('returns err when listSessions fails', async () => {
      client.listSessions.mockResolvedValue({
        ok: false,
        error: {
          code: 'MEMORY_QUERY_ERROR',
          message: 'Failed to list sessions: timeout',
          status: 500,
        },
      });

      const result = await admin.getSessions('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // ── search ──

  describe('search', () => {
    it('maps conclusions to SearchResult with type:"conclusion"', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.queryConclusions.mockResolvedValue({
        ok: true,
        value: [mockConclusion],
      });

      const result = await admin.search('cs-1', 'drizzle database');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]).toEqual({
          id: 'conc-1',
          content: 'Always use Drizzle for DB queries',
          type: 'conclusion',
          observerId: 'agent-default',
          observedId: 'user-default',
          sessionId: 'sess-1',
          createdAt: '2026-01-01T00:00:00Z',
        });
      }
    });

    it('passes limit option to queryConclusions', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.queryConclusions.mockResolvedValue({ ok: true, value: [] });

      await admin.search('cs-1', 'typescript', { limit: 5 });

      expect(client.queryConclusions).toHaveBeenCalledWith(mockPeer, 'typescript', 5);
    });

    it('passes undefined limit when not provided', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.queryConclusions.mockResolvedValue({ ok: true, value: [] });

      await admin.search('cs-1', 'typescript');

      expect(client.queryConclusions).toHaveBeenCalledWith(mockPeer, 'typescript', undefined);
    });

    it('returns err when ensurePeer fails', async () => {
      client.ensurePeer.mockResolvedValue(peerError);

      const result = await admin.search('cs-1', 'some query');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      expect(client.queryConclusions).not.toHaveBeenCalled();
    });

    it('returns err when queryConclusions fails', async () => {
      client.ensurePeer.mockResolvedValue({ ok: true, value: mockPeer });
      client.queryConclusions.mockResolvedValue({
        ok: false,
        error: {
          code: 'MEMORY_QUERY_ERROR',
          message: 'Failed to query conclusions: internal error',
          status: 500,
        },
      });

      const result = await admin.search('cs-1', 'failing query');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });
});
