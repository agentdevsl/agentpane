import {
  getTaskCreationCollectionStats,
  taskCreationCollections,
} from '../../task-creation/index.js';
import { ok } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

/**
 * Initialize collections for client mode.
 *
 * Sets up TanStack DB collections for task creation:
 * - sessions: Task creation session state
 * - messages: Task creation conversation messages
 */
export const initializeCollections = async (_ctx: BootstrapContext) => {
  // Collections are created lazily on first use via localOnlyCollectionOptions
  // Preload them to ensure they're ready
  await Promise.all([
    // Task creation collections
    taskCreationCollections.sessions.preload(),
    taskCreationCollections.messages.preload(),
  ]);

  const stats = getTaskCreationCollectionStats();

  return ok({
    taskCreationCollections,
    stats,
  });
};
