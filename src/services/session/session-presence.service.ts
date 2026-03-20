/**
 * SessionPresenceService - User presence management
 *
 * Handles user presence in sessions:
 * - join() - User joins session
 * - leave() - User leaves session
 * - updatePresence() - Update user presence/cursor
 * - getActiveUsers() - Get active users in session
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { sessions } from '../../db/schema';
import type { SessionError } from '../../lib/errors/session-errors.js';
import { SessionErrors } from '../../lib/errors/session-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { SessionStreamService } from './session-stream.service.js';
import type { ActiveUser, PresenceUpdate, SessionWithPresence } from './types.js';

const log = createLogger('SessionPresenceService');

/** Stale presence threshold: 30 minutes */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Cleanup sweep interval: 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * SessionPresenceService handles user presence management
 */
export class SessionPresenceService {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly presenceStore = new Map<string, Map<string, ActiveUser>>();

  constructor(
    private db: Database,
    private getStreamService: () => SessionStreamService
  ) {}

  /** Read-only snapshot of the presence store (for testing/debugging). */
  getPresenceStore(): ReadonlyMap<string, ReadonlyMap<string, ActiveUser>> {
    return this.presenceStore;
  }

  async join(
    sessionId: string,
    userId: string
  ): Promise<Result<SessionWithPresence, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    if (session.status === 'closed') {
      return err(SessionErrors.CLOSED);
    }

    const presence = this.presenceStore.get(sessionId) ?? new Map();
    presence.set(userId, { userId, lastSeen: Date.now() });
    this.presenceStore.set(sessionId, presence);

    await this.getStreamService().publish(sessionId, {
      id: createId(),
      type: 'presence:joined',
      timestamp: Date.now(),
      data: { userId },
    });

    return ok({ ...session, presence: Array.from(presence.values()) });
  }

  async leave(
    sessionId: string,
    userId: string
  ): Promise<Result<SessionWithPresence, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    const presence = this.presenceStore.get(sessionId) ?? new Map();
    presence.delete(userId);
    this.presenceStore.set(sessionId, presence);

    await this.getStreamService().publish(sessionId, {
      id: createId(),
      type: 'presence:left',
      timestamp: Date.now(),
      data: { userId },
    });

    return ok({ ...session, presence: Array.from(presence.values()) });
  }

  async updatePresence(
    sessionId: string,
    userId: string,
    presenceUpdate: PresenceUpdate
  ): Promise<Result<void, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    const presence = this.presenceStore.get(sessionId) ?? new Map();
    const current = presence.get(userId);
    if (!current) {
      return err(SessionErrors.NOT_FOUND);
    }

    presence.set(userId, { ...current, ...presenceUpdate, lastSeen: Date.now() });
    this.presenceStore.set(sessionId, presence);

    await this.getStreamService().publish(sessionId, {
      id: createId(),
      type: 'presence:cursor',
      timestamp: Date.now(),
      data: { userId, ...presenceUpdate },
    });

    return ok(undefined);
  }

  async getActiveUsers(sessionId: string): Promise<Result<ActiveUser[], SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    const presence = Array.from(this.presenceStore.get(sessionId)?.values() ?? []);
    return ok(presence);
  }

  /**
   * Sweep stale users from all sessions.
   * Removes any user with `lastSeen` older than 30 minutes and
   * publishes a `presence:timeout` event for each removed user.
   */
  async sweepStaleUsers(): Promise<void> {
    const now = Date.now();
    let removedCount = 0;

    for (const [sessionId, users] of this.presenceStore) {
      for (const [userId, user] of users) {
        if (now - user.lastSeen > STALE_THRESHOLD_MS) {
          users.delete(userId);
          removedCount++;

          // Publish timeout event (fire-and-forget, errors are logged)
          this.getStreamService()
            .publish(sessionId, {
              id: createId(),
              type: 'presence:timeout',
              timestamp: now,
              data: { userId },
            })
            .catch((publishErr) => {
              log.warn('Failed to publish presence:timeout event', {
                error: publishErr,
                data: { sessionId, userId },
              });
            });
        }
      }

      // Clean up empty session maps
      if (users.size === 0) {
        this.presenceStore.delete(sessionId);
      }
    }

    if (removedCount > 0) {
      log.info('Swept stale presence records', { data: { removedCount } });
    }
  }

  /**
   * Start a 5-minute interval that sweeps stale users.
   */
  startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return; // Already running
    }
    this.cleanupTimer = setInterval(() => {
      this.sweepStaleUsers().catch((sweepErr) => {
        log.error('Presence cleanup sweep failed', { error: sweepErr });
      });
    }, CLEANUP_INTERVAL_MS);
    log.info('Presence cleanup timer started', {
      data: { intervalMs: CLEANUP_INTERVAL_MS },
    });
  }

  /**
   * Stop the cleanup interval.
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      log.info('Presence cleanup timer stopped');
    }
  }

  /**
   * Remove all presence records for a given session.
   * Call this when a session is closed.
   */
  clearSession(sessionId: string): void {
    const users = this.presenceStore.get(sessionId);
    if (users) {
      const count = users.size;
      this.presenceStore.delete(sessionId);
      if (count > 0) {
        log.info('Cleared session presence', { data: { sessionId, userCount: count } });
      }
    }
  }
}
