/**
 * Optimistic Writes for Session Data
 *
 * Provides optimistic update capabilities for terminal input
 * and presence updates with rollback on failure.
 *
 * @module lib/sessions/optimistic
 */

import { createId } from '@paralleldrive/cuid2';
import { errorMessage } from '../utils/error-message';
import { presenceCollection, terminalCollection } from './collections.js';
import type { PresenceEvent, TerminalEvent } from './schema.js';

/**
 * Options for optimistic terminal input
 */
export interface OptimisticWriteOptions {
  /** Called when optimistic update is applied */
  onOptimistic: (event: TerminalEvent) => void;
  /** Called when write is confirmed by server */
  onConfirm: (event: TerminalEvent, offset: number) => void;
  /** Called when write fails and needs rollback */
  onRollback: (event: TerminalEvent, error: Error) => void;
}

/**
 * Send terminal input with optimistic UI update
 *
 * The event is immediately added to the UI (optimistic),
 * then sent to the server via HTTP POST. On failure,
 * the event is removed (rollback).
 *
 * @param sessionId - The session to send input to
 * @param input - The terminal input string
 * @param options - Callbacks for optimistic, confirm, and rollback
 */
export async function sendTerminalInput(
  sessionId: string,
  input: string,
  options: OptimisticWriteOptions
): Promise<void> {
  // Create optimistic event
  const optimisticEvent: TerminalEvent = {
    id: createId(),
    sessionId,
    type: 'input',
    data: input,
    source: 'user',
    timestamp: Date.now(),
  };

  // Apply optimistic update immediately
  options.onOptimistic(optimisticEvent);

  // Also insert into collection for live queries
  terminalCollection.insert(optimisticEvent);

  try {
    // HTTP POST to append to the stream
    const response = await fetch(`/api/streams?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'terminal',
        data: optimisticEvent,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send: ${response.status}`);
    }

    const result = (await response.json()) as { ok: boolean; offset?: number };
    options.onConfirm(optimisticEvent, result.offset ?? 0);
  } catch (error) {
    const wrappedError = error instanceof Error ? error : new Error(String(error));
    console.error('[Terminal] Failed to send input:', {
      sessionId,
      error: wrappedError.message,
    });
    // Rollback: remove from collection
    terminalCollection.delete(optimisticEvent.id);
    options.onRollback(optimisticEvent, wrappedError);
  }
}

/**
 * Cursor throttle state
 */
let cursorThrottleTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingCursorUpdate: {
  sessionId: string;
  userId: string;
  cursor: { x: number; y: number };
} | null = null;

/** Cursor throttle delay in ms */
const CURSOR_THROTTLE_MS = 50;

/**
 * Send presence update with optimistic cursor position
 *
 * Cursor updates are throttled to prevent excessive network traffic.
 * Fire-and-forget with no rollback (presence is ephemeral).
 *
 * @param sessionId - The session to update presence in
 * @param userId - The user ID
 * @param cursor - The cursor position
 * @param options - Optional callbacks
 */
export function sendPresenceUpdate(
  sessionId: string,
  userId: string,
  cursor: { x: number; y: number },
  options?: {
    onOptimistic?: (cursor: { x: number; y: number }) => void;
  }
): void {
  // Apply optimistic update immediately
  options?.onOptimistic?.(cursor);

  // Store pending update for throttling
  pendingCursorUpdate = { sessionId, userId, cursor };

  // If already throttling, just update the pending value
  if (cursorThrottleTimeout) {
    return;
  }

  // Set up throttled send
  cursorThrottleTimeout = setTimeout(() => {
    cursorThrottleTimeout = null;

    if (pendingCursorUpdate) {
      const { sessionId, userId, cursor } = pendingCursorUpdate;
      pendingCursorUpdate = null;

      // Update collection
      const key = `${sessionId}:${userId}` as `${string}:${string}`;
      const presence: PresenceEvent = {
        userId,
        sessionId,
        cursor,
        lastSeen: Date.now(),
      };

      if (presenceCollection.has(key)) {
        presenceCollection.update(key, (draft) => {
          draft.cursor = cursor;
          draft.lastSeen = Date.now();
        });
      } else {
        presenceCollection.insert(presence);
      }

      // Fire-and-forget HTTP POST
      fetch(`/api/streams?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'presence',
          data: presence,
        }),
      }).catch((error) => {
        console.warn('[Presence] Failed to send update:', error);
      });
    }
  }, CURSOR_THROTTLE_MS);
}

/**
 * Send presence join event
 */
export async function sendPresenceJoin(
  sessionId: string,
  userId: string,
  metadata?: { displayName?: string; avatarUrl?: string }
): Promise<boolean> {
  const key = `${sessionId}:${userId}` as `${string}:${string}`;
  const presence: PresenceEvent = {
    userId,
    sessionId,
    displayName: metadata?.displayName,
    avatarUrl: metadata?.avatarUrl,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
  };

  // Insert into collection
  if (!presenceCollection.has(key)) {
    presenceCollection.insert(presence);
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'join', ...metadata }),
    });

    return response.ok;
  } catch (error) {
    console.error('[Presence] Failed to join session:', {
      sessionId,
      userId,
      error: errorMessage(error),
    });
    return false;
  }
}

/**
 * Send presence leave event
 */
export async function sendPresenceLeave(sessionId: string, userId: string): Promise<boolean> {
  const key = `${sessionId}:${userId}` as `${string}:${string}`;

  // Remove from collection
  if (presenceCollection.has(key)) {
    presenceCollection.delete(key);
  }

  try {
    const response = await fetch(`/api/sessions/${sessionId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'leave' }),
    });

    return response.ok;
  } catch (error) {
    console.error('[Presence] Failed to leave session:', {
      sessionId,
      userId,
      error: errorMessage(error),
    });
    return false;
  }
}
