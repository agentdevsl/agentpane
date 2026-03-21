import { getCollectionStats, sessionCollections } from '../../sessions/index.js';
import {
  getTaskCreationCollectionStats,
  taskCreationCollections,
} from '../../task-creation/index.js';
import { ok } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

/**
 * Initialize collections for client mode.
 *
 * Sets up TanStack DB collections for session data including:
 * - chunks: Streaming text from agents
 * - toolCalls: Agent tool invocations
 * - presence: Active users in sessions
 * - terminal: Terminal I/O events
 * - workflow: Approval workflow events
 * - agentState: Agent lifecycle state
 * - messages: Derived messages from chunks
 *
 * Also sets up task creation collections:
 * - sessions: Task creation session state
 * - messages: Task creation conversation messages
 */
export const initializeCollections = async (_ctx: BootstrapContext) => {
  // Collections are created lazily on first use via localOnlyCollectionOptions
  // Preload them to ensure they're ready
  await Promise.all([
    // Session collections
    sessionCollections.chunks.preload(),
    sessionCollections.toolCalls.preload(),
    sessionCollections.presence.preload(),
    sessionCollections.terminal.preload(),
    sessionCollections.workflow.preload(),
    sessionCollections.agentState.preload(),
    sessionCollections.messages.preload(),
    // Task creation collections
    taskCreationCollections.sessions.preload(),
    taskCreationCollections.messages.preload(),
  ]);

  const stats = getCollectionStats();
  getTaskCreationCollectionStats();

  return ok({
    collections: sessionCollections,
    taskCreationCollections,
    stats,
  });
};
