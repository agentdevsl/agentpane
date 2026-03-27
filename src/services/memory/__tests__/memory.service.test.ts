// @ts-nocheck — test mocks use loose types
import { describe, expect, it, vi } from 'vitest';
import { MemoryErrors } from '../../../lib/errors/memory-errors.js';
import { err, ok } from '../../../lib/utils/result.js';
import type { SettingsService } from '../../settings.service.js';
import type { InsightDeriverInterface, MemoryStoreInterface } from '../memory.service.js';
import { MemoryService } from '../memory.service.js';
import type { Insight, MemoryContext, MemoryMessage } from '../types.js';
import { EMPTY_CONTEXT } from '../types.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const mockInsight: Insight = {
  id: 'ins-1',
  codespaceId: 'cs-1',
  content: 'Always use Result types',
  source: 'manual',
  sourceSessionId: null,
  skillId: null,
  tags: [],
  metadata: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockMessage: MemoryMessage = {
  id: 'msg-1',
  codespaceId: 'cs-1',
  memorySessionId: 'msess-1',
  agentId: 'agent-1',
  taskId: 'task-1',
  role: 'assistant',
  content: 'Analyzing the codebase...',
  turnNumber: 1,
  metadata: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockContext: MemoryContext = {
  text: '## Memory Context\n\n### Codebase Insights\n- Use Result types\n',
  tokenCount: 15,
  sources: { insights: 1 },
};

function createMockStore(): MemoryStoreInterface {
  return {
    insertInsight: vi.fn().mockResolvedValue(ok(mockInsight)),
    getInsights: vi.fn().mockResolvedValue(ok([mockInsight])),
    deleteInsight: vi.fn().mockResolvedValue(ok(undefined)),
    searchInsights: vi.fn().mockResolvedValue(ok([mockInsight])),
    assembleContext: vi.fn().mockResolvedValue(ok(mockContext)),
    insertMessage: vi.fn().mockResolvedValue(ok(mockMessage)),
    getMessages: vi.fn().mockResolvedValue(ok([mockMessage])),
    getInsightCount: vi.fn().mockResolvedValue(ok(5)),
    getMessageCount: vi.fn().mockResolvedValue(ok(10)),
  };
}

function createMockDeriver(): InsightDeriverInterface {
  return {
    deriveInsights: vi.fn().mockResolvedValue(ok({ insightsCreated: 3 })),
  };
}

function createMockSettingsService(enabled = true): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'memory.enabled') {
        return ok({ key, value: JSON.stringify(enabled), updatedAt: '' });
      }
      return ok(null);
    }),
    getValue: vi.fn(),
  } as unknown as SettingsService;
}

// Helper to wire up a MemoryService with injectable sub-services
function createTestService(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const settings = createMockSettingsService(enabled);
  const store = createMockStore();
  const deriver = createMockDeriver();

  // Create the service then inject mocks
  const service = new MemoryService(settings, {} as never);
  // Replace internal sub-services with mocks
  (service as any).store = store;
  (service as any).deriver = deriver;

  return { service, store, deriver, settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryService', () => {
  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe('initialize()', () => {
    it('sets available=true when memory.enabled setting is true', async () => {
      const { service } = createTestService({ enabled: true });
      await service.initialize();
      expect(service.isAvailable()).toBe(true);
    });

    it('sets available=false when memory.enabled setting is false', async () => {
      const { service } = createTestService({ enabled: false });
      await service.initialize();
      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false when settings.get returns null', async () => {
      const settings = {
        get: vi.fn().mockResolvedValue(ok(null)),
      } as unknown as SettingsService;

      const service = new MemoryService(settings, {} as never);
      await service.initialize();
      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false when settings.get returns err result', async () => {
      const settings = {
        get: vi
          .fn()
          .mockResolvedValue(err({ code: 'NOT_FOUND', message: 'not found', status: 404 })),
      } as unknown as SettingsService;

      const service = new MemoryService(settings, {} as never);
      await service.initialize();
      expect(service.isAvailable()).toBe(false);
    });

    it('sets available=false when settings.get throws', async () => {
      const settings = {
        get: vi.fn().mockRejectedValue(new Error('db error')),
      } as unknown as SettingsService;

      const service = new MemoryService(settings, {} as never);
      await service.initialize();
      expect(service.isAvailable()).toBe(false);
    });

    it('handles string "true" value without JSON.parse', async () => {
      const settings = {
        get: vi.fn().mockResolvedValue(ok({ key: 'memory.enabled', value: 'true', updatedAt: '' })),
      } as unknown as SettingsService;

      const service = new MemoryService(settings, {} as never);
      await service.initialize();
      expect(service.isAvailable()).toBe(true);
    });

    it('handles non-boolean JSON values as false', async () => {
      const settings = {
        get: vi
          .fn()
          .mockResolvedValue(ok({ key: 'memory.enabled', value: '"yes"', updatedAt: '' })),
      } as unknown as SettingsService;

      const service = new MemoryService(settings, {} as never);
      await service.initialize();
      expect(service.isAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe('isAvailable()', () => {
    it('returns false before initialization', () => {
      const { service } = createTestService();
      expect(service.isAvailable()).toBe(false);
    });

    it('returns true after successful initialization with enabled=true', async () => {
      const { service } = createTestService({ enabled: true });
      await service.initialize();
      expect(service.isAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getContext
  // -------------------------------------------------------------------------

  describe('getContext()', () => {
    it('returns EMPTY_CONTEXT when not available', async () => {
      const { service } = createTestService({ enabled: false });
      const result = await service.getContext('cs-1', 'test query');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(EMPTY_CONTEXT);
      }
    });

    it('delegates to store.assembleContext when available', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const result = await service.getContext('cs-1', 'test query');

      expect(store.assembleContext).toHaveBeenCalledWith('cs-1', 'test query');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(mockContext);
      }
    });

    it('returns EMPTY_CONTEXT on error (fire-and-forget)', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;
      (store.assembleContext as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('DB failure')
      );

      const result = await service.getContext('cs-1', 'test query');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(EMPTY_CONTEXT);
      }
    });
  });

  // -------------------------------------------------------------------------
  // startSession
  // -------------------------------------------------------------------------

  describe('startSession()', () => {
    it('returns null when not available', async () => {
      const { service } = createTestService();
      const ref = await service.startSession({
        codespaceId: 'cs-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });
      expect(ref).toBeNull();
    });

    it('returns MemorySessionRef with generated ID when available', async () => {
      const { service } = createTestService();
      (service as any).available = true;

      const ref = await service.startSession({
        codespaceId: 'cs-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });

      expect(ref).not.toBeNull();
      expect(ref!.memorySessionId).toBeDefined();
      expect(ref!.memorySessionId.length).toBeGreaterThan(0);
      expect(ref!.codespaceId).toBe('cs-1');
      expect(ref!.agentId).toBe('agent-1');
      expect(ref!.taskId).toBe('task-1');
    });

    it('generates unique session IDs', async () => {
      const { service } = createTestService();
      (service as any).available = true;

      const ref1 = await service.startSession({
        codespaceId: 'cs-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });
      const ref2 = await service.startSession({
        codespaceId: 'cs-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });

      expect(ref1!.memorySessionId).not.toBe(ref2!.memorySessionId);
    });
  });

  // -------------------------------------------------------------------------
  // captureMessage
  // -------------------------------------------------------------------------

  describe('captureMessage()', () => {
    const ref = {
      memorySessionId: 'msess-1',
      codespaceId: 'cs-1',
      agentId: 'agent-1',
      taskId: 'task-1',
    };

    it('does nothing when not available', async () => {
      const { service, store } = createTestService();
      await service.captureMessage(ref, {
        role: 'assistant',
        content: 'hello',
        turnNumber: 1,
      });
      expect(store.insertMessage).not.toHaveBeenCalled();
    });

    it('delegates to store.insertMessage when available', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      await service.captureMessage(ref, {
        role: 'assistant',
        content: 'Analyzing code...',
        turnNumber: 1,
        metadata: { model: 'claude-sonnet-4-6' },
      });

      expect(store.insertMessage).toHaveBeenCalledWith({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Analyzing code...',
        turnNumber: 1,
        metadata: { model: 'claude-sonnet-4-6' },
      });
    });

    it('swallows errors (fire-and-forget)', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;
      (store.insertMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Insert failed')
      );

      // Should not throw
      await expect(
        service.captureMessage(ref, {
          role: 'user',
          content: 'test',
          turnNumber: 1,
        })
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // finalizeSession
  // -------------------------------------------------------------------------

  describe('finalizeSession()', () => {
    const ref = {
      memorySessionId: 'msess-1',
      codespaceId: 'cs-1',
      agentId: 'agent-1',
      taskId: 'task-1',
    };

    it('does nothing when not available', async () => {
      const { service, deriver } = createTestService();
      await service.finalizeSession(ref);
      expect(deriver.deriveInsights).not.toHaveBeenCalled();
    });

    it('triggers insight derivation when available', async () => {
      const { service, deriver } = createTestService();
      (service as any).available = true;

      await service.finalizeSession(ref);

      expect(deriver.deriveInsights).toHaveBeenCalledWith('msess-1', 'cs-1');
    });

    it('swallows derivation errors', async () => {
      const { service, deriver } = createTestService();
      (service as any).available = true;
      (deriver.deriveInsights as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Claude API error')
      );

      await expect(service.finalizeSession(ref)).resolves.toBeUndefined();
    });

    it('handles deriver returning err result (logs but does not throw)', async () => {
      const { service, deriver } = createTestService();
      (service as any).available = true;
      (deriver.deriveInsights as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(MemoryErrors.DERIVATION_ERROR('Claude timeout'))
      );

      await expect(service.finalizeSession(ref)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getInsights (admin)
  // -------------------------------------------------------------------------

  describe('getInsights()', () => {
    it('returns empty array when not available', async () => {
      const { service } = createTestService();
      const result = await service.getInsights('cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('delegates to store.getInsights when available', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const result = await service.getInsights('cs-1', { page: 2, size: 10 });

      expect(store.getInsights).toHaveBeenCalledWith('cs-1', { page: 2, size: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([mockInsight]);
      }
    });

    it('propagates errors from store', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(MemoryErrors.QUERY_ERROR('DB error'))
      );

      const result = await service.getInsights('cs-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // createInsight (admin)
  // -------------------------------------------------------------------------

  describe('createInsight()', () => {
    it('returns UNAVAILABLE error when not available', async () => {
      const { service } = createTestService();
      const result = await service.createInsight('cs-1', 'some insight');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_UNAVAILABLE');
      }
    });

    it('delegates to store.insertInsight when available', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const result = await service.createInsight('cs-1', 'Use Result types', 'manual', {
        author: 'user-1',
      });

      expect(store.insertInsight).toHaveBeenCalledWith({
        codespaceId: 'cs-1',
        content: 'Use Result types',
        source: 'manual',
        metadata: { author: 'user-1' },
      });
      expect(result.ok).toBe(true);
    });

    it('defaults source to manual', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      await service.createInsight('cs-1', 'insight content');

      expect(store.insertInsight).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'manual' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // deleteInsight (admin)
  // -------------------------------------------------------------------------

  describe('deleteInsight()', () => {
    it('returns UNAVAILABLE error when not available', async () => {
      const { service } = createTestService();
      const result = await service.deleteInsight('ins-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_UNAVAILABLE');
      }
    });

    it('delegates to store.deleteInsight when available', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const result = await service.deleteInsight('ins-1');

      expect(store.deleteInsight).toHaveBeenCalledWith('ins-1');
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // search (admin)
  // -------------------------------------------------------------------------

  describe('search()', () => {
    it('returns empty array when not available', async () => {
      const { service } = createTestService();
      const result = await service.search('cs-1', 'drizzle');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('delegates to store.searchInsights and maps to SearchResult', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const result = await service.search('cs-1', 'Result types', 10);

      expect(store.searchInsights).toHaveBeenCalledWith('cs-1', 'Result types', 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe('ins-1');
        expect(result.value[0].type).toBe('insight');
        expect(result.value[0].content).toBe('Always use Result types');
      }
    });

    it('includes skillId and createdAt in SearchResult', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;

      const insightWithSkill: Insight = {
        ...mockInsight,
        skillId: 'skill-deploy',
      };
      (store.searchInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([insightWithSkill]));

      const result = await service.search('cs-1', 'deploy');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0].skillId).toBe('skill-deploy');
        expect(result.value[0].createdAt).toBe('2026-01-01T00:00:00Z');
      }
    });

    it('propagates errors from store', async () => {
      const { service, store } = createTestService();
      (service as any).available = true;
      (store.searchInsights as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(MemoryErrors.QUERY_ERROR('Search failed'))
      );

      const result = await service.search('cs-1', 'query');
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------

  describe('healthCheck()', () => {
    it('returns unavailable health when not available', async () => {
      const { service } = createTestService();
      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available).toBe(false);
        expect(result.value.insightCount).toBe(0);
        expect(result.value.messageCount).toBe(0);
      }
    });

    it('returns available health when available', async () => {
      const { service } = createTestService();
      (service as any).available = true;

      const result = await service.healthCheck();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available).toBe(true);
      }
    });
  });
});
