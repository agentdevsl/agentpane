/**
 * SkillTrackingService — Records skill execution metrics and computes aggregates.
 *
 * Tracks per-run data in skill_executions and materializes aggregates in skill_metrics.
 * Called after agent runs complete for tasks with associated skills.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { PaginationOptions, SkillExecution, SkillMetrics } from './types.js';

const log = createLogger('SkillTracking');

export interface RecordExecutionParams {
  codespaceId: string;
  skillId: string;
  skillName: string | null;
  taskId: string | null;
  agentRunId: string | null;
  sessionId: string | null;
  status: 'success' | 'failed' | 'cancelled' | 'turn_limit';
  turnsUsed?: number | null;
  tokensUsed?: number | null;
  durationMs?: number | null;
  filesModified?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  costUsd?: number | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export class SkillTrackingService {
  constructor(private db: Database) {}

  /**
   * Record a skill execution after an agent run completes.
   */
  async recordExecution(
    params: RecordExecutionParams
  ): Promise<Result<SkillExecution, MemoryError>> {
    try {
      const id = createId();
      const now = new Date().toISOString();

      // Dynamic import to avoid circular dependency at module load
      const { skillExecutions } = await import('../../db/schema/index.js');

      const record = {
        id,
        codespaceId: params.codespaceId,
        skillId: params.skillId,
        skillName: params.skillName,
        taskId: params.taskId,
        agentRunId: params.agentRunId,
        sessionId: params.sessionId,
        status: params.status,
        turnsUsed: params.turnsUsed ?? null,
        tokensUsed: params.tokensUsed ?? null,
        durationMs: params.durationMs ?? null,
        filesModified: params.filesModified ?? null,
        linesAdded: params.linesAdded ?? null,
        linesRemoved: params.linesRemoved ?? null,
        costUsd: params.costUsd ?? null,
        errorMessage: params.errorMessage ?? null,
        startedAt: params.startedAt ?? null,
        completedAt: params.completedAt ?? null,
        createdAt: now,
      };

      await this.db.insert(skillExecutions).values(record);

      log.debug('Recorded skill execution', {
        data: { id, skillId: params.skillId, status: params.status },
      });

      return ok(record as SkillExecution);
    } catch (error) {
      log.error('Failed to record skill execution', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.CAPTURE_ERROR('Failed to record skill execution'));
    }
  }

  /**
   * Refresh aggregated metrics for a skill from raw execution data.
   */
  async refreshMetrics(codespaceId: string, skillId?: string): Promise<Result<void, MemoryError>> {
    try {
      const { skillExecutions, skillMetrics } = await import('../../db/schema/index.js');

      // Build the where clause
      const conditions = [eq(skillExecutions.codespaceId, codespaceId)];
      if (skillId) {
        conditions.push(eq(skillExecutions.skillId, skillId));
      }

      // Aggregate from skill_executions
      const aggregates = await this.db
        .select({
          skillId: skillExecutions.skillId,
          skillName: sql<string>`MAX(${skillExecutions.skillName})`.as('skill_name'),
          totalRuns: sql<number>`COUNT(*)`.as('total_runs'),
          successCount:
            sql<number>`SUM(CASE WHEN ${skillExecutions.status} = 'success' THEN 1 ELSE 0 END)`.as(
              'success_count'
            ),
          errorCount:
            sql<number>`SUM(CASE WHEN ${skillExecutions.status} = 'failed' THEN 1 ELSE 0 END)`.as(
              'error_count'
            ),
          avgTokensUsed: sql<number>`AVG(${skillExecutions.tokensUsed})`.as('avg_tokens'),
          avgTurnsUsed: sql<number>`AVG(${skillExecutions.turnsUsed})`.as('avg_turns'),
          avgDurationMs: sql<number>`AVG(${skillExecutions.durationMs})`.as('avg_duration'),
          avgCostUsd: sql<number>`AVG(${skillExecutions.costUsd})`.as('avg_cost'),
          lastRunAt: sql<string>`MAX(${skillExecutions.completedAt})`.as('last_run_at'),
        })
        .from(skillExecutions)
        .where(and(...conditions))
        .groupBy(skillExecutions.skillId);

      const now = new Date().toISOString();

      for (const agg of aggregates) {
        const successRate =
          agg.totalRuns > 0 ? Number(agg.successCount) / Number(agg.totalRuns) : null;

        // Upsert: try insert, on conflict update
        const existing = await this.db.query.skillMetrics?.findFirst({
          where: and(
            eq(skillMetrics.codespaceId, codespaceId),
            eq(skillMetrics.skillId, agg.skillId)
          ),
        });

        if (existing) {
          await this.db
            .update(skillMetrics)
            .set({
              skillName: agg.skillName || existing.skillName,
              totalRuns: Number(agg.totalRuns),
              successCount: Number(agg.successCount),
              errorCount: Number(agg.errorCount),
              avgTokensUsed: agg.avgTokensUsed ? Number(agg.avgTokensUsed) : null,
              avgTurnsUsed: agg.avgTurnsUsed ? Number(agg.avgTurnsUsed) : null,
              avgDurationMs: agg.avgDurationMs ? Number(agg.avgDurationMs) : null,
              avgCostUsd: agg.avgCostUsd ? Number(agg.avgCostUsd) : null,
              successRate,
              lastRunAt: agg.lastRunAt,
              updatedAt: now,
            })
            .where(eq(skillMetrics.id, existing.id));
        } else {
          await this.db.insert(skillMetrics).values({
            id: createId(),
            codespaceId,
            skillId: agg.skillId,
            skillName: agg.skillName || agg.skillId,
            totalRuns: Number(agg.totalRuns),
            successCount: Number(agg.successCount),
            errorCount: Number(agg.errorCount),
            avgTokensUsed: agg.avgTokensUsed ? Number(agg.avgTokensUsed) : null,
            avgTurnsUsed: agg.avgTurnsUsed ? Number(agg.avgTurnsUsed) : null,
            avgDurationMs: agg.avgDurationMs ? Number(agg.avgDurationMs) : null,
            avgCostUsd: agg.avgCostUsd ? Number(agg.avgCostUsd) : null,
            successRate,
            lastRunAt: agg.lastRunAt,
            updatedAt: now,
          });
        }
      }

      log.debug('Refreshed skill metrics', {
        data: { codespaceId, skillId, skillsUpdated: aggregates.length },
      });

      return ok(undefined);
    } catch (error) {
      log.error('Failed to refresh skill metrics', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to refresh skill metrics'));
    }
  }

  /**
   * Get aggregated metrics for all skills in a codespace (or a single skill).
   */
  async getMetrics(
    codespaceId: string,
    skillId?: string
  ): Promise<Result<SkillMetrics[], MemoryError>> {
    try {
      const { skillMetrics } = await import('../../db/schema/index.js');

      const conditions = [eq(skillMetrics.codespaceId, codespaceId)];
      if (skillId) {
        conditions.push(eq(skillMetrics.skillId, skillId));
      }

      const results = await this.db.query.skillMetrics?.findMany({
        where: and(...conditions),
        orderBy: [desc(skillMetrics.lastRunAt)],
      });

      return ok((results ?? []) as SkillMetrics[]);
    } catch (error) {
      log.error('Failed to get skill metrics', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to get skill metrics'));
    }
  }

  /**
   * Get execution history for a specific skill.
   */
  async getExecutionHistory(
    codespaceId: string,
    skillId: string,
    options?: PaginationOptions
  ): Promise<Result<SkillExecution[], MemoryError>> {
    try {
      const { skillExecutions } = await import('../../db/schema/index.js');

      const page = options?.page ?? 1;
      const size = options?.size ?? 20;
      const offset = (page - 1) * size;

      const results = await this.db
        .select()
        .from(skillExecutions)
        .where(
          and(eq(skillExecutions.codespaceId, codespaceId), eq(skillExecutions.skillId, skillId))
        )
        .orderBy(desc(skillExecutions.createdAt))
        .limit(size)
        .offset(offset);

      return ok(results as SkillExecution[]);
    } catch (error) {
      log.error('Failed to get execution history', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to get execution history'));
    }
  }

  /**
   * Get detailed performance summary for dreaming input.
   * Includes error pattern analysis.
   */
  async getSkillPerformanceSummary(
    codespaceId: string,
    skillId: string
  ): Promise<
    Result<
      {
        metrics: SkillMetrics | null;
        recentExecutions: SkillExecution[];
        errorPatterns: Array<{ message: string; count: number }>;
      },
      MemoryError
    >
  > {
    try {
      const { skillExecutions, skillMetrics } = await import('../../db/schema/index.js');

      // Get aggregated metrics
      const metricsResult = await this.db.query.skillMetrics?.findFirst({
        where: and(eq(skillMetrics.codespaceId, codespaceId), eq(skillMetrics.skillId, skillId)),
      });

      // Get recent executions (last 10)
      const recentExecutions = await this.db
        .select()
        .from(skillExecutions)
        .where(
          and(eq(skillExecutions.codespaceId, codespaceId), eq(skillExecutions.skillId, skillId))
        )
        .orderBy(desc(skillExecutions.createdAt))
        .limit(10);

      // Get error patterns
      const errorPatterns = await this.db
        .select({
          message: skillExecutions.errorMessage,
          count: sql<number>`COUNT(*)`.as('count'),
        })
        .from(skillExecutions)
        .where(
          and(
            eq(skillExecutions.codespaceId, codespaceId),
            eq(skillExecutions.skillId, skillId),
            eq(skillExecutions.status, 'failed'),
            sql`${skillExecutions.errorMessage} IS NOT NULL`
          )
        )
        .groupBy(skillExecutions.errorMessage)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(5);

      return ok({
        metrics: (metricsResult as SkillMetrics) ?? null,
        recentExecutions: recentExecutions as SkillExecution[],
        errorPatterns: errorPatterns.map((e) => ({
          message: e.message || 'Unknown error',
          count: Number(e.count),
        })),
      });
    } catch (error) {
      log.error('Failed to get skill performance summary', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to get skill performance summary'));
    }
  }
}
