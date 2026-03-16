import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionErrors } from '@/lib/errors/session-errors';
import {
  type ConnectionState,
  type SessionCallbacks,
  type Subscription,
  subscribeToSession,
} from '@/lib/streams/client';
import { err, ok, type Result } from '@/lib/utils/result';

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
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const subscriptionRef = useRef<Subscription | null>(null);

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

  // Subscribe to session events with automatic reconnection
  useEffect(() => {
    void joinRef.current();
    setConnectionState('connecting');

    const callbacks: SessionCallbacks = {
      onChunk: (event) => {
        setState((prev) => ({
          ...prev,
          chunks: [
            ...prev.chunks,
            {
              text: event.data.text,
              timestamp: event.data.timestamp,
              agentId: event.data.agentId,
            },
          ],
        }));
      },

      onToolCall: (event) => {
        setState((prev) => {
          const existingIndex = prev.toolCalls.findIndex((t) => t.id === event.data.id);
          if (existingIndex >= 0) {
            // Update existing tool call
            const updated = [...prev.toolCalls];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...event.data,
            };
            return { ...prev, toolCalls: updated };
          }
          // Add new tool call
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
        setConnectionState('disconnected');
      },

      onReconnect: () => {
        console.log('[useSession] Reconnected to session stream');
        setConnectionState('connected');
      },

      onDisconnect: () => {
        console.log('[useSession] Disconnected from session stream');
        setConnectionState('reconnecting');
      },
    };

    // Subscribe using the durable streams client with automatic reconnection
    const subscription = subscribeToSession(sessionId, callbacks);
    subscriptionRef.current = subscription;
    setConnectionState('connected');

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
      void leaveRef.current();
    };
  }, [sessionId]);

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

  const lastOffset = subscriptionRef.current?.getLastOffset() ?? 0;

  return { state, connectionState, lastOffset, join, leave };
}
