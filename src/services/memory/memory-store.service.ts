/**
 * MemoryStoreService - DB-backed storage for memory insights and messages.
 *
 * Provides CRUD operations, keyword search, and token-budgeted context assembly.
 * All methods return Result<T, MemoryError> for consistent error handling.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { memoryInsights, memoryMessages } from '../../db/schema/index.js';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { Insight, MemoryContext, MemoryMessage, PaginationOptions } from './types.js';

const log = createLogger('MemoryStoreService');

/** Escape SQL LIKE wildcard characters in user input. */
function escapeLikeQuery(query: string): string {
  return query.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/** Estimate token count from text length. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Category-to-task-intent mapping for relevance boosting. */
const CATEGORY_INTENT_MAP: Record<string, string[]> = {
  error_lesson: ['fix', 'bug', 'error', 'issue', 'broken', 'failing', 'crash', 'debug'],
  pattern: ['add', 'implement', 'create', 'build', 'feature', 'new'],
  anti_pattern: ['fix', 'refactor', 'avoid', 'bug', 'issue'],
  architecture: ['design', 'architect', 'structure', 'refactor', 'restructure', 'migrate'],
  decision: ['choose', 'decide', 'evaluate', 'compare', 'option'],
};

/** Compute a relevance score for an insight against a query. */
function scoreInsightRelevance(
  content: string,
  category: string | null,
  effectivenessScore: number | null,
  source: string,
  createdAt: string,
  skillId: string | null,
  query: string,
  taskSkillId?: string | null
): number {
  let score = 0;

  // 1. Keyword overlap (0-0.4)
  const queryWords = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
  const contentWords = content
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (queryWords.size > 0 && contentWords.length > 0) {
    const matches = contentWords.filter((w) => queryWords.has(w)).length;
    score += Math.min(0.4, (matches / queryWords.size) * 0.4);
  }

  // 2. Category-intent match (0-0.15)
  if (category && CATEGORY_INTENT_MAP[category]) {
    const intents = CATEGORY_INTENT_MAP[category];
    const queryLower = query.toLowerCase();
    if (intents.some((intent) => queryLower.includes(intent))) {
      score += 0.15;
    }
  }

  // 3. Skill match bonus (0-0.2)
  if (taskSkillId && skillId && taskSkillId === skillId) {
    score += 0.2;
  }

  // 4. Effectiveness score (0-0.15)
  if (effectivenessScore != null) {
    // Normalize from [-1, 1] to [0, 0.15]
    score += Math.max(0, (effectivenessScore + 1) / 2) * 0.15;
  }

  // 5. Source priority (0-0.05)
  if (source === 'manual') score += 0.05;
  else if (source === 'dream') score += 0.025;

  // 6. Recency decay (0-0.05) — 30-day half-life
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  score += 0.05 * 0.5 ** (ageMs / HALF_LIFE_MS);

  return score;
}

export class MemoryStoreService {
  constructor(private db: Database) {}

  // ---------------------------------------------------------------------------
  // Insights
  // ---------------------------------------------------------------------------

  async insertInsight(params: {
    codespaceId: string;
    content: string;
    source: 'agent_derived' | 'manual' | 'dream';
    sourceSessionId?: string;
    skillId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    status?: 'active' | 'pending_review' | 'rejected';
    category?: 'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson';
  }): Promise<Result<Insight, MemoryError>> {
    try {
      const id = createId();
      const now = new Date().toISOString();
      const status = params.status ?? 'active';
      const category = params.category ?? null;

      await this.db.insert(memoryInsights).values({
        id,
        codespaceId: params.codespaceId,
        content: params.content,
        source: params.source,
        sourceSessionId: params.sourceSessionId ?? null,
        skillId: params.skillId ?? null,
        tags: params.tags ?? [],
        metadata: params.metadata ?? null,
        status,
        category,
        createdAt: now,
      });

      const insight: Insight = {
        id,
        codespaceId: params.codespaceId,
        content: params.content,
        source: params.source,
        sourceSessionId: params.sourceSessionId ?? null,
        skillId: params.skillId ?? null,
        tags: params.tags ?? [],
        metadata: params.metadata ?? null,
        status,
        category,
        effectivenessScore: null,
        updatedAt: null,
        createdAt: now,
      };

      return ok(insight);
    } catch (error) {
      log.error('Failed to insert insight', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId: params.codespaceId },
      });
      return err(MemoryErrors.CAPTURE_ERROR('Failed to insert insight'));
    }
  }

  async updateInsight(
    id: string,
    params: {
      content?: string;
      status?: 'active' | 'pending_review' | 'rejected';
      category?: 'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson';
    },
    onlyIfStatus?: 'active' | 'pending_review' | 'rejected'
  ): Promise<Result<Insight, MemoryError>> {
    try {
      const updatedAt = new Date().toISOString();
      const whereClause = onlyIfStatus
        ? and(eq(memoryInsights.id, id), eq(memoryInsights.status, onlyIfStatus))
        : eq(memoryInsights.id, id);
      const result = await this.db
        .update(memoryInsights)
        .set({ ...params, updatedAt })
        .where(whereClause)
        .returning();

      const row = result[0];
      if (!row) {
        return err(MemoryErrors.NOT_FOUND(`insight:${id}`));
      }

      const insight: Insight = {
        id: row.id,
        codespaceId: row.codespaceId,
        content: row.content,
        source: row.source,
        sourceSessionId: row.sourceSessionId,
        skillId: row.skillId,
        tags: (row.tags as string[]) ?? [],
        metadata: row.metadata as Record<string, unknown> | null,
        status: row.status ?? 'active',
        category: row.category ?? null,
        effectivenessScore: row.effectivenessScore ?? null,
        updatedAt: row.updatedAt ?? null,
        createdAt: row.createdAt,
      };

      return ok(insight);
    } catch (error) {
      log.error('Failed to update insight', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { id },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to update insight'));
    }
  }

  async getInsights(
    codespaceId: string | null,
    options?: PaginationOptions,
    filters?: {
      status?: 'active' | 'pending_review' | 'rejected';
      category?: 'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson';
    }
  ): Promise<Result<Insight[], MemoryError>> {
    try {
      const page = options?.page ?? 1;
      const size = options?.size ?? 50;
      const offset = (page - 1) * size;

      const conditions = [];
      if (codespaceId) {
        conditions.push(eq(memoryInsights.codespaceId, codespaceId));
      }
      if (filters?.status) {
        conditions.push(eq(memoryInsights.status, filters.status));
      }
      if (filters?.category) {
        conditions.push(eq(memoryInsights.category, filters.category));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await this.db
        .select()
        .from(memoryInsights)
        .where(whereClause)
        .orderBy(desc(memoryInsights.createdAt))
        .limit(size)
        .offset(offset);

      const insights: Insight[] = rows.map((row) => ({
        id: row.id,
        codespaceId: row.codespaceId,
        content: row.content,
        source: row.source,
        sourceSessionId: row.sourceSessionId,
        skillId: row.skillId,
        tags: (row.tags as string[]) ?? [],
        metadata: row.metadata as Record<string, unknown> | null,
        status: row.status ?? 'active',
        category: row.category ?? null,
        effectivenessScore: row.effectivenessScore ?? null,
        updatedAt: row.updatedAt ?? null,
        createdAt: row.createdAt,
      }));

      return ok(insights);
    } catch (error) {
      log.error('Failed to get insights', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to get insights'));
    }
  }

  async deleteInsight(id: string): Promise<Result<void, MemoryError>> {
    try {
      const result = await this.db
        .delete(memoryInsights)
        .where(eq(memoryInsights.id, id))
        .returning({ id: memoryInsights.id });

      if (result.length === 0) {
        return err(MemoryErrors.NOT_FOUND(`insight:${id}`));
      }

      return ok(undefined);
    } catch (error) {
      log.error('Failed to delete insight', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { id },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to delete insight'));
    }
  }

  async searchInsights(
    codespaceId: string | null,
    query: string,
    limit = 20
  ): Promise<Result<Insight[], MemoryError>> {
    try {
      const likeCondition = sql`${memoryInsights.content} LIKE ${`%${escapeLikeQuery(query)}%`} ESCAPE '\\'`;
      const activeCondition = eq(memoryInsights.status, 'active');
      const whereClause = codespaceId
        ? and(eq(memoryInsights.codespaceId, codespaceId), likeCondition, activeCondition)
        : and(likeCondition, activeCondition);

      const rows = await this.db
        .select()
        .from(memoryInsights)
        .where(whereClause)
        .orderBy(desc(memoryInsights.createdAt))
        .limit(limit);

      const insights: Insight[] = rows.map((row) => ({
        id: row.id,
        codespaceId: row.codespaceId,
        content: row.content,
        source: row.source,
        sourceSessionId: row.sourceSessionId,
        skillId: row.skillId,
        tags: (row.tags as string[]) ?? [],
        metadata: row.metadata as Record<string, unknown> | null,
        status: row.status ?? 'active',
        category: row.category ?? null,
        effectivenessScore: row.effectivenessScore ?? null,
        updatedAt: row.updatedAt ?? null,
        createdAt: row.createdAt,
      }));

      return ok(insights);
    } catch (error) {
      log.error('Failed to search insights', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId, query },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to search insights'));
    }
  }

  async assembleContext(
    codespaceId: string | null,
    query: string,
    maxTokens = 2000,
    maxInsights = 10,
    taskSkillId?: string | null
  ): Promise<Result<MemoryContext, MemoryError>> {
    try {
      const activeCondition = eq(memoryInsights.status, 'active');
      const whereClause = codespaceId
        ? and(eq(memoryInsights.codespaceId, codespaceId), activeCondition)
        : activeCondition;

      // Fetch all active insights (capped at 200 for scoring)
      const rows = await this.db
        .select()
        .from(memoryInsights)
        .where(whereClause)
        .orderBy(desc(memoryInsights.createdAt))
        .limit(200);

      if (rows.length === 0) {
        return ok({ text: '', tokenCount: 0, sources: { insights: 0, insightIds: [] } });
      }

      // Score and sort by relevance
      const scored = rows.map((row) => ({
        row,
        score: scoreInsightRelevance(
          row.content,
          row.category,
          row.effectivenessScore ?? null,
          row.source,
          row.createdAt,
          row.skillId,
          query,
          taskSkillId
        ),
      }));
      scored.sort((a, b) => b.score - a.score);

      // Collect insights within token and count budgets
      let insightCount = 0;
      const insightIds: string[] = [];
      const categorized = new Map<string, string[]>();
      const uncategorized: string[] = [];

      for (const { row } of scored) {
        if (insightCount >= maxInsights) break;
        const line = `- ${row.content}`;
        const candidateText = `## Memory Context\n\n${[...categorized.values()].flat().join('\n')}\n${uncategorized.join('\n')}\n${line}\n`;
        const candidateTokens = estimateTokens(candidateText);
        if (candidateTokens > maxTokens) break;
        if (row.category) {
          if (!categorized.has(row.category)) categorized.set(row.category, []);
          categorized.get(row.category)?.push(line);
        } else {
          uncategorized.push(line);
        }
        insightCount++;
        insightIds.push(row.id);
      }

      if (insightCount === 0) {
        return ok({ text: '', tokenCount: 0, sources: { insights: 0, insightIds: [] } });
      }

      // Build markdown context with category headers
      let text = '## Memory Context\n\n';
      const categoryHeaders: Record<string, string> = {
        pattern: '### Patterns',
        anti_pattern: '### Anti-Patterns',
        decision: '### Decisions',
        architecture: '### Architecture',
        error_lesson: '### Error Lessons',
      };

      for (const [cat, lines] of categorized.entries()) {
        const header = categoryHeaders[cat] ?? `### ${cat}`;
        text += `${header}\n${lines.join('\n')}\n\n`;
      }
      if (uncategorized.length > 0) {
        if (categorized.size > 0) {
          text += '### Other Insights\n';
        } else {
          text += '### Codebase Insights\n';
        }
        text += `${uncategorized.join('\n')}\n`;
      }

      const tokenCount = estimateTokens(text);

      return ok({
        text,
        tokenCount,
        sources: { insights: insightCount, insightIds },
      });
    } catch (error) {
      log.error('Failed to assemble context', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId, query },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to assemble context'));
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async insertMessage(params: {
    codespaceId: string;
    memorySessionId: string;
    agentId: string;
    taskId: string;
    role: 'user' | 'assistant';
    content: string;
    turnNumber: number;
    metadata?: Record<string, unknown>;
  }): Promise<Result<MemoryMessage, MemoryError>> {
    try {
      const id = createId();
      const now = new Date().toISOString();

      await this.db.insert(memoryMessages).values({
        id,
        codespaceId: params.codespaceId,
        memorySessionId: params.memorySessionId,
        agentId: params.agentId,
        taskId: params.taskId,
        role: params.role,
        content: params.content,
        turnNumber: params.turnNumber,
        metadata: params.metadata ?? null,
        createdAt: now,
      });

      const message: MemoryMessage = {
        id,
        codespaceId: params.codespaceId,
        memorySessionId: params.memorySessionId,
        agentId: params.agentId,
        taskId: params.taskId,
        role: params.role,
        content: params.content,
        turnNumber: params.turnNumber,
        metadata: params.metadata ?? null,
        createdAt: now,
      };

      return ok(message);
    } catch (error) {
      log.error('Failed to insert message', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId: params.codespaceId, memorySessionId: params.memorySessionId },
      });
      return err(MemoryErrors.CAPTURE_ERROR('Failed to insert message'));
    }
  }

  async getMessages(memorySessionId: string): Promise<Result<MemoryMessage[], MemoryError>> {
    try {
      const rows = await this.db
        .select()
        .from(memoryMessages)
        .where(eq(memoryMessages.memorySessionId, memorySessionId))
        .orderBy(memoryMessages.turnNumber);

      const messages: MemoryMessage[] = rows.map((row) => ({
        id: row.id,
        codespaceId: row.codespaceId,
        memorySessionId: row.memorySessionId,
        agentId: row.agentId,
        taskId: row.taskId,
        role: row.role,
        content: row.content,
        turnNumber: row.turnNumber,
        metadata: row.metadata as Record<string, unknown> | null,
        createdAt: row.createdAt,
      }));

      return ok(messages);
    } catch (error) {
      log.error('Failed to get messages', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { memorySessionId },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to get messages'));
    }
  }

  // ---------------------------------------------------------------------------
  // Counts
  // ---------------------------------------------------------------------------

  async getInsightCount(codespaceId?: string): Promise<Result<number, MemoryError>> {
    try {
      const query = this.db.select({ value: count() }).from(memoryInsights);
      const result = codespaceId
        ? await query.where(eq(memoryInsights.codespaceId, codespaceId))
        : await query;

      return ok(result[0]?.value ?? 0);
    } catch (error) {
      log.error('Failed to count insights', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to count insights'));
    }
  }

  async getMessageCount(codespaceId?: string): Promise<Result<number, MemoryError>> {
    try {
      const query = this.db.select({ value: count() }).from(memoryMessages);
      const result = codespaceId
        ? await query.where(eq(memoryMessages.codespaceId, codespaceId))
        : await query;

      return ok(result[0]?.value ?? 0);
    } catch (error) {
      log.error('Failed to count messages', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId },
      });
      return err(MemoryErrors.QUERY_ERROR('Failed to count messages'));
    }
  }
}
