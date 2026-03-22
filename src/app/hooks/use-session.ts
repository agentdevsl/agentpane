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
import { useCallback, useEffectEvent, useRef, useState } from 'react';
import { SessionErrors } from '@/lib/errors/session-errors';
import type { ConnectionState, SessionCallbacks } from '@/lib/streams/client';
import { err, ok, type Result } from '@/lib/utils/result';
import { useInterval } from './use-interval';
import { useMountEffect } from './use-mount-effect';
import { useSessionSubscription } from './use-session-subscription';
import { useWatchEffect } from './use-watch-effect';

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

type PendingSessionUpdates = {
  chunks: SessionChunk[];
  toolCalls: SessionToolCall[];
  terminal: SessionTerminal[];
  presence: SessionPresence[];
  hasAgentState: boolean;
  agentState: SessionAgentState;
};

function createInitialState(): SessionState {
  return {
    chunks: [],
    toolCalls: [],
    terminal: [],
    presence: [],
    agentState: null,
  };
}

function createPendingSessionUpdates(): PendingSessionUpdates {
  return {
    chunks: [],
    toolCalls: [],
    terminal: [],
    presence: [],
    hasAgentState: false,
    agentState: null,
  };
}

function applyPendingSessionUpdates(
  prev: SessionState,
  batch: PendingSessionUpdates
): SessionState {
  let nextState = prev;

  if (batch.chunks.length > 0) {
    const chunks = [...prev.chunks, ...batch.chunks];
    nextState = {
      ...nextState,
      chunks: chunks.length > MAX_CHUNKS ? chunks.slice(chunks.length - MAX_CHUNKS) : chunks,
    };
  }

  if (batch.toolCalls.length > 0) {
    const toolCalls = [...nextState.toolCalls];
    for (const toolCall of batch.toolCalls) {
      const existingIndex = toolCalls.findIndex((item) => item.id === toolCall.id);
      if (existingIndex >= 0) {
        const existing = toolCalls[existingIndex];
        if (existing) {
          toolCalls[existingIndex] = {
            ...existing,
            ...toolCall,
          };
        }
      } else {
        toolCalls.push(toolCall);
      }
    }
    nextState = { ...nextState, toolCalls };
  }

  if (batch.presence.length > 0) {
    const presence = [...nextState.presence];
    for (const activeUser of batch.presence) {
      const existingIndex = presence.findIndex((item) => item.userId === activeUser.userId);
      if (existingIndex >= 0) {
        presence[existingIndex] = activeUser;
      } else {
        presence.push(activeUser);
      }
    }
    nextState = { ...nextState, presence };
  }

  if (batch.terminal.length > 0) {
    nextState = {
      ...nextState,
      terminal: [...nextState.terminal, ...batch.terminal],
    };
  }

  if (batch.hasAgentState) {
    nextState = {
      ...nextState,
      agentState: batch.agentState,
    };
  }

  return nextState;
}

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
  const [state, setState] = useState<SessionState>(createInitialState);
  const pendingUpdatesRef = useRef<PendingSessionUpdates>(createPendingSessionUpdates());
  const flushFrameRef = useRef<number | null>(null);

  const flushPendingUpdates = useEffectEvent(() => {
    const batch = pendingUpdatesRef.current;
    const hasUpdates =
      batch.chunks.length > 0 ||
      batch.toolCalls.length > 0 ||
      batch.terminal.length > 0 ||
      batch.presence.length > 0 ||
      batch.hasAgentState;

    flushFrameRef.current = null;

    if (!hasUpdates) {
      return;
    }

    pendingUpdatesRef.current = createPendingSessionUpdates();
    setState((prev) => applyPendingSessionUpdates(prev, batch));
  });

  const scheduleFlush = useEffectEvent(() => {
    if (flushFrameRef.current !== null) {
      return;
    }

    flushFrameRef.current = requestAnimationFrame(() => {
      flushPendingUpdates();
    });
  });

  const queueChunk = useEffectEvent((chunk: SessionChunk) => {
    pendingUpdatesRef.current.chunks.push(chunk);
    scheduleFlush();
  });

  const queueToolCall = useEffectEvent((toolCall: SessionToolCall) => {
    pendingUpdatesRef.current.toolCalls.push(toolCall);
    scheduleFlush();
  });

  const queuePresence = useEffectEvent((presence: SessionPresence) => {
    pendingUpdatesRef.current.presence.push(presence);
    scheduleFlush();
  });

  const queueTerminal = useEffectEvent((terminal: SessionTerminal) => {
    pendingUpdatesRef.current.terminal.push(terminal);
    scheduleFlush();
  });

  const queueAgentState = useEffectEvent((agentState: SessionAgentState) => {
    pendingUpdatesRef.current.hasAgentState = true;
    pendingUpdatesRef.current.agentState = agentState;
    scheduleFlush();
  });

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

  // useEffectEvent keeps the latest join/leave closures stable across renders
  const stableJoin = useEffectEvent(() => join());
  const stableLeave = useEffectEvent(() => leave());

  useMountEffect(() => {
    return () => {
      if (flushFrameRef.current !== null) {
        cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
    };
  });

  // Join on mount, leave on unmount — re-run when sessionId changes
  useWatchEffect(() => {
    void stableJoin();
    return () => {
      void stableLeave();
    };
  }, [sessionId]);

  useWatchEffect(() => {
    if (flushFrameRef.current !== null) {
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    pendingUpdatesRef.current = createPendingSessionUpdates();
    setState(createInitialState());
  }, [sessionId]);

  // Build session-specific callbacks
  const callbacks = useRef<SessionCallbacks>({});

  const stableOnReconnect = useEffectEvent(() => {
    console.log('[useSession] Reconnected to session stream');
    // Durable stream resume remains the authoritative reconnect mechanism.
    // The REST gap-healing path stays disabled until opaque stream offsets are
    // mapped to durable DB offsets without lossy conversion.
  });

  useWatchEffect(() => {
    callbacks.current = {
      onChunk: (event) => {
        queueChunk({
          text: event.data.text,
          timestamp: event.data.timestamp,
          agentId: event.data.agentId,
        });
      },

      onToolCall: (event) => {
        queueToolCall(event.data);
      },

      onPresence: (event) => {
        queuePresence(event.data);
      },

      onTerminal: (event) => {
        queueTerminal(event.data);
      },

      onAgentState: (event) => {
        queueAgentState(event.data);
      },

      onError: (error) => {
        console.error('[useSession] Stream error:', error);
      },

      onReconnect: () => {
        stableOnReconnect();
      },

      onDisconnect: () => {
        console.log('[useSession] Disconnected from session stream');
      },
    };
  }, [sessionId]);

  const { connectionState } = useSessionSubscription(sessionId, callbacks.current);

  // Presence heartbeat at 10s interval (per spec)
  const heartbeat = useEffectEvent(async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } catch {
      // Ignore presence update errors
    }
  });

  useInterval(() => {
    void heartbeat();
  }, PRESENCE_HEARTBEAT_INTERVAL);

  // FC-006: lastOffset is no longer directly tracked via subscriptionRef;
  // it is managed internally by useSessionSubscription. Return 0 for compat.
  const lastOffset = 0;

  return { state, connectionState, lastOffset, join, leave };
}
