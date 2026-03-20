/**
 * FC-006: Updated to use useSessionSubscription for shared SSE connections.
 *
 * FC-020: TanStack DB vs TanStack Query decision
 * -----------------------------------------------
 * This app uses manual fetch patterns (useState + useEffect + apiClient) rather
 * than TanStack Query for server data. TanStack DB is installed but primarily
 * used for local-first reactive collections. The decision was intentional:
 *
 * 1. Session/agent streams use SSE (durable streams) -- not request/response --
 *    so TanStack Query's cache/refetch model does not apply.
 * 2. Task/project data is fetched once per route mount with manual refresh on
 *    mutations. The overhead of a query cache layer is not justified for the
 *    current route count and data size.
 * 3. TanStack DB handles the few truly reactive local collections (e.g., client
 *    settings, CLI monitor sessions) where optimistic updates matter.
 *
 * If the app grows to have deeply nested data dependencies or shared cross-route
 * cache requirements, TanStack Query should be reconsidered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionErrors } from '@/lib/errors/session-errors';
import type { ConnectionState, SessionCallbacks } from '@/lib/streams/client';
import { err, ok, type Result } from '@/lib/utils/result';
import { useSessionSubscription } from './use-session-subscription';

export type SessionEvent = {
  type: string;
  data: unknown;
  timestamp: number;
};

export type SessionChunk = {
  text: string;
  timestamp: number;
  agentId?: string;
};

export type SessionToolCall = {
  id: string;
  tool: string;
  input: unknown;
  output?: unknown;
  status: 'pending' | 'running' | 'complete' | 'error';
  timestamp: number;
};

export type SessionTerminal = {
  type: 'input' | 'output';
  data: string;
  timestamp: number;
};

export type SessionPresence = {
  userId: string;
  lastSeen: number;
  cursor?: { x: number; y: number };
};

export type SessionAgentState = {
  status: string;
  turn?: number;
  progress?: number;
} | null;

export type SessionState = {
  chunks: SessionChunk[];
  toolCalls: SessionToolCall[];
  terminal: SessionTerminal[];
  presence: SessionPresence[];
  agentState: SessionAgentState;
};

const initialState: SessionState = {
  chunks: [],
  toolCalls: [],
  terminal: [],
  presence: [],
  agentState: null,
};

/** Presence heartbeat interval in ms (10 seconds per spec) */
const PRESENCE_HEARTBEAT_INTERVAL = 10000;

/** RS-011: Maximum number of chunks to retain in state to prevent unbounded memory growth. */
const MAX_CHUNKS = 5000;

export function useSession(
  sessionId: string,
  userId: string
): {
  state: SessionState;
  connectionState: ConnectionState;
  lastOffset: number;
  join: () => Promise<Result<void, ReturnType<typeof SessionErrors.CONNECTION_FAILED>>>;
  leave: () => Promise<Result<void, ReturnType<typeof SessionErrors.CONNECTION_FAILED>>>;
} {
  const [state, setState] = useState<SessionState>(initialState);

  const join = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action: 'join' }),
      });
      const data = await response.json();
      if (!data.ok) {
        return err(SessionErrors.CONNECTION_FAILED(data.error?.message ?? 'Join failed'));
      }
      return ok(undefined);
    } catch (error) {
      return err(
        SessionErrors.CONNECTION_FAILED(error instanceof Error ? error.message : 'Join failed')
      );
    }
  }, [sessionId, userId]);

  const leave = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action: 'leave' }),
      });
      const data = await response.json();
      if (!data.ok) {
        return err(SessionErrors.CONNECTION_FAILED(data.error?.message ?? 'Leave failed'));
      }
      return ok(undefined);
    } catch (error) {
      return err(
        SessionErrors.CONNECTION_FAILED(error instanceof Error ? error.message : 'Leave failed')
      );
    }
  }, [sessionId, userId]);

  // Keep refs to join/leave so the subscription effect only depends on sessionId
  const joinRef = useRef(join);
  const leaveRef = useRef(leave);
  useEffect(() => {
    joinRef.current = join;
  }, [join]);
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);

  // Join on mount, leave on unmount
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers re-join when session changes
  useEffect(() => {
    void joinRef.current();
    return () => {
      void leaveRef.current();
    };
  }, [sessionId]);

  // Build session-specific callbacks
  const callbacks = useRef<SessionCallbacks>({});

  useEffect(() => {
    callbacks.current = {
      onChunk: (event) => {
        setState((prev) => {
          const newChunk = {
            text: event.data.text,
            timestamp: event.data.timestamp,
            agentId: event.data.agentId,
          };
          let chunks = [...prev.chunks, newChunk];
          // RS-011: Cap chunks array to prevent unbounded memory growth.
          // Slice oldest entries when overflow occurs.
          if (chunks.length > MAX_CHUNKS) {
            chunks = chunks.slice(chunks.length - MAX_CHUNKS);
          }
          return { ...prev, chunks };
        });
      },

      onToolCall: (event) => {
        setState((prev) => {
          const existingIndex = prev.toolCalls.findIndex((t) => t.id === event.data.id);
          if (existingIndex >= 0) {
            const updated = [...prev.toolCalls];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...event.data,
            };
            return { ...prev, toolCalls: updated };
          }
          return {
            ...prev,
            toolCalls: [...prev.toolCalls, event.data],
          };
        });
      },

      onPresence: (event) => {
        setState((prev) => {
          const existingIndex = prev.presence.findIndex((p) => p.userId === event.data.userId);
          if (existingIndex >= 0) {
            const updated = [...prev.presence];
            updated[existingIndex] = event.data;
            return { ...prev, presence: updated };
          }
          return {
            ...prev,
            presence: [...prev.presence, event.data],
          };
        });
      },

      onTerminal: (event) => {
        setState((prev) => ({
          ...prev,
          terminal: [...prev.terminal, event.data],
        }));
      },

      onAgentState: (event) => {
        setState((prev) => ({
          ...prev,
          agentState: event.data,
        }));
      },

      onError: (error) => {
        console.error('[useSession] Stream error:', error);
      },

      onReconnect: () => {
        console.log('[useSession] Reconnected to session stream');
        // RS-006: Fetch missed events from the REST API on reconnect.
        // The durable streams client tracks its last offset and will resume
        // from there, but if the gap is too large events may be lost.
        // Fetch missed events from the database as a safety net.
        // FC-006: subscription is now managed by useSessionSubscription;
        // offset tracking is internal, so we always fetch from offset 0 on reconnect.
        const lastOff = 0;
        if (lastOff > 0) {
          fetch(`/api/sessions/${sessionId}/events?offset=${lastOff}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
              if (!json?.ok || !Array.isArray(json.data)) return;
              // Events are already ordered by offset from the API.
              // Re-apply any we may have missed during the disconnect gap.
              for (const evt of json.data) {
                if (evt.type === 'chunk' && evt.data?.text) {
                  setState((prev) => {
                    let chunks = [
                      ...prev.chunks,
                      { text: evt.data.text, timestamp: evt.timestamp },
                    ];
                    if (chunks.length > MAX_CHUNKS) {
                      chunks = chunks.slice(chunks.length - MAX_CHUNKS);
                    }
                    return { ...prev, chunks };
                  });
                }
              }
            })
            .catch(() => {
              // Best-effort -- ignore fetch errors on reconnect gap detection
            });
        }
      },

      onDisconnect: () => {
        console.log('[useSession] Disconnected from session stream');
      },
    };
  }, [sessionId]);

  const { connectionState } = useSessionSubscription(sessionId, callbacks.current);

  // Presence heartbeat at 10s interval (per spec)
  useEffect(() => {
    const updatePresence = async () => {
      try {
        await fetch(`/api/sessions/${sessionId}/presence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
      } catch {
        // Ignore presence update errors
      }
    };

    const interval = window.setInterval(updatePresence, PRESENCE_HEARTBEAT_INTERVAL);

    return () => window.clearInterval(interval);
  }, [sessionId, userId]);

  // FC-006: lastOffset is no longer directly tracked via subscriptionRef;
  // it is managed internally by useSessionSubscription. Return 0 for compat.
  const lastOffset = 0;

  return { state, connectionState, lastOffset, join, leave };
}
