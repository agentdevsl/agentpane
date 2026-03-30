/**
 * Integration tests for the memory service improvements.
 *
 * Exercises REAL service code through the full lifecycle with a real in-memory
 * SQLite database. Only the Claude Agent SDK (`agentPrompt`) is mocked since
 * we cannot call the real API in tests.
 *
 * Covers:
 * 1. Insight lifecycle: create -> derive -> approve/reject
 * 2. Source priority ordering in assembleContext
 * 3. Item cap (maxInsights)
 * 4. Deduplication via Jaccard overlap
 * 5. Consolidation (UPDATE/DELETE actions from derivation)
 * 6. Category grouping in context output
 * 7. Status-based filtering (searchInsights excludes rejected)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InsightDeriverService } from '../../src/services/memory/insight-deriver.service';
import { MemoryService } from '../../src/services/memory/memory.service';
import { MemoryStoreService } from '../../src/services/memory/memory-store.service';
import type { SettingsService } from '../../src/services/settings.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock Agent SDK (only external I/O boundary)
// ---------------------------------------------------------------------------

const { mockAgentPrompt } = vi.hoisted(() => ({
  mockAgentPrompt: vi.fn(),
}));

vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  agentPrompt: mockAgentPrompt,
}));

// ---------------------------------------------------------------------------
// SQL to create memory tables with status, category, updated_at columns
// The base migration (v22) does not include these columns; they were added
// to the Drizzle schema later. We create the full table here.
// ---------------------------------------------------------------------------

const MEMORY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS memory_insights (
  id TEXT PRIMARY KEY,
  codespace_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_session_id TEXT,
  skill_id TEXT,
  tags TEXT DEFAULT '[]',
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  category TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_insights_status ON memory_insights(status);
CREATE INDEX IF NOT EXISTS idx_memory_insights_codespace_id ON memory_insights(codespace_id);

CREATE TABLE IF NOT EXISTS memory_messages (
  id TEXT PRIMARY KEY,
  codespace_id TEXT NOT NULL,
  memory_session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  turn_number INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_messages_memory_session_id ON memory_messages(memory_session_id);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSettings(): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'memory.enabled') {
        return { ok: true, value: { value: 'true' } };
      }
      if (key === 'memory.contextMaxTokens') {
        return { ok: true, value: { value: '2000' } };
      }
      return { ok: true, value: null };
    }),
    set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getAll: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    getMany: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    setMany: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  } as unknown as SettingsService;
}

/** Build a JSON response string as Claude would return it */
function makeJsonResponse(actions: Array<Record<string, unknown>>): string {
  return `\`\`\`json\n${JSON.stringify(actions)}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Memory Service Lifecycle Integration', () => {
  let db: ReturnType<typeof getTestDb>;
  let store: MemoryStoreService;
  let deriver: InsightDeriverService;
  let memoryService: MemoryService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    // Create memory tables (with status/category/updated_at columns)
    for (const stmt of MEMORY_TABLES_SQL.split(';').filter((s) => s.trim())) {
      (db as any).$client.exec(`${stmt};`);
    }

    // Clean data from previous tests
    (db as any).$client.exec('DELETE FROM memory_messages; DELETE FROM memory_insights;');

    // Set up services with real DB
    store = new MemoryStoreService(db as any);
    deriver = new InsightDeriverService(store);
    memoryService = new MemoryService(createMockSettings(), db as any);
    await memoryService.initialize();

    mockAgentPrompt.mockReset();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =========================================================================
  // 1. Insight lifecycle: create -> derive -> approve/reject
  // =========================================================================

  describe('insight lifecycle: create -> derive -> approve/reject', () => {
    it('manual insights are active and appear in getInsights and assembleContext', async () => {
      const result = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Use Result types for error handling',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      expect(result.ok).toBe(true);

      // Appears in getInsights
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(1);
        expect(insights.value[0].status).toBe('active');
        expect(insights.value[0].category).toBe('pattern');
      }

      // Appears in assembleContext (query matches content)
      const ctx = await store.assembleContext('cs-1', 'Result types');
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.value.sources.insights).toBe(1);
        expect(ctx.value.text).toContain('Use Result types');
      }
    });

    it('agent-derived insights get pending_review status and are EXCLUDED from assembleContext', async () => {
      // Seed a message for the deriver to read
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-derive-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Fix the authentication flow',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-derive-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'The auth flow was missing CSRF token validation.',
        turnNumber: 2,
      });

      // Mock Claude returning an INSERT action
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Auth flows must include CSRF token validation',
            category: 'error_lesson',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      // Derive insights
      const deriveResult = await deriver.deriveInsights('msess-derive-1', 'cs-1');
      expect(deriveResult.ok).toBe(true);
      if (deriveResult.ok) {
        expect(deriveResult.value.insightsCreated).toBe(1);
      }

      // Verify the derived insight has pending_review status
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(1);
        expect(insights.value[0].status).toBe('pending_review');
        expect(insights.value[0].source).toBe('agent_derived');
        expect(insights.value[0].category).toBe('error_lesson');
      }

      // pending_review insights should be EXCLUDED from assembleContext
      const ctx = await store.assembleContext('cs-1', 'CSRF');
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.value.sources.insights).toBe(0);
        expect(ctx.value.text).toBe('');
      }
    });

    it('approving a pending insight makes it active and visible in assembleContext', async () => {
      // Insert a pending_review insight
      const insertResult = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Always use parameterized queries',
        source: 'agent_derived',
        status: 'pending_review',
        category: 'pattern',
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) return;

      const insightId = insertResult.value.id;

      // Approve via MemoryService facade
      const approveResult = await memoryService.approveInsight(insightId);
      expect(approveResult.ok).toBe(true);
      if (approveResult.ok) {
        expect(approveResult.value.status).toBe('active');
        expect(approveResult.value.updatedAt).toBeTruthy();
      }

      // Now it should appear in assembleContext
      const ctx = await store.assembleContext('cs-1', 'parameterized');
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.value.sources.insights).toBe(1);
        expect(ctx.value.text).toContain('parameterized queries');
      }
    });

    it('rejecting an insight sets status to rejected and excludes from context and search', async () => {
      const insertResult = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Use eval for dynamic code generation',
        source: 'agent_derived',
        status: 'pending_review',
        category: 'anti_pattern',
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) return;

      const insightId = insertResult.value.id;

      // Reject
      const rejectResult = await memoryService.rejectInsight(insightId);
      expect(rejectResult.ok).toBe(true);
      if (rejectResult.ok) {
        expect(rejectResult.value.status).toBe('rejected');
      }

      // Rejected insights excluded from assembleContext
      const ctx = await store.assembleContext('cs-1', 'eval');
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.value.sources.insights).toBe(0);
      }

      // Rejected insights excluded from searchInsights
      const searchResult = await store.searchInsights('cs-1', 'eval');
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        expect(searchResult.value).toHaveLength(0);
      }
    });
  });

  // =========================================================================
  // 2. Source priority ordering
  // =========================================================================

  describe('source priority ordering in assembleContext', () => {
    it('orders manual first, then dream, then agent_derived', async () => {
      // Insert in reverse priority order to verify sorting overrides insertion order
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Agent derived insight about testing',
        source: 'agent_derived',
        status: 'active',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Dream insight about testing',
        source: 'dream',
        status: 'active',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Manual insight about testing',
        source: 'manual',
        status: 'active',
      });

      const ctx = await store.assembleContext('cs-1', 'testing');
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      // All 3 should be included
      expect(ctx.value.sources.insights).toBe(3);

      // The insight IDs should reflect source priority ordering
      // Manual first (index 0), then dream (index 1), then agent_derived (index 2)
      const text = ctx.value.text;
      const manualPos = text.indexOf('Manual insight');
      const dreamPos = text.indexOf('Dream insight');
      const agentPos = text.indexOf('Agent derived');

      expect(manualPos).toBeLessThan(dreamPos);
      expect(dreamPos).toBeLessThan(agentPos);
    });
  });

  // =========================================================================
  // 3. Item cap (maxInsights)
  // =========================================================================

  describe('item cap (maxInsights)', () => {
    it('respects maxInsights parameter in assembleContext', async () => {
      // Insert 15 active insights
      for (let i = 0; i < 15; i++) {
        await store.insertInsight({
          codespaceId: 'cs-1',
          content: `Insight number ${i} about code patterns`,
          source: 'manual',
          status: 'active',
        });
      }

      // Request max 5
      const ctx = await store.assembleContext('cs-1', 'code patterns', 2000, 5);
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      expect(ctx.value.sources.insights).toBe(5);
      expect(ctx.value.sources.insightIds).toHaveLength(5);
    });

    it('returns all insights when count is below maxInsights', async () => {
      // Insert 3 insights, request max 10
      for (let i = 0; i < 3; i++) {
        await store.insertInsight({
          codespaceId: 'cs-1',
          content: `Small set insight ${i} about patterns`,
          source: 'manual',
          status: 'active',
        });
      }

      const ctx = await store.assembleContext('cs-1', 'patterns', 2000, 10);
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      expect(ctx.value.sources.insights).toBe(3);
    });
  });

  // =========================================================================
  // 4. Deduplication via Jaccard overlap
  // =========================================================================

  describe('deduplication via Jaccard overlap', () => {
    it('treats INSERT with high overlap as UPDATE instead of creating duplicate', async () => {
      // Insert an existing insight
      const existing = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Use Result types for error handling in services',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      expect(existing.ok).toBe(true);
      if (!existing.ok) return;

      // Seed messages for derivation
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-dedup-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'How should I handle errors?',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-dedup-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Always use Result types for proper error handling in all services.',
        turnNumber: 2,
      });

      // Mock Claude returning very similar content (high Jaccard overlap)
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Always use Result types for proper error handling in services',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      const result = await deriver.deriveInsights('msess-dedup-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should be treated as UPDATE due to overlap, not INSERT
        expect(result.value.insightsCreated).toBe(0);
        expect(result.value.insightsUpdated).toBe(1);
      }

      // Should still have only 1 insight (the original, now updated)
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(1);
        // Content was updated to the new version
        expect(insights.value[0].content).toContain('Always use Result types');
      }
    });

    it('does NOT deduplicate when content is sufficiently different', async () => {
      // Insert an existing insight about testing
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Always write unit tests for service methods',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });

      // Seed messages
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-dedup-2',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'How do I handle database migrations?',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-dedup-2',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Use Drizzle migrations for schema changes.',
        turnNumber: 2,
      });

      // Mock Claude returning different content (low Jaccard overlap)
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Use Drizzle migrations for all database schema changes',
            category: 'architecture',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      const result = await deriver.deriveInsights('msess-dedup-2', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(1);
        expect(result.value.insightsUpdated).toBe(0);
      }

      // Should now have 2 insights
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(2);
      }
    });
  });

  // =========================================================================
  // 5. Consolidation (UPDATE/DELETE actions)
  // =========================================================================

  describe('consolidation: UPDATE and DELETE actions from derivation', () => {
    it('UPDATE action updates existing insight content via derivation', async () => {
      // Insert existing insight with known ID
      const existing = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Auth service handles OAuth flows',
        source: 'manual',
        status: 'active',
        category: 'architecture',
      });
      expect(existing.ok).toBe(true);
      if (!existing.ok) return;

      const existingId = existing.value.id;

      // Seed messages
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-update-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Add SSO support to auth',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-update-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Updated auth.service.ts to support SSO alongside OAuth.',
        turnNumber: 2,
      });

      // Mock Claude returning an UPDATE action targeting the existing insight
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'UPDATE',
            id: existingId,
            content: 'Auth service handles both OAuth and SSO flows',
            category: 'architecture',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      const result = await deriver.deriveInsights('msess-update-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsUpdated).toBe(1);
        expect(result.value.insightsCreated).toBe(0);
        expect(result.value.insightsDeleted).toBe(0);
      }

      // Verify the insight was updated in the DB
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(1);
        expect(insights.value[0].content).toBe('Auth service handles both OAuth and SSO flows');
        expect(insights.value[0].updatedAt).toBeTruthy();
      }
    });

    it('DELETE action removes existing insight via derivation', async () => {
      // Insert existing insight
      const existing = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Use jQuery for DOM manipulation',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      expect(existing.ok).toBe(true);
      if (!existing.ok) return;

      const existingId = existing.value.id;

      // Seed messages
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-delete-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Should we still use jQuery?',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-delete-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'No, React handles DOM. jQuery is outdated for this project.',
        turnNumber: 2,
      });

      // Mock Claude returning a DELETE action
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'DELETE',
            id: existingId,
            reason: 'jQuery is no longer used; React handles DOM',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await deriver.deriveInsights('msess-delete-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsDeleted).toBe(1);
      }

      // Insight should be gone
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(0);
      }
    });

    it('skips UPDATE/DELETE with hallucinated (non-existent) IDs', async () => {
      // Insert an insight with a known ID
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Real insight',
        source: 'manual',
        status: 'active',
      });

      // Seed messages
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-hallucinate',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Some conversation',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-hallucinate',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Some response',
        turnNumber: 2,
      });

      // Mock Claude returning actions with non-existent IDs
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'UPDATE',
            id: 'fake-id-that-does-not-exist',
            content: 'updated content',
            category: 'pattern',
          },
          {
            action: 'DELETE',
            id: 'another-fake-id',
            reason: 'outdated',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await deriver.deriveInsights('msess-hallucinate', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsUpdated).toBe(0);
        expect(result.value.insightsDeleted).toBe(0);
        expect(result.value.insightsCreated).toBe(0);
      }

      // Original insight should be unchanged
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value).toHaveLength(1);
        expect(insights.value[0].content).toBe('Real insight');
      }
    });
  });

  // =========================================================================
  // 6. Category grouping in context output
  // =========================================================================

  describe('category grouping in context output', () => {
    it('groups insights by category with proper headers', async () => {
      // Insert insights with different categories
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Always validate inputs before database writes',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Never use string concatenation for SQL queries',
        source: 'manual',
        status: 'active',
        category: 'anti_pattern',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Chose Drizzle over Prisma for build speed',
        source: 'manual',
        status: 'active',
        category: 'decision',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Services use hexagonal architecture pattern',
        source: 'manual',
        status: 'active',
        category: 'architecture',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Missing CSRF token caused auth redirect failures',
        source: 'manual',
        status: 'active',
        category: 'error_lesson',
      });

      // Use empty query to get all (or a broad query)
      const ctx = await store.assembleContext('cs-1', '', 4000, 10);
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      const text = ctx.value.text;

      // All 5 should be included
      expect(ctx.value.sources.insights).toBe(5);

      // Should have category headers
      expect(text).toContain('### Patterns');
      expect(text).toContain('### Anti-Patterns');
      expect(text).toContain('### Decisions');
      expect(text).toContain('### Architecture');
      expect(text).toContain('### Error Lessons');

      // Should contain the actual insight content
      expect(text).toContain('validate inputs');
      expect(text).toContain('string concatenation');
      expect(text).toContain('Drizzle over Prisma');
      expect(text).toContain('hexagonal architecture');
      expect(text).toContain('CSRF token');
    });

    it('uses "Codebase Insights" header when no categories are set', async () => {
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Uncategorized insight about general patterns',
        source: 'manual',
        status: 'active',
        // No category
      });

      const ctx = await store.assembleContext('cs-1', '', 2000, 10);
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      expect(ctx.value.text).toContain('### Codebase Insights');
      expect(ctx.value.text).not.toContain('### Other Insights');
    });

    it('uses "Other Insights" header for uncategorized when categorized insights also exist', async () => {
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Categorized pattern insight',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Uncategorized insight',
        source: 'manual',
        status: 'active',
        // No category
      });

      const ctx = await store.assembleContext('cs-1', '', 2000, 10);
      expect(ctx.ok).toBe(true);
      if (!ctx.ok) return;

      expect(ctx.value.text).toContain('### Patterns');
      expect(ctx.value.text).toContain('### Other Insights');
    });
  });

  // =========================================================================
  // 7. Status-based filtering
  // =========================================================================

  describe('status-based filtering', () => {
    it('getInsights filters by status', async () => {
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Active insight',
        source: 'manual',
        status: 'active',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Pending insight',
        source: 'agent_derived',
        status: 'pending_review',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Rejected insight',
        source: 'agent_derived',
        status: 'rejected',
      });

      // Filter active only
      const activeOnly = await store.getInsights('cs-1', undefined, { status: 'active' });
      expect(activeOnly.ok).toBe(true);
      if (activeOnly.ok) {
        expect(activeOnly.value).toHaveLength(1);
        expect(activeOnly.value[0].content).toBe('Active insight');
      }

      // Filter pending only
      const pendingOnly = await store.getInsights('cs-1', undefined, {
        status: 'pending_review',
      });
      expect(pendingOnly.ok).toBe(true);
      if (pendingOnly.ok) {
        expect(pendingOnly.value).toHaveLength(1);
        expect(pendingOnly.value[0].content).toBe('Pending insight');
      }

      // Filter rejected only
      const rejectedOnly = await store.getInsights('cs-1', undefined, { status: 'rejected' });
      expect(rejectedOnly.ok).toBe(true);
      if (rejectedOnly.ok) {
        expect(rejectedOnly.value).toHaveLength(1);
        expect(rejectedOnly.value[0].content).toBe('Rejected insight');
      }

      // No filter returns all
      const all = await store.getInsights('cs-1');
      expect(all.ok).toBe(true);
      if (all.ok) {
        expect(all.value).toHaveLength(3);
      }
    });

    it('searchInsights only returns active insights', async () => {
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Active searchable insight about databases',
        source: 'manual',
        status: 'active',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Rejected searchable insight about databases',
        source: 'agent_derived',
        status: 'rejected',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Pending searchable insight about databases',
        source: 'agent_derived',
        status: 'pending_review',
      });

      const result = await store.searchInsights('cs-1', 'databases');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only active should appear in search results
        expect(result.value).toHaveLength(1);
        expect(result.value[0].content).toContain('Active searchable');
      }
    });

    it('getInsights filters by category', async () => {
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Pattern insight',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Error lesson insight',
        source: 'manual',
        status: 'active',
        category: 'error_lesson',
      });

      const result = await store.getInsights('cs-1', undefined, { category: 'error_lesson' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].content).toBe('Error lesson insight');
      }
    });
  });

  // =========================================================================
  // 8. End-to-end: MemoryService facade lifecycle
  // =========================================================================

  describe('MemoryService facade: end-to-end lifecycle', () => {
    it('full lifecycle: create manual -> start session -> capture -> derive -> approve', async () => {
      // 1. Create a manual insight (active by default)
      const createResult = await memoryService.createInsight(
        'cs-1',
        'Use Drizzle ORM for type-safe queries',
        'manual',
        undefined,
        ['database'],
        undefined,
        'active',
        'pattern'
      );
      expect(createResult.ok).toBe(true);

      // 2. Start a memory session
      const ref = await memoryService.startSession({
        codespaceId: 'cs-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });
      expect(ref).not.toBeNull();
      if (!ref) return;

      // 3. Capture messages
      await memoryService.captureMessage(ref, {
        role: 'user',
        content: 'How should I handle errors in service methods?',
        turnNumber: 1,
      });
      await memoryService.captureMessage(ref, {
        role: 'assistant',
        content: 'Use the Result type pattern. Return ok() for success and err() for failures.',
        turnNumber: 2,
      });

      // 4. Mock Claude for finalization (insight derivation)
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Service methods should return Result<T, Error> for consistent error handling',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 300, outputTokens: 80 },
      });

      // 5. Finalize session (triggers derivation)
      await memoryService.finalizeSession(ref);

      // 6. Verify we have 2 insights: 1 manual (active) + 1 derived (pending_review)
      const allInsights = await memoryService.getInsights('cs-1');
      expect(allInsights.ok).toBe(true);
      if (allInsights.ok) {
        expect(allInsights.value).toHaveLength(2);
        const manual = allInsights.value.find((i) => i.source === 'manual');
        const derived = allInsights.value.find((i) => i.source === 'agent_derived');
        expect(manual?.status).toBe('active');
        expect(derived?.status).toBe('pending_review');
      }

      // 7. Context should only include the manual (active) insight
      const ctx = await memoryService.getContext('cs-1', 'error handling');
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.value.sources.insights).toBe(1);
      }

      // 8. Approve the derived insight
      const insights = await memoryService.getInsights('cs-1');
      if (insights.ok) {
        const derived = insights.value.find((i) => i.source === 'agent_derived');
        if (derived) {
          const approveResult = await memoryService.approveInsight(derived.id);
          expect(approveResult.ok).toBe(true);
        }
      }

      // 9. Now context should include both insights
      const ctxAfterApproval = await memoryService.getContext('cs-1', '');
      expect(ctxAfterApproval.ok).toBe(true);
      if (ctxAfterApproval.ok) {
        expect(ctxAfterApproval.value.sources.insights).toBe(2);
      }
    });
  });

  // =========================================================================
  // 9. updateInsight with conditional status guard
  // =========================================================================

  describe('updateInsight with onlyIfStatus guard', () => {
    it('updates when current status matches guard', async () => {
      const insertResult = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Original content',
        source: 'manual',
        status: 'active',
        category: 'pattern',
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) return;

      const result = await store.updateInsight(
        insertResult.value.id,
        { content: 'Updated content', status: 'pending_review' },
        'active' // only update if currently active
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('Updated content');
        expect(result.value.status).toBe('pending_review');
      }
    });

    it('returns NOT_FOUND when current status does not match guard', async () => {
      const insertResult = await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Rejected content',
        source: 'agent_derived',
        status: 'rejected',
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) return;

      // Try to update with guard requiring 'active' status
      const result = await store.updateInsight(
        insertResult.value.id,
        { status: 'pending_review' },
        'active' // guard: only if currently active
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_NOT_FOUND');
      }

      // Verify the insight is unchanged
      const insights = await store.getInsights('cs-1');
      expect(insights.ok).toBe(true);
      if (insights.ok) {
        expect(insights.value[0].status).toBe('rejected');
      }
    });
  });

  // =========================================================================
  // 10. Derivation excludes rejected insights from dedup context
  // =========================================================================

  describe('derivation excludes rejected insights from dedup context', () => {
    it('does not include rejected insights in the prompt context for dedup', async () => {
      // Insert a rejected insight
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'This insight was rejected and should be ignored',
        source: 'agent_derived',
        status: 'rejected',
        category: 'pattern',
      });

      // Insert an active insight
      await store.insertInsight({
        codespaceId: 'cs-1',
        content: 'Active insight that should be in context',
        source: 'manual',
        status: 'active',
        category: 'architecture',
      });

      // Seed messages
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-rejected-context',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Some work',
        turnNumber: 1,
      });
      await store.insertMessage({
        codespaceId: 'cs-1',
        memorySessionId: 'msess-rejected-context',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Some response',
        turnNumber: 2,
      });

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([{ action: 'SKIP', id: 'any' }]),
        usage: { inputTokens: 200, outputTokens: 20 },
      });

      await deriver.deriveInsights('msess-rejected-context', 'cs-1');

      // Check the prompt sent to Claude
      const prompt = mockAgentPrompt.mock.calls[0][0] as string;

      // The active insight should be in the existing insights section
      expect(prompt).toContain('Active insight that should be in context');

      // The rejected insight should NOT be in the existing insights section
      expect(prompt).not.toContain('This insight was rejected');
    });
  });
});
