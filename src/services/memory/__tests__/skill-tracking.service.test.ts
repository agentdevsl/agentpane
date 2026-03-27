// @ts-nocheck — test mocks use loose types
import { describe, expect, it, vi } from 'vitest';
import { SkillTrackingService } from '../skill-tracking.service.js';
import type { SkillExecution, SkillMetrics } from '../types.js';

// ---------------------------------------------------------------------------
// Mock DB + dynamic import helpers
// ---------------------------------------------------------------------------

const mockSkillExecution: SkillExecution = {
  id: 'exec-1',
  codespaceId: 'cs-1',
  skillId: 'skill-deploy',
  skillName: 'Deploy Service',
  taskId: 'task-1',
  agentRunId: 'run-1',
  sessionId: 'sess-1',
  status: 'success',
  turnsUsed: 10,
  tokensUsed: 5000,
  durationMs: 30000,
  filesModified: 3,
  linesAdded: 50,
  linesRemoved: 10,
  costUsd: 0.05,
  errorMessage: null,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  createdAt: '2026-01-01T00:01:00Z',
};

const mockSkillMetrics: SkillMetrics = {
  id: 'met-1',
  codespaceId: 'cs-1',
  skillId: 'skill-deploy',
  skillName: 'Deploy Service',
  totalRuns: 10,
  successCount: 8,
  errorCount: 2,
  avgTokensUsed: 4500,
  avgTurnsUsed: 8,
  avgDurationMs: 25000,
  avgCostUsd: 0.04,
  successRate: 0.8,
  lastRunAt: '2026-01-01T00:01:00Z',
  updatedAt: '2026-01-01T00:02:00Z',
};

// Mock the dynamic schema import used by SkillTrackingService
vi.mock('../../db/schema/index.js', () => ({
  skillExecutions: {
    id: 'id',
    codespaceId: 'codespaceId',
    skillId: 'skillId',
    skillName: 'skillName',
    status: 'status',
    turnsUsed: 'turnsUsed',
    tokensUsed: 'tokensUsed',
    durationMs: 'durationMs',
    costUsd: 'costUsd',
    errorMessage: 'errorMessage',
    completedAt: 'completedAt',
    createdAt: 'createdAt',
  },
  skillMetrics: {
    id: 'id',
    codespaceId: 'codespaceId',
    skillId: 'skillId',
    skillName: 'skillName',
    lastRunAt: 'lastRunAt',
  },
}));

function createMockDb() {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
  };

  return {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    select: vi.fn().mockReturnValue({
      ...selectChain,
      from: vi.fn().mockReturnValue(selectChain),
    }),
    query: {
      skillMetrics: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    _insertValues: insertValues,
    _updateSet: updateSet,
    _selectChain: selectChain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillTrackingService', () => {
  // -------------------------------------------------------------------------
  // recordExecution
  // -------------------------------------------------------------------------

  describe('recordExecution()', () => {
    it('inserts skill_executions record and returns SkillExecution', async () => {
      const db = createMockDb();
      const service = new SkillTrackingService(db as never);

      const result = await service.recordExecution({
        codespaceId: 'cs-1',
        skillId: 'skill-deploy',
        skillName: 'Deploy Service',
        taskId: 'task-1',
        agentRunId: 'run-1',
        sessionId: 'sess-1',
        status: 'success',
        turnsUsed: 10,
        tokensUsed: 5000,
        durationMs: 30000,
        filesModified: 3,
        linesAdded: 50,
        linesRemoved: 10,
        costUsd: 0.05,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeDefined();
        expect(result.value.codespaceId).toBe('cs-1');
        expect(result.value.skillId).toBe('skill-deploy');
        expect(result.value.status).toBe('success');
        expect(result.value.turnsUsed).toBe(10);
        expect(result.value.tokensUsed).toBe(5000);
      }
      expect(db.insert).toHaveBeenCalled();
    });

    it('defaults optional numeric fields to null', async () => {
      const db = createMockDb();
      const service = new SkillTrackingService(db as never);

      const result = await service.recordExecution({
        codespaceId: 'cs-1',
        skillId: 'skill-test',
        skillName: null,
        taskId: null,
        agentRunId: null,
        sessionId: null,
        status: 'failed',
        errorMessage: 'Something broke',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turnsUsed).toBeNull();
        expect(result.value.tokensUsed).toBeNull();
        expect(result.value.durationMs).toBeNull();
        expect(result.value.filesModified).toBeNull();
        expect(result.value.linesAdded).toBeNull();
        expect(result.value.linesRemoved).toBeNull();
        expect(result.value.costUsd).toBeNull();
        expect(result.value.errorMessage).toBe('Something broke');
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb();
      db._insertValues.mockRejectedValue(new Error('constraint violation'));
      const service = new SkillTrackingService(db as never);

      const result = await service.recordExecution({
        codespaceId: 'cs-1',
        skillId: 'skill-x',
        skillName: null,
        taskId: null,
        agentRunId: null,
        sessionId: null,
        status: 'success',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // refreshMetrics
  // -------------------------------------------------------------------------

  describe('refreshMetrics()', () => {
    it('aggregates from executions and inserts new metrics when none exist', async () => {
      const db = createMockDb();
      // Mock the aggregation query result
      const selectChain = db.select();
      const fromChain = selectChain.from('skillExecutions');
      fromChain.where.mockReturnThis();
      fromChain.groupBy.mockResolvedValue([
        {
          skillId: 'skill-deploy',
          skillName: 'Deploy',
          totalRuns: 5,
          successCount: 4,
          errorCount: 1,
          avgTokensUsed: 3000,
          avgTurnsUsed: 7,
          avgDurationMs: 20000,
          avgCostUsd: 0.03,
          lastRunAt: '2026-01-01T00:00:00Z',
        },
      ]);

      // findFirst returns null (no existing metrics)
      db.query.skillMetrics.findFirst.mockResolvedValue(null);

      const service = new SkillTrackingService(db as never);
      const result = await service.refreshMetrics('cs-1', 'skill-deploy');

      expect(result.ok).toBe(true);
      // Should have inserted new metrics
      expect(db.insert).toHaveBeenCalled();
    });

    it('updates existing metrics when they already exist', async () => {
      const db = createMockDb();
      const selectChain = db.select();
      const fromChain = selectChain.from('skillExecutions');
      fromChain.where.mockReturnThis();
      fromChain.groupBy.mockResolvedValue([
        {
          skillId: 'skill-deploy',
          skillName: 'Deploy',
          totalRuns: 10,
          successCount: 8,
          errorCount: 2,
          avgTokensUsed: 4000,
          avgTurnsUsed: 8,
          avgDurationMs: 25000,
          avgCostUsd: 0.04,
          lastRunAt: '2026-01-01T00:00:00Z',
        },
      ]);

      // findFirst returns existing metrics
      db.query.skillMetrics.findFirst.mockResolvedValue({
        id: 'met-1',
        skillName: 'Deploy',
      });

      const service = new SkillTrackingService(db as never);
      const result = await service.refreshMetrics('cs-1', 'skill-deploy');

      expect(result.ok).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('returns err on database error', async () => {
      const db = createMockDb();
      const selectChain = db.select();
      selectChain.from.mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockRejectedValue(new Error('DB crash')),
        }),
      });

      const service = new SkillTrackingService(db as never);
      const result = await service.refreshMetrics('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getMetrics
  // -------------------------------------------------------------------------

  describe('getMetrics()', () => {
    it('queries skill_metrics for codespace', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findMany.mockResolvedValue([mockSkillMetrics]);

      const service = new SkillTrackingService(db as never);
      const result = await service.getMetrics('cs-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].skillId).toBe('skill-deploy');
        expect(result.value[0].totalRuns).toBe(10);
      }
    });

    it('filters by skillId when provided', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findMany.mockResolvedValue([mockSkillMetrics]);

      const service = new SkillTrackingService(db as never);
      const result = await service.getMetrics('cs-1', 'skill-deploy');

      expect(result.ok).toBe(true);
      expect(db.query.skillMetrics.findMany).toHaveBeenCalled();
    });

    it('returns empty array when no metrics exist', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findMany.mockResolvedValue([]);

      const service = new SkillTrackingService(db as never);
      const result = await service.getMetrics('cs-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findMany.mockRejectedValue(new Error('query failed'));

      const service = new SkillTrackingService(db as never);
      const result = await service.getMetrics('cs-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getExecutionHistory
  // -------------------------------------------------------------------------

  describe('getExecutionHistory()', () => {
    it('returns paginated execution history', async () => {
      const db = createMockDb();
      const selectChain = db.select();
      const fromChain = selectChain.from('skillExecutions');
      fromChain.where.mockReturnThis();
      fromChain.orderBy.mockReturnThis();
      fromChain.limit.mockReturnThis();
      fromChain.offset.mockResolvedValue([mockSkillExecution]);

      const service = new SkillTrackingService(db as never);
      const result = await service.getExecutionHistory('cs-1', 'skill-deploy', {
        page: 1,
        size: 20,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].skillId).toBe('skill-deploy');
      }
    });

    it('defaults to page=1 size=20 when options not provided', async () => {
      const db = createMockDb();
      const selectChain = db.select();
      const fromChain = selectChain.from('skillExecutions');
      fromChain.where.mockReturnThis();
      fromChain.orderBy.mockReturnThis();
      fromChain.limit.mockReturnThis();
      fromChain.offset.mockResolvedValue([]);

      const service = new SkillTrackingService(db as never);
      const result = await service.getExecutionHistory('cs-1', 'skill-deploy');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb();
      const selectChain = db.select();
      selectChain.from.mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockRejectedValue(new Error('timeout')),
            }),
          }),
        }),
      });

      const service = new SkillTrackingService(db as never);
      const result = await service.getExecutionHistory('cs-1', 'skill-deploy');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getSkillPerformanceSummary
  // -------------------------------------------------------------------------

  describe('getSkillPerformanceSummary()', () => {
    it('returns combined metrics, recent executions, and error patterns', async () => {
      const db = createMockDb();

      // Mock metrics query
      db.query.skillMetrics.findFirst.mockResolvedValue(mockSkillMetrics);

      // Mock recent executions
      const selectChain = db.select();
      const fromChain = selectChain.from('skillExecutions');
      fromChain.where.mockReturnThis();
      fromChain.orderBy.mockReturnThis();
      fromChain.limit.mockReturnThis();
      fromChain.groupBy.mockReturnThis();

      // For the chained calls - first select is for recent executions, second for error patterns
      let selectCallIdx = 0;
      db.select.mockImplementation(() => {
        selectCallIdx++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn(),
          groupBy: vi.fn(),
        };

        if (selectCallIdx === 1) {
          // Recent executions
          chain.limit.mockResolvedValue([mockSkillExecution]);
        } else {
          // Error patterns
          chain.limit.mockResolvedValue([{ message: 'Timeout error', count: 3 }]);
          chain.groupBy.mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ message: 'Timeout error', count: 3 }]),
            }),
          });
        }

        return chain;
      });

      const service = new SkillTrackingService(db as never);
      const result = await service.getSkillPerformanceSummary('cs-1', 'skill-deploy');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metrics).toBeDefined();
        expect(result.value.metrics?.skillId).toBe('skill-deploy');
      }
    });

    it('returns null metrics when no metrics exist', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findFirst.mockResolvedValue(null);

      // Mock select chains
      let _selectCallIdx = 0;
      db.select.mockImplementation(() => {
        _selectCallIdx++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
          groupBy: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
        return chain;
      });

      const service = new SkillTrackingService(db as never);
      const result = await service.getSkillPerformanceSummary('cs-1', 'skill-nonexistent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metrics).toBeNull();
        expect(result.value.recentExecutions).toEqual([]);
        expect(result.value.errorPatterns).toEqual([]);
      }
    });

    it('returns err on database error', async () => {
      const db = createMockDb();
      db.query.skillMetrics.findFirst.mockRejectedValue(new Error('DB error'));

      const service = new SkillTrackingService(db as never);
      const result = await service.getSkillPerformanceSummary('cs-1', 'skill-deploy');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_QUERY_ERROR');
      }
    });
  });
});
