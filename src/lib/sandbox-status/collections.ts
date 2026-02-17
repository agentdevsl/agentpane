/**
 * TanStack DB Collection for Sandbox Status
 *
 * Local-only collection that tracks sandbox mode and container status per project.
 * Synced via polling from the API.
 */

import { createCollection, localOnlyCollectionOptions } from '@tanstack/db';
import { type SandboxStatus, sandboxStatusSchema } from './schema.js';

// Re-export the type for convenience
export type { SandboxStatus };

/**
 * Sandbox status collection
 *
 * Primary key: projectId
 * Tracks sandbox mode and container status for each project
 */
export const sandboxStatusCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'sandbox-status',
    schema: sandboxStatusSchema,
    getKey: (status) => status.projectId,
  })
);

/**
 * Update sandbox status for a project (upsert pattern)
 */
export function updateSandboxStatus(status: SandboxStatus): void {
  if (sandboxStatusCollection.has(status.projectId)) {
    sandboxStatusCollection.update(status.projectId, (draft) => {
      draft.mode = status.mode;
      draft.containerStatus = status.containerStatus;
      draft.containerId = status.containerId;
      draft.dockerAvailable = status.dockerAvailable;
      draft.provider = status.provider;
      draft.updatedAt = status.updatedAt;
    });
  } else {
    sandboxStatusCollection.insert(status);
  }
}

/**
 * Get sandbox status for a project
 */
export function getSandboxStatus(projectId: string): SandboxStatus | undefined {
  return sandboxStatusCollection.get(projectId);
}

/**
 * Clear sandbox status for a project
 */
export function clearSandboxStatus(projectId: string): void {
  sandboxStatusCollection.delete(projectId);
}

/**
 * Get collection statistics for debugging
 */
export function getSandboxStatusCollectionStats(): { size: number; ready: boolean } {
  return {
    size: sandboxStatusCollection.size,
    ready: sandboxStatusCollection.isReady(),
  };
}
