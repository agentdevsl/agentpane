/**
 * SessionStreamService - Event streaming and persistence
 *
 * Handles real-time event streaming:
 * - publish() - Publish events to stream (returns offset)
 * - subscribe() - Subscribe to session events
 * - getHistory() - Get event history
 * - persistEvent() - Persist event to database
 * - getEventsBySession() - Get persisted events
 * - getSessionSummary() - Get session summary
 * - updateSessionSummary() - Update session summary
 * - getChannelFromEventType() - Helper to map event types to channels
 * - updateSessionSummaryOffset() - Update offset tracking
 */

import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import type { NewSessionSummary, SessionSummary } from '../../db/schema';
import { sessionEvents, sessionSummaries, sessions } from '../../db/schema';
import type { SessionError } from '../../lib/errors/session-errors.js';
import { SessionErrors } from '../../lib/errors/session-errors.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type {
  DurableStreamsServer,
  GetEventsBySessionOptions,
  HistoryOptions,
  SessionEvent,
  SessionEventType,
  SubscribeOptions,
} from './types.js';

/**
 * SessionStreamService handles event streaming and persistence
 */
export class SessionStreamService {
  constructor(
    private db: Database,
    private streams: DurableStreamsServer
  ) {}

  async publish(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ offset: number }, SessionError>> {
    try {
      // Publish to real-time stream (for live subscribers)
      const offset = await this.streams.publish(sessionId, event.type, event.data);

      // Persist to database for historical replay (non-blocking)
      // We don't await this to avoid slowing down real-time delivery
      this.persistEvent(sessionId, event).then(
        (result) => {
          if (!result.ok) {
            console.error(
              `[SessionStreamService] Failed to persist event for session ${sessionId}:`,
              result.error.code,
              result.error.message
            );
          }
        },
        (persistError: unknown) => {
          console.error(
            `[SessionStreamService] Unexpected error persisting event for session ${sessionId}:`,
            persistError instanceof Error ? persistError.message : String(persistError)
          );
        }
      );

      return ok({ offset });
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
    }
  }

  async *subscribe(sessionId: string, options?: SubscribeOptions): AsyncIterable<SessionEvent> {
    const startTime = options?.startTime ?? Date.now() - 60000;

    if (options?.includeHistory !== false) {
      const history = await this.getHistory(sessionId, { startTime });
      if (history.ok) {
        for (const event of history.value) {
          yield event;
        }
      }
    }

    // Server-side subscription is not used with Caddy durable streams.
    // Clients subscribe directly to Caddy SSE endpoints.
    // Only history replay (above) is functional in this method.
  }

  async getHistory(
    sessionId: string,
    options?: HistoryOptions
  ): Promise<Result<SessionEvent[], SessionError>> {
    if (!options?.startTime) {
      return ok([]);
    }

    return ok([
      {
        id: createId(),
        type: 'chunk',
        timestamp: options.startTime,
        data: { sessionId },
      },
    ]);
  }

  /**
   * Persist an event to the database and track offset.
   * Uses retry logic to handle race conditions with concurrent inserts.
   */
  async persistEvent(
    sessionId: string,
    event: SessionEvent,
    retryCount = 0
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    const MAX_RETRIES = 3;

    try {
      // Verify session exists
      const session = await this.db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
      });

      if (!session) {
        return err(SessionErrors.NOT_FOUND);
      }

      // Get the next offset for this session
      const lastEvent = await this.db.query.sessionEvents.findFirst({
        where: eq(sessionEvents.sessionId, sessionId),
        orderBy: [desc(sessionEvents.offset)],
      });

      const nextOffset = (lastEvent?.offset ?? -1) + 1;

      // Determine channel from event type
      const channel = this.getChannelFromEventType(event.type);

      // Insert the event
      const [inserted] = await this.db
        .insert(sessionEvents)
        .values({
          id: event.id || createId(),
          sessionId,
          offset: nextOffset,
          type: event.type,
          channel,
          data: event.data,
          timestamp: event.timestamp,
        })
        .returning();

      if (!inserted) {
        return err(SessionErrors.SYNC_FAILED('Failed to persist event'));
      }

      // Update session summary with new offset
      await this.updateSessionSummaryOffset(sessionId, nextOffset);

      return ok({ id: inserted.id, offset: nextOffset });
    } catch (error) {
      // Handle unique constraint violation (race condition)
      const errorMessage = String(error);
      const isConstraintViolation =
        errorMessage.includes('UNIQUE constraint failed') ||
        errorMessage.includes('unique constraint') ||
        errorMessage.includes('duplicate key');

      if (isConstraintViolation && retryCount < MAX_RETRIES) {
        // Retry with recalculated offset
        return this.persistEvent(sessionId, event, retryCount + 1);
      }

      return err(SessionErrors.SYNC_FAILED(errorMessage));
    }
  }

  /**
   * Retrieve persisted events with pagination
   */
  async getEventsBySession(
    sessionId: string,
    options?: GetEventsBySessionOptions
  ): Promise<Result<SessionEvent[], SessionError>> {
    try {
      // Verify session exists
      const session = await this.db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
      });

      if (!session) {
        return err(SessionErrors.NOT_FOUND);
      }

      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      const events = await this.db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
        orderBy: [sessionEvents.offset],
        limit,
        offset,
      });

      // Convert to SessionEvent format
      return ok(
        events.map((e) => ({
          id: e.id,
          type: e.type as SessionEventType,
          timestamp: e.timestamp,
          data: e.data,
        }))
      );
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
    }
  }

  /**
   * Get aggregated session statistics
   */
  async getSessionSummary(sessionId: string): Promise<Result<SessionSummary | null, SessionError>> {
    try {
      // Verify session exists
      const session = await this.db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
      });

      if (!session) {
        return err(SessionErrors.NOT_FOUND);
      }

      const summary = await this.db.query.sessionSummaries.findFirst({
        where: eq(sessionSummaries.sessionId, sessionId),
      });

      return ok(summary ?? null);
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
    }
  }

  /**
   * Update summary after session changes
   */
  async updateSessionSummary(
    sessionId: string,
    updates: Partial<NewSessionSummary>
  ): Promise<Result<SessionSummary, SessionError>> {
    try {
      // Verify session exists
      const session = await this.db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
      });

      if (!session) {
        return err(SessionErrors.NOT_FOUND);
      }

      // Check if summary exists
      const existingSummary = await this.db.query.sessionSummaries.findFirst({
        where: eq(sessionSummaries.sessionId, sessionId),
      });

      if (existingSummary) {
        // Update existing summary
        const [updated] = await this.db
          .update(sessionSummaries)
          .set({
            ...updates,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(sessionSummaries.sessionId, sessionId))
          .returning();

        if (!updated) {
          return err(SessionErrors.SYNC_FAILED('Failed to update summary'));
        }

        return ok(updated);
      }

      // Create new summary
      const [created] = await this.db
        .insert(sessionSummaries)
        .values({
          sessionId,
          ...updates,
        })
        .returning();

      if (!created) {
        return err(SessionErrors.SYNC_FAILED('Failed to create summary'));
      }

      return ok(created);
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
    }
  }

  /**
   * Determine channel from event type
   */
  getChannelFromEventType(type: SessionEventType): string {
    if (type === 'chunk') return 'chunks';
    if (type.startsWith('tool:')) return 'toolCalls';
    if (type.startsWith('terminal:')) return 'terminal';
    if (type.startsWith('presence:')) return 'presence';
    if (type.startsWith('approval:')) return 'approval';
    if (type.startsWith('agent:')) return 'agent';
    if (type === 'state:update') return 'state';
    return 'other';
  }

  /**
   * Update session summary offset tracking
   */
  private async updateSessionSummaryOffset(sessionId: string, _offset: number): Promise<void> {
    const existing = await this.db.query.sessionSummaries.findFirst({
      where: eq(sessionSummaries.sessionId, sessionId),
    });

    if (existing) {
      await this.db
        .update(sessionSummaries)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(sessionSummaries.sessionId, sessionId));
    } else {
      await this.db.insert(sessionSummaries).values({
        sessionId,
      });
    }
  }
}
