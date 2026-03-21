import { eq } from '@tanstack/db';
import { useCollectionQuery } from '@/lib/db/use-collection-query';
import {
  refreshSandboxStatus,
  type SandboxStatus,
  sandboxStatusCollection,
  startSandboxStatusSync,
  stopSandboxStatusSync,
} from '@/lib/sandbox-status';
import { useWatchEffect } from './use-watch-effect';

export type { SandboxStatus };

/**
 * Hook to get sandbox mode and container status for a codespace
 *
 * Uses TanStack DB collection with automatic sync from API.
 */
export function useSandboxStatus(codespaceId: string): {
  data: SandboxStatus | null;
  isLoading: boolean;
  refetch: () => void;
} {
  // Subscribe to collection changes using TanStack DB live query
  const { data } = useCollectionQuery<SandboxStatus>(
    (q) =>
      q
        .from({ sandboxStatus: sandboxStatusCollection })
        .where(({ sandboxStatus }: { sandboxStatus: SandboxStatus }) =>
          eq(sandboxStatus.codespaceId, codespaceId)
        ),
    [codespaceId]
  );

  // Start/stop sync when codespaceId changes
  useWatchEffect(() => {
    if (!codespaceId) return;

    startSandboxStatusSync(codespaceId);

    return () => {
      stopSandboxStatusSync(codespaceId);
    };
  }, [codespaceId]);

  return {
    data: data?.[0] ?? null,
    isLoading: !sandboxStatusCollection.isReady(),
    refetch: () => refreshSandboxStatus(codespaceId),
  };
}
