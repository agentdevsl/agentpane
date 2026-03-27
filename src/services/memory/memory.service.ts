/**
 * MemoryService - Facade that composes all memory sub-services.
 *
 * Single entry point used by AgentExecutionService (lifecycle methods)
 * and memory API routes (admin methods).
 *
 * Error handling tiers:
 *   Lifecycle methods (getContext, captureMessage, finalizeSession):
 *     Return ok() with empty defaults on failure - never block agent execution.
 *   Admin methods (CRUD, search):
 *     Return err(MemoryError) on failure - propagate to API responses.
 */

import { createId } from '@paralleldrive/cuid2';
import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { SettingsService } from '../settings.service.js';
import { InsightDeriverService } from './insight-deriver.service.js';
import { MemoryStoreService } from './memory-store.service.js';
import type {
  HealthStatus,
  Insight,
  MemoryContext,
  MemoryMessage,
  MemorySessionRef,
  PaginationOptions,
  SearchResult,
} from './types.js';
import { EMPTY_CONTEXT } from './types.js';

const log = createLogger('MemoryService');

// ---------------------------------------------------------------------------
// Sub-service interfaces (for decoupled wiring and testing)
// ---------------------------------------------------------------------------

export interface MemoryStoreInterface {
  insertInsight(params: {
    codespaceId: string;
    content: string;
    source: 'agent_derived' | 'manual' | 'dream';
    sourceSessionId?: string;
    skillId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Result<Insight, MemoryError>>;
  getInsights(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<Insight[], MemoryError>>;
  deleteInsight(id: string): Promise<Result<void, MemoryError>>;
  searchInsights(
    codespaceId: string,
    query: string,
    limit?: number
  ): Promise<Result<Insight[], MemoryError>>;
  assembleContext(
    codespaceId: string,
    query: string,
    maxTokens?: number
  ): Promise<Result<MemoryContext, MemoryError>>;
  insertMessage(params: {
    codespaceId: string;
    memorySessionId: string;
    agentId: string;
    taskId: string;
    role: 'user' | 'assistant';
    content: string;
    turnNumber: number;
    metadata?: Record<string, unknown>;
  }): Promise<Result<MemoryMessage, MemoryError>>;
  getMessages(memorySessionId: string): Promise<Result<MemoryMessage[], MemoryError>>;
  getInsightCount(codespaceId?: string): Promise<Result<number, MemoryError>>;
  getMessageCount(codespaceId?: string): Promise<Result<number, MemoryError>>;
}

export interface InsightDeriverInterface {
  deriveInsights(
    memorySessionId: string,
    codespaceId: string
  ): Promise<Result<{ insightsCreated: number }, MemoryError>>;
}

// ---------------------------------------------------------------------------
// MemoryService
// ---------------------------------------------------------------------------

export class MemoryService {
  private store: MemoryStoreInterface;
  private deriver: InsightDeriverInterface;
  private available = false;

  constructor(
    private settingsService: SettingsService,
    db: Database
  ) {
    const storeService = new MemoryStoreService(db);
    this.store = storeService;
    this.deriver = new InsightDeriverService(storeService);
  }

  /** Initialize the memory system. Non-fatal on failure. */
  async initialize(): Promise<void> {
    try {
      const settingResult = await this.settingsService.get('memory.enabled');
      if (settingResult.ok && settingResult.value) {
        const raw = settingResult.value.value;
        // Setting value is JSON-encoded, so "true" or true
        try {
          this.available = JSON.parse(raw) === true;
        } catch {
          this.available = raw === 'true';
        }
      } else {
        this.available = false;
      }
      log.info('Memory service initialized', { data: { available: this.available } });
    } catch (error) {
      log.warn('Memory initialization failed (non-fatal)', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.available = false;
    }
  }

  /** Whether the memory system is available. */
  isAvailable(): boolean {
    return this.available;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods (agent-facing - swallow errors)
  // ---------------------------------------------------------------------------

  /** Assemble relevant memory context for agent prompt injection. */
  async getContext(
    codespaceId: string,
    query: string
  ): Promise<Result<MemoryContext, MemoryError>> {
    if (!this.available) {
      return ok(EMPTY_CONTEXT);
    }
    try {
      return await this.store.assembleContext(codespaceId, query);
    } catch (error) {
      log.warn('Memory context retrieval failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return ok(EMPTY_CONTEXT);
    }
  }

  /** Create a memory session for tracking agent execution messages. */
  async startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
  }): Promise<MemorySessionRef | null> {
    if (!this.available) {
      return null;
    }
    try {
      const memorySessionId = createId();
      const ref: MemorySessionRef = {
        memorySessionId,
        codespaceId: params.codespaceId,
        agentId: params.agentId,
        taskId: params.taskId,
      };
      log.info('Memory session started', {
        data: { memorySessionId, codespaceId: params.codespaceId },
      });
      return ref;
    } catch (error) {
      log.warn('Memory session start failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return null;
    }
  }

  /** Capture a single message (turn) from the stream handler. Fire-and-forget. */
  async captureMessage(
    ref: MemorySessionRef,
    params: {
      role: 'user' | 'assistant';
      content: string;
      turnNumber: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.available) return;
    try {
      await this.store.insertMessage({
        codespaceId: ref.codespaceId,
        memorySessionId: ref.memorySessionId,
        agentId: ref.agentId,
        taskId: ref.taskId,
        role: params.role,
        content: params.content,
        turnNumber: params.turnNumber,
        metadata: params.metadata,
      });
    } catch (error) {
      log.warn('Memory capture failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          memorySessionId: ref.memorySessionId,
          role: params.role,
          contentLength: params.content.length,
        },
      });
    }
  }

  /** Finalize a memory session (triggers insight derivation). Fire-and-forget. */
  async finalizeSession(ref: MemorySessionRef): Promise<void> {
    if (!this.available) return;
    try {
      const result = await this.deriver.deriveInsights(ref.memorySessionId, ref.codespaceId);
      if (!result.ok) {
        log.warn('Insight derivation returned error', {
          error: new Error(String(result.error)),
          data: { memorySessionId: ref.memorySessionId },
        });
      }
    } catch (error) {
      log.warn('Memory session finalization failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { memorySessionId: ref.memorySessionId },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Admin methods (user-facing - propagate errors)
  // ---------------------------------------------------------------------------

  async getInsights(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<Insight[], MemoryError>> {
    if (!this.available) return ok([]);
    return this.store.getInsights(codespaceId, options);
  }

  async createInsight(
    codespaceId: string,
    content: string,
    source: 'agent_derived' | 'manual' | 'dream' = 'manual',
    metadata?: Record<string, unknown>,
    tags?: string[],
    skillId?: string
  ): Promise<Result<Insight, MemoryError>> {
    if (!this.available) {
      return err(MemoryErrors.UNAVAILABLE);
    }
    return this.store.insertInsight({
      codespaceId,
      content,
      source,
      metadata,
      tags,
      skillId,
    });
  }

  async deleteInsight(id: string): Promise<Result<void, MemoryError>> {
    if (!this.available) {
      return err(MemoryErrors.UNAVAILABLE);
    }
    return this.store.deleteInsight(id);
  }

  async search(
    codespaceId: string,
    query: string,
    limit?: number
  ): Promise<Result<SearchResult[], MemoryError>> {
    if (!this.available) return ok([]);

    const result = await this.store.searchInsights(codespaceId, query, limit);
    if (!result.ok) return result;

    // Map Insight[] to SearchResult[]
    const searchResults: SearchResult[] = result.value.map((insight) => ({
      id: insight.id,
      content: insight.content,
      type: 'insight' as const,
      skillId: insight.skillId,
      createdAt: insight.createdAt,
    }));

    return ok(searchResults);
  }

  async healthCheck(): Promise<Result<HealthStatus, MemoryError>> {
    if (!this.available) {
      return ok({
        available: false,
        insightCount: 0,
        messageCount: 0,
      });
    }

    try {
      const [insightResult, messageResult] = await Promise.all([
        this.store.getInsightCount(),
        this.store.getMessageCount(),
      ]);

      return ok({
        available: true,
        insightCount: insightResult.ok ? insightResult.value : 0,
        messageCount: messageResult.ok ? messageResult.value : 0,
      });
    } catch {
      return ok({
        available: true,
        insightCount: 0,
        messageCount: 0,
      });
    }
  }
}
