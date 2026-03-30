// @ts-nocheck — test mocks use loose types
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryErrors } from '../../../lib/errors/memory-errors.js';
import { err, ok } from '../../../lib/utils/result.js';
import { InsightDeriverService } from '../insight-deriver.service.js';
import type { MemoryStoreService } from '../memory-store.service.js';
import type { Insight, MemoryMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Mock Agent SDK utils
// ---------------------------------------------------------------------------

const { mockAgentPrompt } = vi.hoisted(() => ({
  mockAgentPrompt: vi.fn(),
}));

vi.mock('../../../lib/agents/agent-sdk-utils.js', () => ({
  agentPrompt: mockAgentPrompt,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockMessages: MemoryMessage[] = [
  {
    id: 'msg-1',
    codespaceId: 'cs-1',
    memorySessionId: 'msess-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    role: 'user',
    content: 'Fix the login bug with SSO',
    turnNumber: 1,
    metadata: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'msg-2',
    codespaceId: 'cs-1',
    memorySessionId: 'msess-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    role: 'assistant',
    content:
      'Found the issue in auth.service.ts. The SSO redirect was missing the state parameter.',
    turnNumber: 2,
    metadata: null,
    createdAt: '2026-01-01T00:00:01Z',
  },
];

const mockInsight: Insight = {
  id: 'ins-derived-1',
  codespaceId: 'cs-1',
  content: 'SSO redirects require a state parameter for CSRF protection',
  source: 'agent_derived',
  sourceSessionId: 'msess-1',
  skillId: null,
  tags: [],
  metadata: null,
  status: 'pending_review',
  category: 'error_lesson',
  updatedAt: null,
  createdAt: '2026-01-01T00:00:02Z',
};

const existingInsight: Insight = {
  id: 'ins-existing-1',
  codespaceId: 'cs-1',
  content: 'Auth service handles OAuth flows',
  source: 'manual',
  sourceSessionId: null,
  skillId: null,
  tags: [],
  metadata: null,
  status: 'active',
  category: 'architecture',
  updatedAt: null,
  createdAt: '2025-12-01T00:00:00Z',
};

/** Build a JSON response string with INSERT actions */
function makeJsonResponse(actions: Array<Record<string, unknown>>): string {
  return `\`\`\`json\n${JSON.stringify(actions)}\n\`\`\``;
}

function createMockStore() {
  return {
    getMessages: vi.fn().mockResolvedValue(ok(mockMessages)),
    insertInsight: vi.fn().mockResolvedValue(ok(mockInsight)),
    getInsights: vi.fn().mockResolvedValue(ok([])),
    deleteInsight: vi.fn().mockResolvedValue(ok(undefined)),
    updateInsight: vi.fn().mockResolvedValue(ok(mockInsight)),
    searchInsights: vi.fn(),
    assembleContext: vi.fn(),
    insertMessage: vi.fn(),
    getInsightCount: vi.fn(),
    getMessageCount: vi.fn(),
  } as unknown as MemoryStoreService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightDeriverService', () => {
  let store: ReturnType<typeof createMockStore>;
  let service: InsightDeriverService;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAgentPrompt.mockReset();
    store = createMockStore();
    service = new InsightDeriverService(store as never);

    // Default agentPrompt response with structured JSON
    mockAgentPrompt.mockResolvedValue({
      text: makeJsonResponse([
        {
          action: 'INSERT',
          content: 'SSO redirects require a state parameter for CSRF protection',
          category: 'error_lesson',
        },
        {
          action: 'INSERT',
          content: 'The auth.service.ts file handles all OAuth flows',
          category: 'architecture',
        },
        {
          action: 'INSERT',
          content: 'Always validate redirect URIs against allowlist',
          category: 'pattern',
        },
      ]),
      usage: { inputTokens: 300, outputTokens: 100 },
    });
  });

  // -------------------------------------------------------------------------
  // deriveInsights
  // -------------------------------------------------------------------------

  describe('deriveInsights()', () => {
    it('reads messages, calls Claude, stores insights', async () => {
      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(3);
        expect(result.value.insightsUpdated).toBe(0);
        expect(result.value.insightsDeleted).toBe(0);
      }

      // Should have read messages
      expect(store.getMessages).toHaveBeenCalledWith('msess-1');

      // Should have fetched existing insights for dedup (large window)
      expect(store.getInsights).toHaveBeenCalledWith('cs-1', { page: 1, size: 500 });

      // Should have called Claude via Agent SDK
      expect(mockAgentPrompt).toHaveBeenCalledWith(expect.stringContaining('Fix the login bug'), {
        model: 'claude-haiku-4-5-20251001',
      });

      // Should have stored 3 insights with pending_review status
      expect(store.insertInsight).toHaveBeenCalledTimes(3);
      expect(store.insertInsight).toHaveBeenCalledWith(
        expect.objectContaining({
          codespaceId: 'cs-1',
          source: 'agent_derived',
          sourceSessionId: 'msess-1',
          status: 'pending_review',
        })
      );
    });

    it('handles empty messages (returns 0 insights)', async () => {
      (store.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue(ok([]));

      const result = await service.deriveInsights('msess-empty', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(0);
      }

      // Should NOT have called Claude
      expect(mockAgentPrompt).not.toHaveBeenCalled();
    });

    it('handles Claude API error gracefully', async () => {
      mockAgentPrompt.mockRejectedValue(new Error('API rate limited'));

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_DERIVATION_ERROR');
        expect(result.error.message).toContain('API rate limited');
      }
    });

    it('parses structured JSON with categories', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          { action: 'INSERT', content: 'Error lesson insight', category: 'error_lesson' },
          { action: 'INSERT', content: 'Pattern insight', category: 'pattern' },
          { action: 'INSERT', content: 'Architecture insight', category: 'architecture' },
        ]),
        usage: { inputTokens: 200, outputTokens: 80 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(3);
      }
      expect(store.insertInsight).toHaveBeenCalledTimes(3);

      // Check categories were passed through
      const calls = (store.insertInsight as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].category).toBe('error_lesson');
      expect(calls[1][0].category).toBe('pattern');
      expect(calls[2][0].category).toBe('architecture');
    });

    it('handles getMessages returning error result', async () => {
      (store.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(MemoryErrors.QUERY_ERROR('messages table locked'))
      );

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });

    it('returns 0 insights when Claude returns no valid actions', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: 'No notable insights found in this conversation.',
        usage: { inputTokens: 200, outputTokens: 20 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(0);
      }
      expect(store.insertInsight).not.toHaveBeenCalled();
    });

    it('counts only successfully stored insights', async () => {
      // First insert succeeds, second fails, third succeeds
      (store.insertInsight as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok(mockInsight))
        .mockResolvedValueOnce(err(MemoryErrors.CAPTURE_ERROR('insert failed')))
        .mockResolvedValueOnce(ok(mockInsight));

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // 3 INSERT actions, but only 2 stored successfully
        expect(result.value.insightsCreated).toBe(2);
      }
    });

    it('formats conversation with User/Assistant role labels', async () => {
      await service.deriveInsights('msess-1', 'cs-1');

      const prompt = mockAgentPrompt.mock.calls[0][0];

      expect(prompt).toContain('User: Fix the login bug with SSO');
      expect(prompt).toContain('Assistant: Found the issue in auth.service.ts');
    });

    it('includes existing insights in prompt for dedup context', async () => {
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([existingInsight]));

      await service.deriveInsights('msess-1', 'cs-1');

      const prompt = mockAgentPrompt.mock.calls[0][0];
      expect(prompt).toContain('[ins-existing-1]');
      expect(prompt).toContain('Auth service handles OAuth flows');
    });

    it('processes UPDATE actions', async () => {
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([existingInsight]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'UPDATE',
            id: 'ins-existing-1',
            content: 'Auth service handles all OAuth and SSO flows',
            category: 'architecture',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsUpdated).toBe(1);
        expect(result.value.insightsCreated).toBe(0);
      }
      expect(store.updateInsight).toHaveBeenCalledWith('ins-existing-1', {
        content: 'Auth service handles all OAuth and SSO flows',
        category: 'architecture',
      });
    });

    it('processes DELETE actions', async () => {
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([existingInsight]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'DELETE',
            id: 'ins-existing-1',
            reason: 'no longer accurate',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsDeleted).toBe(1);
      }
      expect(store.deleteInsight).toHaveBeenCalledWith('ins-existing-1');
    });

    it('deduplicates INSERT when significant word overlap with existing insight', async () => {
      const overlappingExisting: Insight = {
        ...existingInsight,
        id: 'ins-overlap',
        content: 'Auth service handles OAuth flows and authentication',
      };
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([overlappingExisting]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Auth service handles OAuth flows and SSO authentication',
            category: 'architecture',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should be treated as UPDATE, not INSERT
        expect(result.value.insightsCreated).toBe(0);
        expect(result.value.insightsUpdated).toBe(1);
      }
      expect(store.updateInsight).toHaveBeenCalledWith('ins-overlap', expect.any(Object));
      expect(store.insertInsight).not.toHaveBeenCalled();
    });

    it('processes SKIP actions (does nothing)', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([{ action: 'SKIP', id: 'ins-existing-1' }]),
        usage: { inputTokens: 200, outputTokens: 20 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(0);
        expect(result.value.insightsUpdated).toBe(0);
        expect(result.value.insightsDeleted).toBe(0);
      }
      expect(store.insertInsight).not.toHaveBeenCalled();
      expect(store.updateInsight).not.toHaveBeenCalled();
      expect(store.deleteInsight).not.toHaveBeenCalled();
    });

    it('sets agent-derived insights to pending_review status', async () => {
      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);

      const calls = (store.insertInsight as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0].status).toBe('pending_review');
      }
    });

    // -----------------------------------------------------------------------
    // Hallucinated ID handling
    // -----------------------------------------------------------------------

    it('skips UPDATE action with unknown insight ID (hallucination)', async () => {
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([existingInsight]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'UPDATE',
            id: 'ins-hallucinated-999',
            content: 'updated text',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsUpdated).toBe(0);
      }
      expect(store.updateInsight).not.toHaveBeenCalled();
    });

    it('skips DELETE action with unknown insight ID (hallucination)', async () => {
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([existingInsight]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'DELETE',
            id: 'ins-hallucinated-999',
            reason: 'outdated',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsDeleted).toBe(0);
      }
      expect(store.deleteInsight).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Overlap edge cases
    // -----------------------------------------------------------------------

    it('detects identical content as overlap (converts INSERT to UPDATE)', async () => {
      const identicalExisting: Insight = {
        ...existingInsight,
        id: 'ins-identical',
        content: 'Always validate redirect URIs against allowlist',
      };
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([identicalExisting]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Always validate redirect URIs against allowlist',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(0);
        expect(result.value.insightsUpdated).toBe(1);
      }
      expect(store.updateInsight).toHaveBeenCalledWith('ins-identical', expect.any(Object));
      expect(store.insertInsight).not.toHaveBeenCalled();
    });

    it('does not treat short unrelated insights as overlapping', async () => {
      // "deploy" and "testing" share zero significant words (>3 chars)
      const shortExisting: Insight = {
        ...existingInsight,
        id: 'ins-short',
        content: 'Deploy using Docker containers always',
      };
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(ok([shortExisting]));

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'Testing requires separate database fixtures',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(1);
        expect(result.value.insightsUpdated).toBe(0);
      }
      expect(store.insertInsight).toHaveBeenCalledTimes(1);
      expect(store.updateInsight).not.toHaveBeenCalled();
    });

    it('does not match when Jaccard similarity is just below threshold', async () => {
      // Jaccard threshold is 0.6. We need overlap / union < 0.6
      // existing significant words (>3 chars): "alpha", "bravo", "charlie", "delta", "echo"
      // new significant words: "alpha", "bravo", "foxtrot", "golf", "hotel", "india", "juliet"
      // intersection: 2 (alpha, bravo), union: 5 + 7 - 2 = 10, Jaccard: 2/10 = 0.2 (well below)
      const belowThresholdExisting: Insight = {
        ...existingInsight,
        id: 'ins-below',
        content: 'alpha bravo charlie delta echo',
      };
      (store.getInsights as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok([belowThresholdExisting])
      );

      mockAgentPrompt.mockResolvedValue({
        text: makeJsonResponse([
          {
            action: 'INSERT',
            content: 'alpha bravo foxtrot golf hotel india juliet',
            category: 'pattern',
          },
        ]),
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(1);
        expect(result.value.insightsUpdated).toBe(0);
      }
      expect(store.insertInsight).toHaveBeenCalledTimes(1);
      expect(store.updateInsight).not.toHaveBeenCalled();
    });

    it('hasSignificantOverlap returns false for empty significant words', () => {
      // Words with <= 3 chars are filtered out, so content with only short words yields empty sets
      const result = (service as any).hasSignificantOverlap('a b c', 'x y z');
      expect(result).toBe(false);
    });
  });
});
