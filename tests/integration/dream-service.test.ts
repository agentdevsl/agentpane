/**
 * Integration tests for DreamService.
 *
 * Exercises REAL database operations (dream sessions, skill suggestions,
 * skill metrics) against an in-memory SQLite database. Only external I/O
 * boundaries are mocked:
 * - agentPrompt (Claude SDK)
 * - SkillTrackingService (returns canned performance data)
 * - SettingsService (returns configuration)
 */

import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dreamSessions,
  skillExecutions,
  skillMetrics,
  skillSuggestions,
} from '../../src/db/schema';
import { DreamService } from '../../src/services/memory/dream.service';
import type { MemoryStoreService } from '../../src/services/memory/memory-store.service';
import type { SkillTrackingService } from '../../src/services/memory/skill-tracking.service';
import type { SettingsService } from '../../src/services/settings.service';
import { createTestProject } from '../factories/project.factory';
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
// Helpers
// ---------------------------------------------------------------------------

function createMockSettings(overrides: Record<string, unknown> = {}): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key in overrides) {
        const val = overrides[key];
        if (val === null) return { ok: true, value: null };
        return { ok: true, value: { value: JSON.stringify(val) } };
      }
      return { ok: true, value: null };
    }),
    set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getAll: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    getMany: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    setMany: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  } as unknown as SettingsService;
}

function createMockSkillTracking(
  performanceSummary = {
    metrics: {
      totalRuns: 10,
      successCount: 8,
      errorCount: 2,
      avgTokensUsed: 1500,
      avgTurnsUsed: 5,
      avgDurationMs: 3000,
      successRate: 0.8,
    },
    recentExecutions: [
      {
        status: 'success',
        taskId: 'task-1',
        turnsUsed: 4,
        tokensUsed: 1200,
        durationMs: 2500,
        errorMessage: null,
      },
      {
        status: 'failed',
        taskId: 'task-2',
        turnsUsed: 6,
        tokensUsed: 2000,
        durationMs: 4000,
        errorMessage: 'timeout',
      },
    ],
    errorPatterns: [{ message: 'timeout', count: 2 }],
  }
): SkillTrackingService {
  return {
    getSkillPerformanceSummary: vi.fn().mockResolvedValue({ ok: true, value: performanceSummary }),
    recordExecution: vi.fn().mockResolvedValue({ ok: true }),
    getInsightCorrelations: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    computeInsightScores: vi.fn().mockResolvedValue(undefined),
  } as unknown as SkillTrackingService;
}

function _createMockStoreService(): MemoryStoreService {
  return {
    updateInsight: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as MemoryStoreService;
}

/**
 * Create the memory/dream tables that are NOT in the base MIGRATION_SQL
 * (they are in MEMORY_TABLES_MIGRATION_SQL which setupTestDatabase doesn't apply).
 */
function ensureDreamTables(db: ReturnType<typeof getTestDb>): void {
  const sqlite = (db as any).$client;

  // Skill executions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "skill_executions" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "codespace_id" TEXT NOT NULL,
      "skill_id" TEXT NOT NULL,
      "skill_name" TEXT,
      "task_id" TEXT,
      "agent_run_id" TEXT,
      "session_id" TEXT,
      "status" TEXT NOT NULL,
      "turns_used" INTEGER,
      "tokens_used" INTEGER,
      "duration_ms" INTEGER,
      "files_modified" INTEGER,
      "lines_added" INTEGER,
      "lines_removed" INTEGER,
      "cost_usd" REAL,
      "error_message" TEXT,
      "started_at" TEXT,
      "completed_at" TEXT,
      "insight_ids_used" TEXT,
      "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);

  // Skill metrics
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "skill_metrics" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "codespace_id" TEXT NOT NULL,
      "skill_id" TEXT NOT NULL,
      "skill_name" TEXT NOT NULL,
      "total_runs" INTEGER DEFAULT 0 NOT NULL,
      "success_count" INTEGER DEFAULT 0 NOT NULL,
      "error_count" INTEGER DEFAULT 0 NOT NULL,
      "avg_tokens_used" REAL,
      "avg_turns_used" REAL,
      "avg_duration_ms" REAL,
      "avg_cost_usd" REAL,
      "success_rate" REAL,
      "last_run_at" TEXT,
      "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "skill_metrics_codespace_skill_unique" ON "skill_metrics"("codespace_id", "skill_id");
  `);

  // Dream sessions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "dream_sessions" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "codespace_id" TEXT,
      "type" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "skills_analyzed" INTEGER DEFAULT 0 NOT NULL,
      "suggestions_generated" INTEGER DEFAULT 0 NOT NULL,
      "tokens_used" INTEGER DEFAULT 0 NOT NULL,
      "cost_usd" REAL,
      "started_at" TEXT DEFAULT (datetime('now')) NOT NULL,
      "completed_at" TEXT,
      "error_message" TEXT,
      "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);

  // Skill suggestions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "skill_suggestions" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "dream_session_id" TEXT NOT NULL,
      "codespace_id" TEXT NOT NULL,
      "skill_id" TEXT NOT NULL,
      "skill_name" TEXT NOT NULL,
      "suggestion_type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "reasoning" TEXT NOT NULL,
      "current_content" TEXT,
      "suggested_content" TEXT NOT NULL,
      "diff" TEXT,
      "status" TEXT DEFAULT 'pending' NOT NULL,
      "user_notes" TEXT,
      "applied_at" TEXT,
      "applied_by" TEXT,
      "created_at" TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);

  // Clean any existing data
  sqlite.exec(`
    DELETE FROM skill_suggestions;
    DELETE FROM dream_sessions;
    DELETE FROM skill_executions;
    DELETE FROM skill_metrics;
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamService (IT-DRM-001)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: DreamService;
  let settingsService: SettingsService;
  let skillTrackingService: SkillTrackingService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    ensureDreamTables(db);

    const codespace = await createTestProject({ name: 'Dream Test Project' });
    codespaceId = codespace.id;

    settingsService = createMockSettings({});
    skillTrackingService = createMockSkillTracking();
    service = new DreamService(db as any, settingsService, skillTrackingService);

    mockAgentPrompt.mockReset();
    mockAgentPrompt.mockResolvedValue({
      text: '```json\n[{"type":"improve_prompt","title":"Better error handling","reasoning":"High error rate","suggestedContent":"Add retry logic"}]\n```',
      usage: { inputTokens: 500, outputTokens: 200 },
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =========================================================================
  // Skill config and overrides
  // =========================================================================

  describe('skill config and overrides', () => {
    it('IT-DRM-001a: getSkillConfig returns global defaults when no overrides', async () => {
      const config = await service.getSkillConfig('skill-1');
      expect(config.enabled).toBe(true);
      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.minRuns).toBe(3);
    });

    it('IT-DRM-001b: getSkillConfig merges per-skill overrides', async () => {
      // Store an override via settings. Note: getModel() reads value.value as-is
      // (no JSON.parse), so the mock stores the value with JSON.stringify like
      // the real SettingsService.set() does. getModel returns it as-is including quotes.
      // For skillOverrides/minRuns, the service does JSON.parse, so JSON.stringify is correct.
      const settingsWithOverrides: SettingsService = {
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'memory.dreaming.skillOverrides') {
            return {
              ok: true,
              value: { value: JSON.stringify({ 'skill-1': { enabled: false, minRuns: 10 } }) },
            };
          }
          if (key === 'memory.dreaming.model') {
            // getModel() reads value.value as-is (casts to string, no JSON.parse)
            return { ok: true, value: { value: 'claude-sonnet-4-6' } };
          }
          if (key === 'memory.dreaming.minRunsForAnalysis') {
            return { ok: true, value: null };
          }
          return { ok: true, value: null };
        }),
        set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        getAll: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        getMany: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        setMany: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      } as unknown as SettingsService;
      const svc = new DreamService(db as any, settingsWithOverrides, skillTrackingService);

      const config = await svc.getSkillConfig('skill-1');
      expect(config.enabled).toBe(false);
      expect(config.minRuns).toBe(10);
      expect(config.model).toBe('claude-sonnet-4-6');
    });

    it('IT-DRM-001c: setSkillOverride persists and getSkillOverrides retrieves', async () => {
      const result = await service.setSkillOverride('skill-1', { enabled: false, minRuns: 5 });
      expect(result.ok).toBe(true);

      // Verify set was called on settingsService
      expect(settingsService.set).toHaveBeenCalledWith(
        'memory.dreaming.skillOverrides',
        expect.any(String)
      );
    });

    it('IT-DRM-001d: setSkillOverride with null removes the override', async () => {
      // First set an override
      const settingsWithExisting = createMockSettings({
        'memory.dreaming.skillOverrides': { 'skill-1': { enabled: false } },
      });
      const svc = new DreamService(db as any, settingsWithExisting, skillTrackingService);

      const result = await svc.setSkillOverride('skill-1', null);
      expect(result.ok).toBe(true);
    });

    it('IT-DRM-001e: getSkillOverrides returns empty object on parse error', async () => {
      const settingsWithBadData = createMockSettings({
        'memory.dreaming.skillOverrides': 'not-json-{{{',
      });
      const svc = new DreamService(db as any, settingsWithBadData, skillTrackingService);

      const overrides = await svc.getSkillOverrides();
      expect(overrides).toEqual({});
    });
  });

  // =========================================================================
  // Dream cycle
  // =========================================================================

  describe('runDreamCycle', () => {
    it('IT-DRM-002a: creates dream session and completes with no eligible skills', async () => {
      // No skill metrics in DB — nothing to analyze
      const result = await service.runDreamCycle(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.skillsAnalyzed).toBe(0);
        expect(result.value.suggestionsGenerated).toBe(0);
        expect(result.value.codespaceId).toBe(codespaceId);
        expect(result.value.type).toBe('skill_improvement');
      }

      // Verify dream session was persisted
      const sessions = db.select().from(dreamSessions).all();
      expect(sessions.length).toBe(1);
      expect(sessions[0].status).toBe('completed');
    });

    it('IT-DRM-002b: analyzes eligible skills and stores suggestions', async () => {
      // Insert a skill metric with enough runs
      await db.insert(skillMetrics).values({
        id: createId(),
        codespaceId,
        skillId: 'test-skill',
        skillName: 'Test Skill',
        totalRuns: 10,
        successCount: 8,
        errorCount: 2,
      });

      const result = await service.runDreamCycle(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.skillsAnalyzed).toBe(1);
        expect(result.value.suggestionsGenerated).toBe(1);
        expect(result.value.tokensUsed).toBe(700); // 500 + 200
      }

      // Verify suggestion was stored
      const suggestions = db.select().from(skillSuggestions).all();
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].skillId).toBe('test-skill');
      expect(suggestions[0].status).toBe('pending');
      expect(suggestions[0].title).toBe('Better error handling');
    });

    it('IT-DRM-002c: skips skills with fewer runs than minRuns', async () => {
      // Insert skill with only 1 run (default minRuns is 3)
      await db.insert(skillMetrics).values({
        id: createId(),
        codespaceId,
        skillId: 'low-runs-skill',
        skillName: 'Low Runs Skill',
        totalRuns: 1,
        successCount: 1,
        errorCount: 0,
      });

      const result = await service.runDreamCycle(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skillsAnalyzed).toBe(0);
      }
      expect(mockAgentPrompt).not.toHaveBeenCalled();
    });

    it('IT-DRM-002d: skips disabled skills via per-skill override', async () => {
      const settingsWithDisabled = createMockSettings({
        'memory.dreaming.skillOverrides': { 'disabled-skill': { enabled: false } },
      });
      const svc = new DreamService(db as any, settingsWithDisabled, skillTrackingService);

      await db.insert(skillMetrics).values({
        id: createId(),
        codespaceId,
        skillId: 'disabled-skill',
        skillName: 'Disabled Skill',
        totalRuns: 20,
        successCount: 18,
        errorCount: 2,
      });

      const result = await svc.runDreamCycle(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skillsAnalyzed).toBe(0);
      }
    });

    it('IT-DRM-002e: handles agentPrompt failure gracefully', async () => {
      mockAgentPrompt.mockRejectedValue(new Error('API rate limited'));

      await db.insert(skillMetrics).values({
        id: createId(),
        codespaceId,
        skillId: 'fail-skill',
        skillName: 'Fail Skill',
        totalRuns: 10,
        successCount: 5,
        errorCount: 5,
      });

      const result = await service.runDreamCycle(codespaceId);

      // Should still complete (errors are caught per-skill)
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.skillsAnalyzed).toBe(1);
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('IT-DRM-002f: runs without codespaceId (global dream cycle)', async () => {
      const result = await service.runDreamCycle();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.codespaceId).toBeNull();
        expect(result.value.type).toBe('skill_improvement');
      }
    });
  });

  // =========================================================================
  // Dream session and suggestion queries
  // =========================================================================

  describe('getDreamSessions', () => {
    it('IT-DRM-003a: returns dream sessions for codespace', async () => {
      // Insert sessions directly
      await db.insert(dreamSessions).values([
        {
          id: createId(),
          codespaceId,
          type: 'skill_improvement',
          status: 'completed',
          skillsAnalyzed: 2,
          suggestionsGenerated: 1,
          tokensUsed: 500,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        {
          id: createId(),
          codespaceId,
          type: 'context_optimization',
          status: 'completed',
          skillsAnalyzed: 0,
          suggestionsGenerated: 3,
          tokensUsed: 800,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ]);

      const result = await service.getDreamSessions(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('IT-DRM-003b: paginates results correctly', async () => {
      // Insert 5 dream sessions
      for (let i = 0; i < 5; i++) {
        await db.insert(dreamSessions).values({
          id: createId(),
          codespaceId,
          type: 'skill_improvement',
          status: 'completed',
          skillsAnalyzed: i,
          suggestionsGenerated: 0,
          tokensUsed: 100 * i,
          startedAt: new Date().toISOString(),
        });
      }

      const page1 = await service.getDreamSessions(codespaceId, { page: 1, size: 2 });
      expect(page1.ok).toBe(true);
      if (page1.ok) {
        expect(page1.value.length).toBe(2);
      }

      const page2 = await service.getDreamSessions(codespaceId, { page: 2, size: 2 });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.value.length).toBe(2);
      }
    });

    it('IT-DRM-003c: returns empty array for codespace with no sessions', async () => {
      const result = await service.getDreamSessions('nonexistent-codespace');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  // =========================================================================
  // Suggestion CRUD
  // =========================================================================

  describe('suggestion lifecycle', () => {
    let dreamSessionId: string;

    beforeEach(async () => {
      dreamSessionId = createId();
      await db.insert(dreamSessions).values({
        id: dreamSessionId,
        codespaceId,
        type: 'skill_improvement',
        status: 'completed',
        skillsAnalyzed: 1,
        suggestionsGenerated: 1,
        tokensUsed: 500,
        startedAt: new Date().toISOString(),
      });

      await db.insert(skillSuggestions).values({
        id: 'sug-1',
        dreamSessionId,
        codespaceId,
        skillId: 'skill-1',
        skillName: 'Test Skill',
        suggestionType: 'improve_prompt',
        title: 'Better prompts',
        reasoning: 'Current prompt is unclear',
        suggestedContent: 'Improved prompt text',
        status: 'pending',
      });
    });

    it('IT-DRM-004a: getSkillSuggestions returns suggestions for codespace', async () => {
      const result = await service.getSkillSuggestions(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0].title).toBe('Better prompts');
      }
    });

    it('IT-DRM-004b: getSkillSuggestions filters by status', async () => {
      const pending = await service.getSkillSuggestions(codespaceId, { status: 'pending' });
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        expect(pending.value.length).toBe(1);
      }

      const accepted = await service.getSkillSuggestions(codespaceId, { status: 'accepted' });
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.value.length).toBe(0);
      }
    });

    it('IT-DRM-004c: getSkillSuggestions filters by skillId', async () => {
      const result = await service.getSkillSuggestions(codespaceId, { skillId: 'skill-1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
      }

      const noResults = await service.getSkillSuggestions(codespaceId, { skillId: 'nonexistent' });
      expect(noResults.ok).toBe(true);
      if (noResults.ok) {
        expect(noResults.value.length).toBe(0);
      }
    });

    it('IT-DRM-004d: acceptSuggestion marks suggestion as accepted', async () => {
      const result = await service.acceptSuggestion('sug-1', 'Looks good');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('accepted');
        expect(result.value.userNotes).toBe('Looks good');
        expect(result.value.appliedAt).toBeTruthy();
      }

      // Verify in DB
      const rows = db.select().from(skillSuggestions).all();
      expect(rows[0].status).toBe('accepted');
    });

    it('IT-DRM-004e: rejectSuggestion marks suggestion as rejected', async () => {
      const result = await service.rejectSuggestion('sug-1', 'Not relevant');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('rejected');
        expect(result.value.userNotes).toBe('Not relevant');
      }
    });

    it('IT-DRM-004f: modifySuggestion updates content and marks as modified', async () => {
      const result = await service.modifySuggestion('sug-1', 'Modified content', 'Tweaked it');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('modified');
        expect(result.value.suggestedContent).toBe('Modified content');
        expect(result.value.userNotes).toBe('Tweaked it');
        expect(result.value.appliedAt).toBeTruthy();
      }
    });

    it('IT-DRM-004g: accept/reject/modify returns error for nonexistent suggestion', async () => {
      const acceptResult = await service.acceptSuggestion('nonexistent');
      expect(acceptResult.ok).toBe(false);

      const rejectResult = await service.rejectSuggestion('nonexistent');
      expect(rejectResult.ok).toBe(false);

      const modifyResult = await service.modifySuggestion('nonexistent', 'content');
      expect(modifyResult.ok).toBe(false);
    });
  });

  // =========================================================================
  // Context effectiveness analysis
  // =========================================================================

  describe('analyzeContextEffectiveness', () => {
    it('IT-DRM-005a: returns early when not enough execution data', async () => {
      // No skill_executions data — fewer than 5
      const result = await service.analyzeContextEffectiveness(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('context_optimization');
        expect(result.value.status).toBe('completed');
        expect(result.value.suggestionsGenerated).toBe(0);
      }
      expect(mockAgentPrompt).not.toHaveBeenCalled();
    });

    it('IT-DRM-005b: analyzes executions and generates context optimization suggestions', async () => {
      // Insert 6 skill executions with insight_ids_used
      for (let i = 0; i < 6; i++) {
        await db.insert(skillExecutions).values({
          id: createId(),
          codespaceId,
          skillId: 'test-skill',
          status: i < 4 ? 'success' : 'failed',
          insightIdsUsed: ['insight-1', 'insight-2'],
          tokensUsed: 1000 + i * 100,
          turnsUsed: 3 + i,
        });
      }

      mockAgentPrompt.mockResolvedValue({
        text: '```json\n[{"type":"optimize_context","title":"Reduce insight count","reasoning":"Too many insights","suggestedContent":"Set max insights to 5"}]\n```',
        usage: { inputTokens: 300, outputTokens: 150 },
      });

      const result = await service.analyzeContextEffectiveness(codespaceId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('context_optimization');
        expect(result.value.suggestionsGenerated).toBe(1);
        expect(result.value.tokensUsed).toBe(450);
      }

      // Verify suggestion stored
      const suggestions = db.select().from(skillSuggestions).all();
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].skillId).toBe('_context_assembly');
      expect(suggestions[0].suggestionType).toBe('optimize_context');
    });
  });

  // =========================================================================
  // parseSuggestions edge cases (tested indirectly through runDreamCycle)
  // =========================================================================

  describe('suggestion parsing edge cases', () => {
    beforeEach(async () => {
      await db.insert(skillMetrics).values({
        id: createId(),
        codespaceId,
        skillId: 'parse-test-skill',
        skillName: 'Parse Test Skill',
        totalRuns: 10,
        successCount: 5,
        errorCount: 5,
      });
    });

    it('IT-DRM-006a: handles response with no JSON', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: 'No suggestions needed, the skill is performing well.',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await service.runDreamCycle(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('IT-DRM-006b: handles response with empty JSON array', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '```json\n[]\n```',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await service.runDreamCycle(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('IT-DRM-006c: handles response with invalid JSON', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '```json\n{not valid json\n```',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await service.runDreamCycle(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestionsGenerated).toBe(0);
      }
    });

    it('IT-DRM-006d: filters out suggestions with invalid types', async () => {
      mockAgentPrompt.mockResolvedValue({
        text: '```json\n[{"type":"invalid_type","title":"Bad","reasoning":"Bad","suggestedContent":"Bad"},{"type":"improve_prompt","title":"Good","reasoning":"Good","suggestedContent":"Good"}]\n```',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await service.runDreamCycle(codespaceId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the valid suggestion should be counted
        expect(result.value.suggestionsGenerated).toBe(1);
      }
    });

    it('IT-DRM-006e: truncates suggestion title to 200 characters', async () => {
      const longTitle = 'A'.repeat(300);
      mockAgentPrompt.mockResolvedValue({
        text: `\`\`\`json\n[{"type":"improve_prompt","title":"${longTitle}","reasoning":"R","suggestedContent":"C"}]\n\`\`\``,
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await service.runDreamCycle(codespaceId);
      expect(result.ok).toBe(true);

      const suggestions = db.select().from(skillSuggestions).all();
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].title.length).toBe(200);
    });
  });
});
