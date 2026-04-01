import {
  ArrowClockwise,
  ArrowDown,
  ArrowsClockwise,
  ArrowUp,
  CaretDown,
  CheckCircle,
  CloudArrowDown,
  GitBranch,
  GitCommit,
  GitPullRequest,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Skeleton } from '@/app/components/ui/skeleton';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

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
  isHead?: boolean;
  status?: 'UNMERGED' | 'LOCAL' | 'MERGED';
}

interface PullRequestInfo {
  id: string;
  number: number;
  title: string;
  author: string;
  status: 'open' | 'merged' | 'closed';
  additions: number;
  deletions: number;
  reviewStatus?: 'approved' | 'changes_requested' | 'pending';
}

interface GitViewProps {
  codespaceId: string;
  projectPath?: string;
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
    <div className="flex items-center justify-between border-b border-border bg-surface-subtle/50 px-4 py-2.5 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-fg-muted" />
        <span className="text-sm font-medium text-fg">{title}</span>
        {subtitle && (
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">
            {subtitle}
          </span>
        )}
        {count !== undefined && <span className="ml-1 text-xs text-fg-subtle">{count}</span>}
        <CaretDown className="h-3 w-3 text-fg-subtle ml-0.5" />
      </div>
      {action}
    </div>
  );
}

// ============================================
// PULL REQUEST ITEM
// ============================================

function PullRequestItem({
  pr,
  isSelected,
  onSelect,
}: {
  pr: PullRequestInfo;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border/30 transition-colors',
        'hover:bg-surface-muted/50 focus:outline-none',
        isSelected && 'bg-accent/8 border-l-2 border-l-accent -ml-[2px] pl-[calc(1rem+2px)]'
      )}
    >
      <div className="font-medium text-sm text-fg line-clamp-2">{pr.title}</div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
        <span className="font-mono text-accent">#{pr.number}</span>
        <span>{pr.author}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <span className="text-success">+{pr.additions}</span>
        <span className="text-danger">-{pr.deletions}</span>
      </div>
    </button>
  );
}

// ============================================
// COMMIT ITEM COMPONENT
// ============================================

function CommitItem({ commit }: { commit: CommitInfo }) {
  return (
    <div className="px-4 py-3 border-b border-border/30 hover:bg-surface-muted/50 transition-colors">
      <div className="font-medium text-sm text-fg line-clamp-2">{commit.message}</div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
        <span className="font-mono text-accent">{commit.shortHash}</span>
        <span>{commit.author}</span>
        <span>{commit.date}</span>
      </div>
      {(commit.additions !== undefined || commit.deletions !== undefined) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="text-success">+{commit.additions}</span>
          <span className="text-danger">-{commit.deletions}</span>
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

function BranchItem({ branch, onSelect }: { branch: BranchInfo; onSelect?: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border/30 transition-colors',
        'hover:bg-surface-muted/50 focus:outline-none',
        branch.isHead && 'bg-accent/5'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {branch.isHead && <span className="text-xs text-accent font-medium">→</span>}
            <span
              className={cn(
                'font-medium text-sm truncate',
                branch.isHead ? 'text-accent' : 'text-fg'
              )}
            >
              {branch.name}
            </span>
            {branch.status && (
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                  branch.status === 'UNMERGED' && 'bg-attention/15 text-attention',
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
        {branch.isHead && <div className="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5" />}
      </div>
    </button>
  );
}

// ============================================
// MAIN GIT VIEW COMPONENT
// ============================================

export function GitView({ codespaceId, projectPath }: GitViewProps): React.JSX.Element {
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Selected states
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  // Git status state
  const [gitStatus, setGitStatus] = useState<{
    repoName: string;
    currentBranch: string;
    status: 'clean' | 'dirty';
    staged: number;
    unstaged: number;
    untracked: number;
    ahead: number;
    behind: number;
  } | null>(null);

  // Data states
  const [pullRequests] = useState<PullRequestInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [localBranches, setLocalBranches] = useState<BranchInfo[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<BranchInfo[]>([]);

  // Fetch all git data
  const fetchData = useCallback(
    async (showLoading = true) => {
      if (showLoading) setIsLoading(true);
      else setIsRefreshing(true);

      try {
        // Fetch all data in parallel
        const [branchesResult, remoteBranchesResult, commitsResult, statusResult] =
          await Promise.all([
            apiClient.git.branches(codespaceId),
            apiClient.git.remoteBranches(codespaceId),
            apiClient.git.commits(codespaceId, undefined, 50),
            apiClient.git.status(codespaceId),
          ]);

        // Process git status
        if (statusResult.ok) {
          setGitStatus(statusResult.data);
        }

        // Process local branches
        if (branchesResult.ok) {
          const mappedBranches: BranchInfo[] = branchesResult.data.items.map((branch) => ({
            name: branch.name,
            commitHash: branch.shortHash,
            commitCount: branch.commitCount,
            isHead: branch.isHead,
            status:
              branch.status === 'ahead'
                ? 'LOCAL'
                : branch.status === 'behind'
                  ? 'MERGED'
                  : branch.status === 'diverged'
                    ? 'UNMERGED'
                    : undefined,
          }));
          setLocalBranches(mappedBranches);

          // Select the HEAD branch by default
          const headBranch = mappedBranches.find((b) => b.isHead);
          if (headBranch && !selectedBranch) {
            setSelectedBranch(headBranch.name);
          }
        }

        // Process remote branches
        if (remoteBranchesResult.ok) {
          const mappedRemoteBranches: BranchInfo[] = remoteBranchesResult.data.items.map(
            (branch) => ({
              name: branch.fullName,
              commitHash: branch.shortHash,
              commitCount: branch.commitCount,
            })
          );
          setRemoteBranches(mappedRemoteBranches);
        }

        // Process commits
        if (commitsResult.ok) {
          const mappedCommits: CommitInfo[] = commitsResult.data.items.map((commit) => ({
            hash: commit.hash,
            shortHash: commit.shortHash,
            message: commit.message,
            author: commit.author,
            date: new Date(commit.date).toLocaleDateString(),
            additions: commit.additions,
            deletions: commit.deletions,
            filesChanged: commit.filesChanged,
          }));
          setCommits(mappedCommits);
        }
      } catch (err) {
        console.error('[GitView] Failed to fetch data:', err);
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [codespaceId, selectedBranch]
  );

  useWatchEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Fetch commits when branch selection changes
  const fetchCommitsForBranch = useCallback(
    async (branch: string) => {
      try {
        const result = await apiClient.git.commits(codespaceId, branch, 50);
        if (result.ok) {
          const mappedCommits: CommitInfo[] = result.data.items.map((commit) => ({
            hash: commit.hash,
            shortHash: commit.shortHash,
            message: commit.message,
            author: commit.author,
            date: new Date(commit.date).toLocaleDateString(),
            additions: commit.additions,
            deletions: commit.deletions,
            filesChanged: commit.filesChanged,
          }));
          setCommits(mappedCommits);
        }
      } catch (err) {
        console.error('[GitView] Failed to fetch commits:', err);
      }
    },
    [codespaceId]
  );

  // Effect to fetch commits when branch selection changes
  useWatchEffect(() => {
    if (selectedBranch) {
      void fetchCommitsForBranch(selectedBranch);
    }
  }, [selectedBranch, fetchCommitsForBranch]);

  // Handle refresh
  const handleRefresh = () => fetchData(false);

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
          <Skeleton className="h-8 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
        <div className="grid grid-cols-4 divide-x divide-border min-h-[500px]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col">
              <div className="border-b border-border bg-surface-subtle/50 px-4 py-2.5">
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="flex-1 p-4 space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {/* Top toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-3">
          {/* Repo name and branch info */}
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-subtle px-3 py-1.5">
            <GitBranch className="h-4 w-4 text-fg-muted" />
            <span className="text-sm font-semibold text-fg">
              {gitStatus?.repoName || projectPath?.split('/').pop() || 'Repository'}
            </span>
          </div>

          {/* Current branch */}
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-subtle px-3 py-1.5">
            <GitBranch className="h-4 w-4 text-accent" />
            <span className="text-sm font-mono text-fg">{gitStatus?.currentBranch || 'main'}</span>
            {/* Ahead/behind indicators */}
            {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <div className="flex items-center gap-1.5 ml-1 text-xs">
                {gitStatus.ahead > 0 && (
                  <span className="flex items-center gap-0.5 text-success">
                    <ArrowUp className="h-3 w-3" />
                    {gitStatus.ahead}
                  </span>
                )}
                {gitStatus.behind > 0 && (
                  <span className="flex items-center gap-0.5 text-attention">
                    <ArrowDown className="h-3 w-3" />
                    {gitStatus.behind}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Git status indicator */}
          {gitStatus && (
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium',
                gitStatus.status === 'clean'
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-attention/30 bg-attention/10 text-attention'
              )}
            >
              {gitStatus.status === 'clean' ? (
                <>
                  <CheckCircle className="h-3.5 w-3.5" weight="fill" />
                  Clean
                </>
              ) : (
                <>
                  <WarningCircle className="h-3.5 w-3.5" weight="fill" />
                  {gitStatus.staged + gitStatus.unstaged + gitStatus.untracked} changes
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5">
            <ArrowsClockwise className="h-3.5 w-3.5" />
            Change Repo
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={handleRefresh}
            className="gap-1.5 bg-accent hover:bg-accent/90"
          >
            <ArrowClockwise className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Multi-column grid - 4 columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-x divide-border">
        {/* Pull Requests Column */}
        <div className="flex flex-col min-h-[500px] max-h-[calc(100vh-200px)]">
          <ColumnHeader icon={GitPullRequest} title="Pull Requests" count={pullRequests.length} />
          <div className="flex-1 overflow-y-auto">
            {pullRequests.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">No PRs match filter</div>
            ) : (
              pullRequests.map((pr) => <PullRequestItem key={pr.id} pr={pr} />)
            )}
          </div>
        </div>

        {/* Commits Column */}
        <div className="flex flex-col min-h-[500px] max-h-[calc(100vh-200px)]">
          <ColumnHeader
            icon={GitCommit}
            title="Commits"
            subtitle={selectedBranch ?? 'MASTER'}
            count={commits.length}
          />
          <div className="flex-1 overflow-y-auto">
            {commits.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">
                {selectedBranch ? 'No commits' : 'Select a branch'}
              </div>
            ) : (
              commits.map((commit) => <CommitItem key={commit.hash} commit={commit} />)
            )}
          </div>
        </div>

        {/* Local Branches Column */}
        <div className="flex flex-col min-h-[500px] max-h-[calc(100vh-200px)]">
          <ColumnHeader icon={GitBranch} title="Local Branches" count={localBranches.length} />
          <div className="flex-1 overflow-y-auto">
            {localBranches.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">No local branches</div>
            ) : (
              localBranches.map((branch) => (
                <BranchItem
                  key={branch.name}
                  branch={branch}
                  onSelect={() => setSelectedBranch(branch.name)}
                />
              ))
            )}
          </div>
        </div>

        {/* Remote Branches Column */}
        <div className="flex flex-col min-h-[500px] max-h-[calc(100vh-200px)]">
          <ColumnHeader
            icon={CloudArrowDown}
            title="Remote Branches"
            count={remoteBranches.length}
          />
          <div className="flex-1 overflow-y-auto">
            {remoteBranches.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-muted">No remote branches</div>
            ) : (
              remoteBranches.map((branch) => (
                <BranchItem
                  key={branch.name}
                  branch={branch}
                  onSelect={() => setSelectedBranch(branch.name)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
