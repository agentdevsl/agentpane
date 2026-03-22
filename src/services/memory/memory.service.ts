/**
 * MemoryService — Facade that composes all memory sub-services.
 *
 * Single entry point used by AgentExecutionService (lifecycle methods)
 * and memory API routes (admin methods).
 *
 * Error handling tiers:
 *   Lifecycle methods (getContext, captureMessage, finalizeSession):
 *     Return ok() with empty defaults on failure — never block agent execution.
 *   Admin methods (CRUD, search):
 *     Return err(MemoryError) on failure — propagate to API responses.
 */

import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { SettingsService } from '../settings.service.js';
import { MemoryClientService } from './memory-client.service.js';
import type {
  HealthStatus,
  HonchoSessionRef,
  MemoryConclusion,
  MemoryContext,
  MemorySession,
  PaginationOptions,
  SearchResult,
} from './types.js';
import { EMPTY_CONTEXT } from './types.js';

const log = createLogger('MemoryService');

export class MemoryService {
  private client: MemoryClientService;
  // Sub-services injected after Phase 3/4/5 implementation
  private queryService: MemoryQueryServiceInterface | null = null;
  private captureService: MemoryCaptureServiceInterface | null = null;
  private adminService: MemoryAdminServiceInterface | null = null;

  constructor(
    private settingsService: SettingsService,
    _db: unknown // reserved for future use
  ) {
    this.client = new MemoryClientService(settingsService);
  }

  /** Initialize the memory system. Non-fatal on failure. */
  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  /** Whether the memory system is available. */
  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  /** Get the underlying client service (for sub-service wiring). */
  getClient(): MemoryClientService {
    return this.client;
  }

  /** Get the settings service (for sub-service wiring). */
  getSettingsService(): SettingsService {
    return this.settingsService;
  }

  // --- Sub-service setters (called during wiring) ---

  setQueryService(service: MemoryQueryServiceInterface): void {
    this.queryService = service;
  }

  setCaptureService(service: MemoryCaptureServiceInterface): void {
    this.captureService = service;
  }

  setAdminService(service: MemoryAdminServiceInterface): void {
    this.adminService = service;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods (agent-facing — swallow errors)
  // ---------------------------------------------------------------------------

  /** Query Honcho for relevant memory context to inject into agent prompt. */
  async getContext(params: {
    codespaceId: string;
    agentId: string;
    taskTitle: string;
    taskDescription: string | null;
  }): Promise<Result<MemoryContext, MemoryError>> {
    if (!this.client.isAvailable() || !this.queryService) {
      return ok(EMPTY_CONTEXT);
    }
    try {
      return await this.queryService.assembleContext(params);
    } catch (error) {
      log.warn('Memory context retrieval failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return ok(EMPTY_CONTEXT);
    }
  }

  /** Create a Honcho session for tracking agent execution. */
  async startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
    sessionId: string;
    phase: 'planning' | 'execution';
    model: string;
  }): Promise<Result<HonchoSessionRef, MemoryError> | null> {
    if (!this.client.isAvailable() || !this.captureService) {
      return null;
    }
    try {
      return await this.captureService.startSession(params);
    } catch (error) {
      log.warn('Memory session start failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return null;
    }
  }

  /** Capture a single message (turn) from the stream handler. Fire-and-forget. */
  async captureMessage(params: {
    honchoSessionRef: HonchoSessionRef;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.client.isAvailable() || !this.captureService) return;
    try {
      await this.captureService.captureMessage(params);
    } catch (error) {
      log.warn('Memory capture failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          sessionId: params.honchoSessionRef.sessionId,
          role: params.role,
          contentLength: params.content.length,
        },
      });
    }
  }

  /** Finalize a Honcho session (triggers deriver). Fire-and-forget. */
  async finalizeSession(ref: HonchoSessionRef): Promise<void> {
    if (!this.client.isAvailable() || !this.captureService) return;
    try {
      await this.captureService.finalizeSession(ref);
    } catch (error) {
      log.warn('Memory session finalization failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Admin methods (user-facing — propagate errors)
  // ---------------------------------------------------------------------------

  async getConclusions(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<MemoryConclusion[], MemoryError>> {
    if (!this.adminService) return ok([]);
    return this.adminService.getConclusions(codespaceId, options);
  }

  async createConclusion(
    codespaceId: string,
    content: string
  ): Promise<Result<MemoryConclusion, MemoryError>> {
    if (!this.adminService) {
      return err(MemoryErrors.UNAVAILABLE);
    }
    return this.adminService.createConclusion(codespaceId, content);
  }

  async deleteConclusion(
    codespaceId: string,
    conclusionId: string
  ): Promise<Result<void, MemoryError>> {
    if (!this.adminService) {
      return err(MemoryErrors.UNAVAILABLE);
    }
    return this.adminService.deleteConclusion(codespaceId, conclusionId);
  }

  async getSessions(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<MemorySession[], MemoryError>> {
    if (!this.adminService) return ok([]);
    return this.adminService.getSessions(codespaceId, options);
  }

  async search(
    codespaceId: string,
    query: string,
    options?: { limit?: number }
  ): Promise<Result<SearchResult[], MemoryError>> {
    if (!this.adminService) return ok([]);
    return this.adminService.search(codespaceId, query, options);
  }

  async healthCheck(): Promise<Result<HealthStatus, MemoryError>> {
    const start = Date.now();
    const pingResult = await this.client.ping();
    const latencyMs = Date.now() - start;

    if (!pingResult.ok) {
      return ok({
        available: false,
        version: null,
        latencyMs,
        workspaceCount: 0,
      });
    }

    return ok({
      available: true,
      version: pingResult.value.version,
      latencyMs,
      workspaceCount: 0, // Would need API call to count
    });
  }

  /** Delete a workspace (for codespace cascade deletion). */
  async deleteWorkspace(codespaceId: string): Promise<void> {
    if (!this.client.isAvailable()) return;
    try {
      await this.client.deleteWorkspace(`codespace-${codespaceId}`);
    } catch (error) {
      log.error('Failed to delete memory workspace (orphaned data in Honcho)', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { codespaceId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-service interfaces (for decoupled wiring)
// ---------------------------------------------------------------------------

export interface MemoryQueryServiceInterface {
  assembleContext(params: {
    codespaceId: string;
    agentId: string;
    taskTitle: string;
    taskDescription: string | null;
  }): Promise<Result<MemoryContext, MemoryError>>;
}

export interface MemoryCaptureServiceInterface {
  startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
    sessionId: string;
    phase: 'planning' | 'execution';
    model: string;
  }): Promise<Result<HonchoSessionRef, MemoryError>>;

  captureMessage(params: {
    honchoSessionRef: HonchoSessionRef;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<void, MemoryError>>;

  finalizeSession(ref: HonchoSessionRef): Promise<Result<void, MemoryError>>;
}

export interface MemoryAdminServiceInterface {
  getConclusions(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<MemoryConclusion[], MemoryError>>;
  createConclusion(
    codespaceId: string,
    content: string
  ): Promise<Result<MemoryConclusion, MemoryError>>;
  deleteConclusion(codespaceId: string, conclusionId: string): Promise<Result<void, MemoryError>>;
  getSessions(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<MemorySession[], MemoryError>>;
  search(
    codespaceId: string,
    query: string,
    options?: { limit?: number }
  ): Promise<Result<SearchResult[], MemoryError>>;
}
