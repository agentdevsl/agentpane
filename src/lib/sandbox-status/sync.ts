/**
 * Sandbox Status Sync
 *
 * Polls the API to fetch sandbox status and updates the TanStack DB collection.
 */

import { type SandboxStatus, updateSandboxStatus } from './collections.js';

// Active sync intervals per project
const activeSyncs = new Map<string, NodeJS.Timeout>();

// API base URL
const API_BASE = import.meta.env?.DEV ? 'http://localhost:3001' : '';

/**
 * Fetch sandbox status from the API
 */
async function fetchSandboxStatus(projectId: string): Promise<SandboxStatus | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sandbox/status/${projectId}`);
    const result = await response.json();

    if (result.ok) {
      return {
        projectId,
        mode: result.data.mode,
        containerStatus: result.data.containerStatus,
        containerId: result.data.containerId,
        providerAvailable: result.data.providerAvailable,
        provider: result.data.provider ?? 'none',
        k8sCrdReady: result.data.k8sCrdReady,
        k8sClusterVersion: result.data.k8sClusterVersion ?? null,
        k8sPodCount: result.data.k8sPodCount,
        k8sPodsRunning: result.data.k8sPodsRunning,
        nomadHealthy: result.data.nomadHealthy,
        nomadVersion: result.data.nomadVersion ?? null,
        nomadLeader: result.data.nomadLeader ?? null,
        nomadJobCount: result.data.nomadJobCount,
        updatedAt: Date.now(),
      };
    }

    console.error('[SandboxStatusSync] API error:', result.error);
    return null;
  } catch (error) {
    console.error('[SandboxStatusSync] Fetch error:', error);
    return null;
  }
}

/**
 * Start syncing sandbox status for a project
 *
 * @param projectId Project ID to sync
 * @param intervalMs Polling interval in milliseconds (default: 10000)
 */
export function startSandboxStatusSync(projectId: string, intervalMs = 10000): void {
  // Don't start if already syncing
  if (activeSyncs.has(projectId)) {
    return;
  }

  console.log('[SandboxStatusSync] Starting sync for project:', projectId);

  // Fetch immediately
  fetchSandboxStatus(projectId).then((status) => {
    if (status) {
      updateSandboxStatus(status);
    }
  });

  // Set up polling interval
  const interval = setInterval(async () => {
    const status = await fetchSandboxStatus(projectId);
    if (status) {
      updateSandboxStatus(status);
    }
  }, intervalMs);

  activeSyncs.set(projectId, interval);
}

/**
 * Stop syncing sandbox status for a project
 */
export function stopSandboxStatusSync(projectId: string): void {
  const interval = activeSyncs.get(projectId);
  if (interval) {
    console.log('[SandboxStatusSync] Stopping sync for project:', projectId);
    clearInterval(interval);
    activeSyncs.delete(projectId);
  }
}

/**
 * Force refresh sandbox status for a project
 */
export async function refreshSandboxStatus(projectId: string): Promise<void> {
  const status = await fetchSandboxStatus(projectId);
  if (status) {
    updateSandboxStatus(status);
  }
}
