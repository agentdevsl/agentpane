/**
 * Integration tests for the internal memory service.
 *
 * Tests use real in-memory SQLite database (via test helper) to verify
 * MemoryStoreService, MemoryService, and SkillTrackingService.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService } from '../../src/services/memory/memory.service';
import { MemoryStoreService } from '../../src/services/memory/memory-store.service';
import { SkillTrackingService } from '../../src/services/memory/skill-tracking.service';
import type { SettingsService } from '../../src/services/settings.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// SQL to create new memory tables (not yet in base migration)
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
  effectiveness_score REAL,
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_insights_status ON memory_insights(status);

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

CREATE TABLE IF NOT EXISTS skill_executions (
  id TEXT PRIMARY KEY,
  codespace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_name TEXT,
  task_id TEXT,
  agent_run_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  turns_used INTEGER,
  tokens_used INTEGER,
  duration_ms INTEGER,
  duration_api_ms INTEGER,
  files_modified INTEGER,
  lines_added INTEGER,
  lines_removed INTEGER,
  cost_usd REAL,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  insight_ids_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_metrics (
  id TEXT PRIMARY KEY,
  codespace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  total_runs INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  avg_tokens_used REAL,
  avg_turns_used REAL,
  avg_duration_ms REAL,
  avg_duration_api_ms REAL,
  avg_cost_usd REAL,
  success_rate REAL,
  last_run_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(codespace_id, skill_id)
);

CREATE TABLE IF NOT EXISTS dream_sessions (
  id TEXT PRIMARY KEY,
  codespace_id TEXT,
  type TEXT NOT NULL DEFAULT 'skill_improvement',
  status TEXT NOT NULL DEFAULT 'running',
  skills_analyzed INTEGER NOT NULL DEFAULT 0,
  suggestions_generated INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_suggestions (
  id TEXT PRIMARY KEY,
  dream_session_id TEXT NOT NULL,
  codespace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  suggestion_type TEXT NOT NULL DEFAULT 'improve_prompt',
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  current_content TEXT,
  suggested_content TEXT NOT NULL,
  diff TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_notes TEXT,
  applied_at TEXT,
  applied_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ---------------------------------------------------------------------------
// Mock SettingsService
// ---------------------------------------------------------------------------
function createMockSettings(overrides?: Record<string, unknown>): SettingsService {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'memory.enabled') {
        return { ok: true, value: { value: 'true' } };
      }
      if (key === 'memory.contextMaxTokens') {
        return { ok: true, value: { value: '2000' } };
      }
      if (overrides?.[key] !== undefined) {
        return { ok: true, value: { value: JSON.stringify(overrides[key]) } };
      }
      return { ok: true, value: null };
    }),
    getAll: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    getMany: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    setMany: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  } as unknown as SettingsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Memory Service Integration', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // F09-21 (arch29-W2-Q): the test harness now creates memory tables with
    // `REFERENCES codespaces(id) ON DELETE CASCADE` FKs. This test uses
    // arbitrary codespaceId values (e.g. `cs-test-1`) without seeding real
    // codespaces, so DROP+CREATE removes the FK and lets the existing test
    // logic work without rewriting the entire suite.
    (db as any).$client.exec(
      `DROP TABLE IF EXISTS skill_suggestions;
       DROP TABLE IF EXISTS dream_sessions;
       DROP TABLE IF EXISTS skill_metrics;
       DROP TABLE IF EXISTS skill_executions;
       DROP TABLE IF EXISTS memory_messages;
       DROP TABLE IF EXISTS memory_insights;`
    );
    // Create new memory tables — exec each statement separately
    for (const stmt of MEMORY_TABLES_SQL.split(';').filter((s) => s.trim())) {
      (db as any).$client.exec(`${stmt};`);
    }
    // Clean data from previous tests
    (db as any).$client.exec(
      'DELETE FROM skill_suggestions; DELETE FROM dream_sessions; DELETE FROM skill_metrics; DELETE FROM skill_executions; DELETE FROM memory_messages; DELETE FROM memory_insights;'
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =========================================================================
  // MemoryStoreService
  // =========================================================================
  describe('MemoryStoreService', () => {
    let store: MemoryStoreService;

    beforeEach(() => {
      store = new MemoryStoreService(db as any);
    });

    it('inserts and retrieves an insight', async () => {
      const result = await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'Always validate user input before DB queries',
        source: 'manual',
        tags: ['security', 'validation'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBeTruthy();
      expect(result.value.content).toBe('Always validate user input before DB queries');
      expect(result.value.source).toBe('manual');

      // Retrieve
      const getResult = await store.getInsights('cs-test-1');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value).toHaveLength(1);
      expect(getResult.value[0].content).toBe('Always validate user input before DB queries');
    });

    it('searches insights with keyword matching', async () => {
      await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'Use Drizzle ORM for type-safe database queries',
        source: 'manual',
      });
      await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'React components should be memoized for performance',
        source: 'manual',
      });

      const result = await store.searchInsights('cs-test-1', 'Drizzle');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].content).toContain('Drizzle');
    });

    it('escapes SQL LIKE wildcards in search query', async () => {
      await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'Use 100% coverage for critical paths',
        source: 'manual',
      });
      await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'Testing is important',
        source: 'manual',
      });

      // Searching for literal "%" should only match the insight that contains "%"
      const result = await store.searchInsights('cs-test-1', '100%');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].content).toContain('100%');
    });

    it('inserts and retrieves messages', async () => {
      const result = await store.insertMessage({
        codespaceId: 'cs-test-1',
        memorySessionId: 'msess-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        role: 'user',
        content: 'Fix the authentication bug',
        turnNumber: 1,
      });

      expect(result.ok).toBe(true);

      const msgs = await store.getMessages('msess-1');
      expect(msgs.ok).toBe(true);
      if (!msgs.ok) return;

      expect(msgs.value).toHaveLength(1);
      expect(msgs.value[0].content).toBe('Fix the authentication bug');
      expect(msgs.value[0].role).toBe('user');
      expect(msgs.value[0].turnNumber).toBe(1);
    });

    it('assembles context within token budget', async () => {
      // Insert several insights
      for (let i = 0; i < 10; i++) {
        await store.insertInsight({
          codespaceId: 'cs-test-1',
          content: `Insight number ${i}: ${'x'.repeat(100)}`,
          source: 'manual',
        });
      }

      // Assemble context with a small token budget
      const result = await store.assembleContext('cs-test-1', 'Insight', 100);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.sources.insights).toBeGreaterThan(0);
      expect(result.value.sources.insights).toBeLessThan(10);
    });

    it('deletes an insight', async () => {
      const insertResult = await store.insertInsight({
        codespaceId: 'cs-test-1',
        content: 'Temporary insight',
        source: 'manual',
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) return;

      const deleteResult = await store.deleteInsight(insertResult.value.id);
      expect(deleteResult.ok).toBe(true);

      const getResult = await store.getInsights('cs-test-1');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toHaveLength(0);
    });

    it('counts insights globally and per codespace', async () => {
      await store.insertInsight({
        codespaceId: 'cs-a',
        content: 'Insight A1',
        source: 'manual',
      });
      await store.insertInsight({
        codespaceId: 'cs-a',
        content: 'Insight A2',
        source: 'manual',
      });
      await store.insertInsight({
        codespaceId: 'cs-b',
        content: 'Insight B1',
        source: 'manual',
      });

      // Per codespace
      const countA = await store.getInsightCount('cs-a');
      expect(countA.ok).toBe(true);
      if (countA.ok) expect(countA.value).toBe(2);

      const countB = await store.getInsightCount('cs-b');
      expect(countB.ok).toBe(true);
      if (countB.ok) expect(countB.value).toBe(1);

      // Global
      const countAll = await store.getInsightCount();
      expect(countAll.ok).toBe(true);
      if (countAll.ok) expect(countAll.value).toBe(3);
    });

    it('paginates insights', async () => {
      for (let i = 0; i < 5; i++) {
        await store.insertInsight({
          codespaceId: 'cs-test-1',
          content: `Paginated insight ${i}`,
          source: 'manual',
        });
      }

      const page1 = await store.getInsights('cs-test-1', { page: 1, size: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value).toHaveLength(2);

      const page2 = await store.getInsights('cs-test-1', { page: 2, size: 2 });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value).toHaveLength(2);

      const page3 = await store.getInsights('cs-test-1', { page: 3, size: 2 });
      expect(page3.ok).toBe(true);
      if (!page3.ok) return;
      expect(page3.value).toHaveLength(1);
    });
  });

  // =========================================================================
  // MemoryService (facade)
  // =========================================================================
  describe('MemoryService', () => {
    let service: MemoryService;

    beforeEach(async () => {
      const settings = createMockSettings();

      service = new MemoryService(settings, db as any);
      await service.initialize();
    });

    it('initializes and reports as available', () => {
      expect(service.isAvailable()).toBe(true);
    });

    it('creates and retrieves insights', async () => {
      const createResult = await service.createInsight(
        'cs-test-1',
        'Always use Result pattern for error handling',
        'manual',
        undefined,
        ['patterns'],
        'skill-1'
      );

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      expect(createResult.value.content).toBe('Always use Result pattern for error handling');

      const getResult = await service.getInsights('cs-test-1');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toHaveLength(1);
    });

    it('searches insights', async () => {
      await service.createInsight('cs-test-1', 'TypeScript strict mode prevents null errors');
      await service.createInsight('cs-test-1', 'React hooks must follow rules');

      const result = await service.search('cs-test-1', 'TypeScript');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].content).toContain('TypeScript');
      expect(result.value[0].type).toBe('insight');
    });

    it('manages session start and message capture', async () => {
      // Start session
      const ref = await service.startSession({
        codespaceId: 'cs-test-1',
        agentId: 'agent-1',
        taskId: 'task-1',
      });

      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(ref.memorySessionId).toBeTruthy();

      // Capture messages
      await service.captureMessage(ref, {
        role: 'user',
        content: 'Fix the login bug',
        turnNumber: 1,
      });

      await service.captureMessage(ref, {
        role: 'assistant',
        content: 'Found the issue in auth.ts',
        turnNumber: 2,
      });

      // Note: finalizeSession() calls Claude API for insight derivation,
      // which requires a real API key. Skip it in integration tests.
    });

    it('gets context for a codespace', async () => {
      await service.createInsight('cs-test-1', 'Use Drizzle for database access');
      await service.createInsight('cs-test-1', 'Always handle errors with Result type');

      const result = await service.getContext('cs-test-1', 'database');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sources.insights).toBeGreaterThan(0);
    });

    it('healthCheck returns real counts', async () => {
      await service.createInsight('cs-test-1', 'Test insight 1');
      await service.createInsight('cs-test-1', 'Test insight 2');

      const result = await service.healthCheck();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.available).toBe(true);
      expect(result.value.insightCount).toBe(2);
    });

    it('deletes an insight', async () => {
      const createResult = await service.createInsight('cs-test-1', 'To be deleted');
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const deleteResult = await service.deleteInsight(createResult.value.id);
      expect(deleteResult.ok).toBe(true);

      const getResult = await service.getInsights('cs-test-1');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toHaveLength(0);
    });
  });

  // =========================================================================
  // SkillTrackingService
  // =========================================================================
  describe('SkillTrackingService', () => {
    let tracking: SkillTrackingService;

    beforeEach(() => {
      tracking = new SkillTrackingService(db as any);
    });

    it('records a skill execution', async () => {
      const result = await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy Service',
        status: 'success',
        turnsUsed: 8,
        tokensUsed: 4000,
        durationMs: 25000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.skillId).toBe('skill-deploy');
      expect(result.value.status).toBe('success');
    });

    it('refreshes metrics after recording executions', async () => {
      // Record several executions
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy Service',
        status: 'success',
        turnsUsed: 8,
        tokensUsed: 4000,
        durationMs: 25000,
      });
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy Service',
        status: 'failed',
        turnsUsed: 10,
        tokensUsed: 5000,
        durationMs: 30000,
        errorMessage: 'Timeout error',
      });
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy Service',
        status: 'success',
        turnsUsed: 6,
        tokensUsed: 3000,
        durationMs: 20000,
      });

      // Refresh metrics
      const refreshResult = await tracking.refreshMetrics('cs-test-1', 'skill-deploy');
      expect(refreshResult.ok).toBe(true);

      // Get metrics
      const metricsResult = await tracking.getMetrics('cs-test-1', 'skill-deploy');
      expect(metricsResult.ok).toBe(true);
      if (!metricsResult.ok) return;

      expect(metricsResult.value).toHaveLength(1);
      const metrics = metricsResult.value[0];
      expect(metrics.totalRuns).toBe(3);
      expect(metrics.successCount).toBe(2);
      expect(metrics.errorCount).toBe(1);
    });

    it('retrieves execution history with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await tracking.recordExecution({
          codespaceId: 'cs-test-1',
          skillId: 'skill-deploy',
          skillName: 'Deploy Service',
          status: i % 2 === 0 ? 'success' : 'failed',
          turnsUsed: 5 + i,
          tokensUsed: 2000 + i * 500,
          durationMs: 15000 + i * 2000,
        });
      }

      const page1 = await tracking.getExecutionHistory('cs-test-1', 'skill-deploy', {
        page: 1,
        size: 2,
      });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value).toHaveLength(2);

      const page2 = await tracking.getExecutionHistory('cs-test-1', 'skill-deploy', {
        page: 2,
        size: 2,
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value).toHaveLength(2);
    });

    it('gets performance summary with error patterns', async () => {
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy',
        status: 'success',
        turnsUsed: 5,
        tokensUsed: 2000,
        durationMs: 10000,
      });
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy',
        status: 'failed',
        turnsUsed: 8,
        tokensUsed: 3000,
        durationMs: 15000,
        errorMessage: 'Connection timeout',
      });
      await tracking.recordExecution({
        codespaceId: 'cs-test-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy',
        status: 'failed',
        turnsUsed: 7,
        tokensUsed: 2500,
        durationMs: 12000,
        errorMessage: 'Connection timeout',
      });

      await tracking.refreshMetrics('cs-test-1', 'skill-deploy');

      const result = await tracking.getSkillPerformanceSummary('cs-test-1', 'skill-deploy');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metrics).toBeTruthy();
      expect(result.value.recentExecutions).toHaveLength(3);
      expect(result.value.errorPatterns.length).toBeGreaterThan(0);
      expect(result.value.errorPatterns[0].message).toBe('Connection timeout');
      expect(result.value.errorPatterns[0].count).toBe(2);
    });
  });
});
