import { useCallback, useState } from 'react';
import { toast } from '@/app/components/ui/toast';
import { apiClient } from '@/lib/api/client';
import type { MergeOptions, WorktreeListItem } from '../types';

type ActionType = 'commit' | 'merge' | 'remove' | 'prune' | null;

interface UseWorktreeActionsReturn {
  isLoading: boolean;
  currentAction: ActionType;
  handleCommit: (worktreeId: string, message: string) => Promise<boolean>;
  handleMerge: (worktreeId: string, options: MergeOptions) => Promise<boolean>;
  handleRemove: (worktreeId: string, force?: boolean) => Promise<boolean>;
  handlePrune: (codespaceId: string) => Promise<{ pruned: number; failed: number }>;
  handleOpen: (worktree: WorktreeListItem) => void;
}

/**
 * Helper to extract error message from unknown error
 */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return `Unexpected error: ${typeof err}`;
}

/**
 * Hook for handling worktree actions with loading states and toast notifications
 */
export function useWorktreeActions(onSuccess?: () => void): UseWorktreeActionsReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [currentAction, setCurrentAction] = useState<ActionType>(null);

  const handleCommit = useCallback(
    async (worktreeId: string, message: string): Promise<boolean> => {
      setIsLoading(true);
      setCurrentAction('commit');

      try {
        const result = await apiClient.worktrees.commit(worktreeId, message);

        if (result.ok) {
          toast.success('Changes committed successfully');
          onSuccess?.();
          return true;
        } else {
          console.error('[WorktreeActions] Commit failed:', { worktreeId, error: result.error });
          toast.error(`Commit failed: ${result.error.message}`);
          return false;
        }
      } catch (err) {
        console.error('[WorktreeActions] Commit exception:', { worktreeId, error: err });
        toast.error(`Commit failed: ${getErrorMessage(err)}`);
        return false;
      } finally {
        setIsLoading(false);
        setCurrentAction(null);
      }
    },
    [onSuccess]
  );

  const handleMerge = useCallback(
    async (worktreeId: string, options: MergeOptions): Promise<boolean> => {
      setIsLoading(true);
      setCurrentAction('merge');

      try {
        const result = await apiClient.worktrees.merge(worktreeId, {
          targetBranch: options.targetBranch,
          deleteAfterMerge: options.deleteAfterMerge,
          squash: options.squash,
          commitMessage: options.commitMessage,
        });

        if (result.ok) {
          if (result.data.conflicts && result.data.conflicts.length > 0) {
            console.warn('[WorktreeActions] Merge conflicts:', {
              worktreeId,
              conflicts: result.data.conflicts,
            });
            toast.error(`Merge conflicts detected in ${result.data.conflicts.length} file(s)`);
            return false;
          }
          // Check for partial cleanup failure
          if (result.data.cleanupFailed) {
            console.warn('[WorktreeActions] Merge succeeded but cleanup failed:', {
              worktreeId,
              error: result.data.cleanupError,
            });
            toast.warning(
              `Merged to ${options.targetBranch}, but worktree cleanup failed: ${result.data.cleanupError}`
            );
          } else {
            toast.success(`Merged to ${options.targetBranch}`);
          }
          onSuccess?.();
          return true;
        } else {
          console.error('[WorktreeActions] Merge failed:', {
            worktreeId,
            options,
            error: result.error,
          });
          toast.error(`Merge failed: ${result.error.message}`);
          return false;
        }
      } catch (err) {
        console.error('[WorktreeActions] Merge exception:', { worktreeId, options, error: err });
        toast.error(`Merge failed: ${getErrorMessage(err)}`);
        return false;
      } finally {
        setIsLoading(false);
        setCurrentAction(null);
      }
    },
    [onSuccess]
  );

  const handleRemove = useCallback(
    async (worktreeId: string, force = false): Promise<boolean> => {
      setIsLoading(true);
      setCurrentAction('remove');

      try {
        const result = await apiClient.worktrees.remove(worktreeId, force);

        if (result.ok) {
          toast.success('Worktree removed');
          onSuccess?.();
          return true;
        } else {
          console.error('[WorktreeActions] Remove failed:', {
            worktreeId,
            force,
            error: result.error,
          });
          toast.error(`Remove failed: ${result.error.message}`);
          return false;
        }
      } catch (err) {
        console.error('[WorktreeActions] Remove exception:', { worktreeId, force, error: err });
        toast.error(`Remove failed: ${getErrorMessage(err)}`);
        return false;
      } finally {
        setIsLoading(false);
        setCurrentAction(null);
      }
    },
    [onSuccess]
  );

  const handlePrune = useCallback(
    async (codespaceId: string): Promise<{ pruned: number; failed: number }> => {
      setIsLoading(true);
      setCurrentAction('prune');

      try {
        const result = await apiClient.worktrees.prune(codespaceId);

        if (result.ok) {
          const { pruned, failed } = result.data;
          if (pruned > 0) {
            toast.success(`Pruned ${pruned} stale worktree${pruned !== 1 ? 's' : ''}`);
          }
          if (failed.length > 0) {
            // Log detailed failure info
            console.error('[WorktreeActions] Prune partial failure:', {
              codespaceId,
              pruned,
              failures: failed,
            });
            // Show user-friendly message with details
            const failedBranches = failed
              .slice(0, 3)
              .map((f) => f.branch)
              .join(', ');
            const moreCount = failed.length > 3 ? ` and ${failed.length - 3} more` : '';
            toast.error(`Failed to prune: ${failedBranches}${moreCount}`);
          }
          onSuccess?.();
          return { pruned, failed: failed.length };
        } else {
          console.error('[WorktreeActions] Prune failed:', { codespaceId, error: result.error });
          toast.error(`Prune failed: ${result.error.message}`);
          return { pruned: 0, failed: 0 };
        }
      } catch (err) {
        console.error('[WorktreeActions] Prune exception:', { codespaceId, error: err });
        toast.error(`Prune failed: ${getErrorMessage(err)}`);
        return { pruned: 0, failed: 0 };
      } finally {
        setIsLoading(false);
        setCurrentAction(null);
      }
    },
    [onSuccess]
  );

  const handleOpen = useCallback((worktree: WorktreeListItem) => {
    const vscodeUrl = `vscode://file/${encodeURIComponent(worktree.path)}`;

    // window.open returns null if blocked or fails
    const result = window.open(vscodeUrl, '_blank');

    if (result === null) {
      console.warn('[WorktreeActions] VS Code open may have failed:', {
        path: worktree.path,
        branch: worktree.branch,
      });
      toast.warning(
        'Could not open VS Code. Check that popups are allowed and VS Code is installed.'
      );
    } else {
      toast.info(`Opening ${worktree.branch} in VS Code`);
    }
  }, []);

  return {
    isLoading,
    currentAction,
    handleCommit,
    handleMerge,
    handleRemove,
    handlePrune,
    handleOpen,
  };
}
