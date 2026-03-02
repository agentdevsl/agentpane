/**
 * Session Data Hooks
 *
 * React hooks for accessing session data from TanStack DB collections
 * with live reactive updates.
 *
 * @module lib/sessions/hooks/use-session-data
 */

import { eq } from '@tanstack/db';
import { useEffect, useRef, useState } from 'react';
import { useCollectionQuery } from '../../db/use-collection-query.js';
import {
  agentStateCollection,
  chunksCollection,
  messagesCollection,
  presenceCollection,
  terminalCollection,
  toolCallsCollection,
} from '../collections.js';
import type {
  AgentStateEvent,
  ChunkEvent,
  Message,
  PresenceEvent,
  TerminalEvent,
  ToolCallEvent,
} from '../schema.js';
import { stopSessionSync, syncSessionToCollections } from '../sync.js';

/**
 * Hook to get all chunks for a session with live updates
 */
export function useSessionChunks(sessionId: string): ChunkEvent[] {
  const { data } = useCollectionQuery<ChunkEvent>((q) =>
    q
      .from({ chunks: chunksCollection })
      .where(({ chunks }: { chunks: ChunkEvent }) => eq(chunks.sessionId, sessionId))
  );

  return data ?? [];
}

/**
 * Hook to get all tool calls for a session with live updates
 */
export function useSessionToolCalls(sessionId: string): ToolCallEvent[] {
  const { data } = useCollectionQuery<ToolCallEvent>((q) =>
    q
      .from({ tools: toolCallsCollection })
      .where(({ tools }: { tools: ToolCallEvent }) => eq(tools.sessionId, sessionId))
  );

  return data ?? [];
}

/**
 * Hook to get pending tool calls for a session
 */
export function usePendingToolCalls(sessionId: string): ToolCallEvent[] {
  const toolCalls = useSessionToolCalls(sessionId);
  return toolCalls.filter((t) => t.status === 'pending' || t.status === 'running');
}

/**
 * Hook to get active presence for a session (users seen in last 30 seconds)
 */
export function useSessionPresence(sessionId: string, maxAgeMs = 30000): PresenceEvent[] {
  const cutoff = Date.now() - maxAgeMs;

  const { data } = useCollectionQuery<PresenceEvent>(
    (q) =>
      q
        .from({ presence: presenceCollection })
        .where(({ presence }: { presence: PresenceEvent }) => eq(presence.sessionId, sessionId)),
    [sessionId]
  );

  // Filter by lastSeen in memory since it changes frequently
  return (data ?? []).filter((p) => p.lastSeen > cutoff);
}

/**
 * Hook to get terminal events for a session with live updates
 */
export function useSessionTerminal(sessionId: string): TerminalEvent[] {
  const { data } = useCollectionQuery<TerminalEvent>((q) =>
    q
      .from({ terminal: terminalCollection })
      .where(({ terminal }: { terminal: TerminalEvent }) => eq(terminal.sessionId, sessionId))
  );

  return data ?? [];
}

/**
 * Hook to get the current agent state for a session
 */
export function useSessionAgentState(sessionId: string, agentId?: string): AgentStateEvent | null {
  const { data } = useCollectionQuery<AgentStateEvent>((q) =>
    q
      .from({ state: agentStateCollection })
      .where(({ state }: { state: AgentStateEvent }) => eq(state.sessionId, sessionId))
  );

  if (!data || data.length === 0) return null;

  // If specific agent requested, find it
  if (agentId) {
    return data.find((s) => s.agentId === agentId) ?? null;
  }

  // Return first agent state
  return data[0] ?? null;
}

/**
 * Hook to get derived messages for a session
 */
export function useSessionMessages(sessionId: string): Message[] {
  const { data } = useCollectionQuery<Message>((q) =>
    q
      .from({ messages: messagesCollection })
      .where(({ messages }: { messages: Message }) => eq(messages.sessionId, sessionId))
  );

  return data ?? [];
}

/**
 * Hook to get full accumulated text for a session from chunks
 */
export function useSessionFullText(sessionId: string): string {
  const chunks = useSessionChunks(sessionId);
  return chunks.map((c) => c.text).join('');
}

/**
 * Combined hook for all session data with automatic sync management
 */
export interface UseSessionDataResult {
  chunks: ChunkEvent[];
  toolCalls: ToolCallEvent[];
  pendingToolCalls: ToolCallEvent[];
  presence: PresenceEvent[];
  terminal: TerminalEvent[];
  messages: Message[];
  agentState: AgentStateEvent | null;
  fullText: string;
  isLoading: boolean;
  isSyncing: boolean;
}

export function useSessionData(sessionId: string): UseSessionDataResult {
  const [isSyncing, setIsSyncing] = useState(false);
  const syncStartedRef = useRef(false);

  // Start syncing when the hook mounts
  useEffect(() => {
    if (syncStartedRef.current) return;

    syncStartedRef.current = true;
    setIsSyncing(true);

    const unsubscribe = syncSessionToCollections(sessionId);

    return () => {
      unsubscribe();
      stopSessionSync(sessionId);
      syncStartedRef.current = false;
      setIsSyncing(false);
    };
  }, [sessionId]);

  // Get all data with live queries
  const chunks = useSessionChunks(sessionId);
  const toolCalls = useSessionToolCalls(sessionId);
  const presence = useSessionPresence(sessionId);
  const terminal = useSessionTerminal(sessionId);
  const messages = useSessionMessages(sessionId);
  const agentState = useSessionAgentState(sessionId);

  const pendingToolCalls = toolCalls.filter(
    (t) => t.status === 'pending' || t.status === 'running'
  );
  const fullText = chunks.map((c) => c.text).join('');

  // Consider loading if syncing and no data yet
  const isLoading = isSyncing && chunks.length === 0 && terminal.length === 0;

  return {
    chunks,
    toolCalls,
    pendingToolCalls,
    presence,
    terminal,
    messages,
    agentState,
    fullText,
    isLoading,
    isSyncing,
  };
}
