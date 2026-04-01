/**
 * TanStack DB Collections for Session Data
 *
 * Local-only collections that sync from durable streams.
 * These collections provide reactive data access with live queries.
 *
 * @module lib/sessions/collections
 */

import { createCollection, localOnlyCollectionOptions } from '@tanstack/db';
import {
  agentStateSchema,
  chunkSchema,
  messageSchema,
  presenceSchema,
  terminalSchema,
  toolCallSchema,
  workflowSchema,
} from './schema.js';

/**
 * Chunks collection - raw streaming text data
 *
 * Primary key: id
 * Used for real-time streaming text from agents
 */
export const chunksCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-chunks',
    schema: chunkSchema,
    getKey: (chunk) => chunk.id,
  })
);

/**
 * Tool calls collection - agent tool invocations
 *
 * Primary key: id
 * Tracks tool execution status and results
 */
export const toolCallsCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-tool-calls',
    schema: toolCallSchema,
    getKey: (tool) => tool.id,
  })
);

/**
 * Presence collection - active users in session
 *
 * Primary key: `${sessionId}:${userId}`
 * Tracks who is viewing each session with cursor positions
 */
export const presenceCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-presence',
    schema: presenceSchema,
    getKey: (presence) => `${presence.sessionId}:${presence.userId}`,
  })
);

/**
 * Terminal collection - terminal I/O events
 *
 * Primary key: id
 * Tracks terminal input/output for interactive sessions
 */
export const terminalCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-terminal',
    schema: terminalSchema,
    getKey: (terminal) => terminal.id,
  })
);

/**
 * Workflow collection - approval workflow events
 *
 * Primary key: id
 * Tracks approval requests, approvals, rejections, and worktree events
 */
export const workflowCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-workflow',
    schema: workflowSchema,
    getKey: (workflow) => workflow.id,
  })
);

/**
 * Agent state collection - agent lifecycle state
 *
 * Primary key: `${sessionId}:${agentId}`
 * Tracks current agent status, turn, progress, etc.
 * Uses composite key to support multiple agents per session
 */
export const agentStateCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'agent-state',
    schema: agentStateSchema,
    getKey: (state) => `${state.sessionId}:${state.agentId}`,
  })
);

/**
 * Messages collection - derived from chunks
 *
 * Primary key: id
 * Aggregated messages derived from streaming chunks
 */
export const messagesCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'session-messages',
    schema: messageSchema,
    getKey: (message) => message.id,
  })
);

/**
 * Collection registry for easy iteration
 */
export const sessionCollections = {
  chunks: chunksCollection,
  toolCalls: toolCallsCollection,
  presence: presenceCollection,
  terminal: terminalCollection,
  workflow: workflowCollection,
  agentState: agentStateCollection,
  messages: messagesCollection,
} as const;

/**
 * Clear all data from all session collections
 * Useful for cleanup when leaving a session
 */
export function clearSessionCollections(): void {
  // TODO: implement collection clearing — currently a no-op placeholder
}

/**
 * Get collection statistics for debugging
 */
export function getCollectionStats(): Record<string, { size: number; ready: boolean }> {
  return {
    chunks: { size: chunksCollection.size, ready: chunksCollection.isReady() },
    toolCalls: { size: toolCallsCollection.size, ready: toolCallsCollection.isReady() },
    presence: { size: presenceCollection.size, ready: presenceCollection.isReady() },
    terminal: { size: terminalCollection.size, ready: terminalCollection.isReady() },
    workflow: { size: workflowCollection.size, ready: workflowCollection.isReady() },
    agentState: { size: agentStateCollection.size, ready: agentStateCollection.isReady() },
    messages: { size: messagesCollection.size, ready: messagesCollection.isReady() },
  };
}
