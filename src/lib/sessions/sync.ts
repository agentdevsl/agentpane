/**
 * Durable Streams to TanStack DB Collection Sync
 *
 * Syncs session events from durable streams into TanStack DB collections
 * for reactive data access with live queries.
 *
 * @module lib/sessions/sync
 */

import { createId } from '@paralleldrive/cuid2';
import { type Subscription, subscribeToSession } from '../streams/client.js';
import {
  agentStateCollection,
  chunksCollection,
  messagesCollection,
  presenceCollection,
  terminalCollection,
  toolCallsCollection,
  workflowCollection,
} from './collections.js';
import type {
  AgentStateEvent,
  ChunkEvent,
  Message,
  PresenceEvent,
  TerminalEvent,
  ToolCallEvent,
  WorkflowEvent,
} from './schema.js';

/**
 * Active sync subscriptions by session ID
 */
const activeSyncs = new Map<string, Subscription>();

/**
 * Message accumulator for deriving messages from chunks
 * Key: `${sessionId}:${agentId}-${turn}` (includes sessionId for proper cleanup)
 */
const messageAccumulators = new Map<string, { text: string; lastTimestamp: number }>();

/**
 * Sync a session's events to TanStack DB collections
 *
 * @param sessionId - The session ID to sync
 * @returns Unsubscribe function to stop syncing
 */
export function syncSessionToCollections(sessionId: string): () => void {
  // Prevent duplicate subscriptions
  if (activeSyncs.has(sessionId)) {
    return () => stopSessionSync(sessionId);
  }

  const subscription = subscribeToSession(sessionId, {
    onChunk: (event) => {
      const chunk: ChunkEvent = {
        id: createId(),
        agentId: event.data.agentId,
        sessionId,
        text: event.data.text,
        timestamp: event.data.timestamp,
      };

      // Insert chunk into collection
      chunksCollection.insert(chunk);

      // Accumulate for derived messages
      const agentId = chunk.agentId ?? 'unknown';
      const turn = 0; // Default turn if not provided
      const key = `${sessionId}:${agentId}-${turn}`;

      const existing = messageAccumulators.get(key);
      if (existing) {
        existing.text += chunk.text;
        existing.lastTimestamp = chunk.timestamp;
      } else {
        messageAccumulators.set(key, {
          text: chunk.text,
          lastTimestamp: chunk.timestamp,
        });
      }

      // Update derived message
      updateDerivedMessage(sessionId, agentId, turn);
    },

    onToolCall: (event) => {
      const toolCall: ToolCallEvent = {
        id: event.data.id,
        agentId: undefined, // Will be set if available in event
        sessionId,
        tool: event.data.tool,
        input: event.data.input,
        output: event.data.output,
        status: event.data.status,
        timestamp: event.data.timestamp,
      };

      // Upsert - update if exists, insert if new
      if (toolCallsCollection.has(toolCall.id)) {
        toolCallsCollection.update(toolCall.id, (draft) => {
          Object.assign(draft, toolCall);
        });
      } else {
        toolCallsCollection.insert(toolCall);
      }
    },

    onPresence: (event) => {
      const presence: PresenceEvent = {
        userId: event.data.userId,
        sessionId,
        cursor: event.data.cursor,
        lastSeen: event.data.lastSeen,
      };

      const key = `${sessionId}:${presence.userId}` as `${string}:${string}`;

      // Upsert presence
      if (presenceCollection.has(key)) {
        presenceCollection.update(key, (draft) => {
          Object.assign(draft, presence);
        });
      } else {
        presenceCollection.insert(presence);
      }
    },

    onTerminal: (event) => {
      const terminal: TerminalEvent = {
        id: createId(),
        sessionId,
        type: event.data.type,
        data: event.data.data,
        timestamp: event.data.timestamp,
      };

      terminalCollection.insert(terminal);
    },

    onAgentState: (event) => {
      if (!event.data) return;

      const state = event.data as unknown as {
        agentId?: string;
        status?: string;
        turn?: number;
        progress?: number;
        message?: string;
        error?: string;
      };

      const agentId = state.agentId ?? 'default';
      const agentState: AgentStateEvent = {
        agentId,
        sessionId,
        status: (state.status as AgentStateEvent['status']) ?? 'idle',
        turn: state.turn,
        progress: state.progress,
        message: state.message,
        error: state.error,
        timestamp: Date.now(),
      };

      const key = `${sessionId}:${agentId}` as `${string}:${string}`;

      // Upsert agent state
      if (agentStateCollection.has(key)) {
        agentStateCollection.update(key, (draft) => {
          Object.assign(draft, agentState);
        });
      } else {
        agentStateCollection.insert(agentState);
      }
    },

    onError: (_error) => {
      // Stream errors are handled by automatic reconnection logic
    },

    onReconnect: () => {
      // Reconnection is automatic — no action needed
    },

    onDisconnect: () => {
      // Disconnection is handled by reconnection logic
    },
  });

  activeSyncs.set(sessionId, subscription);

  return () => stopSessionSync(sessionId);
}

/**
 * Stop syncing a session
 */
export function stopSessionSync(sessionId: string): void {
  const subscription = activeSyncs.get(sessionId);
  if (subscription) {
    subscription.unsubscribe();
    activeSyncs.delete(sessionId);
  }

  // Clear accumulators for this session (keys are formatted as `${sessionId}:${agentId}-${turn}`)
  for (const key of messageAccumulators.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      messageAccumulators.delete(key);
    }
  }
}

/**
 * Check if a session is currently being synced
 */
export function isSessionSyncing(sessionId: string): boolean {
  return activeSyncs.has(sessionId);
}

/**
 * Get count of active syncs
 */
export function getActiveSyncCount(): number {
  return activeSyncs.size;
}

/**
 * Stop all active syncs
 */
export function stopAllSyncs(): void {
  for (const sessionId of activeSyncs.keys()) {
    stopSessionSync(sessionId);
  }
}

/**
 * Update derived message from accumulated chunks
 */
function updateDerivedMessage(sessionId: string, agentId: string, turn: number): void {
  const key = `${sessionId}:${agentId}-${turn}`;
  const accumulated = messageAccumulators.get(key);

  if (!accumulated) return;

  const messageId = `${sessionId}-${agentId}-${turn}`;
  const message: Message = {
    id: messageId,
    agentId,
    sessionId,
    text: accumulated.text,
    turn,
    timestamp: accumulated.lastTimestamp,
  };

  // Upsert derived message
  if (messagesCollection.has(messageId)) {
    messagesCollection.update(messageId, (draft) => {
      draft.text = message.text;
      draft.timestamp = message.timestamp;
    });
  } else {
    messagesCollection.insert(message);
  }
}

/**
 * Manually insert a workflow event
 * Used for local workflow events that don't come from the stream
 */
export function insertWorkflowEvent(event: WorkflowEvent): void {
  workflowCollection.insert(event);
}
