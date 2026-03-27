/**
 * MemoryStoreService - DB-backed storage for memory insights and messages.
 *
 * Provides CRUD operations, keyword search, and token-budgeted context assembly.
 * All methods return Result<T, MemoryError> for consistent error handling.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, count, desc, eq, like } from 'drizzle-orm';
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

export class MemoryStoreService {
  constructor(private db: Database) {}

  // ---------------------------------------------------------------------------
  // Insights
  // ---------------------------------------------------------------------------

  async insertInsight(params: {
    codespaceId: string;
    content: string;
    source: string;
    sourceSessionId?: string;
    skillId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Result<Insight, MemoryError>> {
    try {
      const id = createId();
      const now = new Date().toISOString();

      await this.db.insert(memoryInsights).values({
        id,
        codespaceId: params.codespaceId,
        content: params.content,
        source: params.source as 'agent_derived' | 'manual' | 'dream',
        sourceSessionId: params.sourceSessionId ?? null,
        skillId: params.skillId ?? null,
        tags: params.tags ?? [],
        metadata: params.metadata ?? null,
        createdAt: now,
      });

      const insight: Insight = {
        id,
        codespaceId: params.codespaceId,
        content: params.content,
        source: params.source as 'agent_derived' | 'manual' | 'dream',
        sourceSessionId: params.sourceSessionId ?? null,
        skillId: params.skillId ?? null,
        tags: params.tags ?? [],
        metadata: params.metadata ?? null,
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

  async getInsights(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<Insight[], MemoryError>> {
    try {
      const page = options?.page ?? 1;
      const size = options?.size ?? 50;
      const offset = (page - 1) * size;

      const rows = await this.db
        .select()
        .from(memoryInsights)
        .where(eq(memoryInsights.codespaceId, codespaceId))
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
    codespaceId: string,
    query: string,
    limit = 20
  ): Promise<Result<Insight[], MemoryError>> {
    try {
      const rows = await this.db
        .select()
        .from(memoryInsights)
        .where(
          and(
            eq(memoryInsights.codespaceId, codespaceId),
            like(memoryInsights.content, `%${escapeLikeQuery(query)}%`)
          )
        )
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
    codespaceId: string,
    query: string,
    maxTokens = 2000
  ): Promise<Result<MemoryContext, MemoryError>> {
    try {
      // First try search-relevant insights, then fall back to recent
      let rows = await this.db
        .select()
        .from(memoryInsights)
        .where(
          and(
            eq(memoryInsights.codespaceId, codespaceId),
            like(memoryInsights.content, `%${escapeLikeQuery(query)}%`)
          )
        )
        .orderBy(desc(memoryInsights.createdAt))
        .limit(50);

      // If no search matches, get recent insights
      if (rows.length === 0) {
        rows = await this.db
          .select()
          .from(memoryInsights)
          .where(eq(memoryInsights.codespaceId, codespaceId))
          .orderBy(desc(memoryInsights.createdAt))
          .limit(50);
      }

      if (rows.length === 0) {
        return ok({ text: '', tokenCount: 0, sources: { insights: 0 } });
      }

      // Build markdown context, trimming to fit within maxTokens
      const header = '## Memory Context\n\n### Codebase Insights\n';
      let text = header;
      let insightCount = 0;

      for (const row of rows) {
        const line = `- ${row.content}\n`;
        const candidateTokens = estimateTokens(text + line);
        if (candidateTokens > maxTokens) {
          break;
        }
        text += line;
        insightCount++;
      }

      const tokenCount = estimateTokens(text);

      return ok({
        text,
        tokenCount,
        sources: { insights: insightCount },
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
    role: string;
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
        role: params.role as 'user' | 'assistant',
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
        role: params.role as 'user' | 'assistant',
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
