import type { WorktreeStatus } from '@/db/schema';

// Re-export for convenience
export type { WorktreeStatus } from '@/db/schema';

// ===== Extended Display Status =====
// The spec defines additional UI states beyond the DB enum
export type WorktreeDisplayStatus =
  | WorktreeStatus // creating, active, merging, removing, removed, error
  | 'initializing' // Running setup scripts (subset of creating)
  | 'dirty' // Has uncommitted changes
  | 'committing' // Commit in progress
  | 'conflict'; // Has merge conflicts

// ===== Worktree List Item =====
export interface WorktreeListItem {
  id: string;
  branch: string;
  path: string;
  baseBranch: string;
  status: WorktreeStatus;
  /** Computed display status based on additional context */
  displayStatus: WorktreeDisplayStatus;
  taskId?: string;
  taskTitle?: string;
  agentId?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string | null;
  lastActivity?: string;
  hasUncommittedChanges: boolean;
  aheadBehind?: {
    ahead: number;
    behind: number;
  };
  /** Whether this worktree is stale (inactive >7 days) */
  isStale: boolean;
}

// ===== Merge Options =====
export interface MergeOptions {
  targetBranch: string;
  deleteAfterMerge: boolean;
  squash: boolean;
  commitMessage?: string;
}

// ===== Conflict File =====
export interface ConflictFile {
  path: string;
  status: 'conflicted' | 'resolved';
  resolution?: 'ours' | 'theirs' | 'manual';
}

// ===== Diff Types =====
export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface GitDiff {
  files: DiffFile[];
  stats: DiffStats;
}

// ===== Component Props =====
export interface WorktreeManagementProps {
  /** Codespace ID to show worktrees for */
  codespaceId: string;
  /** Callback when worktree is selected */
  onWorktreeSelect?: (worktree: WorktreeListItem) => void;
  /** Whether to show in panel mode (sidebar) */
  panelMode?: boolean;
}

export interface WorktreeListItemProps {
  worktree: WorktreeListItem;
  onSelect?: () => void;
  onOpen?: () => void;
  onMerge?: () => void;
  onCommit?: () => void;
  onRemove?: () => void;
  onResolve?: () => void;
  isSelected?: boolean;
  compact?: boolean;
}

export interface WorktreeStatusBadgeProps {
  status: WorktreeDisplayStatus;
  size?: 'sm' | 'md';
}

export interface WorktreeActionsProps {
  worktree: WorktreeListItem;
  onOpen?: () => void;
  onMerge?: () => void;
  onCommit?: () => void;
  onRemove?: () => void;
  onResolve?: () => void;
  onAbort?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  isLoading?: boolean;
  compact?: boolean;
}

export interface MergeDialogProps {
  worktree: WorktreeListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerge: (options: MergeOptions) => void;
  isLoading?: boolean;
  diff?: GitDiff | null;
  diffError?: { message: string } | null;
  isDiffLoading?: boolean;
}

export interface CommitDialogProps {
  worktree: WorktreeListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommit: (message: string) => void;
  isLoading?: boolean;
  diff?: GitDiff | null;
  diffError?: { message: string } | null;
  isDiffLoading?: boolean;
}

export interface RemoveDialogProps {
  worktree: WorktreeListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (force: boolean) => void;
  isLoading?: boolean;
}

export interface WorktreeListProps {
  worktrees: WorktreeListItem[];
  title: string;
  emptyMessage?: string;
  selectedId?: string;
  onSelect?: (worktree: WorktreeListItem) => void;
  onOpen?: (worktree: WorktreeListItem) => void;
  onMerge?: (worktree: WorktreeListItem) => void;
  onCommit?: (worktree: WorktreeListItem) => void;
  onRemove?: (worktree: WorktreeListItem) => void;
  compact?: boolean;
}

export interface SummaryCardsProps {
  total: number;
  activeWithAgent: number;
  stale: number;
  diskUsage?: string;
}

export interface StaleWorktreesSectionProps {
  worktrees: WorktreeListItem[];
  onPruneAll: () => void;
  onRemove: (worktree: WorktreeListItem) => void;
  isPruning?: boolean;
  compact?: boolean;
}
