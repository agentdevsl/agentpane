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
  createdAt: '2026-01-01T00:00:02Z',
};

function createMockStore() {
  return {
    getMessages: vi.fn().mockResolvedValue(ok(mockMessages)),
    insertInsight: vi.fn().mockResolvedValue(ok(mockInsight)),
    getInsights: vi.fn(),
    deleteInsight: vi.fn(),
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

    // Default agentPrompt response with multi-line insights
    mockAgentPrompt.mockResolvedValue({
      text: '- SSO redirects require a state parameter for CSRF protection\n- The auth.service.ts file handles all OAuth flows\n- Always validate redirect URIs against allowlist',
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
      }

      // Should have read messages
      expect(store.getMessages).toHaveBeenCalledWith('msess-1');

      // Should have called Claude via Agent SDK
      expect(mockAgentPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Fix the login bug with SSO'),
        { model: 'claude-haiku-4-5-20251001' }
      );

      // Should have stored 3 insights (one per line)
      expect(store.insertInsight).toHaveBeenCalledTimes(3);
      expect(store.insertInsight).toHaveBeenCalledWith(
        expect.objectContaining({
          codespaceId: 'cs-1',
          source: 'agent_derived',
          sourceSessionId: 'msess-1',
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

    it('parses multi-line insights from response', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '- First insight about the codebase\n- Second insight about testing patterns\n- Third insight about deployment',
        usage: { inputTokens: 200, outputTokens: 80 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(3);
      }
      expect(store.insertInsight).toHaveBeenCalledTimes(3);

      // Check each insight was stored with correct content
      const calls = (store.insertInsight as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].content).toBe('First insight about the codebase');
      expect(calls[1][0].content).toBe('Second insight about testing patterns');
      expect(calls[2][0].content).toBe('Third insight about deployment');
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

    it('skips lines that do not start with "- "', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: 'Here are the insights:\n- Valid insight line\nThis is not an insight\n- Another valid insight\n',
        usage: { inputTokens: 200, outputTokens: 60 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(2);
      }
      expect(store.insertInsight).toHaveBeenCalledTimes(2);
    });

    it('skips empty insight lines after trimming', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '- \n-   \n- Actual insight here',
        usage: { inputTokens: 200, outputTokens: 30 },
      });

      const result = await service.deriveInsights('msess-1', 'cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.insightsCreated).toBe(1);
      }
    });

    it('returns 0 insights when Claude returns no lines with "- " prefix', async () => {
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
        // 3 lines parsed, but only 2 stored successfully
        expect(result.value.insightsCreated).toBe(2);
      }
    });

    it('formats conversation with User/Assistant role labels', async () => {
      const _result = await service.deriveInsights('msess-1', 'cs-1');

      const prompt = mockAgentPrompt.mock.calls[0][0];

      expect(prompt).toContain('User: Fix the login bug with SSO');
      expect(prompt).toContain('Assistant: Found the issue in auth.service.ts');
    });
  });
});
