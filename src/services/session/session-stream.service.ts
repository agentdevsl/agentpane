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
import { and, desc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import type { NewSessionSummary, SessionSummary } from '../../db/schema';
import { sessionEvents, sessionSummaries, sessions } from '../../db/schema';
import { getDbDialect, runRaw } from '../../lib/db/dialect.js';
import type { SessionError } from '../../lib/errors/session-errors.js';
import { SessionErrors } from '../../lib/errors/session-errors.js';
import {
  requirePayloadStreamMetadata,
  STREAM_PROTOCOL_MIGRATION_GATE,
} from '../../lib/streams/envelope.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import { enqueueOutboxEvent, enqueueOutboxEventSync } from '../event-outbox-relay.service.js';
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

  private getStructuredSessionMetadata(
    event: SessionEvent
  ): Result<import('../../lib/streams/envelope.js').StreamEventMetadata, SessionError> {
    const metadataResult = requirePayloadStreamMetadata(
      event.data,
      `Session event '${event.type}'`
    );

    if (!metadataResult.ok) {
      return err(
        SessionErrors.PROTOCOL_MISMATCH(metadataResult.error.message, {
          gate: STREAM_PROTOCOL_MIGRATION_GATE,
          type: event.type,
          reason: metadataResult.error.code,
        })
      );
    }

    return ok(metadataResult.value);
  }

  private validateStructuredSessionEventForStream(
    sessionId: string,
    event: SessionEvent
  ): Result<void, SessionError> {
    const metadataResult = this.getStructuredSessionMetadata(event);
    if (!metadataResult.ok) {
      return err(metadataResult.error);
    }

    const metadata = metadataResult.value;

    if (metadata.streamId !== sessionId) {
      return err(
        SessionErrors.PROTOCOL_MISMATCH(
          `Session event '${event.type}' targets stream '${metadata.streamId}' but was published to '${sessionId}'.`,
          {
            gate: STREAM_PROTOCOL_MIGRATION_GATE,
            type: event.type,
            reason: 'CONFLICTING_METADATA',
            expectedStreamId: sessionId,
            actualStreamId: metadata.streamId,
          }
        )
      );
    }

    if (metadata.eventId !== event.id) {
      return err(
        SessionErrors.PROTOCOL_MISMATCH(
          `Session event '${event.type}' has payload eventId '${metadata.eventId}' but wrapper id '${event.id}'.`,
          {
            gate: STREAM_PROTOCOL_MIGRATION_GATE,
            type: event.type,
            reason: 'CONFLICTING_METADATA',
            expectedEventId: event.id,
            actualEventId: metadata.eventId,
          }
        )
      );
    }

    return ok(undefined);
  }

  /**
   * Events are persisted with an outbox row in the same transaction. The
   * outbox relay owns live delivery, so session events use the same durable
   * publish pipeline as the app-level stream service.
   */
  async publish(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ offset: number }, SessionError>> {
    const validationResult = this.validateStructuredSessionEventForStream(sessionId, event);
    if (!validationResult.ok) {
      return err(validationResult.error);
    }

    try {
      const persistResult = await this.persistEventAndOutbox(sessionId, event);
      if (!persistResult.ok) {
        return err(persistResult.error);
      }

      return ok({ offset: persistResult.value.offset });
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
    return this.persistEventInternal(sessionId, event, false);
  }

  private async persistEventAndOutbox(
    sessionId: string,
    event: SessionEvent
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    return this.persistEventInternal(sessionId, event, true);
  }

  private async persistEventInternal(
    sessionId: string,
    event: SessionEvent,
    enqueueForLiveDelivery: boolean
  ): Promise<Result<{ id: string; offset: number }, SessionError>> {
    const validationResult = this.validateStructuredSessionEventForStream(sessionId, event);
    if (!validationResult.ok) {
      return err(validationResult.error);
    }

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
      //
      // Concurrency safety:
      // - SQLite: Serialized writes guarantee no two inserts see the same MAX(offset).
      // - PostgreSQL: The UNIQUE index on (session_id, offset) prevents duplicates.
      //   If a constraint violation occurs, the error is caught below and returned
      //   as SYNC_FAILED — the caller (publish()) can retry.
      // F02-15: capture `created_at` as a JS-side ISO string so the same
      // value round-trips through both SQLite and Postgres without relying
      // on the SQLite-only `datetime('now')` literal. `runRaw` dispatches
      // to `db.run()` (SQLite) or `db.execute()` (Postgres) — both support
      // this INSERT...SELECT pattern.
      // F05-25: derive `stream_kind` from the streamId prefix and persist it.
      const createdAtIso = new Date().toISOString();
      const streamKind =
        sessionId === 'cli-monitor'
          ? 'cli-monitor'
          : sessionId.startsWith('plan:')
            ? 'plan'
            : sessionId.startsWith('sandbox:')
              ? 'sandbox'
              : sessionId.startsWith('terraform:')
                ? 'terraform'
                : sessionId.startsWith('topology:')
                  ? 'topology'
                  : 'session';
      const insertSql = sql`INSERT INTO session_events (id, session_id, stream_kind, "offset", type, channel, data, timestamp, created_at)
          SELECT ${eventId}, ${sessionId}, ${streamKind},
                 COALESCE(MAX("offset"), -1) + 1,
                 ${event.type}, ${channel}, ${JSON.stringify(event.data)},
                 ${event.timestamp}, ${createdAtIso}
          FROM session_events
          WHERE session_id = ${sessionId}`;

      const inserted =
        getDbDialect() === 'sqlite'
          ? this.db.transaction((tx) => {
              const transactionalDb = tx as Database;
              (
                transactionalDb as unknown as {
                  run: (query: typeof insertSql) => { changes: number };
                }
              ).run(insertSql);

              const [persisted] = transactionalDb
                .select()
                .from(sessionEvents)
                .where(eq(sessionEvents.id, eventId))
                .limit(1)
                .all() as Array<typeof sessionEvents.$inferSelect>;

              if (!persisted) {
                throw new Error('Failed to persist event');
              }

              this.updateSessionSummaryOffsetSync(sessionId, persisted.offset, transactionalDb);

              if (enqueueForLiveDelivery) {
                enqueueOutboxEventSync(transactionalDb, {
                  streamId: sessionId,
                  type: event.type,
                  payload: event.data,
                });
              }

              return { id: persisted.id, offset: persisted.offset };
            })
          : await this.db.transaction(async (tx) => {
              const transactionalDb = tx as Database;
              await runRaw(transactionalDb, insertSql);

              const [persisted] = await transactionalDb
                .select()
                .from(sessionEvents)
                .where(eq(sessionEvents.id, eventId))
                .limit(1);

              if (!persisted) {
                throw new Error('Failed to persist event');
              }

              await this.updateSessionSummaryOffset(sessionId, persisted.offset, transactionalDb);

              if (enqueueForLiveDelivery) {
                await enqueueOutboxEvent(transactionalDb, {
                  streamId: sessionId,
                  type: event.type,
                  payload: event.data,
                });
              }

              return { id: persisted.id, offset: persisted.offset };
            });

      return ok(inserted);
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
      const afterEventId = options?.afterEventId;
      const beforeOffset = options?.beforeOffset;
      const fromOffset = options?.fromOffset;
      const toOffset = options?.toOffset;

      if (afterEventId) {
        const anchor = await this.db.query.sessionEvents.findFirst({
          where: and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.id, afterEventId)),
        });

        if (!anchor) {
          return err(SessionErrors.RESUME_POINT_NOT_FOUND(afterEventId));
        }

        const events = await this.db.query.sessionEvents.findMany({
          where: and(
            eq(sessionEvents.sessionId, sessionId),
            gt(sessionEvents.offset, anchor.offset)
          ),
          orderBy: [sessionEvents.offset],
          limit,
        });

        return ok(
          events.map((e) => ({
            id: e.id,
            type: e.type as SessionEventType,
            timestamp: e.timestamp,
            data: e.data,
            offset: e.offset,
          }))
        );
      }

      // F05-06: contiguous range fetch for client-side gap detection on reconnect.
      if (
        typeof fromOffset === 'number' &&
        typeof toOffset === 'number' &&
        toOffset >= fromOffset
      ) {
        const events = await this.db.query.sessionEvents.findMany({
          where: and(
            eq(sessionEvents.sessionId, sessionId),
            gte(sessionEvents.offset, fromOffset),
            lte(sessionEvents.offset, toOffset)
          ),
          orderBy: [sessionEvents.offset],
          limit,
        });
        return ok(
          events.map((e) => ({
            id: e.id,
            type: e.type as SessionEventType,
            timestamp: e.timestamp,
            data: e.data,
            offset: e.offset,
          }))
        );
      }

      // F05-04: "load earlier" — strictly before this offset, newest first.
      if (typeof beforeOffset === 'number') {
        const events = await this.db.query.sessionEvents.findMany({
          where: and(
            eq(sessionEvents.sessionId, sessionId),
            lt(sessionEvents.offset, beforeOffset)
          ),
          orderBy: [desc(sessionEvents.offset)],
          limit,
        });
        // Return in ascending order to match the default semantics.
        return ok(
          events.reverse().map((e) => ({
            id: e.id,
            type: e.type as SessionEventType,
            timestamp: e.timestamp,
            data: e.data,
            offset: e.offset,
          }))
        );
      }

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
          offset: e.offset,
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
    const metadataResult = requirePayloadStreamMetadata(data, `Realtime session event '${type}'`);
    if (!metadataResult.ok) {
      throw new Error(metadataResult.error.message);
    }

    if (metadataResult.value.streamId !== sessionId) {
      throw new Error(
        `Realtime session event '${type}' targets stream '${metadataResult.value.streamId}' but was published to '${sessionId}'.`
      );
    }

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
  private async updateSessionSummaryOffset(
    sessionId: string,
    _offset: number,
    db: Database = this.db
  ): Promise<void> {
    await db
      .insert(sessionSummaries)
      .values({
        sessionId,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: sessionSummaries.sessionId,
        set: {
          updatedAt: new Date().toISOString(),
        },
      });
  }

  private updateSessionSummaryOffsetSync(
    sessionId: string,
    _offset: number,
    db: Database = this.db
  ): void {
    db.insert(sessionSummaries)
      .values({
        sessionId,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: sessionSummaries.sessionId,
        set: {
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }
}
