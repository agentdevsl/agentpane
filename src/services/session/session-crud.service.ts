/**
 * SessionCrudService - Session CRUD operations
 *
 * Handles basic session lifecycle:
 * - create() - Create new session
 * - getById() - Get session by ID
 * - list() - List sessions with pagination
 * - close() - Close a session
 * - listSessionsWithFilters() - List with filters
 * - generateUrl() - Generate session URL
 * - parseUrl() - Parse session URL
 */

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import type { Session } from '../../db/schema';
import { codespaces, sessionEvents, sessions } from '../../db/schema';
import { CodespaceErrors } from '../../lib/errors/codespace-errors.js';
import type { SessionError } from '../../lib/errors/session-errors.js';
import { SessionErrors } from '../../lib/errors/session-errors.js';
import { ValidationErrors } from '../../lib/errors/validation-errors.js';
import { sessionSchema } from '../../lib/integrations/durable-streams/schema.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type {
  ActiveUser,
  CreateSessionInput,
  DurableStreamsServer,
  ListSessionsOptions,
  ListSessionsWithFiltersOptions,
  SessionServiceConfig,
  SessionWithPresence,
} from './types.js';

/**
 * SessionCrudService handles basic session CRUD operations
 */
export class SessionCrudService {
  constructor(
    private db: Database,
    private streams: DurableStreamsServer,
    private config: SessionServiceConfig,
    private presenceStore: Map<string, Map<string, ActiveUser>>
  ) {}

  async create(input: CreateSessionInput): Promise<Result<SessionWithPresence, SessionError>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, input.codespaceId),
    });

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    const sessionId = createId();
    const url = this.generateUrl(sessionId);

    const [session] = await this.db
      .insert(sessions)
      .values({
        id: sessionId,
        codespaceId: input.codespaceId,
        taskId: input.taskId,
        agentId: input.agentId,
        title: input.title,
        url,
        status: 'initializing',
        createdAt: new Date().toISOString(),
      })
      .returning();

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    this.presenceStore.set(sessionId, new Map());
    await this.streams.createStream(sessionId, sessionSchema);

    const [activated] = await this.db
      .update(sessions)
      .set({ status: 'active' })
      .where(eq(sessions.id, sessionId))
      .returning({ id: sessions.id });
    softInvariant(!!activated, 'session activation expected 1 row', { sessionId });

    return ok({ ...session, status: 'active', presence: [] });
  }

  async getById(id: string): Promise<Result<SessionWithPresence, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    const presence = Array.from(this.presenceStore.get(id)?.values() ?? []);

    return ok({ ...session, presence });
  }

  async list(options?: ListSessionsOptions): Promise<Result<SessionWithPresence[], SessionError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy ?? 'updatedAt';
    const direction = options?.orderDirection ?? 'desc';

    const orderColumn = orderBy === 'createdAt' ? sessions.createdAt : sessions.updatedAt;

    // F07-01: when a cursor is supplied, query strictly after the cursor
    // position using a compound `(sortValue, id)` comparison. The route
    // handler is responsible for passing `limit + 1` and slicing the
    // overflow row via `paginate()` to detect `hasMore` — this method does
    // NOT add a redundant `+ 1` on top.
    //
    // Precondition: sort columns (`sessions.createdAt`, `sessions.updatedAt`)
    // are declared `.notNull()` in the SQLite and Postgres schemas, so the
    // compound `col < v` comparison always yields a boolean (never NULL).
    // If a nullable sort column is ever added, wrap with COALESCE or use
    // explicit NULL ordering so pagination does not silently break.
    const cursor = options?.cursor;
    let where: ReturnType<typeof and> | undefined;
    let fetchOffset = offset;
    if (cursor) {
      const sortVal = cursor.sortValue;
      // Compound tuple comparison:
      //   desc: (col, id) < (sortVal, cursorId)
      //   asc : (col, id) > (sortVal, cursorId)
      // SQL: `(col < v) OR (col = v AND id < cursorId)` (flip < for asc).
      const primary =
        direction === 'desc' ? sql`${orderColumn} < ${sortVal}` : sql`${orderColumn} > ${sortVal}`;
      const tiebreak =
        direction === 'desc'
          ? sql`(${orderColumn} = ${sortVal} AND ${sessions.id} < ${cursor.id})`
          : sql`(${orderColumn} = ${sortVal} AND ${sessions.id} > ${cursor.id})`;
      where = and(sql`(${primary} OR ${tiebreak})`) as ReturnType<typeof and>;
      fetchOffset = 0;
    }

    const items = await this.db.query.sessions.findMany({
      where,
      orderBy: (direction === 'asc'
        ? [orderColumn, sessions.id]
        : [desc(orderColumn), desc(sessions.id)]) as never,
      limit,
      offset: fetchOffset,
    });

    return ok(
      items.map((s: Session) => ({
        ...s,
        presence: Array.from(this.presenceStore.get(s.id)?.values() ?? []),
        // Mirror updatedAt as lastActivityAt for client UIs that group by
        // recency rather than session creation time. See the equivalent
        // mapping in `listSessionsWithFilters` for context.
        lastActivityAt: (s.updatedAt ?? s.createdAt) as string | undefined,
      }))
    );
  }

  async close(id: string): Promise<Result<SessionWithPresence, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    // Idempotent: if already closed, return current state without updating closedAt
    if (session.status === 'closed') {
      return ok({
        ...session,
        presence: Array.from(this.presenceStore.get(id)?.values() ?? []),
      });
    }

    const [updated] = await this.db
      .update(sessions)
      .set({ status: 'closed', closedAt: new Date().toISOString() })
      .where(eq(sessions.id, id))
      .returning();

    if (!updated) {
      return err(SessionErrors.NOT_FOUND);
    }

    return ok({ ...updated, presence: Array.from(this.presenceStore.get(id)?.values() ?? []) });
  }

  /**
   * Enhanced list with status/date/search filters
   */
  async listSessionsWithFilters(
    codespaceId: string,
    options?: ListSessionsWithFiltersOptions
  ): Promise<Result<{ sessions: SessionWithPresence[]; total: number }, SessionError>> {
    try {
      // Build filter conditions
      const conditions = [eq(sessions.codespaceId, codespaceId)];

      if (options?.status && options.status.length > 0) {
        conditions.push(inArray(sessions.status, options.status));
      }

      if (options?.agentId) {
        conditions.push(eq(sessions.agentId, options.agentId));
      }

      if (options?.dateFrom) {
        conditions.push(gte(sessions.createdAt, options.dateFrom));
      }

      if (options?.dateTo) {
        conditions.push(lte(sessions.createdAt, options.dateTo));
      }

      if (options?.search) {
        conditions.push(like(sessions.title, `%${options.search}%`));
      }

      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;

      // Get total count
      const countResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(sessions)
        .where(and(...conditions));

      const total = countResult[0]?.count ?? 0;

      // Get paginated sessions, ordered by *latest activity* rather than
      // session creation time. A session row is created once when its task
      // first runs and is reused on every subsequent re-trigger of that
      // task, so `sessions.createdAt` reflects the task's first run, not
      // when an agent last did something. `sessions.updatedAt` is touched
      // by the session lifecycle on every state change (status/agentId
      // updates, etc.), and that's a reliable signal of recent activity
      // already maintained for both SQLite and Postgres schemas — no need
      // for a correlated subquery against session_events.
      const items = await this.db.query.sessions.findMany({
        where: and(...conditions),
        orderBy: [desc(sessions.updatedAt)],
        limit,
        offset,
      });

      // Add presence + lastActivityAt to each session. lastActivityAt
      // mirrors updatedAt today; exposing it as a distinct field lets the
      // UI render "Today" / "Yesterday" buckets without coupling to the
      // server-side sort key, and leaves room to wire it to a more precise
      // signal (e.g. MAX(session_events.timestamp)) later without breaking
      // clients.
      const sessionsWithPresence: SessionWithPresence[] = items.map((s: Session) => ({
        ...s,
        presence: Array.from(this.presenceStore.get(s.id)?.values() ?? []),
        lastActivityAt: (s.updatedAt ?? s.createdAt) as string | undefined,
      }));

      return ok({ sessions: sessionsWithPresence, total });
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(String(error)));
    }
  }

  generateUrl(sessionId: string): string {
    return `${this.config.baseUrl}/sessions/${sessionId}`;
  }

  parseUrl(url: string): Result<string, SessionError> {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/sessions\/([a-z0-9]+)$/i);
      const sessionId = match?.[1];
      if (!sessionId) {
        return err(ValidationErrors.INVALID_URL(url));
      }
      return ok(sessionId);
    } catch {
      return err(ValidationErrors.INVALID_URL(url));
    }
  }

  async delete(id: string): Promise<Result<{ deleted: boolean }, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    // Explicitly delete session_events (no FK cascade — session_events stores
    // events for multiple stream types, not just sessions)
    await this.db.delete(sessionEvents).where(eq(sessionEvents.sessionId, id));

    // Delete the session (cascade handles session_summaries)
    await this.db.delete(sessions).where(eq(sessions.id, id));

    // Clean up presence store
    this.presenceStore.delete(id);

    return ok({ deleted: true });
  }
}
