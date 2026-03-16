import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ConnectionState,
  type SessionAgentState,
  type Subscription,
  subscribeToSession,
} from '@/lib/streams/client';

export type AgentStreamChunk = {
  text: string;
  timestamp: number;
};

export type ToolExecution = {
  id: string;
  tool: string;
  input: unknown;
  output?: unknown;
  status: 'pending' | 'running' | 'complete' | 'error';
  duration?: number;
  timestamp: number;
};

export function useAgentStream(sessionId: string): {
  chunks: AgentStreamChunk[];
  fullText: string;
  isStreaming: boolean;
  connectionState: ConnectionState;
  tools: ToolExecution[];
  agentState: SessionAgentState;
  clearChunks: () => void;
} {
  const [chunks, setChunks] = useState<AgentStreamChunk[]>([]);
  const [tools, setTools] = useState<ToolExecution[]>([]);
  const [agentState, setAgentState] = useState<SessionAgentState>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const subscriptionRef = useRef<Subscription | null>(null);

  useEffect(() => {
    setConnectionState('connecting');

    const subscription = subscribeToSession(sessionId, {
      onChunk: (event) => {
        setChunks((prev) => [
          ...prev,
          {
            text: event.data.text,
            timestamp: event.data.timestamp,
          },
        ]);
        setIsStreaming(true);
      },

      onToolCall: (event) => {
        setTools((prev) => {
          const existingIndex = prev.findIndex((t) => t.id === event.data.id);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...event.data,
            };
            return updated;
          }
          return [...prev, event.data];
        });
      },

      onAgentState: (event) => {
        setAgentState(event.data);
        // Stop streaming indicator when agent completes
        if (
          event.data?.status === 'completed' ||
          event.data?.status === 'error' ||
          event.data?.status === 'idle'
        ) {
          setIsStreaming(false);
        } else if (event.data?.status === 'running') {
          setIsStreaming(true);
        }
      },

      onError: (error) => {
        console.error('[useAgentStream] Stream error:', error);
        setConnectionState('disconnected');
        setIsStreaming(false);
      },

      onReconnect: () => {
        console.log('[useAgentStream] Reconnected to stream');
        setConnectionState('connected');
      },

      onDisconnect: () => {
        console.log('[useAgentStream] Disconnected from stream');
        setConnectionState('reconnecting');
      },
    });

    subscriptionRef.current = subscription;

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
      setIsStreaming(false);
    };
  }, [sessionId]);

  const fullText = useMemo(() => chunks.map((chunk) => chunk.text).join(''), [chunks]);

  const clearChunks = useCallback(() => {
    setChunks([]);
  }, []);

  return {
    chunks,
    fullText,
    isStreaming,
    connectionState,
    tools,
    agentState,
    clearChunks,
  };
}
