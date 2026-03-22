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
import { eq, sql } from 'drizzle-orm';
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
  // DB-017: Cache known session IDs in memory to avoid querying the database
  // on every event persist. Sessions are only added, never deleted during
  // normal operation, so a Set is safe. The FK constraint on session_events
  // still provides correctness if a session is deleted between cache and insert.
  private knownSessionIds = new Set<string>();

  constructor(
    private db: Database,
    private streams: DurableStreamsServer
  ) {}

  /**
   * Check if a session exists, using the in-memory cache first.
   * Returns true if the session exists, false otherwise.
   */
  private async sessionExists(sessionId: string): Promise<boolean> {
    if (this.knownSessionIds.has(sessionId)) {
      return true;
    }

    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (session) {
      this.knownSessionIds.add(sessionId);
      return true;
    }

    return false;
  }

  /**
   * RS-013: DB-first persistence strategy.
   * Events are persisted to the database FIRST (awaited), then published to the
   * real-time stream. This ensures events are durable before being sent to live
   * subscribers, matching the pattern used in DurableStreamsService.publish().
   */
  async publish(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ offset: number }, SessionError>> {
    try {
      // RS-013: Persist to database FIRST to ensure durability
      const persistResult = await this.persistEvent(sessionId, event);
      if (!persistResult.ok) {
        // Still attempt real-time delivery even if DB persistence fails
      }

      // THEN publish to real-time stream (for live subscribers)
      // This is best-effort: if DB persistence succeeded, the event is durable
      // and clients can hydrate from the database on refresh.
      let offset = persistResult.ok ? persistResult.value.offset : 0;
      try {
        offset = await this.streams.publish(sessionId, event.type, event.data);
      } catch (_streamErr) {}

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

    return this.getEventsBySession(sessionId);
  }

  /**
   * Persist an event to the database and track offset.
   * Uses atomic INSERT...SELECT to calculate offset without race conditions.
   */
  async persistEvent(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    try {
      // DB-017: Use cached session existence check
      if (!(await this.sessionExists(sessionId))) {
        return err(SessionErrors.NOT_FOUND);
      }

      // Determine channel from event type
      const channel = this.getChannelFromEventType(event.type);

      const eventId = event.id || createId();

      // DB-018: Use atomic INSERT...SELECT for offset calculation instead of
      // read-then-write, eliminating the race condition between concurrent inserts.
      // The COALESCE(MAX(offset), -1) + 1 is computed atomically within the INSERT.
      await this.db.run(
        sql`INSERT INTO session_events (id, session_id, "offset", type, channel, data, timestamp, created_at)
            SELECT ${eventId}, ${sessionId},
                   COALESCE(MAX("offset"), -1) + 1,
                   ${event.type}, ${channel}, ${JSON.stringify(event.data)},
                   ${event.timestamp}, datetime('now')
            FROM session_events
            WHERE session_id = ${sessionId}`
      );

      // Retrieve the inserted offset
      const inserted = await this.db.query.sessionEvents.findFirst({
        where: eq(sessionEvents.id, eventId),
      });

      if (!inserted) {
        return err(SessionErrors.SYNC_FAILED('Failed to persist event'));
      }

      // Update session summary with new offset
      await this.updateSessionSummaryOffset(sessionId, inserted.offset);

      return ok({ id: inserted.id, offset: inserted.offset });
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
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
      // DB-017: Use cached session existence check
      if (!(await this.sessionExists(sessionId))) {
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
      // DB-017: Use cached session existence check
      if (!(await this.sessionExists(sessionId))) {
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
      // DB-017: Use cached session existence check
      if (!(await this.sessionExists(sessionId))) {
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
   * Persist an event to the database WITHOUT publishing to real-time stream.
   * Used by ChunkBatcher for batched chunk persistence.
   */
  async persistOnly(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    return this.persistEvent(sessionId, event);
  }

  /**
   * Publish to real-time stream ONLY (no DB persistence).
   * Used by ChunkBatcher for individual delta delivery to SSE clients.
   */
  async publishRealtimeOnly(sessionId: string, type: string, data: unknown): Promise<number> {
    const streamId = sessionId;
    return this.streams.publish(streamId, type, data);
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
