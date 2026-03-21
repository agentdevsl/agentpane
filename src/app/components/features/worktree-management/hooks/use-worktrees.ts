import { useCallback, useMemo, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { AUTO_REFRESH_INTERVAL_MS } from '../constants';
import type { GitDiff, WorktreeListItem } from '../types';
import { groupWorktrees, transformWorktree } from '../utils/format-worktree';

interface UseWorktreesReturn {
  worktrees: WorktreeListItem[];
  activeWorktrees: WorktreeListItem[];
  staleWorktrees: WorktreeListItem[];
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching and managing worktrees for a project
 */
export function useWorktrees(codespaceId: string): UseWorktreesReturn {
  const [worktrees, setWorktrees] = useState<WorktreeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);

  const fetchWorktrees = useCallback(
    async (isAutoRefresh = false) => {
      if (!codespaceId) {
        setWorktrees([]);
        setIsLoading(false);
        return;
      }

      // Only show loading state for initial/manual fetches, not auto-refresh
      if (!isAutoRefresh) {
        setIsLoading(true);
      }

      try {
        const result = await apiClient.worktrees.list({ codespaceId });

        if (result.ok) {
          const items = result.data.items.map(transformWorktree);
          setWorktrees(items);
          // Only clear error on successful fetch
          setError(null);
        } else {
          setError({ message: result.error.message });
        }
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : 'Failed to fetch worktrees' });
      } finally {
        if (!isAutoRefresh) {
          setIsLoading(false);
        }
      }
    },
    [codespaceId]
  );

  // Initial fetch
  useWatchEffect(() => {
    void fetchWorktrees();
  }, [fetchWorktrees]);

  // Auto-refresh (silent, doesn't clear error or show loading)
  useWatchEffect(() => {
    const interval = setInterval(() => {
      void fetchWorktrees(true);
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchWorktrees]);

  const { active, stale } = useMemo(() => groupWorktrees(worktrees), [worktrees]);

  return {
    worktrees,
    activeWorktrees: active,
    staleWorktrees: stale,
    isLoading,
    error,
    refetch: fetchWorktrees,
  };
}

interface UseWorktreeDiffReturn {
  diff: GitDiff | null;
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching diff for a specific worktree
 */
export function useWorktreeDiff(worktreeId: string | null): UseWorktreeDiffReturn {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!worktreeId) {
      setDiff(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await apiClient.worktrees.getDiff(worktreeId);

      if (result.ok) {
        setDiff(result.data);
      } else {
        setError({ message: result.error.message });
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Failed to fetch diff' });
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId]);

  useWatchEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

  return {
    diff,
    isLoading,
    error,
    refetch: fetchDiff,
  };
}
