import {
  ArrowClockwise,
  CaretDown,
  GitBranch,
  GitCommit,
  GitFork,
  GitPullRequest,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Skeleton } from '@/app/components/ui/skeleton';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { CommitDialog } from './dialogs/commit-dialog';
import { MergeDialog } from './dialogs/merge-dialog';
import { RemoveDialog } from './dialogs/remove-dialog';
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts';
import { useWorktreeActions } from './hooks/use-worktree-actions';
import { useWorktreeDiff, useWorktrees } from './hooks/use-worktrees';
import type { MergeOptions, WorktreeListItem, WorktreeManagementProps } from './types';

// ============================================
// TYPES
// ============================================

interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}

interface BranchInfo {
  name: string;
  commitHash: string;
  commitCount: number;
  isDefault?: boolean;
  status?: 'UNMERGED' | 'LOCAL' | 'MERGED';
}

// ============================================
// COLUMN HEADER COMPONENT
// ============================================

function ColumnHeader({
  icon: Icon,
  title,
  count,
  subtitle,
  action,
}: {
  icon: React.ElementType;
  title: string;
  count?: number;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-4 py-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-fg-muted" weight="bold" />
        <span className="text-sm font-medium text-fg">{title}</span>
        {subtitle && (
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">
            {subtitle}
          </span>
        )}
        {count !== undefined && (
          <span className="ml-1.5 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
            {count}
          </span>
        )}
        <CaretDown className="h-3 w-3 text-fg-subtle" />
      </div>
      {action}
    </div>
  );
}

// ============================================
// WORKTREE ITEM COMPONENT
// ============================================

function WorktreeItem({
  worktree,
  isSelected,
  onSelect,
  onContextMenu,
}: {
  worktree: WorktreeListItem;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  // Extract workspace name from path or generate from branch
  const workspaceName = worktree.agentName
    ? `${worktree.agentName}: ${worktree.branch}`
    : worktree.branch;

  // Short path display
  const shortPath = worktree.path.replace(/^.*\/([^/]+\/[^/]+)$/, '~/$1');

  // Status badge styling
  const getStatusStyle = () => {
    if (worktree.hasUncommittedChanges) return 'text-warning';
    return 'text-fg-muted';
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border/50 transition-colors',
        'hover:bg-surface-muted focus:outline-none focus:bg-surface-muted',
        isSelected && 'bg-accent/10 border-l-2 border-l-accent'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-fg truncate">{workspaceName}</div>
          <div className="mt-0.5 text-xs text-fg-muted truncate font-mono">{shortPath}</div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                'bg-surface-muted',
                getStatusStyle()
              )}
            >
              {worktree.hasUncommittedChanges ? 'dirty' : 'clean'}
            </span>
          </div>
        </div>
        {isSelected && <div className="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5" />}
      </div>
    </button>
  );
}

// ============================================
// COMMIT ITEM COMPONENT
// ============================================

function CommitItem({ commit }: { commit: CommitInfo }) {
  return (
    <div className="px-4 py-3 border-b border-border/50 hover:bg-surface-muted transition-colors">
      <div className="font-medium text-sm text-fg line-clamp-2">{commit.message}</div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
        <span className="font-mono text-accent">{commit.shortHash}</span>
        <span>{commit.author}</span>
        <span>{commit.date}</span>
      </div>
      {(commit.additions !== undefined || commit.deletions !== undefined) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          {commit.additions !== undefined && (
            <span className="text-success">+{commit.additions}</span>
          )}
          {commit.deletions !== undefined && (
            <span className="text-danger">-{commit.deletions}</span>
          )}
          {commit.filesChanged !== undefined && (
            <span className="text-fg-muted">{commit.filesChanged} files</span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// BRANCH ITEM COMPONENT
// ============================================

function BranchItem({
  branch,
  isDefault,
  onSelect,
}: {
  branch: BranchInfo;
  isDefault?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border/50 transition-colors',
        'hover:bg-surface-muted focus:outline-none focus:bg-surface-muted',
        isDefault && 'bg-accent/5'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isDefault && <span className="text-xs text-accent">→</span>}
            <span
              className={cn('font-medium text-sm truncate', isDefault ? 'text-accent' : 'text-fg')}
            >
              {branch.name}
            </span>
            {branch.status && (
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                  branch.status === 'UNMERGED' && 'bg-warning/15 text-warning',
                  branch.status === 'LOCAL' && 'bg-accent/15 text-accent',
                  branch.status === 'MERGED' && 'bg-success/15 text-success'
                )}
              >
                {branch.status}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
            <span className="font-mono">{branch.commitHash}</span>
            <span>{branch.commitCount} commits</span>
          </div>
        </div>
        {isDefault && <div className="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5" />}
      </div>
    </button>
  );
}

// ============================================
// CONTEXT MENU COMPONENT
// ============================================

function ContextMenu({
  x,
  y,
  onClose,
  actions,
}: {
  x: number;
  y: number;
  onClose: () => void;
  actions: { label: string; onClick: () => void; danger?: boolean }[];
}) {
  useWatchEffect(() => {
    const handleClick = () => onClose();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-surface shadow-xl animate-scale-in"
      style={{ left: x, top: y }}
    >
      <div className="py-1">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
              onClose();
            }}
            className={cn(
              'w-full text-left px-4 py-2 text-sm transition-colors',
              'hover:bg-surface-muted focus:outline-none focus:bg-surface-muted',
              action.danger ? 'text-danger' : 'text-fg'
            )}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export function WorktreeManagement({
  codespaceId,
  onWorktreeSelect,
  panelMode = false,
}: WorktreeManagementProps): React.JSX.Element {
  const { worktrees, activeWorktrees, staleWorktrees, isLoading, error, refetch } =
    useWorktrees(codespaceId);

  const {
    isLoading: isActionLoading,
    handleCommit,
    handleMerge,
    handleRemove,
    handleOpen,
  } = useWorktreeActions(refetch);

  // Selected worktree state
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeListItem | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    worktree: WorktreeListItem;
  } | null>(null);

  // Dialog states
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [dialogWorktree, setDialogWorktree] = useState<WorktreeListItem | null>(null);

  // Mock data for branches and commits (would come from API in production)
  const [commits] = useState<CommitInfo[]>([]);
  const [localBranches] = useState<BranchInfo[]>([]);

  // Fetch diff when dialog worktree is set
  const {
    diff,
    error: diffError,
    isLoading: isDiffLoading,
  } = useWorktreeDiff(mergeDialogOpen || commitDialogOpen ? (dialogWorktree?.id ?? null) : null);

  // All worktrees for display (combine active and stale)
  const allWorktrees = useMemo(
    () => [...activeWorktrees, ...staleWorktrees],
    [activeWorktrees, staleWorktrees]
  );

  // Keyboard shortcuts
  useKeyboardShortcuts({
    worktrees: activeWorktrees,
    selectedId: selectedWorktree?.id,
    onSelect: (wt) => {
      setSelectedWorktree(wt);
      onWorktreeSelect?.(wt);
    },
    onOpen: handleOpen,
    onMerge: (wt) => {
      setDialogWorktree(wt);
      setMergeDialogOpen(true);
    },
    onRemove: (wt) => {
      setDialogWorktree(wt);
      setRemoveDialogOpen(true);
    },
    enabled: !panelMode,
  });

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, worktree: WorktreeListItem) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, worktree });
  }, []);

  // Action handlers that open dialogs
  const openMergeDialog = (wt: WorktreeListItem) => {
    setDialogWorktree(wt);
    setMergeDialogOpen(true);
  };

  const openCommitDialog = (wt: WorktreeListItem) => {
    setDialogWorktree(wt);
    setCommitDialogOpen(true);
  };

  const openRemoveDialog = (wt: WorktreeListItem) => {
    setDialogWorktree(wt);
    setRemoveDialogOpen(true);
  };

  // Dialog action handlers
  const onMergeConfirm = async (options: MergeOptions) => {
    if (dialogWorktree) {
      const success = await handleMerge(dialogWorktree.id, options);
      if (success) {
        setMergeDialogOpen(false);
        setDialogWorktree(null);
      }
    }
  };

  const onCommitConfirm = async (message: string) => {
    if (dialogWorktree) {
      const success = await handleCommit(dialogWorktree.id, message);
      if (success) {
        setCommitDialogOpen(false);
        setDialogWorktree(null);
      }
    }
  };

  const onRemoveConfirm = async (force: boolean) => {
    if (dialogWorktree) {
      const success = await handleRemove(dialogWorktree.id, force);
      if (success) {
        setRemoveDialogOpen(false);
        setDialogWorktree(null);
      }
    }
  };

  // Loading state
  if (isLoading && worktrees.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-4 py-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-x divide-border min-h-[400px]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col">
              <div className="border-b border-border bg-surface-subtle px-4 py-3">
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="flex-1 p-4 space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-6">
        <div className="flex items-start gap-3">
          <GitBranch className="h-5 w-5 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-danger">Failed to load worktrees</p>
            <p className="mt-1 text-sm text-fg-muted">{error.message}</p>
            <Button size="sm" variant="outline" onClick={refetch} className="mt-3">
              <ArrowClockwise className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Panel mode - simplified compact layout
  if (panelMode) {
    return (
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <ColumnHeader
          icon={GitFork}
          title="Worktrees"
          count={allWorktrees.length}
          action={
            <Button size="sm" variant="ghost" onClick={refetch} className="h-7 w-7 p-0">
              <ArrowClockwise className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </Button>
          }
        />
        <div className="max-h-[400px] overflow-y-auto">
          {allWorktrees.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">No worktrees yet</div>
          ) : (
            allWorktrees.map((wt) => (
              <WorktreeItem
                key={wt.id}
                worktree={wt}
                isSelected={selectedWorktree?.id === wt.id}
                onSelect={() => {
                  setSelectedWorktree(wt);
                  onWorktreeSelect?.(wt);
                }}
                onContextMenu={(e) => handleContextMenu(e, wt)}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  // Full multi-column layout
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {/* Top toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded border border-border bg-surface-subtle px-3 py-1.5 text-sm font-mono text-fg-muted">
            {codespaceId.slice(0, 12)}...
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refetch}>
            <ArrowClockwise className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Multi-column grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-x divide-border">
        {/* Pull Requests Column (placeholder) */}
        <div className="flex flex-col min-h-[500px]">
          <ColumnHeader icon={GitPullRequest} title="Pull Requests" count={0} />
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 py-8 text-center text-sm text-fg-muted">No PRs match filter</div>
          </div>
        </div>

        {/* Worktrees Column */}
        <div className="flex flex-col min-h-[500px]">
          <ColumnHeader icon={GitFork} title="Worktrees" count={allWorktrees.length} />
          <div className="flex-1 overflow-y-auto">
            {allWorktrees.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">No worktrees yet</div>
            ) : (
              allWorktrees.map((wt) => (
                <WorktreeItem
                  key={wt.id}
                  worktree={wt}
                  isSelected={selectedWorktree?.id === wt.id}
                  onSelect={() => {
                    setSelectedWorktree(wt);
                    onWorktreeSelect?.(wt);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, wt)}
                />
              ))
            )}
          </div>
        </div>

        {/* Commits Column */}
        <div className="flex flex-col min-h-[500px]">
          <ColumnHeader
            icon={GitCommit}
            title="Commits"
            subtitle={selectedWorktree?.branch ?? 'MASTER'}
            count={commits.length || 0}
          />
          <div className="flex-1 overflow-y-auto">
            {commits.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">
                {selectedWorktree ? 'Loading commits...' : 'Select a worktree'}
              </div>
            ) : (
              commits.map((commit) => <CommitItem key={commit.hash} commit={commit} />)
            )}
          </div>
        </div>

        {/* Local Branches Column */}
        <div className="flex flex-col min-h-[500px]">
          <ColumnHeader
            icon={GitBranch}
            title="Local Branches"
            count={localBranches.length || allWorktrees.length}
          />
          <div className="flex-1 overflow-y-auto">
            {/* Show worktree branches as local branches */}
            {allWorktrees.map((wt) => (
              <BranchItem
                key={wt.id}
                branch={{
                  name: wt.branch,
                  commitHash: wt.id.slice(0, 7),
                  commitCount: 1,
                  status: wt.hasUncommittedChanges ? 'LOCAL' : undefined,
                }}
                isDefault={wt.branch === 'main' || wt.branch === 'master'}
                onSelect={() => {
                  setSelectedWorktree(wt);
                  onWorktreeSelect?.(wt);
                }}
              />
            ))}
            {allWorktrees.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">No local branches</div>
            )}
          </div>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={[
            {
              label: 'Check Out Worktree',
              onClick: () => handleOpen(contextMenu.worktree),
            },
            {
              label: 'Open in Finder',
              onClick: () => {
                // Open folder in finder
                window.open(`file://${contextMenu.worktree.path}`, '_blank');
              },
            },
            ...(contextMenu.worktree.hasUncommittedChanges
              ? [
                  {
                    label: 'Commit Changes',
                    onClick: () => openCommitDialog(contextMenu.worktree),
                  },
                ]
              : []),
            {
              label: 'Merge to Base',
              onClick: () => openMergeDialog(contextMenu.worktree),
            },
            {
              label: 'Remove Worktree',
              onClick: () => openRemoveDialog(contextMenu.worktree),
              danger: true,
            },
          ]}
        />
      )}

      {/* Dialogs */}
      {dialogWorktree && (
        <>
          <MergeDialog
            worktree={dialogWorktree}
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            onMerge={onMergeConfirm}
            isLoading={isActionLoading}
            diff={diff}
            diffError={diffError}
            isDiffLoading={isDiffLoading}
          />
          <CommitDialog
            worktree={dialogWorktree}
            open={commitDialogOpen}
            onOpenChange={setCommitDialogOpen}
            onCommit={onCommitConfirm}
            isLoading={isActionLoading}
            diff={diff}
            diffError={diffError}
            isDiffLoading={isDiffLoading}
          />
          <RemoveDialog
            worktree={dialogWorktree}
            open={removeDialogOpen}
            onOpenChange={setRemoveDialogOpen}
            onRemove={onRemoveConfirm}
            isLoading={isActionLoading}
          />
        </>
      )}
    </div>
  );
}
