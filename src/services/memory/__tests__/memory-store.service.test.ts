// @ts-nocheck — test mocks use loose types
import { describe, expect, it, vi } from 'vitest';
import { MemoryStoreService } from '../memory-store.service.js';

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

function createMockRow(overrides?: Record<string, unknown>) {
  return {
    id: 'ins-1',
    codespaceId: 'cs-1',
    content: 'Use Drizzle ORM for queries',
    source: 'manual',
    sourceSessionId: null,
    skillId: null,
    tags: [],
    metadata: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockMessageRow(overrides?: Record<string, unknown>) {
  return {
    id: 'msg-1',
    codespaceId: 'cs-1',
    memorySessionId: 'msess-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    role: 'assistant',
    content: 'Analyzing the code...',
    turnNumber: 1,
    metadata: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Creates a mock database object that mimics the Drizzle query builder chain.
 */
function createMockDb(opts?: {
  selectResult?: unknown[];
  insertError?: Error;
  deleteResult?: unknown[];
  countResult?: number;
}) {
  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnValue(opts?.deleteResult ?? [{ id: 'ins-1' }]),
  };

  // select() returns a chainable that eventually resolves
  // We wrap in a real Promise so `await db.select()...` works without a `then` property
  const selectResult = opts?.selectResult ?? [createMockRow()];
  const selectChain = Object.assign(Promise.resolve(selectResult), chainable);

  const insertChain = {
    values: vi.fn().mockImplementation(() => {
      if (opts?.insertError) throw opts.insertError;
      return Promise.resolve();
    }),
  };

  const deleteResult = opts?.deleteResult ?? [{ id: 'ins-1' }];
  const deleteChain = Object.assign(Promise.resolve(deleteResult), chainable);

  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    delete: vi.fn().mockReturnValue(deleteChain),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryStoreService', () => {
  // -------------------------------------------------------------------------
  // insertInsight
  // -------------------------------------------------------------------------

  describe('insertInsight()', () => {
    it('inserts with cuid2 ID and returns Insight', async () => {
      const db = createMockDb();
      const service = new MemoryStoreService(db as never);

      const result = await service.insertInsight({
        codespaceId: 'cs-1',
        content: 'Use Result types',
        source: 'manual',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeDefined();
        expect(result.value.id.length).toBeGreaterThan(0);
        expect(result.value.codespaceId).toBe('cs-1');
        expect(result.value.content).toBe('Use Result types');
        expect(result.value.source).toBe('manual');
        expect(result.value.createdAt).toBeDefined();
      }
      expect(db.insert).toHaveBeenCalled();
    });

    it('passes optional fields through', async () => {
      const db = createMockDb();
      const service = new MemoryStoreService(db as never);

      const result = await service.insertInsight({
        codespaceId: 'cs-1',
        content: 'Insight with extras',
        source: 'agent_derived',
        sourceSessionId: 'sess-42',
        skillId: 'skill-deploy',
        tags: ['infra', 'deploy'],
        metadata: { model: 'claude-sonnet-4-6' },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sourceSessionId).toBe('sess-42');
        expect(result.value.skillId).toBe('skill-deploy');
        expect(result.value.tags).toEqual(['infra', 'deploy']);
        expect(result.value.metadata).toEqual({ model: 'claude-sonnet-4-6' });
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb({ insertError: new Error('UNIQUE constraint') });
      const service = new MemoryStoreService(db as never);

      const result = await service.insertInsight({
        codespaceId: 'cs-1',
        content: 'test',
        source: 'manual',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
      }
    });

    it('defaults optional fields to null/empty when not provided', async () => {
      const db = createMockDb();
      const service = new MemoryStoreService(db as never);

      const result = await service.insertInsight({
        codespaceId: 'cs-1',
        content: 'minimal insight',
        source: 'manual',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sourceSessionId).toBeNull();
        expect(result.value.skillId).toBeNull();
        expect(result.value.tags).toEqual([]);
        expect(result.value.metadata).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // getInsights
  // -------------------------------------------------------------------------

  describe('getInsights()', () => {
    it('returns paginated insights for codespace', async () => {
      const rows = [createMockRow(), createMockRow({ id: 'ins-2', content: 'Second insight' })];
      const db = createMockDb({ selectResult: rows });
      const service = new MemoryStoreService(db as never);

      const result = await service.getInsights('cs-1', { page: 1, size: 50 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].codespaceId).toBe('cs-1');
      }
    });

    it('defaults to page=1 size=50 when options not provided', async () => {
      const db = createMockDb({ selectResult: [] });
      const service = new MemoryStoreService(db as never);

      const result = await service.getInsights('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockRejectedValue(new Error('DB unavailable')),
                }),
              }),
            }),
          }),
        }),
      };
      const service = new MemoryStoreService(db as never);

      const result = await service.getInsights('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // deleteInsight
  // -------------------------------------------------------------------------

  describe('deleteInsight()', () => {
    it('deletes by ID and returns ok', async () => {
      const db = createMockDb({ deleteResult: [{ id: 'ins-1' }] });
      const service = new MemoryStoreService(db as never);

      const result = await service.deleteInsight('ins-1');

      expect(result.ok).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when no rows deleted', async () => {
      const db = createMockDb({ deleteResult: [] });
      const service = new MemoryStoreService(db as never);

      const result = await service.deleteInsight('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_NOT_FOUND');
      }
    });
  });

  // -------------------------------------------------------------------------
  // searchInsights
  // -------------------------------------------------------------------------

  describe('searchInsights()', () => {
    it('performs LIKE query on content', async () => {
      const rows = [createMockRow({ content: 'Use Drizzle ORM' })];
      const db = createMockDb({ selectResult: rows });
      const service = new MemoryStoreService(db as never);

      const result = await service.searchInsights('cs-1', 'Drizzle');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].content).toContain('Drizzle');
      }
    });

    it('defaults limit to 20', async () => {
      const db = createMockDb({ selectResult: [] });
      const service = new MemoryStoreService(db as never);

      const result = await service.searchInsights('cs-1', 'test');
      expect(result.ok).toBe(true);
    });

    it('returns err on database error', async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockRejectedValue(new Error('query failed')),
              }),
            }),
          }),
        }),
      };
      const service = new MemoryStoreService(db as never);

      const result = await service.searchInsights('cs-1', 'test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // assembleContext
  // -------------------------------------------------------------------------

  describe('assembleContext()', () => {
    it('returns context with markdown header and insights', async () => {
      const rows = [
        createMockRow({ content: 'Insight A' }),
        createMockRow({ id: 'ins-2', content: 'Insight B' }),
      ];
      const db = createMockDb({ selectResult: rows });
      const service = new MemoryStoreService(db as never);

      const result = await service.assembleContext('cs-1', 'test query');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toContain('## Memory Context');
        expect(result.value.text).toContain('### Codebase Insights');
        expect(result.value.text).toContain('- Insight A');
        expect(result.value.text).toContain('- Insight B');
        expect(result.value.sources.insights).toBe(2);
        expect(result.value.tokenCount).toBeGreaterThan(0);
      }
    });

    it('returns empty context when no insights found', async () => {
      // First call (search) returns empty, second call (recent) returns empty
      let _callCount = 0;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockImplementation(() => {
                  _callCount++;
                  return Promise.resolve([]);
                }),
              }),
            }),
          }),
        }),
      };
      const service = new MemoryStoreService(db as never);

      const result = await service.assembleContext('cs-1', 'nope');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toBe('');
        expect(result.value.tokenCount).toBe(0);
        expect(result.value.sources.insights).toBe(0);
      }
    });

    it('respects maxTokens budget', async () => {
      // Create many long insights that exceed a small token budget
      const longRows = Array.from({ length: 50 }, (_, i) =>
        createMockRow({ id: `ins-${i}`, content: 'x'.repeat(200) })
      );
      const db = createMockDb({ selectResult: longRows });
      const service = new MemoryStoreService(db as never);

      const result = await service.assembleContext('cs-1', 'test', 100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Token count should respect budget
        expect(result.value.tokenCount).toBeLessThanOrEqual(100);
        // Not all insights should be included
        expect(result.value.sources.insights).toBeLessThan(50);
      }
    });
  });

  // -------------------------------------------------------------------------
  // insertMessage
  // -------------------------------------------------------------------------

  describe('insertMessage()', () => {
    it('inserts message record and returns MemoryMessage', async () => {
      const db = createMockDb();
      const service = new MemoryStoreService(db as never);

      const result = await service.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Analyzing the codebase...',
        turnNumber: 1,
        metadata: { model: 'claude-sonnet-4-6' },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeDefined();
        expect(result.value.codespaceId).toBe('cs-1');
        expect(result.value.memorySessionId).toBe('msess-1');
        expect(result.value.role).toBe('assistant');
        expect(result.value.turnNumber).toBe(1);
        expect(result.value.metadata).toEqual({ model: 'claude-sonnet-4-6' });
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb({ insertError: new Error('insert failed') });
      const service = new MemoryStoreService(db as never);

      const result = await service.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'test',
        turnNumber: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getMessages
  // -------------------------------------------------------------------------

  describe('getMessages()', () => {
    it('returns messages by memorySessionId', async () => {
      const msgRows = [
        createMockMessageRow(),
        createMockMessageRow({ id: 'msg-2', turnNumber: 2 }),
      ];
      const db = createMockDb({ selectResult: msgRows });
      const service = new MemoryStoreService(db as never);

      const result = await service.getMessages('msess-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].memorySessionId).toBe('msess-1');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getInsightCount / getMessageCount
  // -------------------------------------------------------------------------

  describe('getInsightCount()', () => {
    it('returns count for codespace', async () => {
      const db = createMockDb({ selectResult: [{ value: 42 }] });
      const service = new MemoryStoreService(db as never);

      const result = await service.getInsightCount('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('returns 0 when no results', async () => {
      const db = createMockDb({ selectResult: [] });
      const service = new MemoryStoreService(db as never);

      const result = await service.getInsightCount('cs-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe('getMessageCount()', () => {
    it('returns count for codespace', async () => {
      const db = createMockDb({ selectResult: [{ value: 17 }] });
      const service = new MemoryStoreService(db as never);

      const result = await service.getMessageCount('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(17);
      }
    });
  });
});
