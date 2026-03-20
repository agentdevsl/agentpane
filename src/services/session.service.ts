/**
 * SessionService - Facade for session management
 *
 * This service composes the focused session services:
 * - SessionCrudService: Basic CRUD operations
 * - SessionPresenceService: User presence management
 * - SessionStreamService: Event streaming and persistence
 *
 * All types are re-exported for backward compatibility.
 */

import type { NewSessionSummary, SessionSummary } from '../db/schema';
import type { SessionError } from '../lib/errors/session-errors.js';
import type { Result } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import { SessionCrudService } from './session/session-crud.service.js';
import { SessionPresenceService } from './session/session-presence.service.js';
import { SessionStreamService } from './session/session-stream.service.js';
import type {
  ActiveUser,
  CreateSessionInput,
  DurableStreamsServer,
  GetEventsBySessionOptions,
  HistoryOptions,
  ListSessionsOptions,
  ListSessionsWithFiltersOptions,
  PresenceUpdate,
  SessionEvent,
  SessionEventType,
  SessionWithPresence,
  SubscribeOptions,
} from './session/types.js';

// Re-export all types for backward compatibility
export type {
  ActiveUser,
  CreateSessionInput,
  DurableStreamsServer,
  GetEventsBySessionOptions,
  HistoryOptions,
  ListSessionsOptions,
  ListSessionsWithFiltersOptions,
  PresenceUpdate,
  SessionEvent,
  SessionEventType,
  SessionWithPresence,
  SubscribeOptions,
};

/**
 * SessionService - Unified facade for session management
 *
 * Maintains backward compatibility while delegating to focused services.
 */
export class SessionService {
  private crudService: SessionCrudService;
  private presenceService: SessionPresenceService;
  private streamService: SessionStreamService;

  constructor(db: Database, streams: DurableStreamsServer, config: { baseUrl: string }) {
    this.streamService = new SessionStreamService(db, streams);
    this.presenceService = new SessionPresenceService(db, () => this.streamService);
    this.crudService = new SessionCrudService(
      db,
      streams,
      config,
      this.presenceService.getMutablePresenceStore()
    );

    // Start the stale-presence cleanup timer (RS-007)
    this.presenceService.startCleanupTimer();
  }

  /**
   * Tear down timers and resources. Call during graceful shutdown.
   */
  destroy(): void {
    this.presenceService.stopCleanupTimer();
  }

  // ===== CRUD Operations (SessionCrudService) =====

  async create(input: CreateSessionInput): Promise<Result<SessionWithPresence, SessionError>> {
    return this.crudService.create(input);
  }

  async getById(id: string): Promise<Result<SessionWithPresence, SessionError>> {
    return this.crudService.getById(id);
  }

  async list(options?: ListSessionsOptions): Promise<Result<SessionWithPresence[], SessionError>> {
    return this.crudService.list(options);
  }

  async close(id: string): Promise<Result<SessionWithPresence, SessionError>> {
    return this.crudService.close(id);
  }

  async delete(id: string): Promise<Result<{ deleted: boolean }, SessionError>> {
    return this.crudService.delete(id);
  }

  async listSessionsWithFilters(
    projectId: string,
    options?: ListSessionsWithFiltersOptions
  ): Promise<Result<{ sessions: SessionWithPresence[]; total: number }, SessionError>> {
    return this.crudService.listSessionsWithFilters(projectId, options);
  }

  generateUrl(sessionId: string): string {
    return this.crudService.generateUrl(sessionId);
  }

  parseUrl(url: string): Result<string, SessionError> {
    return this.crudService.parseUrl(url);
  }

  // ===== Presence Operations (SessionPresenceService) =====

  async join(
    sessionId: string,
    userId: string
  ): Promise<Result<SessionWithPresence, SessionError>> {
    return this.presenceService.join(sessionId, userId);
  }

  async leave(
    sessionId: string,
    userId: string
  ): Promise<Result<SessionWithPresence, SessionError>> {
    return this.presenceService.leave(sessionId, userId);
  }

  async updatePresence(
    sessionId: string,
    userId: string,
    presenceUpdate: PresenceUpdate
  ): Promise<Result<void, SessionError>> {
    return this.presenceService.updatePresence(sessionId, userId, presenceUpdate);
  }

  async getActiveUsers(sessionId: string): Promise<Result<ActiveUser[], SessionError>> {
    return this.presenceService.getActiveUsers(sessionId);
  }

  // ===== Streaming Operations (SessionStreamService) =====

  async publish(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ offset: number }, SessionError>> {
    return this.streamService.publish(sessionId, event);
  }

  async *subscribe(sessionId: string, options?: SubscribeOptions): AsyncIterable<SessionEvent> {
    yield* this.streamService.subscribe(sessionId, options);
  }

  async getHistory(
    sessionId: string,
    options?: HistoryOptions
  ): Promise<Result<SessionEvent[], SessionError>> {
    return this.streamService.getHistory(sessionId, options);
  }

  async persistEvent(
    sessionId: string,
    event: SessionEvent,
    retryCount = 0
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    return this.streamService.persistEvent(sessionId, event, retryCount);
  }

  async getEventsBySession(
    sessionId: string,
    options?: GetEventsBySessionOptions
  ): Promise<Result<SessionEvent[], SessionError>> {
    return this.streamService.getEventsBySession(sessionId, options);
  }

  async getSessionSummary(sessionId: string): Promise<Result<SessionSummary | null, SessionError>> {
    return this.streamService.getSessionSummary(sessionId);
  }

  async updateSessionSummary(
    sessionId: string,
    updates: Partial<NewSessionSummary>
  ): Promise<Result<SessionSummary, SessionError>> {
    return this.streamService.updateSessionSummary(sessionId, updates);
  }
}
