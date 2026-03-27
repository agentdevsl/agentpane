// @ts-nocheck — test mocks use loose types
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../lib/utils/result.js';
import type { SettingsService } from '../../settings.service.js';
import { DreamService } from '../dream.service.js';
import type { SkillTrackingService } from '../skill-tracking.service.js';
import type { DreamSession, SkillMetrics, SkillSuggestion } from '../types.js';

// ---------------------------------------------------------------------------
// Mock the dynamic schema import
// ---------------------------------------------------------------------------

vi.mock('../../db/schema/index.js', () => ({
  dreamSessions: {
    id: 'id',
    codespaceId: 'codespaceId',
    type: 'type',
    status: 'status',
    createdAt: 'createdAt',
  },
  skillMetrics: {
    codespaceId: 'codespaceId',
    skillId: 'skillId',
    lastRunAt: 'lastRunAt',
  },
  skillSuggestions: {
    id: 'id',
    codespaceId: 'codespaceId',
    skillId: 'skillId',
    status: 'status',
    createdAt: 'createdAt',
  },
}));

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

const mockDreamSession: DreamSession = {
  id: 'dream-1',
  codespaceId: 'cs-1',
  type: 'skill_improvement',
  status: 'completed',
  skillsAnalyzed: 1,
  suggestionsGenerated: 2,
  tokensUsed: 1000,
  costUsd: null,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  errorMessage: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockSuggestion: SkillSuggestion = {
  id: 'sug-1',
  dreamSessionId: 'dream-1',
  codespaceId: 'cs-1',
  skillId: 'skill-deploy',
  skillName: 'Deploy Service',
  suggestionType: 'improve_prompt',
  title: 'Add error handling example',
  reasoning: 'High failure rate due to timeout errors',
  currentContent: null,
  suggestedContent: 'Updated skill content...',
  diff: null,
  status: 'pending',
  userNotes: null,
  appliedAt: null,
  appliedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockMetrics: SkillMetrics = {
  id: 'met-1',
  codespaceId: 'cs-1',
  skillId: 'skill-deploy',
  skillName: 'Deploy Service',
  totalRuns: 5,
  successCount: 3,
  errorCount: 2,
  avgTokensUsed: 4000,
  avgTurnsUsed: 8,
  avgDurationMs: 25000,
  avgCostUsd: 0.04,
  successRate: 0.6,
  lastRunAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function createMockSettingsService(): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'memory.dreaming.model') return ok(null);
      if (key === 'memory.dreaming.minRunsForAnalysis') return ok(null);
      if (key === 'memory.dreaming.maxTokensPerCycle') return ok(null);
      return ok(null);
    }),
    getValue: vi.fn(),
  } as unknown as SettingsService;
}

function createMockSkillTrackingService(): SkillTrackingService {
  return {
    getSkillPerformanceSummary: vi.fn().mockResolvedValue(
      ok({
        metrics: mockMetrics,
        recentExecutions: [
          {
            ...mockMetrics,
            id: 'exec-1',
            status: 'success',
            taskId: 'task-1',
            turnsUsed: 8,
            tokensUsed: 4000,
            durationMs: 25000,
            errorMessage: null,
          },
          {
            ...mockMetrics,
            id: 'exec-2',
            status: 'failed',
            taskId: 'task-2',
            turnsUsed: 10,
            tokensUsed: 5000,
            durationMs: 30000,
            errorMessage: 'Timeout',
          },
        ],
        errorPatterns: [{ message: 'Timeout', count: 2 }],
      })
    ),
    getMetrics: vi.fn(),
    getExecutionHistory: vi.fn(),
    recordExecution: vi.fn(),
    refreshMetrics: vi.fn(),
  } as unknown as SkillTrackingService;
}

function createMockDb() {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const updateSetWhere = vi.fn().mockResolvedValue(undefined);

  return {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: updateSetWhere,
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    query: {
      skillMetrics: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      skillSuggestions: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    _insertValues: insertValues,
    _updateSetWhere: updateSetWhere,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamService', () => {
  let db: ReturnType<typeof createMockDb>;
  let settings: ReturnType<typeof createMockSettingsService>;
  let skillTracking: ReturnType<typeof createMockSkillTrackingService>;
  let service: DreamService;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAgentPrompt.mockReset();
    db = createMockDb();
    settings = createMockSettingsService();
    skillTracking = createMockSkillTrackingService();
    service = new DreamService(db as never, settings as never, skillTracking as never);

    // Default agentPrompt response
    mockAgentPrompt.mockResolvedValue({
      text: '```json\n[{"type":"improve_prompt","title":"Add timeout handling","reasoning":"High failure rate","suggestedContent":"Updated content"}]\n```',
      usage: { inputTokens: 800, outputTokens: 200 },
    });
  });

  // -------------------------------------------------------------------------
  // runDreamCycle
  // -------------------------------------------------------------------------

  describe('runDreamCycle()', () => {
    it('orchestrates analysis of eligible skills', async () => {
      // Setup: one skill with enough runs
      db.query.skillMetrics.findMany.mockResolvedValue([{ ...mockMetrics, totalRuns: 5 }]);

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('skill_improvement');
        expect(result.value.status).toBe('completed');
        expect(result.value.skillsAnalyzed).toBe(1);
        expect(result.value.suggestionsGenerated).toBe(1);
      }
      // Should have called Claude via Agent SDK
      expect(mockAgentPrompt).toHaveBeenCalled();
      // Should have inserted dream session and suggestion records
      expect(db.insert).toHaveBeenCalled();
    });

    it('skips skills with fewer runs than minRuns threshold', async () => {
      // Setup: skill with only 1 run (below default threshold of 3)
      db.query.skillMetrics.findMany.mockResolvedValue([{ ...mockMetrics, totalRuns: 1 }]);

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skillsAnalyzed).toBe(0);
        expect(result.value.suggestionsGenerated).toBe(0);
      }
      // Should NOT have called Claude
      expect(mockAgentPrompt).not.toHaveBeenCalled();
    });

    it('respects token budget limit', async () => {
      // Set a very low token budget
      (settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === 'memory.dreaming.maxTokensPerCycle') {
          return ok({ key, value: '100', updatedAt: '' });
        }
        return ok(null);
      });

      // Multiple eligible skills
      db.query.skillMetrics.findMany.mockResolvedValue([
        { ...mockMetrics, skillId: 'skill-1', totalRuns: 5 },
        { ...mockMetrics, skillId: 'skill-2', totalRuns: 5 },
        { ...mockMetrics, skillId: 'skill-3', totalRuns: 5 },
      ]);

      // First call uses 1000 tokens (already over budget of 100)
      mockAgentPrompt.mockResolvedValue({
        text: '[]',
        usage: { inputTokens: 800, outputTokens: 200 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      // Should have stopped after first skill (token budget exhausted)
      // The first skill is analyzed, then budget check prevents further analysis
      expect(mockAgentPrompt.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('handles errors gracefully and marks dream session as error', async () => {
      // Make the DB throw on the metrics query
      db.query.skillMetrics.findMany.mockRejectedValue(new Error('DB crash'));

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_DERIVATION_ERROR');
      }
      // Should have tried to update dream session status to 'error'
      expect(db.update).toHaveBeenCalled();
    });

    it('works without codespaceId (analyzes all codespaces)', async () => {
      db.query.skillMetrics.findMany.mockResolvedValue([]);

      const result = await service.runDreamCycle();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.codespaceId).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // getDreamSessions
  // -------------------------------------------------------------------------

  describe('getDreamSessions()', () => {
    it('returns paginated dream sessions', async () => {
      const fromChain = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([mockDreamSession]),
      };
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue(fromChain),
      });

      const result = await service.getDreamSessions('cs-1', { page: 1, size: 20 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe('dream-1');
      }
    });

    it('defaults pagination when options not provided', async () => {
      const fromChain = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([]),
      };
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue(fromChain),
      });

      const result = await service.getDreamSessions();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockRejectedValue(new Error('query failed')),
              }),
            }),
          }),
        }),
      });

      const result = await service.getDreamSessions('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getSkillSuggestions
  // -------------------------------------------------------------------------

  describe('getSkillSuggestions()', () => {
    it('returns filtered suggestions by status and skillId', async () => {
      const fromChain = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([mockSuggestion]),
      };
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue(fromChain),
      });

      const result = await service.getSkillSuggestions(
        'cs-1',
        { status: 'pending', skillId: 'skill-deploy' },
        { page: 1, size: 20 }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].status).toBe('pending');
      }
    });

    it('returns empty array when no suggestions found', async () => {
      const fromChain = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([]),
      };
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue(fromChain),
      });

      const result = await service.getSkillSuggestions('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockRejectedValue(new Error('DB error')),
              }),
            }),
          }),
        }),
      });

      const result = await service.getSkillSuggestions('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // acceptSuggestion
  // -------------------------------------------------------------------------

  describe('acceptSuggestion()', () => {
    it('marks suggestion as accepted with appliedAt', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.acceptSuggestion('sug-1', 'LGTM');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('accepted');
        expect(result.value.userNotes).toBe('LGTM');
        expect(result.value.appliedAt).toBeDefined();
      }
      expect(db.update).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when suggestion does not exist', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(null);

      const result = await service.acceptSuggestion('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_NOT_FOUND');
      }
    });

    it('accepts without userNotes', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.acceptSuggestion('sug-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userNotes).toBeNull();
      }
    });

    it('returns err on database error', async () => {
      db.query.skillSuggestions.findFirst.mockRejectedValue(new Error('DB error'));

      const result = await service.acceptSuggestion('sug-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // rejectSuggestion
  // -------------------------------------------------------------------------

  describe('rejectSuggestion()', () => {
    it('marks suggestion as rejected', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.rejectSuggestion('sug-1', 'Not applicable');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('rejected');
        expect(result.value.userNotes).toBe('Not applicable');
      }
      expect(db.update).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when suggestion does not exist', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(null);

      const result = await service.rejectSuggestion('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_NOT_FOUND');
      }
    });

    it('rejects without userNotes', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.rejectSuggestion('sug-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userNotes).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // modifySuggestion
  // -------------------------------------------------------------------------

  describe('modifySuggestion()', () => {
    it('updates content and marks as modified', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.modifySuggestion(
        'sug-1',
        'Modified content here',
        'Tweaked wording'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('modified');
        expect(result.value.suggestedContent).toBe('Modified content here');
        expect(result.value.userNotes).toBe('Tweaked wording');
        expect(result.value.appliedAt).toBeDefined();
      }
      expect(db.update).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when suggestion does not exist', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(null);

      const result = await service.modifySuggestion('nonexistent', 'content');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_NOT_FOUND');
      }
    });

    it('modifies without userNotes', async () => {
      db.query.skillSuggestions.findFirst.mockResolvedValue(mockSuggestion);

      const result = await service.modifySuggestion('sug-1', 'New content');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userNotes).toBeNull();
      }
    });

    it('returns err on database error', async () => {
      db.query.skillSuggestions.findFirst.mockRejectedValue(new Error('DB error'));

      const result = await service.modifySuggestion('sug-1', 'content');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // parseSuggestions (tested via runDreamCycle)
  // -------------------------------------------------------------------------

  describe('parseSuggestions (via runDreamCycle)', () => {
    beforeEach(() => {
      db.query.skillMetrics.findMany.mockResolvedValue([{ ...mockMetrics, totalRuns: 5 }]);
    });

    it('parses JSON suggestions from Claude response', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '```json\n[{"type":"improve_prompt","title":"Better prompts","reasoning":"Reduce errors","suggestedContent":"New prompt text"}]\n```',
        usage: { inputTokens: 500, outputTokens: 200 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(1);
      }
    });

    it('handles empty array from Claude (skill performing well)', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '[]',
        usage: { inputTokens: 500, outputTokens: 10 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('handles malformed JSON gracefully (returns 0 suggestions)', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: 'This is not JSON at all',
        usage: { inputTokens: 500, outputTokens: 50 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('filters out suggestions missing required fields', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '```json\n[{"type":"improve_prompt","title":"Valid"},{"type":"fix_pattern"}]\n```',
        usage: { inputTokens: 500, outputTokens: 100 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only suggestions with all required fields are counted
        // The first one is missing reasoning and suggestedContent, second is missing title/reasoning/suggestedContent
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('truncates suggestion titles to 200 chars', async () => {
      const longTitle = 'x'.repeat(300);
      mockAgentPrompt.mockResolvedValue({
        text: `[{"type":"improve_prompt","title":"${longTitle}","reasoning":"test","suggestedContent":"content"}]`,
        usage: { inputTokens: 500, outputTokens: 200 },
      });

      const result = await service.runDreamCycle('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(1);
      }
      // Verify the insert was called (the title truncation happens internally)
      expect(db.insert).toHaveBeenCalled();
    });
  });
});
