/**
 * Sandbox Status Sync
 *
 * Polls the API to fetch sandbox status and updates the TanStack DB collection.
 */

import { createApiFetch } from '@/lib/api/client';
import { type SandboxStatus, updateSandboxStatus } from './collections.js';

// Active sync intervals per codespace
const activeSyncs = new Map<string, NodeJS.Timeout>();

// Track inflight polls to prevent overlap
const inflightPolls = new Set<string>();

// Use the project's apiFetch (relative URLs go through Vite proxy in the browser)
const apiFetch = createApiFetch();

/**
 * Fetch sandbox status from the API
 */
async function fetchSandboxStatus(codespaceId: string): Promise<SandboxStatus | null> {
  const result = await apiFetch<{
    mode: string;
    containerStatus: string;
    containerId: string | null;
    providerAvailable: boolean;
    provider?: string;
    k8sCrdReady: boolean;
    k8sClusterVersion?: string | null;
    k8sPodCount: number;
    k8sPodsRunning: number;
    nomadHealthy: boolean;
    nomadVersion?: string | null;
    nomadLeader?: string | null;
    nomadJobCount: number;
  }>(`/api/sandbox/status/${encodeURIComponent(codespaceId)}`);

  if (!result.ok) {
    return null;
  }

  return {
    codespaceId,
    mode: result.data.mode as SandboxStatus['mode'],
    containerStatus: result.data.containerStatus as SandboxStatus['containerStatus'],
    containerId: result.data.containerId,
    providerAvailable: result.data.providerAvailable,
    provider: (result.data.provider ?? 'none') as SandboxStatus['provider'],
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

/**
 * Start syncing sandbox status for a codespace
 *
 * @param codespaceId Codespace ID to sync
 * @param intervalMs Polling interval in milliseconds (default: 10000)
 */
export function startSandboxStatusSync(codespaceId: string, intervalMs = 30000): void {
  // Don't start if already syncing
  if (activeSyncs.has(codespaceId)) {
    return;
  }

  // Fetch immediately
  fetchSandboxStatus(codespaceId).then((status) => {
    if (status) {
      updateSandboxStatus(status);
    }
  });

  // Set up polling interval with overlap guard
  const interval = setInterval(async () => {
    if (inflightPolls.has(codespaceId)) {
      return;
    }
    inflightPolls.add(codespaceId);
    try {
      const status = await fetchSandboxStatus(codespaceId);
      if (status) {
        updateSandboxStatus(status);
      }
    } finally {
      inflightPolls.delete(codespaceId);
    }
  }, intervalMs);

  activeSyncs.set(codespaceId, interval);
}

/**
 * Stop syncing sandbox status for a project
 */
export function stopSandboxStatusSync(codespaceId: string): void {
  const interval = activeSyncs.get(codespaceId);
  if (interval) {
    clearInterval(interval);
    activeSyncs.delete(codespaceId);
  }
}

/**
 * Force refresh sandbox status for a project
 */
export async function refreshSandboxStatus(codespaceId: string): Promise<void> {
  const status = await fetchSandboxStatus(codespaceId);
  if (status) {
    updateSandboxStatus(status);
  }
}
